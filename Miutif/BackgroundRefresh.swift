import BackgroundTasks
import Foundation

/// Vérification en arrière-plan, demandée pour la fenêtre qui précède 11 h
/// afin que les notifications soient prêtes au moment de sonner.
/// Le traitement lui-même est branché dans MiutifApp via `.backgroundTask(.appRefresh)`.
enum BackgroundRefresh {
    static let identifier = "app.miutif.refresh"

    /// Demande à iOS de nous réveiller à partir de ~9 h (iOS choisit le moment exact).
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        let target = Date.nextNotificationTime().addingTimeInterval(-2 * 3600)
        request.earliestBeginDate = max(target, Date().addingTimeInterval(15 * 60))
        try? BGTaskScheduler.shared.submit(request)
    }
}
