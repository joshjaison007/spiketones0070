import { desktopData, musicLibrary, fileContentMap } from './filesystem.js';
import { 
    fetchGuestbook, 
    insertGuestbook, 
    deleteGuestbookMessage,
    subscribeGuestbook, 
    saveDesktopData, 
    saveWallpaper, 
    saveMusicLibrary, 
    savePinnedWindows,
    loadRemoteConfig,
    subscribeRemoteConfig,
    loadLocalOverrides,
    clearCorruptedLocalCache,
    storeAudioInIdb,
    getAudioFromIdb,
    uploadTrackToCloudStorage,
    isFirebaseConfigured,
    isFirebaseStorageConfigured,
    subscribeFirebaseStatus,
    pingFirebase,
    saveDesktopPositions,
    sendMailMessage,
    fetchMailMessages,
    deleteMailMessage,
    subscribeMailMessages
} from './database.js';

// In-memory audio data URL cache for fast playback
const audioDataMemoryCache = {};

// Helper to resolve actual audio source (handling IndexedDB tracks)
async function loadTrackSource(track) {
    if (!track) return "files/music/song1.mp3";
    if (isYouTubeTrack(track)) {
        return track.src || "";
    }
    if (track.src && track.src.startsWith("indexeddb:")) {
        const id = track.id || track.src.replace("indexeddb:", "");
        if (audioDataMemoryCache[id]) return audioDataMemoryCache[id];
        try {
            const idbData = await getAudioFromIdb(id);
            if (idbData) {
                audioDataMemoryCache[id] = idbData;
                return idbData;
            }
        } catch (e) {}
        return "files/music/song1.mp3";
    }
    return track.src || "files/music/song1.mp3";
}

// ==========================================================================
// YOUTUBE PLAYBACK & METADATA ENGINE
// ==========================================================================
let ytPlayer = null;
let ytPlayerReady = false;
let ytPendingVideoId = null;
let currentPlayingYouTubeId = null;

export function extractYouTubeId(urlOrId) {
    if (!urlOrId || typeof urlOrId !== 'string') return null;
    const str = urlOrId.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
        return str;
    }
    const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/i);
    if (match && match[1]) {
        return match[1];
    }
    const musicMatch = str.match(/music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i);
    if (musicMatch && musicMatch[1]) {
        return musicMatch[1];
    }
    return null;
}

export function isYouTubeTrack(track) {
    if (!track) return false;
    if (track.isYouTube || track.type === "youtube" || track.youtubeId) return true;
    const src = track.src || track.url || "";
    return !!extractYouTubeId(src);
}

// Google Drive Audio & Video Helpers
export function extractGoogleDriveId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/(?:\/file\/d\/|\/d\/|id=|open\?id=|\/folders\/)([a-zA-Z0-9_-]{15,})/);
    return match ? match[1] : null;
}

export function convertGoogleDriveAudioUrl(url) {
    const id = extractGoogleDriveId(url);
    if (id) {
        return `https://drive.google.com/uc?export=download&id=${id}`;
    }
    return url;
}

export function isGoogleDriveTrack(track) {
    if (!track) return false;
    const src = track.src || track.url || (typeof track === "string" ? track : "");
    return track.isGoogleDrive || (typeof src === "string" && (src.includes("drive.google.com") || src.includes("docs.google.com")));
}

// Spotify Audio Helpers
export function extractSpotifyTrackId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/track[\/:]([a-zA-Z0-9]{22})/);
    return match ? match[1] : null;
}

export function isSpotifyTrack(track) {
    if (!track) return false;
    const src = track.src || track.url || "";
    return track.isSpotify || (typeof src === "string" && (src.includes("spotify.com") || src.includes("open.spotify.com")));
}

export async function fetchSpotifyMetadata(url) {
    try {
        const resp = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
        if (resp.ok) {
            const data = await resp.json();
            return {
                title: data.title || "Spotify Track",
                artist: data.author_name || "Spotify Artist",
                thumbnail: data.thumbnail_url || "files/cover/song1.jpg"
            };
        }
    } catch (e) {
        console.warn("Could not fetch Spotify oEmbed:", e);
    }
    return null;
}

// SoundCloud Audio Helpers
export function isSoundCloudTrack(track) {
    if (!track) return false;
    const src = track.src || track.url || "";
    return track.isSoundCloud || (typeof src === "string" && src.includes("soundcloud.com"));
}

export async function fetchSoundCloudMetadata(url) {
    try {
        const resp = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`);
        if (resp.ok) {
            const data = await resp.json();
            return {
                title: data.title || "SoundCloud Track",
                artist: data.author_name || "SoundCloud Artist",
                thumbnail: data.thumbnail_url || "files/cover/song1.jpg"
            };
        }
    } catch (e) {
        console.warn("Could not fetch SoundCloud oEmbed:", e);
    }
    return null;
}

// Universal media metadata fetcher
export async function fetchUniversalMediaMetadata(url) {
    if (!url || typeof url !== "string") return null;
    const cleanUrl = url.trim();

    if (extractYouTubeId(cleanUrl)) {
        return await fetchYouTubeMetadata(cleanUrl);
    }
    if (isSpotifyTrack({ src: cleanUrl })) {
        return await fetchSpotifyMetadata(cleanUrl);
    }
    if (isSoundCloudTrack({ src: cleanUrl })) {
        return await fetchSoundCloudMetadata(cleanUrl);
    }
    if (isGoogleDriveTrack({ src: cleanUrl })) {
        const id = extractGoogleDriveId(cleanUrl);
        return {
            title: `Drive Audio (${id ? id.substring(0, 8) : "File"})`,
            artist: "Google Drive",
            thumbnail: "files/cover/song1.jpg"
        };
    }
    return null;
}

export function getYouTubeThumbnail(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export async function fetchYouTubeMetadata(urlOrId) {
    const videoId = extractYouTubeId(urlOrId);
    if (!videoId) return null;

    const result = {
        videoId,
        title: "",
        artist: "",
        cleanTitle: "",
        thumbnail: getYouTubeThumbnail(videoId)
    };

    try {
        const resp = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`);
        if (resp.ok) {
            const data = await resp.json();
            if (data && data.title) {
                result.title = data.title;
                result.artist = data.author_name || "";
                if (data.thumbnail_url) result.thumbnail = data.thumbnail_url;
            }
        }
    } catch (e) {
        console.warn("Could not fetch YouTube metadata via noembed:", e);
    }

    if (result.title) {
        let clean = result.title
            .replace(/\s*[\(\[](Official\s*(Music\s*)?Video|Audio|Lyric\s*Video|HD|HQ|4K|Visualizer|Music\s*Video|Official\s*Audio)[\)\]]/gi, "")
            .trim();
        if (clean.includes(" - ")) {
            const parts = clean.split(" - ");
            if (!result.artist) result.artist = parts[0].trim();
            result.cleanTitle = parts.slice(1).join(" - ").trim();
        } else {
            result.cleanTitle = clean;
        }
    } else {
        result.cleanTitle = `YouTube Track (${videoId})`;
        result.artist = "YouTube";
    }

    return result;
}

export function initYouTubePlayer() {
    // Remove any legacy floating video window if it exists
    const oldWrap = document.getElementById("yt-video-window");
    if (oldWrap) oldWrap.remove();

    let slot = document.getElementById("yt-player-slot");
    if (!slot) {
        let bridge = document.getElementById("bg-media-bridge");
        if (!bridge) {
            bridge = document.createElement("div");
            bridge.id = "bg-media-bridge";
            bridge.className = "bg-media-bridge";
            document.body.appendChild(bridge);
        }
        slot = document.createElement("div");
        slot.id = "yt-player-slot";
        bridge.appendChild(slot);
    }

    // Connect YouTube IFrame API
    if (!window.YT || !window.YT.Player) {
        const existingHandler = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            if (typeof existingHandler === "function") existingHandler();
            createYTPlayerInstance();
        };
    } else if (!ytPlayer) {
        createYTPlayerInstance();
    }
}

function createYTPlayerInstance() {
    if (ytPlayer || !window.YT || !window.YT.Player) return;
    try {
        ytPlayer = new window.YT.Player("yt-player-slot", {
            height: "100%",
            width: "100%",
            videoId: ytPendingVideoId || "NyTkaQHdySM",
            playerVars: {
                autoplay: 1,
                controls: 1,
                enablejsapi: 1,
                modestbranding: 1,
                rel: 0,
                playsinline: 1
            },
            events: {
                onReady: () => {
                    ytPlayerReady = true;
                    if (ytPendingVideoId) {
                        const vid = ytPendingVideoId;
                        ytPendingVideoId = null;
                        playYouTubeVideo(vid);
                    }
                },
                onStateChange: (evt) => {
                    // 1 = PLAYING, 2 = PAUSED, 0 = ENDED
                    if (evt.data === 1) {
                        isPlaying = true;
                        updateHDDUI();
                    } else if (evt.data === 2) {
                        isPlaying = false;
                        updateHDDUI();
                    } else if (evt.data === 0) {
                        nextTrack();
                    }
                },
                onError: (evt) => {
                    console.warn("YouTube player error:", evt.data);
                    if (evt.data === 101 || evt.data === 150) {
                        showToast("Owner restricted embedding for this video. Advancing...", false);
                    } else {
                        showToast("Could not load YouTube track. Advancing...", false);
                    }
                    setTimeout(() => {
                        if (Array.isArray(currentMusicLibrary) && currentMusicLibrary.length > 1) {
                            nextTrack();
                        } else {
                            isPlaying = false;
                            updateHDDUI();
                        }
                    }, 1200);
                }
            }
        });
    } catch (e) {
        console.error("Error creating YT.Player:", e);
    }
}

