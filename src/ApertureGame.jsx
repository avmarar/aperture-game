import React, { useState, useEffect, useRef } from "react";
import { db } from "./firebase.js";
import { ref, set, get, onValue, onChildAdded, push, child } from "firebase/database";

/* ────────────────────────────────────────────────────────────────
   APERTURE — a live "guess the image as the lens opens" party game
   Design language: camera / darkroom HUD. Warm black, amber optics.
   Realtime sync via Firebase Realtime Database.
   ──────────────────────────────────────────────────────────────── */

const STAGES = [
  { scale: 4.2, vignette: 9, label: "PINHOLE", points: 1000 },
  { scale: 3.2, vignette: 16, label: "SLIVER", points: 800 },
  { scale: 2.3, vignette: 26, label: "NARROW", points: 600 },
  { scale: 1.7, vignette: 42, label: "WIDENING", points: 400 },
  { scale: 1.25, vignette: 68, label: "OPEN", points: 250 },
  { scale: 1, vignette: 150, label: "FULL", points: 100 },
];

const STARTER_ROUNDS = [
  { id: "s1", url: "https://commons.wikimedia.org/wiki/Special:FilePath/Tour_Eiffel_Wikimedia_Commons.jpg", answer: "Eiffel Tower", hint: "Parisian landmark" },
  { id: "s2", url: "https://commons.wikimedia.org/wiki/Special:FilePath/Giraffe_Mikumi_National_Park.jpg", answer: "Giraffe", hint: "Tallest land mammal" },
  { id: "s3", url: "https://commons.wikimedia.org/wiki/Special:FilePath/Yellow_Rubber_Duck.jpg", answer: "Rubber Duck", hint: "Bath time icon" },
  { id: "s4", url: "https://commons.wikimedia.org/wiki/Special:FilePath/GoldenGateBridge-001.jpg", answer: "Golden Gate Bridge", hint: "San Francisco crossing" },
  { id: "s5", url: "https://commons.wikimedia.org/wiki/Special:FilePath/Mona_Lisa.jpg", answer: "Mona Lisa", hint: "Mysterious smile" },
  { id: "s6", url: "https://commons.wikimedia.org/wiki/Special:FilePath/Strawberry.jpg", answer: "Strawberry", hint: "Seeded red fruit" },
  { id: "s7", url: "https://commons.wikimedia.org/wiki/Special:FilePath/FullMoon2010.jpg", answer: "Moon", hint: "Earth's natural satellite" },
  { id: "s8", url: "https://commons.wikimedia.org/wiki/Special:FilePath/Great_Pyramid_of_Giza.jpg", answer: "Pyramid of Giza", hint: "Ancient wonder in Egypt" },
  { id: "s9", url: "https://commons.wikimedia.org/wiki/Special:FilePath/Basketball_Clipart.svg", answer: "Basketball", hint: "Orange pebbled sphere" },
  { id: "s10", url: "https://commons.wikimedia.org/wiki/Special:FilePath/Tennis_Racket_and_Balls.jpg", answer: "Tennis Ball", hint: "Fuzzy neon sphere" },
];

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ";
const genCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
const genId = () => Math.random().toString(36).slice(2, 10);
const normalize = (s) => (s || "").toLowerCase().trim().replace(/[^a-z0-9 ]/g, "");
const safeKey = (s) => normalize(s).replace(/\s+/g, "_") || genId(); // Firebase keys can't contain . # $ [ ] /
const isCorrect = (guess, answer) => {
  const g = normalize(guess), a = normalize(answer);
  if (!g || !a) return false;
  if (g === a) return true;
  if (a.length > 3 && g.includes(a)) return true;
  if (g.length > 3 && a.includes(g)) return true;
  return false;
};

/* ---------- Firebase refs & helpers ---------- */
const roomRef = (code) => ref(db, `rooms/${code}/state`);
const playersRef = (code) => ref(db, `rooms/${code}/players`);
const submissionsRef = (code, roundIdx) => ref(db, `rooms/${code}/submissions/${roundIdx}`);

