import Foundation
import MusicKit

/// Tout ce qui parle à Apple Music.
enum MusicService {

    // MARK: - Librairie

    /// Renvoie les identifiants *catalogue* de tous les artistes de la librairie.
    /// On passe par l'API brute pour pouvoir demander `include=catalog`
    /// (les artistes de la librairie ont des identifiants locaux).
    static func libraryCatalogArtistIDs() async throws -> [MusicItemID] {
        var ids: [MusicItemID] = []
        var seen = Set<String>()
        var offset = 0

        while true {
            var comps = URLComponents(string: "https://api.music.apple.com/v1/me/library/artists")!
            comps.queryItems = [
                URLQueryItem(name: "include", value: "catalog"),
                URLQueryItem(name: "limit", value: "100"),
                URLQueryItem(name: "offset", value: String(offset)),
            ]
            let response = try await MusicDataRequest(urlRequest: URLRequest(url: comps.url!)).response()
            let page = try JSONDecoder().decode(LibraryArtistsPage.self, from: response.data)

            for artist in page.data {
                guard let catalogID = artist.relationships?.catalog?.data.first?.id,
                      seen.insert(catalogID).inserted else { continue }
                ids.append(MusicItemID(catalogID))
            }

            if page.next == nil || page.data.isEmpty { break }
            offset += page.data.count
        }
        return ids
    }

    // MARK: - Dernières sorties

    /// Récupère la dernière sortie de chaque artiste (par paquets de 25).
    static func latestReleases(for artistIDs: [MusicItemID]) async throws -> [Release] {
        var releases: [Release] = []

        for chunk in artistIDs.chunked(into: 25) {
            var request = MusicCatalogResourceRequest<Artist>(matching: \.id, memberOf: chunk)
            request.properties = [.latestRelease]
            let response = try await request.response()

            for artist in response.items {
                guard let album = artist.latestRelease,
                      let date = album.releaseDate else { continue }
                releases.append(Release(
                    id: album.id.rawValue,
                    title: album.title,
                    artistName: album.artistName,
                    releaseDate: date,
                    url: album.url,
                    artworkURL: album.artwork?.url(width: 600, height: 600),
                    isSingle: album.isSingle ?? false
                ))
            }
        }
        return releases
    }
}

// MARK: - Décodage de /v1/me/library/artists

private struct LibraryArtistsPage: Decodable {
    let data: [Item]
    let next: String?

    struct Item: Decodable {
        let id: String
        let relationships: Relationships?
    }
    struct Relationships: Decodable {
        let catalog: Catalog?
    }
    struct Catalog: Decodable {
        let data: [Ref]
    }
    struct Ref: Decodable {
        let id: String
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0 ..< Swift.min($0 + size, count)]) }
    }
}
