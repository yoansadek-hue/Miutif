import Foundation
import UserNotifications

/// Programme les notifications locales : une par sortie, à 11 h 00.
enum NotificationScheduler {

    static let urlKey = "appleMusicURL"
    private static let center = UNUserNotificationCenter.current()

    @discardableResult
    static func requestPermission() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// Programme une notification pour chaque sortie au prochain 11:00.
    static func schedule(_ releases: [Release]) async {
        guard !releases.isEmpty else { return }
        let fireDate = Date.nextNotificationTime()
        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: fireDate)

        for release in releases {
            let content = await makeContent(for: release)
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            let request = UNNotificationRequest(identifier: "release-\(release.id)", content: content, trigger: trigger)
            try? await center.add(request)
        }
    }

    /// Notification de test dans 5 secondes (pour vérifier la redirection).
    static func sendTest(with release: Release?) async {
        let content: UNMutableNotificationContent
        if let release {
            content = await makeContent(for: release)
        } else {
            content = UNMutableNotificationContent()
            content.title = "Miutif"
            content.body = "Les notifications fonctionnent. Rendez-vous à 11 h !"
            content.sound = .default
        }
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        try? await center.add(UNNotificationRequest(identifier: "test-\(UUID())", content: content, trigger: trigger))
    }

    private static func makeContent(for release: Release) async -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Nouveau \(release.isSingle ? "single" : "projet") de \(release.artistName)"
        content.body = "« \(release.title) » est disponible sur Apple Music. Touchez pour écouter."
        content.sound = .default
        content.threadIdentifier = "miutif-releases"
        if let url = release.url {
            content.userInfo = [urlKey: url.absoluteString]
        }
        if let attachment = await artworkAttachment(for: release) {
            content.attachments = [attachment]
        }
        return content
    }

    /// Télécharge la pochette pour l'afficher dans la notification.
    private static func artworkAttachment(for release: Release) async -> UNNotificationAttachment? {
        guard let artworkURL = release.artworkURL,
              let (data, _) = try? await URLSession.shared.data(from: artworkURL) else { return nil }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("artwork-\(release.id).jpg")
        do {
            try data.write(to: file)
            return try UNNotificationAttachment(identifier: release.id, url: file)
        } catch {
            return nil
        }
    }
}
