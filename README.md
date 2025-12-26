# Torbox Status - Addon Stremio

Addon Stremio pour afficher tes contenus Torbox avec les vrais posters et lancer les streams directement.

## Fonctionnalités

- **Torbox Status** : Stats de ton compte (plan, jours restants, cloud utilisé)
- **Torbox Films** : Tes films récents avec vrais posters (via Cinemeta)
- **Torbox Séries** : Tes séries récentes avec vrais posters
- **Streams directs** : Lance tes fichiers Torbox depuis n'importe quelle fiche film/série
- **Multi-qualités** : Si tu as le même film en 4K et 1080p, les deux apparaissent
- **Progression** : Stremio sauvegarde où tu t'es arrêté
- **Sous-titres** : Compatible avec les addons de sous-titres (via IMDB ID)

## Installation

### Variables d'environnement

```env
# Obligatoire
TORBOX_API_KEY=your_api_key_here

# Optionnel
PORT=7003
ENABLE_CATALOG=true
```

- `TORBOX_API_KEY` : Récupère-la sur https://torbox.app/settings
- `ENABLE_CATALOG` :
  - `true` (défaut) : Affiche les catalogues Torbox Status/Films/Séries
  - `false` : Streams uniquement (les liens Torbox apparaissent sur les fiches sans catalogues)

### Lancer en local

```bash
npm install
npm start
```

Puis installe dans Stremio : `http://localhost:7003/manifest.json`

### Déployer sur Render

1. Fork ce repo
2. Crée un nouveau Web Service sur Render
3. Configure les variables d'environnement
4. Installe dans Stremio avec l'URL Render

## Utilisation

### Avec catalogues (ENABLE_CATALOG=true)

1. Ouvre Stremio
2. Va dans les catalogues "Torbox Films" ou "Torbox Séries"
3. Clique sur un film/série
4. Le stream `⚡ TORBOX CLOUD` apparaît dans la liste

### Sans catalogues (ENABLE_CATALOG=false)

1. Ouvre n'importe quel film/série dans Stremio
2. Si tu as ce contenu dans ton Torbox, le stream `⚡ TORBOX CLOUD` apparaît automatiquement

## Changelog

- **v2.2.0** : Variable ENABLE_CATALOG pour désactiver les catalogues
- **v2.1.0** : Support multi-qualités (tous les torrents d'un même film)
- **v2.0.3** : Support des épisodes de séries
- **v2.0.2** : Streams plus visibles "⚡ TORBOX CLOUD"
- **v2.0.1** : Support IMDB IDs pour progression et sous-titres
- **v2.0.0** : Vrais posters via Cinemeta, catalogues Films/Séries
- **v1.x** : Version initiale avec stats et historique basique
