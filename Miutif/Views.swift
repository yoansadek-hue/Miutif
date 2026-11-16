import MusicKit
import SwiftUI

// MARK: - Thème

enum Theme {
    static let pink = Color(red: 1.0, green: 0.25, blue: 0.43)
    static let violet = Color(red: 0.59, green: 0.20, blue: 0.92)
    static let indigo = Color(red: 0.16, green: 0.08, blue: 0.47)
    static let gold = Color(red: 1.0, green: 0.80, blue: 0.0)

    static let background = LinearGradient(
        colors: [Color(red: 0.10, green: 0.04, blue: 0.20), .black],
        startPoint: .top, endPoint: .bottom)
    static let brand = LinearGradient(colors: [pink, violet, indigo],
                                      startPoint: .topLeading, endPoint: .bottomTrailing)
}

// MARK: - Racine

struct RootView: View {
    @EnvironmentObject private var store: ReleaseStore

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            if store.authorization == .authorized {
                ReleasesView()
            } else {
                OnboardingView()
            }
        }
    }
}

// MARK: - Connexion

struct OnboardingView: View {
    @EnvironmentObject private var store: ReleaseStore

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            Image("Logo")
                .resizable()
                .frame(width: 120, height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                .shadow(color: Theme.violet.opacity(0.6), radius: 30, y: 10)

            VStack(spacing: 10) {
                Text("Miutif")
                    .font(.system(size: 44, weight: .heavy, design: .rounded))
                Text("Chaque jour à 11 h, découvre les nouvelles sorties des artistes de ta librairie Apple Music.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            VStack(alignment: .leading, spacing: 14) {
                Feature(icon: "music.note.list", text: "Tes artistes, lus depuis ta librairie")
                Feature(icon: "bell.badge.fill", text: "Une notification à 11 h pour chaque sortie")
                Feature(icon: "arrow.up.forward.app.fill", text: "Un appui et c'est ouvert dans Apple Music")
            }
            .padding(.horizontal, 40)

            Spacer()

            if store.authorization == .denied || store.authorization == .restricted {
                Text("L'accès à Apple Music a été refusé. Active-le dans Réglages › Miutif.")
                    .font(.footnote)
                    .foregroundStyle(Theme.pink)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button("Ouvrir les Réglages") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .buttonStyle(BrandButtonStyle())
            } else {
                Button {
                    Task { await store.connect() }
                } label: {
                    Label("Se connecter à Apple Music", systemImage: "applelogo")
                }
                .buttonStyle(BrandButtonStyle())
            }
        }
        .padding(.bottom, 24)
    }
}

private struct Feature: View {
    let icon: String
    let text: String
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Theme.gold)
                .frame(width: 30)
            Text(text).font(.callout)
        }
    }
}

struct BrandButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(Theme.brand, in: Capsule())
            .padding(.horizontal, 32)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

// MARK: - Liste des sorties

struct ReleasesView: View {
    @EnvironmentObject private var store: ReleaseStore

    var body: some View {
        NavigationStack {
            List {
                Section {
                    StatusCard()
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }

                if let error = store.errorMessage {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(Theme.pink)
                    }
                }

                Section("Sorties récentes") {
                    if store.releases.isEmpty {
                        Text(store.isRefreshing
                             ? "Recherche des sorties de tes artistes…"
                             : "Aucune sortie ces 30 derniers jours. Tu seras prévenu à 11 h dès qu'il y en a une !")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 8)
                    }
                    ForEach(store.releases) { release in
                        Button {
                            if let url = release.url { AppleMusicLink.open(url) }
                        } label: {
                            ReleaseRow(release: release)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Miutif")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            Task { await store.refresh(forceArtistReload: true) }
                        } label: {
                            Label("Relire ma librairie", systemImage: "arrow.clockwise")
                        }
                        Button {
                            Task {
                                await NotificationScheduler.requestPermission()
                                await NotificationScheduler.sendTest(with: store.releases.first)
                            }
                        } label: {
                            Label("Notification de test (5 s)", systemImage: "bell.badge")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .refreshable { await store.refresh(forceArtistReload: true) }
        }
    }
}

private struct StatusCard: View {
    @EnvironmentObject private var store: ReleaseStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "bell.badge.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Theme.gold, .white)
                    .font(.title2)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Prochaine notification")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.8))
                    Text(Date.nextNotificationTime(), format: .dateTime.weekday(.wide).hour().minute())
                        .font(.headline)
                }
                Spacer()
                if store.isRefreshing { ProgressView().tint(.white) }
            }
            HStack(spacing: 24) {
                Stat(value: "\(store.artistCount)", label: "artistes suivis")
                Stat(value: "\(store.releases.filter { Date().timeIntervalSince($0.releaseDate) < 7 * 86400 }.count)",
                     label: "sorties cette semaine")
            }
            if let last = store.lastCheck {
                Text("Dernière vérification \(last.formatted(.relative(presentation: .named)))")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
        .foregroundStyle(.white)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.brand, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.vertical, 8)
    }
}

private struct Stat: View {
    let value: String
    let label: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(.system(.title, design: .rounded, weight: .bold))
            Text(label).font(.caption).foregroundStyle(.white.opacity(0.8))
        }
    }
}

struct ReleaseRow: View {
    let release: Release

    var body: some View {
        HStack(spacing: 14) {
            AsyncImage(url: release.artworkURL) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                ZStack {
                    Theme.brand
                    Image(systemName: "music.note").foregroundStyle(.white)
                }
            }
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if release.isFresh {
                        Text("NOUVEAU")
                            .font(.system(size: 10, weight: .heavy))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.gold, in: Capsule())
                            .foregroundStyle(.black)
                    }
                    Text(release.kindLabel.uppercased())
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                Text(release.title).font(.headline).lineLimit(1)
                Text(release.artistName).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Text(release.releaseDate, format: .dateTime.day().month(.wide).year())
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.forward.app")
                .foregroundStyle(Theme.pink)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
