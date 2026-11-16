import SwiftUI
import UserNotifications

@main
struct MiutifApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = ReleaseStore.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await store.refresh() }
        }
        .backgroundTask(.appRefresh(BackgroundRefresh.identifier)) {
            BackgroundRefresh.schedule() // prochain réveil demain matin
            await ReleaseStore.shared.refresh()
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        BackgroundRefresh.schedule()
        return true
    }

    /// Affiche aussi la notif quand l'app est ouverte.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    /// Appui sur une notification → ouverture directe dans Apple Music.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        guard let link = response.notification.request.content.userInfo[NotificationScheduler.urlKey] as? String,
              let url = URL(string: link) else { return }
        await MainActor.run { AppleMusicLink.open(url) }
    }
}

enum AppleMusicLink {
    /// Les liens music.apple.com sont des liens universels :
    /// iOS les ouvre directement dans l'app Musique.
    @MainActor
    static func open(_ url: URL) {
        UIApplication.shared.open(url)
    }
}
