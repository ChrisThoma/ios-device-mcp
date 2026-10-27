#!/usr/bin/env node
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { startRecording } from "./audio.js";
import * as dc from "./devicectl.js";
import { driverFor, stopAllDrivers, type Driver } from "./driver.js";
import { describeElement, findElements, renderTree, type ElementQuery, type UINode } from "./ui.js";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const server = new McpServer({ name: "ios-device-mcp", version: "0.1.0" });

type ToolResult = { content: any[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

/** Wrap a handler so thrown errors become MCP tool errors instead of protocol errors. */
function handle<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  };
}

const deviceArg = {
  device: z
    .string()
    .optional()
    .describe("Device UDID or name substring. Defaults to the select_device choice, then IOS_DEVICE_MCP_DEVICE, else the single USB-connected device."),
};

async function getDriver(device?: string): Promise<{ udid: string; driver: Driver }> {
  const { udid } = await dc.resolveDevice(device);
  const driver = driverFor(udid);
  if (!(await driver.healthy())) {
    await driver.start();
    await sendCandidates(udid, driver);
  }
  return { udid, driver };
}

/** Tell the runner which apps exist so it can find the foreground one. */
async function sendCandidates(udid: string, driver: Driver) {
  const apps = await dc.listApps(udid, true).catch(() => []);
  await driver.request("POST", "/candidates", { bundleIds: apps.map((a) => a.bundleId) }).catch(() => {});
}

async function getTree(driver: Driver, bundleId?: string) {
  const q = bundleId ? `?bundleId=${encodeURIComponent(bundleId)}` : "";
  return driver.request<{ bundleId: string; tree: UINode; systemAlerts?: UINode[] }>("GET", `/source${q}`);
}

// MARK: Devices and apps

server.registerTool(
  "list_devices",
  { description: "List physical iPhones/iPads known to this Mac, with connection state. The device tools use by default is marked." },
  handle(async () => {
    const devices = await dc.listDevices();
    if (!devices.length) return text("No physical devices found.");
    const current = await dc.resolveDevice().catch(() => undefined);
    return text(
      devices
        .map((d) => {
          const mark = d.udid === current?.udid ? "  [default]" : "";
          return `${d.name} — ${d.model} iOS ${d.osVersion}${mark}\n  udid=${d.udid} transport=${d.transport ?? "offline"} tunnel=${d.tunnelState ?? "?"}`;
        })
        .join("\n"),
    );
  }),
);

server.registerTool(
  "select_device",
  {
    description:
      "Choose which device later calls use when they don't pass \"device\". Lasts for this server session. Omit device to clear the choice.",
    inputSchema: { device: z.string().optional().describe("Device UDID or name substring; omit to clear") },
  },
  handle(async ({ device }) => {
    const chosen = await dc.selectDevice(device);
    if (chosen) return text(`Using ${chosen.name} (${chosen.udid}) by default`);
    const fallback = await dc.resolveDevice().catch((err) => err as Error);
    return text(`Cleared. ${fallback instanceof Error ? fallback.message : `Default is now ${fallback.name} (${fallback.udid})`}`);
  }),
);

server.registerTool(
  "list_apps",
  {
    description: "List apps installed on the device.",
    inputSchema: { ...deviceArg, includeSystem: z.boolean().optional().describe("Include Apple system apps") },
  },
  handle(async ({ device, includeSystem }) => {
    const { udid } = await dc.resolveDevice(device);
    const apps = await dc.listApps(udid, includeSystem);
    return text(apps.map((a) => `${a.name} (${a.bundleId})${a.version ? " v" + a.version : ""}`).join("\n"));
  }),
);