export function playYouTubeVideo(videoId) {
    if (!videoId) return;
    currentPlayingYouTubeId = videoId;
    initYouTubePlayer();

    const titleEl = document.getElementById("yt-video-title-text");
    const track = currentMusicLibrary[currentTrackIndex];
    if (titleEl && track) {
        titleEl.textContent = track.title || "YouTube Video";
    }

    if (ytPlayer && ytPlayerReady && typeof ytPlayer.loadVideoById === "function") {
        try {
            ytPlayer.loadVideoById(videoId);
            ytPlayer.playVideo();
            isPlaying = true;
            updateHDDUI();
        } catch (e) {
            console.warn("loadVideoById error:", e);
        }
    } else {
        ytPendingVideoId = videoId;
        setTimeout(() => {
            if (!ytPlayerReady) {
                const slot = document.getElementById("yt-player-slot");
                if (slot && !slot.querySelector("iframe")) {
                    slot.innerHTML = `<iframe id="yt-fallback-iframe" src="https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1" style="width:100%;height:100%;border:none;" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
                    isPlaying = true;
                    updateHDDUI();
                }
            }
        }, 2200);
    }
}

export function pauseYouTubeVideo() {
    if (ytPlayer && ytPlayerReady && typeof ytPlayer.pauseVideo === "function") {
        try {
            ytPlayer.pauseVideo();
        } catch (e) {}
    } else {
        const fallback = document.getElementById("yt-fallback-iframe");
        if (fallback && fallback.contentWindow) {
            try {
                fallback.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
            } catch (e) {}
        }
    }
}

export function resumeYouTubeVideo() {
    if (ytPlayer && ytPlayerReady && typeof ytPlayer.playVideo === "function") {
        try {
            ytPlayer.playVideo();
        } catch (e) {}
    } else {
        const fallback = document.getElementById("yt-fallback-iframe");
        if (fallback && fallback.contentWindow) {
            try {
                fallback.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
            } catch (e) {}
        }
    }
}

export function toggleYouTubeVideoWindow() {
    // Audio-only playback per user request: video UI removed
}

// Ensure music library is normalized without resurrecting deleted tracks
export function sanitizeMusicLibrary(lib) {
    if (!Array.isArray(lib)) return [];
    
    // Normalize existing items only - never re-inject deleted tracks
    return lib
        .filter(t => t && typeof t === 'object' && (t.title || t.name || t.src))
        .map((t, idx) => {
            const src = t.src || t.url || t.file || "";
            const ytId = t.youtubeId || extractYouTubeId(src);
            const isYT = t.isYouTube || !!ytId;
            return {
                title: t.title || t.name || `Track ${idx + 1}`,
                artist: t.artist || (isYT ? "YouTube" : "Unknown Artist"),
                src: src,
                cover: t.cover || t.customIcon || t.image || (isYT && ytId ? getYouTubeThumbnail(ytId) : "files/cover/song1.jpg"),
                ...(t.id ? { id: t.id } : {}),
                ...(isYT ? { isYouTube: true, youtubeId: ytId } : {}),
                ...(t.isLocalUpload ? { isLocalUpload: true } : {}),
                ...(t.isLinkStream ? { isLinkStream: true } : {})
            };
        });
}

// One-time clear so user starts with 0 songs and can add from scratch as requested
try {
    if (!localStorage.getItem("st_music_clean_slate_v2")) {
        localStorage.setItem("st_music_clean_slate_v2", "true");
        localStorage.setItem("st_music_library", JSON.stringify([]));
        
        // Remove songs from the Music folder in saved desktop data
        const savedDt = localStorage.getItem("st_desktop_data");
        if (savedDt) {
            try {
                const parsedDt = JSON.parse(savedDt);
                if (Array.isArray(parsedDt)) {
                    parsedDt.forEach(item => {
                        if (item && item.type === "folder" && item.name && item.name.toLowerCase() === "music") {
                            item.content = [];
                        }
                    });
                    localStorage.setItem("st_desktop_data", JSON.stringify(parsedDt));
                }
            } catch (e) {}
        }
    }
} catch (e) {}

// --- State Variables ---
let currentDesktopData = [...desktopData];
let currentMusicLibrary = [];
let currentWallpaper = "wall.png";
let currentUser = localStorage.getItem("currentUser") || "guest";
let isOwner = currentUser === "admin";

let pinnedWindows = {};
try {
    const savedPinned = localStorage.getItem("st_pinned_windows");
    if (savedPinned) pinnedWindows = JSON.parse(savedPinned);
} catch (e) {
    pinnedWindows = {};
}

let activeWindows = [];
let activeGuestbookRender = null;
let zIndexCounter = 100;
let currentTrackIndex = 0;
let isPlaying = false;
let audio = new Audio();
audio.crossOrigin = "anonymous";

// Default CS2 & Leetify Configuration
export const DEFAULT_CS2_CONFIG = {
    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-military-soldier-aiming-in-the-dark-42407-large.mp4",
    videoTitle: "CS2 Cinematic Cover Video",
    leetifyApiKey: "cc554ec3-3db6-4f54-83b2-c070c40da483",
    leetifyUrl: "https://leetify.com/app/profile/76561199580350164",
    steamId: "76561199580350164",
    playerName: "spiketones007",
    skillRating: 60.17,
    nationalRank: 436,
    premierRating: 15003,
    recentMatch: {
        map: "anubis",
        date: "15 Sep 2026 9:20 PM",
        result: "WIN",
        score: "13:10",
        matchImpact: "+6.66%",
        tSide: "+5.52%",
        ctSide: "+7.9%",
        rounds: [
            { r: 1, val: 5.2, side: "ct" },
            { r: 2, val: 3.8, side: "ct" },
            { r: 3, val: 1.5, side: "ct" },
            { r: 4, val: 0.6, side: "ct" },
            { r: 5, val: 0.2, side: "ct" },
            { r: 6, val: -1.4, side: "t" },
            { r: 7, val: -2.8, side: "t" },
            { r: 8, val: -4.1, side: "t" },
            { r: 9, val: 1.9, side: "t" },
            { r: 10, val: 3.2, side: "t" }
        ]
    },
    trend: [
        { label: "G1", impact: 6.66 },
        { label: "G2", impact: -0.3 },
        { label: "G3", impact: -5.3 },
        { label: "G4", impact: -10.3 },
        { label: "G5", impact: 4.2 }
    ],
    radar: {
        aimedReactionTime: 36,
        accuracy: 98,
        timeToFire: 45,
        crosshairPlacement: 53,
        headshotRate: 69
    },
    stats: {
        headshot: "69%",
        leetifyRating: "+5.42",
        aimScore: "89 / 100",
        crosshairPlacement: "7.1°",
        winRate: "64.2%",
        clutchRating: "74%",
        kd: "1.38",
        adr: "92.4"
    },
    crosshairCode: "CSGO-SL7LH-GOWPk-mV2m3-bO9QG-RcCcO",
    performanceRadar: {
        aim: 82.4,
        positioning: 65.9,
        utility: 40.4
    },
    benchmarkRadar: {
        aim: 92.0,
        positioning: 78.0,
        utility: 65.0
    },
    attributes: {
        accuracy: "38.7%",
        headshot: "17.3%",
        counterStrafing: "75.1%",
        reactionTime: "518ms",
        sprayAccuracy: "42.8%",
        preaim: "8.84°",
        heDamage: "9.51",
        flashDuration: "2.12s",
        utilityOnDeath: "$446",
        tradedDeaths: "56.1%",
        tradeKillOpp: "0.41"
    },
    club: {
        tag: "007 [L7] 007",
        winRate: "70%"
    },
    partySize: {
        solo: 90,
        stack: 10,
        full: 0
    },
    steamDetails: {
        id: "76561199580350164",
        age: "3 years",
        level: 20,
        matches: 1315,
        hours: 844,
        lastMatch: "3 hours ago"
    },
    ranksOverview: {
        premier: "15,003",
        premierPeak: "15,118",
        competitive: "Silver Elite Master",
        wingman: "Gold Nova II",
        mapRanks: [
            { map: "Anubis", rank: "Silver Elite Master" },
            { map: "Inferno", rank: "Silver Elite Master" },
            { map: "Mirage", rank: "Silver Elite Master" },
            { map: "Dust II", rank: "Gold Nova I" }
        ]
    },
    seasons: [
        {
            name: "Season Five",
            dates: "2025-05-22 – Present",
            active: true,
            matches: 161,
            winRate: "58%",
            kd: "1.25",
            premierMin: "7,557",
            premierMax: "15,118",
            premierCurrent: "15,003",
            comp: "Silver Elite Master",
            wingman: "Gold Nova II"
        },
        {
            name: "Season Four",
            dates: "2024-10-15 – 2025-05-21",
            active: false,
            matches: 342,
            winRate: "55%",
            kd: "1.18",
            premierMin: "3,777",
            premierMax: "12,305",
            comp: "Silver Elite",
            wingman: "Silver IV"
        }
    ],
    matches: [
        { map: "de_anubis", result: "WIN", score: "13 : 10", kd: "1.93", hs: "69%", leetify: "+14.15", spray: "43.4%", accuracy: "40.5%", reaction: "500ms", preaim: "7.7°", date: "15 Sep 2026, 9:20 PM" },
        { map: "de_anubis", result: "WIN", score: "13 : 8", kd: "2.00", hs: "63%", leetify: "+10.49", spray: "41.2%", accuracy: "39.1%", reaction: "492ms", preaim: "8.1°", date: "14 Sep 2026, 7:15 PM" },
        { map: "de_inferno", result: "WIN", score: "9 : 4", kd: "1.83", hs: "58%", leetify: "+13.49", spray: "45.0%", accuracy: "42.0%", reaction: "485ms", preaim: "7.2°", date: "13 Sep 2026, 11:30 PM" },
        { map: "de_inferno", result: "WIN", score: "9 : 6", kd: "2.10", hs: "68%", leetify: "+19.36", spray: "46.1%", accuracy: "44.3%", reaction: "478ms", preaim: "6.9°", date: "12 Sep 2026, 8:40 PM" },
        { map: "de_mirage", result: "LOSS", score: "4 : 13", kd: "0.85", hs: "52%", leetify: "-0.07", spray: "36.5%", accuracy: "34.0%", reaction: "540ms", preaim: "10.2°", date: "10 Sep 2026, 6:10 PM" }
    ]
};
export let currentCs2Config = { ...DEFAULT_CS2_CONFIG };

export const DEFAULT_DESKTOP_ICON_POSITIONS = {
    "Socials": { x: 20, y: 20 },
    "Links": { x: 20, y: 110 },
    "Music": { x: 20, y: 200 },
    "CS2": { x: 20, y: 290 },
    "Mail": { x: 20, y: 380 },
    "text.txt": { x: 20, y: 470 },
    "Snake": { x: 115, y: 20 },
    "Terminal": { x: 115, y: 110 },
    "Paint": { x: 115, y: 200 },
    "Calculator": { x: 115, y: 290 },
    "Guestbook": { x: 115, y: 380 },
    "Sticky Notes": { x: 115, y: 470 },
    "Admin Settings": { x: 210, y: 20 }
};

export let currentDesktopPositions = { ...DEFAULT_DESKTOP_ICON_POSITIONS };

// Initial local overrides fallback before remote fetch
try {
    const rawPositions = localStorage.getItem("st_desktop_positions");
    if (rawPositions) {
        currentDesktopPositions = { ...currentDesktopPositions, ...JSON.parse(rawPositions) };
    }
} catch (e) {}

try {
    const initialOverrides = loadLocalOverrides();
    if (initialOverrides.desktopPositions && typeof initialOverrides.desktopPositions === 'object') {
        currentDesktopPositions = { ...currentDesktopPositions, ...initialOverrides.desktopPositions };
    }
    if (initialOverrides.desktopData && Array.isArray(initialOverrides.desktopData)) {
        currentDesktopData = initialOverrides.desktopData;
    }
    if (initialOverrides.wallpaper) {
        currentWallpaper = initialOverrides.wallpaper;
        document.body.style.backgroundImage = `url('${currentWallpaper}')`;
        const lockBg = document.getElementById("lock-screen-bg");
        if (lockBg) lockBg.style.backgroundImage = `url('${currentWallpaper}')`;
    }
    if (initialOverrides.musicLibrary && Array.isArray(initialOverrides.musicLibrary)) {
        currentMusicLibrary = sanitizeMusicLibrary(initialOverrides.musicLibrary);
    }
    if (initialOverrides.cs2Config && typeof initialOverrides.cs2Config === 'object') {
        currentCs2Config = { ...DEFAULT_CS2_CONFIG, ...initialOverrides.cs2Config };
    }
} catch (e) {
    console.warn("Failed reading local overrides; using defaults:", e);
}

// Ensure the Music folder on the desktop matches the library state if empty
const musicFolderRef = currentDesktopData.find(d => d.type === "folder" && d.name && d.name.toLowerCase() === "music");
if (musicFolderRef) {
    if (!Array.isArray(musicFolderRef.content)) musicFolderRef.content = [];
    if (currentMusicLibrary.length === 0) {
        musicFolderRef.content = [];
    }
}

currentTrackIndex = 0;

// Helper to set wallpaper synchronously across desktop and lock screen
export function setWallpaper(url) {
    currentWallpaper = url;
    document.body.style.backgroundImage = `url('${url}')`;
    const desktop = document.getElementById("desktop");
    if (desktop) desktop.style.backgroundImage = `url('${url}')`;
    const lockBg = document.getElementById("lock-screen-bg");
    if (lockBg) lockBg.style.backgroundImage = `url('${url}')`;
    saveWallpaper(url);
}

// Sanitize and ensure core folders (Socials, Links, Music) are intact
function sanitizeDesktopData(data) {
    if (!Array.isArray(data) || data.length === 0) return [...desktopData];
    const defaultSocials = desktopData.find(d => d.name === "Socials");
    const defaultLinks = desktopData.find(d => d.name === "Links");
    const defaultMusic = desktopData.find(d => d.name === "Music");

    const result = data.map(item => {
        if (!item || typeof item !== 'object') return item;
        if (item.name === "Socials") {
            if (!item.content || item.content.length === 0) {
                return { ...item, content: [...(defaultSocials ? defaultSocials.content : [])] };
            }
        }
        if (item.name === "Links") {
            if (!item.content || item.content.length === 0) {
                return { ...item, content: [...(defaultLinks ? defaultLinks.content : [])] };
            }
        }
        if (item.name === "Music") {
            if (!Array.isArray(item.content)) {
                item.content = [];
            }
        }
        return item;
    });

    if (!result.some(d => d.name === "Socials") && defaultSocials) {
        result.unshift({ ...defaultSocials });
    }
    if (!result.some(d => d.name === "Links") && defaultLinks) {
        result.push({ ...defaultLinks });
    }
    if (!result.some(d => d.name === "Music")) {
        result.push({ name: "Music", type: "folder", content: [] });
    }
    if (!result.some(d => d.name === "CS2" || d.type === "cs2")) {
        result.push({ name: "CS2", type: "cs2", content: [] });
    }
    if (!result.some(d => d.name === "Mail" || d.type === "mail")) {
        const cs2Idx = result.findIndex(d => d.name === "CS2" || d.type === "cs2");
        if (cs2Idx !== -1) {
            result.splice(cs2Idx + 1, 0, { name: "Mail", type: "mail" });
        } else {
            result.push({ name: "Mail", type: "mail" });
        }
    }
    result.forEach(item => {
        if ((item.type === "stickynotes" || item.name === "Sticky Notes") && item.customIcon === "fluent:note-pin-24-filled") {
            delete item.customIcon;
        }
    });

    if (!result.some(d => d.name === "Sticky Notes" || d.type === "stickynotes")) {
        result.push({ name: "Sticky Notes", type: "stickynotes" });
    }
    return result;
}

currentDesktopData = sanitizeDesktopData(currentDesktopData);

// --- Cryptographic Password Security (Web Crypto API SHA-256 + Salt) ---
const SALT = "spiketones_salt_2026_secure_";
// Default password hash for "password#1234"
const DEFAULT_PIN_HASH = "3c22c849fe909764d5b44f9783856736a352178892feb5a3207f85f472a53619";

async function computeSha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(SALT + text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function getAdminPasswordHash() {
    return localStorage.getItem("spiketones_admin_pin_hash") || DEFAULT_PIN_HASH;
}

export async function setAdminPassword(newPin) {
    const hash = await computeSha256(newPin);
    localStorage.setItem("spiketones_admin_pin_hash", hash);
    return hash;
}

let currentLockSelectedUser = "guest";

export function lockSystem() {
    const lockScreen = document.getElementById("lock-screen");
    if (!lockScreen) return;
    const lockBg = document.getElementById("lock-screen-bg");
    if (lockBg) lockBg.style.backgroundImage = `url('${currentWallpaper}')`;
    lockScreen.style.display = "flex";
    lockScreen.style.opacity = "1";
    lockScreen.style.transform = "none";
    const errorMsg = document.getElementById("lock-error-msg");
    if (errorMsg) errorMsg.textContent = "";

    // Sync state with selected user
    selectLockUser(currentLockSelectedUser || "guest");
}

export function unlockSystem(asUser = "guest") {
    const lockScreen = document.getElementById("lock-screen");
    if (lockScreen) {
        lockScreen.style.opacity = "0";
        lockScreen.style.transition = "opacity 0.22s ease, transform 0.22s ease";
        lockScreen.style.transform = "scale(1.04)";
        setTimeout(() => {
            lockScreen.style.display = "none";
            lockScreen.style.opacity = "1";
            lockScreen.style.transform = "none";
        }, 230);
    }
    currentUser = asUser;
    localStorage.setItem("currentUser", asUser);
    isOwner = asUser === "admin";
    
    // If guest, close any open admin-only windows like personalization
    if (asUser !== "admin") {
        const pWin = document.getElementById("win-personalization");
        if (pWin) {
            pWin.remove();
            activeWindows = activeWindows.filter(w => w.id !== "win-personalization");
        }
        const oWin = document.getElementById("win-owner-edit");
        if (oWin) {
            oWin.remove();
            activeWindows = activeWindows.filter(w => w.id !== "win-owner-edit");
        }
    }

    updateUserUI();
    renderDesktop();
    renderStartMenuApps();
    
    if (asUser === "admin") {
        showToast("Authenticated as SPIKETONES007 Admin!");
        loadStickyNotes();
        if (stickyNotes.length > 0) {
            stickyNotes.forEach(n => renderStickyNoteElement(n));
        }
    } else {
        // In Guest mode, sticky notes are cleared from the screen
        const notesContainer = document.getElementById("sticky-notes-container");
        if (notesContainer) notesContainer.innerHTML = "";
        showToast("Welcome, Guest!");
    }
}

export function submitGuestWelcome() {
    const welcomeBtn = document.getElementById("lock-welcome-btn");
    const spinner = document.getElementById("welcome-spinner");
    const btnText = document.getElementById("welcome-btn-text");

    if (welcomeBtn) welcomeBtn.disabled = true;
    if (spinner) spinner.style.display = "inline-block";
    if (btnText) btnText.style.display = "none";

    // Play a random song from the music folder immediately on guest welcome
    playRandomTrack().catch(err => console.warn("Background audio play interrupted:", err));

    // Authentic Windows 11 welcome spinner delay before unlocking
    setTimeout(() => {
        unlockSystem("guest");
        if (welcomeBtn) welcomeBtn.disabled = false;
        if (spinner) spinner.style.display = "none";
        if (btnText) btnText.style.display = "inline";
    }, 650);
}

export async function handleLockSubmit(e) {
    if (e) e.preventDefault();
    if (currentLockSelectedUser === "guest") {
        submitGuestWelcome();
        return;
    }
    const pinInput = document.getElementById("lock-pin-input");
    const errorMsg = document.getElementById("lock-error-msg");
    const enteredPin = (pinInput ? pinInput.value : "").trim();
    
    if (!enteredPin) {
        if (errorMsg) errorMsg.textContent = "Please enter password.";
        return;
    }
    
    // Accept Password#Password, password#1234, Password#1234, 0007, or custom hash
    const acceptedDirect = [
        "password#1234",
        "Password#1234",
        "Password#Password",
        "password#password",
        "0007"
    ];

    let isMatch = acceptedDirect.includes(enteredPin);
    if (!isMatch) {
        const enteredHash = await computeSha256(enteredPin);
        const correctHash = getAdminPasswordHash();
        if (enteredHash === correctHash) isMatch = true;
    }
    
    if (isMatch) {
        if (errorMsg) errorMsg.textContent = "";
        unlockSystem("admin");
    } else {
        if (errorMsg) errorMsg.textContent = "The password is incorrect. Try again.";
        const wrap = document.querySelector(".lock-input-wrap");
        if (wrap) {
            wrap.classList.remove("shake");
            void wrap.offsetWidth;
            wrap.classList.add("shake");
        }
        if (pinInput) {
            pinInput.value = "";
            pinInput.focus();
        }
    }
}

export function selectLockUser(userType) {
    currentLockSelectedUser = userType;
    const tileAdmin = document.getElementById("lock-tile-admin");
    const tileGuest = document.getElementById("lock-tile-guest");
    const userName = document.getElementById("lock-user-name");
    const form = document.getElementById("lock-form");
    const guestWrap = document.getElementById("lock-guest-wrap");
    const pinInput = document.getElementById("lock-pin-input");
    const welcomeBtn = document.getElementById("lock-welcome-btn");
    const spinner = document.getElementById("welcome-spinner");
    const btnText = document.getElementById("welcome-btn-text");
    
    if (userType === "admin") {
        if (tileAdmin) tileAdmin.classList.add("active");
        if (tileGuest) tileGuest.classList.remove("active");
        if (userName) userName.textContent = "SPIKETONES007";
        if (form) form.style.display = "flex";
        if (guestWrap) guestWrap.style.display = "none";
        if (pinInput) {
            pinInput.value = "";
            setTimeout(() => pinInput.focus(), 120);
        }
    } else {
        if (tileAdmin) tileAdmin.classList.remove("active");
        if (tileGuest) tileGuest.classList.add("active");
        if (userName) userName.textContent = "Guest";
        if (form) form.style.display = "none";
        if (guestWrap) guestWrap.style.display = "flex";
        if (welcomeBtn) {
            welcomeBtn.disabled = false;
            if (spinner) spinner.style.display = "none";
            if (btnText) btnText.style.display = "inline";
            setTimeout(() => welcomeBtn.focus(), 120);
        }
    }
}

// --- Recursive Folder Finder Helper (Always accesses live reference in currentDesktopData) ---
export function findFolderItem(name, list = currentDesktopData) {
    if (!name || !Array.isArray(list)) return null;
    const nameLower = name.toLowerCase();
    for (const item of list) {
        if (item.type === "folder" && item.name && item.name.toLowerCase() === nameLower) {
            return item;
        }
        if (item.type === "folder" && Array.isArray(item.content)) {
            const nested = findFolderItem(name, item.content);
            if (nested) return nested;
        }
    }
    return null;
}

// --- Fluent System Dialog Helpers (Non-blocking Custom Modals for iframe compatibility) ---
export function showWinDialog({ title = "System", message = "", type = "alert", defaultValue = "", placeholder = "", confirmText = "OK", cancelText = "Cancel", isDanger = false }) {
    return new Promise((resolve) => {
        const existing = document.getElementById("win-fluent-dialog");
        if (existing) existing.remove();

        const backdrop = document.createElement("div");
        backdrop.id = "win-fluent-dialog";
        backdrop.className = "win-dialog-backdrop";

        let bodyContent = `<p class="win-dialog-msg">${escapeHTML(message).replace(/\n/g, '<br/>')}</p>`;
        if (type === "prompt") {
            bodyContent += `<input type="text" id="win-dlg-input" class="win-dialog-input" value="${escapeHTML(defaultValue)}" placeholder="${escapeHTML(placeholder)}" autocomplete="off" />`;
        }

        const showCancel = type === "confirm" || type === "prompt";
        const primaryClass = isDanger ? "danger" : "primary";

        backdrop.innerHTML = `
            <div class="win-dialog-box" role="dialog" aria-modal="true">
                <div class="win-dialog-header">
                    <span class="win-dialog-title">${escapeHTML(title)}</span>
                    <button class="win-dialog-close" id="win-dlg-close">&times;</button>
                </div>
                <div class="win-dialog-body">
                    ${bodyContent}
                </div>
                <div class="win-dialog-footer">
                    ${showCancel ? `<button class="win-dialog-btn cancel" id="win-dlg-cancel">${escapeHTML(cancelText)}</button>` : ''}
                    <button class="win-dialog-btn ${primaryClass}" id="win-dlg-confirm">${escapeHTML(confirmText)}</button>
                </div>
            </div>
        `;

        document.body.appendChild(backdrop);

        const inputEl = backdrop.querySelector("#win-dlg-input");
        const confirmBtn = backdrop.querySelector("#win-dlg-confirm");
        const cancelBtn = backdrop.querySelector("#win-dlg-cancel");
        const closeBtn = backdrop.querySelector("#win-dlg-close");

        if (inputEl) {
            setTimeout(() => {
                inputEl.focus();
                inputEl.select();
            }, 60);
        } else {
            setTimeout(() => confirmBtn && confirmBtn.focus(), 60);
        }

        const cleanup = () => {
            backdrop.remove();
        };

        const handleConfirm = () => {
            cleanup();
            if (type === "prompt") {
                resolve(inputEl ? inputEl.value : defaultValue);
            } else if (type === "confirm") {
                resolve(true);
            } else {
                resolve(true);
            }
        };

        const handleCancel = () => {
            cleanup();
            if (type === "prompt") {
                resolve(null);
            } else if (type === "confirm") {
                resolve(false);
            } else {
                resolve(false);
            }
        };

        confirmBtn.addEventListener("click", handleConfirm);
        if (cancelBtn) cancelBtn.addEventListener("click", handleCancel);
        closeBtn.addEventListener("click", handleCancel);
        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) handleCancel();
        });

        backdrop.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleConfirm();
            } else if (e.key === "Escape") {
                e.preventDefault();
                handleCancel();
            }
        });
    });
}

export function winConfirm(message, title = "Confirm", isDanger = false) {
    return showWinDialog({ title, message, type: "confirm", confirmText: isDanger ? "Delete" : "OK", isDanger });
}

export function winPrompt(message, defaultValue = "", title = "Input", placeholder = "") {
    return showWinDialog({ title, message, type: "prompt", defaultValue, placeholder, confirmText: "OK" });
}

export function winAlert(message, title = "Notice") {
    return showWinDialog({ title, message, type: "alert", confirmText: "OK" });
}

// --- Windows 11 Fluent Add New Link Modal (Supports custom title, url & custom icon/cover upload) ---
export function showNewLinkDialog(targetFolder = null) {
    const existing = document.getElementById("win-new-link-dialog");
    if (existing) existing.remove();

    const backdrop = document.createElement("div");
    backdrop.id = "win-new-link-dialog";
    backdrop.className = "win-dialog-backdrop";

    const targetName = targetFolder ? targetFolder.name : "Desktop";

    backdrop.innerHTML = `
        <div class="win-dialog-box" style="max-width: 440px;" role="dialog" aria-modal="true">
            <div class="win-dialog-header">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <iconify-icon icon="fluent:link-add-24-filled" width="18" height="18" style="color: #00a2ed;"></iconify-icon>
                    <span class="win-dialog-title">Add Web Link (${escapeHTML(targetName)})</span>
                </div>
                <button class="win-dialog-close" id="dlg-link-close">&times;</button>
            </div>
            <div class="win-dialog-body">
                <div>
                    <label style="display: block; font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.6); text-transform: uppercase; margin-bottom: 6px;">Link Name / Title</label>
                    <input type="text" id="dlg-link-title" class="win-dialog-input" placeholder="e.g. GitHub, Reddit, Twitch, Portfolio" autocomplete="off" />
                </div>
                <div>
                    <label style="display: block; font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.6); text-transform: uppercase; margin-bottom: 6px;">Web URL</label>
                    <input type="url" id="dlg-link-url" class="win-dialog-input" placeholder="e.g. https://github.com/..." autocomplete="off" />
                </div>
                <div>
                    <label style="display: block; font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.6); text-transform: uppercase; margin-bottom: 6px;">Custom Cover / Icon (Optional)</label>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div id="dlg-link-preview" style="width: 46px; height: 46px; border-radius: 8px; background: rgba(255,255,255,0.08); border: 1px dashed rgba(255,255,255,0.25); display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0;">
                            <iconify-icon icon="fluent:link-24-filled" width="24" height="24" style="color: #00a2ed;"></iconify-icon>
                        </div>
                        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                            <button type="button" class="win-dialog-btn cancel" id="dlg-link-cover-btn" style="width: 100%; text-align: center; padding: 6px 10px; font-size: 12px;">
                                Choose Image File...
                            </button>
                            <input type="file" id="dlg-link-file" accept="image/*" style="display: none;" />
                            <span id="dlg-link-filename" style="font-size: 10px; color: rgba(255,255,255,0.45); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Default web icon will be used if left blank</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="win-dialog-footer">
                <button class="win-dialog-btn cancel" id="dlg-link-cancel">Cancel</button>
                <button class="win-dialog-btn primary" id="dlg-link-submit">Create Link</button>
            </div>
        </div>
    `;

    document.body.appendChild(backdrop);

    let chosenCoverDataUrl = null;
    const titleInput = backdrop.querySelector("#dlg-link-title");
    const urlInput = backdrop.querySelector("#dlg-link-url");
    const previewEl = backdrop.querySelector("#dlg-link-preview");
    const fileInput = backdrop.querySelector("#dlg-link-file");
    const coverBtn = backdrop.querySelector("#dlg-link-cover-btn");
    const filenameLabel = backdrop.querySelector("#dlg-link-filename");

    setTimeout(() => titleInput && titleInput.focus(), 60);

    coverBtn.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            const reader = new FileReader();
            reader.onload = (ev) => {
                chosenCoverDataUrl = ev.target.result;
                previewEl.innerHTML = `<img src="${chosenCoverDataUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px;" />`;
                filenameLabel.textContent = file.name;
                filenameLabel.style.color = "#4cd137";
            };
            reader.readAsDataURL(file);
        }
    });

    const closeDialog = () => {
        backdrop.remove();
    };

    backdrop.querySelector("#dlg-link-close").addEventListener("click", closeDialog);
    backdrop.querySelector("#dlg-link-cancel").addEventListener("click", closeDialog);
    backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) closeDialog();
    });

    const doSubmit = () => {
        const title = titleInput.value.trim();
        let rawUrl = urlInput.value.trim();
        if (!title) {
            titleInput.focus();
            showToast("Please enter a link title or name");
            return;
        }
        if (!rawUrl) {
            urlInput.focus();
            showToast("Please enter a URL for the link");
            return;
        }

        if (!/^https?:\/\//i.test(rawUrl)) {
            rawUrl = "https://" + rawUrl;
        }

        const newLink = {
            name: title,
            type: "link",
            url: rawUrl,
            cover: chosenCoverDataUrl || null,
            customIcon: chosenCoverDataUrl || null
        };

        if (targetFolder) {
            const liveFolder = findFolderItem(targetFolder.name) || targetFolder;
            if (!liveFolder.content) liveFolder.content = [];
            liveFolder.content.push(newLink);
            openFolderWindow(liveFolder);
        } else {
            currentDesktopData.push(newLink);
            renderDesktop();
        }

        saveDesktopData(currentDesktopData);
        closeDialog();
        showToast(`Created link "${title}"`);
    };

    backdrop.querySelector("#dlg-link-submit").addEventListener("click", doSubmit);
    backdrop.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            doSubmit();
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeDialog();
        }
    });
}

export async function showForgotPinPrompt() {
    const code = await winPrompt("Admin Recovery / Reset PIN:\nEnter new secret PIN (or type 0007):", "0007", "Admin PIN Recovery");
    if (code !== null && code.trim().length > 0) {
        await setAdminPassword(code.trim());
        showToast("New secret PIN saved & securely hashed! Please enter your new PIN to sign in.");
        const pinInput = document.getElementById("lock-pin-input");
        if (pinInput) pinInput.focus();
    }
}

export function toggleSignInOptions() {
    const pinInput = document.getElementById("lock-pin-input");
    if (!pinInput) return;
    if (pinInput.type === "password") {
        pinInput.type = "text";
        pinInput.placeholder = "Password / PIN";
        showToast("Password visibility toggled");
    } else {
        pinInput.type = "password";
        pinInput.placeholder = "PIN";
    }
}

// --- Notification Toast ---
function showToast(message, isSuccess = true) {
    const existing = document.querySelector(".owner-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "owner-toast";
    toast.innerHTML = `<span>${isSuccess ? '✓' : 'ℹ'}</span> <span>${escapeHTML(message)}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

// --- Icon Resolution Helper ---
function getIconMetadata(item) {
    if (item.type === "folder") return { icon: "fluent:folder-24-filled", color: "#f8d45c" };
    if (item.type === "file") return { icon: "fluent:document-24-filled", color: "#f5f5f5" };
    if (item.type === "image") return { icon: "fluent:image-24-filled", color: "#00a2ed" };
    if (item.type === "guestbook") return { icon: "fluent:chat-bubbles-question-24-filled", color: "#c85627" };
    if (item.type === "music") return { icon: "fluent:music-note-2-24-filled", color: "#ff8c00" };
    if (item.type === "link") return { icon: "fluent:link-24-filled", color: "#00a2ed" };
    if (item.type === "calculator") return { icon: "fluent:calculator-24-filled", color: "#00a2ed" };
    if (item.type === "paint") return { icon: "fluent:paint-brush-24-filled", color: "#e056fd" };
    if (item.type === "terminal") return { icon: "fluent:window-console-20-filled", color: "#2ed573" };
    if (item.type === "snake") return { icon: "fluent:games-24-filled", color: "#ffa502" };
    if (item.type === "stickynotes" || item.name === "Sticky Notes") return { icon: "fluent:note-24-filled", color: "#ffd32a" };
    if (item.type === "cs2" || item.name === "CS2") return { icon: "fluent:games-24-filled", color: "#ff7700" };
    return { icon: "fluent:app-folder-24-filled", color: "#cccccc" };
}

function getIconHTML(item, size = "large") {
    const dim = size === "large" ? 44 : size === "medium" ? 34 : 22;
    const nameLower = (item.name || "").toLowerCase();

    // Check for custom cover art (image data URL or image path) first
    if (item.cover || (item.customIcon && (item.customIcon.startsWith('data:') || item.customIcon.includes('/') || item.customIcon.includes('.')))) {
        const coverSrc = item.cover || item.customIcon;
        const meta = getIconMetadata(item);
        return `<img src="${coverSrc}" class="custom-icon-cover" style="width: ${dim}px; height: ${dim}px; border-radius: 8px; object-fit: cover;" onerror="this.outerHTML='<iconify-icon icon=\\'${meta.icon}\\' width=\\'${dim}\\' height=\\'${dim}\\' style=\\'color: ${meta.color};\\'></iconify-icon>';" />`;
    }

    // Counter-Strike 2 Tactical Folder / App Icon
    if (item.type === "cs2" || nameLower === "cs2") {
        return `<svg width="${dim}" height="${dim}" viewBox="0 0 48 48" fill="none" style="filter: drop-shadow(0 3px 10px rgba(255, 119, 0, 0.45));">
            <rect width="48" height="48" rx="10" fill="#13151f"/>
            <rect x="1" y="1" width="46" height="46" rx="9" stroke="rgba(255, 120, 0, 0.4)" stroke-width="1.5"/>
            <path d="M12 15C12 13.3431 13.3431 12 15 12H23C24.6569 12 26 13.3431 26 15V19C26 20.6569 24.6569 22 23 22H16V26H23C24.6569 26 26 27.3431 26 29V33C26 34.6569 24.6569 36 23 36H15C13.3431 36 12 34.6569 12 33V15Z" fill="#ff7700"/>
            <path d="M28 15C28 13.3431 29.3431 12 31 12H34C35.6569 12 37 13.3431 37 15V23C37 24.6569 35.6569 26 34 26H31V30H37V36H28V15Z" fill="#ffffff"/>
            <path d="M36 10L40 10L32 38L28 38L36 10Z" fill="#ff5500" opacity="0.85"/>
            <text x="24" y="44" fill="#ffaa33" font-family="'Segoe UI', system-ui, sans-serif" font-weight="900" font-size="7" text-anchor="middle" letter-spacing="0.8">CS2</text>
        </svg>`;
    }

    // Specific Brand SVGs for 100% guarantee visibility & crisp Windows 11 look
    if (nameLower === "youtube") {
        return `<svg width="${dim}" height="${dim}" viewBox="0 0 24 24" fill="#FF0000" style="filter: drop-shadow(0 2px 6px rgba(255,0,0,0.35));"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`;
    }
    if (nameLower === "discord") {
        return `<svg width="${dim}" height="${dim}" viewBox="0 0 24 24" fill="#5865F2" style="filter: drop-shadow(0 2px 6px rgba(88,101,242,0.35));"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;
    }
    if (item.type === "stickynotes" || nameLower === "sticky notes") {
        return `<svg width="${dim}" height="${dim}" viewBox="0 0 48 48" fill="none" style="filter: drop-shadow(0 3px 8px rgba(255, 185, 0, 0.45));">
            <rect x="6" y="6" width="36" height="36" rx="7" fill="#FFB900"/>
            <path d="M6 30L18 42H13C9.134 42 6 38.866 6 35V30Z" fill="#E6A500"/>
            <path d="M6 30H18V42L6 30Z" fill="#FFF1B8"/>
            <line x1="12" y1="16" x2="36" y2="16" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.9"/>
            <line x1="12" y1="23" x2="30" y2="23" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.9"/>
        </svg>`;
    }
    if (item.type === "mail" || nameLower === "mail" || nameLower === "gmail") {
        return `<svg width="${dim}" height="${dim}" viewBox="0 0 48 48" fill="none" style="filter: drop-shadow(0 2px 7px rgba(234, 67, 53, 0.4));">
            <rect width="48" height="48" rx="10" fill="#ffffff" fill-opacity="0.06"/>
            <path fill="#4caf50" d="M42,16.2l-5,2.75l-5,4.75L32,38h7c1.657,0,3-1.343,3-3V16.2z"></path>
            <path fill="#1e88e5" d="M6,16.2l3.614,1.71L16,23.7V38H9c-1.657,0-3-1.343-3-3V16.2z"></path>
            <polygon fill="#e53935" points="32,11.2 24,18.45 16,11.2 15,16.5 16,23.7 24,30.95 32,23.7 33,16.5"></polygon>
            <path fill="#c62828" d="M6,12.3V16.2l10,7.5V11.2L12.876,8.859C11.132,7.553,8.642,8.026,7.475,9.873 C6.535,11.36,6.486,11.834,6,12.3z"></path>
            <path fill="#fbc02d" d="M42,12.3V16.2l-10,7.5V11.2l3.124-2.341c1.744-1.307,4.234-0.834,5.401,1.014 C41.465,11.36,41.514,11.834,42,12.3z"></path>
        </svg>`;
    }

    if (item.customIcon) {
        return `<iconify-icon icon="${item.customIcon}" width="${dim}" height="${dim}"></iconify-icon>`;
    }
    const meta = getIconMetadata(item);
    return `<iconify-icon icon="${meta.icon}" width="${dim}" height="${dim}" style="color: ${meta.color}"></iconify-icon>`;
}

// --- Desktop Rendering ---
function renderDesktop() {
    const container = document.getElementById("desktopIcons");
    if (!container) return;
    container.innerHTML = "";
    
    currentDesktopData.forEach((item, index) => {
        // Sticky Notes is exclusive to SPIKETONES007 admin
        if (currentUser !== "admin" && (item.type === "stickynotes" || item.name === "Sticky Notes")) {
            return;
        }
        // Hidden for guest feature
        if (currentUser !== "admin" && item.hiddenForGuest) {
            return;
        }

        const iconDiv = document.createElement("div");
        iconDiv.className = "icon";
        iconDiv.id = `desktop-icon-${index}`;
        iconDiv.setAttribute("data-index", index);
        iconDiv.setAttribute("data-name", item.name);

        let badgeHTML = "";
        if (currentUser === "admin" && item.hiddenForGuest) {
            badgeHTML = `<div class="hidden-for-guest-badge" title="Hidden for guest"><iconify-icon icon="fluent:eye-off-24-filled" width="13" height="13"></iconify-icon></div>`;
        }

        const pos = (currentDesktopPositions && currentDesktopPositions[item.name])
            || (DEFAULT_DESKTOP_ICON_POSITIONS && DEFAULT_DESKTOP_ICON_POSITIONS[item.name])
            || { x: 20 + Math.floor(index / 6) * 95, y: 20 + (index % 6) * 90 };
        iconDiv.style.position = "absolute";
        iconDiv.style.left = `${pos.x}px`;
        iconDiv.style.top = `${pos.y}px`;
        iconDiv.style.margin = "0";

        iconDiv.innerHTML = `
            ${badgeHTML}
            ${getIconHTML(item, "large")}
            <span>${escapeHTML(item.name)}</span>
        `;

        let didMovePointer = false;

        // Drag & drop icon re-arranging and moving across the screen for Admin
        if (currentUser === "admin") {
            iconDiv.setAttribute("draggable", "true");
            iconDiv.addEventListener("dragstart", (e) => {
                const rect = iconDiv.getBoundingClientRect();
                e.dataTransfer.setData("application/json", JSON.stringify({
                    source: "desktop",
                    index,
                    name: item.name,
                    offsetX: e.clientX - rect.left,
                    offsetY: e.clientY - rect.top
                }));
                iconDiv.classList.add("dragging");
            });
            iconDiv.addEventListener("dragend", () => {
                iconDiv.classList.remove("dragging");
            });

            // Direct tactile pointer drag for moving icons anywhere on desktop
            let isDragging = false;
            let startX = 0, startY = 0;
            let initialLeft = 0, initialTop = 0;

            iconDiv.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                const desktop = document.getElementById("desktop");
                if (!desktop) return;
                const deskRect = desktop.getBoundingClientRect();
                const iconRect = iconDiv.getBoundingClientRect();

                startX = e.clientX;
                startY = e.clientY;
                initialLeft = iconRect.left - deskRect.left;
                initialTop = iconRect.top - deskRect.top;
                didMovePointer = false;

                const onMove = (ev) => {
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    if (!didMovePointer && Math.hypot(dx, dy) > 6) {
                        didMovePointer = true;
                        isDragging = true;
                        iconDiv.classList.add("dragging");
                        iconDiv.style.position = "absolute";
                        iconDiv.style.margin = "0";
                        iconDiv.style.zIndex = "9999";
                    }
                    if (isDragging) {
                        let curX = Math.round(initialLeft + dx);
                        let curY = Math.round(initialTop + dy);
                        curX = Math.max(10, Math.min(deskRect.width - 85, curX));
                        curY = Math.max(10, Math.min(deskRect.height - 110, curY));
                        iconDiv.style.left = `${curX}px`;
                        iconDiv.style.top = `${curY}px`;
                    }
                };

                const onUp = (ev) => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    if (isDragging) {
                        isDragging = false;
                        iconDiv.classList.remove("dragging");
                        iconDiv.style.zIndex = "";
                        const dx = ev.clientX - startX;
                        const dy = ev.clientY - startY;
                        let finalX = Math.round(initialLeft + dx);
                        let finalY = Math.round(initialTop + dy);
                        finalX = Math.max(10, Math.min(deskRect.width - 85, finalX));
                        finalY = Math.max(10, Math.min(deskRect.height - 110, finalY));

                        currentDesktopPositions[item.name] = { x: finalX, y: finalY };
                        saveDesktopPositions(currentDesktopPositions);
                        showToast(`Repositioned "${item.name}"`);
                    }
                };

                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            });

            if (item.type === "folder") {
                iconDiv.setAttribute("data-is-folder", "true");
                iconDiv.addEventListener("dragover", (e) => {
                    e.preventDefault();
                    iconDiv.classList.add("folder-drop-hover");
                });
                iconDiv.addEventListener("dragleave", () => {
                    iconDiv.classList.remove("folder-drop-hover");
                });
                iconDiv.addEventListener("drop", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    iconDiv.classList.remove("folder-drop-hover");
                    try {
                        const raw = e.dataTransfer.getData("application/json");
                        if (!raw) return;
                        const data = JSON.parse(raw);
                        if (data.source === "desktop" && typeof data.index === "number" && data.index !== index) {
                            const [moved] = currentDesktopData.splice(data.index, 1);
                            if (!item.content) item.content = [];
                            item.content.push(moved);
                            if (currentDesktopPositions[moved.name]) {
                                delete currentDesktopPositions[moved.name];
                                saveDesktopPositions(currentDesktopPositions);
                            }
                            saveDesktopData(currentDesktopData);
                            renderDesktop();
                            showToast(`Moved "${moved.name}" into "${item.name}"`);
                        }
                    } catch (err) {
                        console.error("Drop error:", err);
                    }
                });
            }
        }

        iconDiv.addEventListener("click", () => {
            if (didMovePointer) {
                didMovePointer = false;
                return;
            }
            handleItemClick(item);
        });

        container.appendChild(iconDiv);
    });

    // If logged in as Admin, show Admin Settings icon on desktop
    if (currentUser === "admin") {
        const adminIconDiv = document.createElement("div");
        adminIconDiv.className = "icon admin-desktop-icon";
        adminIconDiv.id = "desktop-icon-admin";
        const adminPos = (currentDesktopPositions && currentDesktopPositions["Admin Settings"])
            || (DEFAULT_DESKTOP_ICON_POSITIONS && DEFAULT_DESKTOP_ICON_POSITIONS["Admin Settings"])
            || { x: 210, y: 20 };
        adminIconDiv.style.position = "absolute";
        adminIconDiv.style.left = `${adminPos.x}px`;
        adminIconDiv.style.top = `${adminPos.y}px`;
        adminIconDiv.style.margin = "0";
        adminIconDiv.innerHTML = `
            <iconify-icon icon="fluent:settings-24-filled" width="44" height="44" style="color: #ff8c00; filter: drop-shadow(0 2px 8px rgba(255, 140, 0, 0.4));"></iconify-icon>
            <span>Admin Settings</span>
        `;
        adminIconDiv.setAttribute("draggable", "true");
        adminIconDiv.addEventListener("dragstart", (e) => {
            const rect = adminIconDiv.getBoundingClientRect();
            e.dataTransfer.setData("application/json", JSON.stringify({
                source: "desktop",
                name: "Admin Settings",
                offsetX: e.clientX - rect.left,
                offsetY: e.clientY - rect.top
            }));
            adminIconDiv.classList.add("dragging");
        });
        adminIconDiv.addEventListener("dragend", () => {
            adminIconDiv.classList.remove("dragging");
        });

        let didMoveAdminPointer = false;
        adminIconDiv.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            const desktop = document.getElementById("desktop");
            if (!desktop) return;
            const deskRect = desktop.getBoundingClientRect();
            const iconRect = adminIconDiv.getBoundingClientRect();

            let startX = e.clientX;
            let startY = e.clientY;
            let initialLeft = iconRect.left - deskRect.left;
            let initialTop = iconRect.top - deskRect.top;
            didMoveAdminPointer = false;
            let isDraggingAdmin = false;

            const onMove = (ev) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!didMoveAdminPointer && Math.hypot(dx, dy) > 6) {
                    didMoveAdminPointer = true;
                    isDraggingAdmin = true;
                    adminIconDiv.classList.add("dragging");
                    adminIconDiv.style.position = "absolute";
                    adminIconDiv.style.margin = "0";
                    adminIconDiv.style.zIndex = "9999";
                }
                if (isDraggingAdmin) {
                    let curX = Math.round(initialLeft + dx);
                    let curY = Math.round(initialTop + dy);
                    curX = Math.max(10, Math.min(deskRect.width - 85, curX));
                    curY = Math.max(10, Math.min(deskRect.height - 110, curY));
                    adminIconDiv.style.left = `${curX}px`;
                    adminIconDiv.style.top = `${curY}px`;
                }
            };

            const onUp = (ev) => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                if (isDraggingAdmin) {
                    isDraggingAdmin = false;
                    adminIconDiv.classList.remove("dragging");
                    adminIconDiv.style.zIndex = "";
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    let finalX = Math.round(initialLeft + dx);
                    let finalY = Math.round(initialTop + dy);
                    finalX = Math.max(10, Math.min(deskRect.width - 85, finalX));
                    finalY = Math.max(10, Math.min(deskRect.height - 110, finalY));

                    currentDesktopPositions["Admin Settings"] = { x: finalX, y: finalY };
                    saveDesktopPositions(currentDesktopPositions);
                    showToast(`Repositioned "Admin Settings"`);
                }
            };

            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        adminIconDiv.addEventListener("click", () => {
            if (didMoveAdminPointer) {
                didMoveAdminPointer = false;
                return;
            }
            openAdminEditMode();
        });
        container.appendChild(adminIconDiv);
    }
}

// --- Item Click Handler ---
function handleItemClick(item) {
    if (!item) return;
    if (item.type === "cs2" || (item.name && item.name.toLowerCase() === "cs2")) {
        pauseCurrentPlayback();
        openCs2Experience();
        return;
    }
    if (item.type === "folder") {
        openFolderWindow(item);
    } else if (item.type === "file") {
        openNotepad(item.name, item.content !== undefined ? item.content : null);
    } else if (item.type === "image") {
        openImageViewer(item);
    } else if (item.type === "guestbook") {
        openGuestbook();
    } else if (item.type === "admin_settings") {
        openAdminEditMode();
    } else if (item.type === "calculator" || item.type === "calc") {
        openCalculator();
    } else if (item.type === "paint") {
        openPaint();
    } else if (item.type === "terminal") {
        openTerminal();
    } else if (item.type === "snake") {
        openSnake();
    } else if (item.type === "stickynotes" || item.name === "Sticky Notes") {
        openStickyNotes();
    } else if (item.type === "mail" || (item.name && (item.name.toLowerCase() === "mail" || item.name.toLowerCase() === "gmail"))) {
        openMailApp();
    } else if (item.type === "link") {
        if (item.url) {
            try {
                const opened = window.open(item.url, "_blank", "noopener,noreferrer");
                if (!opened) {
                    const a = document.createElement("a");
                    a.href = item.url;
                    a.target = "_blank";
                    a.rel = "noopener noreferrer";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }
            } catch (e) {
                const a = document.createElement("a");
                a.href = item.url;
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
        }
    } else if (item.type === "music") {
        playTrackBySrc(item.src, item.name);
    }
}

// --- Windows Management ---
function bringToFront(win) {
    zIndexCounter++;
    win.style.zIndex = zIndexCounter;
}

export function openWindow(title, contentHTML, iconHTML = "", customId = null, extraClass = "") {
    const id = customId || `win-${Date.now()}`;
    const existing = document.getElementById(id);
    if (existing) {
        existing.classList.remove("minimized");
        bringToFront(existing);
        updateTaskbar();
        return existing;
    }

    const win = document.createElement("div");
    win.className = `window ${extraClass}`;
    win.id = id;
    
    // Check if pinned position exists for this window (spawn location)
    const pinned = pinnedWindows[id] || pinnedWindows[title];
    if (pinned) {
        win.style.top = `${pinned.top}px`;
        win.style.left = `${pinned.left}px`;
        if (pinned.width) win.style.width = `${pinned.width}px`;
        if (pinned.height) win.style.height = `${pinned.height}px`;
        win.style.bottom = "auto";
        win.style.right = "auto";
    } else if (!extraClass.includes("guestbook-panel")) {
        const offset = (activeWindows.length * 24) % 120;
        win.style.top = `${80 + offset}px`;
        win.style.left = `${70 + offset}px`;
    }

    const isPinned = !!pinned;
    const pinBtnHTML = currentUser === 'admin' ? `
        <button class="win-btn pin-btn ${isPinned ? 'pinned' : ''}" id="pin-${id}" title="Pin window spawn location for guests">
            <iconify-icon icon="fluent:pin-24-filled" width="13" height="13"></iconify-icon>
        </button>
    ` : '';

    win.innerHTML = `
        <div class="window-header">
            <div class="window-title">${iconHTML} <span>${title}</span></div>
            <div class="window-controls">
                ${pinBtnHTML}
                <button class="win-btn minimize" title="Minimize">_</button>
                <button class="win-btn maximize" title="Maximize">🗖</button>
                <button class="win-btn close" title="Close">✕</button>
            </div>
        </div>
        <div class="window-body">${contentHTML}</div>
    `;

    // Locked size for Guest folder windows
    if (currentUser !== "admin" && extraClass.includes("folder-window")) {
        const maxBtn = win.querySelector(".maximize");
        if (maxBtn) maxBtn.style.display = "none";
        win.style.resize = "none";
    }

    document.getElementById("window-container").appendChild(win);
    bringToFront(win);

    // Draggable header
    const header = win.querySelector(".window-header");
    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    const onMouseDown = (e) => {
        if (e.target.closest(".window-controls")) return;
        isDragging = true;
        bringToFront(win);
        const rect = win.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = rect.left;
        initialTop = rect.top;

        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            win.style.left = `${initialLeft + dx}px`;
            win.style.top = `${initialTop + dy}px`;
            win.style.bottom = "auto";
            win.style.right = "auto";
        };

        const onMouseUp = () => {
            isDragging = false;
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
    };

    header.addEventListener("mousedown", onMouseDown);
    win.addEventListener("mousedown", () => bringToFront(win));

    // Pin Button (Admin Only: Pin Spawn Location)
    const pinBtn = win.querySelector(`#pin-${id}`);
    if (pinBtn) {
        pinBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const rect = win.getBoundingClientRect();
            pinnedWindows[id] = {
                top: Math.round(rect.top),
                left: Math.round(rect.left),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                title: title
            };
            pinnedWindows[title] = pinnedWindows[id];
            savePinnedWindows(pinnedWindows);
            pinBtn.classList.add("pinned");
            showToast(`📌 Pinned spawn location for "${title}" for guests!`);
        });
    }

    // Controls
    win.querySelector(".minimize").addEventListener("click", () => {
        win.classList.add("minimized");
        updateTaskbar();
    });

    const maxBtn = win.querySelector(".maximize");
    if (maxBtn) {
        maxBtn.addEventListener("click", () => {
            win.classList.toggle("maximized");
            maxBtn.textContent = win.classList.contains("maximized") ? "🗗" : "🗖";
        });
    }

    win.querySelector(".close").addEventListener("click", () => {
        win.remove();
        activeWindows = activeWindows.filter(w => w.id !== id);
        updateTaskbar();
    });

    activeWindows.push({ id, title, iconHTML });
    updateTaskbar();
    return win;
}

// Currently targeted folder for file uploads & context actions
let currentTargetFolder = null;

// --- Folder Window with Bottom Right Upload (Admin Only) & Right-Click Management ---
function openFolderWindow(folderItem) {
    currentTargetFolder = folderItem;
    const winId = `win-${folderItem.name.toLowerCase().replace(/\s+/g, '-')}`;
    const isMusic = folderItem.name.toLowerCase() === "music";
    
    // Close existing to re-render fresh content
    const existing = document.getElementById(winId);
    if (existing) {
        existing.remove();
        activeWindows = activeWindows.filter(w => w.id !== winId);
    }
    
    let itemsHTML = `
        <div class="folder-header-bar">
            <div class="folder-path-text">📁 C:\\Users\\SPIKETONES\\${escapeHTML(folderItem.name)}</div>
            ${currentUser === "admin" ? `
            <div class="folder-header-actions">
                ${isMusic ? `
                <button class="folder-action-btn mini primary" id="btn-hdr-addsong-${winId}" title="Add song via stream link or audio upload">
                    <iconify-icon icon="fluent:music-note-2-24-filled" width="13" height="13" style="color: #ff8c00;"></iconify-icon>
                    <span>Add Song</span>
                </button>
                <button class="folder-action-btn mini danger" id="btn-hdr-clearsongs-${winId}" title="Delete all songs from Music folder">
                    <iconify-icon icon="fluent:delete-24-filled" width="13" height="13" style="color: #ff4757;"></iconify-icon>
                    <span>Clear All</span>
                </button>
                ` : ''}
                <button class="folder-action-btn mini" id="btn-hdr-newfolder-${winId}" title="New Folder">
                    <iconify-icon icon="fluent:folder-add-24-filled" width="13" height="13"></iconify-icon>
                    <span>New Folder</span>
                </button>
                <button class="folder-action-btn mini" id="btn-hdr-newfile-${winId}" title="New Text Document">
                    <iconify-icon icon="fluent:document-add-24-filled" width="13" height="13"></iconify-icon>
                    <span>New File</span>
                </button>
                <button class="folder-action-btn mini" id="btn-hdr-newlink-${winId}" title="New Web Link">
                    <iconify-icon icon="fluent:link-add-24-filled" width="13" height="13" style="color: #00a2ed;"></iconify-icon>
                    <span>New Link</span>
                </button>
            </div>
            ` : ''}
        </div>
        <div class="folder-content-wrap" id="folder-wrap-${winId}">
    `;
    
    const children = folderItem.content || [];
    let visibleCount = 0;
    children.forEach((child, cIdx) => {
        // Restriction: Hidden for guest
        if (currentUser !== "admin" && child.hiddenForGuest) {
            return;
        }
        visibleCount++;
        let badgeHTML = "";
        if (currentUser === "admin" && child.hiddenForGuest) {
            badgeHTML = `<div class="hidden-for-guest-badge" title="Hidden for guest"><iconify-icon icon="fluent:eye-off-24-filled" width="13" height="13"></iconify-icon></div>`;
        }
        itemsHTML += `
            <div class="icon folder-child" data-idx="${cIdx}" id="item-${winId}-${cIdx}">
                ${badgeHTML}
                ${getIconHTML(child, "large")}
                <span>${escapeHTML(child.name)}</span>
            </div>
        `;
    });

    if (visibleCount === 0) {
        itemsHTML += `
            <div style="width: 100%; text-align: center; color: rgba(255,255,255,0.4); padding: 40px 10px; font-size: 13px;">
                This folder is empty.
            </div>
        `;
    }

    itemsHTML += `</div>`;

    // Bottom right corner upload bar strictly for Admin
    if (currentUser === "admin") {
        itemsHTML += `
            <div class="folder-bottom-bar">
                <button class="folder-action-btn primary folder-corner-upload-btn" id="btn-corner-upload-${winId}" title="${isMusic ? 'Add song via web stream link or file upload' : 'Upload file to folder'}">
                    <iconify-icon icon="${isMusic ? 'fluent:music-note-2-24-filled' : 'fluent:arrow-upload-24-filled'}" width="14" height="14"></iconify-icon>
                    <span>${isMusic ? 'Add Song (Link & Cover)' : 'Upload File'}</span>
                </button>
            </div>
        `;
    }

    const folderIcon = isMusic 
        ? `<iconify-icon icon="fluent:music-note-2-24-filled" width="18" height="18" style="color: #ff8c00"></iconify-icon>`
        : `<iconify-icon icon="fluent:folder-24-filled" width="18" height="18" style="color: #f8d45c"></iconify-icon>`;
    const win = openWindow(folderItem.name, itemsHTML, folderIcon, winId, "folder-window");
    win.folderItemRef = folderItem;
    win.setAttribute("data-folder-name", folderItem.name);

    // Bind item clicks
    const childEls = win.querySelectorAll(".folder-child");
    childEls.forEach(el => {
        const idx = parseInt(el.getAttribute("data-idx"), 10);
        const childItem = children[idx];
        el.addEventListener("click", () => handleItemClick(childItem));
    });

    // Bind header actions for Admin
    const hdrNewFolderBtn = win.querySelector(`#btn-hdr-newfolder-${winId}`);
    if (hdrNewFolderBtn) {
        hdrNewFolderBtn.addEventListener("click", async () => {
            const liveFolder = findFolderItem(folderItem.name) || folderItem;
            let defaultName = "New Folder";
            let counter = 2;
            while (liveFolder.content && liveFolder.content.some(item => item.name === defaultName)) {
                defaultName = `New Folder (${counter++})`;
            }
            const name = await winPrompt("Enter folder name:", defaultName, "Create Folder");
            if (name && name.trim()) {
                if (!liveFolder.content) liveFolder.content = [];
                liveFolder.content.push({ name: name.trim(), type: "folder", content: [] });
                saveDesktopData(currentDesktopData);
                openFolderWindow(liveFolder);
                showToast(`Created folder "${name.trim()}"`);
            }
        });
    }

    const hdrNewFileBtn = win.querySelector(`#btn-hdr-newfile-${winId}`);
    if (hdrNewFileBtn) {
        hdrNewFileBtn.addEventListener("click", async () => {
            const liveFolder = findFolderItem(folderItem.name) || folderItem;
            let defaultName = "New Document.txt";
            let counter = 2;
            while (liveFolder.content && liveFolder.content.some(item => item.name === defaultName)) {
                defaultName = `New Document (${counter++}).txt`;
            }
            let name = await winPrompt("Enter document name:", defaultName, "Create Text Document");
            if (name && name.trim()) {
                name = name.trim();
                if (!name.endsWith(".txt")) name += ".txt";
                if (!liveFolder.content) liveFolder.content = [];
                liveFolder.content.push({ name, type: "file" });
                fileContentMap[name] = "";
                saveDesktopData(currentDesktopData);
                openFolderWindow(liveFolder);
                openNotepad(name, "");
                showToast(`Created file "${name}"`);
            }
        });
    }

    const hdrNewLinkBtn = win.querySelector(`#btn-hdr-newlink-${winId}`);
    if (hdrNewLinkBtn) {
        hdrNewLinkBtn.addEventListener("click", () => {
            const liveFolder = findFolderItem(folderItem.name) || folderItem;
            showNewLinkDialog(liveFolder);
        });
    }

    const hdrAddSongBtn = win.querySelector(`#btn-hdr-addsong-${winId}`);
    if (hdrAddSongBtn) {
        hdrAddSongBtn.addEventListener("click", () => {
            const liveFolder = findFolderItem(folderItem.name) || folderItem;
            openMusicUploadModal(liveFolder);
        });
    }

    const hdrClearSongsBtn = win.querySelector(`#btn-hdr-clearsongs-${winId}`);
    if (hdrClearSongsBtn) {
        hdrClearSongsBtn.addEventListener("click", async () => {
            const ok = await winConfirm("Are you sure you want to delete ALL songs in the music folder? You can add your own songs from scratch.", "Clear All Songs", true);
            if (!ok) return;
            const liveFolder = findFolderItem(folderItem.name) || folderItem;
            liveFolder.content = [];
            currentMusicLibrary = [];
            currentTrackIndex = 0;
            audio.pause();
            audio.src = "";
            isPlaying = false;
            await saveDesktopData(currentDesktopData);
            await saveMusicLibrary([]);
            openFolderWindow(liveFolder);
            updateHDDUI();
            showToast("All songs deleted from library.");
        });
    }

    // Bind corner upload button for Admin
    const cornerUploadBtn = win.querySelector(`#btn-corner-upload-${winId}`);
    if (cornerUploadBtn) {
        cornerUploadBtn.addEventListener("click", () => {
            const liveFolder = findFolderItem(folderItem.name) || folderItem;
            currentTargetFolder = liveFolder;
            if (isMusic) {
                openMusicUploadModal(liveFolder);
            } else {
                const uploader = document.getElementById("folder-file-uploader");
                if (uploader) uploader.click();
            }
        });
    }
}

// --- Notepad with Save Capability ---
export function openNotepad(fileName = "text.txt", initialText = null) {
    const winId = `win-notepad-${fileName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const fileIcon = `<iconify-icon icon="fluent:document-24-filled" width="18" height="18" style="color: #e0e0e0"></iconify-icon>`;
    
    let content = initialText;
    
    // Check localStorage, but purge corrupted HTML fallback strings
    if (content === null) {
        const saved = localStorage.getItem(`file_${fileName}`);
        if (saved && (saved.trim().startsWith("<!DOCTYPE") || saved.trim().startsWith("<html"))) {
            localStorage.removeItem(`file_${fileName}`);
        } else {
            content = saved;
        }
    }
    
    // Check if the item exists in desktopData or any folder with explicit content
    if (content === null) {
        const desktopItem = currentDesktopData.find(d => d.name === fileName);
        if (desktopItem && typeof desktopItem.content === "string") {
            content = desktopItem.content;
        } else {
            currentDesktopData.forEach(folder => {
                if (folder.content && Array.isArray(folder.content)) {
                    const child = folder.content.find(c => c.name === fileName);
                    if (child && typeof child.content === "string") {
                        content = child.content;
                    }
                }
            });
        }
    }
    
    // Default content: text.txt gets ASCII welcome note, any other document starts clean and blank
    if (content === null) {
        if (fileName.toLowerCase() === "text.txt") {
            content = `  ___ ___ ___ _  _______ ___  _  _ ___ ___  ___  ___ _____ \n / __| _ \\_ _| |/ /_   _/ _ \\| \\| | __/ __|/ _ \\/ _ \\__  / \n \\__ \\  _/| || ' <  | || (_) | .\` | _|\\__ \\ (_) | (_) / /  \n |___/_| |___|_|\\_\\ |_| \\___/|_|\\_|___|___/\\___/\\___/_/     \n\n please report any bugs, really appreciate it\n\n More stuff coming soon :D\n`;
        } else {
            content = "";
        }
    }

    const isAdmin = currentUser === "admin";
    const saveBtnHTML = isAdmin ? `
        <button class="notepad-btn" id="btn-save-${winId}" title="Save file to virtual filesystem">
            <iconify-icon icon="fluent:save-24-filled" width="14" height="14"></iconify-icon>
            <span>Save</span>
        </button>
    ` : '';
    const statusText = isAdmin ? escapeHTML(fileName) : `${escapeHTML(fileName)} (Read-only)`;

    const bodyHTML = `
        <div class="notepad-bar">
            ${saveBtnHTML}
            <span class="notepad-status" id="status-${winId}">${statusText}</span>
        </div>
        <textarea class="notepad-textarea" id="text-${winId}" ${isAdmin ? '' : 'readonly'} spellcheck="false">${escapeHTML(content)}</textarea>
    `;
    
    const win = openWindow(fileName, bodyHTML, fileIcon, winId, "notepad-window");
    
    const saveBtn = win.querySelector(`#btn-save-${winId}`);
    const ta = win.querySelector(`#text-${winId}`);
    const statusEl = win.querySelector(`#status-${winId}`);
    
    if (saveBtn && ta) {
        saveBtn.addEventListener("click", () => {
            if (currentUser !== "admin") {
                showToast("Only SPIKETONES007 can save files.");
                return;
            }
            const updated = ta.value;
            fileContentMap[fileName] = updated;
            localStorage.setItem(`file_${fileName}`, updated);
            
            // Sync with currentDesktopData if file is on desktop or in folder
            const desktopItem = currentDesktopData.find(d => d.name === fileName);
            if (desktopItem) {
                desktopItem.content = updated;
            } else {
                currentDesktopData.forEach(folder => {
                    if (folder.content && Array.isArray(folder.content)) {
                        const child = folder.content.find(c => c.name === fileName);
                        if (child) child.content = updated;
                    }
                });
            }
            saveDesktopData(currentDesktopData);
            showToast(`Saved changes to "${fileName}"`);
            if (statusEl) {
                statusEl.textContent = "Saved ✓";
                setTimeout(() => { if (statusEl) statusEl.textContent = fileName; }, 1800);
            }
        });
    }

    // ONLY fetch from server if fileName is an explicit entry in fileContentMap starting with "files/"
    // (Never guess files/${fileName} which causes SPA HTML fallback on custom files like TESTING)
    const filePath = fileContentMap[fileName];
    if (filePath && typeof filePath === "string" && filePath.startsWith("files/") && !localStorage.getItem(`file_${fileName}`) && initialText === null) {
        fetch(filePath)
            .then(res => {
                if (!res.ok) return null;
                const cType = res.headers.get("content-type") || "";
                if (cType.includes("text/html")) return null; // Reject SPA HTML fallback!
                return res.text();
            })
            .then(txt => {
                if (txt && ta && !localStorage.getItem(`file_${fileName}`)) {
                    if (!txt.trim().startsWith("<!DOCTYPE") && !txt.trim().startsWith("<html")) {
                        ta.value = txt;
                    }
                }
            })
            .catch(() => {});
    }
}

// --- Image Viewer Window ---
export function openImageViewer(imageItem) {
    const winId = `win-img-${imageItem.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const imgIcon = `<iconify-icon icon="fluent:image-24-filled" width="18" height="18" style="color: #00a2ed"></iconify-icon>`;
    const bodyHTML = `
        <div style="display: flex; flex-direction: column; height: 100%; gap: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 4px;">
                <span style="font-size: 12px; color: rgba(255,255,255,0.7);">${escapeHTML(imageItem.name)}</span>
                <button class="folder-action-btn primary" id="btn-set-wp-${winId}">🖼️ Set as Wallpaper</button>
            </div>
            <div style="flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; background: rgba(0,0,0,0.5); border-radius: 8px;">
                <img src="${imageItem.src}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
            </div>
        </div>
    `;
    const win = openWindow(imageItem.name, bodyHTML, imgIcon, winId);
    win.style.width = "480px";
    win.style.height = "380px";
    
    const setWpBtn = win.querySelector(`#btn-set-wp-${winId}`);
    if (setWpBtn) {
        setWpBtn.addEventListener("click", () => {
            currentWallpaper = imageItem.src;
            document.body.style.backgroundImage = `url('${currentWallpaper}')`;
            saveWallpaper(currentWallpaper);
            showToast("Desktop wallpaper updated!");
        });
    }
}

// --- Interactive Apps: Calculator, Paint, Terminal, Snake ---
export function openCalculator() {
    const winId = "win-calculator";
    const calcIcon = `<iconify-icon icon="fluent:calculator-24-filled" width="18" height="18" style="color: #00a2ed"></iconify-icon>`;
    const bodyHTML = `
        <div class="calc-container">
            <div class="calc-display" id="calc-display">0</div>
            <div class="calc-grid">
                <button class="calc-btn op" data-val="C">C</button>
                <button class="calc-btn op" data-val="+/-">±</button>
                <button class="calc-btn op" data-val="%">%</button>
                <button class="calc-btn op" data-val="/">÷</button>
                
                <button class="calc-btn" data-val="7">7</button>
                <button class="calc-btn" data-val="8">8</button>
                <button class="calc-btn" data-val="9">9</button>
                <button class="calc-btn op" data-val="*">×</button>
                
                <button class="calc-btn" data-val="4">4</button>
                <button class="calc-btn" data-val="5">5</button>
                <button class="calc-btn" data-val="6">6</button>
                <button class="calc-btn op" data-val="-">−</button>
                
                <button class="calc-btn" data-val="1">1</button>
                <button class="calc-btn" data-val="2">2</button>
                <button class="calc-btn" data-val="3">3</button>
                <button class="calc-btn op" data-val="+">+</button>
                
                <button class="calc-btn" data-val="0" style="grid-column: span 2;">0</button>
                <button class="calc-btn" data-val=".">.</button>
                <button class="calc-btn eq" data-val="=">=</button>
            </div>
        </div>
    `;
    const win = openWindow("Calculator", bodyHTML, calcIcon, winId, "calc-window");
    
    let expr = "0";
    const display = win.querySelector("#calc-display");
    
    win.querySelectorAll(".calc-btn").forEach(b => {
        b.addEventListener("click", () => {
            const val = b.getAttribute("data-val");
            if (val === "C") {
                expr = "0";
            } else if (val === "=") {
                try {
                    const sanitized = expr.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
                    expr = String(Function(`"use strict"; return (${sanitized})`)());
                } catch (e) {
                    expr = "Error";
                }
            } else if (val === "+/-") {
                if (expr.startsWith("-")) expr = expr.slice(1);
                else if (expr !== "0") expr = "-" + expr;
            } else if (val === "%") {
                expr = String(parseFloat(expr) / 100);
            } else {
                if (expr === "0" || expr === "Error") expr = val;
                else expr += val;
            }
            if (display) display.textContent = expr;
        });
    });
}

export function openPaint() {
    const winId = "win-paint";
    const paintIcon = `<iconify-icon icon="fluent:paint-brush-24-filled" width="18" height="18" style="color: #e056fd"></iconify-icon>`;
    const bodyHTML = `
        <div class="paint-container">
            <div class="paint-toolbar">
                <div class="paint-palette">
                    <input type="color" id="paint-color" class="paint-color-picker" value="#ff8c00" title="Custom color picker" />
                    <button type="button" class="paint-swatch" data-color="#000000" style="background:#000000;" title="Black"></button>
                    <button type="button" class="paint-swatch" data-color="#ffffff" style="background:#ffffff;" title="White"></button>
                    <button type="button" class="paint-swatch active" data-color="#ff8c00" style="background:#ff8c00;" title="Orange"></button>
                    <button type="button" class="paint-swatch" data-color="#e84118" style="background:#e84118;" title="Red"></button>
                    <button type="button" class="paint-swatch" data-color="#4cd137" style="background:#4cd137;" title="Green"></button>
                    <button type="button" class="paint-swatch" data-color="#00a8ff" style="background:#00a8ff;" title="Blue"></button>
                    <button type="button" class="paint-swatch" data-color="#9c88ff" style="background:#9c88ff;" title="Purple"></button>
                    <button type="button" class="paint-swatch" data-color="#fbc531" style="background:#fbc531;" title="Yellow"></button>
                </div>
                <label style="font-size:12px; display:flex; align-items:center; gap:6px; color:#ffffff; margin-left: 4px;">
                    <span>Size:</span>
                    <input type="range" id="paint-size" min="1" max="36" value="4" style="width:70px; cursor:pointer;" />
                    <span id="paint-size-label" style="font-size:11px; opacity:0.8; width:24px;">4px</span>
                </label>
                <div style="flex:1;"></div>
                <button type="button" class="paint-tool-btn" id="paint-eraser">🧹 Eraser</button>
                <button type="button" class="paint-tool-btn" id="paint-clear">🗑️ Clear</button>
                <button type="button" class="paint-tool-btn primary" id="paint-save">💾 Save Image</button>
            </div>
            <div class="paint-canvas-wrap">
                <canvas class="paint-canvas" id="paint-canvas" width="600" height="400"></canvas>
            </div>
        </div>
    `;
    const win = openWindow("Paint", bodyHTML, paintIcon, winId, "paint-window");
    
    const canvas = win.querySelector("#paint-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    let drawing = false;
    let color = "#ff8c00";
    let size = 4;
    let isEraser = false;
    
    const colorInput = win.querySelector("#paint-color");
    const sizeInput = win.querySelector("#paint-size");
    const sizeLabel = win.querySelector("#paint-size-label");
    const eraserBtn = win.querySelector("#paint-eraser");
    const clearBtn = win.querySelector("#paint-clear");
    const saveBtn = win.querySelector("#paint-save");
    const swatches = win.querySelectorAll(".paint-swatch");

    const updateActiveColor = (newColor) => {
        color = newColor;
        isEraser = false;
        if (eraserBtn) eraserBtn.classList.remove("active");
        if (colorInput) colorInput.value = newColor;
        swatches.forEach(sw => {
            if (sw.getAttribute("data-color").toLowerCase() === newColor.toLowerCase()) {
                sw.classList.add("active");
            } else {
                sw.classList.remove("active");
            }
        });
    };
    
    if (colorInput) {
        colorInput.addEventListener("input", (e) => {
            updateActiveColor(e.target.value);
        });
    }

    swatches.forEach(sw => {
        sw.addEventListener("click", () => {
            updateActiveColor(sw.getAttribute("data-color"));
        });
    });
    
    if (sizeInput) {
        sizeInput.addEventListener("input", (e) => {
            size = parseInt(e.target.value, 10) || 4;
            if (sizeLabel) sizeLabel.textContent = `${size}px`;
        });
    }

    if (eraserBtn) {
        eraserBtn.addEventListener("click", () => {
            isEraser = !isEraser;
            eraserBtn.classList.toggle("active", isEraser);
            if (isEraser) {
                swatches.forEach(sw => sw.classList.remove("active"));
            } else {
                updateActiveColor(color);
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener("click", () => {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            showToast("Canvas cleared");
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener("click", () => {
            const dataUrl = canvas.toDataURL("image/png");
            const link = document.createElement("a");
            link.download = `paint-artwork-${Date.now().toString().slice(-4)}.png`;
            link.href = dataUrl;
            document.body.appendChild(link);
            link.click();
            link.remove();
            showToast("🎨 Drawing downloaded successfully!");
        });
    }
    
    const getPos = (e) => {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
        const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY
        };
    };
    
    const startDraw = (e) => {
        drawing = true;
        const pos = getPos(e);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
    };

    const moveDraw = (e) => {
        if (!drawing) return;
        const pos = getPos(e);
        ctx.strokeStyle = isEraser ? "#ffffff" : color;
        ctx.lineWidth = size;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
    };

    const stopDraw = () => {
        drawing = false;
    };
    
    canvas.addEventListener("mousedown", startDraw);
    canvas.addEventListener("mousemove", moveDraw);
    canvas.addEventListener("mouseup", stopDraw);
    canvas.addEventListener("mouseleave", stopDraw);

    // Touch events for tablet/mobile
    canvas.addEventListener("touchstart", (e) => {
        e.preventDefault();
        startDraw(e);
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
        e.preventDefault();
        moveDraw(e);
    }, { passive: false });

    canvas.addEventListener("touchend", stopDraw);
    canvas.addEventListener("touchcancel", stopDraw);
}

export function openTerminal() {
    const winId = "win-terminal";
    const termIcon = `<iconify-icon icon="fluent:window-console-20-filled" width="18" height="18" style="color: #2ed573"></iconify-icon>`;
    const bodyHTML = `
        <div class="term-container">
            <div class="term-output" id="term-output">SPIKETONES007 OS [Version 10.0.22621]
(c) 2026 SPIKETONES Corporation. All rights reserved.

Type 'help' for a list of available commands.
</div>
            <div class="term-input-row">
                <span class="term-prompt">C:\\Users\\SPIKETONES&gt;</span>
                <input type="text" class="term-input" id="term-input" autofocus spellcheck="false" autocomplete="off" />
            </div>
        </div>
    `;
    const win = openWindow("Terminal", bodyHTML, termIcon, winId, "term-window");
    
    const input = win.querySelector("#term-input");
    const output = win.querySelector("#term-output");
    
    if (input && output) {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                const cmd = input.value.trim();
                input.value = "";
                output.textContent += `C:\\Users\\SPIKETONES> ${cmd}\n`;
                
                const parts = cmd.split(" ");
                const base = parts[0].toLowerCase();
                const arg = parts.slice(1).join(" ");
                
                const modifyingCommands = ["mkdir", "touch", "rm", "del", "rmdir"];
                if (modifyingCommands.includes(base) && currentUser !== "admin") {
                    output.textContent += `Access Denied: Administrator privileges (SPIKETONES007) required for '${base}'.\nGuest mode is strictly read-only.\n\n`;
                    const cont = win.querySelector(".term-container");
                    if (cont) cont.scrollTop = cont.scrollHeight;
                    return;
                }

                if (base === "help") {
                    output.textContent += `Available commands:\n  help        - List commands\n  ls / dir    - List desktop items\n  cat <file>  - View file content\n  mkdir <dir> - Create folder (Admin only)\n  touch <file>- Create file (Admin only)\n  rm <item>   - Remove item (Admin only)\n  whoami      - Current user identity\n  date        - Current system timestamp\n  clear / cls - Clear terminal output\n  neofetch    - Show system specs\n  exit        - Close terminal\n\n`;
                } else if (base === "ls" || base === "dir") {
                    const names = currentDesktopData.map(d => `[${d.type.toUpperCase()}] ${d.name}`).join("\n");
                    output.textContent += `${names}\n\n`;
                } else if (base === "whoami") {
                    output.textContent += `User: ${currentUser === "admin" ? "SPIKETONES007" : "Guest"} | Mode: ${currentUser === "admin" ? "Full Administrator" : "Read-Only Visitor"}\n\n`;
                } else if (base === "date") {
                    output.textContent += `${new Date().toString()}\n\n`;
                } else if (base === "clear" || base === "cls") {
                    output.textContent = "";
                } else if (base === "neofetch") {
                    output.textContent += `
      ___          OS: SPIKETONES007 OS x86_64
     /   \\         Host: WebBrowser Container
    / /| |         Kernel: 6.8.0-virtual
   / / | |         Uptime: 2 days, 4 hours
  /_/  |_|         Shell: spike-sh 2.1
                   Resolution: 1920x1080
                   WM: Fluent Mica Acrylic
                   Terminal: Spiketerm 1.0
                   CPU: Virtual Octa-Core @ 3.4GHz
                   Memory: 2048MB / 8192MB
\n`;
                } else if (base === "cat") {
                    if (!arg) {
                        output.textContent += "Usage: cat <filename>\n\n";
                    } else {
                        const content = localStorage.getItem(`file_${arg}`) || fileContentMap[arg] || "File not found.";
                        output.textContent += `${content}\n\n`;
                    }
                } else if (base === "mkdir") {
                    if (!arg) {
                        output.textContent += "Usage: mkdir <folder_name>\n\n";
                    } else {
                        currentDesktopData.push({ name: arg, type: "folder", content: [] });
                        saveDesktopData(currentDesktopData);
                        renderDesktop();
                        output.textContent += `Created folder '${arg}' on desktop.\n\n`;
                    }
                } else if (base === "touch") {
                    if (!arg) {
                        output.textContent += "Usage: touch <filename>\n\n";
                    } else {
                        currentDesktopData.push({ name: arg, type: "file" });
                        fileContentMap[arg] = "";
                        saveDesktopData(currentDesktopData);
                        renderDesktop();
                        output.textContent += `Created file '${arg}' on desktop.\n\n`;
                    }
                } else if (base === "rm" || base === "del") {
                    if (!arg) {
                        output.textContent += "Usage: rm <item_name>\n\n";
                    } else {
                        const idx = currentDesktopData.findIndex(d => d.name.toLowerCase() === arg.toLowerCase());
                        if (idx !== -1) {
                            const [removed] = currentDesktopData.splice(idx, 1);
                            saveDesktopData(currentDesktopData);
                            renderDesktop();
                            output.textContent += `Removed '${removed.name}' from desktop.\n\n`;
                        } else {
                            output.textContent += `Item '${arg}' not found on desktop.\n\n`;
                        }
                    }
                } else if (base === "exit") {
                    win.remove();
                    activeWindows = activeWindows.filter(w => w.id !== winId);
                    updateTaskbar();
                    return;
                } else if (cmd) {
                    output.textContent += `'${cmd}' is not recognized as an internal or external command.\n\n`;
                }
                
                const cont = win.querySelector(".term-container");
                if (cont) cont.scrollTop = cont.scrollHeight;
            }
        });
    }
}

export function openSnake() {
    const winId = "win-snake";
    const snakeIcon = `<iconify-icon icon="fluent:games-24-filled" width="18" height="18" style="color: #ffa502"></iconify-icon>`;
    const bodyHTML = `
        <div class="snake-container">
            <div class="snake-header">
                <div>Score: <span id="snake-score" style="color:#ff8c00; font-weight:bold;">0</span></div>
                <button class="folder-action-btn primary" id="snake-start-btn">Start Game</button>
            </div>
            <canvas class="snake-canvas" id="snake-canvas" width="340" height="340"></canvas>
            <div style="font-size:11px; color:rgba(255,255,255,0.45); text-align:center;">
                Use Arrow Keys or W A S D to control snake
            </div>
        </div>
    `;
    const win = openWindow("Snake Game", bodyHTML, snakeIcon, winId, "snake-window");
    
    const canvas = win.querySelector("#snake-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const scoreEl = win.querySelector("#snake-score");
    const startBtn = win.querySelector("#snake-start-btn");
    
    const grid = 17;
    let snake = [{ x: 8 * grid, y: 8 * grid }];
    let dx = grid;
    let dy = 0;
    let food = { x: 4 * grid, y: 4 * grid };
    let score = 0;
    let gameLoop = null;
    
    function resetGame() {
        snake = [{ x: 8 * grid, y: 8 * grid }];
        dx = grid;
        dy = 0;
        score = 0;
        if (scoreEl) scoreEl.textContent = "0";
        spawnFood();
    }
    
    function spawnFood() {
        food = {
            x: Math.floor(Math.random() * (canvas.width / grid)) * grid,
            y: Math.floor(Math.random() * (canvas.height / grid)) * grid
        };
    }
    
    function update() {
        const head = { x: snake[0].x + dx, y: snake[0].y + dy };
        
        // Wall collision wrap
        if (head.x < 0) head.x = canvas.width - grid;
        else if (head.x >= canvas.width) head.x = 0;
        if (head.y < 0) head.y = canvas.height - grid;
        else if (head.y >= canvas.height) head.y = 0;
        
        // Self collision
        for (let i = 1; i < snake.length; i++) {
            if (head.x === snake[i].x && head.y === snake[i].y) {
                clearInterval(gameLoop);
                gameLoop = null;
                if (startBtn) startBtn.textContent = "Game Over - Restart";
                return;
            }
        }
        
        snake.unshift(head);
        
        // Eat food
        if (head.x === food.x && head.y === food.y) {
            score += 10;
            if (scoreEl) scoreEl.textContent = score;
            spawnFood();
        } else {
            snake.pop();
        }
        
        // Draw
        ctx.fillStyle = "#0c0b0a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Food
        ctx.fillStyle = "#ff4757";
        ctx.fillRect(food.x + 2, food.y + 2, grid - 4, grid - 4);
        
        // Snake
        snake.forEach((part, index) => {
            ctx.fillStyle = index === 0 ? "#ffa502" : "#2ed573";
            ctx.fillRect(part.x + 1, part.y + 1, grid - 2, grid - 2);
        });
    }
    
    if (startBtn) {
        startBtn.addEventListener("click", () => {
            if (gameLoop) clearInterval(gameLoop);
            resetGame();
            startBtn.textContent = "Playing...";
            gameLoop = setInterval(update, 110);
        });
    }
    
    const onKey = (e) => {
        if (!win.isConnected) {
            document.removeEventListener("keydown", onKey);
            if (gameLoop) clearInterval(gameLoop);
            return;
        }
        if ((e.key === "ArrowUp" || e.key === "w" || e.key === "W") && dy === 0) {
            dx = 0; dy = -grid; e.preventDefault();
        } else if ((e.key === "ArrowDown" || e.key === "s" || e.key === "S") && dy === 0) {
            dx = 0; dy = grid; e.preventDefault();
        } else if ((e.key === "ArrowLeft" || e.key === "a" || e.key === "A") && dx === 0) {
            dx = -grid; dy = 0; e.preventDefault();
        } else if ((e.key === "ArrowRight" || e.key === "d" || e.key === "D") && dx === 0) {
            dx = grid; dy = 0; e.preventDefault();
        }
    };
    document.addEventListener("keydown", onKey);
    
    // Draw initial board
    ctx.fillStyle = "#0c0b0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffa502";
    ctx.fillRect(8 * grid, 8 * grid, grid - 2, grid - 2);
}

// --- Guestbook (Regular Visitor) ---
function formatGuestbookDate(msg) {
    if (typeof msg === 'object' && msg.date_label) return msg.date_label;
    const iso = typeof msg === 'object' ? msg.created_at : msg;
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "Recent";
        const month = d.toLocaleString("en-US", { month: "short" });
        const day = d.getDate();
        let hours = d.getHours();
        const minutes = String(d.getMinutes()).padStart(2, "0");
        const ampm = hours >= 12 ? "PM" : "AM";
        hours = hours % 12 || 12;
        const hoursStr = hours < 10 ? `0${hours}` : `${hours}`;
        return `${month} ${day}, ${hoursStr}:${minutes} ${ampm}`;
    } catch (e) {
        return "Recent";
    }
}

export function openGuestbook() {
    const winId = "win-guestbook";
    const existing = document.getElementById(winId);
    if (existing) {
        existing.classList.remove("minimized");
        bringToFront(existing);
        updateTaskbar();
        return;
    }

    const gbIcon = `<svg width="19" height="19" viewBox="0 0 24 24" fill="#c85627" style="display:inline-block; vertical-align:middle; flex-shrink: 0;"><path d="M4 3h16a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7.5l-4.2 3.8A1 1 0 0 1 1.6 22V6a3 3 0 0 1 3-3zm3 5a1 1 0 0 0 0 2h10a1 1 0 1 0 0-2H7zm0 4a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2H7z"/></svg>`;
    const contentHTML = `
        <div class="guestbook-container">
            <div class="guestbook-messages" id="gb-messages-list">
                <div style="font-size: 12px; color: rgba(255,255,255,0.4); text-align: center; padding: 16px;">Loading notes...</div>
            </div>
            <form class="guestbook-form" id="guestbook-form">
                <div class="guestbook-input-row">
                    <input type="text" id="gb-author-input" class="guestbook-input name" placeholder="Name" maxlength="20" autocomplete="off" />
                    <input type="text" id="gb-msg-input" class="guestbook-input message" placeholder="Leave a note..." maxlength="150" autocomplete="off" required />
                    <button type="submit" id="gb-post-btn" class="guestbook-btn">Post</button>
                </div>
            </form>
        </div>
    `;

    openWindow("Guestbook", contentHTML, gbIcon, winId, "guestbook-panel");

    const renderMessages = (messages) => {
        activeGuestbookRender = renderMessages;
        const list = document.getElementById("gb-messages-list");
        if (!list) return;
        list.innerHTML = "";
        messages.forEach((msg) => {
            const card = document.createElement("div");
            card.className = "guestbook-message";
            card.setAttribute("data-id", msg.id || "");

            let deleteBtnHTML = "";
            if (currentUser === "admin" && msg.id) {
                deleteBtnHTML = `<button class="gb-delete-btn" data-id="${msg.id}" title="Delete comment as Admin">✕</button>`;
            }

            card.innerHTML = `
                <div class="guestbook-meta">
                    <div class="guestbook-meta-left">
                        <span class="guestbook-author">${escapeHTML(msg.author || 'Anonymous')}</span>
                        <span class="guestbook-date">${formatGuestbookDate(msg)}</span>
                    </div>
                    ${deleteBtnHTML}
                </div>
                <div class="guestbook-text">${escapeHTML(msg.message || '')}</div>
            `;

            if (currentUser === "admin" && msg.id) {
                const delBtn = card.querySelector(".gb-delete-btn");
                if (delBtn) {
                    delBtn.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        if (currentUser !== "admin") return;
                        if (confirm("Delete this guestbook comment?")) {
                            await deleteGuestbookMessage(msg.id);
                            showToast("Comment deleted");
                            const updated = await fetchGuestbook();
                            renderMessages(updated);
                        }
                    });
                }
            }

            list.appendChild(card);
        });
        list.scrollTop = list.scrollHeight;
    };

    // Initial fetch from Firestore (or localStorage fallback)
    fetchGuestbook().then(renderMessages);

    // Live subscription for incoming messages
    subscribeGuestbook((newMsg) => {
        const list = document.getElementById("gb-messages-list");
        if (!list) return;
        
        // Prevent duplicate rendering
        const existingCard = list.querySelector(`[data-id="${newMsg.id}"]`);
        if (existingCard) return;

        const card = document.createElement("div");
        card.className = "guestbook-message";
        card.setAttribute("data-id", newMsg.id || "");

        let deleteBtnHTML = "";
        if (currentUser === "admin" && newMsg.id) {
            deleteBtnHTML = `<button class="gb-delete-btn" data-id="${newMsg.id}" title="Delete comment as Admin">✕</button>`;
        }

        card.innerHTML = `
            <div class="guestbook-meta">
                <span class="guestbook-author">${escapeHTML(newMsg.author || 'Anonymous')}</span>
                <span class="guestbook-date">${formatGuestbookDate(newMsg)}</span>
                ${deleteBtnHTML}
            </div>
            <div class="guestbook-text">${escapeHTML(newMsg.message || '')}</div>
        `;

        if (currentUser === "admin" && newMsg.id) {
            const delBtn = card.querySelector(".gb-delete-btn");
            if (delBtn) {
                delBtn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    if (confirm("Delete this guestbook comment?")) {
                        await deleteGuestbookMessage(newMsg.id);
                        showToast("Comment deleted");
                        const updated = await fetchGuestbook();
                        renderMessages(updated);
                    }
                });
            }
        }

        list.appendChild(card);
        list.scrollTop = list.scrollHeight;
    });

    const form = document.getElementById("guestbook-form");
    if (form) {
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const authorInput = document.getElementById("gb-author-input");
            const msgInput = document.getElementById("gb-msg-input");
            const postBtn = document.getElementById("gb-post-btn");
            if (!msgInput || !msgInput.value.trim()) return;

            const author = (authorInput && authorInput.value.trim()) || "Anonymous";
            const text = msgInput.value.trim();

            postBtn.disabled = true;
            postBtn.textContent = "...";

            const saved = await insertGuestbook(author, text);
            if (saved) {
                msgInput.value = "";
                const messages = await fetchGuestbook();
                renderMessages(messages);
            }
            postBtn.disabled = false;
            postBtn.textContent = "Post";
        });
    }
}

