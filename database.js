// Database connection layer supporting Firebase Firestore & Storage with localStorage fallback
import { 
    db, 
    storage,
    storageRef,
    uploadBytes,
    getDownloadURL,
    collection, 
    addDoc, 
    getDocs, 
    onSnapshot, 
    setDoc, 
    getDoc,
    doc, 
    query, 
    orderBy,
    deleteDoc,
    isFirebaseConfigured,
    isFirebaseStorageConfigured
} from './firebase.js';

export { isFirebaseConfigured, isFirebaseStorageConfigured };

// --- Firebase Status & Health Tracker ---
let dbStatus = {
    isUp: isFirebaseConfigured(),
    lastUpdated: new Date(),
    statusText: isFirebaseConfigured() ? "UP" : "Local Only",
    projectId: "spiketones7"
};
const statusListeners = new Set();

function notifyStatus() {
    statusListeners.forEach(cb => {
        try { cb({ ...dbStatus }); } catch (e) {}
    });
}

export function subscribeFirebaseStatus(cb) {
    statusListeners.add(cb);
    cb({ ...dbStatus });
    return () => statusListeners.delete(cb);
}

export function recordDbUpdate() {
    dbStatus.isUp = true;
    dbStatus.lastUpdated = new Date();
    dbStatus.statusText = "UP";
    notifyStatus();
}

export async function pingFirebase() {
    if (!isFirebaseConfigured() || !db) {
        dbStatus.isUp = false;
        dbStatus.statusText = "Offline";
        notifyStatus();
        return false;
    }
    try {
        await getDoc(doc(db, 'config', 'desktop_data'));
        dbStatus.isUp = true;
        dbStatus.lastUpdated = new Date();
        dbStatus.statusText = "UP";
        notifyStatus();
        return true;
    } catch (err) {
        if (err?.code === 'permission-denied') {
            dbStatus.isUp = true;
            dbStatus.lastUpdated = new Date();
            dbStatus.statusText = "UP";
        } else if (err?.code === 'unavailable') {
            dbStatus.isUp = false;
            dbStatus.statusText = "Offline";
        } else {
            dbStatus.isUp = true;
            dbStatus.lastUpdated = new Date();
            dbStatus.statusText = "UP";
        }
        notifyStatus();
        return dbStatus.isUp;
    }
}

// Initial ping
if (typeof window !== "undefined") {
    setTimeout(() => { pingFirebase(); }, 500);
}

// Default guestbook messages
export const DEFAULT_GUESTBOOK_MESSAGES = [
    { 
        id: "msg-1", 
        created_at: "2026-06-05T00:54:00.000Z", 
        date_label: "Jun 5, 12:54 AM",
        author: "SPIKETONES007", 
        message: "Yo wsg my boiii! Welcome to the guestbook!" 
    },
    { 
        id: "msg-2", 
        created_at: "2026-06-05T01:54:00.000Z", 
        date_label: "Jun 5, 01:54 AM",
        author: "Viewer12", 
        message: "This site looks insane. Love the glassmorphism theme." 
    },
    { 
        id: "msg-3", 
        created_at: "2026-06-05T02:54:00.000Z", 
        date_label: "Jun 5, 02:54 AM",
        author: "Josh", 
        message: "Yoo" 
    }
];

let localGuestbookMessages = [...DEFAULT_GUESTBOOK_MESSAGES];

// Load from localStorage cache
try {
    const saved = localStorage.getItem('st_guestbook');
    if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
            localGuestbookMessages = parsed.map(msg => {
                if (msg.id === "msg-1" && !msg.date_label) msg.date_label = "Jun 5, 12:54 AM";
                if (msg.id === "msg-2" && !msg.date_label) msg.date_label = "Jun 5, 01:54 AM";
                if (msg.id === "msg-3" && !msg.date_label) msg.date_label = "Jun 5, 02:54 AM";
                return msg;
            });
        }
    } else {
        localStorage.setItem('st_guestbook', JSON.stringify(localGuestbookMessages));
    }
} catch (e) { 
    console.warn("Local storage guestbook load failed:", e); 
}

function saveLocalGuestbook() {
    try { 
        localStorage.setItem('st_guestbook', JSON.stringify(localGuestbookMessages)); 
    } catch (e) { 
        console.warn("Local storage guestbook save failed:", e); 
    }
}

// --- Guestbook API ---
export async function fetchGuestbook() {
    if (isFirebaseConfigured() && db) {
        try {
            const q = query(collection(db, 'guestbook'), orderBy('created_at', 'asc'));
            const querySnapshot = await getDocs(q);
            const messages = [];
            querySnapshot.forEach((docSnap) => {
                messages.push({ id: docSnap.id, ...docSnap.data() });
            });
            if (messages.length > 0) {
                localGuestbookMessages = messages;
                saveLocalGuestbook();
                return messages;
            }
        } catch (err) {
            console.warn("Firebase guestbook fetch error (falling back to localStorage):", err);
        }
    }
    return [...localGuestbookMessages];
}

