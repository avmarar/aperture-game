import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, onChildAdded, onValue, runTransaction, set } from "firebase/database";
import { authReady } from "./firebase.js";
import { FEED_LENGTH, MAX_GUESS, MAX_NAME, STAGES, STARTER_ROUNDS, awardPoints, stagePoints } from "./game/constants.js";
import { genCode, genId, isCorrect } from "./game/text.js";
import { ImageSourceError, assertUsableImage, loadImage, renderRoundFrames } from "./game/occlusion.js";
import {
  frameRef,
  metaRef,
  playerRef,
  playersRef,
  setlistRef,
  stateRef,
  submissionRef,
  submissionsRef,
} from "./game/paths.js";

/* ────────────────────────────────────────────────────────────────
   APERTURE — a live "guess the image as the lens opens" party game
   Design language: camera / darkroom HUD. Warm black, amber optics.

   Players never receive the answers or the source images. The host's
   browser flattens each aperture stage onto a canvas and publishes only
   that stage's pixels; everything else is solid black in the bytes.
   ──────────────────────────────────────────────────────────────── */

function freshState(code, hostName, roundCount) {
  return {
    code,
    host: hostName,
    status: "lobby", // lobby | playing | ended
    roundCount,
    currentIndex: 0,
    stage: 0,
    roundActive: false,
    credited: {},
    scores: {},
    feed: [{ id: genId(), type: "system", text: "Room created. Waiting for players…" }],
    updatedAt: Date.now(),
  };
}

function pushFeed(state, entry) {
  const feed = [{ id: genId(), ...entry }, ...(state.feed || [])].slice(0, FEED_LENGTH);
  return { ...state, feed };
}