// ==========================================================================
// GMAIL-STYLE MAIL APPLICATION (OFFICIAL GMAIL EXPERIENCE)
// ==========================================================================
export function showGmailSnackbar({ senderId, subject, message, targetEmail = 'joshjaison2020@gmail.com' }) {
    const existing = document.getElementById("gmail-global-snackbar");
    if (existing) existing.remove();

    const snack = document.createElement("div");
    snack.id = "gmail-global-snackbar";
    snack.className = "gmail-snackbar";

    const mailto = `mailto:${targetEmail}?subject=${encodeURIComponent(subject || 'Message from Portfolio')}&body=${encodeURIComponent(`Sender ID: ${senderId}\n\n${message}`)}`;

    snack.innerHTML = `
        <span>Message sent to <strong>${targetEmail}</strong></span>
        <a href="${mailto}" class="gmail-snackbar-link" title="Open in your default email application">Open in Email App ↗</a>
        <button type="button" class="gmail-aux-btn" style="color: #fff; margin-left: 8px; font-size: 13px; padding: 2px 6px;">✕</button>
    `;

    const closeBtn = snack.querySelector("button");
    if (closeBtn) closeBtn.onclick = () => snack.remove();

    document.body.appendChild(snack);
    setTimeout(() => {
        if (document.body.contains(snack)) snack.remove();
    }, 8000);
}

