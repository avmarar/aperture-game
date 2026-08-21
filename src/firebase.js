import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";

// These come from your .env file (copy .env.example -> .env and fill in
// the values from your Firebase project's web app config).
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

// Nothing may touch the database before this resolves: the security rules key
// host privileges and per-player guess slots off auth.uid, so a write without
// a uid is always rejected.
export const authReady = new Promise((resolve, reject) => {
  const stop = onAuthStateChanged(
    auth,
    (user) => {
      if (!user) return;
      stop();
      resolve(user.uid);
    },
    reject,
  );
  signInAnonymously(auth).catch(reject);
});
