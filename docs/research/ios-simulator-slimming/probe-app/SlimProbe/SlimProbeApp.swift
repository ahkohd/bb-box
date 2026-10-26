import Contacts
import CoreLocation
import Photos
import SwiftUI
import UserNotifications

@main
struct SlimProbeApp: App {
    @UIApplicationDelegateAdaptor(NotificationReceiver.self) var notificationReceiver

    var body: some Scene {
        WindowGroup {
            ProbeView(probe: notificationReceiver.probe)
        }
    }
}

final class Probe: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var location = "none"
    @Published var lastPush = "none"
    @Published var pasted = "none"
    @Published var taps = 0
    @Published var typed = ""
    private let locationManager = CLLocationManager()

    func startLocation() {
        locationManager.delegate = self
        locationManager.requestWhenInUseAuthorization()
        locationManager.startUpdatingLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        location = String(format: "%.4f,%.4f", latest.coordinate.latitude, latest.coordinate.longitude)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        location = "error \((error as NSError).code)"
    }

    var contactsAccess: String {
        String(describing: CNContactStore.authorizationStatus(for: .contacts).rawValue)
    }

    var photosAccess: String {
        String(describing: PHPhotoLibrary.authorizationStatus(for: .readWrite).rawValue)
    }

    func readPasteboard() {
        pasted = UIPasteboard.general.string ?? "empty"
    }
}

final class NotificationReceiver: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let probe = Probe()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let title = notification.request.content.title
        await MainActor.run { probe.lastPush = title }
        return [.banner, .list]
    }
}

struct ProbeView: View {
    @ObservedObject var probe: Probe
    @State private var refresh = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("location: \(probe.location)")
            Text("push: \(probe.lastPush)")
            Text("contacts: \(probe.contactsAccess) photos: \(probe.photosAccess) \(refresh)")
            Text("pasted: \(probe.pasted)")
            Text("taps: \(probe.taps)").accessibilityIdentifier("tapCount")
            Button("Tap me") { probe.taps += 1 }.accessibilityIdentifier("tapButton")
            Button("Read pasteboard") { probe.readPasteboard() }
            Button("Refresh access") { refresh += 1 }
            TextField("type here", text: $probe.typed)
                .accessibilityIdentifier("input")
                .textFieldStyle(.roundedBorder)
            Text("typed: \(probe.typed)").accessibilityIdentifier("typedEcho")
        }
        .padding()
        .onAppear { probe.startLocation() }
    }
}
