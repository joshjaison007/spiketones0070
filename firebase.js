// Firebase SDK initialization with provided project configuration
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";
import { 
    getFirestore, 
    collection, 
    addDoc, 
    getDocs, 
    onSnapshot, 
    setDoc, 
    getDoc, 
    doc, 
    query, 
    orderBy, 
    deleteDoc 
} from "firebase/firestore";
import { 
    getStorage, 
    ref as storageRef, 
    uploadBytes, 
    getDownloadURL 
} from "firebase/storage";

// User provided Firebase configuration for spiketones7
export const firebaseConfig = {
  apiKey: "AIzaSyDQmlRTr0Z-d_wKDpCXiKGYcvwIYWb2ytw",
  authDomain: "spiketones7.firebaseapp.com",
  projectId: "spiketones7",
  storageBucket: "spiketones7.firebasestorage.app",
  messagingSenderId: "761269257502",
  appId: "1:761269257502:web:e167c812a0b2fb9db7750f",
  measurementId: "G-YZHGLRTGZY"
};

let app = null;
let db = null;
let storage = null;
let analytics = null;
let isConfigured = false;

try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    try {
        storage = getStorage(app);
    } catch (sErr) {
        console.warn("Firebase Storage initialization warning:", sErr);
    }
    isConfigured = true;
    console.log("Firebase App & Firestore initialized for:", firebaseConfig.projectId);

    if (typeof window !== "undefined") {
        isSupported().then(supported => {
            if (supported) {
                analytics = getAnalytics(app);
            }
        }).catch(() => {});
    }
} catch (error) {
    console.warn("Firebase initialization warning (will fall back to localStorage):", error);
    isConfigured = false;
}

export function isFirebaseConfigured() {
    return isConfigured && db !== null;
}

export function isFirebaseStorageConfigured() {
    return isConfigured && storage !== null;
}

export { 
    app, 
    db, 
    storage,
    storageRef,
    uploadBytes,
    getDownloadURL,
    analytics, 
    collection, 
    addDoc, 
    getDocs, 
    onSnapshot, 
    setDoc, 
    getDoc, 
    doc, 
    query, 
    orderBy, 
    deleteDoc 
};
