import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { env } from "./env.js";

const exec = promisify(execFile);

export interface Device {
  udid: string;
  name: string;
  model: string;
  osVersion: string;
  platform: string;
  transport: string | null;
  tunnelState: string | null;
  tunnelIP: string | null;
  hostnames: string[];
  paired: boolean;
  developerMode: string | null;
}

export interface App {
  bundleId: string;
  name: string;
  version?: string;
  removable: boolean;
}

/** Run `xcrun devicectl <args>` and return the parsed JSON `result`. */
export async function devicectl(args: string[], timeoutMs = 60_000): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), "ios-device-mcp-"));
  const out = join(dir, "out.json");
  try {
    // Our flags must precede any `--`, after which everything goes to the app.
    const split = args.indexOf("--");
    const [own, passthrough] = split === -1 ? [args, []] : [args.slice(0, split), args.slice(split)];
    await exec("xcrun", ["devicectl", ...own, "--json-output", out, "--quiet", ...passthrough], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    }).catch(async (err) => {
      // devicectl writes structured errors to the JSON file; prefer those.
      const parsed = await readFile(out, "utf8").then(JSON.parse).catch(() => null);
      const message =
        parsed?.error?.userInfo?.NSLocalizedDescription?.string ??
        parsed?.error?.userInfo?.NSUnderlyingError?.error?.userInfo?.NSLocalizedDescription?.string ??
        (err.stderr || err.message);
      throw new Error(`devicectl ${args.slice(0, 3).join(" ")} failed: ${String(message).trim()}`);
    });
    return JSON.parse(await readFile(out, "utf8")).result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Physical iOS/iPadOS devices known to CoreDevice. */
export async function listDevices(): Promise<Device[]> {
  const result = await devicectl(["list", "devices"]);
  return (result.devices ?? [])
    .filter((d: any) => (d.hardwareProperties?.reality ?? "physical") === "physical")
    .map((d: any) => ({
      udid: d.hardwareProperties?.udid ?? d.identifier,
      name: d.deviceProperties?.name ?? "Unknown",
      model: d.hardwareProperties?.marketingName ?? d.hardwareProperties?.productType ?? "",
      osVersion: d.deviceProperties?.osVersionNumber ?? "",
      platform: d.hardwareProperties?.platform ?? "",
      transport: d.connectionProperties?.transportType ?? null,
      tunnelState: d.connectionProperties?.tunnelState ?? null,
      tunnelIP: d.connectionProperties?.tunnelIPAddress ?? null,
      hostnames: d.connectionProperties?.potentialHostnames ?? [],
      paired: d.connectionProperties?.pairingState === "paired",
      developerMode: d.deviceProperties?.developerModeStatus ?? null,
    }));
}

/** Details for one device, including its current tunnel address. */
export async function deviceDetails(udid: string): Promise<Device> {
  const devices = await listDevices();
  const device = devices.find((d) => d.udid === udid);
  if (!device) throw new Error(`Device ${udid} not found`);
  if (!device.tunnelIP) {
    // `info details` brings the CoreDevice tunnel up if it is idle.
    const details = await devicectl(["device", "info", "details", "--device", udid]);
    device.tunnelIP = details.connectionProperties?.tunnelIPAddress ?? null;
    device.tunnelState = details.connectionProperties?.tunnelState ?? device.tunnelState;
  }
  return device;
}

// The device chosen with select_device; it applies to calls that don't name one.
let selectedUdid: string | undefined;

/** Make a device the default for later calls, or clear the choice with undefined. */
export async function selectDevice(selector?: string): Promise<Device | undefined> {
  // Resolve before assigning, so a typo keeps the earlier choice.
  const device = selector ? await resolveDevice(selector) : undefined;
  selectedUdid = device?.udid;
  return device;
}

/** Lowercase, with curly apostrophes straightened: device names use them ("Chris’s iPhone"). */
function fold(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'");
}

/**
 * Resolve a device by UDID or name substring. With no selector, use the
 * select_device choice, then IOS_DEVICE_MCP_DEVICE, else the only USB device.
 */
