import Foundation
import MusicKit

/// État de l'app + logique de vérification des sorties.
@MainActor
final class ReleaseStore: ObservableObject {
    static let shared = ReleaseStore()

    /// Une sortie est « nouvelle » si elle date de moins de 7 jours.
    private let newWindow: TimeInterval = 7 * 24 * 3600
    /// On garde l'historique affiché sur 30 jours.
    private let historyWindow: TimeInterval = 30 * 24 * 3600
    /// La liste des artistes est relue au plus une fois toutes les 12 h.
    private let artistCacheLifetime: TimeInterval = 12 * 3600

    @Published private(set) var authorization: MusicAuthorization.Status = MusicAuthorization.currentStatus
    @Published private(set) var releases: [Release] = []
    @Published private(set) var artistCount = 0
    @Published private(set) var lastCheck: Date?
    @Published private(set) var isRefreshing = false
    @Published var errorMessage: String?

    private let defaults = UserDefaults.standard
    private var notifiedIDs: Set<String>
    private var cachedArtistIDs: [String]
    private var artistsFetchedAt: Date?

    private init() {
        notifiedIDs = Set(defaults.stringArray(forKey: Keys.notified) ?? [])
        cachedArtistIDs = defaults.stringArray(forKey: Keys.artists) ?? []
        artistsFetchedAt = defaults.object(forKey: Keys.artistsDate) as? Date
        lastCheck = defaults.object(forKey: Keys.lastCheck) as? Date
        artistCount = cachedArtistIDs.count
        if let data = defaults.data(forKey: Keys.releases),
           let saved = try? JSONDecoder().decode([Release].self, from: data) {
            releases = saved
        }
    }

    // MARK: - Connexion

    func connect() async {
        authorization = await MusicAuthorization.request()
        guard authorization == .authorized else { return }
        await NotificationScheduler.requestPermission()
        await refresh()
        BackgroundRefresh.schedule()
    }

    // MARK: - Vérification

    /// Récupère les dernières sorties et programme les notifs de 11 h.
    /// Appelée à l'ouverture de l'app et par la tâche de fond.
    func refresh(forceArtistReload: Bool = false) async {
        authorization = MusicAuthorization.currentStatus
        guard authorization == .authorized, !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let artistIDs = try await loadArtistIDs(force: forceArtistReload)
            let latest = try await MusicService.latestReleases(for: artistIDs)
            let now = Date()

            // Nouvelles sorties à notifier (déjà sorties, < 7 jours, jamais notifiées).
            let toNotify = latest.filter {
                $0.releaseDate <= now
                    && now.timeIntervalSince($0.releaseDate) < newWindow
                    && !notifiedIDs.contains($0.id)
            }
            await NotificationScheduler.schedule(toNotify)
            notifiedIDs.formUnion(toNotify.map(\.id))

            // Historique affiché dans l'app.
            var byID = Dictionary(uniqueKeysWithValues: releases.map { ($0.id, $0) })
            for r in latest where r.releaseDate <= now { byID[r.id] = r }
            releases = byID.values
                .filter { now.timeIntervalSince($0.releaseDate) < historyWindow }
                .sorted { $0.releaseDate > $1.releaseDate }

            lastCheck = now
            errorMessage = nil
            persist()
        } catch {
            errorMessage = "Impossible de joindre Apple Music : \(error.localizedDescription)"
        }
    }

    private func loadArtistIDs(force: Bool) async throws -> [MusicItemID] {
        let cacheIsFresh = artistsFetchedAt.map { Date().timeIntervalSince($0) < artistCacheLifetime } ?? false
        if force || !cacheIsFresh || cachedArtistIDs.isEmpty {
            let ids = try await MusicService.libraryCatalogArtistIDs()
            cachedArtistIDs = ids.map(\.rawValue)
            artistsFetchedAt = Date()
            artistCount = ids.count
        }
        return cachedArtistIDs.map { MusicItemID($0) }
    }

    private func persist() {
        defaults.set(Array(notifiedIDs), forKey: Keys.notified)
        defaults.set(cachedArtistIDs, forKey: Keys.artists)
        defaults.set(artistsFetchedAt, forKey: Keys.artistsDate)
        defaults.set(lastCheck, forKey: Keys.lastCheck)
        if let data = try? JSONEncoder().encode(releases) {
            defaults.set(data, forKey: Keys.releases)
        }
    }

    private enum Keys {
        static let notified = "notifiedReleaseIDs"
        static let artists = "libraryCatalogArtistIDs"
        static let artistsDate = "artistsFetchedAt"
        static let lastCheck = "lastCheck"
        static let releases = "releases"
    }
}
