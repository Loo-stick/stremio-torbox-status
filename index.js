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

const PORT = parseInt(process.env.PORT, 10) || 7003;
const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const TORBOX_API_URL = 'https://api.torbox.app/v1/api';

/** Cache des torrents pour le stream handler */
const torrentsCache = new Map();

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
 * Handler pour le catalogue Historique
 * @returns {Promise<Object>}
 */
async function handleHistoryCatalog() {
    console.log('[TorboxHistory] Récupération des torrents...');

    try {
        const torrents = await getTorboxTorrents();

        // Trie par date de mise à jour (plus récent en premier)
        const sorted = torrents.sort((a, b) => {
            const dateA = parseDate(a.updated_at) || parseDate(a.created_at) || new Date(0);
            const dateB = parseDate(b.updated_at) || parseDate(b.created_at) || new Date(0);
            return dateB.getTime() - dateA.getTime();
        });

        // Limite à 20 entrées
        const recent = sorted.slice(0, 20);

        console.log('[TorboxHistory] ═══════════════════════════════════════');
        console.log(`[TorboxHistory] ${torrents.length} torrents trouvés, affichage des ${recent.length} plus récents`);

        const metas = recent.map((torrent, index) => {
            const name = torrent.name || 'Sans nom';
            const quality = extractQuality(name);
            const size = formatBytes(torrent.size || 0);
            const date = formatRelativeDate(torrent.updated_at || torrent.created_at);

            console.log(`[TorboxHistory] ${index + 1}. ${name.substring(0, 50)}...`);

            return {
                id: `tbhistory:${torrent.id}`,
                type: 'other',
                name: name,
                poster: generatePoster('🎬', quality || size, '2d4a3e'),
                description: `Taille: ${size}\nAjouté: ${date}\n\nRelease: ${name}`,
                releaseInfo: quality || size
            };
        });

        console.log('[TorboxHistory] ═══════════════════════════════════════');
        console.log(`[TorboxHistory] ${metas.length} entrées générées`);

        return { metas };

    } catch (error) {
        console.error('[TorboxHistory] Erreur:', error.message);
        return {
            metas: [{
                id: 'tbhistory:error',
                type: 'other',
                name: 'Erreur de connexion',
                poster: generatePoster('❌', 'Erreur', 'ff0000'),
                description: `Impossible de récupérer l'historique.\n\nErreur: ${error.message}`
            }]
        };
    }
}

// Manifest de l'addon
const manifest = {
    id: 'community.torbox.status',
    version: '1.2.0',
    name: 'Torbox Status',
    description: 'Stats Torbox + Derniers visionnages',
    logo: 'https://torbox.app/favicon.ico',
    catalogs: [
        {
            type: 'other',
            id: 'torbox-status',
            name: 'Torbox Status'
        },
        {
            type: 'other',
            id: 'torbox-history',
            name: 'Derniers Visionnages'
        }
    ],
    resources: ['catalog', 'meta', 'stream'],
    types: ['other'],
    idPrefixes: ['tbstatus:', 'tbhistory:']
};

const builder = new addonBuilder(manifest);

/**
 * Handler du catalogue - Affiche les stats ou l'historique
 */
builder.defineCatalogHandler(async ({ type, id }) => {
    if (type !== 'other') {
        return { metas: [] };
    }

    // Catalogue Historique
    if (id === 'torbox-history') {
        return handleHistoryCatalog();
    }

    // Catalogue Status
    if (id !== 'torbox-status') {
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
 * Handler meta - Détails d'une stat
 */
builder.defineMetaHandler(async ({ type, id }) => {
    if (type !== 'other' || !id.startsWith('tbstatus:')) {
        return { meta: null };
    }

    // On retourne les mêmes infos que le catalogue
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
 * Handler de stream - Lance un torrent depuis l'historique
 */
builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== 'other' || !id.startsWith('tbhistory:')) {
        return { streams: [] };
    }

    const torrentId = id.replace('tbhistory:', '');
    console.log(`[TorboxStream] Demande de stream pour torrent ${torrentId}`);

    try {
        // Vérifie le cache, sinon recharge les torrents
        let torrent = torrentsCache.get(torrentId);
        if (!torrent) {
            console.log('[TorboxStream] Torrent pas en cache, rechargement...');
            await getTorboxTorrents();
            torrent = torrentsCache.get(torrentId);
        }

        if (!torrent) {
            console.log('[TorboxStream] Torrent introuvable');
            return { streams: [] };
        }

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
                            name: `Torbox`,
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
                    name: `Torbox`,
                    title: `${quality ? quality + ' • ' : ''}${torrent.name}`,
                    url: streamUrl
                });

                console.log(`[TorboxStream] Stream ajouté: ${torrent.name}`);
            } catch (err) {
                console.error(`[TorboxStream] Erreur torrent:`, err.message);
            }
        }

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