export async function resolveDevice(selector?: string): Promise<Device> {
  const devices = await listDevices();
  const wanted = selector ?? selectedUdid ?? env("DEVICE");
  if (wanted) {
    const needle = fold(wanted);
    const exact =
      devices.find((d) => d.udid.toLowerCase() === needle) ?? devices.find((d) => fold(d.name) === needle);
    if (exact) return exact;
    if (!selector && wanted === selectedUdid) {
      throw new Error(`The device chosen with select_device (${wanted}) is no longer listed. Reconnect it, or select_device another.`);
    }
    // A partial name must be unambiguous: "My iPhone" also matches "My iPhone (2)".
    const partial = devices.filter((d) => fold(d.name).includes(needle));
    const list = (ds: Device[]) => ds.map((d) => `${d.name} (${d.udid})`).join(", ");
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(`"${wanted}" matches several devices: ${list(partial)}. Use the full name or UDID.`);
    throw new Error(`No device matches "${wanted}". Known: ${list(devices)}`);
  }
  // Never pick a Wi-Fi device implicitly: only one physically on the cable.
  const wired = devices.filter((d) => d.transport === "wired");
  if (wired.length === 1) return wired[0];
  if (wired.length === 0) {
    throw new Error(
      `No USB-connected iPhone/iPad found. Plug one in and unlock it, or pass "device", call select_device, or set IOS_DEVICE_MCP_DEVICE. Known: ${devices.map((d) => `${d.name} (${d.udid}, ${d.transport ?? "offline"})`).join(", ")}`,
    );
  }
  throw new Error(`Several USB devices connected; pass "device" or call select_device: ${wired.map((d) => `${d.name} (${d.udid})`).join(", ")}`);
}

export async function listApps(udid: string, includeSystem = false): Promise<App[]> {
  const args = ["device", "info", "apps", "--device", udid];
  if (includeSystem) args.push("--include-all-apps");
  const result = await devicectl(args);
  return (result.apps ?? [])
    .map((a: any) => ({
      bundleId: a.bundleIdentifier,
      name: a.name,
      version: a.version,
      removable: a.removable ?? true,
    }))
    .sort((a: App, b: App) => a.name.localeCompare(b.name));
}

export async function installApp(udid: string, appPath: string): Promise<string | undefined> {
  const result = await devicectl(["device", "install", "app", "--device", udid, appPath], 300_000);
  return result.installedApplications?.[0]?.bundleID;
}

export async function uninstallApp(udid: string, bundleId: string): Promise<void> {
  await devicectl(["device", "uninstall", "app", "--device", udid, bundleId], 120_000);
}

export async function launchApp(udid: string, bundleId: string, args: string[] = [], env: Record<string, string> = {}): Promise<void> {
  const cmd = ["device", "process", "launch", "--device", udid, "--terminate-existing"];
  if (Object.keys(env).length) cmd.push("--environment-variables", JSON.stringify(env));
  // `--` before the bundle ID stops devicectl parsing app arguments like `-method play`
  // as its own flags. (After the bundle ID, devicectl forwards a literal `--` to the app.)
  await devicectl([...cmd, "--", bundleId, ...args]);
}

export interface ContainerFile {
  path: string;
  size: number;
  modified: Date;
  isDirectory: boolean;
}

const containerArgs = (udid: string, bundleId: string) => [
  "--device", udid, "--domain-type", "appDataContainer", "--domain-identifier", bundleId,
];

/** Files in an app's data container (only works for development-signed apps). */
export async function listAppFiles(udid: string, bundleId: string, subdirectory?: string): Promise<ContainerFile[]> {
  const args = ["device", "info", "files", ...containerArgs(udid, bundleId)];
  if (subdirectory) args.push("--subdirectory", subdirectory);
  const result = await devicectl(args);
  const prefix = subdirectory ? subdirectory.replace(/\/+$/, "") + "/" : "";
  return (result.files ?? []).map((f: any) => ({
    path: prefix + f.relativePath,
    size: f.metadata?.size ?? 0,
    modified: new Date(f.metadata?.lastModDate),
    isDirectory: !!f.resources?.isDirectory,
  }));
}

export class FileNotFoundError extends Error {}

/** Copy a file out of an app's data container. `source` is relative to the container root. */
export async function pullAppFile(udid: string, bundleId: string, source: string, destination: string): Promise<void> {
  try {
    await devicectl(["device", "copy", "from", ...containerArgs(udid, bundleId), "--source", source, "--destination", destination], 300_000);
  } catch (err) {
    const message = (err as Error).message;
    if (/Failed to retrieve the file node/.test(message)) throw new FileNotFoundError(`${source} does not exist in ${bundleId}'s container`);
    throw err;
  }
}
