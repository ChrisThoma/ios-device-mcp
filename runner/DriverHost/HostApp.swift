import SwiftUI

// Placeholder host app. XCUITest bundles need a target app; the driver
// itself controls whatever app is in the foreground.
@main
struct HostApp: App {
    var body: some Scene {
        WindowGroup {
            Text("ios-device-mcp driver host")
        }
    }
}