export async function insertGuestbook(author, message) {
    const authorName = author && author.trim() ? author.trim() : "Anonymous";
    const msgText = message ? message.trim() : "";
    if (!msgText) return null;

    const newMsg = { 
        id: "msg-" + Date.now(), 
        created_at: new Date().toISOString(), 
        author: authorName, 
        message: msgText 
    };

    let firebaseSuccess = false;
    if (isFirebaseConfigured() && db) {
        try {
            const docRef = await addDoc(collection(db, 'guestbook'), {
                author: authorName,
                message: msgText,
                created_at: newMsg.created_at
            });
            newMsg.id = docRef.id;
            firebaseSuccess = true;
            recordDbUpdate();
        } catch (err) {
            console.warn("Firebase guestbook insert error (falling back to localStorage):", err);
        }
    }

    // Always keep local list up to date as backup
    localGuestbookMessages.push(newMsg);
    saveLocalGuestbook();
    return newMsg;
}

export async function deleteGuestbookMessage(msgId) {
    if (!msgId) return false;
    let deleted = false;
    if (isFirebaseConfigured() && db) {
        try {
            await deleteDoc(doc(db, 'guestbook', msgId));
            deleted = true;
            recordDbUpdate();
        } catch (err) {
            console.warn("Firebase guestbook delete error:", err);
        }
    }
    localGuestbookMessages = localGuestbookMessages.filter(m => m.id !== msgId);
    saveLocalGuestbook();
    return true;
}

export function subscribeGuestbook(onMessageAdded) {
    if (isFirebaseConfigured() && db) {
        try {
            const q = query(collection(db, 'guestbook'), orderBy('created_at', 'asc'));
            return onSnapshot(q, (snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        const data = { id: change.doc.id, ...change.doc.data() };
                        onMessageAdded(data);
                    }
                });
            }, (error) => {
                console.warn("Firestore guestbook live subscription failed:", error);
            });
        } catch (e) {
            console.warn("Firestore subscription init error:", e);
        }
    }
    return () => {};
}

// --- Remote Config API (Owner Edit Mode) ---
export async function loadRemoteConfig() {
    const config = {};
    if (isFirebaseConfigured() && db) {
        try {
            const wpSnap = await getDoc(doc(db, 'config', 'wallpaper_url'));
            if (wpSnap.exists() && wpSnap.data()?.value) {
                config.wallpaper = wpSnap.data().value;
            }
            const dtSnap = await getDoc(doc(db, 'config', 'desktop_data'));
            if (dtSnap.exists() && dtSnap.data()?.value !== undefined) {
                const val = dtSnap.data().value;
                if (Array.isArray(val)) {
                    config.desktopData = val;
                }
            }
            const mlSnap = await getDoc(doc(db, 'config', 'music_library'));
            if (mlSnap.exists() && mlSnap.data()?.value !== undefined) {
                const val = mlSnap.data().value;
                if (Array.isArray(val)) {
                    config.musicLibrary = val;
                }
            }
            const csSnap = await getDoc(doc(db, 'config', 'cs2_config'));
            if (csSnap.exists() && csSnap.data()) {
                config.cs2Config = csSnap.data();
            }
            if (Object.keys(config).length > 0) {
                return config;
            }
        } catch (err) {
            console.warn("Firebase remote config load error (falling back to localStorage):", err);
        }
    }
    return loadLocalOverrides();
}

export function subscribeRemoteConfig(onConfigChange) {
    if (isFirebaseConfigured() && db) {
        try {
            const unsubWp = onSnapshot(doc(db, 'config', 'wallpaper_url'), (snap) => {
                if (snap.exists() && snap.data()?.value) {
                    onConfigChange('wallpaper', snap.data().value);
                }
            }, (err) => {
                console.warn("Wallpaper snapshot listener inactive:", err?.message || err);
            });
            const unsubDt = onSnapshot(doc(db, 'config', 'desktop_data'), (snap) => {
                if (snap.exists() && snap.data()?.value !== undefined) {
                    onConfigChange('desktopData', snap.data().value);
                }
            }, (err) => {
                console.warn("Desktop data snapshot listener inactive:", err?.message || err);
            });
            const unsubMl = onSnapshot(doc(db, 'config', 'music_library'), (snap) => {
                if (snap.exists() && snap.data()?.value !== undefined) {
                    onConfigChange('musicLibrary', snap.data().value);
                }
            }, (err) => {
                console.warn("Music library snapshot listener inactive:", err?.message || err);
            });
            const unsubPw = onSnapshot(doc(db, 'config', 'pinned_windows'), (snap) => {
                if (snap.exists() && snap.data()?.value) {
                    onConfigChange('pinnedWindows', snap.data().value);
                }
            }, (err) => {
                console.warn("Pinned windows snapshot listener inactive:", err?.message || err);
            });
            const unsubCs = onSnapshot(doc(db, 'config', 'cs2_config'), (snap) => {
                if (snap.exists() && snap.data()) {
                    onConfigChange('cs2Config', snap.data());
                }
            }, (err) => {
                console.warn("CS2 config snapshot listener inactive:", err?.message || err);
            });
            return () => {
                if (unsubWp) unsubWp();
                if (unsubDt) unsubDt();
                if (unsubMl) unsubMl();
                if (unsubPw) unsubPw();
                if (unsubCs) unsubCs();
            };
        } catch (e) {
            console.warn("Remote config subscription warning:", e);
        }
    }
    return () => {};
}

