# Miutif

Web app (comme Quizly) : tu suis tes artistes et chaque jour **à 11 h** tu reçois une notification pour chacune de leurs nouvelles sorties. Toucher la notif ouvre directement le titre dans l'app Musique.

Sur iPhone : ouvre le lien dans Safari › **Partager** › **Sur l'écran d'accueil**, puis ouvre Miutif depuis son icône et touche **Activer les notifications** (iOS 16.4 minimum).

## Mettre en ligne (gratuit, Cloudflare)

Une seule fois, depuis ce dossier :

```
npm install
npx wrangler login     # ouvre le navigateur pour te connecter à Cloudflare (compte gratuit)
npm run deploy
```

L'adresse de l'app s'affiche à la fin (`https://miutif.<ton-nom>.workers.dev`) : c'est le lien à partager.
La base de données et les clés de notification sont créées automatiquement au premier déploiement.

Pour mettre à jour après une modification : `npm run deploy`.

## Fonctionnement

- **Artistes** : recherche dans le catalogue Apple Music (API publique iTunes, gratuite et sans clé).
- **Sorties** : pour chaque artiste, ses sorties récentes (albums, EP, singles).
- **11 h** : Cloudflare réveille le serveur toutes les heures ; chaque téléphone est notifié quand il est 11 h chez lui. Une sortie de moins de 7 jours n'est notifiée qu'une fois. Au-delà de 6 sorties le même jour, une notif résumé.
- **Appui sur la notif** : Miutif s'ouvre et bascule aussitôt dans l'app Musique (`music://`).

## Option : importer toute sa librairie Apple Music

Lire la librairie d'un compte Apple Music demande un compte Apple Developer payant (99 €/an). Si tu en as un :

1. developer.apple.com › Certificates, Identifiers & Profiles › **Keys** › nouvelle clé avec **Media Services (MusicKit)** › télécharge le fichier `.p8`.
2. Puis :
   ```
   npx wrangler secret put MUSICKIT_TEAM_ID       # ton Team ID (10 caractères)
   npx wrangler secret put MUSICKIT_KEY_ID        # l'ID de la clé
   npx wrangler secret put MUSICKIT_PRIVATE_KEY   # colle tout le contenu du .p8
   ```

Le bouton **Importer ma librairie Apple Music** apparaît alors dans l'app. Sans ça, on ajoute ses artistes avec la recherche.

## Développement

- `npm run dev` : lance l'app en local sur http://localhost:8787
- `npm test` : tests (chiffrement des notifs, envoi de 11 h, fuseaux horaires, doublons…)

| Fichier | Rôle |
|---|---|
| `src/worker.js` | Serveur : API, base de données, envoi de 11 h |
| `src/push.js` | Envoi des notifications web push (chiffrement + clés VAPID) |
| `src/music.js` | Catalogue Apple Music (recherche, sorties récentes) |
| `public/` | L'app : `index.html`, `app.js`, `style.css`, `sw.js` (notifs), icônes |
