# MANIFEST — Contra Orbit / Orbit Assault

*Written 2026-09-04, at the end of the night that built it. Read this first
when picking the toy back up; it says what exists, what is proven, what is half-done,
and which mistakes are already paid for.*

---

## What this is

A five-player co-op run-and-gun in one HTML file, playable over LAN or WireGuard.
Forked from **Apoapsis** (`../ledger-run`), a single-player platformer built the day
before, when its author noticed the platformer formula wanted to be a run-and-gun instead.

Two folders, on purpose:

| folder | what it is |
|---|---|
| the working copy | where this is hacked on. Not public: it holds tunnel configs and ROM-derived reference art. |
| `this repo` | **the scrubbed public export.** Renamed, secret-free. Regenerate by hand if the working copy moves ahead. |

Licence: MIT.
The rename is deliberate: our code and art are original, the name *Contra* is Konami's.

The NES ROM was never a source of code. It was read once for tile-art reference
(`tools/chr_rip.py` → `ref/`), and that output is not shippable.

## Run it

```
python3 build.py                              # verify levels, inline modules -> orbit.html
python3 shotserver.py --bind 0.0.0.0          # page,      8901  (test.html -> orbit.html)
python3 relay.py --bind 0.0.0.0 --port 8902   # relay,     8902  (dashboard on the same port)
```

Play at `http://<host>:8901/orbit.html`, relay box `ws://<host>:8902`, dashboard at
`http://<host>:8902/`. Host reads out the four-letter code, everyone else Joins, host
Launches (the button stays locked until a second player is actually in the lobby).

## Architecture in one breath

The core (`orbit.src.html`) owns the simulation, players, bullets, camera, HUD and
lobby. `contra.js` owns every enemy behind a four-function interface. `net.js` +
`relay.py` own the wire. `build.py` inlines all of it into one file. `CONTRACT.md` is the
contract they were written against and is the first thing to read before touching
anything that runs inside a tick.

Levels are ASCII text. `verify_level.py` simulates the real player physics and refuses to
build a level whose goal cannot be reached, so an unplayable level cannot ship.

## The netcode, and the three laws it cost us to learn

Deterministic lockstep: only input bytes cross the wire, never state. Every browser runs
the identical sim from the same seed at a fixed 1/60 tick. All three of these were
learned by watching it break, in this room, tonight:

1. **No wall-clock, no `Math.random`, no `Date` inside a tick.** Seeded rng only.
2. **One byte per tick, ever.** Re-pushing a changed byte for a tick a peer already
   consumed is a race the peer loses. Cost: five desynced ticks in one run, zero in the
   next, which is exactly how this class of bug hides.
3. **A stalled client must keep sending inputs.** Sending only while advancing meant one
   player's hitch starved everyone, which stalled them, which starved everyone else —
   a room that can never recover. This froze three real players mid-fight.

Input delay adapts from measured rtt at launch (floor 4 ticks, two round trips of
headroom) and climbs on sustained stalls up to 16. The HUD's `d8` is that number.
The original hardcoded 3 ticks was a real-LAN figure and produced constant micro-stalls
over a 45ms tunnel.

**Five slots are simulated from tick zero.** Unclaimed ones are dormant: frozen,
invisible, ignored by camera and enemies, input pinned to zero. Activation at an agreed
tick is what turns a slot into a player — which is what makes mid-run joining possible
without shipping any state.

## Couch-mode decisions worth keeping

- **Leash, not a screen wall.** The old shared-viewport clamp let whoever ran ahead shove
  everyone else. Now each browser has its own camera centred on its own player, with a
  deterministic tether (`LEASH = 330px`) to the group anchor. `cam` is the shared sim
  anchor; `view` is local presentation and must never feed anything the sim reads.
- **Off-screen teammates** get a coloured arrow with their name at the screen edge,
  which separate cameras made necessary.
- **Shape, not just colour.** Each slot has a crest (dot, triangle, bar, diamond, cross)
  above the head, because five colours under bloom in a firefight were not enough. Your
  own player carries a white chevron nobody else has.
- **Infinite lives** (`INFINITE_LIVES` at the top of the core). Dying costs your gun and
  a tally mark, never your seat. Flip to `false` for the three-lives arcade version.
