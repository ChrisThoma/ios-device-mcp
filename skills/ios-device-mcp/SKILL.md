---
name: ios-device-mcp
description: "Drive a real, USB-connected iPhone or iPad through the ios-device-mcp server to build, install, launch and test an iOS app on hardware: tap, type, read the screen, capture print/os_log output, pull files from the app container, and record audio in sync with a tap. Use when testing on a physical device rather than the simulator, or when the user says \"run it on my phone\", \"test on device\", \"what's on the device screen\", or needs real audio, microphone or hardware behavior."
---

# Testing on a real iOS device

This skill drives the tools of the `ios-device-mcp` MCP server
(`build_app`, `launch_app`, `describe_ui`, `tap_element`, …). If those
tools aren't available, the server isn't installed: point the user to
https://github.com/ChrisThoma/ios-device-mcp and stop.

## Ground rules

- **Only the device the user means.** Without a `device` argument the
  server uses the one iPhone/iPad on the USB cable (or the device pinned in
  `IOS_DEVICE_MCP_DEVICE`). If `list_devices` shows several and it's
  unclear which to use, ask. Never pick a Wi-Fi-only device on your own.
  Once you know, `select_device` it so later calls go there. With two
  devices in play, pass `device` on every call to the other one.
- **The device is personal.** It's usually the user's own phone, so don't
  change settings, send messages, make purchases or confirm destructive
  dialogs ("Delete", "Reset", "Erase") outside the app under test.
- **Check what you tapped.** Every tap result names the element it hit.
  If it isn't what you meant, stop and look (`describe_ui`) before the
  next action.

## The loop

1. **Build and install:** `build_app` with the `.xcodeproj` or
   `.xcworkspace` and scheme. It uses the project's own signing.
2. **Launch with logs:** `launch_app` with `captureLogs: true`. This
   captures `print`, `NSLog` and `os_log`/`Logger` (debug level by
   default). Pass test hooks via `arguments`/`environment`.
3. **Look:** `describe_ui` first. It is cheaper and more exact than a
   screenshot: one element per line with its tap point `@(x,y)`. Use
   `screenshot` for visual checks (layout, colors, images). Its pixels
   equal tap coordinates.
4. **Act:** prefer `tap_element` with `id` (accessibility identifier),
   then `text`, over raw `tap` coordinates. Add `scrollDirection` when the
   target may be below the fold, since lists only load visible rows.
   `type_text` needs a focused field, so tap it first; `submit: true`
   presses return, and `deleteCount` presses delete first (to clear or
   edit a field).
5. **Wait, don't sleep:** `wait_for_element` for the next screen (or
   `gone: true` for a spinner) instead of fixed delays.
6. **Check results:** `get_app_logs` with `grep` (e.g. `\[network\]`,
   `error|fault`); `pull_file` for files the app writes.

## Specific jobs

- **Files the app writes** (results, exports, timelines): `pull_file` with
  `modifiedAfter: "lastLaunch"` waits for a file written after the last
  `launch_app`, so a stale one from an earlier run doesn't count.
  `list_app_files` shows the container. Only works for apps the user signs
  themselves.
- **Audio the app plays:** pass `recordAudio: { seconds }` to `tap` or
  `tap_element`. It records the Mac's microphone, sends the tap once audio
  is flowing, and reports where in the WAV the tap landed (a window of
  about 0.4–0.7 s, since taps take that long to deliver). Call
  `set_volume` first so every run starts at the same level.
- **Known starting state:** `terminate_app` plus `launch_app`, then
  `set_volume`, `set_orientation`, and `open_url` for deep links.
- **System alerts** (permission prompts) appear at the end of
  `describe_ui` output; `tap_element` searches them first. Ask the user
  before granting a permission they may not want granted.

## When things go wrong

- **"Unlock the device" / "UI automation was not authorized":** the user
  must unlock the phone, and on first use enter the passcode when iOS asks
  to allow UI automation. Ask them, then retry.
- **"isn't registered in your developer account":** the device needs
  adding to their team (Xcode, or `IOS_DEVICE_MCP_ALLOW_DEVICE_REGISTRATION=1`).
  That changes their developer account, so ask first.
- **Element not found:** run `describe_ui` and read what's actually there.
  Labels often differ from what the code suggests, and off-screen list
  rows don't exist until scrolled to.
- **Tapped the wrong thing:** usually a partial text match. Use `id` or
  `exact: true`.
- The driver starts on the first UI call (5–8 s) and only one UI-test
  session can run per device. If another agent is using the same phone,
  starting yours interrupts theirs.
