# Aperture — local setup

A real-time "guess the image as the lens opens" party game, synced across
players with Firebase Realtime Database.

## 1. Install Node

Node 18+ recommended. Check with `node -v`.

## 2. Create a free Firebase project

1. Go to https://console.firebase.google.com → **Add project** (name it
   anything, e.g. "aperture-game"). You can skip Google Analytics.
2. In the left sidebar: **Build → Realtime Database → Create Database**.
   - Choose any region.
   - Start in **test mode** (open read/write, expires in 30 days). This is
     fine for a one-off office game. See the security rules section below
     if you want it locked down or longer-lived.
3. In the left sidebar: **Project settings** (gear icon) → scroll to
   **Your apps** → click the **</>** (web) icon → register an app (no
   need for Firebase Hosting).
4. Firebase shows you a `firebaseConfig` object — you'll need those values
   in step 4 below.

## 3. Install dependencies

```bash
npm install
```

## 4. Add your Firebase config

```bash
cp .env.example .env
```

Open `.env` and fill in the values from the `firebaseConfig` object Firebase
showed you (the database URL looks like
`https://your-project-id-default-rtdb.firebaseio.com`).

## 5. Run it

```bash
npm run dev
```

Open the printed `localhost` URL. To actually test multiplayer, open the
same URL in a second tab (or on a phone/another laptop on the same network
using your machine's local IP instead of `localhost`, e.g.
`http://192.168.1.23:5173`) — one tab hosts, the rest join with the room
code.

For your team to play together over the internet, deploy the built app
(`npm run build` → the `dist/` folder) anywhere static, e.g. Vercel,
Netlify, GitHub Pages, or Firebase Hosting itself.

## Security rules (recommended before sharing widely)

Test mode opens your whole database to anyone with the URL. For a quick
one-off game that's usually fine, but if you want it scoped to just this
app's data, use these rules instead (Realtime Database → Rules tab):

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

This still has no auth (anyone with a room code can read/write that room),
which matches how the game already works — the room code is the shared
secret. It just prevents access to any other data in the same Firebase
project.

## How the sync works

- `rooms/{code}/state` — the single source of truth for the room (rounds,
  score, current stage, feed). The host writes to it; everyone listens
  with `onValue` for instant updates.
- `rooms/{code}/players/{name}` — one entry per player.
- `rooms/{code}/submissions/{roundIndex}` — append-only guesses. The host's
  browser listens with `onChildAdded`, checks each guess against the
  answer, and awards points — same scoring logic as the original version
  (first correct guess at a given aperture stage scores highest).