- **The camera only ever advances**, Contra's rule, and respawn puts you on real floor
  beside the furthest-ahead teammate.

## State: proven, and not

**Proven, by something that actually ran:**

- Solo run clean in headless Chrome, no JS errors.
- Two real browsers through a real relay: per-tick fingerprints identical, many runs.
- `node test_contra.js` all green, including same-seed byte-identical state.
- `node test_net.js`: mid-run join by input-log replay, plus drop-and-retake, all peers
  agreeing on identical rows either side of the join tick.
- Three levels pass the physics verifier and its structural rules.
- Relay under a real five-player load: **3.4% of one core, 25 MB, 30x headroom, 1.37ms**.
  This is why it is not worth rewriting in Rust for couch play. A public multi-room
  server is a different question and the honest moment to hand it to Luc.
- Four real humans played it together over a VPN.

**Not proven / not done:**

- **Mid-run join is only half wired.** The relay records the log and answers a join into
  a started room with `resume`; `net.js` exposes `onActivate`, `resumeInfo`, `joinTick`,
  `catchingUp`, `caughtUp()`. The **core does not yet replay a resume log or fast-forward
  to the join tick**, and the title screen has no "join a running game" path. The core
  half that *is* done: dormant slots, `pendingAct`, `applyActivations()` inside the tick,
  and the `onActivate` subscription. This is the next job and it is well-teed-up.
- A human has never killed the stage-one boss. The headless bot cannot aim; the boss
  pipeline is proven in the node test and one port died to real bullets in Chrome.
- Never tested with all five slots occupied by real people, nor stages 2 and 3 in coop.
- The public export is a hand-made copy. It does not update itself when this folder moves
  on, and it must be re-scrubbed (no no `ref/`, no ROM, no household names) if
  regenerated.

## Files, and who wrote what

| file | written by |
|---|---|
| `orbit.src.html`, `build.py` | the core author |
| `contra.js`, the new sfx in `juice.js` | the enemy module author |
| `net.js`, `relay.py` | the netcode authors (input log, resume, spans) |
| `contra1..3.txt`, `verify_level.py` | the level author |
| `tools/chr_rip.py` | the tooling author |
| `drive*.py`, `bench_relay.py` | the core author |

## Harnesses

```
python3 drive.py           # solo smoke run, screenshots to shots/, console errors
python3 drive_coop.py      # two browsers + relay, per-tick fingerprint comparison
python3 drive_boss.py 231  # warp to a column and fight the boss
python3 bench_relay.py     # five-client load test of the relay
node test_contra.js / node test_net.js / python3 test_relay_frames.py
```

`drive_coop.py` is the one that matters. One fingerprint mismatch means lockstep is
broken somewhere, and it will not be visible any other way until it is enormous.

## Scars, so nobody pays twice

- **Charset, twice.** Literal `·` in JS rendered as `Â·` when the host served no charset.
  `<meta charset="utf-8">` is line 1 of the source and non-ASCII in JS stays `\u`-escaped.
- **The page server was single-threaded.** One browser holding a connection froze the
  page for everyone. It is `ThreadingTCPServer` now.
- **A closed socket left in `ws`** made every retry after a failed join fail with
  "already connected", surfacing to players as "websocket error". One wrong room code
  locked a player out until a full reload.
- **Launch was pressable with one player**, which locked the room before anyone could
  join. It now stays disabled below two players. This wasted three real attempts.
- **A `%` inside the dashboard's CSS** crashed Python's formatter, so the HTML path 500'd
  while `/status.json` worked fine.
- **Founders were activated by counting slots.** Once the relay reported five, three
  ghosts switched on at spawn and dragged the shared camera backwards. Founders come from
  the lobby list, never from a count.

## If picking this up cold

1. Read `CONTRACT.md`, then the three laws above.
2. `python3 build.py && python3 drive_coop.py` — if that reports zero mismatches, the
   foundation is intact and you can trust it.
3. The next feature is finishing mid-run join in the core: on `resume`, run the sim
   forward through the replayed log as fast as it will go, call `NET.caughtUp()`, then
   let `applyActivations()` switch the slot on at `joinTick`. Everything under it exists.
