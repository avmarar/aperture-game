import { ref } from "firebase/database";
import { db } from "../firebase.js";

const room = (code) => `rooms/${code}`;

export const metaRef = (code) => ref(db, `${room(code)}/meta`);
export const setlistRef = (code) => ref(db, `${room(code)}/setlist`);
export const stateRef = (code) => ref(db, `${room(code)}/state`);
export const frameRef = (code) => ref(db, `${room(code)}/frame`);
export const playersRef = (code) => ref(db, `${room(code)}/players`);
export const playerRef = (code, uid) => ref(db, `${room(code)}/players/${uid}`);
export const submissionsRef = (code, round) => ref(db, `${room(code)}/submissions/${round}`);
export const submissionRef = (code, round, uid) => ref(db, `${room(code)}/submissions/${round}/${uid}`);
