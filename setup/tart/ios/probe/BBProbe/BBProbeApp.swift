import SwiftUI

@main
struct BBProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeView() }
    }
}

struct ProbeView: View {
    @State private var taps = 0
    @State private var typed = ""

    var body: some View {
        VStack(spacing: 16) {
            TextField("Type here", text: $typed)
                .accessibilityIdentifier("input")
                .textFieldStyle(.roundedBorder)
            Text("typed: \(typed)").accessibilityIdentifier("typedEcho")
            Button("Tap me") { taps += 1 }.accessibilityIdentifier("tapButton")
            Text("taps: \(taps)").accessibilityIdentifier("tapCount")
        }
        .padding()
    }
}