function freshState(code, hostName) {
  return {
    code,
    host: hostName,
    status: "lobby", // lobby | playing | ended
    rounds: STARTER_ROUNDS.map((r) => ({ ...r })),
    currentIndex: 0,
    stage: 0,
    roundActive: false,
    creditedThisRound: {},
    scores: {},
    feed: [{ id: genId(), type: "system", text: "Room created. Waiting for players…" }],
    updatedAt: Date.now(),
  };
}

function pushFeed(state, entry) {
  const feed = [{ id: genId(), ...entry }, ...(state.feed || [])].slice(0, 10);
  return { ...state, feed };
}

export default function ApertureGame() {
  const [screen, setScreen] = useState("landing"); // landing | create | join | room
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const roomLive = useRef(null); // always-current room snapshot for listener callbacks
  useEffect(() => {
    roomLive.current = room;
  }, [room]);

  /* ---------- subscribe to room state + players ---------- */
  useEffect(() => {
    if (screen !== "room" || !code) return;
    const sRef = roomRef(code);
    const pRef = playersRef(code);

    const unsubState = onValue(sRef, (snap) => {
      const val = snap.val();
      if (val) {
        // Firebase can drop empty objects/arrays; normalize defensively
        val.rounds = val.rounds || [];
        val.scores = val.scores || {};
        val.creditedThisRound = val.creditedThisRound || {};
        val.feed = val.feed || [];
        setRoom(val);
      }
    });
    const unsubPlayers = onValue(pRef, (snap) => {
      const val = snap.val() || {};
      setPlayers(Object.values(val).map((p) => p.name));
    });

    return () => {
      unsubState();
      unsubPlayers();
    };
  }, [screen, code]);

  /* ---------- host: listen for guess submissions on the current round ---------- */
  useEffect(() => {
    if (!isHost || !room || room.status !== "playing") return;
    const subRef = submissionsRef(code, room.currentIndex);

    const unsub = onChildAdded(subRef, (snap) => {
      const sub = snap.val();
      const cur = roomLive.current;
      if (!cur || !sub) return;
      if (cur.creditedThisRound && cur.creditedThisRound[sub.name]) return;
      const round = cur.rounds[cur.currentIndex];
      if (!round) return;
      if (!isCorrect(sub.text, round.answer)) return;

      const rank = Object.keys(cur.creditedThisRound || {}).length;
      const base = STAGES[cur.stage].points;
      const pts = rank === 0 ? base : rank === 1 ? Math.round(base / 2) : Math.max(50, Math.round(base / 4));

      let next = {
        ...cur,
        creditedThisRound: { ...cur.creditedThisRound, [sub.name]: true },
        scores: { ...cur.scores, [sub.name]: (cur.scores[sub.name] || 0) + pts },
      };
      next = pushFeed(next, { type: "correct", text: `${sub.name} nailed it — +${pts}` });
      next.updatedAt = Date.now();
      set(roomRef(code), next);
    });

    return () => unsub();
  }, [isHost, code, room?.status, room?.currentIndex]);

  /* ---------- actions ---------- */
  const handleCreate = async () => {
    if (!name.trim()) return setError("Enter your name first.");
    setBusy(true);
    const c = genCode();
    const st = freshState(c, name.trim());
    await set(roomRef(c), st);
    await set(child(playersRef(c), safeKey(name)), { name: name.trim(), joinedAt: Date.now() });
    setCode(c);
    setIsHost(true);
    setRoom(st);
    setScreen("room");
    setBusy(false);
  };

  const handleJoin = async () => {
    if (!name.trim()) return setError("Enter your name first.");
    if (!code.trim()) return setError("Enter the 4-letter room code.");
    setBusy(true);
    const c = code.trim().toUpperCase();
    const snap = await get(roomRef(c));
    const st = snap.val();
    if (!st) {
      setError("No room found with that code.");
      setBusy(false);
      return;
    }
    await set(child(playersRef(c), safeKey(name)), { name: name.trim(), joinedAt: Date.now() });
    setCode(c);
    setIsHost(false);
    setRoom(st);
    setScreen("room");
    setError("");
    setBusy(false);
  };

  const updateRoom = (mutator) => {
    setRoom((prev) => {
      if (!prev) return prev;
      const next = mutator({ ...prev });
      next.updatedAt = Date.now();
      set(roomRef(code), next);
      return next;
    });
  };

  const addRound = (url, answer, hint) => {
    updateRoom((s) => ({ ...s, rounds: [...s.rounds, { id: genId(), url, answer, hint }] }));
  };
  const removeRound = (id) => {
    updateRoom((s) => ({ ...s, rounds: s.rounds.filter((r) => r.id !== id) }));
  };
  const startGame = () => {
    updateRoom((s) => pushFeed({ ...s, status: "playing", currentIndex: 0, stage: 0, roundActive: true, creditedThisRound: {} }, { type: "system", text: `Round 1: the aperture opens…` }));
  };
  const openAperture = () => {
    updateRoom((s) => (s.stage < STAGES.length - 1 ? { ...s, stage: s.stage + 1 } : s));
  };
  const revealAnswer = () => {
    updateRoom((s) => pushFeed({ ...s, roundActive: false }, { type: "reveal", text: `Answer: ${s.rounds[s.currentIndex]?.answer}` }));
  };
  const nextRound = () => {
    updateRoom((s) => {
      const ni = s.currentIndex + 1;
      if (ni >= s.rounds.length) {
        return pushFeed({ ...s, status: "ended" }, { type: "system", text: "That's a wrap! Final scores are in." });
      }
      return pushFeed({ ...s, currentIndex: ni, stage: 0, roundActive: true, creditedThisRound: {} }, { type: "system", text: `Round ${ni + 1}: the aperture opens…` });
    });
  };

  const submitGuess = async (text) => {
    if (!room || !room.roundActive) return;
    await push(submissionsRef(code, room.currentIndex), { name: name.trim(), text, ts: Date.now() });
  };

  /* ---------- render ---------- */
  return (
    <div style={S.app}>
      <GlobalStyle />
      {screen === "landing" && <Landing onCreate={() => setScreen("create")} onJoin={() => setScreen("join")} />}
      {screen === "create" && (
        <NameGate
          title="HOST A ROOM"
          sub="Name your camera operator alias."
          name={name}
          setName={setName}
          error={error}
          busy={busy}
          onBack={() => { setScreen("landing"); setError(""); }}
          onSubmit={handleCreate}
          submitLabel="Create Room"
        />
      )}
      {screen === "join" && (
        <NameGate
          title="JOIN A ROOM"
          sub="Enter your name and the room code."
          name={name}
          setName={setName}
          error={error}
          busy={busy}
          onBack={() => { setScreen("landing"); setError(""); }}
          onSubmit={handleJoin}
          submitLabel="Join Room"
          showCode
          code={code}
          setCode={setCode}
        />
      )}
      {screen === "room" && room && (
        <RoomView
          room={room}
          players={players}
          isHost={isHost}
          myName={name.trim()}
          onAddRound={addRound}
          onRemoveRound={removeRound}
          onStart={startGame}
          onOpenAperture={openAperture}
          onReveal={revealAnswer}
          onNext={nextRound}
          onSubmitGuess={submitGuess}
        />
      )}
    </div>
  );
}