// --- IndexedDB Local Audio Storage (Handles audio files of any size without quota errors) ---
const IDB_NAME = 'spiketones_media_db';
const IDB_STORE = 'audio_tracks';
const IDB_VERSION = 1;

function openAudioDb() {
    return new Promise((resolve) => {
        if (typeof window === 'undefined' || !window.indexedDB) {
            return resolve(null);
        }
        try {
            const req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = (e) => {
                const dbInstance = e.target.result;
                if (!dbInstance.objectStoreNames.contains(IDB_STORE)) {
                    dbInstance.createObjectStore(IDB_STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

export async function storeAudioInIdb(id, dataUrl) {
    try {
        const idb = await openAudioDb();
        if (!idb) return false;
        return new Promise((resolve) => {
            const tx = idb.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            store.put({ id, data: dataUrl, updated: Date.now() });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (e) {
        return false;
    }
}

export async function getAudioFromIdb(id) {
    try {
        const idb = await openAudioDb();
        if (!idb) return null;
        return new Promise((resolve) => {
            const tx = idb.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result?.data || null);
            req.onerror = () => resolve(null);
        });
    } catch (e) {
        return null;
    }
}

// Upload large audio track (up to 10MB+) directly to Cloud Storage for Firebase
export async function uploadTrackToCloudStorage(fileOrBlob, filename) {
    if (!isFirebaseStorageConfigured() || !storage) {
        return null;
    }
    try {
        const safeName = (filename || 'track.mp3').replace(/[^a-zA-Z0-9._-]/g, '_');
        const trackPath = `audio_tracks/${Date.now()}_${safeName}`;
        const fileRef = storageRef(storage, trackPath);
        const snapshot = await uploadBytes(fileRef, fileOrBlob);
        const downloadUrl = await getDownloadURL(snapshot.ref);
        console.log("Successfully uploaded track to Firebase Cloud Storage:", downloadUrl);
        return downloadUrl;
    } catch (err) {
        console.warn("Firebase Storage upload not available or permission denied (using local IndexedDB):", err);
        return null;
    }
}

// Strip heavy base64 strings from remote Firestore docs so they don't exceed the 1MB Firestore limit
function sanitizeMusicForCloud(library) {
    if (!Array.isArray(library)) return [];
    return library.map(item => {
        if (!item || typeof item !== 'object') return item;
        const copy = { ...item };
        if (typeof copy.src === 'string' && copy.src.startsWith('data:audio') && copy.src.length > 200000) {
            copy.src = copy.id ? `indexeddb:${copy.id}` : 'files/music/song1.mp3';
            copy.isLocalUpload = true;
        }
        return copy;
    });
}

function sanitizeDesktopForCloud(data) {
    if (!Array.isArray(data)) return [];
    return data.map(item => {
        if (!item || typeof item !== 'object') return item;
        const copy = { ...item };
        if (Array.isArray(copy.content)) {
            copy.content = copy.content.map(subItem => {
                if (!subItem || typeof subItem !== 'object') return subItem;
                const subCopy = { ...subItem };
                if (typeof subCopy.src === 'string' && subCopy.src.startsWith('data:audio') && subCopy.src.length > 200000) {
                    subCopy.src = subCopy.id ? `indexeddb:${subCopy.id}` : 'files/music/song1.mp3';
                    subCopy.isLocalUpload = true;
                }
                return subCopy;
            });
        }
        return copy;
    });
}

// Save Desktop Data
export async function saveDesktopData(data) {
    let savedToFirestore = false;
    const cloudPayload = sanitizeDesktopForCloud(data);
    if (isFirebaseConfigured() && db) {
        try {
            await setDoc(doc(db, 'config', 'desktop_data'), { 
                value: cloudPayload,
                updated_at: new Date().toISOString()
            }, { merge: true });
            savedToFirestore = true;
            recordDbUpdate();
        } catch (err) {
            console.warn("Firebase saveDesktopData error (saving locally):", err);
        }
    }
    try { 
        localStorage.setItem('st_desktop_data', JSON.stringify(cloudPayload)); 
    } catch(e) {
        console.warn("localStorage quota reached for desktop data:", e);
    }
    return { success: true, firestore: savedToFirestore };
}

// Save Wallpaper
export async function saveWallpaper(url) {
    let savedToFirestore = false;
    if (isFirebaseConfigured() && db) {
        try {
            await setDoc(doc(db, 'config', 'wallpaper_url'), { 
                value: url,
                updated_at: new Date().toISOString()
            }, { merge: true });
            savedToFirestore = true;
            recordDbUpdate();
        } catch (err) {
            console.warn("Firebase saveWallpaper error (saving locally):", err);
        }
    }
    try { 
        localStorage.setItem('st_wallpaper', url); 
    } catch(e) {}
    return { success: true, firestore: savedToFirestore };
}

// Save Music Library
export async function saveMusicLibrary(library) {
    let savedToFirestore = false;
    const cloudPayload = sanitizeMusicForCloud(library);
    if (isFirebaseConfigured() && db) {
        try {
            await setDoc(doc(db, 'config', 'music_library'), { 
                value: cloudPayload,
                updated_at: new Date().toISOString()
            }, { merge: true });
            savedToFirestore = true;
            recordDbUpdate();
        } catch (err) {
            console.warn("Firebase saveMusicLibrary error (saving locally):", err);
        }
    }
    try { 
        localStorage.setItem('st_music_library', JSON.stringify(cloudPayload)); 
    } catch(e) {
        console.warn("localStorage quota reached for music library:", e);
    }
    return { success: true, firestore: savedToFirestore };
}

// Save Pinned Windows
export async function savePinnedWindows(pinned) {
    let savedToFirestore = false;
    if (isFirebaseConfigured() && db) {
        try {
            await setDoc(doc(db, 'config', 'pinned_windows'), {
                value: pinned,
                updated_at: new Date().toISOString()
            }, { merge: true });
            savedToFirestore = true;
            recordDbUpdate();
        } catch (err) {
            console.warn("Firebase savePinnedWindows error (saving locally):", err);
        }
    }
    try {
        localStorage.setItem('st_pinned_windows', JSON.stringify(pinned));
    } catch(e) {}
    return { success: true, firestore: savedToFirestore };
}

// Save CS2 Config (Video URL, Leetify Profile URL, Stats)
export async function saveCs2Config(cs2Config) {
    let savedToFirestore = false;
    if (isFirebaseConfigured() && db) {
        try {
            await setDoc(doc(db, 'config', 'cs2_config'), {
                ...cs2Config,
                updated_at: new Date().toISOString()
            }, { merge: true });
            savedToFirestore = true;
            recordDbUpdate();
        } catch (err) {
            console.warn("Firebase saveCs2Config error (saving locally):", err);
        }
    }
    try {
        localStorage.setItem('st_cs2_config', JSON.stringify(cs2Config));
    } catch(e) {}
    return { success: true, firestore: savedToFirestore };
}

// Load local overrides
export function loadLocalOverrides() {
    const result = {};
    try {
        const d = localStorage.getItem('st_desktop_data');
        if (d) {
            const parsed = JSON.parse(d);
            if (Array.isArray(parsed)) {
                result.desktopData = parsed;
            }
        }
        const w = localStorage.getItem('st_wallpaper');
        if (w && typeof w === 'string') result.wallpaper = w;
        const m = localStorage.getItem('st_music_library');
        if (m) {
            const parsed = JSON.parse(m);
            if (Array.isArray(parsed)) {
                result.musicLibrary = parsed;
            }
        }
        const p = localStorage.getItem('st_pinned_windows');
        if (p) {
            const parsed = JSON.parse(p);
            if (parsed && typeof parsed === 'object') {
                result.pinnedWindows = parsed;
            }
        }
        const c = localStorage.getItem('st_cs2_config');
        if (c) {
            const parsed = JSON.parse(c);
            if (parsed && typeof parsed === 'object') {
                result.cs2Config = parsed;
            }
        }
    } catch(e) {
        console.warn("Failed parsing local overrides cache:", e);
    }
    return result;
}

export function clearCorruptedLocalCache() {
    try {
        localStorage.removeItem('st_desktop_data');
        localStorage.removeItem('st_music_library');
        localStorage.removeItem('st_pinned_windows');
        console.log("OS local storage cache reset successfully.");
    } catch(e) {}
}
