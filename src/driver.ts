import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deviceDetails, type Device } from "./devicectl.js";
import { env } from "./env.js";

const exec = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_DIR = join(ROOT, "runner");
const BUILD_DIR = env("BUILD_DIR") ?? join(ROOT, ".build", "runner");
const PRODUCTS_DIR = join(BUILD_DIR, "Build", "Products");
const PORT = Number(env("PORT") ?? 22087);

function log(message: string) {
  process.stderr.write(`[ios-device-mcp] ${message}\n`);
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.endsWith(".xcodeproj")) continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

function findXctestrun(): string | undefined {
  if (!existsSync(PRODUCTS_DIR)) return undefined;
  const file = readdirSync(PRODUCTS_DIR).find((f) => f.endsWith(".xctestrun") && f.includes("iphoneos"));
  return file && join(PRODUCTS_DIR, file);
}

// Drivers for several devices share one build directory, so builds run one at a time.
let buildQueue: Promise<unknown> = Promise.resolve();

/** Build the XCUITest runner if it is missing or its sources changed. */
export function buildRunner(udid: string, force = false): Promise<string> {
  const build = buildQueue.then(() => buildRunnerNow(udid, force));
  buildQueue = build.catch(() => {});
  return build;
}

async function buildRunnerNow(udid: string, force: boolean): Promise<string> {
  const existing = findXctestrun();
  if (existing && !force && statSync(existing).mtimeMs >= newestMtime(RUNNER_DIR)) return existing;

  const team = env("TEAM_ID");
  if (!team) {
    throw new Error(
      "IOS_DEVICE_MCP_TEAM_ID is not set. Set it to your Apple Developer Team ID (Xcode > Settings > Accounts, or developer.apple.com > Membership) in the MCP server config.",
    );
  }
  const prefix = env("BUNDLE_PREFIX") ?? `dev.iosdevicemcp.${team.toLowerCase()}`;

  log("generating runner project");
  await exec("xcodegen", ["generate", "--quiet", "--spec", join(RUNNER_DIR, "project.yml")], { cwd: RUNNER_DIR }).catch((err) => {
    throw new Error(`xcodegen failed (install with \`brew install xcodegen\`): ${err.stderr || err.message}`);
  });

  log(`building runner for ${udid} (team ${team})`);
  const args = [
    "build-for-testing",
    "-project", join(RUNNER_DIR, "DriverRunner.xcodeproj"),
    "-scheme", "DriverUITests",
    "-destination", `id=${udid}`,
    "-derivedDataPath", BUILD_DIR,
    "-allowProvisioningUpdates",
    `DEVELOPMENT_TEAM=${team}`,
    `BUNDLE_PREFIX=${prefix}`,
  ];
  // Registering a new device changes the developer account, so it is opt-in.
  if (env("ALLOW_DEVICE_REGISTRATION") === "1") args.push("-allowProvisioningDeviceRegistration");
  try {
    await exec("xcodebuild", args, { maxBuffer: 256 * 1024 * 1024, timeout: 600_000 });
  } catch (err: any) {
    const errors = String(err.stdout ?? "")
      .split("\n")
      .filter((l) => /error:/.test(l))
      .slice(0, 8)
      .join("\n");
    const hint = /isn't registered/.test(errors)
      ? "\nRegister the device in your team (Xcode, or set IOS_DEVICE_MCP_ALLOW_DEVICE_REGISTRATION=1) and retry."
      : "";
    throw new Error(`Runner build failed:\n${errors || err.message}${hint}`);
  }
  const built = findXctestrun();
  if (!built) throw new Error("Runner build succeeded but no .xctestrun file was produced");
  return built;
}

export class DriverError extends Error {}

/** One XCUITest driver session on one device. */
export class Driver {
  private process?: ChildProcess;
  private output: string[] = [];
  private baseUrl?: string;

  constructor(readonly udid: string) {}

  get running(): boolean {
    return !!this.process && this.process.exitCode === null;
  }

  recentOutput(lines = 30): string {
    return this.output.slice(-lines).join("\n");
  }

