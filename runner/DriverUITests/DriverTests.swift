import XCTest
import UIKit
import AVFoundation

/// A never-ending UI test that exposes XCUITest over HTTP so the MCP server can
/// drive whatever app is on screen. Start with `xcodebuild test-without-building`.
final class DriverTests: XCTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var currentBundleId: String?
    /// Installed app bundle IDs, scanned to find the foreground app when the
    /// user switched apps by hand.
    private var candidateBundleIds: [String] = []
    private var lastIssue: String?
    private var shouldStop = false

    override func setUp() {
        continueAfterFailure = true
    }

    /// Capture XCTest failures (e.g. "no keyboard focus") so they become HTTP
    /// errors instead of ending the session.
    override func record(_ issue: XCTIssue) {
        lastIssue = issue.compactDescription
    }

    func testRunDriver() throws {
        let port = UInt16(ProcessInfo.processInfo.environment["DRIVER_PORT"] ?? "") ?? 22087
        let server = try HTTPServer(port: port) { [unowned self] request in
            self.lastIssue = nil
            let response: HTTPResponse
            do {
                response = try self.route(request)
            } catch {
                return .error("\(error)")
            }
            if let issue = self.lastIssue { return .error(issue) }
            return response
        }
        server.start()
        NSLog("ios-device-mcp driver listening on port \(port)")
        while !shouldStop {
            _ = RunLoop.main.run(mode: .default, before: .distantFuture)
        }
    }

    // MARK: - Routing

    private func route(_ req: HTTPRequest) throws -> HTTPResponse {
        let body = req.json
        switch (req.method, req.path) {
        case ("GET", "/health"):
            let size = screenSize()
            return .json([
                "ok": true,
                "screen": ["width": size.width, "height": size.height],
                "orientation": XCUIDevice.shared.orientation.rawValue,
                "currentApp": foregroundApp().bundleId,
            ])

        case ("GET", "/screenshot"):
            let quality = Double(req.query["quality"] ?? "") ?? 0.6
            let fullRes = req.query["fullRes"] == "1"
            return .json(screenshot(quality: quality, fullRes: fullRes))

        case ("GET", "/source"):
            let target = req.query["bundleId"].map { (app: XCUIApplication(bundleIdentifier: $0), bundleId: $0) } ?? foregroundApp()
            let snapshot = try target.app.snapshot()
            var result: [String: Any] = ["bundleId": target.bundleId, "tree": node(snapshot)]
            // System alerts (permission prompts etc.) live in SpringBoard.
            if target.bundleId != "com.apple.springboard" {
                let alerts = springboard.alerts
                if alerts.count > 0 {
                    result["systemAlerts"] = try alerts.allElementsBoundByIndex.map { node(try $0.snapshot()) }
                }
            }
            return .json(result)

        case ("POST", "/tap"):
            let received = Date()
            let point = coordinate(body)
            // Time spent before the touch starts, so audio sync can exclude it.
            let setup = Date().timeIntervalSince(received)
            point.tap()
            return .json(["ok": true, "setup": setup])

        case ("POST", "/double_tap"):
            coordinate(body).doubleTap()
            return .json(["ok": true])

        case ("POST", "/long_press"):
            coordinate(body).press(forDuration: body["duration"] as? Double ?? 1.0)
            return .json(["ok": true])

        case ("POST", "/swipe"):
            let from = coordinate(["x": body["fromX"] ?? 0, "y": body["fromY"] ?? 0])
            let to = coordinate(["x": body["toX"] ?? 0, "y": body["toY"] ?? 0])
            let duration = max(body["duration"] as? Double ?? 0.3, 0.05)
            let dx = (body["toX"] as? Double ?? 0) - (body["fromX"] as? Double ?? 0)
            let dy = (body["toY"] as? Double ?? 0) - (body["fromY"] as? Double ?? 0)
            let velocity = max((dx * dx + dy * dy).squareRoot() / duration, 50)
            from.press(forDuration: 0.05, thenDragTo: to, withVelocity: XCUIGestureVelocity(velocity), thenHoldForDuration: 0)
            return .json(["ok": true])

        case ("POST", "/type"):
            guard let text = body["text"] as? String else { return .error("text is required", status: 400) }
            foregroundApp().app.typeText(text)
            return .json(["ok": true])

        case ("POST", "/button"):
            let buttons: [String: XCUIDevice.Button] = ["home": .home, "volumeUp": .volumeUp, "volumeDown": .volumeDown]
            guard let name = body["name"] as? String, let button = buttons[name] else {
                return .error("name must be one of: \(buttons.keys.sorted().joined(separator: ", "))", status: 400)
            }
            let previous = name == "home" ? foregroundApp() : nil
            XCUIDevice.shared.press(button)
            if let previous, previous.bundleId != "com.apple.springboard" {
                // Wait for the home screen; if it never shows, the press was
                // dropped and activating SpringBoard has the same effect.
                let deadline = Date().addingTimeInterval(1.5)
                while !homeScreenVisible() && Date() < deadline {
                    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                }
                if !homeScreenVisible() { springboard.activate() }
            }
            if name == "home" { currentBundleId = nil }
            return .json(["ok": true])

        case ("POST", "/launch"):
            guard let bundleId = body["bundleId"] as? String else { return .error("bundleId is required", status: 400) }
            let app = XCUIApplication(bundleIdentifier: bundleId)
            if let args = body["arguments"] as? [String] { app.launchArguments = args }
            if let env = body["environment"] as? [String: String] { app.launchEnvironment = env }
            app.launch()
            currentBundleId = bundleId
            return .json(["ok": true, "state": app.state.rawValue])

        case ("POST", "/activate"):
            guard let bundleId = body["bundleId"] as? String else { return .error("bundleId is required", status: 400) }
            let app = XCUIApplication(bundleIdentifier: bundleId)
            app.activate()
            currentBundleId = bundleId
            return .json(["ok": true, "state": app.state.rawValue])

        case ("POST", "/terminate"):
            guard let bundleId = body["bundleId"] as? String else { return .error("bundleId is required", status: 400) }
            XCUIApplication(bundleIdentifier: bundleId).terminate()
            return .json(["ok": true])

        case ("GET", "/state"):
            guard let bundleId = req.query["bundleId"] else { return .error("bundleId is required", status: 400) }
            let state = XCUIApplication(bundleIdentifier: bundleId).state
            return .json(["state": stateName(state)])

        case ("POST", "/open_url"):
            guard let string = body["url"] as? String, let url = URL(string: string) else {
                return .error("valid url is required", status: 400)
            }
            XCUIDevice.shared.system.open(url)
            return .json(["ok": true])

        case ("POST", "/orientation"):
            let values: [String: UIDeviceOrientation] = [
                "portrait": .portrait, "portraitUpsideDown": .portraitUpsideDown,
                "landscapeLeft": .landscapeLeft, "landscapeRight": .landscapeRight,
            ]
            guard let name = body["value"] as? String, let value = values[name] else {
                return .error("value must be one of: \(values.keys.sorted().joined(separator: ", "))", status: 400)
            }
            XCUIDevice.shared.orientation = value
            return .json(["ok": true])

        case ("POST", "/volume"):
            guard let target = (body["level"] as? NSNumber)?.doubleValue, (0...1).contains(target) else {
                return .error("level must be between 0 and 1", status: 400)
            }
            let result = setVolume(target)
            if let error = result["error"] as? String { return .error(error) }
            return .json(result)

        case ("POST", "/candidates"):
            candidateBundleIds = body["bundleIds"] as? [String] ?? []
            return .json(["ok": true, "count": candidateBundleIds.count])

        case ("POST", "/shutdown"):
            shouldStop = true
            return .json(["ok": true])

        default:
            return .error("no route for \(req.method) \(req.path)", status: 404)
        }
    }

    // MARK: - Helpers

    /// The app the driver should act on: the last known foreground app if it is
    /// still in front, else whichever candidate app is, else SpringBoard.
    private func foregroundApp() -> (app: XCUIApplication, bundleId: String) {
        for id in [currentBundleId].compactMap({ $0 }) + candidateBundleIds where id != "com.apple.springboard" {
            let app = XCUIApplication(bundleIdentifier: id)
            if app.state == .runningForeground {
                // App state can lag several seconds behind leaving the app; if the
                // home screen is actually showing, trust that instead.
                if homeScreenVisible() { break }
                currentBundleId = id
                return (app, id)
            }
        }
        return (springboard, "com.apple.springboard")
    }

    /// Volume (0–1) shown by SpringBoard's volume HUD, which appears for a moment
    /// after each button press. AVAudioSession.outputVolume can't be used: it is
    /// frozen at its first reading for the life of the runner process.
    private func hudVolume() -> Double? {
        // snapshot() throws instead of recording a test failure when the HUD
        // fades out between lookup and read.
        let hud = springboard.otherElements["sb-volume-hud"].firstMatch
        guard let value = (try? hud.snapshot())?.value as? String else { return nil }
        return Double(value.replacingOccurrences(of: "%", with: "").trimmingCharacters(in: .whitespaces)).map { $0 / 100 }
    }

    /// Press a volume button and return the level the HUD shows once it reflects the press.
    private func pressVolume(up: Bool) -> Double? {
        let before = hudVolume()
        XCUIDevice.shared.press(up ? .volumeUp : .volumeDown)
        var level = hudVolume()
        let deadline = Date().addingTimeInterval(0.8)
        while (level == nil || level == before) && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            level = hudVolume()
        }
        return level
    }

    /// iOS has no API to set the volume, so press the hardware buttons toward the
    /// target (16 steps), reading the HUD after each press, until it is reached
    /// or stops changing.
    private func setVolume(_ target: Double) -> [String: Any] {
        let step = 1.0 / 16
        // outputVolume is stale but still a fair hint for which way to press first.
        let hint = Double(AVAudioSession.sharedInstance().outputVolume)
        guard var current = pressVolume(up: target > hint) else {
            return ["error": "volume HUD did not appear after pressing a volume button"]
        }
        var presses = 1
        // Press the computed number of steps back to back, then verify on the HUD
        // and correct; stop if a round changes nothing (a volume limit applies).
        for _ in 0..<4 {
            let steps = Int(((target - current) / step).rounded())
            if steps == 0 { break }
            for _ in 0..<abs(steps) { XCUIDevice.shared.press(steps > 0 ? .volumeUp : .volumeDown) }
            presses += abs(steps)
            var level = hudVolume()
            let deadline = Date().addingTimeInterval(1)
            while (level == nil || level == current) && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
                level = hudVolume()
            }
            // Let the HUD catch up with the last press before trusting it.
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            level = hudVolume() ?? level
            guard let level, level != current else { break }
            current = level
        }
        var result: [String: Any] = ["level": current, "presses": presses]
        if abs(target - current) > step / 2 {
            result["warning"] = "volume stopped changing at \(Int((current * 100).rounded()))% (a volume limit may apply, e.g. headphone safety)"
        }
        return result
    }

    /// Whether the home screen's icon grid is showing. Cheap (~40ms), unlike
    /// isHittable, which can block for seconds while an app is in front.
    private func homeScreenVisible() -> Bool {
        springboard.otherElements["Home screen icons"].firstMatch.exists
    }

    /// Screen size in points. UIScreen.main is unreliable here because the test
    /// runner app runs in legacy 320x480 compatibility mode.
    private func screenSize() -> CGSize {
        springboard.frame.size
    }

    /// Screen-absolute coordinate in points, anchored to the foreground app.
    /// Anchored to SpringBoard instead, a tap on an in-app alert button also
    /// reaches the view behind the alert.
    private func coordinate(_ body: [String: Any]) -> XCUICoordinate {
        let x = (body["x"] as? NSNumber)?.doubleValue ?? 0
        let y = (body["y"] as? NSNumber)?.doubleValue ?? 0
        // System alerts (permission prompts) belong to SpringBoard, and a touch
        // anchored to the app never reaches them.
        let alert = springboard.alerts.firstMatch
        if alert.exists, alert.frame.contains(CGPoint(x: x, y: y)) {
            return springboard.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
        }
        let (app, bundleId) = foregroundApp()
        // The app's frame isn't at the screen origin in iPad Split View or Stage Manager.
        let origin = bundleId == "com.apple.springboard" ? .zero : app.frame.origin
        return app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x - origin.x, dy: y - origin.y))
    }

    private func screenshot(quality: Double, fullRes: Bool) -> [String: Any] {
        let image = XCUIScreen.main.screenshot().image
        let pointSize = screenSize()
        let output: UIImage
        if fullRes {
            output = image
        } else {
            // Downscale to points so pixel coordinates in the image match tap coordinates.
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            output = UIGraphicsImageRenderer(size: pointSize, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: pointSize))
            }
        }
        let data = output.jpegData(compressionQuality: quality) ?? Data()
        return [
            "image": data.base64EncodedString(),
            "width": output.size.width * output.scale,
            "height": output.size.height * output.scale,
            "pointWidth": pointSize.width,
            "pointHeight": pointSize.height,
        ]
    }

    private func node(_ s: XCUIElementSnapshot) -> [String: Any] {
        var d: [String: Any] = [
            "type": typeName(s.elementType),
            "frame": [s.frame.origin.x, s.frame.origin.y, s.frame.size.width, s.frame.size.height].map { ($0 * 10).rounded() / 10 },
        ]
        if !s.identifier.isEmpty { d["id"] = s.identifier }
        if !s.label.isEmpty { d["label"] = s.label }
        if !s.title.isEmpty { d["title"] = s.title }
        if let v = s.value {
            let str = "\(v)"
            if !str.isEmpty { d["value"] = str }
        }
        if let p = s.placeholderValue, !p.isEmpty { d["placeholder"] = p }
        if !s.isEnabled { d["enabled"] = false }
        if s.isSelected { d["selected"] = true }
        if !s.children.isEmpty { d["children"] = s.children.map(node) }
        return d
    }

    private func stateName(_ state: XCUIApplication.State) -> String {
        switch state {
        case .notRunning: return "notRunning"
        case .runningBackgroundSuspended: return "backgroundSuspended"
        case .runningBackground: return "background"
        case .runningForeground: return "foreground"
        default: return "unknown"
        }
    }

    private func typeName(_ t: XCUIElement.ElementType) -> String {
        switch t {
        case .application: return "Application"
        case .window: return "Window"
        case .alert: return "Alert"
        case .sheet: return "Sheet"
        case .button: return "Button"
        case .keyboard: return "Keyboard"
        case .key: return "Key"
        case .navigationBar: return "NavigationBar"
        case .tabBar: return "TabBar"
        case .toolbar: return "Toolbar"
        case .statusBar: return "StatusBar"
        case .table: return "Table"
        case .cell: return "Cell"
        case .collectionView: return "CollectionView"
        case .scrollView: return "ScrollView"
        case .slider: return "Slider"
        case .pageIndicator: return "PageIndicator"
        case .progressIndicator: return "ProgressIndicator"
        case .activityIndicator: return "ActivityIndicator"
        case .segmentedControl: return "SegmentedControl"
        case .picker: return "Picker"
        case .pickerWheel: return "PickerWheel"
        case .datePicker: return "DatePicker"
        case .switch: return "Switch"
        case .toggle: return "Toggle"
        case .link: return "Link"
        case .image: return "Image"
        case .icon: return "Icon"
        case .searchField: return "SearchField"
        case .staticText: return "StaticText"
        case .textField: return "TextField"
        case .secureTextField: return "SecureTextField"
        case .textView: return "TextView"
        case .menu: return "Menu"
        case .menuItem: return "MenuItem"
        case .map: return "Map"
        case .webView: return "WebView"
        case .stepper: return "Stepper"
        case .tab: return "Tab"
        case .popover: return "Popover"
        case .group: return "Group"
        case .other: return "Other"
        default: return "Element\(t.rawValue)"
        }
    }
}
