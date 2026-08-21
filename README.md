# Aperture — local setup

A real-time "guess the image as the lens opens" party game, synced across
players with Firebase Realtime Database.

Players never receive the answers or the source images. The host's browser
flattens each aperture stage onto a canvas and publishes only that stage's
pixels; everything outside the aperture is solid black in the bytes.

## 1. Install Node

Node 18+ recommended. Check with `node -v`.

## 2. Create a free Firebase project

1. Go to https://console.firebase.google.com → **Add project** (name it
   anything, e.g. "aperture-game"). You can skip Google Analytics.
2. **Build → Realtime Database → Create Database**.
   - Choose any region.
   - Start in **locked mode** (deny all). You will paste the real rules in
     step 6.
3. **Build → Authentication → Get started → Sign-in method → Anonymous →
   Enable**. The app signs every player in anonymously so the rules can tell
   the host from everyone else.
4. **Project settings** (gear icon) → **Your apps** → **</>** (web) →
   register an app (no need for Firebase Hosting). Copy the `firebaseConfig`
   values for step 4.

## 3. Install dependencies

```bash
npm install
```

## 4. Add your Firebase config

```bash
cp .env.example .env
```

Open `.env` and fill in the values from the `firebaseConfig` object Firebase
showed you. The database URL for a default instance looks like
`https://your-project-id-default-rtdb.REGION.firebasedatabase.app`.

## 5. Run it

```bash
npm run dev
```

Open the printed `localhost` URL. To test multiplayer, open the same URL in a
second tab (or on a phone/another laptop on the same network using your
machine's local IP, e.g. `http://192.168.1.23:5173`) — one tab hosts, the rest
join with the room code.

For your team to play together over the internet, deploy the built app
(`npm run build` → the `dist/` folder) anywhere static, e.g. Vercel,
Netlify, GitHub Pages, or Firebase Hosting itself.

## 6. Publish the security rules

The game will not work until these rules are live. In the console:
**Realtime Database → Rules**, replace everything with the contents of
`database.rules.json` in this repo, then **Publish**.

Those rules:

- let anyone create a room, and lock `meta.hostUid` to the creator forever
- let only the host read/write the setlist (answers + source URLs) and the
  public game state / current frame
- let each player write only their own player record and **one** guess per
  round, while the round is active
- hide submissions from everyone except the host

## How the sync works

- `rooms/{code}/meta` — `hostUid` + createdAt. Write-once; used by the rules
  to decide who is the host.
- `rooms/{code}/setlist` — host-only. Source URLs, answers, hints. Players
  cannot read this node.
- `rooms/{code}/state` — public game state (status, round index, stage,
  scores keyed by uid, feed). Host writes; everyone listens.
- `rooms/{code}/frame` — the current aperture stage as a flattened data-URL.
  Players never see the source image.
- `rooms/{code}/players/{uid}` — display names. Each player can write only
  their own uid.
- `rooms/{code}/submissions/{round}/{uid}` — one guess per player per round.
  Host-only read; the host's browser grades them.

Scoring is still host-authoritative: first correct guess at a given aperture
stage scores full points, second half, later guesses a quarter.

## Adding your own rounds

Custom image URLs must allow cross-origin canvas reads
(`Access-Control-Allow-Origin`). Wikimedia does. Many CDNs, Google Drive, and
Dropbox share links do not — the host form will reject those with an error
rather than silently falling back to an unoccluded image.

## Trust model

This is **host-trusted**, not server-authoritative. The host already knows
every answer by design, and their browser is what grades guesses and crops
frames. A determined host can cheat; a determined player cannot read the
setlist, write scores, guess more than once, or recover pixels the aperture
has not yet opened.

There is no Cloud Function in the loop, so this stays on the Firebase free
tier.
