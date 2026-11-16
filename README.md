# Miutif

App iPhone qui lit les artistes de ta librairie Apple Music et t'envoie chaque jour **à 11 h** une notification pour chacune de leurs nouvelles sorties. Toucher la notification (ou une sortie dans l'app) ouvre directement le titre dans Apple Music.

## Fonctionnement

1. **Connexion** : l'app demande l'accès à Apple Music (MusicKit) et la permission d'envoyer des notifications.
2. **Artistes** : elle lit tous les artistes de ta librairie (`/v1/me/library/artists?include=catalog`) et garde leur identifiant catalogue (relu toutes les 12 h au maximum).
3. **Sorties** : pour chaque artiste, elle récupère sa dernière sortie (`latestRelease`, par paquets de 25).
4. **Notifications** : chaque sortie de moins de 7 jours jamais notifiée est programmée pour le **prochain 11 h 00**, avec la pochette en image. Une sortie n'est notifiée qu'une seule fois.
5. **Vérification quotidienne** : à chaque ouverture de l'app, et en arrière-plan (iOS réveille l'app à partir de ~9 h) pour que les notifs soient prêtes à 11 h.
6. **Appui** : le lien `music.apple.com` stocké dans la notification est ouvert, et iOS bascule dans l'app Musique.

## Installation (il faut un Mac)

1. Ouvre `Miutif.xcodeproj` avec Xcode 16 ou plus récent.
2. Cible **Miutif** › **Signing & Capabilities** : choisis ton équipe (Team). Change le Bundle Identifier si `app.miutif.ios` est déjà pris (ex. `com.tonnom.miutif`).
3. **Active MusicKit pour l'app** (obligatoire, sinon la connexion échoue) :
   - [developer.apple.com](https://developer.apple.com/account/resources/identifiers/list) › Identifiers › ton Bundle ID ›
     onglet **App Services** › coche **MusicKit** › Save.
   - Il faut un compte Apple Developer **payant** (99 €/an) pour MusicKit.
4. Branche ton iPhone et lance l'app (MusicKit ne fonctionne pas bien dans le simulateur).
5. Dans l'app : menu `…` › **Notification de test (5 s)** pour vérifier que l'appui ouvre bien Apple Music.

## Limite à connaître

iOS décide lui-même quand lancer les tâches d'arrière-plan. Si tu n'ouvres jamais l'app et que le mode économie d'énergie est activé, il peut arriver qu'iOS ne la réveille pas avant 11 h : les sorties détectées seront alors notifiées le lendemain à 11 h (ou dès que tu ouvres l'app, pour le 11 h suivant). Pour une garantie à 100 %, il faudrait un petit serveur qui envoie de vraies notifications push.

## Fichiers

| Fichier | Rôle |
|---|---|
| `Miutif/MiutifApp.swift` | Point d'entrée, tâche de fond, appui sur la notif → Apple Music |
| `Miutif/ReleaseStore.swift` | État de l'app, détection des nouvelles sorties, mémorisation |
| `Miutif/MusicService.swift` | Appels Apple Music (librairie + catalogue) |
| `Miutif/NotificationScheduler.swift` | Notifications de 11 h avec pochette |
| `Miutif/BackgroundRefresh.swift` | Demande de réveil avant 11 h |
| `Miutif/Views.swift` | Écrans (connexion, liste des sorties) |
| `Miutif/Assets.xcassets` | Icône de l'app et couleurs |