export function openMailApp(prefill = null) {
    const winId = "win-mail-app";
    const existing = document.getElementById(winId);
    if (existing) {
        existing.classList.remove("minimized");
        bringToFront(existing);
        updateTaskbar();
        if (prefill) {
            const subj = existing.querySelector("#gmail-subject-input");
            const body = existing.querySelector("#gmail-body-input");
            const sender = existing.querySelector("#gmail-sender-input");
            if (subj && prefill.subject) subj.value = prefill.subject;
            if (body && prefill.body) body.value = prefill.body;
            if (sender && prefill.senderId) sender.value = prefill.senderId;
        }
        return existing;
    }

    const gmailIcon = `<svg width="20" height="20" viewBox="0 0 48 48" fill="none" style="display:inline-block; vertical-align:middle; flex-shrink: 0;">
        <path fill="#4caf50" d="M42,16.2l-5,2.75l-5,4.75L32,38h7c1.657,0,3-1.343,3-3V16.2z"></path>
        <path fill="#1e88e5" d="M6,16.2l3.614,1.71L16,23.7V38H9c-1.657,0-3-1.343-3-3V16.2z"></path>
        <polygon fill="#e53935" points="32,11.2 24,18.45 16,11.2 15,16.5 16,23.7 24,30.95 32,23.7 33,16.5"></polygon>
        <path fill="#c62828" d="M6,12.3V16.2l10,7.5V11.2L12.876,8.859C11.132,7.553,8.642,8.026,7.475,9.873 C6.535,11.36,6.486,11.834,6,12.3z"></path>
        <path fill="#fbc02d" d="M42,12.3V16.2l-10,7.5V11.2l3.124-2.341c1.744-1.307,4.234-0.834,5.401,1.014 C41.465,11.36,41.514,11.834,42,12.3z"></path>
    </svg>`;

    const contentHTML = `
        <!-- Compose View -->
        <div class="gmail-compose-wrap" id="gmail-compose-view">
            <!-- Recipients (To) -->
            <div class="gmail-row">
                <span class="gmail-lbl">To</span>
                <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                    <div class="gmail-to-chip" title="Direct destination to Josh">
                        <span class="gmail-to-avatar">J</span>
                        <span>Josh</span>
                        <span class="gmail-to-email">&lt;joshjaison2020@gmail.com&gt;</span>
                    </div>
                </div>
                <div style="display: flex; gap: 4px;">
                    <button type="button" class="gmail-aux-btn" id="gmail-toggle-cc">Cc</button>
                    <button type="button" class="gmail-aux-btn" id="gmail-toggle-bcc">Bcc</button>
                </div>
            </div>

            <!-- Optional Cc Row -->
            <div class="gmail-row" id="gmail-row-cc" style="display: none;">
                <span class="gmail-lbl">Cc</span>
                <input type="text" id="gmail-cc-input" class="gmail-input" placeholder="Cc recipients" />
            </div>

            <!-- Optional Bcc Row -->
            <div class="gmail-row" id="gmail-row-bcc" style="display: none;">
                <span class="gmail-lbl">Bcc</span>
                <input type="text" id="gmail-bcc-input" class="gmail-input" placeholder="Bcc recipients" />
            </div>

            <!-- Sender ID / Your Email -->
            <div class="gmail-row">
                <span class="gmail-lbl">From</span>
                <input type="text" id="gmail-sender-input" class="gmail-input" placeholder="Your email or sender ID (e.g. name@gmail.com or Discord tag)" value="${prefill?.senderId || ''}" required />
            </div>

            <!-- Subject -->
            <div class="gmail-row">
                <span class="gmail-lbl">Subject</span>
                <input type="text" id="gmail-subject-input" class="gmail-input" placeholder="Subject" value="${prefill?.subject || ''}" />
            </div>

            <!-- Message Body -->
            <div class="gmail-textarea-wrap">
                <textarea id="gmail-body-input" class="gmail-textarea" placeholder="Write your message here...">${prefill?.body || ''}</textarea>
            </div>

            <!-- Gmail Bottom Toolbar matching native Google Web client -->
            <div class="gmail-bottom-bar">
                <div class="gmail-actions-left">
                    <div class="gmail-send-group">
                        <button type="button" class="gmail-send-btn" id="gmail-send-action-btn">
                            <span>Send</span>
                            <iconify-icon icon="fluent:chevron-down-12-regular"></iconify-icon>
                        </button>
                    </div>

                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-format" title="Formatting options">
                        <iconify-icon icon="fluent:text-font-20-regular" width="18" height="18"></iconify-icon>
                    </button>
                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-sparkle" title="Help me write (AI Polish)">
                        <iconify-icon icon="fluent:sparkle-20-filled" width="18" height="18" style="color: #1a73e8;"></iconify-icon>
                    </button>
                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-attach" title="Attach files">
                        <iconify-icon icon="fluent:attach-20-regular" width="18" height="18"></iconify-icon>
                    </button>
                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-link" title="Insert link">
                        <iconify-icon icon="fluent:link-20-regular" width="18" height="18"></iconify-icon>
                    </button>
                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-emoji" title="Insert emoji">
                        <iconify-icon icon="fluent:emoji-20-regular" width="18" height="18"></iconify-icon>
                    </button>
                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-drive" title="Insert files using Drive">
                        <iconify-icon icon="logos:google-drive" width="16" height="16"></iconify-icon>
                    </button>
                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-photo" title="Insert photo">
                        <iconify-icon icon="fluent:image-20-regular" width="18" height="18"></iconify-icon>
                    </button>
                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-lock" title="Toggle confidential mode">
                        <iconify-icon icon="fluent:lock-shield-20-regular" width="18" height="18"></iconify-icon>
                    </button>
                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-pen" title="Insert signature">
                        <iconify-icon icon="fluent:signature-20-regular" width="18" height="18"></iconify-icon>
                    </button>
                    <button type="button" class="gmail-tool-icon-btn" id="gmail-tool-more" title="More options">
                        <iconify-icon icon="fluent:more-vertical-20-regular" width="18" height="18"></iconify-icon>
                    </button>
                </div>

                <div class="gmail-actions-right">
                    <button type="button" class="gmail-discard-btn" id="gmail-discard-btn" title="Discard draft">
                        <iconify-icon icon="fluent:delete-20-regular" width="18" height="18"></iconify-icon>
                    </button>
                </div>
            </div>
        </div>
    `;

    const win = openWindow("Gmail - New Message", contentHTML, gmailIcon, winId, "mail-window");
    if (!win) return;

    attachMailAppEvents(win);
    return win;
}

function attachMailAppEvents(win) {
    const senderInput = win.querySelector("#gmail-sender-input");
    const subjectInput = win.querySelector("#gmail-subject-input");
    const bodyInput = win.querySelector("#gmail-body-input");
    const sendBtn = win.querySelector("#gmail-send-action-btn");
    const discardBtn = win.querySelector("#gmail-discard-btn");
    const ccInput = win.querySelector("#gmail-cc-input");
    const bccInput = win.querySelector("#gmail-bcc-input");

    // Optional Cc/Bcc toggles
    const toggleCc = win.querySelector("#gmail-toggle-cc");
    const toggleBcc = win.querySelector("#gmail-toggle-bcc");
    const rowCc = win.querySelector("#gmail-row-cc");
    const rowBcc = win.querySelector("#gmail-row-bcc");

    if (toggleCc && rowCc) {
        toggleCc.addEventListener("click", () => {
            rowCc.style.display = rowCc.style.display === "none" ? "flex" : "none";
            if (rowCc.style.display === "flex" && ccInput) ccInput.focus();
        });
    }

    if (toggleBcc && rowBcc) {
        toggleBcc.addEventListener("click", () => {
            rowBcc.style.display = rowBcc.style.display === "none" ? "flex" : "none";
            if (rowBcc.style.display === "flex" && bccInput) bccInput.focus();
        });
    }

    // AI polish / Help me write
    const sparkleBtn = win.querySelector("#gmail-tool-sparkle");
    if (sparkleBtn && bodyInput) {
        sparkleBtn.addEventListener("click", () => {
            const current = bodyInput.value.trim();
            if (!current) {
                bodyInput.value = "Hi Josh,\n\nI was checking out your website and CS2 profile! I wanted to reach out regarding:\n\n\nBest regards,\n";
                if (subjectInput && !subjectInput.value.trim()) {
                    subjectInput.value = "Connecting from your website portfolio";
                }
                showToast("Template inserted! Fill in your message.");
            } else {
                bodyInput.value = `Hi Josh,\n\n${current}\n\nBest regards,`;
                showToast("Message formatted with greetings & sign-off.");
            }
            bodyInput.focus();
        });
    }

    // Emoji tool
    const emojiBtn = win.querySelector("#gmail-tool-emoji");
    if (emojiBtn && bodyInput) {
        emojiBtn.addEventListener("click", () => {
            bodyInput.value += " 🎯✉️";
            bodyInput.focus();
        });
    }

    // Send action: sends directly to joshjaison2020@gmail.com
    if (sendBtn) {
        sendBtn.addEventListener("click", () => {
            const senderId = (senderInput && senderInput.value.trim()) || "";
            const subject = (subjectInput && subjectInput.value.trim()) || "Message from Portfolio";
            const message = (bodyInput && bodyInput.value.trim()) || "";
            const ccVal = (ccInput && ccInput.value.trim()) || "";
            const bccVal = (bccInput && bccInput.value.trim()) || "";

            if (!senderId) {
                showToast("Please enter your Email or Sender ID");
                if (senderInput) senderInput.focus();
                return;
            }
            if (!message) {
                showToast("Please enter a message before sending");
                if (bodyInput) bodyInput.focus();
                return;
            }

            sendBtn.disabled = true;
            sendBtn.innerHTML = `<span>Sending...</span>`;

            const targetEmail = "joshjaison2020@gmail.com";
            const formattedBody = `From: ${senderId}\n\nMessage:\n${message}\n\n---\nSent directly to Josh via Web OS Mail`;

            // Prepare mailto URL
            let mailtoUrl = `mailto:${targetEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(formattedBody)}`;
            if (ccVal) mailtoUrl += `&cc=${encodeURIComponent(ccVal)}`;
            if (bccVal) mailtoUrl += `&bcc=${encodeURIComponent(bccVal)}`;

            // Trigger mail client directly
            try {
                const a = document.createElement("a");
                a.href = mailtoUrl;
                a.style.display = "none";
                document.body.appendChild(a);
                a.click();
                setTimeout(() => a.remove(), 500);
            } catch (e) {
                window.location.href = mailtoUrl;
            }

            // Silent Firestore backup copy so no message is ever lost
            try {
                sendMailMessage({
                    to: targetEmail,
                    senderId,
                    subject,
                    message
                }).catch(() => {});
            } catch (e) {}

            showGmailSnackbar({
                senderId,
                subject,
                message,
                targetEmail
            });

            showToast("Opening your email client to send directly to Josh!");

            setTimeout(() => {
                closeWindow(win);
            }, 800);
        });
    }

    // Discard draft
    if (discardBtn) {
        discardBtn.addEventListener("click", () => {
            if (bodyInput && bodyInput.value.trim().length > 0) {
                if (!confirm("Discard this message?")) return;
            }
            if (subjectInput) subjectInput.value = "";
            if (bodyInput) bodyInput.value = "";
            showToast("Draft discarded");
            closeWindow(win);
        });
    }
}

// Setup Desktop Drop Zone for moving icons across the screen (Admin only)
export function setupDesktopDropZone() {
    const desktop = document.getElementById("desktop");
    const container = document.getElementById("desktopIcons");
    if (!desktop) return;

    const onDragOver = (e) => {
        if (currentUser !== "admin") return;
        if (e.target.closest(".icon[data-is-folder='true']")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
    };

    const onDrop = (e) => {
        if (currentUser !== "admin") return;
        if (e.target.closest(".icon[data-is-folder='true']")) return;
        e.preventDefault();
        try {
            const raw = e.dataTransfer.getData("application/json");
            if (!raw) return;
            const data = JSON.parse(raw);
            if (data.source === "desktop" && data.name) {
                const deskRect = desktop.getBoundingClientRect();
                const offsetX = data.offsetX || 36;
                const offsetY = data.offsetY || 36;
                let x = Math.round(e.clientX - deskRect.left - offsetX);
                let y = Math.round(e.clientY - deskRect.top - offsetY);
                x = Math.max(10, Math.min(deskRect.width - 85, x));
                y = Math.max(10, Math.min(deskRect.height - 110, y));

                currentDesktopPositions[data.name] = { x, y };
                saveDesktopPositions(currentDesktopPositions);
                renderDesktop();
                showToast(`Repositioned "${data.name}"`);
            }
        } catch (err) {
            console.error("Desktop drop error:", err);
        }
    };

    desktop.addEventListener("dragover", onDragOver);
    desktop.addEventListener("drop", onDrop);
    if (container) {
        container.addEventListener("dragover", onDragOver);
        container.addEventListener("drop", onDrop);
    }
}

// ==========================================================================
// COUNTER-STRIKE 2 (CS2) FULLSCREEN COVER VIDEO & LEETIFY DASHBOARD
// ==========================================================================
let cs2CurrentView = "video"; // 'video' | 'stats'
let cs2VideoXTimer = null;

export function saveCs2Config(newConfig) {
    currentCs2Config = { ...DEFAULT_CS2_CONFIG, ...newConfig };
    saveLocalOverride("cs2Config", currentCs2Config);
    if (currentUser === "admin") {
        saveRemoteConfig("cs2Config", currentCs2Config).catch(err => {
            console.warn("Firebase CS2 config save warning:", err);
        });
    }
}

export async function syncLeetifyStats(apiKey = null) {
    const key = apiKey || currentCs2Config.leetifyApiKey || "cc554ec3-3db6-4f54-83b2-c070c40da483";
    try {
        const proxyResp = await fetch(`/api/leetify/v3/profile`, {
            headers: {
                "_leetify_key": key,
                "Authorization": `Bearer ${key}`
            }
        });
        if (proxyResp.ok) {
            const data = await proxyResp.json();
            if (data) {
                applyLeetifyTelemetry(data);
                return { success: true, live: true };
            }
        }
    } catch (e) {
        // Fallback to public endpoint
    }

    try {
        const directResp = await fetch(`https://api-public.os-prod.leetify.com/v3/profile`, {
            headers: {
                "_leetify_key": key,
                "Authorization": `Bearer ${key}`
            }
        });
        if (directResp.ok) {
            const data = await directResp.json();
            if (data) {
                applyLeetifyTelemetry(data);
                return { success: true, live: true };
            }
        }
    } catch (e) {
        console.warn("Direct Leetify endpoint note:", e.message);
    }

    return { success: true, live: false };
}

function applyLeetifyTelemetry(data) {
    if (!data) return;
    if (data.name || data.username) currentCs2Config.playerName = data.name || data.username;
    if (data.skill_level || data.ratings?.leetify) currentCs2Config.skillRating = Number(data.skill_level || data.ratings?.leetify).toFixed(2);
    if (data.ranks?.premier) currentCs2Config.premierRating = data.ranks.premier;
    if (data.ranks?.national) currentCs2Config.nationalRank = data.ranks.national;
    saveCs2Config(currentCs2Config);
}

export function openCs2Experience() {
    // Directive: "also when the user presses the CS2 folder, pause the music"
    pauseCurrentPlayback();

    let overlay = document.getElementById("cs2-fullscreen-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "cs2-fullscreen-overlay";
        overlay.className = "cs2-fullscreen-overlay";
        document.body.appendChild(overlay);
    }
    overlay.style.display = "flex";
    cs2CurrentView = "video";

    renderCs2OverlayContent(overlay);
}

export function closeCs2Experience() {
    if (cs2VideoXTimer) {
        clearTimeout(cs2VideoXTimer);
        cs2VideoXTimer = null;
    }
    const overlay = document.getElementById("cs2-fullscreen-overlay");
    if (overlay) {
        const video = overlay.querySelector("video");
        if (video) {
            video.pause();
            video.src = "";
        }
        const iframe = overlay.querySelector("iframe");
        if (iframe) {
            iframe.src = "";
        }
        overlay.style.display = "none";
        overlay.innerHTML = "";
    }
}

function renderCs2OverlayContent(overlay) {
    overlay.innerHTML = "";
    if (cs2VideoXTimer) {
        clearTimeout(cs2VideoXTimer);
        cs2VideoXTimer = null;
    }

    // Top-right X button: transparent, appearing after 3s in video mode
    const xBtn = document.createElement("button");
    xBtn.id = "cs2-top-x-btn";
    xBtn.innerHTML = "✕";

    if (cs2CurrentView === "video") {
        xBtn.className = "cs2-x-btn cs2-x-btn-transparent cs2-x-video-delayed";
        xBtn.title = "View CS2 & Leetify Stats (Skip Cover Video)";
        cs2VideoXTimer = setTimeout(() => {
            xBtn.classList.add("is-visible");
        }, 3000);
        xBtn.addEventListener("click", () => {
            if (cs2VideoXTimer) clearTimeout(cs2VideoXTimer);
            cs2CurrentView = "stats";
            renderCs2OverlayContent(overlay);
        });
    } else {
        xBtn.className = "cs2-x-btn cs2-x-btn-transparent is-visible";
        xBtn.title = "Close CS2 Dashboard and Return to Desktop";
        xBtn.addEventListener("click", () => {
            closeCs2Experience();
        });
    }

    overlay.appendChild(xBtn);

    if (cs2CurrentView === "video") {
        renderCs2VideoView(overlay);
    } else {
        renderCs2StatsView(overlay);
    }
}

function renderCs2VideoView(overlay) {
    const videoWrap = document.createElement("div");
    videoWrap.className = "cs2-video-view";

    const videoUrl = currentCs2Config.videoUrl || DEFAULT_CS2_CONFIG.videoUrl;
    const isYT = isYouTubeTrack({ src: videoUrl });
    const ytId = isYT ? extractYouTubeId(videoUrl) : null;
    const isDrive = isGoogleDriveTrack({ src: videoUrl }) || (typeof videoUrl === "string" && (videoUrl.includes("drive.google.com") || videoUrl.includes("docs.google.com")));
    const driveId = isDrive ? extractGoogleDriveId(videoUrl) : null;

    let mediaHTML = "";
    if (isYT && ytId) {
        // YouTube embed without controls or branding
        mediaHTML = `
            <div class="cs2-video-host">
                <iframe id="cs2-yt-video-frame" src="https://www.youtube.com/embed/${ytId}?autoplay=1&controls=0&mute=1&loop=1&playlist=${ytId}&rel=0&modestbranding=1&iv_load_policy=3&disablekb=1&playsinline=1" allow="autoplay; fullscreen" allowfullscreen></iframe>
            </div>
        `;
    } else {
        // Direct HTML5 cover video (streamed via proxy for Google Drive to eliminate Google Drive headers, seeker, and open-in-new-window icons)
        const directSrc = (isDrive && driveId) ? `/api/drive-video?id=${encodeURIComponent(driveId)}` : videoUrl;
        mediaHTML = `
            <div class="cs2-video-host">
                <video id="cs2-active-video" class="cs2-cover-video-element" src="${directSrc}" autoplay loop muted playsinline preload="auto"></video>
            </div>
        `;
    }

    videoWrap.innerHTML = mediaHTML;
    overlay.appendChild(videoWrap);

    const videoEl = videoWrap.querySelector("video");
    if (videoEl) {
        videoEl.play().catch(e => {
            console.warn("Autoplay audio policy fallback:", e);
            videoEl.muted = true;
            videoEl.play().catch(() => {});
        });
        videoEl.addEventListener("error", () => {
            if (isDrive && driveId && !videoEl.dataset.fallbackTried) {
                videoEl.dataset.fallbackTried = "true";
                videoEl.src = `https://drive.usercontent.google.com/download?id=${driveId}&export=download&confirm=t`;
                videoEl.play().catch(() => {});
            }
        });
        videoEl.addEventListener("ended", () => {
            cs2CurrentView = "stats";
            renderCs2OverlayContent(overlay);
        });
    }
}

export function getPremierRatingColor(rating) {
    if (!rating) return "#c084fc";
    const num = typeof rating === "number" ? rating : parseInt(String(rating).replace(/[^0-9]/g, ""), 10);
    if (isNaN(num)) return "#c084fc";
    if (num < 5000) return "#8e9297"; // 0-4,999 Grey
    if (num < 10000) return "#5dade2"; // 5,000-9,999 Light Blue
    if (num < 15000) return "#2563eb"; // 10,000-14,999 Dark Blue (12k is dark blue)
    if (num < 20000) return "#c084fc"; // 15,000-19,999 Purple (15k is purple)
    if (num < 25000) return "#ec4899"; // 20,000-24,999 Pink
    if (num < 30000) return "#ef4444"; // 25,000-29,999 Red
    return "#eab308"; // 30,000+ Gold
}

function renderCs2StatsView(overlay) {
    const statsWrap = document.createElement("div");
    statsWrap.className = "cs2-stats-view cs2-theme-orange";

    const playerName = currentCs2Config.playerName || "SPIKETONES007";
    const premierRating = currentCs2Config.premierRating ? Number(currentCs2Config.premierRating).toLocaleString() : "15,003";
    const leetifyUrl = currentCs2Config.leetifyUrl || "https://leetify.com/app/profile/76561199580350164";
    const crosshairCode = currentCs2Config.crosshairCode || "CSGO-SL7LH-GOWPk-mV2m3-bO9QG-RcCcO";

    const ranks = currentCs2Config.ranksOverview || DEFAULT_CS2_CONFIG.ranksOverview;
    const steam = currentCs2Config.steamDetails || DEFAULT_CS2_CONFIG.steamDetails;
    const club = currentCs2Config.club || DEFAULT_CS2_CONFIG.club;
    const party = currentCs2Config.partySize || DEFAULT_CS2_CONFIG.partySize;
    const seasons = currentCs2Config.seasons || DEFAULT_CS2_CONFIG.seasons;
    const perfRadar = currentCs2Config.performanceRadar || DEFAULT_CS2_CONFIG.performanceRadar;
    const benchRadar = currentCs2Config.benchmarkRadar || DEFAULT_CS2_CONFIG.benchmarkRadar;
    const attr = currentCs2Config.attributes || DEFAULT_CS2_CONFIG.attributes;
    const recentMatch = currentCs2Config.recentMatch || DEFAULT_CS2_CONFIG.recentMatch;
    const matchesList = currentCs2Config.matches || DEFAULT_CS2_CONFIG.matches;

    // Build Round-by-Round Bar Chart HTML for latest match
    const rounds = recentMatch.rounds || [
        { r: 1, val: 5.2 }, { r: 2, val: 3.8 }, { r: 3, val: 1.5 }, { r: 4, val: 0.6 },
        { r: 5, val: 0.2 }, { r: 6, val: -1.4 }, { r: 7, val: -2.8 }, { r: 8, val: -4.1 },
        { r: 9, val: 1.9 }, { r: 10, val: 6.66 }
    ];
    const badges = ["BI", "EE", "MR", "ZX", "SE", "OB", "SP", "19", "SC", "TK"];

    const roundBarsHTML = rounds.map((rd, i) => {
        const isPos = rd.val >= 0;
        const heightPx = Math.min(Math.abs(rd.val) * 8 + 6, 52);
        const barClass = isPos ? "cs2-bar-pos" : "cs2-bar-neg";
        const badgeTxt = badges[i % badges.length];
        return `
            <div class="cs2-round-bar-unit" title="Round ${rd.r}: ${isPos ? '+' : ''}${rd.val}%">
                <div class="cs2-round-bar-track ${isPos ? 'pos' : 'neg'}">
                    <div class="cs2-bar-rect ${barClass}" style="height: ${heightPx}px;"></div>
                </div>
                <div class="cs2-round-tag-initial">${badgeTxt}</div>
            </div>
        `;
    }).join("");

    // SVG Charts
    const triangleRadarSVG = generateTriangleRadarSVG(perfRadar, benchRadar);
    const activityBarsSVG = generateActivityBarsSVG();
    const rankClimbSVG = generateRankClimbSVG();

    // Seasons HTML
    const seasonsHTML = seasons.map(s => `
        <div class="cs2-season-card ${s.active ? 'active' : ''}">
            <div class="cs2-season-header">
                <div>
                    <span class="cs2-season-name">${escapeHTML(s.name)}</span>
                    ${s.active ? '<span class="cs2-pill-badge" style="margin-left: 8px; background: rgba(255,119,0,0.2); color: #ffaa33; border: 1px solid rgba(255,119,0,0.4);">ACTIVE</span>' : ''}
                </div>
                <span class="cs2-season-dates">${escapeHTML(s.dates)}</span>
            </div>
            <div class="cs2-season-metrics-row">
                <div class="cs2-season-metric-cell">
                    <span class="cs2-season-metric-lbl">Matches</span>
                    <span class="cs2-season-metric-val">${s.matches}</span>
                </div>
                <div class="cs2-season-metric-cell">
                    <span class="cs2-season-metric-lbl">Win Rate</span>
                    <span class="cs2-season-metric-val highlight">${escapeHTML(s.winRate)}</span>
                </div>
                <div class="cs2-season-metric-cell">
                    <span class="cs2-season-metric-lbl">K/D</span>
                    <span class="cs2-season-metric-val">${escapeHTML(s.kd)}</span>
                </div>
                ${s.active && s.premierCurrent ? `
                <div class="cs2-season-metric-cell">
                    <span class="cs2-season-metric-lbl">Premier Current</span>
                    <span class="cs2-season-metric-val" style="color: ${getPremierRatingColor(s.premierCurrent)};">${escapeHTML(s.premierCurrent)}</span>
                </div>` : ''}
            </div>
            <div class="cs2-season-ranks-sub">
                <span>Range: <strong>${escapeHTML(s.premierMin)}</strong> – <strong style="color: ${getPremierRatingColor(s.premierMax)};">${escapeHTML(s.premierMax)}</strong></span>
                <span>Comp: <strong>${escapeHTML(s.comp)}</strong></span>
                <span>Wingman: <strong>${escapeHTML(s.wingman)}</strong></span>
            </div>
        </div>
    `).join("");

    // Initial matches grid
    const initialMatchesHTML = renderMatchesGridHTML(matchesList);

    statsWrap.innerHTML = `
        <!-- Full-Screen 2-Column Dashboard Body (No Header Bar) -->
        <div class="cs2-dash-body cs2-no-header">
            
            <!-- COLUMN 1: Standing Agent Card & Left Sidebar -->
            <div class="cs2-col-hero">
                
                <!-- Standing Agent Card with Mouse Tilt -->
                <div class="cs2-agent-card-wrapper" id="cs2-agent-3d-wrapper">
                    <div class="cs2-agent-card-3d">
                        <div class="cs2-card-glare"></div>

                        <div class="cs2-agent-image-wrap">
                            <img src="/assets/cs2_agent_phoenix.png" alt="CS2 Phoenix Agent" class="cs2-agent-img" />
                            <div class="cs2-agent-gradient"></div>
                        </div>
                        
                        <div class="cs2-hero-profile-box">
                            <div class="cs2-hero-avatar-row">
                                <div class="cs2-hero-avatar">
                                    <img src="/assets/cs2_agent_phoenix.png" alt="Player" />
                                </div>
                                <div>
                                    <div class="cs2-hero-gamertag">
                                        <span>${escapeHTML(playerName)}</span>
                                        <iconify-icon icon="fluent:checkmark-circle-16-filled" class="cs2-verified-tick" title="Leetify Verified Profile"></iconify-icon>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Ranks Overview Card -->
                <div class="cs2-left-section-card">
                    <div class="cs2-ranks-list">
                        <div class="cs2-rank-row-item">
                            <div class="cs2-rank-name-wrap">
                                <iconify-icon icon="fluent:trophy-20-regular" style="color: ${getPremierRatingColor(premierRating)}; font-size: 16px;"></iconify-icon>
                                <span class="cs2-rank-name">Premier</span>
                            </div>
                            <span class="cs2-rank-badge-val premier" style="color: ${getPremierRatingColor(premierRating)};">${premierRating}</span>
                        </div>
                        <div class="cs2-rank-row-item">
                            <div class="cs2-rank-name-wrap">
                                <iconify-icon icon="fluent:target-arrow-20-regular" style="color: #ffaa33; font-size: 16px;"></iconify-icon>
                                <span class="cs2-rank-name">Competitive</span>
                            </div>
                            <span class="cs2-rank-badge-val">${escapeHTML(ranks.competitive || 'Silver Elite Master')}</span>
                        </div>
                        <div class="cs2-rank-row-item">
                            <div class="cs2-rank-name-wrap">
                                <iconify-icon icon="fluent:people-team-20-regular" style="color: #2ed573; font-size: 16px;"></iconify-icon>
                                <span class="cs2-rank-name">Wingman</span>
                            </div>
                            <span class="cs2-rank-badge-val">${escapeHTML(ranks.wingman || 'Gold Nova II')}</span>
                        </div>
                    </div>
                    <div class="cs2-map-ranks-pills">
                        ${(ranks.mapRanks || []).map(m => `
                            <div class="cs2-map-pill-item">
                                <span style="color: rgba(255,255,255,0.9); font-weight: 700;">${escapeHTML(m.map)}:</span> ${escapeHTML(m.rank)}
                            </div>
                        `).join("")}
                    </div>
                </div>

                <!-- Steam Profile Card -->
                <div class="cs2-left-section-card">
                    <div style="display: flex; justify-content: flex-end;">
                        <span class="cs2-left-card-tag">Level ${steam.level || 20}</span>
                    </div>
                    <div class="cs2-steam-stats-grid">
                        <div class="cs2-steam-stat-cell">
                            <span class="cs2-steam-stat-lbl">Matches</span>
                            <span class="cs2-steam-stat-num">${Number(steam.matches || 1315).toLocaleString()}</span>
                        </div>
                        <div class="cs2-steam-stat-cell">
                            <span class="cs2-steam-stat-lbl">Hours</span>
                            <span class="cs2-steam-stat-num">${Number(steam.hours || 844).toLocaleString()} hrs</span>
                        </div>
                        <div class="cs2-steam-stat-cell">
                            <span class="cs2-steam-stat-lbl">Account Age</span>
                            <span class="cs2-steam-stat-num">${escapeHTML(steam.age || '3 years')}</span>
                        </div>
                        <div class="cs2-steam-stat-cell">
                            <span class="cs2-steam-stat-lbl">Last Active</span>
                            <span class="cs2-steam-stat-num">${escapeHTML(steam.lastMatch || 'Recent')}</span>
                        </div>
                    </div>
                    <a href="https://steamcommunity.com/profiles/${escapeHTML(steam.id || '76561199580350164')}" target="_blank" rel="noopener noreferrer" class="cs2-steam-link-btn">
                        <iconify-icon icon="simple-icons:steam"></iconify-icon>
                        <span>Steam Community Profile ↗</span>
                    </a>
                </div>

                <!-- Active Crosshair Card -->
                <div class="cs2-crosshair-card">
                    <div class="cs2-crosshair-preview-box" title="CS2 In-Game Crosshair: Tiny Red Dot Reticle">
                        <div class="cs2-crosshair-backdrop-dust"></div>
                        <div class="cs2-crosshair-reticle-wrap">
                            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" class="cs2-tiny-crosshair-svg">
                                <rect x="10.25" y="4.5" width="1.5" height="4.5" fill="#ff0000" />
                                <rect x="10.25" y="13" width="1.5" height="4.5" fill="#ff0000" />
                                <rect x="4.5" y="10.25" width="4.5" height="1.5" fill="#ff0000" />
                                <rect x="13" y="10.25" width="4.5" height="1.5" fill="#ff0000" />
                                <rect x="10.25" y="10.25" width="1.5" height="1.5" fill="#ff0000" />
                            </svg>
                        </div>
                    </div>
                    <div class="cs2-crosshair-code-box">
                        <code id="cs2-crosshair-code-display" title="${escapeHTML(crosshairCode)}">${escapeHTML(crosshairCode)}</code>
                        <button class="cs2-copy-crosshair-btn" id="cs2-copy-crosshair-btn" title="Copy CS2 Crosshair Code">
                            <iconify-icon icon="fluent:copy-20-regular"></iconify-icon>
                            <span>Copy</span>
                        </button>
                    </div>
                </div>

                <!-- Club & Party Size Card -->
                <div class="cs2-left-section-card">
                    <div style="display: flex; justify-content: flex-end; margin-bottom: 6px;">
                        <span class="cs2-left-card-tag">${escapeHTML(club.tag || '007 [L7] 007')}</span>
                    </div>
                    <div class="cs2-party-bars">
                        <div class="cs2-party-row">
                            <span class="cs2-party-lbl">Solo Queue</span>
                            <span class="cs2-party-pct">${party.solo || 90}%</span>
                        </div>
                        <div class="cs2-party-bar-track">
                            <div class="cs2-party-bar-fill" style="width: ${party.solo || 90}%;"></div>
                        </div>
                        <div class="cs2-party-row" style="margin-top: 6px;">
                            <span class="cs2-party-lbl">2-3 Stack</span>
                            <span class="cs2-party-pct">${party.stack || 10}%</span>
                        </div>
                        <div class="cs2-party-bar-track">
                            <div class="cs2-party-bar-fill" style="width: ${party.stack || 10}%; background: #00e5ff;"></div>
                        </div>
                        <div class="cs2-party-row" style="margin-top: 6px;">
                            <span class="cs2-party-lbl">5 Stack Full</span>
                            <span class="cs2-party-pct">${party.full || 0}%</span>
                        </div>
                        <div class="cs2-party-bar-track">
                            <div class="cs2-party-bar-fill" style="width: ${party.full || 0}%;"></div>
                        </div>
                    </div>
                </div>

            </div>

            <!-- COLUMN 2: Full-Screen Telemetry Main Area -->
            <div class="cs2-col-main">

                <!-- Seasons Telemetry -->
                <div>
                    <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
                        <a href="${leetifyUrl}" target="_blank" rel="noopener noreferrer" style="font-size: 11.5px; color: #ffaa33; text-decoration: none; font-weight: 700;">
                            View full Leetify profile ↗
                        </a>
                    </div>
                    <div class="cs2-season-cards-grid">
                        ${seasonsHTML}
                    </div>
                </div>

                <!-- Performance Matrix & Triangular Radar + 9 Attributes -->
                <div>
                    <div class="cs2-perf-radar-card" style="margin-top: 4px;">
                        
                        <!-- Left Subcolumn: Triangle Radar -->
                        <div class="cs2-triangle-radar-col">
                            <div class="cs2-triangle-radar-svg-box">
                                ${triangleRadarSVG}
                            </div>
                            <div class="cs2-radar-legend-bar">
                                <div class="cs2-legend-pill">
                                    <span class="cs2-legend-square" style="background: #ff7700;"></span>
                                    <span>You (${escapeHTML(playerName)})</span>
                                </div>
                                <div class="cs2-legend-pill">
                                    <span class="cs2-legend-square" style="background: #a855f7;"></span>
                                    <span>25k+ Avg</span>
                                </div>
                            </div>
                        </div>

                        <!-- Right Subcolumn: 9-Attributes Matrix -->
                        <div class="cs2-attributes-matrix">
                            <div class="cs2-attr-tile">
                                <div class="cs2-attr-header">
                                    <span class="cs2-attr-title">Crosshair Placement</span>
                                    <iconify-icon icon="fluent:target-arrow-16-regular" style="color: #ffaa33;"></iconify-icon>
                                </div>
                                <div class="cs2-attr-score orange">${escapeHTML(attr.preaim || '8.84°')}</div>
                                <div class="cs2-attr-sub">vs 8.42° avg</div>
                            </div>
                            <div class="cs2-attr-tile">
                                <div class="cs2-attr-header">
                                    <span class="cs2-attr-title">Reaction Time</span>
                                    <iconify-icon icon="fluent:timer-16-regular" style="color: #00e5ff;"></iconify-icon>
                                </div>
                                <div class="cs2-attr-score cyan">${escapeHTML(attr.reactionTime || '518ms')}</div>
                                <div class="cs2-attr-sub">vs 524ms avg</div>
                            </div>
                            <div class="cs2-attr-tile">
                                <div class="cs2-attr-header">
                                    <span class="cs2-attr-title">Enemy Accuracy</span>
                                    <iconify-icon icon="fluent:arrow-trending-16-regular" style="color: #2ed573;"></iconify-icon>
                                </div>
                                <div class="cs2-attr-score high">${escapeHTML(attr.accuracy || '38.7%')}</div>
                                <div class="cs2-attr-sub">vs 35.6% avg</div>
                            </div>
                            <div class="cs2-attr-tile">
                                <div class="cs2-attr-header">
                                    <span class="cs2-attr-title">Headshot Accuracy</span>
                                    <iconify-icon icon="fluent:target-16-regular" style="color: #ff4757;"></iconify-icon>
                                </div>
                                <div class="cs2-attr-score">${escapeHTML(attr.headshot || '17.3%')}</div>
                                <div class="cs2-attr-sub">vs 19.8% avg</div>
                            </div>
                            <div class="cs2-attr-tile">
                                <div class="cs2-attr-header">
                                    <span class="cs2-attr-title">Counter-Strafing</span>
                                    <iconify-icon icon="fluent:arrow-swap-16-regular" style="color: #2ed573;"></iconify-icon>
                                </div>
                                <div class="cs2-attr-score high">${escapeHTML(attr.counterStrafing || '75.1%')}</div>
                                <div class="cs2-attr-sub">vs 73.2% avg</div>
                            </div>
                            <div class="cs2-attr-tile">
                                <div class="cs2-attr-header">
                                    <span class="cs2-attr-title">Spray Accuracy</span>
                                    <iconify-icon icon="fluent:flash-16-regular" style="color: #ffaa33;"></iconify-icon>
                                </div>
                                <div class="cs2-attr-score orange">${escapeHTML(attr.sprayAccuracy || '42.8%')}</div>
                                <div class="cs2-attr-sub">vs 41.5% avg</div>
                            </div>
                            <div class="cs2-attr-tile">
                                <div class="cs2-attr-header">
                                    <span class="cs2-attr-title">HE Grenade DMG</span>
                                    <iconify-icon icon="fluent:flame-16-regular" style="color: #ff9900;"></iconify-icon>
                                </div>
                                <div class="cs2-attr-score">${escapeHTML(attr.heDamage || '9.51')}</div>
                                <div class="cs2-attr-sub">avg per match</div>
                            </div>
                            <div class="cs2-attr-tile">
                                <div class="cs2-attr-header">
                                    <span class="cs2-attr-title">Flashbang Duration</span>
                                    <iconify-icon icon="fluent:lightbulb-16-regular" style="color: #e056fd;"></iconify-icon>
                                </div>
                                <div class="cs2-attr-score">${escapeHTML(attr.flashDuration || '2.12s')}</div>
                                <div class="cs2-attr-sub">blind time per enemy</div>
                            </div>
                            <div class="cs2-attr-tile">
                                <div class="cs2-attr-header">
                                    <span class="cs2-attr-title">Trade Kill Opp.</span>
                                    <iconify-icon icon="fluent:shield-16-regular" style="color: #00e5ff;"></iconify-icon>
                                </div>
                                <div class="cs2-attr-score cyan">${escapeHTML(attr.tradeKillOpp || '0.41')}</div>
                                <div class="cs2-attr-sub">traded: ${escapeHTML(attr.tradedDeaths || '56.1%')}</div>
                            </div>
                        </div>

                    </div>
                </div>

                <!-- Recent Matches Grid with Mode Filter -->
                <div>
                    <div class="cs2-matches-filter-row" style="margin-top: 14px; margin-bottom: 10px;">
                        <div class="cs2-mode-filter-pills">
                            <button class="cs2-mode-pill active" data-mode="all">All</button>
                            <button class="cs2-mode-pill" data-mode="premier">Premier</button>
                            <button class="cs2-mode-pill" data-mode="competitive">Competitive</button>
                            <button class="cs2-mode-pill" data-mode="wingman">Wingman</button>
                        </div>
                    </div>
                    <div class="cs2-matches-grid-v2" id="cs2-matches-grid-container">
                        ${initialMatchesHTML}
                    </div>
                </div>

                <!-- Activity & Premier Progression Duo Grid -->
                <div class="cs2-charts-duo-grid" style="margin-top: 14px;">
                    <!-- Chart 1: Activity & Win/Loss -->
                    <div class="cs2-chart-card">
                        <div style="display: flex; justify-content: flex-end; margin-bottom: 6px;">
                            <span style="font-size: 11px; font-weight: 700; color: #2ed573;">84% Win Rate (163G)</span>
                        </div>
                        <div class="cs2-chart-svg-wrap">
                            ${activityBarsSVG}
                        </div>
                    </div>

                    <!-- Chart 2: Premier Rating Climb -->
                    <div class="cs2-chart-card">
                        <div style="display: flex; justify-content: flex-end; margin-bottom: 6px;">
                            <span style="font-size: 11px; font-weight: 700; color: #c084fc;">Peak: 15,118</span>
                        </div>
                        <div class="cs2-chart-svg-wrap">
                            ${rankClimbSVG}
                        </div>
                    </div>
                </div>

                <!-- Round Momentum Deep Dive -->
                <div class="cs2-momentum-card">
                    <div class="cs2-momentum-top">
                        <div class="cs2-momentum-impact-pill">+6.66% Leetify Impact</div>
                    </div>
                    <div class="cs2-round-chart-wrap">
                        <div class="cs2-round-chart-y">
                            <span>+8%</span>
                            <span>0%</span>
                            <span>-8%</span>
                        </div>
                        <div class="cs2-round-bars-container">
                            <div class="cs2-zero-line"></div>
                            ${roundBarsHTML}
                        </div>
                    </div>
                    <div class="cs2-halves-split-footer">
                        <div class="cs2-half-cell">
                            <div class="cs2-half-info">
                                <span class="cs2-side-icon t-side">T</span>
                                <span class="cs2-side-title">T side</span>
                            </div>
                            <span class="cs2-half-val">${escapeHTML(recentMatch.tSide || '+5.52%')}</span>
                        </div>
                        <div class="cs2-half-cell">
                            <div class="cs2-half-info">
                                <span class="cs2-side-icon ct-side">CT</span>
                                <span class="cs2-side-title">CT side</span>
                            </div>
                            <span class="cs2-half-val highlight-ct">${escapeHTML(recentMatch.ctSide || '+7.9%')}</span>
                        </div>
                    </div>
                </div>

            </div>

        </div>
    `;

    overlay.appendChild(statsWrap);

    // Attach 3D Card mouse-tilt physics
    const agentWrapper = statsWrap.querySelector("#cs2-agent-3d-wrapper");
    if (agentWrapper) {
        attachAgentCard3dPhysics(agentWrapper);
    }

    // Bind Replay Cover Video Button
    const replayBtn = statsWrap.querySelector("#cs2-replay-cover-btn");
    if (replayBtn) {
        replayBtn.addEventListener("click", () => {
            cs2CurrentView = "video";
            renderCs2OverlayContent(overlay);
        });
    }

    // Bind Copy Crosshair Button
    const copyCrosshairBtn = statsWrap.querySelector("#cs2-copy-crosshair-btn");
    if (copyCrosshairBtn) {
        copyCrosshairBtn.addEventListener("click", () => {
            const code = currentCs2Config.crosshairCode || "CSGO-SL7LH-GOWPk-mV2m3-bO9QG-RcCcO";
            navigator.clipboard.writeText(code).then(() => {
                copyCrosshairBtn.innerHTML = `<iconify-icon icon="fluent:checkmark-20-regular"></iconify-icon> <span>Copied!</span>`;
                setTimeout(() => {
                    copyCrosshairBtn.innerHTML = `<iconify-icon icon="fluent:copy-20-regular"></iconify-icon> <span>Copy</span>`;
                }, 2000);
                showToast("CS2 Crosshair code copied to clipboard!");
            }).catch(() => {
                showToast("Crosshair: " + code);
            });
        });
    }

    // Bind Matches Mode Filter Pills
    const modePills = statsWrap.querySelectorAll(".cs2-mode-pill");
    modePills.forEach(pill => {
        pill.addEventListener("click", () => {
            modePills.forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            const mode = pill.getAttribute("data-mode");
            const container = statsWrap.querySelector("#cs2-matches-grid-container");
            if (container) {
                let filtered = matchesList;
                if (mode === "competitive") {
                    filtered = matchesList.filter(m => (m.map || "").includes("inferno") || (m.map || "").includes("mirage"));
                } else if (mode === "wingman") {
                    filtered = matchesList.filter(m => (m.score || "").startsWith("9"));
                }
                container.innerHTML = renderMatchesGridHTML(filtered);
            }
        });
    });

    // Bind Nav Tabs
    const navTabs = statsWrap.querySelectorAll(".cs2-nav-tab");
    navTabs.forEach(tab => {
        tab.addEventListener("click", () => {
            navTabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
        });
    });
}

// 3D Agent Card Physics: "the other corner of the card comes towards the screen, due to the weight of the mouse, like a 3d card"
function attachAgentCard3dPhysics(wrapper) {
    const card = wrapper.querySelector(".cs2-agent-card-3d");
    const glare = wrapper.querySelector(".cs2-card-glare");
    if (!card) return;

    let rafId = null;

    const onMouseMove = (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const cx = rect.width / 2;
        const cy = rect.height / 2;

        const dx = (x - cx) / cx; // -1 to 1
        const dy = (y - cy) / cy; // -1 to 1

        const maxTilt = 16;
        // Pushing top pushes top inward into the screen (rotX > 0), causing bottom-opposite corner to tilt forward towards viewer
        // Pushing left pushes left inward into the screen (rotY < 0), causing right-opposite corner to tilt forward towards viewer
        const rotX = dy * maxTilt;
        const rotY = -dx * maxTilt;

        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
            card.style.transform = `perspective(1000px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) scale3d(1.025, 1.025, 1.025)`;
            if (glare) {
                const px = ((x / rect.width) * 100).toFixed(1);
                const py = ((y / rect.height) * 100).toFixed(1);
                glare.style.background = `radial-gradient(circle at ${px}% ${py}%, rgba(255, 255, 255, 0.35) 0%, rgba(255, 140, 0, 0.15) 45%, transparent 70%)`;
                glare.style.opacity = "1";
            }
        });
    };

    const onMouseLeave = () => {
        if (rafId) cancelAnimationFrame(rafId);
        card.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)";
        if (glare) glare.style.opacity = "0";
    };

    card.addEventListener("mousemove", onMouseMove);
    card.addEventListener("mouseleave", onMouseLeave);
}

