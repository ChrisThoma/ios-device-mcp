# ios-device-mcp

An MCP server that drives a real iPhone or iPad (not the simulator) over USB for app development testing. It can build and install your app, launch it with console log capture, read the accessibility tree, tap, swipe, type and take screenshots.

## How it works

- **`devicectl`** (Xcode's CoreDevice CLI) lists devices and installs, uninstalls and launches apps.
- **`runner/`** is a small XCUITest bundle whose single test never ends. It runs an HTTP server on the device (port 22087) and maps requests to XCUITest calls (`XCUICoordinate.tap`, `typeText`, `snapshot()`, `XCUIScreen.screenshot()`…).
- **`src/`** is the Node MCP server. It builds the runner with `xcodebuild build-for-testing`, starts it with `xcodebuild test-without-building`, and reaches it through the device's CoreDevice tunnel address (`fd…::1`). The tunnel works over USB and Wi-Fi with no port forwarding.

The driver starts automatically the first time a UI tool runs, takes about 5–8 s to start, and stops when the MCP server exits.

## Requirements

- macOS with Xcode 16+ and `xcodegen` (`brew install xcodegen`); `ffmpeg` for audio recording (`brew install ffmpeg`)
- Node 20+
- An iPhone/iPad that is paired, has Developer Mode on, is unlocked, and is registered in your developer team

## Setup

```sh
git clone <repo-url> ios-device-mcp && cd ios-device-mcp
npm install && npm run build
```

Your Team ID is in Xcode > Settings > Accounts (select the team), or on developer.apple.com under Membership. Then register the server with Claude Code for all your projects:

```sh
claude mcp add --scope user ios-device \
  -e IOS_DEVICE_MCP_TEAM_ID=<TEAMID> \
  -- node "$PWD/dist/index.js"
```

Other MCP clients: run `node dist/index.js` over stdio with the same env vars. See `.mcp.example.json` for a project-scoped config.

| Env var | Purpose |
| --- | --- |
| `IOS_DEVICE_MCP_TEAM_ID` | Required. Team used to sign the runner |
| `IOS_DEVICE_MCP_BUNDLE_PREFIX` | Runner bundle ID prefix (default `dev.iosdevicemcp.<team>`) |
| `IOS_DEVICE_MCP_DEVICE` | UDID or name of the device to use |
| `IOS_DEVICE_MCP_ALLOW_DEVICE_REGISTRATION` | `1` lets the build register a new device in your team |
| `IOS_DEVICE_MCP_PORT` | Driver port (default 22087) |
| `IOS_DEVICE_MCP_AUDIO_DEVICE` | Mac mic name substring for recordings (default: first non-iPhone/iPad input) |
| `IOS_DEVICE_MCP_RECORDINGS_DIR` | Where WAVs go (default `.build/recordings`) |

The pre-rename `IPHONE_MCP_*` names are still read as a fallback.

**Device selection:** if neither `IOS_DEVICE_MCP_DEVICE` nor a tool's `device` argument is set, the server only picks a device that is physically connected over USB. It never picks a Wi-Fi-only device implicitly.

**First run on a device:** iOS asks for the passcode to allow UI automation. Keep the device unlocked while the driver starts.

## Tools

| Tool | What it does |
| --- | --- |
| `list_devices`, `list_apps` | Show devices and installed apps |
| `build_app` | `xcodebuild` a project/workspace scheme for the device and install it |
| `install_app`, `uninstall_app` | Install a `.app`/`.ipa`, remove an app |
| `launch_app` | Launch/relaunch; `captureLogs: true` buffers the app's console: `print`/`NSLog` plus `os_log`/`Logger` (`logLevel`: `debug` default, `info`, `stdout`) |
| `get_app_logs` | Read captured output; `grep` filters by case-insensitive regex (e.g. a `[category]`) |
| `terminate_app` | Force-quit an app |
| `list_app_files`, `pull_file` | List / copy files from an app's data container (dev-signed apps). `pull_file` can wait for a file (`waitSeconds`) or for one written after the last launch (`modifiedAfter: "lastLaunch"`); small text files come back inline |
| `screenshot` | JPEG scaled to points, so image pixels equal tap coordinates |
| `describe_ui` | Compact accessibility tree with `@(x,y)` tap centers, plus system alerts |
| `tap`, `double_tap`, `long_press`, `swipe`, `scroll` | Coordinate gestures (points). `tap` and `tap_element` take `recordAudio: {seconds, leadIn?, audioDevice?}` to record the Mac mic around the tap and report the tap's offset in the WAV |
| `record_audio` | Record the Mac mic for N seconds |
| `set_volume` | Set media volume to a level (0–1, 16 steps), verified on the system volume indicator |
| `tap_element`, `wait_for_element` | Find by text / accessibility ID / type, with waiting and `scrollDirection` scroll-to-find |
| `type_text` | Type into the focused field (`submit` presses return) |
| `press_button` | `home`, `volumeUp`, `volumeDown` |
| `open_url` | Open a URL or deep link |
| `set_orientation` | Rotate the interface |
| `start_driver`, `stop_driver` | Manage the on-device driver explicitly (`rebuild: true` forces a rebuild) |

Text matching in `tap_element` tries exact label/ID/value matches first, then whole-word matches in short labels. Every result says which element was tapped. Give your app accessibility identifiers and match with `id` for the most reliable tests.

## Known limitations

- **Foreground app:** detected from the last launched app, else by scanning installed apps' states, else SpringBoard.
- **Home button:** `XCUIDevice.press(.home)` is ignored on some iOS 26 builds, so the driver falls back to activating SpringBoard. The press takes about 2–3 s.
- **Landscape:** coordinates are screen points in the current orientation, and landscape has had little testing.
- **Logs:** `os_log`/`Logger` capture works like Xcode's console: the app is launched with `OS_ACTIVITY_DT_MODE` (and `OS_ACTIVITY_MODE=debug`), which mirrors its log messages to stderr. Only messages from the app's own process are captured, not from system daemons or extensions. Private values show in plain text. Lines show `[category]` but not the subsystem.
- **Recording sync:** recordings use `ffmpeg` (`brew install ffmpeg`), and the terminal needs microphone permission. Recording start is measured to about ±70 ms. XCUITest takes about 0.4–0.7 s to deliver a tap, so the result gives a window ("sent at … completed at …"), and in testing the sound always landed inside it.
- **Volume:** iOS has no API to set the volume, and the level an app can read goes stale. `set_volume` presses the buttons and reads SpringBoard's volume indicator to verify the level, so the indicator briefly shows on screen.
- **No lock/unlock or Face ID simulation.**

## License

MIT. See [LICENSE](LICENSE).