  private async resolveBaseUrl(): Promise<string> {
    const device: Device = await deviceDetails(this.udid);
    const host = device.tunnelIP ? `[${device.tunnelIP}]` : device.hostnames.find((h) => h.startsWith(this.udid)) ?? device.hostnames[0];
    if (!host) throw new DriverError(`No network route to ${device.name}; is it connected and unlocked?`);
    this.baseUrl = `http://${host}:${PORT}`;
    return this.baseUrl;
  }

  async healthy(): Promise<any | null> {
    try {
      const base = this.baseUrl ?? (await this.resolveBaseUrl());
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  async start({ rebuild = false } = {}): Promise<any> {
    const existing = await this.healthy();
    if (existing && !rebuild) return existing;
    if (existing) await this.stop();

    const xctestrun = await buildRunner(this.udid, rebuild);
    log(`starting driver on ${this.udid}`);
    this.output = [];
    // When the run ends, xcodebuild collects diagnostics with `devicectl diagnose`, which runs sudo.
    // sudo prompts for a password on the controlling terminal, which is Claude Code's input box.
    // Skip the collection, and detach so nothing the driver spawns can reach the terminal.
    const child = spawn(
      "xcodebuild",
      [
        "test-without-building", "-xctestrun", xctestrun, "-destination", `id=${this.udid}`,
        "-test-timeouts-enabled", "NO", "-collect-test-diagnostics", "never",
      ],
      { env: { ...process.env, TEST_RUNNER_DRIVER_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    this.process = child;
    const collect = (chunk: Buffer) => {
      this.output.push(...chunk.toString().split("\n").filter(Boolean));
      if (this.output.length > 500) this.output.splice(0, this.output.length - 500);
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);

    const deadline = Date.now() + 180_000;
    await this.resolveBaseUrl();
    for (let i = 1; Date.now() < deadline; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (child.exitCode !== null) {
        throw new DriverError(`Driver exited before it came up:\n${this.explainFailure()}`);
      }
      const health = await this.healthy();
      if (health) return health;
      // The tunnel address can change while xcodebuild prepares the device.
      if (i % 5 === 0) await this.resolveBaseUrl().catch(() => {});
    }
    child.kill();
    throw new DriverError(`Driver did not respond within 3 minutes:\n${this.explainFailure()}`);
  }

  private explainFailure(): string {
    const text = this.recentOutput(40);
    if (/Unlock .* to Continue|device is locked/i.test(text)) return "The device is locked. Unlock it and try again.";
    if (/Authentication canceled/i.test(text)) {
      return "UI automation was not authorized on the device. Unlock it, start again, and enter the passcode when iOS asks to allow UI automation.";
    }
    if (/not trusted|Untrusted Developer/i.test(text)) {
      return "The runner's developer certificate is not trusted on the device: Settings > General > VPN & Device Management.";
    }
    return text.split("\n").filter((l) => /error|fail/i.test(l)).slice(-8).join("\n") || text;
  }

  async stop(): Promise<void> {
    if (this.baseUrl) {
      await fetch(`${this.baseUrl}/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
    this.process?.kill();
    this.process = undefined;
  }

  /** Call the driver, refreshing the tunnel address once if the request fails to connect. */
  async request<T = any>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const base = this.baseUrl ?? (await this.resolveBaseUrl());
      let res: Response;
      try {
        res = await fetch(base + path, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt === 0) {
          await this.resolveBaseUrl();
          continue;
        }
        throw new DriverError(`Driver unreachable at ${base}: ${(err as Error).message}`);
      }
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new DriverError(json.error ?? `HTTP ${res.status}`);
      return json as T;
    }
  }
}

const drivers = new Map<string, Driver>();

export function driverFor(udid: string): Driver {
  let driver = drivers.get(udid);
  if (!driver) drivers.set(udid, (driver = new Driver(udid)));
  return driver;
}

/** Return a driver that is up, starting it if needed. */
export async function ensureDriver(udid: string): Promise<Driver> {
  const driver = driverFor(udid);
  if (!(await driver.healthy())) await driver.start();
  return driver;
}

export async function stopAllDrivers(): Promise<void> {
  await Promise.all([...drivers.values()].map((d) => d.stop()));
}