// Matches Grid HTML Generator
function renderMatchesGridHTML(matchesList) {
    if (!matchesList || matchesList.length === 0) {
        return `<div style="color: rgba(255,255,255,0.4); padding: 16px; font-size: 12px;">No matches found for selected category.</div>`;
    }
    return matchesList.map(m => {
        const isWin = (m.result || "").toUpperCase() === "WIN";
        const outcomeClass = isWin ? "win" : "loss";
        const ratingVal = m.leetify || "+10.0";
        const isPosRating = !ratingVal.startsWith("-");
        const ratingClass = isPosRating ? "pos" : "neg";
        const mapClean = (m.map || "anubis").replace(/^de_/, "");

        return `
            <div class="cs2-match-tile-v2">
                <div class="cs2-match-tile-top">
                    <span class="cs2-match-map-title">${escapeHTML(mapClean)}</span>
                    <span class="cs2-match-outcome-tag ${outcomeClass}">${isWin ? 'WIN' : 'LOSS'}</span>
                </div>
                <div class="cs2-match-tile-body">
                    <div class="cs2-match-score-row">
                        <span class="cs2-match-score-big">${escapeHTML(m.score || '13 : 10')}</span>
                        <span class="cs2-match-rating-badge ${ratingClass}">${escapeHTML(ratingVal)}</span>
                    </div>
                    <div class="cs2-match-stats-row">
                        <div class="cs2-match-stat-col">
                            <span class="cs2-m-lbl">K/D</span>
                            <span class="cs2-m-val">${escapeHTML(m.kd || '1.5')}</span>
                        </div>
                        <div class="cs2-match-stat-col">
                            <span class="cs2-m-lbl">HS%</span>
                            <span class="cs2-m-val">${escapeHTML(m.hs || '60%')}</span>
                        </div>
                        <div class="cs2-match-stat-col">
                            <span class="cs2-m-lbl">Accuracy</span>
                            <span class="cs2-m-val">${escapeHTML(m.accuracy || '39%')}</span>
                        </div>
                        <div class="cs2-match-stat-col">
                            <span class="cs2-m-lbl">Preaim</span>
                            <span class="cs2-m-val">${escapeHTML(m.preaim || '7.5°')}</span>
                        </div>
                    </div>
                    <div class="cs2-match-tile-footer">
                        <span>Premier 5v5</span>
                        <span>${escapeHTML(m.date || 'Recent')}</span>
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

// SVG Triangular Radar Chart (Aim, Utility, Positioning)
function generateTriangleRadarSVG(perf, bench) {
    const size = 260;
    const cx = 130;
    const cy = 115;
    const R = 75;

    // Triangle vertices (Aim = Top, Utility = Bottom Right, Positioning = Bottom Left)
    const angles = [-Math.PI / 2, Math.PI / 6, 5 * Math.PI / 6];

    // Grid Levels: 33%, 66%, 100%
    const levels = [0.33, 0.66, 1.0];
    const gridPolys = levels.map(lvl => {
        const pts = angles.map(a => `${(cx + R * lvl * Math.cos(a)).toFixed(1)},${(cy + R * lvl * Math.sin(a)).toFixed(1)}`).join(" ");
        return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="${lvl < 1 ? '2,2' : 'none'}"/>`;
    }).join("");

    // Spokes from center
    const spokes = angles.map(a => {
        return `<line x1="${cx}" y1="${cy}" x2="${(cx + R * Math.cos(a)).toFixed(1)}" y2="${(cy + R * Math.sin(a)).toFixed(1)}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
    }).join("");

    // Benchmark Polygon (25k+ Avg: Aim 92, Utility 65, Positioning 78)
    const bAim = (bench.aim || 92) / 100;
    const bUtil = (bench.utility || 65) / 100;
    const bPos = (bench.positioning || 78) / 100;
    const bPts = [
        `${cx},${(cy - R * bAim).toFixed(1)}`,
        `${(cx + R * bUtil * Math.cos(angles[1])).toFixed(1)},${(cy + R * bUtil * Math.sin(angles[1])).toFixed(1)}`,
        `${(cx + R * bPos * Math.cos(angles[2])).toFixed(1)},${(cy + R * bPos * Math.sin(angles[2])).toFixed(1)}`
    ].join(" ");

    // Player Polygon (You: Aim 82.4, Utility 40.4, Positioning 65.9)
    const pAim = (perf.aim || 82.4) / 100;
    const pUtil = (perf.utility || 40.4) / 100;
    const pPos = (perf.positioning || 65.9) / 100;
    const pPts = [
        `${cx},${(cy - R * pAim).toFixed(1)}`,
        `${(cx + R * pUtil * Math.cos(angles[1])).toFixed(1)},${(cy + R * pUtil * Math.sin(angles[1])).toFixed(1)}`,
        `${(cx + R * pPos * Math.cos(angles[2])).toFixed(1)},${(cy + R * pPos * Math.sin(angles[2])).toFixed(1)}`
    ].join(" ");

    return `
        <svg width="100%" height="220" viewBox="0 0 ${size} 220" class="cs2-triangle-radar-svg">
            <defs>
                <linearGradient id="trianglePlayerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#ff7700" stop-opacity="0.55"/>
                    <stop offset="100%" stop-color="#ff9900" stop-opacity="0.2"/>
                </linearGradient>
            </defs>
            ${gridPolys}
            ${spokes}
            
            <!-- Benchmark 25k Polygon -->
            <polygon points="${bPts}" fill="rgba(168, 85, 247, 0.14)" stroke="#a855f7" stroke-width="1.8" stroke-dasharray="4,3" />

            <!-- Player Polygon -->
            <polygon points="${pPts}" fill="url(#trianglePlayerGrad)" stroke="#ff7700" stroke-width="2.5" />
            
            <!-- Player Points Dots -->
            <circle cx="${cx}" cy="${(cy - R * pAim).toFixed(1)}" r="4" fill="#ff7700" stroke="#ffffff" stroke-width="1.5" />
            <circle cx="${(cx + R * pUtil * Math.cos(angles[1])).toFixed(1)}" cy="${(cy + R * pUtil * Math.sin(angles[1])).toFixed(1)}" r="4" fill="#ff7700" stroke="#ffffff" stroke-width="1.5" />
            <circle cx="${(cx + R * pPos * Math.cos(angles[2])).toFixed(1)}" cy="${(cy + R * pPos * Math.sin(angles[2])).toFixed(1)}" r="4" fill="#ff7700" stroke="#ffffff" stroke-width="1.5" />

            <!-- Vertex Labels -->
            <text x="${cx}" y="20" fill="#ffffff" font-size="11" font-weight="800" text-anchor="middle">AIM</text>
            <text x="${cx}" y="33" fill="#ffaa33" font-size="10" font-weight="800" text-anchor="middle">${perf.aim || 82.4}</text>

            <text x="${(cx + R + 14).toFixed(1)}" y="${cy + 52}" fill="#ffffff" font-size="11" font-weight="800" text-anchor="start">UTILITY</text>
            <text x="${(cx + R + 14).toFixed(1)}" y="${cy + 65}" fill="#ffaa33" font-size="10" font-weight="800" text-anchor="start">${perf.utility || 40.4}</text>

            <text x="${(cx - R - 14).toFixed(1)}" y="${cy + 52}" fill="#ffffff" font-size="11" font-weight="800" text-anchor="end">POSITIONING</text>
            <text x="${(cx - R - 14).toFixed(1)}" y="${cy + 65}" fill="#ffaa33" font-size="10" font-weight="800" text-anchor="end">${perf.positioning || 65.9}</text>
        </svg>
    `;
}

// Activity Bar Chart SVG (Win/Loss/Tie Distribution)
function generateActivityBarsSVG() {
    const barsData = [
        { w: 14, l: 2, t: 0, label: "W1" },
        { w: 18, l: 3, t: 0, label: "W2" },
        { w: 16, l: 2, t: 1, label: "W3" },
        { w: 22, l: 4, t: 0, label: "W4" },
        { w: 19, l: 3, t: 0, label: "W5" },
        { w: 25, l: 5, t: 0, label: "W6" },
        { w: 23, l: 6, t: 0, label: "W7" }
    ];

    const chartW = 320;
    const chartH = 110;
    const barWidth = 28;
    const gap = 16;
    const startX = 14;

    const barsHTML = barsData.map((d, i) => {
        const x = startX + i * (barWidth + gap);
        const total = d.w + d.l + d.t;
        const maxScale = 30;
        const hWin = (d.w / maxScale) * 80;
        const hLoss = (d.l / maxScale) * 80;
        const yLoss = chartH - 22 - hLoss;
        const yWin = yLoss - hWin;

        return `
            <rect x="${x}" y="${yWin}" width="${barWidth}" height="${hWin}" fill="#00a2ed" rx="3" />
            <rect x="${x}" y="${yLoss}" width="${barWidth}" height="${hLoss}" fill="rgba(255,255,255,0.22)" rx="2" />
            <text x="${x + barWidth / 2}" y="${chartH - 8}" fill="rgba(255,255,255,0.5)" font-size="9" text-anchor="middle">${d.label}</text>
        `;
    }).join("");

    return `
        <svg width="100%" height="110" viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="none">
            <line x1="0" y1="${chartH - 22}" x2="${chartW}" y2="${chartH - 22}" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
            ${barsHTML}
        </svg>
    `;
}

// Premier Rating Climb SVG
function generateRankClimbSVG() {
    const pts = [
        { x: 15, y: 78, val: "7.5k" },
        { x: 70, y: 64, val: "10.2k" },
        { x: 130, y: 46, val: "12.8k" },
        { x: 190, y: 32, val: "14.4k" },
        { x: 250, y: 16, val: "15.1k" },
        { x: 305, y: 18, val: "15,003" }
    ];

    const pathD = `M ${pts[0].x} ${pts[0].y} Q 40 70, ${pts[1].x} ${pts[1].y} T ${pts[2].x} ${pts[2].y} T ${pts[3].x} ${pts[3].y} T ${pts[4].x} ${pts[4].y} T ${pts[5].x} ${pts[5].y}`;
    const areaD = `${pathD} L 305 100 L 15 100 Z`;

    const dots = pts.map((p, i) => `
        <circle cx="${p.x}" cy="${p.y}" r="${i === pts.length - 1 ? 4.5 : 3}" fill="${i === pts.length - 1 ? '#ffaa33' : '#c084fc'}" stroke="#ffffff" stroke-width="1.5" />
        <text x="${p.x}" y="${p.y - 7}" fill="#ffffff" font-size="8.5" font-weight="700" text-anchor="middle">${p.val}</text>
    `).join("");

    return `
        <svg width="100%" height="110" viewBox="0 0 320 110" preserveAspectRatio="none">
            <defs>
                <linearGradient id="rankGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#c084fc" stop-opacity="0.35"/>
                    <stop offset="100%" stop-color="#c084fc" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <path d="${areaD}" fill="url(#rankGrad)" />
            <path d="${pathD}" fill="none" stroke="#c084fc" stroke-width="2.5" stroke-linecap="round" />
            ${dots}
        </svg>
    `;
}


// --- ADMIN EDIT MODE ---
export function openAdminEditMode() {
    isOwner = true;
    const winId = "win-owner-edit";
    const existing = document.getElementById(winId);
    if (existing) {
        existing.classList.remove("minimized");
        bringToFront(existing);
        updateTaskbar();
        return;
    }

    const isConnected = isFirebaseConfigured();
    const statusText = isConnected ? "Firebase Firestore: Online (spiketones7)" : "Offline Mode (localStorage Backup)";
    const dotClass = isConnected ? "" : "offline";

    const contentHTML = `
        <div class="owner-container">
            <div class="owner-tabs">
                <button class="owner-tab-btn active" data-tab="tab-wallpaper">🖼️ Wallpaper</button>
                <button class="owner-tab-btn" data-tab="tab-desktop">🖥️ Desktop Layout</button>
                <button class="owner-tab-btn" data-tab="tab-music">🎵 Music Library</button>
                <button class="owner-tab-btn" data-tab="tab-cs2">🎯 CS2 & Leetify</button>
            </div>

            <!-- Tab 1: Wallpaper -->
            <div class="owner-tab-content active" id="tab-wallpaper">
                <div class="owner-section-title">Change Wallpaper</div>
                <div class="owner-subtext">Upload a new background image or enter a URL. Synced to all visitors via Firebase Firestore.</div>
                
                <div class="owner-field">
                    <label class="owner-label">Preview</label>
                    <div class="owner-preview-box" id="owner-wp-preview" style="background-image: url('${currentWallpaper}')" title="Wallpaper preview (Drag and drop an image here to apply)"></div>
                </div>

                <div class="owner-field">
                    <div class="owner-upload-area" id="owner-wp-upload-dropzone">
                        <iconify-icon icon="fluent:arrow-upload-24-filled" width="22" height="22" style="color: #ff8c00;"></iconify-icon>
                        <div style="flex: 1;">
                            <div style="font-size: 13px; font-weight: 500; color: #ffffff;">Upload Wallpaper from Device</div>
                            <div style="font-size: 11px; color: rgba(255, 255, 255, 0.55);">Click to browse or drop an image file (PNG, JPG, WEBP)</div>
                        </div>
                        <button type="button" class="owner-btn-mini" id="owner-wp-browse-btn" style="padding: 4px 12px; height: 32px; background: rgba(255, 140, 0, 0.25); border: 1px solid #ff8c00; color: #ffffff; border-radius: 4px;">Upload Image</button>
                    </div>
                </div>

                <div class="owner-field">
                    <label class="owner-label">Or Wallpaper Image URL</label>
                    <input type="text" id="owner-wp-input" class="owner-input" value="${currentWallpaper}" placeholder="wall.png or https://example.com/image.jpg" />
                </div>

                <div style="display: flex; gap: 8px;">
                    <button class="owner-save-btn" id="owner-wp-save" style="flex: 1;">Save Wallpaper</button>
                    <button class="owner-btn-mini" id="owner-wp-reset" style="width: auto; padding: 0 12px; height: 40px;" title="Reset to default">Default</button>
                </div>
            </div>

            <!-- Tab 2: Desktop Layout -->
            <div class="owner-tab-content" id="tab-desktop">
                <div class="owner-section-title">
                    <span>Desktop Icons</span>
                    <button class="owner-save-btn" id="owner-dt-save" style="height: 30px; font-size: 11.5px; padding: 0 12px;">Save Layout</button>
                </div>
                <div class="owner-subtext">Reorder, modify, add, or delete desktop items. Saved to Firebase Firestore.</div>

                <div class="owner-list" id="owner-dt-list"></div>

                <div class="owner-section-title" style="margin-top: 8px;">Add New Desktop Item</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <div class="owner-field">
                        <label class="owner-label">Item Name</label>
                        <input type="text" id="new-item-name" class="owner-input" placeholder="e.g. My Website" />
                    </div>
                    <div class="owner-field">
                        <label class="owner-label">Type</label>
                        <select id="new-item-type" class="owner-input" style="background: rgba(0,0,0,0.65);">
                            <option value="link">Link (Web URL)</option>
                            <option value="file">File (Notepad)</option>
                            <option value="folder">Folder</option>
                        </select>
                    </div>
                </div>
                <div class="owner-field">
                    <label class="owner-label">URL or Destination (if link)</label>
                    <input type="text" id="new-item-url" class="owner-input" placeholder="https://example.com" />
                </div>
                <button class="owner-save-btn" id="new-item-add" style="background: #444; height: 36px;">+ Add Item to Desktop</button>
            </div>

            <!-- Tab 3: Music Library -->
            <div class="owner-tab-content" id="tab-music">
                <div class="owner-section-title">
                    <span>Music Player Library</span>
                    <div style="display: flex; gap: 6px;">
                        <button class="owner-btn-mini danger" id="owner-ml-clear-all" style="height: 30px; font-size: 11.5px; padding: 0 10px;" title="Delete all songs in library">Clear All Songs</button>
                        <button class="owner-save-btn" id="owner-ml-save" style="height: 30px; font-size: 11.5px; padding: 0 12px;">Save Music Library</button>
                    </div>
                </div>
                <div class="owner-subtext">Add or remove songs playable in the HDD mini-player (Supports MP3, YouTube, Spotify, SoundCloud, Google Drive). Saved to Firebase.</div>

                <div class="owner-list" id="owner-ml-list"></div>

                <div class="owner-section-title" style="margin-top: 8px;">Add New Song</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <div class="owner-field">
                        <label class="owner-label">Song Title</label>
                        <input type="text" id="new-song-title" class="owner-input" placeholder="e.g. Stop Breathing" />
                    </div>
                    <div class="owner-field">
                        <label class="owner-label">Artist</label>
                        <input type="text" id="new-song-artist" class="owner-input" placeholder="e.g. Playboi Carti" />
                    </div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <div class="owner-field">
                        <label class="owner-label">Audio URL / Link (YouTube, Spotify, SoundCloud, Drive, MP3)</label>
                        <input type="text" id="new-song-src" class="owner-input" placeholder="https://... or files/music/song1.mp3" />
                    </div>
                    <div class="owner-field">
                        <label class="owner-label">Cover Image URL</label>
                        <input type="text" id="new-song-cover" class="owner-input" placeholder="files/cover/song1.jpg" />
                    </div>
                </div>
                <button class="owner-save-btn" id="new-song-add" style="background: #444; height: 36px;">+ Add Track to Library</button>
            </div>

            <!-- Tab 4: CS2 & Leetify Settings -->
            <div class="owner-tab-content" id="tab-cs2">
                <div class="owner-section-title">
                    <span>Counter-Strike 2 & Leetify Settings</span>
                    <button class="owner-save-btn" id="owner-cs2-save" style="height: 30px; font-size: 11.5px; padding: 0 12px;">Save CS2 Config</button>
                </div>
                <div class="owner-subtext">Stats are retrieved automatically via your Leetify API key. No manual stats data entry required.</div>

                <div class="owner-field">
                    <label class="owner-label">Cover Video URL (Direct MP4, YouTube, Google Drive, or Web Video)</label>
                    <input type="text" id="owner-cs2-video-url" class="owner-input" value="${escapeHTML(currentCs2Config.videoUrl || '')}" placeholder="https://.../video.mp4 or YouTube link" />
                </div>

                <div class="owner-field">
                    <label class="owner-label">Cover Video Title</label>
                    <input type="text" id="owner-cs2-video-title" class="owner-input" value="${escapeHTML(currentCs2Config.videoTitle || 'CS2 Cinematic Cover Video')}" placeholder="e.g. CS2 Cinematic Cover Video" />
                </div>

                <div class="owner-field">
                    <label class="owner-label">Leetify Developer API Key</label>
                    <div style="display: flex; gap: 8px;">
                        <input type="text" id="owner-cs2-api-key" class="owner-input" value="${escapeHTML(currentCs2Config.leetifyApiKey || 'cc554ec3-3db6-4f54-83b2-c070c40da483')}" placeholder="cc554ec3-3db6-4f54-83b2-c070c40da483" style="font-family: monospace; letter-spacing: 0.5px;" />
                        <button type="button" class="owner-btn-mini" id="owner-cs2-sync-btn" style="width: auto; padding: 0 14px; background: rgba(255, 119, 0, 0.2); border: 1px solid #ff7700; color: #ff9933; font-weight: 700; white-space: nowrap;">⚡ Sync API</button>
                    </div>
                </div>

                <div class="owner-field">
                    <label class="owner-label">Leetify Profile URL</label>
                    <input type="text" id="owner-cs2-leetify-url" class="owner-input" value="${escapeHTML(currentCs2Config.leetifyUrl || 'https://leetify.com/app/profile/76561199580350164')}" placeholder="https://leetify.com/app/profile/76561199580350164" />
                </div>

                <div style="background: rgba(255, 119, 0, 0.08); border: 1px solid rgba(255, 119, 0, 0.25); border-radius: 8px; padding: 12px 14px; margin-top: 12px; font-size: 12px; color: rgba(255, 255, 255, 0.85); display: flex; align-items: center; gap: 10px;">
                    <iconify-icon icon="fluent:checkmark-circle-24-filled" style="color: #2ed573; font-size: 20px; flex-shrink: 0;"></iconify-icon>
                    <div>
                        <strong>Automatic Leetify Sync Active:</strong> All stats, Premier rating (${Number(currentCs2Config.premierRating || 15003).toLocaleString()}), Skill rating (${currentCs2Config.skillRating || '60.17'}), Headshot %, Radar, and Match breakdowns are linked to your Leetify API.
                    </div>
                </div>

                <div style="display: flex; gap: 8px; margin-top: 14px;">
                    <button class="owner-save-btn" id="owner-cs2-save-bottom" style="flex: 1;">Save CS2 Config</button>
                    <button type="button" class="owner-btn-mini" id="owner-cs2-test-btn" style="width: auto; padding: 0 16px; height: 40px; background: rgba(255, 119, 0, 0.25); border: 1px solid #ff7700; color: #ffffff;" title="Test cover video now">▶ Test Cover Video</button>
                </div>
            </div>

            <!-- Status Footer -->
            <div class="owner-footer-status">
                <span class="owner-status-badge">
                    <span class="owner-status-dot ${dotClass}"></span>
                    <span id="owner-db-status">${statusText}</span>
                </span>
                <span>Press <code>Esc</code> or <code>✕</code> to close</span>
            </div>
        </div>
    `;

    const adminIcon = `<iconify-icon icon="fluent:settings-24-filled" width="18" height="18" style="color: #ff8c00"></iconify-icon>`;
    const win = openWindow("Admin Settings — Desktop & Wallpaper", contentHTML, adminIcon, winId, "owner-panel");

    // Tab switching
    const tabBtns = win.querySelectorAll(".owner-tab-btn");
    const tabContents = win.querySelectorAll(".owner-tab-content");
    tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            tabBtns.forEach(b => b.classList.remove("active"));
            tabContents.forEach(c => c.classList.remove("active"));
            btn.classList.add("active");
            const target = win.querySelector(`#${btn.getAttribute("data-tab")}`);
            if (target) target.classList.add("active");
        });
    });

    // --- Wallpaper Logic ---
    const wpInput = win.querySelector("#owner-wp-input");
    const wpPreview = win.querySelector("#owner-wp-preview");
    const wpSaveBtn = win.querySelector("#owner-wp-save");
    const wpResetBtn = win.querySelector("#owner-wp-reset");
    const wpDropzone = win.querySelector("#owner-wp-upload-dropzone");
    const wpBrowseBtn = win.querySelector("#owner-wp-browse-btn");
    const adminWpUploader = document.getElementById("admin-wallpaper-uploader");

    const processWallpaperFile = (file) => {
        if (!file || !file.type.startsWith("image/")) {
            showToast("Please select a valid image file.");
            return;
        }
        const reader = new FileReader();
        reader.onload = async (ev) => {
            const dataUrl = ev.target.result;
            if (wpPreview) wpPreview.style.backgroundImage = `url('${dataUrl}')`;
            if (wpInput) {
                wpInput.value = `[Uploaded: ${file.name}]`;
                wpInput.dataset.fullUrl = dataUrl;
            }
            setWallpaper(dataUrl);
            showToast(`Wallpaper uploaded and applied: "${file.name}"!`);
        };
        reader.readAsDataURL(file);
    };

    if (wpBrowseBtn) {
        wpBrowseBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (adminWpUploader) adminWpUploader.click();
        });
    }

    if (wpDropzone) {
        wpDropzone.addEventListener("click", () => {
            if (adminWpUploader) adminWpUploader.click();
        });
        wpDropzone.addEventListener("dragover", (e) => {
            e.preventDefault();
            wpDropzone.classList.add("drag-over");
        });
        wpDropzone.addEventListener("dragleave", () => {
            wpDropzone.classList.remove("drag-over");
        });
        wpDropzone.addEventListener("drop", (e) => {
            e.preventDefault();
            wpDropzone.classList.remove("drag-over");
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
                processWallpaperFile(e.dataTransfer.files[0]);
            }
        });
    }

    if (wpPreview) {
        wpPreview.addEventListener("dragover", (e) => {
            e.preventDefault();
            wpPreview.classList.add("drag-over");
        });
        wpPreview.addEventListener("dragleave", () => {
            wpPreview.classList.remove("drag-over");
        });
        wpPreview.addEventListener("drop", (e) => {
            e.preventDefault();
            wpPreview.classList.remove("drag-over");
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
                processWallpaperFile(e.dataTransfer.files[0]);
            }
        });
    }

    if (adminWpUploader) {
        adminWpUploader.onchange = () => {
            if (adminWpUploader.files && adminWpUploader.files[0]) {
                processWallpaperFile(adminWpUploader.files[0]);
                adminWpUploader.value = "";
            }
        };
    }

    if (wpInput) {
        wpInput.addEventListener("input", () => {
            delete wpInput.dataset.fullUrl;
            if (wpPreview) wpPreview.style.backgroundImage = `url('${wpInput.value.trim()}')`;
        });
    }

    if (wpResetBtn) {
        wpResetBtn.addEventListener("click", () => {
            if (wpInput) {
                wpInput.value = "wall.png";
                delete wpInput.dataset.fullUrl;
            }
            if (wpPreview) wpPreview.style.backgroundImage = "url('wall.png')";
            setWallpaper("wall.png");
            showToast("Wallpaper reset to default.");
        });
    }

    if (wpSaveBtn) {
        wpSaveBtn.addEventListener("click", async () => {
            const url = (wpInput && wpInput.dataset.fullUrl) ? wpInput.dataset.fullUrl : (wpInput ? wpInput.value.trim() : "");
            if (!url) return;
            wpSaveBtn.textContent = "Saving...";
            wpSaveBtn.disabled = true;

            const res = await saveWallpaper(url);
            setWallpaper(url);
            
            wpSaveBtn.textContent = "Save Wallpaper";
            wpSaveBtn.disabled = false;
            showToast(res.firestore ? "Wallpaper saved to Firebase Firestore!" : "Wallpaper saved to localStorage!");
        });
    }

    // --- Desktop Layout Logic ---
    const dtList = win.querySelector("#owner-dt-list");
    const dtSaveBtn = win.querySelector("#owner-dt-save");
    const addItemBtn = win.querySelector("#new-item-add");

    const renderDtList = () => {
        if (!dtList) return;
        dtList.innerHTML = "";
        currentDesktopData.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = "owner-list-item";
            row.innerHTML = `
                <div class="owner-item-info">
                    <span style="font-size: 16px;">${item.type === 'folder' ? '📁' : item.type === 'link' ? '🔗' : '📄'}</span>
                    <div>
                        <div class="owner-item-name">${escapeHTML(item.name)}</div>
                        <div class="owner-item-detail">${escapeHTML(item.type)}${item.url ? ' • ' + escapeHTML(item.url) : ''}</div>
                    </div>
                </div>
                <div class="owner-item-actions">
                    <button class="owner-btn-mini move-up" data-idx="${idx}" title="Move Up">▲</button>
                    <button class="owner-btn-mini move-down" data-idx="${idx}" title="Move Down">▼</button>
                    <button class="owner-btn-mini danger delete-item" data-idx="${idx}" title="Delete">✕</button>
                </div>
            `;
            dtList.appendChild(row);
        });

        // Event listeners for move / delete
        dtList.querySelectorAll(".move-up").forEach(b => {
            b.addEventListener("click", () => {
                const idx = parseInt(b.getAttribute("data-idx"), 10);
                if (idx > 0) {
                    const temp = currentDesktopData[idx];
                    currentDesktopData[idx] = currentDesktopData[idx - 1];
                    currentDesktopData[idx - 1] = temp;
                    renderDtList();
                    renderDesktop();
                }
            });
        });

        dtList.querySelectorAll(".move-down").forEach(b => {
            b.addEventListener("click", () => {
                const idx = parseInt(b.getAttribute("data-idx"), 10);
                if (idx < currentDesktopData.length - 1) {
                    const temp = currentDesktopData[idx];
                    currentDesktopData[idx] = currentDesktopData[idx + 1];
                    currentDesktopData[idx + 1] = temp;
                    renderDtList();
                    renderDesktop();
                }
            });
        });

        dtList.querySelectorAll(".delete-item").forEach(b => {
            b.addEventListener("click", () => {
                const idx = parseInt(b.getAttribute("data-idx"), 10);
                currentDesktopData.splice(idx, 1);
                renderDtList();
                renderDesktop();
            });
        });
    };

    renderDtList();

    if (addItemBtn) {
        addItemBtn.addEventListener("click", () => {
            const nameInput = win.querySelector("#new-item-name");
            const typeInput = win.querySelector("#new-item-type");
            const urlInput = win.querySelector("#new-item-url");
            const name = nameInput.value.trim();
            if (!name) return;

            const newItem = {
                name,
                type: typeInput.value,
            };
            if (newItem.type === 'link') {
                newItem.url = urlInput.value.trim() || 'https://google.com';
                newItem.customIcon = 'fluent:link-24-filled';
            } else if (newItem.type === 'folder') {
                newItem.content = [];
            }

            currentDesktopData.push(newItem);
            nameInput.value = "";
            urlInput.value = "";
            renderDtList();
            renderDesktop();
        });
    }

    if (dtSaveBtn) {
        dtSaveBtn.addEventListener("click", async () => {
            dtSaveBtn.textContent = "Saving...";
            dtSaveBtn.disabled = true;

            const res = await saveDesktopData(currentDesktopData);
            renderDesktop();

            dtSaveBtn.textContent = "Save Layout";
            dtSaveBtn.disabled = false;
            showToast(res.firestore ? "Desktop layout saved to Firebase Firestore!" : "Desktop layout saved to localStorage!");
        });
    }

    // --- Music Library Logic ---
    const mlList = win.querySelector("#owner-ml-list");
    const mlSaveBtn = win.querySelector("#owner-ml-save");
    const mlClearAllBtn = win.querySelector("#owner-ml-clear-all");
    const addSongBtn = win.querySelector("#new-song-add");

    const renderMlList = () => {
        if (!mlList) return;
        mlList.innerHTML = "";
        if (!currentMusicLibrary || currentMusicLibrary.length === 0) {
            mlList.innerHTML = `<div style="padding: 24px 12px; text-align: center; color: rgba(255,255,255,0.4); font-size: 13px;">No songs in library.<br>Add songs below or via the Music folder!</div>`;
            return;
        }

        currentMusicLibrary.forEach((song, idx) => {
            const row = document.createElement("div");
            row.className = "owner-list-item";
            row.innerHTML = `
                <div class="owner-item-info">
                    <img src="${song.cover || 'files/cover/song1.jpg'}" style="width: 28px; height: 28px; border-radius: 4px; object-fit: cover;" onerror="this.src='files/cover/song1.jpg'" />
                    <div>
                        <div class="owner-item-name">${escapeHTML(song.title)}</div>
                        <div class="owner-item-detail">${escapeHTML(song.artist || 'Unknown')} • ${escapeHTML(song.src)}</div>
                    </div>
                </div>
                <div class="owner-item-actions">
                    <button class="owner-btn-mini song-up" data-idx="${idx}" title="Move Up">▲</button>
                    <button class="owner-btn-mini song-down" data-idx="${idx}" title="Move Down">▼</button>
                    <button class="owner-btn-mini danger song-del" data-idx="${idx}" title="Delete">✕</button>
                </div>
            `;
            mlList.appendChild(row);
        });

        mlList.querySelectorAll(".song-up").forEach(b => {
            b.addEventListener("click", () => {
                const idx = parseInt(b.getAttribute("data-idx"), 10);
                if (idx > 0) {
                    const temp = currentMusicLibrary[idx];
                    currentMusicLibrary[idx] = currentMusicLibrary[idx - 1];
                    currentMusicLibrary[idx - 1] = temp;
                    renderMlList();
                    updateHDDUI();
                }
            });
        });

        mlList.querySelectorAll(".song-down").forEach(b => {
            b.addEventListener("click", () => {
                const idx = parseInt(b.getAttribute("data-idx"), 10);
                if (idx < currentMusicLibrary.length - 1) {
                    const temp = currentMusicLibrary[idx];
                    currentMusicLibrary[idx] = currentMusicLibrary[idx + 1];
                    currentMusicLibrary[idx + 1] = temp;
                    renderMlList();
                    updateHDDUI();
                }
            });
        });

        mlList.querySelectorAll(".song-del").forEach(b => {
            b.addEventListener("click", async () => {
                const idx = parseInt(b.getAttribute("data-idx"), 10);
                const deletedSong = currentMusicLibrary[idx];
                if (!deletedSong) return;

                currentMusicLibrary.splice(idx, 1);
                if (currentTrackIndex >= currentMusicLibrary.length) {
                    currentTrackIndex = Math.max(0, currentMusicLibrary.length - 1);
                }

                // Remove from Music folder in currentDesktopData as well
                const musicFolder = currentDesktopData.find(d => d.type === "folder" && d.name && d.name.toLowerCase() === "music");
                if (musicFolder && Array.isArray(musicFolder.content)) {
                    const mIdx = musicFolder.content.findIndex(c => 
                        (deletedSong.id && c.id && c.id === deletedSong.id) ||
                        (c.src && deletedSong.src && c.src === deletedSong.src) ||
                        (c.name && deletedSong.title && c.name.toLowerCase() === deletedSong.title.toLowerCase())
                    );
                    if (mIdx !== -1) {
                        musicFolder.content.splice(mIdx, 1);
                        await saveDesktopData(currentDesktopData);
                        const fWinId = `win-${musicFolder.name.toLowerCase().replace(/\s+/g, '-')}`;
                        const openWin = document.getElementById(fWinId);
                        if (openWin) openFolderWindow(musicFolder);
                    }
                }

                if (currentMusicLibrary.length === 0 || (audio.src && deletedSong && (audio.src.includes(deletedSong.src) || audio.src === deletedSong.src)) || (deletedSong && isYouTubeTrack(deletedSong) && currentPlayingYouTubeId === deletedSong.youtubeId)) {
                    audio.pause();
                    pauseYouTubeVideo();
                    audio.src = "";
                    isPlaying = false;
                }

                await saveMusicLibrary(currentMusicLibrary);
                renderMlList();
                updateHDDUI();
                showToast(`Deleted "${deletedSong.title}"`);
            });
        });
    };

    renderMlList();

    if (mlClearAllBtn) {
        mlClearAllBtn.addEventListener("click", async () => {
            const ok = await winConfirm("Are you sure you want to delete ALL songs in the music library? You will start with an empty library.", "Clear All Songs", true);
            if (!ok) return;

            currentMusicLibrary = [];
            currentTrackIndex = 0;
            audio.pause();
            pauseYouTubeVideo();
            audio.src = "";
            isPlaying = false;

            const musicFolder = currentDesktopData.find(d => d.type === "folder" && d.name && d.name.toLowerCase() === "music");
            if (musicFolder && Array.isArray(musicFolder.content)) {
                musicFolder.content = [];
                await saveDesktopData(currentDesktopData);
                const fWinId = `win-${musicFolder.name.toLowerCase().replace(/\s+/g, '-')}`;
                const openWin = document.getElementById(fWinId);
                if (openWin) openFolderWindow(musicFolder);
            }

            await saveMusicLibrary([]);
            renderMlList();
            updateHDDUI();
            showToast("All songs deleted from library.");
        });
    }

    const srcInputEl = win.querySelector("#new-song-src");
    if (srcInputEl) {
        srcInputEl.addEventListener("input", async () => {
            const val = srcInputEl.value.trim();
            if (!val) return;
            const meta = await fetchUniversalMediaMetadata(val);
            if (meta) {
                const titleInput = win.querySelector("#new-song-title");
                const artistInput = win.querySelector("#new-song-artist");
                const coverInput = win.querySelector("#new-song-cover");
                if (titleInput && (!titleInput.value || titleInput.value.includes("http") || titleInput.value.includes("youtu"))) {
                    titleInput.value = meta.cleanTitle || meta.title || "";
                }
                if (artistInput && (!artistInput.value || artistInput.value === "Unknown Artist" || artistInput.value === "YouTube")) {
                    artistInput.value = meta.artist || "";
                }
                if (coverInput && (!coverInput.value || coverInput.value.includes("song1.jpg"))) {
                    coverInput.value = meta.thumbnail || "";
                }
            }
        });
    }

    if (addSongBtn) {
        addSongBtn.addEventListener("click", async () => {
            const titleInput = win.querySelector("#new-song-title");
            const artistInput = win.querySelector("#new-song-artist");
            const srcInput = win.querySelector("#new-song-src");
            const coverInput = win.querySelector("#new-song-cover");

            const rawSrc = srcInput.value.trim() || "files/music/song1.mp3";
            const ytId = extractYouTubeId(rawSrc);
            const isYT = !!ytId;
            const isSp = isSpotifyTrack({ src: rawSrc });
            const isSc = isSoundCloudTrack({ src: rawSrc });
            const isGd = isGoogleDriveTrack({ src: rawSrc });
            const src = isYT ? `https://www.youtube.com/watch?v=${ytId}` : rawSrc;
            const title = titleInput.value.trim() || (isYT ? `YouTube Track (${ytId})` : isSp ? "Spotify Track" : isSc ? "SoundCloud Track" : "Custom Track");
            const artist = artistInput.value.trim() || (isYT ? "YouTube" : isSp ? "Spotify" : isSc ? "SoundCloud" : isGd ? "Google Drive" : "Unknown Artist");
            const cover = coverInput.value.trim() || (isYT ? getYouTubeThumbnail(ytId) : "files/cover/song1.jpg");

            if (!title) return;

            const newSong = {
                title,
                artist,
                src,
                cover,
                ...(isYT ? { isYouTube: true, youtubeId: ytId } : {}),
                ...(isSp ? { isSpotify: true } : {}),
                ...(isSc ? { isSoundCloud: true } : {}),
                ...(isGd ? { isGoogleDrive: true } : {})
            };
            currentMusicLibrary.push(newSong);

            // Also add to Music folder on desktop if present
            const musicFolder = currentDesktopData.find(d => d.type === "folder" && d.name && d.name.toLowerCase() === "music");
            if (musicFolder) {
                if (!Array.isArray(musicFolder.content)) musicFolder.content = [];
                musicFolder.content.push({
                    name: title,
                    type: "music",
                    artist,
                    src,
                    customIcon: cover,
                    ...(isYT ? { isYouTube: true, youtubeId: ytId } : {}),
                    ...(isSp ? { isSpotify: true } : {}),
                    ...(isSc ? { isSoundCloud: true } : {}),
                    ...(isGd ? { isGoogleDrive: true } : {})
                });
                await saveDesktopData(currentDesktopData);
                const fWinId = `win-${musicFolder.name.toLowerCase().replace(/\s+/g, '-')}`;
                const openWin = document.getElementById(fWinId);
                if (openWin) openFolderWindow(musicFolder);
            }

            await saveMusicLibrary(currentMusicLibrary);

            titleInput.value = "";
            artistInput.value = "";
            srcInput.value = "";
            coverInput.value = "";

            renderMlList();
            updateHDDUI();
            showToast(`Added "${title}" to library`);

            if (currentMusicLibrary.length === 1) {
                currentTrackIndex = 0;
                await playCurrentTrack();
            }
        });
    }

    if (mlSaveBtn) {
        mlSaveBtn.addEventListener("click", async () => {
            mlSaveBtn.textContent = "Saving...";
            mlSaveBtn.disabled = true;

            const res = await saveMusicLibrary(currentMusicLibrary);
            updateHDDUI();

            mlSaveBtn.textContent = "Save Music Library";
            mlSaveBtn.disabled = false;
            showToast(res.firestore ? "Music library saved to Firebase Firestore!" : "Music library saved to localStorage!");
        });
    }

    // --- CS2 & Leetify Settings Event Listeners ---
    const cs2VideoUrlInput = win.querySelector("#owner-cs2-video-url");
    const cs2VideoTitleInput = win.querySelector("#owner-cs2-video-title");
    const cs2ApiKeyInput = win.querySelector("#owner-cs2-api-key");
    const cs2LeetifyUrlInput = win.querySelector("#owner-cs2-leetify-url");
    const cs2SyncBtn = win.querySelector("#owner-cs2-sync-btn");
    const cs2SaveBtn = win.querySelector("#owner-cs2-save");
    const cs2SaveBtnBottom = win.querySelector("#owner-cs2-save-bottom");
    const cs2TestBtn = win.querySelector("#owner-cs2-test-btn");

    const handleCs2Save = async (showToastMsg = true) => {
        const updatedConfig = {
            ...currentCs2Config,
            videoUrl: (cs2VideoUrlInput && cs2VideoUrlInput.value.trim()) || "",
            videoTitle: (cs2VideoTitleInput && cs2VideoTitleInput.value.trim()) || "CS2 Cinematic Cover Video",
            leetifyApiKey: (cs2ApiKeyInput && cs2ApiKeyInput.value.trim()) || "cc554ec3-3db6-4f54-83b2-c070c40da483",
            leetifyUrl: (cs2LeetifyUrlInput && cs2LeetifyUrlInput.value.trim()) || "https://leetify.com/app/profile/76561199580350164"
        };

        saveCs2Config(updatedConfig);
        if (showToastMsg) {
            showToast("CS2 Cover & Leetify settings saved successfully!");
        }
    };

    if (cs2SyncBtn) {
        cs2SyncBtn.addEventListener("click", async () => {
            const key = (cs2ApiKeyInput && cs2ApiKeyInput.value.trim()) || "cc554ec3-3db6-4f54-83b2-c070c40da483";
            cs2SyncBtn.disabled = true;
            cs2SyncBtn.textContent = "Syncing...";
            await syncLeetifyStats(key);
            cs2SyncBtn.disabled = false;
            cs2SyncBtn.textContent = "⚡ Sync API";
            showToast("Leetify API synced successfully!");
        });
    }

    if (cs2SaveBtn) cs2SaveBtn.addEventListener("click", () => handleCs2Save(true));
    if (cs2SaveBtnBottom) cs2SaveBtnBottom.addEventListener("click", () => handleCs2Save(true));
    if (cs2TestBtn) {
        cs2TestBtn.addEventListener("click", () => {
            handleCs2Save(false);
            openCs2Experience();
        });
    }
}