/* ──────────────────────── Screens ──────────────────────── */

function Landing({ onCreate, onJoin }) {
  return (
    <div style={S.centerWrap}>
      <div style={S.lensMark}>
        <div style={S.lensRing} />
        <div style={S.lensRing2} />
        <div style={S.lensCore} />
      </div>
      <div style={S.eyebrow}>OFFICE PARTY GAME</div>
      <h1 style={S.h1}>APERTURE</h1>
      <p style={S.tagline}>Guess the picture before the lens opens all the way.</p>
      <div style={S.btnRow}>
        <button style={S.btnPrimary} onClick={onCreate}>Host a Room</button>
        <button style={S.btnGhost} onClick={onJoin}>Join a Room</button>
      </div>
      <div style={S.footNote}>7–15 players · one host runs the lens, everyone else guesses</div>
    </div>
  );
}

function NameGate({ title, sub, name, setName, code, setCode, error, busy, onBack, onSubmit, submitLabel, showCode }) {
  return (
    <div style={S.centerWrap}>
      <button style={S.backBtn} onClick={onBack}>← back</button>
      <div style={S.eyebrow}>{title}</div>
      <p style={S.tagline}>{sub}</p>
      <div style={S.formCol}>
        <input
          style={S.input}
          placeholder="Your name"
          value={name}
          maxLength={20}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !showCode && onSubmit()}
        />
        {showCode && (
          <input
            style={{ ...S.input, ...S.mono, letterSpacing: "0.3em", textTransform: "uppercase" }}
            placeholder="CODE"
            value={code}
            maxLength={4}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          />
        )}
        {error && <div style={S.error}>{error}</div>}
        <button style={S.btnPrimary} onClick={onSubmit} disabled={busy}>
          {busy ? "…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function RoomView({ room, players, isHost, myName, onAddRound, onRemoveRound, onStart, onOpenAperture, onReveal, onNext, onSubmitGuess }) {
  return (
    <div style={S.roomWrap}>
      <TopBar room={room} players={players} isHost={isHost} />
      {room.status === "lobby" && (
        <Lobby room={room} players={players} isHost={isHost} onAddRound={onAddRound} onRemoveRound={onRemoveRound} onStart={onStart} />
      )}
      {room.status === "playing" && (
        <PlayScreen room={room} isHost={isHost} myName={myName} onOpenAperture={onOpenAperture} onReveal={onReveal} onNext={onNext} onSubmitGuess={onSubmitGuess} />
      )}
      {room.status === "ended" && <EndScreen room={room} />}
    </div>
  );
}

function TopBar({ room, players, isHost }) {
  return (
    <div style={S.topBar}>
      <div>
        <div style={S.topBarLabel}>ROOM</div>
        <div style={{ ...S.mono, fontSize: 22, letterSpacing: "0.25em", color: "#FFB454" }}>{room.code}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={S.topBarLabel}>{isHost ? "YOU ARE HOSTING" : "PLAYERS"}</div>
        <div style={{ ...S.mono, fontSize: 14, color: "#9C948A" }}>{players.length} in room</div>
      </div>
    </div>
  );
}

function Lobby({ room, players, isHost, onAddRound, onRemoveRound, onStart }) {
  const [url, setUrl] = useState("");
  const [answer, setAnswer] = useState("");
  const [hint, setHint] = useState("");

  return (
    <div style={S.lobbyGrid}>
      <div style={S.panel}>
        <div style={S.panelTitle}>ROUNDS ({room.rounds.length})</div>
        <div style={S.roundList}>
          {room.rounds.map((r, i) => (
            <div key={r.id} style={S.roundRow}>
              <img src={r.url} alt="" style={S.roundThumb} onError={(e) => (e.target.style.opacity = 0.15)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{i + 1}. {r.answer}</div>
                <div style={{ fontSize: 12, color: "#9C948A" }}>{r.hint}</div>
              </div>
              {isHost && <button style={S.smallGhostBtn} onClick={() => onRemoveRound(r.id)}>remove</button>}
            </div>
          ))}
        </div>
        {isHost && (
          <div style={S.addRoundForm}>
            <div style={S.panelTitle}>ADD YOUR OWN ROUND</div>
            <input style={S.input} placeholder="Image URL (company photo, logo, meme…)" value={url} onChange={(e) => setUrl(e.target.value)} />
            <input style={S.input} placeholder="Answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <input style={S.input} placeholder="Hint (optional)" value={hint} onChange={(e) => setHint(e.target.value)} />
            <button
              style={S.btnGhost}
              onClick={() => {
                if (!url.trim() || !answer.trim()) return;
                onAddRound(url.trim(), answer.trim(), hint.trim());
                setUrl(""); setAnswer(""); setHint("");
              }}
            >
              + Add Round
            </button>
          </div>
        )}
      </div>

      <div style={S.panel}>
        <div style={S.panelTitle}>PLAYERS</div>
        <div style={S.playerChips}>
          {players.length === 0 && <div style={{ color: "#9C948A", fontSize: 13 }}>Waiting for people to join…</div>}
          {players.map((p) => (
            <div key={p} style={S.chip}>{p}{p === room.host ? " · host" : ""}</div>
          ))}
        </div>
        {isHost ? (
          <button style={S.btnPrimary} disabled={room.rounds.length === 0} onClick={onStart}>
            Start Game
          </button>
        ) : (
          <div style={S.waitingNote}>Waiting for {room.host} to start the game…</div>
        )}
      </div>
    </div>
  );
}

function PlayScreen({ room, isHost, myName, onOpenAperture, onReveal, onNext, onSubmitGuess }) {
  const round = room.rounds[room.currentIndex];
  const stage = STAGES[room.stage];
  const [guess, setGuess] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setSubmitted(false);
    setGuess("");
    setImgError(false);
  }, [room.currentIndex]);

  const scoresSorted = Object.entries(room.scores).sort((a, b) => b[1] - a[1]);

  const doSubmit = () => {
    if (!guess.trim() || submitted || !room.roundActive) return;
    onSubmitGuess(guess.trim());
    setSubmitted(true);
  };

  return (
    <div style={S.playGrid}>
      <div style={S.viewportPanel}>
        <div style={S.roundMeta}>
          <span style={S.mono}>ROUND {room.currentIndex + 1} / {room.rounds.length}</span>
          <span style={{ ...S.mono, color: "#FFB454" }}>{stage.label} · worth {stage.points}</span>
        </div>

        <div style={S.viewport}>
          {imgError ? (
            <div style={S.imgFallback}>Image didn't load. {isHost ? "Skip this round with Next." : "Ask the host to skip."}</div>
          ) : (
            <img
              src={round.url}
              alt=""
              onError={() => setImgError(true)}
              style={{ ...S.viewportImg, transform: `scale(${stage.scale})` }}
            />
          )}
          <div
            style={{
              ...S.vignette,
              background: `radial-gradient(circle at 50% 50%, transparent ${stage.vignette}%, rgba(10,8,6,0.97) ${stage.vignette + 16}%)`,
            }}
          />
          <div style={S.apertureTicks}>
            {STAGES.map((s, i) => (
              <div key={i} style={{ ...S.tick, opacity: i <= room.stage ? 1 : 0.25, background: i <= room.stage ? "#FFB454" : "#5A5248" }} />
            ))}
          </div>
        </div>

        {!isHost && (
          <div style={S.guessRow}>
            <input
              style={{ ...S.input, flex: 1 }}
              placeholder={room.roundActive ? "Type your guess…" : "Waiting for next round…"}
              value={guess}
              disabled={!room.roundActive || submitted}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSubmit()}
            />
            <button style={S.btnPrimary} disabled={!room.roundActive || submitted} onClick={doSubmit}>
              {submitted ? "Sent ✓" : "Guess"}
            </button>
          </div>
        )}

        {isHost && (
          <div style={S.hostControls}>
            {round.hint && <div style={S.hintText}>Hint on card: “{round.hint}”</div>}
            {room.roundActive ? (
              <div style={S.btnRow}>
                <button style={S.btnGhost} disabled={room.stage >= STAGES.length - 1} onClick={onOpenAperture}>
                  Open Aperture
                </button>
                <button style={S.btnPrimary} onClick={onReveal}>Reveal Answer</button>
              </div>
            ) : (
              <div style={S.btnRow}>
                <div style={S.answerReveal}>It was: <strong>{round.answer}</strong></div>
                <button style={S.btnPrimary} onClick={onNext}>
                  {room.currentIndex + 1 >= room.rounds.length ? "Finish Game" : "Next Round"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={S.sidePanel}>
        <div style={S.panelTitle}>LEADERBOARD</div>
        <div style={S.leaderboard}>
          {scoresSorted.length === 0 && <div style={{ color: "#9C948A", fontSize: 13 }}>No points yet — be first!</div>}
          {scoresSorted.map(([n, pts], i) => (
            <div key={n} style={S.leaderRow}>
              <span style={S.mono}>#{i + 1}</span>
              <span style={{ flex: 1, fontWeight: n === myName ? 700 : 400 }}>{n}{n === myName ? " (you)" : ""}</span>
              <span style={{ ...S.mono, color: "#FFB454" }}>{pts}</span>
            </div>
          ))}
        </div>
        <div style={S.panelTitle}>FEED</div>
        <div style={S.feedList}>
          {room.feed.map((f) => (
            <div key={f.id} style={{ ...S.feedItem, color: f.type === "correct" ? "#34D8B0" : f.type === "reveal" ? "#FFB454" : "#9C948A" }}>
              {f.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EndScreen({ room }) {
  const scoresSorted = Object.entries(room.scores).sort((a, b) => b[1] - a[1]);
  return (
    <div style={S.centerWrap}>
      <div style={S.eyebrow}>GAME OVER</div>
      <h1 style={S.h1}>FULL APERTURE</h1>
      <div style={{ ...S.panel, width: "100%", maxWidth: 420 }}>
        <div style={S.panelTitle}>FINAL SCORES</div>
        <div style={S.leaderboard}>
          {scoresSorted.length === 0 && <div style={{ color: "#9C948A" }}>Nobody scored — tough crowd.</div>}
          {scoresSorted.map(([n, pts], i) => (
            <div key={n} style={S.leaderRow}>
              <span style={S.mono}>{i === 0 ? "🏆" : `#${i + 1}`}</span>
              <span style={{ flex: 1 }}>{n}</span>
              <span style={{ ...S.mono, color: "#FFB454" }}>{pts}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={S.footNote}>Refresh to start a new room.</div>
    </div>
  );
}

/* ──────────────────────── Style tokens ──────────────────────── */

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@500;700&family=Inter:wght@400;500;600&display=swap');
      * { box-sizing: border-box; }
      body { margin: 0; }
      input::placeholder { color: #6B6459; }
      input:focus { outline: 2px solid #FFB454; outline-offset: 1px; }
      button:focus-visible { outline: 2px solid #FFB454; outline-offset: 2px; }
      button { cursor: pointer; font-family: 'Inter', sans-serif; transition: transform 0.12s ease, background 0.12s ease; }
      button:hover:not(:disabled) { transform: translateY(-1px); }
      button:disabled { opacity: 0.4; cursor: not-allowed; }
      @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
    `}</style>
  );
}

const S = {
  app: { minHeight: "100vh", background: "#0F0D0B", color: "#F3EEE4", fontFamily: "'Inter', sans-serif", padding: "24px 16px" },
  mono: { fontFamily: "'JetBrains Mono', monospace" },
  centerWrap: { maxWidth: 460, margin: "40px auto", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", position: "relative" },
  lensMark: { position: "relative", width: 90, height: 90, marginBottom: 8 },
  lensRing: { position: "absolute", inset: 0, borderRadius: "50%", border: "2px solid #3A342C" },
  lensRing2: { position: "absolute", inset: 14, borderRadius: "50%", border: "2px solid #FFB454" },
  lensCore: { position: "absolute", inset: 36, borderRadius: "50%", background: "#FFB454" },
  eyebrow: { fontFamily: "'JetBrains Mono', monospace", fontSize: 12, letterSpacing: "0.3em", color: "#9C948A", marginTop: 8 },
  h1: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 48, letterSpacing: "0.04em", margin: "4px 0 8px" },
  tagline: { color: "#9C948A", fontSize: 15, marginBottom: 24, maxWidth: 340 },
  btnRow: { display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" },
  btnPrimary: { background: "#FFB454", color: "#1A1310", border: "none", borderRadius: 8, padding: "12px 22px", fontWeight: 700, fontSize: 14, letterSpacing: "0.02em" },
  btnGhost: { background: "transparent", color: "#F3EEE4", border: "1px solid #3A342C", borderRadius: 8, padding: "12px 22px", fontWeight: 600, fontSize: 14 },
  smallGhostBtn: { background: "transparent", color: "#9C948A", border: "1px solid #3A342C", borderRadius: 6, padding: "4px 8px", fontSize: 11 },
  footNote: { marginTop: 24, fontSize: 12, color: "#6B6459" },
  backBtn: { alignSelf: "flex-start", background: "none", border: "none", color: "#9C948A", fontSize: 13, marginBottom: 12 },
  formCol: { display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 320 },
  input: { background: "#1A1613", border: "1px solid #3A342C", borderRadius: 8, color: "#F3EEE4", padding: "12px 14px", fontSize: 14, fontFamily: "'Inter', sans-serif" },
  error: { color: "#E2604F", fontSize: 13 },
  roomWrap: { maxWidth: 920, margin: "0 auto" },
  topBar: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "1px solid #3A342C", paddingBottom: 14, marginBottom: 20 },
  topBarLabel: { fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.2em", color: "#6B6459" },
  lobbyGrid: { display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 },
  panel: { background: "#1A1613", border: "1px solid #2A251F", borderRadius: 12, padding: 18 },
  panelTitle: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: "0.2em", color: "#6B6459", marginBottom: 10 },
  roundList: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 },
  roundRow: { display: "flex", alignItems: "center", gap: 10 },
  roundThumb: { width: 42, height: 42, objectFit: "cover", borderRadius: 6, background: "#0F0D0B" },
  addRoundForm: { display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid #2A251F", paddingTop: 14 },
  playerChips: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16, minHeight: 30 },
  chip: { background: "#0F0D0B", border: "1px solid #3A342C", borderRadius: 20, padding: "4px 12px", fontSize: 12 },
  waitingNote: { color: "#9C948A", fontSize: 13 },
  playGrid: { display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 },
  viewportPanel: { background: "#1A1613", border: "1px solid #2A251F", borderRadius: 12, padding: 18 },
  roundMeta: { display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 10, color: "#9C948A" },
  viewport: { position: "relative", width: "100%", aspectRatio: "4 / 3", overflow: "hidden", borderRadius: 10, background: "#0A0806" },
  viewportImg: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transition: "transform 1.1s cubic-bezier(0.22,1,0.36,1)" },
  vignette: { position: "absolute", inset: 0, transition: "background 1.1s ease" },
  imgFallback: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#9C948A", fontSize: 13, padding: 20, textAlign: "center" },
  apertureTicks: { position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 5 },
  tick: { width: 18, height: 4, borderRadius: 2, transition: "background 0.3s ease, opacity 0.3s ease" },
  guessRow: { display: "flex", gap: 8, marginTop: 14 },
  hostControls: { marginTop: 14, display: "flex", flexDirection: "column", gap: 10 },
  hintText: { color: "#9C948A", fontSize: 13, fontStyle: "italic" },
  answerReveal: { fontSize: 14, color: "#F3EEE4" },
  sidePanel: { background: "#1A1613", border: "1px solid #2A251F", borderRadius: 12, padding: 18, display: "flex", flexDirection: "column" },
  leaderboard: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 },
  leaderRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14 },
  feedList: { display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, overflowY: "auto", maxHeight: 220 },
  feedItem: { lineHeight: 1.4 },
};
