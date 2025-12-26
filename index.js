/**
 * Addon Stremio - Torbox Status
 *
 * Affiche les stats de ton compte Torbox directement dans Stremio
 *
 * @module index
 */

require('dotenv').config();

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const fetch = require('node-fetch');
const ptt = require('parse-torrent-title');

const PORT = parseInt(process.env.PORT, 10) || 7003;
const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const TORBOX_API_URL = 'https://api.torbox.app/v1/api';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io';

/** Cache des torrents pour le stream handler */
const torrentsCache = new Map();

/** Cache des métadonnées Cinemeta (IMDB ID → meta) */
const cinemetaCache = new Map();

/** Cache de recherche (titre → IMDB ID) */
const searchCache = new Map();

/**
 * Récupère les infos du compte Torbox
 * @returns {Promise<Object>}
 */
async function getTorboxUserInfo() {
    if (!TORBOX_API_KEY) {
        throw new Error('TORBOX_API_KEY non configurée');
    }

    const response = await fetch(`${TORBOX_API_URL}/user/me`, {
        headers: {
            'Authorization': `Bearer ${TORBOX_API_KEY}`
        }
    });

    if (!response.ok) {
        throw new Error(`Erreur API Torbox: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
}

/**
 * Récupère la liste des torrents Torbox
 * @returns {Promise<Array>}
 */
async function getTorboxTorrents() {
    if (!TORBOX_API_KEY) {
        throw new Error('TORBOX_API_KEY non configurée');
    }

    const response = await fetch(`${TORBOX_API_URL}/torrents/mylist?bypass_cache=true`, {
        headers: {
            'Authorization': `Bearer ${TORBOX_API_KEY}`
        }
    });

    if (!response.ok) {
        throw new Error(`Erreur API Torbox: ${response.status}`);
    }

    const data = await response.json();
    const torrents = data.data || [];

    // Met en cache pour le stream handler
    torrents.forEach(t => torrentsCache.set(String(t.id), t));

    return torrents;
}

/**
 * Parse le nom d'un torrent pour extraire les infos
 * @param {string} name - Nom du torrent
 * @returns {Object} { title, year, season, episode, type }
 */
function parseTorrentName(name) {
    const parsed = ptt.parse(name);

    // Détermine le type
    const type = (parsed.season || parsed.episode) ? 'series' : 'movie';

    return {
        title: parsed.title || name,
        year: parsed.year || null,
        season: parsed.season || null,
        episode: parsed.episode || null,
        quality: parsed.resolution || parsed.quality || null,
        type
    };
}

/**
 * Recherche un contenu sur Cinemeta par titre
 * @param {string} title - Titre à rechercher
 * @param {string} type - Type (movie ou series)
 * @param {number} [year] - Année (optionnel)
 * @returns {Promise<Object|null>} Métadonnées ou null
 */
async function searchCinemeta(title, type, year = null) {
    const cacheKey = `${type}:${title}:${year || ''}`;

    if (searchCache.has(cacheKey)) {
        return searchCache.get(cacheKey);
    }

    try {
        // Nettoie le titre pour la recherche
        const cleanTitle = title
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const searchUrl = `${CINEMETA_URL}/catalog/${type}/top/search=${encodeURIComponent(cleanTitle)}.json`;
        console.log(`[Cinemeta] Recherche: ${cleanTitle} (${type})`);

        const response = await fetch(searchUrl, { timeout: 5000 });

        if (!response.ok) {
            console.log(`[Cinemeta] Erreur HTTP: ${response.status}`);
            return null;
        }

        const data = await response.json();

        if (!data.metas || data.metas.length === 0) {
            console.log(`[Cinemeta] Aucun résultat pour "${cleanTitle}"`);
            searchCache.set(cacheKey, null);
            return null;
        }

        // Trouve le meilleur match (par année si disponible)
        let bestMatch = data.metas[0];

        if (year) {
            const yearMatch = data.metas.find(m => {
                const metaYear = m.year || (m.releaseInfo && parseInt(m.releaseInfo));
                return metaYear === year;
            });
            if (yearMatch) bestMatch = yearMatch;
        }

        console.log(`[Cinemeta] Trouvé: ${bestMatch.name} (${bestMatch.id})`);

        // Met en cache
        searchCache.set(cacheKey, bestMatch);
        cinemetaCache.set(bestMatch.id, bestMatch);

        return bestMatch;

    } catch (error) {
        console.error(`[Cinemeta] Erreur recherche:`, error.message);
        return null;
    }
}

/**
 * Récupère les métadonnées complètes depuis Cinemeta
 * @param {string} type - Type (movie ou series)
 * @param {string} imdbId - IMDB ID
 * @returns {Promise<Object|null>}
 */
async function getCinemetaMeta(type, imdbId) {
    if (cinemetaCache.has(imdbId)) {
        return cinemetaCache.get(imdbId);
    }

    try {
        const url = `${CINEMETA_URL}/meta/${type}/${imdbId}.json`;
        const response = await fetch(url, { timeout: 5000 });

        if (!response.ok) return null;

        const data = await response.json();
        if (data.meta) {
            cinemetaCache.set(imdbId, data.meta);
            return data.meta;
        }

        return null;
    } catch (error) {
        console.error(`[Cinemeta] Erreur meta:`, error.message);
        return null;
    }
}

/**
 * Récupère le lien de streaming pour un torrent
 * @param {number} torrentId - ID du torrent
 * @param {number} [fileId] - ID du fichier (optionnel)
 * @returns {Promise<string>}
 */
async function getTorboxStreamLink(torrentId, fileId = null) {
    if (!TORBOX_API_KEY) {
        throw new Error('TORBOX_API_KEY non configurée');
    }

    let url = `${TORBOX_API_URL}/torrents/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrentId}`;
    if (fileId) {
        url += `&file_id=${fileId}`;
    }

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${TORBOX_API_KEY}`
        }
    });

    if (!response.ok) {
        throw new Error(`Erreur API Torbox: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
}

/**
 * Formate les bytes en taille lisible
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Parse une date (timestamp Unix, ISO string, ou Date)
 * @param {number|string} dateValue
 * @returns {Date|null}
 */
function parseDate(dateValue) {
    if (!dateValue) return null;

    // Si c'est déjà un timestamp en millisecondes (> 1e12)
    if (typeof dateValue === 'number' && dateValue > 1e12) {
        return new Date(dateValue);
    }
    // Si c'est un timestamp en secondes
    if (typeof dateValue === 'number') {
        return new Date(dateValue * 1000);
    }
    // Si c'est une string ISO
    if (typeof dateValue === 'string') {
        return new Date(dateValue);
    }
    return null;
}

/**
 * Formate une date en date lisible
 * @param {number|string} dateValue
 * @returns {string}
 */
function formatDate(dateValue) {
    const date = parseDate(dateValue);
    if (!date || isNaN(date.getTime())) return 'N/A';

    return date.toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

/**
 * Calcule les jours restants
 * @param {number|string} dateValue
 * @returns {number}
 */
function daysRemaining(dateValue) {
    const date = parseDate(dateValue);
    if (!date || isNaN(date.getTime())) return 0;

    const now = Date.now();
    const expiry = date.getTime();
    const diff = expiry - now;
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

/**
 * Génère une URL de poster avec du texte
 * @param {string} emoji
 * @param {string} value
 * @param {string} bgColor
 * @returns {string}
 */
function generatePoster(emoji, value, bgColor = '1a1a2e') {
    // Utilise placeholder.com pour générer une image simple
    const text = encodeURIComponent(`${emoji}\n${value}`);
    return `https://placehold.co/300x450/${bgColor}/ffffff?text=${text}&font=roboto`;
}

/**
 * Convertit l'ID du plan Torbox en nom lisible
 * @param {number|string} planId
 * @returns {string}
 */
function getPlanName(planId) {
    const plans = {
        0: 'Free',
        1: 'Essential',
        2: 'Standard',
        3: 'Pro'
    };
    return plans[planId] || `Plan ${planId}`;
}

/**
 * Extrait les infos de qualité depuis un nom de release
 * @param {string} name
 * @returns {string}
 */
function extractQuality(name) {
    const qualities = ['2160p', '4K', 'UHD', '1080p', '720p', '480p', 'HDR', 'DV', 'REMUX'];
    for (const q of qualities) {
        if (name.toUpperCase().includes(q.toUpperCase())) {
            return q;
        }
    }
    return '';
}

/**
 * Formate la date relative (il y a X jours)
 * @param {string|number} dateValue
 * @returns {string}
 */
function formatRelativeDate(dateValue) {
    const date = parseDate(dateValue);
    if (!date || isNaN(date.getTime())) return '';

    const now = Date.now();
    const diff = now - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor(diff / (1000 * 60 * 60));

    if (hours < 1) return 'À l\'instant';
    if (hours < 24) return `Il y a ${hours}h`;
    if (days === 1) return 'Hier';
    if (days < 7) return `Il y a ${days} jours`;
    if (days < 30) return `Il y a ${Math.floor(days / 7)} sem.`;
    return formatDate(dateValue);
}

/**
 * Handler pour le catalogue Films ou Séries
 * @param {string} catalogType - 'movie' ou 'series'
 * @returns {Promise<Object>}
 */
async function handleMediaCatalog(catalogType) {
    console.log(`[TorboxMedia] Récupération des ${catalogType === 'movie' ? 'films' : 'séries'}...`);

    try {
        const torrents = await getTorboxTorrents();

        // Trie par date de mise à jour (plus récent en premier)
        const sorted = torrents.sort((a, b) => {
            const dateA = parseDate(a.updated_at) || parseDate(a.created_at) || new Date(0);
            const dateB = parseDate(b.updated_at) || parseDate(b.created_at) || new Date(0);
            return dateB.getTime() - dateA.getTime();
        });

        console.log(`[TorboxMedia] ═══════════════════════════════════════`);
        console.log(`[TorboxMedia] ${torrents.length} torrents trouvés`);

        const metas = [];
        const seenImdb = new Set(); // Évite les doublons

        for (const torrent of sorted) {
            if (metas.length >= 20) break; // Limite à 20

            const name = torrent.name || 'Sans nom';
            const parsed = parseTorrentName(name);

            // Filtre par type
            if (parsed.type !== catalogType) continue;

            console.log(`[TorboxMedia] Parsing: ${parsed.title} (${parsed.year || '?'}) - ${parsed.type}`);

            // Recherche sur Cinemeta
            const cinemetaResult = await searchCinemeta(parsed.title, parsed.type, parsed.year);

            if (cinemetaResult && !seenImdb.has(cinemetaResult.id)) {
                seenImdb.add(cinemetaResult.id);

                // Stocke le mapping torrent → IMDB pour le stream handler
                if (!torrent._imdbId) {
                    torrent._imdbId = cinemetaResult.id;
                    torrent._parsed = parsed;
                    torrentsCache.set(String(torrent.id), torrent);
                }

                const quality = parsed.quality || extractQuality(name);

                metas.push({
                    id: cinemetaResult.id, // IMDB ID pour que Stremio le reconnaisse
                    type: catalogType,
                    name: cinemetaResult.name,
                    poster: cinemetaResult.poster,
                    background: cinemetaResult.background,
                    description: cinemetaResult.description,
                    releaseInfo: cinemetaResult.releaseInfo || (parsed.year ? String(parsed.year) : ''),
                    imdbRating: cinemetaResult.imdbRating,
                    // Métadonnées custom pour notre addon
                    _torboxId: torrent.id,
                    _quality: quality,
                    _torrentName: name
                });

                console.log(`[TorboxMedia] ✓ ${cinemetaResult.name} (${cinemetaResult.id})`);
            } else if (!cinemetaResult) {
                // Pas trouvé sur Cinemeta, affiche quand même avec un poster générique
                const quality = parsed.quality || extractQuality(name);
                const fallbackId = `tb:${torrent.id}`;

                if (!seenImdb.has(fallbackId)) {
                    seenImdb.add(fallbackId);

                    metas.push({
                        id: fallbackId,
                        type: catalogType,
                        name: parsed.title,
                        poster: generatePoster('🎬', quality || '?', '2d4a3e'),
                        description: `Release: ${name}`,
                        releaseInfo: parsed.year ? String(parsed.year) : quality,
                        _torboxId: torrent.id,
                        _quality: quality,
                        _torrentName: name
                    });

                    console.log(`[TorboxMedia] ○ ${parsed.title} (fallback)`);
                }
            }
        }

        console.log(`[TorboxMedia] ═══════════════════════════════════════`);
        console.log(`[TorboxMedia] ${metas.length} ${catalogType === 'movie' ? 'films' : 'séries'} trouvé(e)s`);

        return { metas };

    } catch (error) {
        console.error('[TorboxMedia] Erreur:', error.message);
        return { metas: [] };
    }
}

// Manifest de l'addon
const manifest = {
    id: 'community.torbox.status',
    version: '2.0.0',
    name: 'Torbox Status',
    description: 'Stats Torbox + Films & Séries récents avec vrais posters',
    logo: 'https://torbox.app/favicon.ico',
    catalogs: [
        {
            type: 'other',
            id: 'torbox-status',
            name: 'Torbox Status'
        },
        {
            type: 'movie',
            id: 'torbox-movies',
            name: 'Torbox Films'
        },
        {
            type: 'series',
            id: 'torbox-series',
            name: 'Torbox Séries'
        }
    ],
    resources: ['catalog', 'meta', 'stream'],
    types: ['other', 'movie', 'series'],
    idPrefixes: ['tbstatus:', 'tb:']
};

const builder = new addonBuilder(manifest);

/**
 * Handler du catalogue - Stats, Films ou Séries
 */
builder.defineCatalogHandler(async ({ type, id }) => {
    // Catalogue Films
    if (type === 'movie' && id === 'torbox-movies') {
        return handleMediaCatalog('movie');
    }

    // Catalogue Séries
    if (type === 'series' && id === 'torbox-series') {
        return handleMediaCatalog('series');
    }

    // Catalogue Status (type other)
    if (type !== 'other' || id !== 'torbox-status') {
        return { metas: [] };
    }

    console.log('[TorboxStatus] Récupération des stats...');

    try {
        const user = await getTorboxUserInfo();

        // Debug: affiche les données brutes
        console.log('[TorboxStatus] ═══════════════════════════════════════');
        console.log('[TorboxStatus] Utilisateur:', user.email);
        console.log('[TorboxStatus] Plan:', getPlanName(user.plan));
        console.log('[TorboxStatus] Premium expires:', user.premium_expires_at, '→', formatDate(user.premium_expires_at));
        console.log('[TorboxStatus] Jours restants:', daysRemaining(user.premium_expires_at));
        console.log('[TorboxStatus] Cloud:', formatBytes(user.total_bytes_downloaded || 0));
        console.log('[TorboxStatus] Torrents actifs:', user.active_torrents || 0);
        console.log('[TorboxStatus] Usenet actifs:', user.active_usenet_downloads || 0);
        console.log('[TorboxStatus] Web DL actifs:', user.active_web_downloads || 0);
        console.log('[TorboxStatus] ═══════════════════════════════════════');

        const metas = [];

        // 1. Plan & Expiration
        const days = daysRemaining(user.premium_expires_at);
        const planStatus = user.is_subscribed ? '🟢 Actif' : '🔴 Inactif';
        const daysText = days > 0 ? `${days}j restants` : (user.premium_expires_at ? 'Expiré' : 'Illimité');
        const daysDisplay = days > 0 ? `${days} jours` : (user.premium_expires_at ? 'Expiré' : '∞');
        metas.push({
            id: 'tbstatus:plan',
            type: 'other',
            name: `${getPlanName(user.plan)} - ${daysText}`,
            poster: generatePoster('📅', daysDisplay, '16213e'),
            description: `Plan: ${getPlanName(user.plan)}\nStatut: ${planStatus}\nExpire le: ${formatDate(user.premium_expires_at)}`,
            releaseInfo: planStatus
        });

        // 2. Espace Cloud
        const usedSpace = formatBytes(user.total_bytes_downloaded || 0);
        metas.push({
            id: 'tbstatus:cloud',
            type: 'other',
            name: `Cloud: ${usedSpace}`,
            poster: generatePoster('💾', usedSpace, '1e3a5f'),
            description: `Espace utilisé: ${usedSpace}\nTotal téléchargé: ${formatBytes(user.total_bytes_downloaded || 0)}`,
            releaseInfo: usedSpace
        });

        // 3. Torrents actifs
        const activeTorrents = user.active_torrents || 0;
        metas.push({
            id: 'tbstatus:torrents',
            type: 'other',
            name: `Torrents: ${activeTorrents} actifs`,
            poster: generatePoster('🌊', `${activeTorrents}`, '3d1e5f'),
            description: `Torrents actifs: ${activeTorrents}`,
            releaseInfo: `${activeTorrents} actifs`
        });

        // 4. Downloads Usenet
        const activeUsenet = user.active_usenet_downloads || 0;
        metas.push({
            id: 'tbstatus:usenet',
            type: 'other',
            name: `Usenet: ${activeUsenet} actifs`,
            poster: generatePoster('📰', `${activeUsenet}`, '5f1e3d'),
            description: `Downloads Usenet actifs: ${activeUsenet}`,
            releaseInfo: `${activeUsenet} actifs`
        });

        // 5. Web Downloads
        const activeWeb = user.active_web_downloads || 0;
        metas.push({
            id: 'tbstatus:web',
            type: 'other',
            name: `Web DL: ${activeWeb} actifs`,
            poster: generatePoster('🌐', `${activeWeb}`, '1e5f3d'),
            description: `Downloads Web actifs: ${activeWeb}`,
            releaseInfo: `${activeWeb} actifs`
        });

        // 6. Compte
        metas.push({
            id: 'tbstatus:account',
            type: 'other',
            name: `Compte: ${user.email}`,
            poster: generatePoster('👤', 'Compte', '4a4a4a'),
            description: `Email: ${user.email}\nCréé le: ${formatDate(user.created_at)}\nServeur: ${user.server || 'Auto'}`,
            releaseInfo: user.email
        });

        console.log(`[TorboxStatus] ${metas.length} stats générées`);
        return { metas };

    } catch (error) {
        console.error('[TorboxStatus] Erreur:', error.message);

        // Affiche une erreur dans le catalogue
        return {
            metas: [{
                id: 'tbstatus:error',
                type: 'other',
                name: 'Erreur de connexion',
                poster: generatePoster('❌', 'Erreur', 'ff0000'),
                description: `Impossible de récupérer les stats Torbox.\n\nErreur: ${error.message}\n\nVérifie ta clé API.`
            }]
        };
    }
});

/**
 * Handler meta - Détails d'une stat ou d'un torrent fallback
 */
builder.defineMetaHandler(async ({ type, id }) => {
    // Meta pour les fallback tb: (films/séries non trouvés sur Cinemeta)
    if (id.startsWith('tb:')) {
        const torrentId = id.replace('tb:', '');
        console.log(`[TorboxMeta] Demande meta fallback pour torrent ${torrentId}`);

        try {
            let torrent = torrentsCache.get(torrentId);
            if (!torrent) {
                console.log('[TorboxMeta] Torrent pas en cache, rechargement...');
                await getTorboxTorrents();
                torrent = torrentsCache.get(torrentId);
            }

            if (!torrent) {
                console.log('[TorboxMeta] Torrent introuvable');
                return { meta: null };
            }

            const parsed = parseTorrentName(torrent.name);
            const quality = parsed.quality || extractQuality(torrent.name);
            const size = formatBytes(torrent.size || 0);

            return {
                meta: {
                    id,
                    type: type,
                    name: parsed.title,
                    poster: generatePoster('🎬', quality || size, '2d4a3e'),
                    background: generatePoster('🎬', quality || '', '1a1a2e'),
                    description: `Release: ${torrent.name}\n\nTaille: ${size}`,
                    releaseInfo: parsed.year ? String(parsed.year) : quality
                }
            };
        } catch (error) {
            console.error('[TorboxMeta] Erreur:', error.message);
            return { meta: null };
        }
    }

    // Les IDs IMDB (tt...) sont gérés automatiquement par Stremio via Cinemeta
    // On ne fait rien ici

    // Meta pour les stats (tbstatus:) - type other uniquement
    if (type !== 'other' || !id.startsWith('tbstatus:')) {
        return { meta: null };
    }

    try {
        const user = await getTorboxUserInfo();
        const statType = id.replace('tbstatus:', '');

        let meta = {
            id,
            type: 'other',
            name: 'Torbox Status',
            description: 'Stats de ton compte'
        };

        switch (statType) {
            case 'plan':
                const days = daysRemaining(user.premium_expires_at);
                meta.name = `${getPlanName(user.plan)} - ${days} jours restants`;
                meta.description = `Plan: ${getPlanName(user.plan)}\nExpire le: ${formatDate(user.premium_expires_at)}\n\nJours restants: ${days}`;
                meta.poster = generatePoster('📅', `${days}j`, '16213e');
                break;
            case 'cloud':
                meta.name = `Cloud: ${formatBytes(user.total_bytes_downloaded || 0)}`;
                meta.description = `Total téléchargé depuis la création du compte: ${formatBytes(user.total_bytes_downloaded || 0)}`;
                meta.poster = generatePoster('💾', formatBytes(user.total_bytes_downloaded || 0), '1e3a5f');
                break;
            case 'account':
                meta.name = user.email;
                meta.description = `Email: ${user.email}\nCréé le: ${formatDate(user.created_at)}`;
                meta.poster = generatePoster('👤', 'Compte', '4a4a4a');
                break;
            default:
                meta.name = 'Stat inconnue';
        }

        return { meta };
    } catch (error) {
        return { meta: null };
    }
});

/**
 * Génère les streams pour un torrent donné
 * @param {Object} torrent - Objet torrent
 * @returns {Promise<Array>}
 */
async function generateStreamsForTorrent(torrent) {
    const streams = [];

    // Si le torrent a des fichiers listés, on crée un stream par fichier vidéo
    if (torrent.files && torrent.files.length > 0) {
        const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.webm'];

        for (const file of torrent.files) {
            const isVideo = videoExtensions.some(ext =>
                file.name.toLowerCase().endsWith(ext)
            );

            if (isVideo) {
                try {
                    const streamUrl = await getTorboxStreamLink(torrent.id, file.id);
                    const quality = extractQuality(file.name);

                    streams.push({
                        name: `⚡ Torbox`,
                        title: `${quality ? quality + ' • ' : ''}${file.name}`,
                        url: streamUrl
                    });

                    console.log(`[TorboxStream] Stream ajouté: ${file.name}`);
                } catch (err) {
                    console.error(`[TorboxStream] Erreur fichier ${file.id}:`, err.message);
                }
            }
        }
    } else {
        // Pas de fichiers listés, on essaie avec le torrent entier
        try {
            const streamUrl = await getTorboxStreamLink(torrent.id);
            const quality = extractQuality(torrent.name);

            streams.push({
                name: `⚡ Torbox`,
                title: `${quality ? quality + ' • ' : ''}${torrent.name}`,
                url: streamUrl
            });

            console.log(`[TorboxStream] Stream ajouté: ${torrent.name}`);
        } catch (err) {
            console.error(`[TorboxStream] Erreur torrent:`, err.message);
        }
    }

    return streams;
}

/**
 * Handler de stream - Lance un film/série depuis Torbox
 */
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`[TorboxStream] Demande de stream: type=${type}, id=${id}`);

    // Ignore les types non supportés
    if (!['movie', 'series', 'other'].includes(type)) {
        return { streams: [] };
    }

    try {
        let torrent = null;

        // Cas 1: ID fallback tb:xxx
        if (id.startsWith('tb:')) {
            const torrentId = id.replace('tb:', '');
            torrent = torrentsCache.get(torrentId);

            if (!torrent) {
                await getTorboxTorrents();
                torrent = torrentsCache.get(torrentId);
            }
        }
        // Cas 2: IMDB ID tt...
        else if (id.startsWith('tt')) {
            // Cherche dans le cache un torrent avec cet IMDB ID
            await getTorboxTorrents(); // Recharge pour être sûr

            for (const [, t] of torrentsCache) {
                if (t._imdbId === id) {
                    torrent = t;
                    break;
                }
            }

            // Si pas trouvé dans le cache avec _imdbId, cherche par parsing
            if (!torrent) {
                for (const [, t] of torrentsCache) {
                    const parsed = parseTorrentName(t.name);
                    const cinemetaResult = await searchCinemeta(parsed.title, parsed.type, parsed.year);
                    if (cinemetaResult && cinemetaResult.id === id) {
                        t._imdbId = id;
                        torrent = t;
                        break;
                    }
                }
            }
        }

        if (!torrent) {
            console.log('[TorboxStream] Aucun torrent trouvé pour cet ID');
            return { streams: [] };
        }

        console.log(`[TorboxStream] Torrent trouvé: ${torrent.name}`);

        const streams = await generateStreamsForTorrent(torrent);

        console.log(`[TorboxStream] ${streams.length} stream(s) disponible(s)`);
        return { streams };

    } catch (error) {
        console.error('[TorboxStream] Erreur:', error.message);
        return { streams: [] };
    }
});

// Serveur Express
const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

// Route de santé
app.get('/health', (req, res) => {
    res.json({ status: 'ok', addon: 'torbox-status' });
});

// Monte le routeur Stremio
app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║         TORBOX STATUS ADDON                ║
║════════════════════════════════════════════║
║  Port: ${PORT}                               ║
║  API Key: ${TORBOX_API_KEY ? '✓ Configurée' : '✗ Manquante'}                    ║
╠════════════════════════════════════════════╣
║  Manifest: http://localhost:${PORT}/manifest.json
╚════════════════════════════════════════════╝
    `);
});
