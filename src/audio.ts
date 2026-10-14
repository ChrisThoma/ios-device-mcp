import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDINGS_DIR = env("RECORDINGS_DIR") ?? join(ROOT, ".build", "recordings");

export interface AudioDevice {
  index: number;
  name: string;
}

/** Mac audio inputs as ffmpeg's AVFoundation backend numbers them. */
export function listAudioDevices(): Promise<AudioDevice[]> {
  return new Promise((resolve, reject) => {
    // ffmpeg exits non-zero after listing; the list is on stderr.
    execFile("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], (err, _stdout, stderr) => {
      if (err && (err as any).code === "ENOENT") return reject(new Error("ffmpeg not found; install it with `brew install ffmpeg`"));
      const audio = stderr.split("AVFoundation audio devices:")[1] ?? "";
      resolve(
        [...audio.matchAll(/\[(\d+)\] (.+)$/gm)].map((m) => ({ index: Number(m[1]), name: m[2].trim() })),
      );
    });
  });
}

/**
 * Pick an input by name substring (argument, else IOS_DEVICE_MCP_AUDIO_DEVICE).
 * Without one, use the first input that isn't an iPhone/iPad Continuity mic,
 * so a nearby phone is never recorded from implicitly.
 */
export async function pickAudioDevice(preferred?: string): Promise<AudioDevice> {
  const devices = await listAudioDevices();
  const wanted = preferred ?? env("AUDIO_DEVICE");
  const device = wanted
    ? devices.find((d) => d.name.toLowerCase().includes(wanted.toLowerCase()))
    : devices.find((d) => !/iphone|ipad/i.test(d.name));
  if (!device) {
    throw new Error(`No audio input${wanted ? ` matching "${wanted}"` : ""}. Available: ${devices.map((d) => d.name).join(", ") || "none"}`);
  }
  return device;
}

export interface Recording {
  path: string;
  device: string;
  /** Wall-clock ms at which the first captured sample was recorded. */
  startedAt: number;
  /** Resolves when the recording has finished and the file is complete. */
  done: Promise<void>;
  stop(): void;
}

/** Start recording from the Mac's mic; resolves once audio is actually being captured. */
export async function startRecording(seconds: number, preferredDevice?: string): Promise<Recording> {
  const device = await pickAudioDevice(preferredDevice);
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  const path = join(RECORDINGS_DIR, `rec-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`);
  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-progress", "pipe:1", "-stats_period", "0.05",
      "-f", "avfoundation", "-i", `:${device.index}`,
      "-t", String(seconds), "-ac", "1", "-ar", "48000", "-y", path,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  const done = new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Recording failed (ffmpeg exit ${code}): ${stderr.trim() || "no output"}`))));
  });
  done.catch(() => {}); // Surfaced to callers that await it.

  // The first progress report with a non-zero position means samples are flowing;
  // back-date by that position to get when the first sample was captured.
  const startedAt = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Recording did not start within 5s. Check that the terminal running Claude Code has microphone access (System Settings > Privacy & Security > Microphone)."));
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      const match = /out_time_us=(\d+)/.exec(chunk.toString());
      if (match && Number(match[1]) > 0) {
        clearTimeout(timer);
        resolve(Date.now() - Number(match[1]) / 1000);
      }
    });
    done.catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return { path, device: device.name, startedAt, done, stop: () => child.kill("SIGINT") };
}