export default function ApertureGame() {
  const [uid, setUid] = useState(null);
  const [authError, setAuthError] = useState("");

  const [screen, setScreen] = useState("landing"); // landing | create | join | room
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isHost, setIsHost] = useState(false);

  const [state, setState] = useState(null);
  const [players, setPlayers] = useState({});
  const [setlist, setSetlist] = useState([]); // host-only; players never read this
  const [frame, setFrame] = useState(null);

  const [error, setError] = useState("");
  const [frameError, setFrameError] = useState("");
  const [busy, setBusy] = useState(false);

  // Always-current snapshots for listener and transaction callbacks.
  const stateLive = useRef(null);
  const playersLive = useRef({});
  const setlistLive = useRef([]);
  useEffect(() => { stateLive.current = state; }, [state]);
  useEffect(() => { playersLive.current = players; }, [players]);
  useEffect(() => { setlistLive.current = setlist; }, [setlist]);

  useEffect(() => {
    authReady.then(setUid).catch((e) => setAuthError(e?.message || "Could not sign in anonymously."));
  }, []);

  /* ---------- public room data: state, players, current frame ---------- */
  useEffect(() => {
    if (screen !== "room" || !code || !uid) return;
    const unsubs = [
      onValue(stateRef(code), (snap) => {
        const val = snap.val();
        if (!val) return;
        // Firebase drops empty objects/arrays; normalize defensively.
        val.scores = val.scores || {};
        val.credited = val.credited || {};
        val.feed = val.feed || [];
        setState(val);
      }),
      onValue(playersRef(code), (snap) => setPlayers(snap.val() || {})),
      onValue(frameRef(code), (snap) => setFrame(snap.val() || null)),
    ];
    return () => unsubs.forEach((stop) => stop());
  }, [screen, code, uid]);

  /* ---------- host-only: the setlist with answers ---------- */
  useEffect(() => {
    if (!isHost || screen !== "room" || !code || !uid) return;
    return onValue(setlistRef(code), (snap) => setSetlist(snap.val() || []));
  }, [isHost, screen, code, uid]);

  /* ---------- host-only: grade incoming guesses ---------- */
  useEffect(() => {
    if (!isHost || !code || state?.status !== "playing") return;
    const round = state.currentIndex;

    return onChildAdded(submissionsRef(code, round), (snap) => {
      const guesser = snap.key;
      const sub = snap.val();
      if (!sub?.text) return;

      const answer = setlistLive.current[round]?.answer;
      if (!answer || !isCorrect(sub.text, answer)) return;
      const guesserName = playersLive.current[guesser]?.name || "Someone";

      // A transaction, because several correct guesses can land at once and
      // each one needs to see the previous one's credit.
      runTransaction(stateRef(code), (cur) => {
        if (!cur || cur.currentIndex !== round || !cur.roundActive) return;
        if (cur.credited?.[guesser]) return;

        const rank = Object.keys(cur.credited || {}).length;
        const pts = awardPoints(cur.stage, rank, !!cur.hintUsed);

        const scored = {
          ...cur,
          credited: { ...(cur.credited || {}), [guesser]: true },
          scores: { ...(cur.scores || {}), [guesser]: (cur.scores?.[guesser] || 0) + pts },
        };
        return { ...pushFeed(scored, { type: "correct", text: `${guesserName} nailed it — +${pts}` }), updatedAt: Date.now() };
      });
    });
  }, [isHost, code, state?.status, state?.currentIndex]);

  /* ---------- host-only: render and publish the current aperture frame ---------- */
  const framesCache = useRef({ round: -1, frames: null });

  useEffect(() => {
    if (!isHost || !code || state?.status !== "playing") return;
    const round = state.currentIndex;
    const stage = state.stage;
    const url = setlist[round]?.url;
    if (!url) return;

    let cancelled = false;
    (async () => {
      try {
        if (framesCache.current.round !== round) {
          setFrameError("");
          const frames = await renderRoundFrames(url);
          if (cancelled) return;
          framesCache.current = { round, frames };
        }
        const { frames } = framesCache.current;
        if (!frames || cancelled) return;
        await set(frameRef(code), { roundIndex: round, stage, src: frames[stage], at: Date.now() });

        // Warm the next image so the round change isn't waiting on the network.
        const nextUrl = setlistLive.current[round + 1]?.url;
        if (nextUrl && !cancelled) loadImage(nextUrl).catch(() => {});
      } catch (e) {
        if (!cancelled) {
          setFrameError(e instanceof ImageSourceError ? e.message : "Could not prepare this image.");
        }
      }
    })();

    return () => { cancelled = true; };
  }, [isHost, code, state?.status, state?.currentIndex, state?.stage, setlist]);

  /* ---------- host state writes ---------- */
  const mutateState = useCallback(
    (mutator) => {
      const cur = stateLive.current;
      if (!cur) return;
      const next = mutator({ ...cur });
      if (!next) return;
      next.updatedAt = Date.now();
      set(stateRef(code), next).catch((e) => setError(e?.message || "That change was rejected."));
    },
    [code],
  );

  /* ---------- actions ---------- */
  const createRoom = async () => {
    if (!uid) return;
    if (!name.trim()) return setError("Enter your name first.");
    setBusy(true);
    setError("");
    const hostName = name.trim().slice(0, MAX_NAME);

    try {
      let claimed = null;
      for (let attempt = 0; attempt < 5 && !claimed; attempt++) {
        const candidate = genCode();
        try {
          // meta is create-once in the rules, so this doubles as the
          // room-code collision check and the host's claim on the room.
          await set(metaRef(candidate), { hostUid: uid, createdAt: Date.now() });
          claimed = candidate;
        } catch {
          /* code already taken — try another */
        }
      }
      if (!claimed) throw new Error("Couldn't find a free room code. Try again.");

      await set(setlistRef(claimed), STARTER_ROUNDS.map((r) => ({ ...r })));
      await set(stateRef(claimed), freshState(claimed, hostName, STARTER_ROUNDS.length));
      await set(playerRef(claimed, uid), { name: hostName, joinedAt: Date.now() });

      setCode(claimed);
      setIsHost(true);
      setScreen("room");
    } catch (e) {
      setError(e?.message || "Could not create the room.");
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async () => {
    if (!uid) return;
    if (!name.trim()) return setError("Enter your name first.");
    if (!code.trim()) return setError("Enter the 4-letter room code.");
    setBusy(true);
    setError("");
    const target = code.trim().toUpperCase();
    const playerName = name.trim().slice(0, MAX_NAME);

    try {
      const meta = await get(metaRef(target));
      if (!meta.exists()) {
        setError("No room found with that code.");
        return;
      }
      await set(playerRef(target, uid), { name: playerName, joinedAt: Date.now() });
      setCode(target);
      setIsHost(meta.val().hostUid === uid); // lets a host who reloaded resume hosting
      setScreen("room");
    } catch (e) {
      setError(e?.message || "Could not join that room.");
    } finally {
      setBusy(false);
    }
  };

  const addRound = async (url, answer, hint) => {
    setError("");
    try {
      await assertUsableImage(url);
    } catch (e) {
      setError(e instanceof ImageSourceError ? e.message : "Could not use that image.");
      return false;
    }
    const next = [...setlistLive.current, { id: genId(), url, answer, hint }];
    await set(setlistRef(code), next);
    mutateState((s) => ({ ...s, roundCount: next.length }));
    return true;
  };

  const removeRound = async (id) => {
    const next = setlistLive.current.filter((r) => r.id !== id);
    await set(setlistRef(code), next);
    mutateState((s) => ({ ...s, roundCount: next.length }));
  };

  const startGame = () =>
    mutateState((s) =>
      pushFeed(
        { ...s, status: "playing", currentIndex: 0, stage: 0, roundActive: true, credited: {}, reveal: null, hint: null, hintUsed: false },
        { type: "system", text: "Round 1: the aperture opens…" },
      ),
    );

  const openAperture = () =>
    mutateState((s) => (s.stage < STAGES.length - 1 ? { ...s, stage: s.stage + 1 } : null));

  const revealHint = () =>
    mutateState((s) => {
      if (s.hintUsed || !s.roundActive) return null;
      const hint = (setlistLive.current[s.currentIndex]?.hint || "").trim();
      if (!hint) return null;
      return pushFeed(
        { ...s, hintUsed: true, hint },
        { type: "hint", text: `Hint revealed — scores halved. “${hint}”` },
      );
    });

  const revealAnswer = () =>
    mutateState((s) => {
      const answer = setlistLive.current[s.currentIndex]?.answer || "—";
      return pushFeed(
        { ...s, roundActive: false, stage: STAGES.length - 1, reveal: { answer } },
        { type: "reveal", text: `Answer: ${answer}` },
      );
    });

  const nextRound = () =>
    mutateState((s) => {
      const next = s.currentIndex + 1;
      if (next >= (s.roundCount || 0)) {
        return pushFeed({ ...s, status: "ended", roundActive: false }, { type: "system", text: "That's a wrap! Final scores are in." });
      }
      return pushFeed(
        { ...s, currentIndex: next, stage: 0, roundActive: true, credited: {}, reveal: null, hint: null, hintUsed: false },
        { type: "system", text: `Round ${next + 1}: the aperture opens…` },
      );
    });

  const submitGuess = async (text) => {
    const cur = stateLive.current;
    if (!cur?.roundActive || !uid) return;
    await set(submissionRef(code, cur.currentIndex, uid), { text: text.slice(0, MAX_GUESS), ts: Date.now() });
  };

  /* ---------- derived view data ---------- */
  const playerList = useMemo(
    () =>
      Object.entries(players)
        .map(([id, p]) => ({ uid: id, name: p?.name || "—", joinedAt: p?.joinedAt || 0 }))
        .sort((a, b) => a.joinedAt - b.joinedAt),
    [players],
  );

  const leaderboard = useMemo(
    () =>
      Object.entries(state?.scores || {})
        .map(([id, pts]) => ({ uid: id, pts, name: players[id]?.name || "—" }))
        .sort((a, b) => b.pts - a.pts),
    [state?.scores, players],
  );

  /* ---------- render ---------- */
  if (authError) {
    return (
      <div style={S.app}>
        <GlobalStyle />
        <div style={S.centerWrap}>
          <div style={S.eyebrow}>SHUTTER JAMMED</div>
          <p style={S.tagline}>{authError}</p>
          <div style={S.footNote}>
            Enable Anonymous sign-in under Authentication → Sign-in method in the Firebase console, then reload.
          </div>
        </div>
      </div>
    );
  }

  if (!uid) {
    return (
      <div style={S.app}>
        <GlobalStyle />
        <div style={S.centerWrap}>
          <LensMark />
          <div style={S.eyebrow}>CALIBRATING…</div>
        </div>
      </div>
    );
  }

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
          onSubmit={createRoom}
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
          onSubmit={joinRoom}
          submitLabel="Join Room"
          showCode
          code={code}
          setCode={setCode}
        />
      )}
      {screen === "room" && state && (
        <RoomView
          room={state}
          setlist={setlist}
          frame={frame}
          players={playerList}
          leaderboard={leaderboard}
          isHost={isHost}
          myUid={uid}
          error={error}
          frameError={frameError}
          onAddRound={addRound}
          onRemoveRound={removeRound}
          onStart={startGame}
          onOpenAperture={openAperture}
          onRevealHint={revealHint}
          onReveal={revealAnswer}
          onNext={nextRound}
          onSubmitGuess={submitGuess}
        />
      )}
      {screen === "room" && !state && (
        <div style={S.centerWrap}>
          <LensMark />
          <div style={S.eyebrow}>LOADING ROOM…</div>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────── Screens ──────────────────────── */

function LensMark() {
  return (
    <div style={S.lensMark}>
      <div style={S.lensRing} />
      <div style={S.lensRing2} />
      <div style={S.lensCore} />
    </div>
  );
}

function Landing({ onCreate, onJoin }) {
  return (
    <div style={S.centerWrap}>
      <LensMark />
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
          maxLength={MAX_NAME}
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

function RoomView({
  room, setlist, frame, players, leaderboard, isHost, myUid, error, frameError,
  onAddRound, onRemoveRound, onStart, onOpenAperture, onRevealHint, onReveal, onNext, onSubmitGuess,
}) {
  return (
    <div style={S.roomWrap}>
      <TopBar room={room} players={players} isHost={isHost} />
      {error && <div style={S.banner}>{error}</div>}
      {room.status === "lobby" && (
        <Lobby
          room={room}
          setlist={setlist}
          players={players}
          isHost={isHost}
          onAddRound={onAddRound}
          onRemoveRound={onRemoveRound}
          onStart={onStart}
        />
      )}
      {room.status === "playing" && (
        <PlayScreen
          room={room}
          setlist={setlist}
          frame={frame}
          leaderboard={leaderboard}
          isHost={isHost}
          myUid={myUid}
          frameError={frameError}
          onOpenAperture={onOpenAperture}
          onRevealHint={onRevealHint}
          onReveal={onReveal}
          onNext={onNext}
          onSubmitGuess={onSubmitGuess}
        />
      )}
      {room.status === "ended" && <EndScreen leaderboard={leaderboard} />}
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

function Lobby({ room, setlist, players, isHost, onAddRound, onRemoveRound, onStart }) {
  const [url, setUrl] = useState("");
  const [answer, setAnswer] = useState("");
  const [hint, setHint] = useState("");
  const [checking, setChecking] = useState(false);

  const submitRound = async () => {
    if (!url.trim() || !answer.trim()) return;
    setChecking(true);
    const ok = await onAddRound(url.trim(), answer.trim(), hint.trim());
    setChecking(false);
    if (ok) { setUrl(""); setAnswer(""); setHint(""); }
  };

  return (
    <div style={S.lobbyGrid}>
      <div style={S.panel}>
        <div style={S.panelTitle}>{isHost ? `SETLIST (${setlist.length})` : `SETLIST (${room.roundCount || 0})`}</div>

        {isHost ? (
          <>
            <div style={S.roundList}>
              {setlist.map((r, i) => (
                <div key={r.id} style={S.roundRow}>
                  <img src={r.url} alt="" style={S.roundThumb} onError={(e) => (e.target.style.opacity = 0.15)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{i + 1}. {r.answer}</div>
                    <div style={{ fontSize: 12, color: "#9C948A" }}>{r.hint}</div>
                  </div>
                  <button style={S.smallGhostBtn} onClick={() => onRemoveRound(r.id)}>remove</button>
                </div>
              ))}
            </div>
            <div style={S.hostOnlyNote}>Only you can see this list. Players just see how many rounds are queued.</div>
            <div style={S.addRoundForm}>
              <div style={S.panelTitle}>ADD YOUR OWN ROUND</div>
              <input style={S.input} placeholder="Image URL (company photo, logo, meme…)" value={url} onChange={(e) => setUrl(e.target.value)} />
              <input style={S.input} placeholder="Answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
              <input style={S.input} placeholder="Hint (optional)" value={hint} onChange={(e) => setHint(e.target.value)} />
              <button style={S.btnGhost} onClick={submitRound} disabled={checking}>
                {checking ? "checking image…" : "+ Add Round"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={S.roundList}>
              {Array.from({ length: room.roundCount || 0 }, (_, i) => (
                <div key={i} style={S.roundRow}>
                  <div style={S.sealedThumb}>◉</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "#9C948A" }}>Round {i + 1}</div>
                    <div style={{ fontSize: 12, color: "#6B6459" }}>sealed</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={S.hostOnlyNote}>Subjects stay sealed until the lens opens on them.</div>
          </>
        )}
      </div>

      <div style={S.panel}>
        <div style={S.panelTitle}>PLAYERS</div>
        <div style={S.playerChips}>
          {players.length === 0 && <div style={{ color: "#9C948A", fontSize: 13 }}>Waiting for people to join…</div>}
          {players.map((p) => (
            <div key={p.uid} style={S.chip}>{p.name}{p.name === room.host ? " · host" : ""}</div>
          ))}
        </div>
        {isHost ? (
          <button style={S.btnPrimary} disabled={setlist.length === 0} onClick={onStart}>Start Game</button>
        ) : (
          <div style={S.waitingNote}>Waiting for {room.host} to start the game…</div>
        )}
      </div>
    </div>
  );
}

// Cross-dissolves between published frames so the aperture still reads as
// opening, even though each stage arrives as a discrete flattened image.
function ApertureFrame({ src }) {
  const previous = useRef(null);
  const behind = previous.current !== src ? previous.current : null;
  useEffect(() => { previous.current = src; }, [src]);

  return (
    <>
      {behind && <img src={behind} alt="" aria-hidden="true" style={S.frameImg} />}
      <img key={src} src={src} alt="" style={{ ...S.frameImg, animation: "apertureIn 900ms ease-out both" }} />
    </>
  );
}

function PlayScreen({
  room, setlist, frame, leaderboard, isHost, myUid, frameError,
  onOpenAperture, onRevealHint, onReveal, onNext, onSubmitGuess,
}) {
  const stage = STAGES[room.stage];
  const worth = stagePoints(room.stage, !!room.hintUsed);
  const hostRound = isHost ? setlist[room.currentIndex] : null;
  const hasHint = !!(hostRound?.hint || room.hint);
  const [guess, setGuess] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    setGuess("");
    setStatus("idle");
    setStatusMsg("");
  }, [room.currentIndex]);

  // Never show a frame from a previous round, and never one that is further
  // open than the round's current stage.
  const liveFrame =
    frame && frame.roundIndex === room.currentIndex && frame.stage <= room.stage ? frame.src : null;

  const doSubmit = async () => {
    if (!guess.trim() || status === "sending" || status === "sent" || !room.roundActive) return;
    setStatus("sending");
    try {
      await onSubmitGuess(guess.trim());
      setStatus("sent");
    } catch {
      setStatus("error");
      setStatusMsg("Guess rejected — one guess per round.");
    }
  };

  return (
    <div style={S.playGrid}>
      <div style={S.viewportPanel}>
        <div style={S.roundMeta}>
          <span style={S.mono}>ROUND {room.currentIndex + 1} / {room.roundCount}</span>
          <span style={{ ...S.mono, color: "#FFB454" }}>
            {stage.label} · worth {worth}{room.hintUsed ? " (hint)" : ""}
          </span>
        </div>

        {room.hint && (
          <div style={S.hintLive}>Hint: “{room.hint}”</div>
        )}

        {isHost && (
          <div style={S.hostControls}>
            {frameError && <div style={S.error}>{frameError}</div>}
            {hostRound?.hint && !room.hintUsed && (
              <div style={S.hintText}>Hint on card: “{hostRound.hint}” — players can’t see this yet.</div>
            )}
            {room.roundActive ? (
              <div style={S.btnRow}>
                <button style={S.btnGhost} disabled={room.stage >= STAGES.length - 1} onClick={onOpenAperture}>
                  Open Aperture
                </button>
                {hasHint && (
                  <button style={S.btnGhost} disabled={!!room.hintUsed} onClick={onRevealHint}>
                    {room.hintUsed ? "Hint live" : "Reveal Hint"}
                  </button>
                )}
                <button style={S.btnPrimary} onClick={onReveal}>Reveal Answer</button>
              </div>
            ) : (
              <div style={S.btnRow}>
                <button style={S.btnPrimary} onClick={onNext}>
                  {room.currentIndex + 1 >= room.roundCount ? "Finish Game" : "Next Round"}
                </button>
              </div>
            )}
          </div>
        )}

        <div style={S.viewport}>
          {liveFrame ? (
            <ApertureFrame src={liveFrame} />
          ) : (
            <div style={S.developing}>{frameError || "Developing…"}</div>
          )}
          <div style={S.apertureTicks}>
            {STAGES.map((s, i) => (
              <div key={i} style={{ ...S.tick, opacity: i <= room.stage ? 1 : 0.25, background: i <= room.stage ? "#FFB454" : "#5A5248" }} />
            ))}
          </div>
        </div>

        {!room.roundActive && room.reveal?.answer && (
          <div style={S.answerReveal}>It was: <strong>{room.reveal.answer}</strong></div>
        )}

        {!isHost && (
          <>
            <div style={S.guessRow}>
              <input
                style={{ ...S.input, flex: 1 }}
                placeholder={room.roundActive ? "Type your guess…" : "Waiting for next round…"}
                value={guess}
                maxLength={MAX_GUESS}
                disabled={!room.roundActive || status === "sent" || status === "sending"}
                onChange={(e) => setGuess(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSubmit()}
              />
              <button style={S.btnPrimary} disabled={!room.roundActive || status === "sent" || status === "sending"} onClick={doSubmit}>
                {status === "sent" ? "Sent ✓" : status === "sending" ? "…" : "Guess"}
              </button>
            </div>
            {statusMsg && <div style={S.error}>{statusMsg}</div>}
          </>
        )}
      </div>

      <div style={S.sidePanel}>
        <div style={S.panelTitle}>LEADERBOARD</div>
        <div style={S.leaderboard}>
          {leaderboard.length === 0 && <div style={{ color: "#9C948A", fontSize: 13 }}>No points yet — be first!</div>}
          {leaderboard.map((row, i) => (
            <div key={row.uid} style={S.leaderRow}>
              <span style={S.mono}>#{i + 1}</span>
              <span style={{ flex: 1, fontWeight: row.uid === myUid ? 700 : 400 }}>
                {row.name}{row.uid === myUid ? " (you)" : ""}
              </span>
              <span style={{ ...S.mono, color: "#FFB454" }}>{row.pts}</span>
            </div>
          ))}
        </div>
        <div style={S.panelTitle}>FEED</div>
        <div style={S.feedList}>
          {room.feed.map((f) => (
            <div key={f.id} style={{ ...S.feedItem, color: f.type === "correct" ? "#34D8B0" : f.type === "reveal" || f.type === "hint" ? "#FFB454" : "#9C948A" }}>
              {f.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EndScreen({ leaderboard }) {
  return (
    <div style={S.centerWrap}>
      <div style={S.eyebrow}>GAME OVER</div>
      <h1 style={S.h1}>FULL APERTURE</h1>
      <div style={{ ...S.panel, width: "100%", maxWidth: 420 }}>
        <div style={S.panelTitle}>FINAL SCORES</div>
        <div style={S.leaderboard}>
          {leaderboard.length === 0 && <div style={{ color: "#9C948A" }}>Nobody scored — tough crowd.</div>}
          {leaderboard.map((row, i) => (
            <div key={row.uid} style={S.leaderRow}>
              <span style={S.mono}>{i === 0 ? "🏆" : `#${i + 1}`}</span>
              <span style={{ flex: 1 }}>{row.name}</span>
              <span style={{ ...S.mono, color: "#FFB454" }}>{row.pts}</span>
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
      @keyframes apertureIn { from { opacity: 0; transform: scale(1.04); } to { opacity: 1; transform: none; } }
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
  btnRow: { display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", alignItems: "center" },
  btnPrimary: { background: "#FFB454", color: "#1A1310", border: "none", borderRadius: 8, padding: "12px 22px", fontWeight: 700, fontSize: 14, letterSpacing: "0.02em" },
  btnGhost: { background: "transparent", color: "#F3EEE4", border: "1px solid #3A342C", borderRadius: 8, padding: "12px 22px", fontWeight: 600, fontSize: 14 },
  smallGhostBtn: { background: "transparent", color: "#9C948A", border: "1px solid #3A342C", borderRadius: 6, padding: "4px 8px", fontSize: 11 },
  footNote: { marginTop: 24, fontSize: 12, color: "#6B6459", maxWidth: 380 },
  backBtn: { alignSelf: "flex-start", background: "none", border: "none", color: "#9C948A", fontSize: 13, marginBottom: 12 },
  formCol: { display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 320 },
  input: { background: "#1A1613", border: "1px solid #3A342C", borderRadius: 8, color: "#F3EEE4", padding: "12px 14px", fontSize: 14, fontFamily: "'Inter', sans-serif" },
  error: { color: "#E2604F", fontSize: 13 },
  banner: { background: "#2A1A16", border: "1px solid #E2604F", color: "#E2604F", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 16 },
  roomWrap: { maxWidth: 920, margin: "0 auto" },
  topBar: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "1px solid #3A342C", paddingBottom: 14, marginBottom: 20 },
  topBarLabel: { fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.2em", color: "#6B6459" },
  lobbyGrid: { display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 },
  panel: { background: "#1A1613", border: "1px solid #2A251F", borderRadius: 12, padding: 18 },
  panelTitle: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: "0.2em", color: "#6B6459", marginBottom: 10 },
  roundList: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 },
  roundRow: { display: "flex", alignItems: "center", gap: 10 },
  roundThumb: { width: 42, height: 42, objectFit: "cover", borderRadius: 6, background: "#0F0D0B" },
  sealedThumb: { width: 42, height: 42, borderRadius: 6, background: "#0F0D0B", border: "1px solid #2A251F", display: "flex", alignItems: "center", justifyContent: "center", color: "#3A342C", fontSize: 16 },
  hostOnlyNote: { fontSize: 11.5, color: "#6B6459", fontStyle: "italic", marginBottom: 14 },
  addRoundForm: { display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid #2A251F", paddingTop: 14 },
  playerChips: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16, minHeight: 30 },
  chip: { background: "#0F0D0B", border: "1px solid #3A342C", borderRadius: 20, padding: "4px 12px", fontSize: 12 },
  waitingNote: { color: "#9C948A", fontSize: 13 },
  playGrid: { display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 },
  viewportPanel: { background: "#1A1613", border: "1px solid #2A251F", borderRadius: 12, padding: 18 },
  roundMeta: { display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 10, color: "#9C948A" },
  viewport: { position: "relative", width: "100%", aspectRatio: "4 / 3", overflow: "hidden", borderRadius: 10, background: "#0A0806" },
  frameImg: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" },
  developing: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#6B6459", fontSize: 13, padding: 20, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.1em" },
  apertureTicks: { position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 5 },
  tick: { width: 18, height: 4, borderRadius: 2, transition: "background 0.3s ease, opacity 0.3s ease" },
  guessRow: { display: "flex", gap: 8, marginTop: 14 },
  hostControls: { marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 },
  hintText: { color: "#9C948A", fontSize: 13, fontStyle: "italic" },
  hintLive: { color: "#FFB454", fontSize: 14, fontStyle: "italic", marginBottom: 10 },
  answerReveal: { fontSize: 14, color: "#F3EEE4", marginTop: 14 },
  sidePanel: { background: "#1A1613", border: "1px solid #2A251F", borderRadius: 12, padding: 18, display: "flex", flexDirection: "column" },
  leaderboard: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 },
  leaderRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14 },
  feedList: { display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, overflowY: "auto", maxHeight: 220 },
  feedItem: { lineHeight: 1.4 },
};
