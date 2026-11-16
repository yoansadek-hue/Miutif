import Foundation

/// Une sortie (album, EP ou single) d'un artiste de la librairie.
struct Release: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let artistName: String
    let releaseDate: Date
    let url: URL?
    let artworkURL: URL?
    let isSingle: Bool

    var kindLabel: String { isSingle ? "Single" : "Album" }

    /// Sortie dans les dernières 24 h.
    var isFresh: Bool { Date().timeIntervalSince(releaseDate) < 36 * 3600 }
}

extension Date {
    /// Prochain 11:00 (aujourd'hui si on est avant 11 h, sinon demain).
    static func nextNotificationTime(from now: Date = Date(), hour: Int = 11) -> Date {
        let cal = Calendar.current
        let today = cal.date(bySettingHour: hour, minute: 0, second: 0, of: now)!
        return now < today ? today : cal.date(byAdding: .day, value: 1, to: today)!
    }
}