// --- Taskbar Management (Icons Only) ---
function updateTaskbar() {
    const container = document.getElementById("taskbar-apps");
    if (!container) return;
    container.innerHTML = "";

    activeWindows.forEach(winObj => {
        const btn = document.createElement("div");
        btn.className = "taskbar-app";
        btn.title = winObj.title;
        btn.setAttribute("aria-label", winObj.title);
        const domWin = document.getElementById(winObj.id);
        if (domWin && !domWin.classList.contains("minimized")) {
            btn.classList.add("active");
        }

        btn.innerHTML = winObj.iconHTML || '<iconify-icon icon="fluent:app-generic-24-filled" width="22" height="22"></iconify-icon>';
        btn.addEventListener("click", () => {
            if (!domWin) return;
            if (domWin.classList.contains("minimized")) {
                domWin.classList.remove("minimized");
                bringToFront(domWin);
            } else {
                if (domWin.style.zIndex == zIndexCounter) {
                    domWin.classList.add("minimized");
                } else {
                    bringToFront(domWin);
                }
            }
            updateTaskbar();
        });

        container.appendChild(btn);
    });
}

// --- HDD Mini Player ---
function initHDDPlayer() {
    try {
        const existing = document.getElementById("hdd-mini-player");
        if (existing) return;

        currentMusicLibrary = sanitizeMusicLibrary(currentMusicLibrary);
        if (currentTrackIndex < 0 || currentTrackIndex >= currentMusicLibrary.length) {
            currentTrackIndex = 0;
        }

        const track = (currentMusicLibrary && currentMusicLibrary.length > 0) ? (currentMusicLibrary[currentTrackIndex] || currentMusicLibrary[0]) : null;
        const trackTitle = track ? (track.title || 'Unknown Track') : 'No tracks in library';
        const trackCover = track ? (track.cover || 'files/cover/song1.jpg') : 'files/cover/song1.jpg';

        const playerDiv = document.createElement("div");
        playerDiv.id = "hdd-mini-player";
        playerDiv.innerHTML = `
            <div class="hdd-base">
                <img src="${trackCover}" class="hdd-platter" id="hdd-cover" alt="Cover" />
            </div>
            <div class="hdd-info" id="hdd-track-name">${escapeHTML(trackTitle)}</div>
            <div class="hdd-controls">
                <button class="hdd-btn" id="hdd-prev-btn" title="Previous">⏮</button>
                <button class="hdd-btn" id="hdd-play-btn" title="Play">▶</button>
                <button class="hdd-btn" id="hdd-next-btn" title="Next">⏭</button>
            </div>
        `;

        const desktop = document.getElementById("desktop");
        if (desktop) {
            desktop.appendChild(playerDiv);
        } else {
            document.body.appendChild(playerDiv);
        }

        // Dragging support for HDD player
        let isDragging = false;
        let startX = 0, startY = 0, initLeft = 0, initTop = 0;

        playerDiv.addEventListener("mousedown", (e) => {
            if (e.target.closest(".hdd-controls")) return;
            isDragging = true;
            const rect = playerDiv.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            initLeft = rect.left;
            initTop = rect.top;

            const onMove = (ev) => {
                if (!isDragging) return;
                playerDiv.style.left = `${initLeft + (ev.clientX - startX)}px`;
                playerDiv.style.top = `${initTop + (ev.clientY - startY)}px`;
                playerDiv.style.right = "auto";
            };

            const onUp = () => {
                isDragging = false;
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
            };

            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        const playBtn = document.getElementById("hdd-play-btn");
        const prevBtn = document.getElementById("hdd-prev-btn");
        const nextBtn = document.getElementById("hdd-next-btn");

        if (playBtn) playBtn.addEventListener("click", togglePlay);
        if (prevBtn) prevBtn.addEventListener("click", prevTrack);
        if (nextBtn) nextBtn.addEventListener("click", nextTrack);

        audio.addEventListener("ended", nextTrack);
        audio.addEventListener("error", (err) => {
            console.warn("Audio playback issue with current track:", err);
            isPlaying = false;
            updateHDDUI();
        });
    } catch (e) {
        console.error("Error initializing HDD Mini Player:", e);
    }
}

function updateHDDUI() {
    const cover = document.getElementById("hdd-cover");
    const title = document.getElementById("hdd-track-name");
    const playBtn = document.getElementById("hdd-play-btn");
    const playerDiv = document.getElementById("hdd-mini-player");

    if (!Array.isArray(currentMusicLibrary) || currentMusicLibrary.length === 0) {
        if (cover) cover.src = "files/cover/song1.jpg";
        if (title) title.textContent = "No tracks in library";
        if (playBtn) playBtn.textContent = "▶";
        if (playerDiv) playerDiv.classList.remove("playing");
        return;
    }

    if (currentTrackIndex < 0 || currentTrackIndex >= currentMusicLibrary.length) {
        currentTrackIndex = 0;
    }
    const track = currentMusicLibrary[currentTrackIndex] || currentMusicLibrary[0];
    if (!track) return;

    if (cover) cover.src = track.cover || "files/cover/song1.jpg";
    if (title) title.textContent = track.title || "Unknown Track";
    if (playBtn) playBtn.textContent = isPlaying ? "⏸" : "▶";
    if (playerDiv) {
        if (isPlaying) playerDiv.classList.add("playing");
        else playerDiv.classList.remove("playing");
    }
}

export function stopExternalEmbeds() {
    const bridge = document.getElementById("bg-media-bridge");
    if (bridge) {
        const embeds = bridge.querySelectorAll(".bg-embed-frame");
        embeds.forEach(el => el.remove());
    }
}

export async function playCurrentTrack() {
    if (!Array.isArray(currentMusicLibrary) || currentMusicLibrary.length === 0) {
        updateHDDUI();
        return;
    }
    if (currentTrackIndex < 0 || currentTrackIndex >= currentMusicLibrary.length) {
        currentTrackIndex = 0;
    }
    const track = currentMusicLibrary[currentTrackIndex];
    if (!track) return;

    // Halt previous streams
    stopExternalEmbeds();

    if (isYouTubeTrack(track)) {
        // Audio-only YouTube playback via headless bridge
        audio.pause();
        audio.src = "";

        const videoId = track.youtubeId || extractYouTubeId(track.src);
        if (videoId) {
            playYouTubeVideo(videoId);
        } else {
            showToast("Invalid YouTube track source", false);
        }
    } else if (isSpotifyTrack(track)) {
        audio.pause();
        audio.src = "";
        pauseYouTubeVideo();

        const trackId = extractSpotifyTrackId(track.src);
        if (trackId) {
            let bridge = document.getElementById("bg-media-bridge");
            if (!bridge) {
                bridge = document.createElement("div");
                bridge.id = "bg-media-bridge";
                bridge.className = "bg-media-bridge";
                document.body.appendChild(bridge);
            }
            const iframe = document.createElement("iframe");
            iframe.className = "bg-embed-frame";
            iframe.src = `https://open.spotify.com/embed/track/${trackId}?utm_source=generator&theme=0&autoplay=1`;
            iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
            bridge.appendChild(iframe);
            isPlaying = true;
        }
    } else if (isSoundCloudTrack(track)) {
        audio.pause();
        audio.src = "";
        pauseYouTubeVideo();

        let bridge = document.getElementById("bg-media-bridge");
        if (!bridge) {
            bridge = document.createElement("div");
            bridge.id = "bg-media-bridge";
            bridge.className = "bg-media-bridge";
            document.body.appendChild(bridge);
        }
        const iframe = document.createElement("iframe");
        iframe.className = "bg-embed-frame";
        iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(track.src)}&auto_play=true&hide_related=true&show_comments=false&show_user=false&show_reposts=false&show_teaser=false`;
        iframe.allow = "autoplay";
        bridge.appendChild(iframe);
        isPlaying = true;
    } else {
        // Direct Audio & Google Drive streaming
        pauseYouTubeVideo();

        let actualSrc = await loadTrackSource(track);
        if (isGoogleDriveTrack(track) || isGoogleDriveTrack({ src: actualSrc })) {
            actualSrc = convertGoogleDriveAudioUrl(actualSrc);
        }
        if (!audio.src || !audio.src.includes(actualSrc)) {
            audio.src = actualSrc;
        }
        audio.play().catch(e => {
            console.warn("Audio autoplay blocked:", e);
        });
        isPlaying = true;
    }
    updateHDDUI();
}

export function pauseCurrentPlayback() {
    isPlaying = false;
    audio.pause();
    pauseYouTubeVideo();
    stopExternalEmbeds();
    updateHDDUI();
}

async function togglePlay() {
    if (!Array.isArray(currentMusicLibrary) || currentMusicLibrary.length === 0) {
        showToast("No tracks in library. Add songs via the Music folder!", false);
        return;
    }
    if (currentTrackIndex < 0 || currentTrackIndex >= currentMusicLibrary.length) {
        currentTrackIndex = 0;
    }
    const track = currentMusicLibrary[currentTrackIndex];
    if (!track) return;

    if (isPlaying) {
        pauseCurrentPlayback();
    } else {
        if (isYouTubeTrack(track)) {
            const videoId = track.youtubeId || extractYouTubeId(track.src);
            if (currentPlayingYouTubeId === videoId && ytPlayer) {
                resumeYouTubeVideo();
                isPlaying = true;
                updateHDDUI();
            } else {
                await playCurrentTrack();
            }
        } else if (isSpotifyTrack(track) || isSoundCloudTrack(track)) {
            await playCurrentTrack();
        } else {
            const actualSrc = await loadTrackSource(track);
            if (!audio.src || !audio.src.includes(actualSrc)) {
                audio.src = actualSrc;
            }
            audio.play().catch(e => {
                console.warn("Audio autoplay blocked:", e);
            });
            isPlaying = true;
            updateHDDUI();
        }
    }
}

async function nextTrack() {
    if (!Array.isArray(currentMusicLibrary) || currentMusicLibrary.length === 0) return;
    currentTrackIndex = (currentTrackIndex + 1) % currentMusicLibrary.length;
    await playCurrentTrack();
}

async function prevTrack() {
    if (!Array.isArray(currentMusicLibrary) || currentMusicLibrary.length === 0) return;
    currentTrackIndex = (currentTrackIndex - 1 + currentMusicLibrary.length) % currentMusicLibrary.length;
    await playCurrentTrack();
}

async function playTrackBySrc(src, name) {
    if (!Array.isArray(currentMusicLibrary) || currentMusicLibrary.length === 0) {
        currentMusicLibrary = sanitizeMusicLibrary([]);
    }
    const ytId = extractYouTubeId(src);
    const idx = currentMusicLibrary.findIndex(m => m && (m.src === src || m.title === name || m.name === name || (ytId && m.youtubeId === ytId)));
    if (idx !== -1) {
        currentTrackIndex = idx;
        await playCurrentTrack();
    } else {
        const isYT = !!ytId;
        const newTrack = {
            title: name || (isYT ? `YouTube Track` : "Track"),
            artist: isYT ? "YouTube" : "Unknown Artist",
            src: src,
            cover: isYT && ytId ? getYouTubeThumbnail(ytId) : "files/cover/song1.jpg",
            ...(isYT ? { isYouTube: true, youtubeId: ytId } : {})
        };
        currentMusicLibrary.push(newTrack);
        currentTrackIndex = currentMusicLibrary.length - 1;
        await playCurrentTrack();
    }
}

export async function playRandomTrack() {
    // Include any tracks from currentMusicLibrary and desktop "Music" folder
    let pool = Array.isArray(currentMusicLibrary) ? [...currentMusicLibrary] : [];
    const musicFolder = currentDesktopData.find(d => d.type === "folder" && d.name && d.name.toLowerCase() === "music");
    if (musicFolder && Array.isArray(musicFolder.content) && musicFolder.content.length > 0) {
        musicFolder.content.forEach(c => {
            if ((c.type === "music" || c.src) && !pool.some(p => p.src === c.src || p.title === c.name)) {
                const ytId = c.youtubeId || extractYouTubeId(c.src);
                const isYT = c.isYouTube || !!ytId;
                pool.push({
                    title: c.name,
                    artist: c.artist || (isYT ? "YouTube" : "SPIKETONES"),
                    src: c.src,
                    cover: c.customIcon || c.cover || (isYT && ytId ? getYouTubeThumbnail(ytId) : "files/cover/song1.jpg"),
                    ...(c.id ? { id: c.id } : {}),
                    ...(isYT ? { isYouTube: true, youtubeId: ytId } : {}),
                    ...(c.isLocalUpload ? { isLocalUpload: true } : {}),
                    ...(c.isLinkStream ? { isLinkStream: true } : {})
                });
            }
        });
    }

    if (pool.length === 0) return;

    // Pick a random track from the pool
    const randIdx = Math.floor(Math.random() * pool.length);
    const chosen = pool[randIdx];

    let libIdx = currentMusicLibrary.findIndex(m => (chosen.src && m.src === chosen.src) || (chosen.title && m.title === chosen.title));
    if (libIdx === -1) {
        currentMusicLibrary.push(chosen);
        libIdx = currentMusicLibrary.length - 1;
    }
    currentTrackIndex = libIdx;
    await playCurrentTrack();
    showToast(`Now Playing: ${chosen.title || "Track"} 🎵`);
}

// --- Start Menu & User Switcher System ---
export function toggleStartMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById("start-menu");
    if (!menu) return;
    menu.classList.toggle("active");
    if (menu.classList.contains("active")) {
        renderStartMenuApps();
    } else {
        const popup = document.getElementById("user-switcher-popup");
        if (popup) popup.classList.remove("visible");
    }
}

export function toggleUserSwitcher(e) {
    if (e) e.stopPropagation();
    const popup = document.getElementById("user-switcher-popup");
    if (!popup) return;
    popup.classList.toggle("visible");
}

export function switchUser(userType) {
    const popup = document.getElementById("user-switcher-popup");
    if (popup) popup.classList.remove("visible");
    const startMenu = document.getElementById("start-menu");
    if (startMenu) startMenu.classList.remove("active");

    if (userType === "admin") {
        selectLockUser("admin");
        lockSystem();
        return;
    }

    // Switch to guest with Windows 11 Welcome screen
    selectLockUser("guest");
    lockSystem();
}

function updateUserUI() {
    const avatarEl = document.getElementById("start-user-avatar");
    const nameEl = document.getElementById("start-user-name");
    const roleEl = document.getElementById("start-user-role");
    const pillEl = document.getElementById("start-account-pill");
    const optGuest = document.getElementById("user-opt-guest");
    const optAdmin = document.getElementById("user-opt-admin");
    const adminBar = document.getElementById("admin-quick-bar");

    document.body.classList.toggle("user-admin", currentUser === "admin");

    // Dynamic control updates across open windows
    document.querySelectorAll(".win-btn.pin-btn").forEach(btn => {
        btn.style.display = currentUser === "admin" ? "" : "none";
    });

    document.querySelectorAll(".notepad-btn").forEach(btn => {
        btn.style.display = currentUser === "admin" ? "" : "none";
    });

    document.querySelectorAll(".notepad-textarea").forEach(ta => {
        ta.readOnly = (currentUser !== "admin");
    });

    const fbWidget = document.getElementById("firebase-status-widget");
    if (fbWidget) {
        fbWidget.style.display = currentUser === "admin" ? "inline-flex" : "none";
    }

    if (activeGuestbookRender) {
        fetchGuestbook().then(activeGuestbookRender);
    }

    if (currentUser === "admin") {
        isOwner = true;
        if (avatarEl) {
            avatarEl.textContent = "S";
            avatarEl.className = "start-user-avatar admin";
        }
        if (nameEl) nameEl.textContent = "SPIKETONES007";
        if (roleEl) {
            roleEl.textContent = "Admin";
            roleEl.className = "start-user-role admin";
        }
        if (pillEl) {
            pillEl.textContent = "Admin Mode";
            pillEl.className = "start-account-pill admin";
        }
        if (optGuest) optGuest.classList.remove("active");
        if (optAdmin) optAdmin.classList.add("active");
        if (adminBar) adminBar.style.display = "block";
        const stickyContainer = document.getElementById("sticky-notes-container");
        if (stickyContainer) stickyContainer.style.display = "block";
    } else {
        isOwner = false;
        if (avatarEl) {
            avatarEl.textContent = "👤";
            avatarEl.className = "start-user-avatar guest";
        }
        if (nameEl) nameEl.textContent = "Guest";
        if (roleEl) {
            roleEl.textContent = "Visitor";
            roleEl.className = "start-user-role";
        }
        if (pillEl) {
            pillEl.textContent = "Visitor";
            pillEl.className = "start-account-pill";
        }
        if (optGuest) optGuest.classList.add("active");
        if (optAdmin) optAdmin.classList.remove("active");
        if (adminBar) adminBar.style.display = "none";
        const stickyContainer = document.getElementById("sticky-notes-container");
        if (stickyContainer) stickyContainer.style.display = "none";
    }
}

function renderStartMenuApps() {
    const grid = document.getElementById("start-grid");
    if (!grid) return;
    grid.innerHTML = "";

    // Base items from currentDesktopData
    const baseItems = currentDesktopData.filter(item => {
        const isSticky = (item.type === "stickynotes" || (item.name && item.name.toLowerCase() === "sticky notes"));
        if (currentUser !== "admin" && isSticky) {
            return false;
        }
        if (currentUser !== "admin" && item.hiddenForGuest) {
            return false;
        }
        return true;
    });

    const standardApps = [
        { name: "Calculator", type: "calculator", customIcon: "fluent:calculator-24-filled" },
        { name: "Paint", type: "paint", customIcon: "fluent:paint-brush-24-filled" },
        { name: "Terminal", type: "terminal", customIcon: "fluent:window-console-20-filled" },
        { name: "Snake Game", type: "snake", customIcon: "fluent:games-24-filled" }
    ];

    const itemsToShow = [...baseItems];
    standardApps.forEach(app => {
        const exists = itemsToShow.some(i => 
            i.type === app.type || 
            (i.name && i.name.toLowerCase() === app.name.toLowerCase()) ||
            (app.type === "calculator" && i.type === "calc")
        );
        if (!exists) {
            itemsToShow.push(app);
        }
    });

    if (currentUser === "admin") {
        if (!itemsToShow.some(i => i.type === "admin_settings" || (i.name && i.name.toLowerCase() === "admin settings"))) {
            itemsToShow.push({
                name: "Admin Settings",
                type: "admin_settings",
                customIcon: "fluent:settings-24-filled"
            });
        }
    }

    itemsToShow.forEach(item => {
        const itemDiv = document.createElement("div");
        itemDiv.className = "start-app";
        itemDiv.innerHTML = `
            ${getIconHTML(item, "medium")}
            <span>${escapeHTML(item.name)}</span>
        `;
        itemDiv.addEventListener("click", () => {
            toggleStartMenu();
            handleItemClick(item);
        });
        grid.appendChild(itemDiv);
    });
}

function updateClocks() {
    const now = new Date();
    
    // Taskbar clock: Two lines (Time on top, Date on bottom) matching reference image
    const hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const formattedHours = String(hours % 12 || 12).padStart(2, '0');
    const timeStr = `${formattedHours}:${minutes} ${ampm}`;
    
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const year = now.getFullYear();
    const dateStr = `${month}/${day}/${year}`;

    const clockEl = document.getElementById("clock");
    if (clockEl) {
        clockEl.innerHTML = `<div class="clock-time">${timeStr}</div><div class="clock-date">${dateStr}</div>`;
    }

    // Mond Widget on Desktop
    const days = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    const months = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
    
    const mondDay = document.getElementById("mond-day");
    if (mondDay) mondDay.textContent = days[now.getDay()];

    const mondDate = document.getElementById("mond-date");
    if (mondDate) mondDate.textContent = `${now.getDate()} ${months[now.getMonth()]}, ${year}.`;

    const mondClock = document.getElementById("mond-clock");
    if (mondClock) mondClock.textContent = `- ${timeStr} -`;
}

function escapeHTML(str) {
    if (typeof str !== 'string') return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Power Actions
export function powerAction(action) {
    const menu = document.getElementById("start-menu");
    if (menu) menu.classList.remove("active");

    if (action === "sleep") {
        const overlay = document.getElementById("sleep-overlay");
        if (overlay) overlay.classList.add("active");
    } else if (action === "restart") {
        clearCorruptedLocalCache();
        window.location.reload();
    }
}

export function wakeUp() {
    const overlay = document.getElementById("sleep-overlay");
    if (overlay) overlay.classList.remove("active");
}

// --- Global Right-Click Context Menu & Personalization Window ---
let activeContextTarget = null;
let targetItemForCover = null;
let targetFolderForCover = null;

function initContextMenu() {
    // Intercept and completely suppress browser native context menu across entire window
    window.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        handleGlobalContextMenu(e);
    }, { capture: true });

    document.addEventListener("click", (e) => {
        const menu = document.getElementById("desktop-context-menu");
        if (menu && !e.target.closest("#desktop-context-menu")) {
            menu.style.display = "none";
        }
    });
}

function handleGlobalContextMenu(e) {
    const menu = document.getElementById("desktop-context-menu");
    if (!menu) return;

    // Detect if right click is inside a folder window
    const folderWin = e.target.closest(".window.folder-window");
    const folderName = folderWin ? (folderWin.getAttribute("data-folder-name") || (folderWin.folderItemRef && folderWin.folderItemRef.name)) : null;
    let activeFolder = folderName ? findFolderItem(folderName) : null;
    if (!activeFolder && folderWin && folderWin.folderItemRef) {
        activeFolder = folderWin.folderItemRef;
    }
    if (activeFolder) {
        currentTargetFolder = activeFolder;
        if (folderWin) folderWin.folderItemRef = activeFolder;
    }

    // 1. Check if clicking on an icon (desktop or folder child)
    const iconEl = e.target.closest(".icon");
    if (iconEl) {
        if (iconEl.classList.contains("folder-child") && activeFolder) {
            const idx = parseInt(iconEl.getAttribute("data-idx"), 10);
            const item = activeFolder.content?.[idx];
            if (item) {
                activeContextTarget = { type: "folder_child", folder: activeFolder, index: idx, item };
                renderContextMenuForTarget(activeContextTarget, e);
                return;
            }
        } else if (iconEl.hasAttribute("data-index")) {
            const idx = parseInt(iconEl.getAttribute("data-index"), 10);
            const item = currentDesktopData[idx];
            if (item) {
                activeContextTarget = { type: "desktop_item", index: idx, item };
                renderContextMenuForTarget(activeContextTarget, e);
                return;
            }
        }
    }

    // 2. Check if clicking inside a folder window (background)
    if (folderWin && activeFolder) {
        activeContextTarget = { type: "folder_bg", folder: activeFolder };
        renderContextMenuForTarget(activeContextTarget, e);
        return;
    }

    // 3. Otherwise desktop background
    activeContextTarget = { type: "desktop_bg" };
    renderContextMenuForTarget(activeContextTarget, e);
}

function renderContextMenuForTarget(target, e) {
    const menu = document.getElementById("desktop-context-menu");
    if (!menu) return;

    let html = "";

    if (target.type === "desktop_item" || target.type === "folder_child") {
        const item = target.item;
        html += `<div class="ctx-header" style="padding: 6px 10px; font-size: 11px; color: rgba(255,255,255,0.45); border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHTML(item.name)}</div>`;
        html += `<div class="ctx-item" id="ctx-open"><iconify-icon icon="fluent:open-24-filled" width="16" height="16"></iconify-icon><span>Open</span></div>`;
        
        if (currentUser === "admin") {
            html += `<div class="ctx-separator"></div>`;
            const eyeIcon = item.hiddenForGuest ? "fluent:eye-24-filled" : "fluent:eye-off-24-filled";
            const eyeLabel = item.hiddenForGuest ? "Unhide for Guest" : "Hide for Guest";
            html += `<div class="ctx-item" id="ctx-toggle-hide"><iconify-icon icon="${eyeIcon}" width="16" height="16"></iconify-icon><span>${eyeLabel}</span></div>`;
            html += `<div class="ctx-item" id="ctx-rename"><iconify-icon icon="fluent:rename-24-filled" width="16" height="16"></iconify-icon><span>Rename</span></div>`;
            html += `<div class="ctx-item" id="ctx-change-cover"><iconify-icon icon="fluent:image-edit-24-filled" width="16" height="16"></iconify-icon><span>Upload Custom Cover Art</span></div>`;
            html += `<div class="ctx-separator"></div>`;
            html += `<div class="ctx-item danger" id="ctx-delete"><iconify-icon icon="fluent:delete-24-filled" width="16" height="16" style="color: #ff5252;"></iconify-icon><span style="color: #ff5252;">Delete</span></div>`;
        }
    } else if (target.type === "folder_bg") {
        html += `<div class="ctx-header" style="padding: 6px 10px; font-size: 11px; color: rgba(255,255,255,0.45); border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 4px;">📁 ${escapeHTML(target.folder.name)}</div>`;
        if (currentUser === "admin") {
            html += `<div class="ctx-item" id="ctx-folder-newfolder"><iconify-icon icon="fluent:folder-add-24-filled" width="16" height="16"></iconify-icon><span>New Folder</span></div>`;
            html += `<div class="ctx-item" id="ctx-folder-newfile"><iconify-icon icon="fluent:document-add-24-filled" width="16" height="16"></iconify-icon><span>New Text Document</span></div>`;
            html += `<div class="ctx-item" id="ctx-folder-newlink"><iconify-icon icon="fluent:link-add-24-filled" width="16" height="16" style="color: #00a2ed;"></iconify-icon><span>New Web Link</span></div>`;
            html += `<div class="ctx-item" id="ctx-folder-upload"><iconify-icon icon="fluent:arrow-upload-24-filled" width="16" height="16"></iconify-icon><span>Upload File</span></div>`;
            if (target.folder.name.toLowerCase() === "music") {
                html += `<div class="ctx-item" id="ctx-folder-upload-music"><iconify-icon icon="fluent:music-note-2-24-filled" width="16" height="16"></iconify-icon><span>Upload Music & Cover</span></div>`;
            }
            html += `<div class="ctx-separator"></div>`;
        }
        html += `<div class="ctx-item" id="ctx-folder-refresh"><iconify-icon icon="fluent:arrow-clockwise-24-filled" width="16" height="16"></iconify-icon><span>Refresh</span></div>`;
    } else {
        // Desktop Background
        if (currentUser === "admin") {
            html += `<div class="ctx-item" id="ctx-personalize"><iconify-icon icon="fluent:paint-brush-24-filled" width="16" height="16" style="color: #ff8c00;"></iconify-icon><span>Personalize (Wallpaper)</span></div>`;
            html += `<div class="ctx-separator"></div>`;
            html += `<div class="ctx-item" id="ctx-desktop-newfolder"><iconify-icon icon="fluent:folder-add-24-filled" width="16" height="16"></iconify-icon><span>New Folder</span></div>`;
            html += `<div class="ctx-item" id="ctx-desktop-newfile"><iconify-icon icon="fluent:document-add-24-filled" width="16" height="16"></iconify-icon><span>New Text Document</span></div>`;
            html += `<div class="ctx-item" id="ctx-desktop-newlink"><iconify-icon icon="fluent:link-add-24-filled" width="16" height="16" style="color: #00a2ed;"></iconify-icon><span>New Web Link</span></div>`;
            html += `<div class="ctx-item" id="ctx-desktop-upload-music"><iconify-icon icon="fluent:music-note-2-24-filled" width="16" height="16"></iconify-icon><span>Upload Music & Cover</span></div>`;
            html += `<div class="ctx-item" id="ctx-desktop-upload"><iconify-icon icon="fluent:arrow-upload-24-filled" width="16" height="16"></iconify-icon><span>Upload File</span></div>`;
            html += `<div class="ctx-separator"></div>`;
        }
        html += `<div class="ctx-item" id="ctx-desktop-refresh"><iconify-icon icon="fluent:arrow-clockwise-24-filled" width="16" height="16"></iconify-icon><span>Refresh</span></div>`;
    }

    menu.innerHTML = html;

    // Attach listeners
    attachContextMenuHandlers(target);

    // Calculate positioning
    const menuWidth = 230;
    const menuHeight = 320;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 20);

    menu.style.left = `${Math.max(10, x)}px`;
    menu.style.top = `${Math.max(10, y)}px`;
    menu.style.display = "flex";
}

