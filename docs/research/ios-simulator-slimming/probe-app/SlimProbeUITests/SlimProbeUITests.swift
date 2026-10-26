import XCTest

final class SlimProbeUITests: XCTestCase {
    func testTapsAreCounted() {
        let app = XCUIApplication()
        app.launch()
        dismissNotificationPrompt()
        for _ in 0..<5 { app.buttons["tapButton"].tap() }
        XCTAssertEqual(app.staticTexts["tapCount"].label, "taps: 5")
    }

    func testTypedTextIsEchoed() {
        let app = XCUIApplication()
        app.launch()
        dismissNotificationPrompt()
        let field = app.textFields["input"]
        field.tap()
        field.typeText("Hello probe 123")
        XCTAssertEqual(app.staticTexts["typedEcho"].label, "typed: Hello probe 123")
    }

    func testRelaunchKeepsWorking() {
        let app = XCUIApplication()
        for round in 1...3 {
            app.launch()
            dismissNotificationPrompt()
            app.buttons["tapButton"].tap()
            XCTAssertEqual(app.staticTexts["tapCount"].label, "taps: 1", "round \(round)")
            app.terminate()
        }
    }

    private func dismissNotificationPrompt() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
    }
}