server.registerTool(
  "build_app",
  {
    description:
      "Build an Xcode project/workspace scheme for the device and (by default) install it. Returns the bundle ID. Signing uses the project's own settings.",
    inputSchema: {
      ...deviceArg,
      project: z.string().optional().describe("Path to .xcodeproj"),
      workspace: z.string().optional().describe("Path to .xcworkspace"),
      scheme: z.string(),
      configuration: z.string().optional().describe("Default: Debug"),
      install: z.boolean().optional().describe("Install after building (default true)"),
    },
  },
  handle(async ({ device, project, workspace, scheme, configuration = "Debug", install = true }) => {
    if (!project && !workspace) throw new Error("Pass project or workspace");
    const { udid } = await dc.resolveDevice(device);
    const container = workspace ? ["-workspace", resolve(workspace)] : ["-project", resolve(project!)];
    const derived = join(ROOT, ".build", "apps", scheme.replace(/[^\w.-]/g, "_"));
    const common = [...container, "-scheme", scheme, "-configuration", configuration, "-destination", `id=${udid}`, "-derivedDataPath", derived];
    try {
      await exec("xcodebuild", [...common, "-allowProvisioningUpdates", "build"], { maxBuffer: 512 * 1024 * 1024, timeout: 1_200_000 });
    } catch (err: any) {
      const errors = String(err.stdout ?? "").split("\n").filter((l: string) => /error:/.test(l)).slice(0, 15).join("\n");
      throw new Error(`Build failed:\n${errors || err.stderr || err.message}`);
    }
    const { stdout } = await exec("xcodebuild", [...common, "-showBuildSettings", "-json"], { maxBuffer: 64 * 1024 * 1024 });
    const app = (JSON.parse(stdout) as any[]).map((t) => t.buildSettings).find((s) => s.WRAPPER_EXTENSION === "app");
    if (!app) throw new Error("Build succeeded but no .app product was found for this scheme");
    const appPath = join(app.TARGET_BUILD_DIR, app.WRAPPER_NAME);
    if (!install) return text(`Built ${appPath} (${app.PRODUCT_BUNDLE_IDENTIFIER})`);
    await dc.installApp(udid, appPath);
    return text(`Built and installed ${app.PRODUCT_BUNDLE_IDENTIFIER} from ${appPath}`);
  }),
);

server.registerTool(
  "install_app",
  { description: "Install a built .app (or .ipa) onto the device.", inputSchema: { ...deviceArg, path: z.string() } },
  handle(async ({ device, path }) => {
    const full = resolve(path);
    if (!existsSync(full)) throw new Error(`No such file: ${full}`);
    const { udid } = await dc.resolveDevice(device);
    const bundleId = await dc.installApp(udid, full);
    return text(`Installed ${bundleId ?? full}`);
  }),
);

server.registerTool(
  "uninstall_app",
  { description: "Uninstall an app (and its data) from the device.", inputSchema: { ...deviceArg, bundleId: z.string() } },
  handle(async ({ device, bundleId }) => {
    const { udid } = await dc.resolveDevice(device);
    await dc.uninstallApp(udid, bundleId);
    return text(`Uninstalled ${bundleId}`);
  }),
);

// App console capture: `devicectl process launch --console` streams the app's stdout/stderr.
// OS_ACTIVITY_DT_MODE makes the app mirror os_log/Logger messages to stderr (as Xcode's
// console does), and OS_ACTIVITY_MODE=debug also enables debug-level messages.
const logSessions = new Map<string, { child: ChildProcess; lines: string[] }>();

// NSUnbufferedIO (also set by Xcode) stops stdout arriving in blocks when piped.
const LOG_LEVEL_ENV: Record<string, Record<string, string>> = {
  stdout: { NSUnbufferedIO: "YES" },
  info: { NSUnbufferedIO: "YES", OS_ACTIVITY_DT_MODE: "1" },
  debug: { NSUnbufferedIO: "YES", OS_ACTIVITY_DT_MODE: "1", OS_ACTIVITY_MODE: "debug" },
};

// When each app was last launched by us, so pull_file can wait for a fresh file.
const lastLaunch = new Map<string, Date>();

// Status lines devicectl prints around the app's own output.
const DEVICECTL_NOISE = /^(Launched application with .* bundle identifier\.|Waiting for the application to terminate…)$/;