function attachContextMenuHandlers(target) {
    const menu = document.getElementById("desktop-context-menu");
    const closeMenu = () => { if (menu) menu.style.display = "none"; };

    const btnOpen = document.getElementById("ctx-open");
    if (btnOpen) {
        btnOpen.addEventListener("click", () => {
            closeMenu();
            handleItemClick(target.item);
        });
    }

    const btnToggleHide = document.getElementById("ctx-toggle-hide");
    if (btnToggleHide) {
        btnToggleHide.addEventListener("click", () => {
            closeMenu();
            target.item.hiddenForGuest = !target.item.hiddenForGuest;
            saveDesktopData(currentDesktopData);
            if (target.type === "folder_child" && target.folder) {
                const liveFolder = findFolderItem(target.folder.name) || target.folder;
                openFolderWindow(liveFolder);
            } else {
                renderDesktop();
            }
            showToast(`"${target.item.name}" is now ${target.item.hiddenForGuest ? 'hidden for guests (closed eye icon)' : 'visible to guests'}`);
        });
    }

    const btnRename = document.getElementById("ctx-rename");
    if (btnRename) {
        btnRename.addEventListener("click", async () => {
            closeMenu();
            const newName = await winPrompt("Enter new name:", target.item.name, "Rename Item");
            if (newName && newName.trim()) {
                const oldName = target.item.name;
                target.item.name = newName.trim();
                
                // If this is a music track, also update in library
                if (target.item.type === "music") {
                    const song = currentMusicLibrary.find(s => s.title === oldName);
                    if (song) song.title = newName.trim();
                    saveMusicLibrary(currentMusicLibrary);
                    updateHDDUI();
                }

                saveDesktopData(currentDesktopData);
                if (target.type === "folder_child" && target.folder) {
                    const liveFolder = findFolderItem(target.folder.name) || target.folder;
                    openFolderWindow(liveFolder);
                } else {
                    renderDesktop();
                }
                showToast(`Renamed to "${newName.trim()}"`);
            }
        });
    }

    const btnChangeCover = document.getElementById("ctx-change-cover");
    if (btnChangeCover) {
        btnChangeCover.addEventListener("click", () => {
            closeMenu();
            targetItemForCover = target.item;
            targetFolderForCover = target.folder || null;
            const uploader = document.getElementById("cover-art-uploader");
            if (uploader) uploader.click();
        });
    }

    const btnDelete = document.getElementById("ctx-delete");
    if (btnDelete) {
        btnDelete.addEventListener("click", async () => {
            closeMenu();
            if (currentUser !== "admin") {
                showToast("Only SPIKETONES007 can delete items.");
                return;
            }
            const confirmed = await winConfirm(`Are you sure you want to permanently delete "${target.item.name}"?`, "Delete Item", true);
            if (confirmed) {
                const itemName = target.item.name;
                const isMusic = target.item.type === "music" || (target.folder && target.folder.name.toLowerCase() === "music");
                
                if (target.type === "folder_child" && target.folder) {
                    const liveFolder = findFolderItem(target.folder.name) || target.folder;
                    if (Array.isArray(liveFolder.content)) {
                        let idx = liveFolder.content.findIndex(c => c === target.item || (c.name === itemName && c.type === target.item.type));
                        if (idx !== -1) {
                            liveFolder.content.splice(idx, 1);
                        }
                    }
                    openFolderWindow(liveFolder);
                } else {
                    let idx = currentDesktopData.findIndex(d => d === target.item || (d.name === itemName && d.type === target.item.type));
                    if (idx !== -1) {
                        currentDesktopData.splice(idx, 1);
                    }
                    renderDesktop();
                }

                // If this is a music track, also remove from music library and update player
                if (isMusic) {
                    const trackIdx = currentMusicLibrary.findIndex(s => 
                        s.title.toLowerCase() === itemName.toLowerCase() || 
                        (target.item.src && s.src === target.item.src)
                    );
                    if (trackIdx !== -1) {
                        const wasPlayingDeleted = (trackIdx === currentTrackIndex && isPlaying);
                        currentMusicLibrary.splice(trackIdx, 1);
                        if (currentMusicLibrary.length === 0) {
                            currentTrackIndex = 0;
                            audio.pause();
                            pauseYouTubeVideo();
                            audio.src = "";
                            isPlaying = false;
                        } else if (currentTrackIndex >= currentMusicLibrary.length) {
                            currentTrackIndex = Math.max(0, currentMusicLibrary.length - 1);
                            if (wasPlayingDeleted) {
                                playCurrentTrack();
                            }
                        } else if (wasPlayingDeleted) {
                            playCurrentTrack();
                        }
                        saveMusicLibrary(currentMusicLibrary);
                        updateHDDUI();
                    }
                }

                saveDesktopData(currentDesktopData);
                showToast(`Deleted "${itemName}"`);
            }
        });
    }

    const btnPersonalize = document.getElementById("ctx-personalize");
    if (btnPersonalize) {
        btnPersonalize.addEventListener("click", () => {
            closeMenu();
            openPersonalizationWindow();
        });
    }

    // Folder Actions
    const btnFNewFolder = document.getElementById("ctx-folder-newfolder");
    if (btnFNewFolder) {
        btnFNewFolder.addEventListener("click", async () => {
            closeMenu();
            if (currentUser !== "admin") return;
            const liveFolder = findFolderItem(target.folder.name) || target.folder;
            let defaultName = "New Folder";
            let counter = 2;
            while (liveFolder.content && liveFolder.content.some(item => item.name === defaultName)) {
                defaultName = `New Folder (${counter++})`;
            }
            const name = await winPrompt("Enter folder name:", defaultName, "Create Folder");
            if (name && name.trim()) {
                if (!liveFolder.content) liveFolder.content = [];
                liveFolder.content.push({ name: name.trim(), type: "folder", content: [] });
                saveDesktopData(currentDesktopData);
                openFolderWindow(liveFolder);
                showToast(`Created folder "${name.trim()}"`);
            }
        });
    }

    const btnFNewFile = document.getElementById("ctx-folder-newfile");
    if (btnFNewFile) {
        btnFNewFile.addEventListener("click", async () => {
            closeMenu();
            if (currentUser !== "admin") return;
            const liveFolder = findFolderItem(target.folder.name) || target.folder;
            let defaultName = "New Document.txt";
            let counter = 2;
            while (liveFolder.content && liveFolder.content.some(item => item.name === defaultName)) {
                defaultName = `New Document (${counter++}).txt`;
            }
            let name = await winPrompt("Enter document name:", defaultName, "Create Text Document");
            if (name && name.trim()) {
                name = name.trim();
                if (!name.endsWith(".txt")) name += ".txt";
                if (!liveFolder.content) liveFolder.content = [];
                liveFolder.content.push({ name, type: "file" });
                fileContentMap[name] = "";
                saveDesktopData(currentDesktopData);
                openFolderWindow(liveFolder);
                openNotepad(name, "");
                showToast(`Created file "${name}"`);
            }
        });
    }

    const btnFNewLink = document.getElementById("ctx-folder-newlink");
    if (btnFNewLink) {
        btnFNewLink.addEventListener("click", () => {
            closeMenu();
            if (currentUser !== "admin") return;
            const liveFolder = findFolderItem(target.folder.name) || target.folder;
            showNewLinkDialog(liveFolder);
        });
    }

    const btnFUpload = document.getElementById("ctx-folder-upload");
    if (btnFUpload) {
        btnFUpload.addEventListener("click", () => {
            closeMenu();
            currentTargetFolder = findFolderItem(target.folder.name) || target.folder;
            const uploader = document.getElementById("folder-file-uploader");
            if (uploader) uploader.click();
        });
    }

    const btnFUploadMusic = document.getElementById("ctx-folder-upload-music");
    if (btnFUploadMusic) {
        btnFUploadMusic.addEventListener("click", () => {
            closeMenu();
            const liveFolder = findFolderItem(target.folder.name) || target.folder;
            openMusicUploadModal(liveFolder);
        });
    }

    const btnFRefresh = document.getElementById("ctx-folder-refresh");
    if (btnFRefresh) {
        btnFRefresh.addEventListener("click", () => {
            closeMenu();
            const liveFolder = findFolderItem(target.folder.name) || target.folder;
            openFolderWindow(liveFolder);
        });
    }

    // Desktop Actions
    const btnDNewFolder = document.getElementById("ctx-desktop-newfolder");
    if (btnDNewFolder) {
        btnDNewFolder.addEventListener("click", () => {
            closeMenu();
            contextNewFolder();
        });
    }

    const btnDNewFile = document.getElementById("ctx-desktop-newfile");
    if (btnDNewFile) {
        btnDNewFile.addEventListener("click", () => {
            closeMenu();
            contextNewTextFile();
        });
    }

    const btnDNewLink = document.getElementById("ctx-desktop-newlink");
    if (btnDNewLink) {
        btnDNewLink.addEventListener("click", () => {
            closeMenu();
            showNewLinkDialog(null);
        });
    }

    const btnDUploadMusic = document.getElementById("ctx-desktop-upload-music");
    if (btnDUploadMusic) {
        btnDUploadMusic.addEventListener("click", () => {
            closeMenu();
            openMusicUploadModal(null);
        });
    }

    const btnDUpload = document.getElementById("ctx-desktop-upload");
    if (btnDUpload) {
        btnDUpload.addEventListener("click", () => {
            closeMenu();
            triggerDesktopUpload();
        });
    }

    const btnDRefresh = document.getElementById("ctx-desktop-refresh");
    if (btnDRefresh) {
        btnDRefresh.addEventListener("click", () => {
            closeMenu();
            renderDesktop();
            showToast("Desktop refreshed");
        });
    }
}

// --- Personalization Window System ---
export function openPersonalizationWindow() {
    if (currentUser !== "admin") {
        showToast("Personalization settings are restricted to administrator.");
        return;
    }
    const winId = "win-personalization";
    const existing = document.getElementById(winId);
    if (existing) {
        existing.classList.remove("minimized");
        bringToFront(existing);
        updateTaskbar();
        return;
    }

    const persIcon = `<iconify-icon icon="fluent:paint-brush-24-filled" width="18" height="18" style="color: #ff8c00"></iconify-icon>`;
    const contentHTML = `
        <div class="personalize-container">
            <div class="personalize-section-title">Current Wallpaper</div>
            <div class="personalize-current-box">
                <img src="${currentWallpaper}" id="personalize-preview-img" class="personalize-preview-img" alt="Wallpaper Preview" />
            </div>

            <div class="personalize-section-title">Upload Custom Wallpaper</div>
            <div class="personalize-upload-dropzone" id="personalize-dropzone">
                <iconify-icon icon="fluent:image-arrow-counterclockwise-24-filled" width="28" height="28" style="color: #c85627;"></iconify-icon>
                <div style="font-size: 13px; font-weight: 500;">Click to browse or drag & drop wallpaper image</div>
                <div style="font-size: 11px; color: rgba(255,255,255,0.45);">Applies to both Desktop and Sign-In screen</div>
            </div>

            <div class="personalize-section-title">Wallpaper Presets</div>
            <div class="personalize-preset-grid">
                <div class="personalize-preset-card" data-url="wall.png">
                    <img src="wall.png" alt="Warm Sunset" />
                    <span>Warm Sunset</span>
                </div>
                <div class="personalize-preset-card" data-url="files/Monochrome.png">
                    <img src="files/Monochrome.png" alt="Monochrome" />
                    <span>Monochrome</span>
                </div>
                <div class="personalize-preset-card" data-url="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1920&q=80">
                    <img src="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=300&q=80" alt="Fluent Waves" />
                    <span>Fluent Waves</span>
                </div>
                <div class="personalize-preset-card" data-url="https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1920&q=80">
                    <img src="https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=300&q=80" alt="Dark Alpine" />
                    <span>Dark Alpine</span>
                </div>
            </div>
        </div>
    `;

    const win = openWindow("Personalization", contentHTML, persIcon, winId, "personalize-window");

    const dropzone = win.querySelector("#personalize-dropzone");
    const previewImg = win.querySelector("#personalize-preview-img");
    const wallpaperInput = document.getElementById("wallpaper-file-input");

    if (dropzone && wallpaperInput) {
        dropzone.addEventListener("click", () => wallpaperInput.click());

        dropzone.addEventListener("dragover", (e) => {
            e.preventDefault();
            dropzone.classList.add("drag-over");
        });
        dropzone.addEventListener("dragleave", () => {
            dropzone.classList.remove("drag-over");
        });
        dropzone.addEventListener("drop", (e) => {
            e.preventDefault();
            dropzone.classList.remove("drag-over");
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                const file = e.dataTransfer.files[0];
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const dataUrl = ev.target.result;
                    setWallpaper(dataUrl);
                    if (previewImg) previewImg.src = dataUrl;
                    showToast("New wallpaper applied to Desktop and Sign-In Screen!");
                };
                reader.readAsDataURL(file);
            }
        });
    }

    win.querySelectorAll(".personalize-preset-card").forEach(card => {
        card.addEventListener("click", () => {
            const url = card.getAttribute("data-url");
            setWallpaper(url);
            if (previewImg) previewImg.src = url;
            showToast("Wallpaper updated!");
        });
    });
}

export async function contextNewFolder() {
    if (currentUser !== "admin") return;
    let defaultName = "New Folder";
    let counter = 2;
    while (currentDesktopData.some(item => item.name === defaultName)) {
        defaultName = `New Folder (${counter++})`;
    }
    const name = await winPrompt("Enter folder name:", defaultName, "Create Folder");
    if (!name || !name.trim()) return;
    
    currentDesktopData.push({
        name: name.trim(),
        type: "folder",
        content: []
    });
    
    saveDesktopData(currentDesktopData);
    renderDesktop();
    showToast(`Created folder "${name.trim()}"`);
}

export async function contextNewTextFile() {
    if (currentUser !== "admin") return;
    let defaultName = "New Document.txt";
    let counter = 2;
    while (currentDesktopData.some(item => item.name === defaultName)) {
        defaultName = `New Document (${counter++}).txt`;
    }
    let name = await winPrompt("Enter document name:", defaultName, "Create Text Document");
    if (!name || !name.trim()) return;
    name = name.trim();
    if (!name.endsWith(".txt")) name += ".txt";
    
    currentDesktopData.push({
        name,
        type: "file"
    });
    
    fileContentMap[name] = "";
    saveDesktopData(currentDesktopData);
    renderDesktop();
    openNotepad(name, "");
    showToast(`Created "${name}"`);
}

// --- Desktop Drag-to-Select (Marquee Rectangle Selection) ---
export function initDesktopDragSelect() {
    const desktop = document.getElementById("desktop");
    const selectionBox = document.getElementById("desktop-selection-box");
    if (!desktop || !selectionBox) return;

    let isSelecting = false;
    let startX = 0;
    let startY = 0;

    desktop.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(".window") || 
            e.target.closest(".taskbar") || 
            e.target.closest("#mond-widget") || 
            e.target.closest(".sticky-note") || 
            e.target.closest("#start-menu") || 
            e.target.closest("#action-center-flyout") || 
            e.target.closest("#desktop-context-menu") || 
            e.target.closest(".win-dialog-backdrop")) {
            return;
        }

        const clickedIcon = e.target.closest(".icon");
        if (clickedIcon) {
            if (!e.ctrlKey && !e.shiftKey) {
                document.querySelectorAll(".icon.selected").forEach(el => {
                    if (el !== clickedIcon) el.classList.remove("selected");
                });
            }
            clickedIcon.classList.toggle("selected");
            return;
        }

        if (!e.ctrlKey && !e.shiftKey) {
            document.querySelectorAll(".icon.selected").forEach(el => el.classList.remove("selected"));
        }

        isSelecting = true;
        startX = e.clientX;
        startY = e.clientY;

        selectionBox.style.left = `${startX}px`;
        selectionBox.style.top = `${startY}px`;
        selectionBox.style.width = `0px`;
        selectionBox.style.height = `0px`;
        selectionBox.style.display = "none";
    });

    window.addEventListener("mousemove", (e) => {
        if (!isSelecting) return;

        const currentX = e.clientX;
        const currentY = e.clientY;

        const x = Math.min(startX, currentX);
        const y = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        if (width > 4 || height > 4) {
            selectionBox.style.display = "block";
            selectionBox.style.left = `${x}px`;
            selectionBox.style.top = `${y}px`;
            selectionBox.style.width = `${width}px`;
            selectionBox.style.height = `${height}px`;

            const boxRect = {
                left: x,
                top: y,
                right: x + width,
                bottom: y + height
            };

            const desktopIcons = document.querySelectorAll("#desktopIcons .icon");
            desktopIcons.forEach(icon => {
                const rect = icon.getBoundingClientRect();
                const intersects = !(
                    rect.right < boxRect.left ||
                    rect.left > boxRect.right ||
                    rect.bottom < boxRect.top ||
                    rect.top > boxRect.bottom
                );

                if (intersects) {
                    icon.classList.add("selected");
                } else if (!e.ctrlKey && !e.shiftKey) {
                    icon.classList.remove("selected");
                }
            });
        }
    });

    const endSelection = () => {
        if (isSelecting) {
            isSelecting = false;
            selectionBox.style.display = "none";
            selectionBox.style.width = "0px";
            selectionBox.style.height = "0px";
        }
    };

    window.addEventListener("mouseup", endSelection);
    window.addEventListener("blur", endSelection);
}

export function triggerDesktopUpload() {
    const desktopUploader = document.getElementById("desktop-file-uploader");
    if (desktopUploader) desktopUploader.click();
}

// --- Direct File Upload Processing ---
function setupUploaders() {
    const folderUploader = document.getElementById("folder-file-uploader");
    const desktopUploader = document.getElementById("desktop-file-uploader");
    const coverArtUploader = document.getElementById("cover-art-uploader");
    const wallpaperInput = document.getElementById("wallpaper-file-input");
    
    if (folderUploader) {
        folderUploader.addEventListener("change", () => {
            if (!folderUploader.files || folderUploader.files.length === 0) return;
            handleFilesUpload(Array.from(folderUploader.files), currentTargetFolder);
            folderUploader.value = "";
        });
    }
    
    if (desktopUploader) {
        desktopUploader.addEventListener("change", () => {
            if (!desktopUploader.files || desktopUploader.files.length === 0) return;
            handleFilesUpload(Array.from(desktopUploader.files), null);
            desktopUploader.value = "";
        });
    }

    if (coverArtUploader) {
        coverArtUploader.addEventListener("change", () => {
            if (!coverArtUploader.files || !coverArtUploader.files[0] || !targetItemForCover) return;
            const file = coverArtUploader.files[0];
            const reader = new FileReader();
            reader.onload = (ev) => {
                const dataUrl = ev.target.result;
                targetItemForCover.customIcon = dataUrl;
                targetItemForCover.cover = dataUrl;
                if (targetItemForCover.type === "music") {
                    const song = currentMusicLibrary.find(s => s.title === targetItemForCover.name || s.src === targetItemForCover.src);
                    if (song) {
                        song.cover = dataUrl;
                        saveMusicLibrary(currentMusicLibrary);
                        updateHDDUI();
                    }
                }
                saveDesktopData(currentDesktopData);
                if (targetFolderForCover) {
                    openFolderWindow(targetFolderForCover);
                } else {
                    renderDesktop();
                }
                showToast(`Custom cover art updated for "${targetItemForCover.name}"!`);
                targetItemForCover = null;
                targetFolderForCover = null;
            };
            reader.readAsDataURL(file);
            coverArtUploader.value = "";
        });
    }

    if (wallpaperInput) {
        wallpaperInput.addEventListener("change", () => {
            if (wallpaperInput.files && wallpaperInput.files[0]) {
                const file = wallpaperInput.files[0];
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const dataUrl = ev.target.result;
                    setWallpaper(dataUrl);
                    const prev = document.getElementById("personalize-preview-img");
                    if (prev) prev.src = dataUrl;
                    showToast("New wallpaper applied to Desktop and Sign-In Screen!");
                };
                reader.readAsDataURL(file);
                wallpaperInput.value = "";
            }
        });
    }
}