server.registerTool(
  "launch_app",
  {
    description:
      "Launch (or relaunch) an app in the foreground. With captureLogs, the app's console output — print/NSLog and os_log/Logger messages — is buffered for get_app_logs.",
    inputSchema: {
      ...deviceArg,
      bundleId: z.string(),
      arguments: z.array(z.string()).optional(),
      environment: z.record(z.string(), z.string()).optional(),
      captureLogs: z.boolean().optional(),
      logLevel: z
        .enum(["debug", "info", "stdout"])
        .optional()
        .describe("With captureLogs: debug (default) includes Logger.debug; info drops debug; stdout captures only print/NSLog"),
    },
  },
  handle(async ({ device, bundleId, arguments: args = [], environment = {}, captureLogs, logLevel = "debug" }) => {
    const { udid, driver } = await getDriver(device);
    lastLaunch.set(`${udid}:${bundleId}`, new Date());
    if (!captureLogs) {
      await driver.request("POST", "/launch", { bundleId, arguments: args, environment });
      return text(`Launched ${bundleId}`);
    }
    const key = `${udid}:${bundleId}`;
    logSessions.get(key)?.child.kill();
    const env = { ...LOG_LEVEL_ENV[logLevel], ...environment };
    const cmd = ["devicectl", "device", "process", "launch", "--console", "--terminate-existing", "--device", udid];
    if (Object.keys(env).length) cmd.push("--environment-variables", JSON.stringify(env));
    // `--` before the bundle ID stops devicectl parsing app arguments like `-method play`
    // as its own flags. (After the bundle ID, devicectl forwards a literal `--` to the app.)
    const child = spawn("xcrun", [...cmd, "--", bundleId, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const session = { child, lines: [] as string[] };
    // Keep partial lines per stream until their newline arrives.
    const collector = () => {
      let partial = "";
      return (chunk: Buffer) => {
        const parts = (partial + chunk.toString()).split("\n");
        partial = parts.pop()!;
        session.lines.push(...parts.filter((l) => l && !DEVICECTL_NOISE.test(l)));
        if (session.lines.length > 5000) session.lines.splice(0, session.lines.length - 5000);
      };
    };
    child.stdout!.on("data", collector());
    child.stderr!.on("data", collector());
    logSessions.set(key, session);
    // Let the app come up, then point the driver at it.
    await new Promise((r) => setTimeout(r, 2500));
    await driver.request("POST", "/activate", { bundleId }).catch(() => {});
    return text(`Launched ${bundleId} capturing ${logLevel === "stdout" ? "stdout/stderr" : `os_log at ${logLevel} level and stdout/stderr`} (use get_app_logs)`);
  }),
);

server.registerTool(
  "get_app_logs",
  {
    description:
      "Read console output captured from an app started with launch_app captureLogs=true. os_log/Logger lines look like `<timestamp> App[pid:tid] [category] message`.",
    inputSchema: {
      ...deviceArg,
      bundleId: z.string(),
      lines: z.number().int().optional().describe("Last N matching lines (default 200)"),
      grep: z.string().optional().describe("Case-insensitive regex; only matching lines are returned (e.g. a category like \"\\[network\\]\")"),
      clear: z.boolean().optional().describe("Clear the buffer after reading"),
    },
  },
  handle(async ({ device, bundleId, lines = 200, grep, clear }) => {
    const { udid } = await dc.resolveDevice(device);
    const session = logSessions.get(`${udid}:${bundleId}`);
    if (!session) throw new Error(`No log capture for ${bundleId}; launch it with captureLogs=true`);
    let matching = session.lines;
    if (grep) {
      const re = new RegExp(grep, "i");
      matching = matching.filter((l) => re.test(l));
    }
    const out = matching.slice(-lines).join("\n");
    if (clear) session.lines = [];
    const status = session.child.exitCode === null ? "" : "\n[app exited — capture ended]";
    return text((out || (grep ? "(no matching lines)" : "(no output yet)")) + status);
  }),
);

server.registerTool(
  "terminate_app",
  { description: "Force-quit an app.", inputSchema: { ...deviceArg, bundleId: z.string() } },
  handle(async ({ device, bundleId }) => {
    const { driver } = await getDriver(device);
    await driver.request("POST", "/terminate", { bundleId });
    return text(`Terminated ${bundleId}`);
  }),
);

// MARK: Driver lifecycle

server.registerTool(
  "start_driver",
  {
    description:
      "Start the on-device XCUITest driver (UI tools start it automatically). The first run on a device builds the runner and iOS asks for the passcode to allow UI automation.",
    inputSchema: { ...deviceArg, rebuild: z.boolean().optional().describe("Force a rebuild of the runner") },
  },
  handle(async ({ device, rebuild }) => {
    const { udid } = await dc.resolveDevice(device);
    const driver = driverFor(udid);
    const health = await driver.start({ rebuild });
    await sendCandidates(udid, driver);
    return text(`Driver running on ${udid}: screen ${health.screen.width}x${health.screen.height} pt, foreground ${health.currentApp}`);
  }),
);

server.registerTool(
  "stop_driver",
  { description: "Stop the on-device driver.", inputSchema: deviceArg },
  handle(async ({ device }) => {
    const { udid } = await dc.resolveDevice(device);
    await driverFor(udid).stop();
    return text("Driver stopped");
  }),
);

// MARK: Seeing the screen

server.registerTool(
  "screenshot",
  {
    description:
      "Take a screenshot. By default it is scaled to screen points, so image pixel coordinates equal tap coordinates.",
    inputSchema: { ...deviceArg, fullRes: z.boolean().optional().describe("Native pixel resolution instead of points") },
  },
  handle(async ({ device, fullRes }) => {
    const { driver } = await getDriver(device);
    const shot = await driver.request("GET", `/screenshot${fullRes ? "?fullRes=1&quality=0.8" : ""}`);
    return {
      content: [
        { type: "image", data: shot.image, mimeType: "image/jpeg" },
        { type: "text", text: `${shot.width}x${shot.height} (screen ${shot.pointWidth}x${shot.pointHeight} pt)` },
      ],
    };
  }),
);

server.registerTool(
  "describe_ui",
  {
    description:
      "Accessibility tree of the foreground app (plus any system alert), one element per line: Type \"label\" #identifier value=… @(centerX,centerY) WxH. Coordinates are in points and can be passed to tap.",
    inputSchema: {
      ...deviceArg,
      bundleId: z.string().optional().describe("Inspect this app instead of the detected foreground app"),
      includeOffscreen: z.boolean().optional(),
      format: z.enum(["text", "json"]).optional().describe("json returns the raw tree"),
    },
  },
  handle(async ({ device, bundleId, includeOffscreen, format }) => {
    const { driver } = await getDriver(device);
    const result = await getTree(driver, bundleId);
    if (format === "json") return text(JSON.stringify(result));
    let out = `App: ${result.bundleId}\n${renderTree(result.tree, { includeOffscreen })}`;
    for (const alert of result.systemAlerts ?? []) out += `\n\nSystem alert:\n${renderTree(alert, { screen: result.tree.frame })}`;
    return text(out);
  }),
);

// MARK: Interaction

const point = { x: z.number().describe("Points from left"), y: z.number().describe("Points from top") };

const recordAudioArg = {
  recordAudio: z
    .object({
      seconds: z.number().positive().max(300).describe("Audio to keep after the tap"),
      leadIn: z.number().min(0).max(10).optional().describe("Seconds recorded before the tap (default 0.5)"),
      audioDevice: z.string().optional().describe("Mac input name substring (default: built-in mic, never an iPhone/iPad mic)"),
    })
    .optional()
    .describe("Record the Mac microphone around the tap. The tap is sent once audio is actually being captured, and the result gives its offset in the file"),
};

type RecordAudio = { seconds: number; leadIn?: number; audioDevice?: string };

/** Run a device action while recording the Mac mic, timed so the action lands `leadIn` seconds into the file. */
async function withRecording(opts: RecordAudio, action: () => Promise<unknown>): Promise<string> {
  const leadIn = opts.leadIn ?? 0.5;
  // ffmpeg's files come out up to ~0.5s shorter than requested, so pad the length.
  const rec = await startRecording(leadIn + opts.seconds + 1, opts.audioDevice);
  try {
    await new Promise((r) => setTimeout(r, Math.max(0, rec.startedAt + leadIn * 1000 - Date.now())));
    const before = Date.now();
    // The driver reports how long it spent finding the target before touching it.
    const result: any = await action();
    const acked = Date.now();
    const sent = before + Math.round((typeof result?.setup === "number" ? result.setup : 0) * 1000);
    await rec.done;
    const offset = (t: number) => `${((t - rec.startedAt) / 1000).toFixed(3)}s`;
    const length = fileSeconds(rec.path);
    const short = length < (sent - rec.startedAt) / 1000 + opts.seconds ? " Warning: the file ends before the requested audio after the tap." : "";
    return `Recorded ${rec.path} from "${rec.device}" (${length.toFixed(2)}s). Tap sent at ${offset(sent)} and completed at ${offset(acked)} into the file (±~0.07s); the touch lands in that window.${short}`;
  } catch (err) {
    rec.stop();
    throw err;
  }
}

function fileSeconds(wavPath: string): number {
  // 16-bit mono 48 kHz WAV with a 44-byte header (what startRecording writes).
  return (statSync(wavPath).size - 44) / 96000;
}

server.registerTool(
  "tap",
  { description: "Tap at screen coordinates (points).", inputSchema: { ...deviceArg, ...point, ...recordAudioArg } },
  handle(async ({ device, x, y, recordAudio }) => {
    const { driver } = await getDriver(device);
    const tap = () => driver.request("POST", "/tap", { x, y });
    if (!recordAudio) {
      await tap();
      return text(`Tapped (${x},${y})`);
    }
    return text(`Tapped (${x},${y}). ${await withRecording(recordAudio, tap)}`);
  }),
);

const elementQuery = {
  text: z.string().optional().describe("Matches label, identifier, value or placeholder (exact first, then substring, case-insensitive)"),
  id: z.string().optional().describe("Exact accessibility identifier"),
  type: z.string().optional().describe("Element type, e.g. Button, TextField, Cell, Switch"),
  index: z.number().int().optional().describe("Pick the Nth best match (0-based)"),
  exact: z.boolean().optional().describe("Require an exact text match"),
  timeout: z.number().optional().describe("Seconds to wait for the element (default 5)"),
  scrollDirection: z
    .enum(["up", "down", "left", "right"])
    .optional()
    .describe("If not found, scroll this way and look again (lists load lazily, so off-screen rows may not exist yet)"),
  maxScrolls: z.number().int().optional().describe("Scroll attempts when scrollDirection is set (default 8)"),
};

type Direction = "up" | "down" | "left" | "right";

/** Scroll content in a direction by swiping across the middle of the screen. */
async function scrollScreen(driver: Driver, direction: Direction, amount = 0.5) {
  const health = await driver.healthy();
  const { width: w, height: h } = health.screen;
  const f = Math.min(Math.max(amount, 0.1), 0.8);
  const [cx, cy] = [w / 2, h / 2];
  const dx = direction === "left" ? -1 : direction === "right" ? 1 : 0;
  const dy = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  // Finger moves opposite to the scroll direction.
  await driver.request("POST", "/swipe", {
    fromX: cx + (dx * w * f) / 2,
    fromY: cy + (dy * h * f) / 2,
    toX: cx - (dx * w * f) / 2,
    toY: cy - (dy * h * f) / 2,
    duration: 0.25,
  });
}

type WaitQuery = ElementQuery & { timeout?: number; scrollDirection?: Direction; maxScrolls?: number };

async function waitForElement(driver: Driver, q: WaitQuery, gone = false) {
  if (!q.text && !q.id && !q.type) throw new Error("Pass at least one of text, id or type");
  const deadline = Date.now() + (q.timeout ?? 5) * 1000;
  let scrolls = 0;
  let settledAt = "";
  for (;;) {
    const { tree, systemAlerts = [] } = await getTree(driver);
    // System alerts sit above the app, so search them first.
    let matches = [...systemAlerts.flatMap((a) => findElements(a, q, tree.frame)), ...findElements(tree, q)];
    if (q.scrollDirection && !gone) matches = matches.filter((m) => m.onScreen);
    const found = matches[q.index ?? 0];
    if (gone && !found) return { found, matches };
    if (!gone && found) {
      // After scrolling, momentum can keep moving the content. Only accept the
      // element once its position matches across two consecutive snapshots.
      const at = `${found.type}|${found.label}|${found.center.join(",")}`;
      if (scrolls === 0 || at === settledAt || Date.now() > deadline) return { found, matches };
      settledAt = at;
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    // Lists load lazily, so an element below the fold may not exist until scrolled to.
    // Only count on-screen matches as found when scrolling, so we scroll until it is tappable.
    if (!gone && q.scrollDirection && scrolls < (q.maxScrolls ?? 8)) {
      scrolls++;
      await scrollScreen(driver, q.scrollDirection, 0.4);
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    if (Date.now() > deadline) {
      const what = JSON.stringify({ text: q.text, id: q.id, type: q.type });
      throw new Error(gone ? `Element ${what} still present after ${q.timeout ?? 5}s` : `No element matching ${what} after ${q.timeout ?? 5}s. Use describe_ui to see what is on screen.`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

server.registerTool(
  "tap_element",
  {
    description: "Find an element by text/identifier/type, waiting for it to appear, and tap its center.",
    inputSchema: { ...deviceArg, ...elementQuery, ...recordAudioArg },
  },
  handle(async ({ device, recordAudio, ...q }) => {
    const { driver } = await getDriver(device);
    // Find the element before recording starts so the search doesn't eat the lead-in.
    const { found, matches } = await waitForElement(driver, q);
    const tap = () => driver.request("POST", "/tap", { x: found!.center[0], y: found!.center[1] });
    const note = matches.length > 1 ? ` (${matches.length} matches; use index to pick another)` : "";
    if (!recordAudio) {
      await tap();
      return text(`Tapped ${describeElement(found!)}${note}`);
    }
    return text(`Tapped ${describeElement(found!)}${note}. ${await withRecording(recordAudio, tap)}`);
  }),
);

server.registerTool(
  "wait_for_element",
  {
    description: "Wait until an element appears (or disappears with gone=true).",
    inputSchema: { ...deviceArg, ...elementQuery, gone: z.boolean().optional() },
  },
  handle(async ({ device, gone, ...q }) => {
    const { driver } = await getDriver(device);
    const { found } = await waitForElement(driver, q, gone);
    return text(gone ? "Element is gone" : `Found ${describeElement(found!)}`);
  }),
);

server.registerTool(
  "double_tap",
  { description: "Double-tap at coordinates (points).", inputSchema: { ...deviceArg, ...point } },
  handle(async ({ device, x, y }) => {
    const { driver } = await getDriver(device);
    await driver.request("POST", "/double_tap", { x, y });
    return text(`Double-tapped (${x},${y})`);
  }),
);

server.registerTool(
  "long_press",
  {
    description: "Press and hold at coordinates (points).",
    inputSchema: { ...deviceArg, ...point, duration: z.number().optional().describe("Seconds (default 1)") },
  },
  handle(async ({ device, x, y, duration }) => {
    const { driver } = await getDriver(device);
    await driver.request("POST", "/long_press", { x, y, duration });
    return text(`Long-pressed (${x},${y})`);
  }),
);

server.registerTool(
  "swipe",
  {
    description: "Drag from one point to another (points).",
    inputSchema: {
      ...deviceArg,
      fromX: z.number(),
      fromY: z.number(),
      toX: z.number(),
      toY: z.number(),
      duration: z.number().optional().describe("Seconds (default 0.3)"),
    },
  },
  handle(async ({ device, ...args }) => {
    const { driver } = await getDriver(device);
    await driver.request("POST", "/swipe", args);
    return text(`Swiped (${args.fromX},${args.fromY}) → (${args.toX},${args.toY})`);
  }),
);

server.registerTool(
  "scroll",
  {
    description: "Scroll the content in a direction (\"down\" reveals content further down) by swiping from the middle of the screen.",
    inputSchema: {
      ...deviceArg,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().optional().describe("Fraction of the screen to scroll, 0.1–0.8 (default 0.5)"),
    },
  },
  handle(async ({ device, direction, amount = 0.5 }) => {
    const { driver } = await getDriver(device);
    await scrollScreen(driver, direction, amount);
    return text(`Scrolled ${direction}`);
  }),
);

server.registerTool(
  "type_text",
  {
    description: "Type into the focused text field (tap the field first). Use \\n for return.",
    inputSchema: {
      ...deviceArg,
      text: z.string(),
      submit: z.boolean().optional().describe("Press return after typing"),
      deleteCount: z.number().int().min(0).optional().describe("Press delete this many times before typing, e.g. to clear a field"),
    },
  },
  handle(async ({ device, text: value, submit, deleteCount = 0 }) => {
    const { driver } = await getDriver(device);
    // U+0008 is XCUIKeyboardKey.delete.
    await driver.request("POST", "/type", { text: "\u0008".repeat(deleteCount) + value + (submit ? "\n" : "") });
    const deleted = deleteCount ? `Deleted ${deleteCount} and typed` : "Typed";
    return text(`${deleted} ${JSON.stringify(value)}${submit ? " + return" : ""}`);
  }),
);

server.registerTool(
  "press_button",
  {
    description: "Press a hardware button. \"home\" goes to the home screen.",
    inputSchema: { ...deviceArg, name: z.enum(["home", "volumeUp", "volumeDown"]) },
  },
  handle(async ({ device, name }) => {
    const { driver } = await getDriver(device);
    await driver.request("POST", "/button", { name });
    return text(`Pressed ${name}`);
  }),
);

server.registerTool(
  "open_url",
  { description: "Open a URL or deep link (custom scheme or universal link) on the device.", inputSchema: { ...deviceArg, url: z.string() } },
  handle(async ({ device, url }) => {
    const { driver } = await getDriver(device);
    await driver.request("POST", "/open_url", { url });
    return text(`Opened ${url}`);
  }),
);

server.registerTool(
  "set_volume",
  {
    description:
      "Set the device's media volume by pressing the volume buttons toward the level, verifying each step on the system volume indicator. iOS volume has 16 steps, so levels round to the nearest 1/16. Returns the final level.",
    inputSchema: { ...deviceArg, level: z.number().min(0).max(1).describe("0 (mute) to 1 (max)") },
  },
  handle(async ({ device, level }) => {
    const { driver } = await getDriver(device);
    const result = await driver.request("POST", "/volume", { level });
    const summary = `Volume now ${result.level.toFixed(4)} (${Math.round(result.level * 16)}/16) after ${result.presses} presses`;
    return result.warning ? { content: [{ type: "text", text: `${summary}. ${result.warning}` }], isError: true } : text(summary);
  }),
);

server.registerTool(
  "record_audio",
  {
    description: "Record the Mac microphone for a number of seconds (e.g. to capture what the device plays). Returns the WAV path.",
    inputSchema: {
      seconds: z.number().positive().max(300),
      audioDevice: z.string().optional().describe("Mac input name substring (default: built-in mic, never an iPhone/iPad mic)"),
    },
  },
  handle(async ({ seconds, audioDevice }) => {
    const rec = await startRecording(seconds + 1, audioDevice);
    await rec.done;
    return text(`Recorded ${rec.path} from "${rec.device}" (${fileSeconds(rec.path).toFixed(2)}s)`);
  }),
);

server.registerTool(
  "list_app_files",
  {
    description: "List files in an app's data container (Documents, Library, tmp…). Works for development-signed apps only.",
    inputSchema: { ...deviceArg, bundleId: z.string(), subdirectory: z.string().optional().describe("e.g. Documents") },
  },
  handle(async ({ device, bundleId, subdirectory }) => {
    const { udid } = await dc.resolveDevice(device);
    const files = await dc.listAppFiles(udid, bundleId, subdirectory);
    if (!files.length) return text("(empty)");
    return text(
      files
        .map((f) => (f.isDirectory ? `${f.path}/` : `${f.path}  ${f.size} B  ${f.modified.toISOString()}`))
        .join("\n"),
    );
  }),
);

server.registerTool(
  "pull_file",
  {
    description:
      "Copy a file out of an app's data container to the Mac. Can wait for the file to appear, or to be written after the last launch_app. Small text files are returned inline.",
    inputSchema: {
      ...deviceArg,
      bundleId: z.string(),
      path: z.string().describe("Path inside the container, e.g. Documents/result.json"),
      destination: z.string().optional().describe("Local path (default: .build/pulled/<bundleId>/<path> in the ios-device-mcp repo)"),
      waitSeconds: z.number().min(0).max(600).optional().describe("Poll this long for the file to exist (default 0)"),
      modifiedAfter: z
        .string()
        .optional()
        .describe('Only accept a file modified after this ISO time, or "lastLaunch" for the last launch_app of this app; implies waiting'),
    },
  },
  handle(async ({ device, bundleId, path, destination, waitSeconds = 0, modifiedAfter }) => {
    const { udid } = await dc.resolveDevice(device);
    const source = path.replace(/^\/+/, "");
    const local = resolve(destination ?? join(ROOT, ".build", "pulled", bundleId, source));
    mkdirSync(dirname(local), { recursive: true });

    let after: Date | undefined;
    if (modifiedAfter === "lastLaunch") {
      after = lastLaunch.get(`${udid}:${bundleId}`);
      if (!after) throw new Error(`No launch_app of ${bundleId} recorded in this session; pass an ISO time instead`);
    } else if (modifiedAfter) {
      after = new Date(modifiedAfter);
      if (isNaN(after.getTime())) throw new Error(`modifiedAfter is not a valid time: ${modifiedAfter}`);
    }
    // modifiedAfter implies waiting: default to 60s if no wait was given.
    const waitFor = after && !waitSeconds ? 60 : waitSeconds;
    const deadline = Date.now() + waitFor * 1000;

    for (;;) {
      let ready = true;
      let note = "";
      if (after) {
        // Container timestamps have 1s resolution; allow for that and small clock skew.
        const parent = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : undefined;
        const entry = (await dc.listAppFiles(udid, bundleId, parent).catch(() => [])).find((f) => f.path === source);
        ready = !!entry && entry.modified.getTime() >= after.getTime() - 1500;
        if (entry) note = ` (modified ${entry.modified.toISOString()})`;
      }
      if (ready) {
        try {
          await dc.pullAppFile(udid, bundleId, source, local);
          const size = statSync(local).size;
          let out = `Pulled ${source}${note} → ${local} (${size} B)`;
          const data = size <= 64 * 1024 ? readFileSync(local) : undefined;
          if (data && !data.includes(0)) out += `\n\n${data.toString("utf8")}`;
          return text(out);
        } catch (err) {
          if (!(err instanceof dc.FileNotFoundError)) throw err;
        }
      }
      if (Date.now() >= deadline) {
        const problem = after ? `was not written after ${after.toISOString()}` : "does not exist";
        const waited = waitFor ? ` (waited ${waitFor}s)` : "";
        throw new Error(`${source} in ${bundleId}'s container ${problem}${waited}. Use list_app_files to see what's there.`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }),
);

server.registerTool(
  "set_orientation",
  {
    description: "Rotate the device's interface orientation.",
    inputSchema: { ...deviceArg, orientation: z.enum(["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight"]) },
  },
  handle(async ({ device, orientation }) => {
    const { driver } = await getDriver(device);
    await driver.request("POST", "/orientation", { value: orientation });
    return text(`Orientation set to ${orientation}`);
  }),
);

const shutdown = async () => {
  for (const s of logSessions.values()) s.child.kill();
  await stopAllDrivers();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