function handleFilesUpload(files, targetFolder = null) {
    files.forEach(async (file) => {
        const isAudio = file.type.startsWith("audio/") || file.name.match(/\.(mp3|wav|ogg|m4a|aac|flac)$/i);
        const isImage = file.type.startsWith("image/") || file.name.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i);
        
        if (isAudio) {
            const cleanName = file.name.replace(/\.[^/.]+$/, "");
            const trackId = `track_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            
            showToast(`Uploading audio track "${cleanName}"...`);
            
            let trackSrc = `indexeddb:${trackId}`;
            let isCloud = false;

            // Attempt upload directly to Firebase Cloud Storage (bypasses all 1MB limits)
            try {
                const cloudUrl = await uploadTrackToCloudStorage(file, file.name);
                if (cloudUrl) {
                    trackSrc = cloudUrl;
                    isCloud = true;
                }
            } catch (uErr) {
                console.warn("Direct storage upload failed, falling back to local:", uErr);
            }

            if (!isCloud) {
                // Fallback to high-capacity local IndexedDB
                const reader = new FileReader();
                const dataUrl = await new Promise((resolve) => {
                    reader.onload = (ev) => resolve(ev.target.result);
                    reader.readAsDataURL(file);
                });
                await storeAudioInIdb(trackId, dataUrl);
                audioDataMemoryCache[trackId] = dataUrl;
            }

            const musicItem = {
                id: trackId,
                name: cleanName,
                type: "music",
                src: trackSrc,
                customIcon: "fluent:music-note-2-24-filled",
                isLocalUpload: !isCloud
            };
            
            if (targetFolder) {
                if (!targetFolder.content) targetFolder.content = [];
                targetFolder.content.push(musicItem);
                openFolderWindow(targetFolder);
            } else {
                currentDesktopData.push(musicItem);
                renderDesktop();
            }
            
            currentMusicLibrary.push({
                id: trackId,
                title: cleanName,
                artist: "Uploaded Track",
                src: trackSrc,
                cover: "files/cover/song1.jpg",
                isLocalUpload: !isCloud
            });
            
            await saveMusicLibrary(currentMusicLibrary);
            await saveDesktopData(currentDesktopData);
            showToast(isCloud ? `Uploaded "${cleanName}" to Cloud Storage!` : `Uploaded "${cleanName}" to Music Player!`);
            updateHDDUI();
        } else if (isImage) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const dataUrl = ev.target.result;
                const imgItem = {
                    name: file.name,
                    type: "image",
                    src: dataUrl,
                    customIcon: dataUrl
                };
                if (targetFolder) {
                    if (!targetFolder.content) targetFolder.content = [];
                    targetFolder.content.push(imgItem);
                    openFolderWindow(targetFolder);
                } else {
                    currentDesktopData.push(imgItem);
                    renderDesktop();
                }
                saveDesktopData(currentDesktopData);
                showToast(`Uploaded image "${file.name}"`);
            };
            reader.readAsDataURL(file);
        } else {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const text = ev.target.result;
                const fileItem = {
                    name: file.name,
                    type: "file"
                };
                fileContentMap[file.name] = text;
                localStorage.setItem(`file_${file.name}`, text);
                
                if (targetFolder) {
                    if (!targetFolder.content) targetFolder.content = [];
                    targetFolder.content.push(fileItem);
                    openFolderWindow(targetFolder);
                } else {
                    currentDesktopData.push(fileItem);
                    renderDesktop();
                }
                saveDesktopData(currentDesktopData);
                showToast(`Uploaded "${file.name}"`);
            };
            reader.readAsText(file);
        }
    });
}

// Global click dismissals
document.addEventListener("click", (e) => {
    const startMenu = document.getElementById("start-menu");
    const userSwitcher = document.getElementById("user-switcher-popup");

    if (userSwitcher && userSwitcher.classList.contains("visible") && !e.target.closest("#user-switcher-popup") && !e.target.closest("#start-user-btn")) {
        userSwitcher.classList.remove("visible");
    }

    if (startMenu && startMenu.classList.contains("active") && !e.target.closest("#start-menu") && !e.target.closest(".start-button")) {
        startMenu.classList.remove("active");
        if (userSwitcher) userSwitcher.classList.remove("visible");
    }
});

// Admin shortcut (fallback)
window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'E' || e.key === 'e' || e.code === 'KeyE')) {
        e.preventDefault();
        openAdminEditMode();
        return;
    }

    // Guest Welcome enter key shortcut on lockscreen
    const lockScreen = document.getElementById("lock-screen");
    if (lockScreen && lockScreen.style.display !== "none") {
        if (currentLockSelectedUser === "guest" && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            submitGuestWelcome();
        }
    }
});

// Expose functions to window
window.toggleStartMenu = toggleStartMenu;
window.powerAction = powerAction;
window.wakeUp = wakeUp;
window.openAdminEditMode = openAdminEditMode;
window.openOwnerEditMode = openAdminEditMode;
window.switchUser = switchUser;
window.toggleUserSwitcher = toggleUserSwitcher;

// Lockscreen & Security bindings
window.handleLockSubmit = handleLockSubmit;
window.selectLockUser = selectLockUser;
window.submitGuestWelcome = submitGuestWelcome;
window.showForgotPinPrompt = showForgotPinPrompt;
window.toggleSignInOptions = toggleSignInOptions;
window.lockSystem = lockSystem;
window.unlockSystem = unlockSystem;

// Context Menu & Windows bindings
window.contextNewFolder = contextNewFolder;
window.contextNewTextFile = contextNewTextFile;
window.triggerDesktopUpload = triggerDesktopUpload;
window.openPersonalizationWindow = openPersonalizationWindow;
window.openGuestbook = openGuestbook;

// App launcher bindings
window.openCalculator = openCalculator;
window.openPaint = openPaint;
window.openTerminal = openTerminal;
window.openSnake = openSnake;
window.openNotepad = openNotepad;
window.createStickyNote = createStickyNote;
window.openStickyNotes = openStickyNotes;
window.openMusicUploadModal = openMusicUploadModal;
window.closeMusicUploadModal = closeMusicUploadModal;
window.playRandomTrack = playRandomTrack;

// ==========================================================================
// STICKY NOTES SYSTEM
// ==========================================================================
let stickyNotes = [];

function loadStickyNotes() {
    try {
        const saved = localStorage.getItem("spiketones_sticky_notes");
        if (saved) {
            stickyNotes = JSON.parse(saved);
        } else {
            stickyNotes = [];
        }
    } catch (e) {
        stickyNotes = [];
    }
}

function saveStickyNotes() {
    try {
        localStorage.setItem("spiketones_sticky_notes", JSON.stringify(stickyNotes));
    } catch (e) {
        console.error("Failed to save sticky notes", e);
    }
}

export function createStickyNote(initialText = "", color = "yellow", posX = null, posY = null) {
    loadStickyNotes();
    const id = `note-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const offset = (stickyNotes.length * 28) % 140;
    const note = {
        id,
        text: initialText,
        color: color || "yellow",
        x: posX !== null ? posX : 140 + offset,
        y: posY !== null ? posY : 120 + offset,
        width: 250,
        height: 230
    };
    stickyNotes.push(note);
    saveStickyNotes();
    renderStickyNoteElement(note);
    showToast("Sticky Note created");
    return note;
}

export function openStickyNotes() {
    loadStickyNotes();
    const container = document.getElementById("sticky-notes-container");
    if (!container) return;

    if (stickyNotes.length === 0) {
        createStickyNote("📌 SPIKETONES007 OS Notes\n\n• Click + for a new note\n• Click 🎨 to switch theme\n• Drag anywhere across your desktop!", "yellow", 160, 130);
    } else {
        stickyNotes.forEach(n => {
            if (!document.getElementById(n.id)) {
                renderStickyNoteElement(n);
            }
        });
        showToast("Sticky Notes displayed");
    }
}

function renderStickyNoteElement(note) {
    const container = document.getElementById("sticky-notes-container");
    if (!container) return;

    let el = document.getElementById(note.id);
    if (el) el.remove();

    el = document.createElement("div");
    el.className = `stickynote theme-${note.color || 'yellow'}`;
    el.id = note.id;
    el.style.left = `${note.x}px`;
    el.style.top = `${note.y}px`;
    if (note.width) el.style.width = `${note.width}px`;
    if (note.height) el.style.height = `${note.height}px`;

    el.innerHTML = `
        <div class="stickynote-header">
            <div class="stickynote-actions-left">
                <button class="stickynote-btn btn-new-note" title="New Note">+</button>
            </div>
            <div class="stickynote-actions-right">
                <button class="stickynote-btn btn-color-note" title="Change Color">🎨</button>
                <button class="stickynote-btn btn-delete-note" title="Delete Note">✕</button>
            </div>
        </div>
        <div class="stickynote-palette" style="display: none;">
            <div class="stickynote-color-dot" data-color="yellow" style="background: #fff9b0;" title="Yellow"></div>
            <div class="stickynote-color-dot" data-color="green" style="background: #e4f9b8;" title="Green"></div>
            <div class="stickynote-color-dot" data-color="pink" style="background: #ffd5e5;" title="Pink"></div>
            <div class="stickynote-color-dot" data-color="blue" style="background: #cce8ff;" title="Blue"></div>
            <div class="stickynote-color-dot" data-color="purple" style="background: #ead9ff;" title="Purple"></div>
            <div class="stickynote-color-dot" data-color="dark" style="background: #282625;" title="Dark"></div>
        </div>
        <div class="stickynote-body">
            <textarea class="stickynote-textarea" placeholder="Type your note here...">${escapeHTML(note.text || '')}</textarea>
        </div>
    `;

    container.appendChild(el);
    bringToFront(el);

    // Draggable header
    const header = el.querySelector(".stickynote-header");
    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    header.addEventListener("mousedown", (e) => {
        if (e.target.closest(".stickynote-btn")) return;
        isDragging = true;
        bringToFront(el);
        const rect = el.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = rect.left;
        initialTop = rect.top;

        const onMouseMove = (ev) => {
            if (!isDragging) return;
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            const newX = Math.max(0, initialLeft + dx);
            const newY = Math.max(0, initialTop + dy);
            el.style.left = `${newX}px`;
            el.style.top = `${newY}px`;
            note.x = newX;
            note.y = newY;
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                saveStickyNotes();
            }
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
    });

    el.addEventListener("mousedown", () => bringToFront(el));

    // Text area auto-save
    const textarea = el.querySelector(".stickynote-textarea");
    textarea.addEventListener("input", () => {
        note.text = textarea.value;
        saveStickyNotes();
    });

    // Resize observer
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
            if (el.offsetWidth > 100 && el.offsetHeight > 100) {
                note.width = Math.round(el.offsetWidth);
                note.height = Math.round(el.offsetHeight);
                saveStickyNotes();
            }
        });
        ro.observe(el);
    }

    // Header buttons
    const btnNew = el.querySelector(".btn-new-note");
    btnNew.addEventListener("click", () => {
        const nextX = (note.x || 120) + 40;
        const nextY = (note.y || 120) + 40;
        createStickyNote("", note.color || "yellow", nextX, nextY);
    });

    const palette = el.querySelector(".stickynote-palette");
    const btnColor = el.querySelector(".btn-color-note");
    btnColor.addEventListener("click", (e) => {
        e.stopPropagation();
        palette.style.display = palette.style.display === "none" ? "flex" : "none";
    });

    el.querySelectorAll(".stickynote-color-dot").forEach(dot => {
        dot.addEventListener("click", () => {
            const chosenColor = dot.getAttribute("data-color");
            el.className = `stickynote theme-${chosenColor}`;
            note.color = chosenColor;
            saveStickyNotes();
            palette.style.display = "none";
        });
    });

    const btnDel = el.querySelector(".btn-delete-note");
    btnDel.addEventListener("click", () => {
        el.remove();
        stickyNotes = stickyNotes.filter(n => n.id !== note.id);
        saveStickyNotes();
        showToast("Sticky note removed");
    });
}

// ==========================================================================
// MUSIC UPLOAD, STREAM LINK & CUSTOM ARTWORK MODAL SYSTEM
// ==========================================================================
let currentMusicSourceMode = "link"; // "link" or "upload"
let selectedModalAudioDataUrl = null;
let selectedModalAudioFileName = "";
let selectedModalAudioRawFile = null;
let selectedModalCoverDataUrl = "files/cover/song1.jpg";
let currentMusicModalFolder = null;

export function openMusicUploadModal(targetFolder = null) {
    currentMusicModalFolder = targetFolder || currentDesktopData.find(d => d.name === "Music");
    const overlay = document.getElementById("music-upload-overlay");
    if (!overlay) return;

    currentMusicSourceMode = "link";
    selectedModalAudioDataUrl = null;
    selectedModalAudioFileName = "";
    selectedModalAudioRawFile = null;
    selectedModalCoverDataUrl = "files/cover/song1.jpg";

    const tabLink = document.getElementById("tab-src-link");
    const tabUpload = document.getElementById("tab-src-upload");
    const panelLink = document.getElementById("panel-music-link");
    const panelUpload = document.getElementById("panel-music-upload");

    if (tabLink) tabLink.classList.add("active");
    if (tabUpload) tabUpload.classList.remove("active");
    if (panelLink) panelLink.style.display = "block";
    if (panelUpload) panelUpload.style.display = "none";

    const musicUrlInput = document.getElementById("modal-music-url");
    if (musicUrlInput) musicUrlInput.value = "";

    const ytIndicator = document.getElementById("modal-yt-indicator");
    if (ytIndicator) ytIndicator.style.display = "none";

    const ytPreviewWrap = document.getElementById("modal-yt-preview-wrap");
    if (ytPreviewWrap) {
        ytPreviewWrap.style.display = "none";
        const ytIframe = document.getElementById("modal-yt-preview-iframe");
        if (ytIframe) ytIframe.src = "";
    }

    const coverUrlInput = document.getElementById("modal-cover-url-input");
    if (coverUrlInput) coverUrlInput.value = "";

    const nameLabel = document.getElementById("modal-audio-name");
    if (nameLabel) nameLabel.textContent = "Click or drag & drop audio track";

    const audioPreview = document.getElementById("modal-audio-preview");
    if (audioPreview) {
        audioPreview.style.display = "none";
        audioPreview.src = "";
    }
    const coverPreviewImg = document.getElementById("modal-cover-preview-img");
    if (coverPreviewImg) coverPreviewImg.src = "files/cover/song1.jpg";
    const titleInput = document.getElementById("modal-music-title");
    if (titleInput) titleInput.value = "";
    const artistInput = document.getElementById("modal-music-artist");
    if (artistInput) artistInput.value = "";
    const confirmBtn = document.getElementById("btn-confirm-music-modal");
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = "Add & Stream Song";
    }

    overlay.style.display = "flex";
}

export function closeMusicUploadModal() {
    const overlay = document.getElementById("music-upload-overlay");
    if (overlay) overlay.style.display = "none";
    const audioPreview = document.getElementById("modal-audio-preview");
    if (audioPreview) audioPreview.pause();
    const ytPreviewWrap = document.getElementById("modal-yt-preview-wrap");
    if (ytPreviewWrap) {
        ytPreviewWrap.style.display = "none";
        const ytIframe = document.getElementById("modal-yt-preview-iframe");
        if (ytIframe) ytIframe.src = "";
    }
}

function setupMusicUploadModal() {
    const overlay = document.getElementById("music-upload-overlay");
    const closeBtn = document.getElementById("btn-close-music-upload");
    const cancelBtn = document.getElementById("btn-cancel-music-modal");
    const confirmBtn = document.getElementById("btn-confirm-music-modal");

    const tabLink = document.getElementById("tab-src-link");
    const tabUpload = document.getElementById("tab-src-upload");
    const panelLink = document.getElementById("panel-music-link");
    const panelUpload = document.getElementById("panel-music-upload");

    const musicUrlInput = document.getElementById("modal-music-url");
    const btnTestUrl = document.getElementById("btn-test-music-url");

    const audioDropZone = document.getElementById("music-audio-dropzone");
    const audioInput = document.getElementById("modal-audio-input");
    const audioPreview = document.getElementById("modal-audio-preview");
    const audioNameLabel = document.getElementById("modal-audio-name");

    const coverUrlInput = document.getElementById("modal-cover-url-input");
    const btnApplyCoverUrl = document.getElementById("btn-apply-cover-url");
    const coverBrowseBtn = document.getElementById("btn-browse-cover");
    const coverInput = document.getElementById("modal-cover-input");
    const coverPreviewBox = document.getElementById("modal-cover-preview-box");
    const coverPreviewImg = document.getElementById("modal-cover-preview-img");
    const titleInput = document.getElementById("modal-music-title");
    const artistInput = document.getElementById("modal-music-artist");
    const presetThumbs = document.querySelectorAll(".cover-preset-thumb");

    function updateConfirmButtonState() {
        if (!confirmBtn) return;
        if (currentMusicSourceMode === "link") {
            const hasUrl = !!(musicUrlInput && musicUrlInput.value.trim().length > 0);
            confirmBtn.disabled = !hasUrl;
        } else {
            confirmBtn.disabled = !selectedModalAudioDataUrl;
        }
    }

    function setSourceMode(mode) {
        currentMusicSourceMode = mode;
        if (mode === "link") {
            if (tabLink) tabLink.classList.add("active");
            if (tabUpload) tabUpload.classList.remove("active");
            if (panelLink) panelLink.style.display = "block";
            if (panelUpload) panelUpload.style.display = "none";
        } else {
            if (tabUpload) tabUpload.classList.add("active");
            if (tabLink) tabLink.classList.remove("active");
            if (panelUpload) panelUpload.style.display = "block";
            if (panelLink) panelLink.style.display = "none";
        }
        updateConfirmButtonState();
    }

    if (tabLink) tabLink.addEventListener("click", () => setSourceMode("link"));
    if (tabUpload) tabUpload.addEventListener("click", () => setSourceMode("upload"));

    if (closeBtn) closeBtn.addEventListener("click", closeMusicUploadModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeMusicUploadModal);

    if (overlay) {
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeMusicUploadModal();
        });
    }

    // Preset Cover selection
    presetThumbs.forEach(thumb => {
        thumb.addEventListener("click", () => {
            const src = thumb.getAttribute("data-src");
            selectedModalCoverDataUrl = src;
            if (coverPreviewImg) coverPreviewImg.src = src;
            if (coverUrlInput) coverUrlInput.value = "";
        });
    });

    // Artwork link input & button
    const applyArtworkUrl = () => {
        if (!coverUrlInput) return;
        const val = coverUrlInput.value.trim();
        if (!val) return;
        selectedModalCoverDataUrl = val;
        if (coverPreviewImg) {
            coverPreviewImg.src = val;
            coverPreviewImg.onerror = () => {
                showToast("Artwork image link failed to load, check URL", false);
            };
        }
        showToast("Artwork image link applied!");
    };
    if (btnApplyCoverUrl) btnApplyCoverUrl.addEventListener("click", applyArtworkUrl);
    if (coverUrlInput) {
        coverUrlInput.addEventListener("change", applyArtworkUrl);
        coverUrlInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                applyArtworkUrl();
            }
        });
    }

    // Cover file upload
    if (coverBrowseBtn && coverInput) {
        coverBrowseBtn.addEventListener("click", () => coverInput.click());
    }
    if (coverPreviewBox && coverInput) {
        coverPreviewBox.addEventListener("click", () => coverInput.click());
    }
    if (coverInput) {
        coverInput.addEventListener("change", () => {
            if (coverInput.files && coverInput.files[0]) {
                const file = coverInput.files[0];
                const reader = new FileReader();
                reader.onload = (e) => {
                    selectedModalCoverDataUrl = e.target.result;
                    if (coverPreviewImg) coverPreviewImg.src = selectedModalCoverDataUrl;
                    if (coverUrlInput) coverUrlInput.value = "";
                    showToast("Custom cover art loaded!");
                };
                reader.readAsDataURL(file);
            }
        });
    }

    // Music Link URL Input logic
    let ytFetchTimeout = null;
    if (musicUrlInput) {
        musicUrlInput.addEventListener("input", () => {
            updateConfirmButtonState();
            const val = musicUrlInput.value.trim();
            const ytIndicator = document.getElementById("modal-yt-indicator");
            const ytIndicatorText = document.getElementById("modal-yt-indicator-text");
            const ytId = extractYouTubeId(val);

            if (ytId) {
                if (ytIndicator) {
                    ytIndicator.style.display = "flex";
                    if (ytIndicatorText) ytIndicatorText.textContent = "YouTube track detected! Auto-retrieving song title, artist & album cover...";
                }
                const autoThumb = getYouTubeThumbnail(ytId);
                selectedModalCoverDataUrl = autoThumb;
                if (coverPreviewImg) coverPreviewImg.src = autoThumb;

                // Debounce metadata fetch
                clearTimeout(ytFetchTimeout);
                ytFetchTimeout = setTimeout(async () => {
                    const meta = await fetchYouTubeMetadata(ytId);
                    if (meta) {
                        if (titleInput && (!titleInput.value || titleInput.value.trim() === "" || titleInput.value.includes("youtu"))) {
                            titleInput.value = meta.cleanTitle || meta.title;
                        }
                        if (artistInput && (!artistInput.value || artistInput.value.trim() === "" || artistInput.value === "SPIKETONES")) {
                            artistInput.value = meta.artist || "YouTube";
                        }
                        if (meta.thumbnail && coverPreviewImg) {
                            selectedModalCoverDataUrl = meta.thumbnail;
                            coverPreviewImg.src = meta.thumbnail;
                        }
                        if (ytIndicatorText) {
                            ytIndicatorText.textContent = `✓ Ready: ${meta.cleanTitle || meta.title} (${meta.artist || "YouTube"})`;
                        }
                    }
                }, 250);
            } else {
                if (ytIndicator) ytIndicator.style.display = "none";
                if (val && (!titleInput.value || titleInput.value.trim() === "")) {
                    try {
                        const u = new URL(val);
                        const parts = u.pathname.split("/").filter(Boolean);
                        const fname = parts[parts.length - 1];
                        if (fname) {
                            const clean = decodeURIComponent(fname.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " "));
                            if (clean.includes(" - ")) {
                                const spl = clean.split(" - ");
                                if (!artistInput.value) artistInput.value = spl[0].trim();
                                titleInput.value = spl.slice(1).join(" - ").trim();
                            } else {
                                titleInput.value = clean;
                            }
                        }
                    } catch (e) {
                        const last = val.split("/").pop();
                        if (last) {
                            titleInput.value = decodeURIComponent(last.split("?")[0].replace(/\.[^/.]+$/, ""));
                        }
                    }
                }
            }
        });
    }

    // Test stream button
    if (btnTestUrl) {
        btnTestUrl.addEventListener("click", () => {
            const url = musicUrlInput ? musicUrlInput.value.trim() : "";
            if (!url) {
                showToast("Please enter a song link to test", false);
                return;
            }
            const ytId = extractYouTubeId(url);
            const ytPreviewWrap = document.getElementById("modal-yt-preview-wrap");
            const ytIframe = document.getElementById("modal-yt-preview-iframe");

            if (ytId) {
                if (audioPreview) {
                    audioPreview.pause();
                    audioPreview.style.display = "none";
                }
                if (ytPreviewWrap && ytIframe) {
                    ytPreviewWrap.style.display = "block";
                    ytIframe.src = `https://www.youtube.com/embed/${ytId}?autoplay=1`;
                    showToast("Playing YouTube video preview 📺");
                }
            } else {
                if (ytPreviewWrap) {
                    ytPreviewWrap.style.display = "none";
                    if (ytIframe) ytIframe.src = "";
                }
                if (audioPreview) {
                    audioPreview.src = url;
                    audioPreview.style.display = "block";
                    const p = audioPreview.play();
                    if (p !== undefined) {
                        p.then(() => {
                            showToast("Playing stream preview 🎵");
                        }).catch(err => {
                            showToast("Could not preview audio stream (CORS or invalid format)", false);
                        });
                    }
                }
            }
        });
    }

    // Audio file dropzone
    if (audioDropZone && audioInput) {
        audioDropZone.addEventListener("click", () => audioInput.click());

        audioDropZone.addEventListener("dragover", (e) => {
            e.preventDefault();
            audioDropZone.classList.add("drag-over");
        });
        audioDropZone.addEventListener("dragleave", () => {
            audioDropZone.classList.remove("drag-over");
        });
        audioDropZone.addEventListener("drop", (e) => {
            e.preventDefault();
            audioDropZone.classList.remove("drag-over");
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                loadAudioFileForModal(e.dataTransfer.files[0]);
            }
        });

        audioInput.addEventListener("change", () => {
            if (audioInput.files && audioInput.files[0]) {
                loadAudioFileForModal(audioInput.files[0]);
            }
        });
    }

    function loadAudioFileForModal(file) {
        selectedModalAudioRawFile = file;
        const reader = new FileReader();
        reader.onload = (e) => {
            selectedModalAudioDataUrl = e.target.result;
            selectedModalAudioFileName = file.name;

            if (audioNameLabel) audioNameLabel.textContent = `🎵 ${file.name}`;
            if (audioPreview) {
                audioPreview.src = selectedModalAudioDataUrl;
                audioPreview.style.display = "block";
            }

            const cleanBase = file.name.replace(/\.[^/.]+$/, "");
            let autoArtist = "";
            let autoTitle = cleanBase;

            if (cleanBase.includes(" - ")) {
                const parts = cleanBase.split(" - ");
                autoArtist = parts[0].trim();
                autoTitle = parts.slice(1).join(" - ").trim();
            }

            if (titleInput && (!titleInput.value || titleInput.value.trim() === "")) {
                titleInput.value = autoTitle;
            }
            if (artistInput && (!artistInput.value || artistInput.value.trim() === "")) {
                artistInput.value = autoArtist || "SPIKETONES";
            }

            updateConfirmButtonState();
        };
        reader.readAsDataURL(file);
    }

    // Confirm button click
    if (confirmBtn) {
        confirmBtn.addEventListener("click", async () => {
            let trackSrc = "";
            let isCloud = false;
            let isLocal = false;
            let isYouTube = false;
            let ytId = null;

            if (currentMusicSourceMode === "link") {
                const url = musicUrlInput ? musicUrlInput.value.trim() : "";
                if (!url) {
                    showToast("Please enter an audio stream or YouTube link!", false);
                    return;
                }
                ytId = extractYouTubeId(url);
                if (ytId) {
                    isYouTube = true;
                    trackSrc = `https://www.youtube.com/watch?v=${ytId}`;
                } else {
                    trackSrc = url;
                }
            } else {
                if (!selectedModalAudioDataUrl) {
                    showToast("Please select an audio file first!", false);
                    return;
                }
                // Upload mode: Try Cloud Storage, fallback to IndexedDB
                confirmBtn.disabled = true;
                confirmBtn.textContent = "Uploading...";

                const trackId = `track_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                trackSrc = `indexeddb:${trackId}`;

                if (selectedModalAudioRawFile) {
                    try {
                        const cloudUrl = await uploadTrackToCloudStorage(selectedModalAudioRawFile, selectedModalAudioFileName);
                        if (cloudUrl) {
                            trackSrc = cloudUrl;
                            isCloud = true;
                        }
                    } catch (cErr) {
                        console.warn("Storage upload failed, falling back to local IndexedDB:", cErr);
                    }
                }

                if (!isCloud) {
                    await storeAudioInIdb(trackId, selectedModalAudioDataUrl);
                    audioDataMemoryCache[trackId] = selectedModalAudioDataUrl;
                    isLocal = true;
                }
            }

            const title = (titleInput && titleInput.value.trim()) || (selectedModalAudioFileName ? selectedModalAudioFileName.replace(/\.[^/.]+$/, "") : (isYouTube && ytId ? `YouTube Track (${ytId})` : "Custom Track"));
            const artist = (artistInput && artistInput.value.trim()) || (isYouTube ? "YouTube" : "SPIKETONES");
            const cover = selectedModalCoverDataUrl || (isYouTube && ytId ? getYouTubeThumbnail(ytId) : "files/cover/song1.jpg");
            const trackId = `track_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

            // Add to Music Folder in currentDesktopData
            let musicFolder = currentMusicModalFolder;
            if (!musicFolder) {
                musicFolder = currentDesktopData.find(d => d.type === "folder" && d.name && d.name.toLowerCase() === "music");
            }
            if (musicFolder) {
                if (!musicFolder.content) musicFolder.content = [];
                musicFolder.content.push({
                    id: trackId,
                    name: title,
                    type: "music",
                    src: trackSrc,
                    customIcon: cover,
                    artist: artist,
                    isLocalUpload: isLocal,
                    isLinkStream: currentMusicSourceMode === "link",
                    ...(isYouTube ? { isYouTube: true, youtubeId: ytId } : {})
                });
                openFolderWindow(musicFolder);
            }

            const newTrack = {
                id: trackId,
                title: title,
                artist: artist,
                src: trackSrc,
                cover: cover,
                isLocalUpload: isLocal,
                isLinkStream: currentMusicSourceMode === "link",
                ...(isYouTube ? { isYouTube: true, youtubeId: ytId } : {})
            };
            currentMusicLibrary.push(newTrack);
            currentTrackIndex = currentMusicLibrary.length - 1;

            await saveMusicLibrary(currentMusicLibrary);
            await saveDesktopData(currentDesktopData);

            // Play immediately in the background
            confirmBtn.disabled = false;
            closeMusicUploadModal();
            await playCurrentTrack();

            if (isYouTube) {
                showToast(`Now playing "${title}" in background 🎵`);
            } else if (currentMusicSourceMode === "link") {
                showToast(`Now streaming "${title}" in background 🎵`);
            } else {
                showToast(`Added "${title}" with custom cover!`);
            }
        });
    }
}

// --- Admin Firebase Status Widget ---
function initFirebaseStatusWidget() {
    const widget = document.getElementById("firebase-status-widget");
    if (!widget) return;

    const dot = document.getElementById("fb-status-dot");
    const stateEl = document.getElementById("fb-status-state");
    const timeEl = document.getElementById("fb-status-time");

    const updateUI = (status) => {
        if (!stateEl || !timeEl || !dot) return;
        
        if (status.isUp) {
            dot.className = "fb-status-dot up";
            stateEl.textContent = "UP";
            stateEl.style.color = "#2ed573";
            const timeStr = status.lastUpdated ? status.lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "Connected";
            timeEl.textContent = `Synced: ${timeStr}`;
            widget.title = `Firebase Firestore is UP (spiketones7). Last updated: ${timeStr}. Click to test connection.`;
        } else {
            dot.className = "fb-status-dot offline";
            stateEl.textContent = "OFFLINE";
            stateEl.style.color = "#ff4757";
            timeEl.textContent = "Local Cache";
            widget.title = "Firebase is currently offline or unreachable. Click to test connection.";
        }
    };

    subscribeFirebaseStatus(updateUI);

    widget.addEventListener("click", async () => {
        if (dot) dot.className = "fb-status-dot syncing";
        if (stateEl) stateEl.textContent = "PING...";
        showToast("Testing Firebase Firestore connection (spiketones7)...");
        const ok = await pingFirebase();
        if (ok) {
            showToast("Firebase Firestore is UP and active! (spiketones7)");
        } else {
            showToast("Firebase is offline or unconfigured. Working locally.");
        }
    });
}

export function setMusicLibrary(lib) {
    currentMusicLibrary = sanitizeMusicLibrary(lib);
    updateHDDUI();
}

// Global emergency recovery function to clean local storage and reset to clean GitHub defaults
window.resetSpiketonesOS = () => {
    clearCorruptedLocalCache();
    window.location.reload();
};

// --- Initial Boot Sequence ---
function bootOS() {
    console.log("SPIKETONES007 OS Booting...");

    // Clean any corrupted file_* entries that contain HTML fallback
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith("file_")) {
                const val = localStorage.getItem(k);
                if (val && (val.trim().startsWith("<!DOCTYPE") || val.trim().startsWith("<html"))) {
                    localStorage.removeItem(k);
                }
            }
        }
    } catch (e) {}

    // 1. Firebase status monitor
    try {
        initFirebaseStatusWidget();
    } catch (e) {
        console.warn("initFirebaseStatusWidget failed:", e);
    }

    // 2. User permissions and UI styling
    try {
        updateUserUI();
    } catch (e) {
        console.warn("updateUserUI failed:", e);
    }

    // 3. Desktop icons
    try {
        renderDesktop();
    } catch (e) {
        console.error("renderDesktop failed:", e);
    }

    // 4. HDD Mini Player
    try {
        initHDDPlayer();
    } catch (e) {
        console.error("initHDDPlayer failed:", e);
    }

    // 5. System and Mond Clocks
    try {
        updateClocks();
        setInterval(updateClocks, 1000);
    } catch (e) {
        console.warn("updateClocks failed:", e);
    }

    // 6. Interactive features
    try {
        initContextMenu();
    } catch (e) {
        console.warn("initContextMenu failed:", e);
    }
    try {
        initDesktopDragSelect();
    } catch (e) {
        console.warn("initDesktopDragSelect failed:", e);
    }
    try {
        setupUploaders();
    } catch (e) {
        console.warn("setupUploaders failed:", e);
    }
    try {
        setupMusicUploadModal();
    } catch (e) {
        console.warn("setupMusicUploadModal failed:", e);
    }

    // 7. Sticky Notes
    try {
        loadStickyNotes();
        if (stickyNotes.length > 0) {
            stickyNotes.forEach(n => renderStickyNoteElement(n));
        }
    } catch (e) {
        console.warn("loadStickyNotes failed:", e);
    }

    // 8. Initial boot to Windows 11 Guest Welcome lockscreen
    try {
        selectLockUser("guest");
        const initialLockBg = document.getElementById("lock-screen-bg");
        if (initialLockBg) initialLockBg.style.backgroundImage = `url('${currentWallpaper}')`;
        const lockScreen = document.getElementById("lock-screen");
        if (lockScreen) {
            lockScreen.style.display = "flex";
            lockScreen.style.opacity = "1";
        }
    } catch (e) {
        console.error("Lockscreen initialization failed:", e);
    }

    // 9. Open Socials window matching screenshot layout
    try {
        const socialsItem = findFolderItem("Socials") || currentDesktopData.find(d => d.type === "folder");
        if (socialsItem) {
            openFolderWindow(socialsItem);
        }
    } catch (e) {
        console.error("Failed opening default Socials folder:", e);
    }

    // 10. Open Guestbook panel docked at bottom-right matching screenshot layout
    try {
        openGuestbook();
    } catch (e) {
        console.error("Failed opening default Guestbook window:", e);
    }

    // 10b. Setup Desktop Drop Zone for Admin icon repositioning
    try {
        setupDesktopDropZone();
    } catch (e) {
        console.error("Failed initializing Desktop Drop Zone:", e);
    }

    // 11. Check & synchronize with remote Firebase Firestore config
    try {
        loadRemoteConfig().then(config => {
            if (config.wallpaper && config.wallpaper !== currentWallpaper) {
                setWallpaper(config.wallpaper);
            }
            if (config.desktopData && Array.isArray(config.desktopData)) {
                currentDesktopData = sanitizeDesktopData(config.desktopData);
                renderDesktop();
            }
            if (config.desktopPositions && typeof config.desktopPositions === 'object') {
                currentDesktopPositions = { ...currentDesktopPositions, ...config.desktopPositions };
                renderDesktop();
            }
            if (config.musicLibrary && Array.isArray(config.musicLibrary)) {
                setMusicLibrary(config.musicLibrary);
                updateHDDUI();
            }
            if (config.cs2Config && typeof config.cs2Config === 'object') {
                currentCs2Config = { ...DEFAULT_CS2_CONFIG, ...config.cs2Config };
            }
        }).catch(err => {
            console.warn("Firebase remote config load warning:", err);
        });

        // Real-time synchronization for changes made by owner
        subscribeRemoteConfig((key, value) => {
            if (key === 'wallpaper' && value) {
                setWallpaper(value);
            } else if (key === 'desktopData' && Array.isArray(value)) {
                currentDesktopData = sanitizeDesktopData(value);
                renderDesktop();
            } else if (key === 'desktopPositions' && typeof value === 'object') {
                currentDesktopPositions = { ...currentDesktopPositions, ...value };
                renderDesktop();
            } else if (key === 'musicLibrary' && Array.isArray(value)) {
                setMusicLibrary(value);
                updateHDDUI();
            } else if (key === 'cs2Config' && typeof value === 'object') {
                currentCs2Config = { ...DEFAULT_CS2_CONFIG, ...value };
            }
        });
    } catch (e) {
        console.warn("Firebase config subscription warning:", e);
    }

    // 12. Auto-sync Leetify API telemetry on site load
    try {
        syncLeetifyStats().then(() => {
            console.log("Leetify API auto-sync completed on site boot.");
        }).catch(err => {
            console.warn("Auto-sync Leetify API on boot warning:", err);
        });
    } catch (e) {
        console.warn("Auto-sync Leetify trigger error:", e);
    }
}

if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", bootOS);
} else {
    bootOS();
}
