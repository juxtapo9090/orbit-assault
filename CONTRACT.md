# CONTRA-ORBIT — the contract every hand cooks against

Forked 2026-09-04 from Apoapsis, a single-player canvas platformer.
Goal: keep the Apoapsis skeleton + cosmos/light/juice look, layer **Contra** on it
(run-and-gun, 8-way aim, prone, spawners, snipers, turrets, wall boss, lives),
and make the sim **deterministic** so up to **5 players** can play couch-coop
over a WireGuard LAN by **lockstep** (inputs cross the wire, nothing else).

Files and who owns them (do NOT edit a file you don't own — the core file is
being refactored at the same time):

| file | owner | job |
|---|---|---|
| `orbit.src.html` | core | sim, players, bullets, input, HUD, loop, hooks |
| `build.py` | core | inlines every module below into `orbit.html` |
| `contra.js` | enemies | enemies, enemy bullets, spawners, boss, weapon capsules, their draw + sfx |
| `net.js` + `relay.py` | netcode | lobby + lockstep input exchange; WebSocket relay |
| `contra1.txt` `contra2.txt` `contra3.txt` + `verify_level.py` | levels | run-and-gun-shaped levels + verifier that knows the new glyphs |
| `tools/chr_rip.py` → `ref/*.png` | reference | rip NES tile graphics as a reference board (reference only, never shipped) |
| `juice.js` | enemies may APPEND new sfx names inside the `SFX` table only | |

Build: `python3 build.py` → `orbit.html`. Serve: `python3 shotserver.py` (port 8901).
Existing modules `juice.js` (sfx/music/particles/shake), `cosmos.js` (background),
`light.js` (2D lighting) stay as they are. Read them if you need their API; they are short.

---

## 1. Determinism rules (everyone)

- Sim tick `DT = 1/60`, fixed, accumulator loop already exists. **No wall-clock, no
  `performance.now`, no `Date` inside anything that touches game state.**
- **No `Math.random` in sim code.** Use `W.rng()` (mulberry32, seeded per level from
  `W.seed`). Draw-only cosmetics may use `hash2(x,y)` style deterministic noise or
  `W.tclock` (render clock). If it changes what a player can be hit by, it is sim.
- Iterate arrays in index order; never depend on object key order or `Map` insertion
  from async sources.
- Floats are fine (same JS engine everywhere, same op order → same result).
  Do not use `Math.fround`/SIMD tricks, don't call `Math.sin` on `Date`.
- Entities die by `alive=false`, they are not spliced mid-tick (splicing changes
  indices → changes iteration → desync). Compact only at level load.

## 2. The world object `W` (core builds it, hands it to CONTRA every call)

```js
W = {
  TS:16, MAP_W, MAP_H, tiles,          // tiles[y][x] = char, mutable ('?'→'u' when bumped)
  solidAt(tx,ty), oneWayAt(tx,ty),     // tile predicates (out-of-range x = solid wall)
  players,                             // array, length 1..5, see §3 — index = slot
  bullets,                             // PLAYER bullets, see §4 (core spawns, CONTRA kills enemies with them)
  rng(),                               // deterministic [0,1)
  seed, tick,                          // level seed (int), current sim tick (int)
  cam:{x,y},                           // camera (presentation; usable for "on screen" spawner logic
                                       //   ONLY via W.camX() below — see note)
  camX(),                              // DETERMINISTIC camera x = min over alive players' x - VW/2 clamped.
                                       //   Use this, not W.cam, for any sim decision.
  VW:480, VH:270,
  hurt(p),                             // demote/kill player p (handles i-frames). CONTRA calls this on hit.
  score(n, p),                         // add n points, credited to player p (may be null)
  J(name,...), C(name,...), L(...),    // juice/cosmos/light passthroughs (safe, try-wrapped)
  levelDone:false,                     // CONTRA sets true when the boss is dead → core opens the beacon
  tclock                               // render clock (draw only)
}
```

## 3. Player object (core owns; CONTRA reads)

```js
p = { slot:0..4, x,y,w:11,h:15, vx,vy, onGround, face:±1,
      aimX:-1|0|1, aimY:-1|0|1,      // 8-way aim; (face,0) when neutral; prone → (face,0), h shrinks
      prone:false, dead:false, invT,  // invT>0 = invulnerable (blinking) — CONTRA must not hurt
      light:2, lives:3, weapon:"n"|"s"|"l",   // normal / spread / laser
      alive:true,                     // false = out of lives (spectating)
      color:"#6E9CE8" }               // per-slot tint
```
Hit box for enemy bullets vs player: the `x,y,w,h` rect, shrink 2px each side.
If `p.dead || p.invT>0 || !p.alive` → not hittable.

## 4. Player bullets (core spawns; CONTRA collides them with its enemies)

```js
b = { x,y, vx,vy, r:2, owner:slot, kind:"n"|"s"|"l", alive:true, ttl:frames }
```
CONTRA loops `W.bullets`, on hit sets `b.alive=false` (laser `"l"` pierces: don't kill it),
damages enemy, calls `W.score(pts, W.players[b.owner])`, `W.J("burst",...)`, `W.J("sfx","enemyDie")`.
Core removes dead bullets itself. Bullets that hit solid tiles are killed by core.

## 5. CONTRA module API (`contra.js` → `window.CONTRA`)

```js
CONTRA.build(W)              // at level load: scan W.tiles for glyphs below, build lists, replace
                             //   the glyph with '.' in W.tiles (so the tile layer stays clean). Reset all state.
CONTRA.step(W, DT)           // one sim tick. Enemies, enemy bullets, spawners, boss; collisions both ways.
CONTRA.draw(g, cx, cy, lights, W)  // world-space camera offset (cx,cy) already rounded. Push [x,y,r,color,a]
                             //   into `lights` for anything glowing. Draw enemy bullets here too.
CONTRA.hud(W)                // optional: returns short string for HUD ("BOSS ████░░") or ""
```
Level glyphs CONTRA owns (core/verify treat them as empty floor-air):

| glyph | thing | behaviour |
|---|---|---|
| `r` | runner | soldier: runs toward nearest player, jumps 1-tile gaps, dies in 1 hit, contact hurts |
| `s` | sniper | stands still, every ~1.6s fires one aimed bullet at nearest player in range; 1 hit |
| `t` | turret | wall-mounted, tracks nearest player, 8-way shots, 3 hits; shielded (closed) for 1s between volleys → no damage while closed |
| `S` | spawner | invisible marker: while any player is within 12 tiles, spawns a runner from just off the right (or left, whichever is farther from camX) every ~1.1s, max 4 alive per spawner |
| `W` | capsule | weapon pod flies in a sine arc across the screen when a player comes within 10 tiles; shoot it → drops a `"s"` spread (or `"l"` laser if `W.rng()<0.3`) pickup that falls to the floor; touch = weapon |
| `B` | boss | wall boss anchored at the glyph: 3 gun ports (fire aimed bursts) + a core that opens for 1.5s every 4s. Core HP 30 (normal 1/spread 1 per pellet/laser 3). Ports HP 6 each, killing all ports lengthens the core window. Dead → `W.levelDone=true`, big burst, `sfx "bossDie"` |

Feel: Contra pacing but Apoapsis look — glowing geometric shapes, deep indigo/purple,
danger = `#E0616B` reds, enemy shots are small hot motes with a trail. Use the palette
in the core file's `PAL` (per level: `pal()` is a global). Don't draw sprites; draw shapes + light.

New sfx to add to `juice.js` SFX table: `shoot`, `spread`, `laser`, `enemyDie`, `turretHit`,
`bossHit`, `bossDie`, `pickup`. Follow the pattern of the existing entries.

## 6. NET module API (`net.js` → `window.NET`, `relay.py`)

Lockstep, input-delay model. `D = 3` ticks of input delay. One relay on the host PC.

```js
NET.host({url, name})        // connect, create room; resolves {room, slot:0}
NET.join({url, room, name})  // connect, join;  resolves {room, slot}
NET.onLobby(cb)              // cb({room, players:[{slot,name}], hostSlot})
NET.start(seed)              // host only → relay broadcasts start{seed, nPlayers, tick0}
NET.onStart(cb)              // cb({seed, nPlayers, mySlot})
NET.pushInput(tick, byte)    // my input for `tick` (core calls with tick+D)
NET.inputsFor(tick)          // → Uint8Array(nPlayers) or null if any slot's input for `tick` hasn't arrived
NET.status()                 // {connected, room, slot, nPlayers, rttMs, stalled:bool}
NET.onDrop(cb)               // a peer left → cb(slot); core marks that player alive=false, treats input as 0
```
Input byte bits: `L=1 R=2 U=4 D=8 J=16 F=32 S=64` (S = run/shift).
Relay is dumb: rooms, slots, broadcast `input{slot,tick,byte}` to all others, forward
`start`, ping/pong for rtt, drop on socket close. Protocol = JSON text frames.
Every client also echo-buffers its own inputs. No state sync, no rollback — LAN only.
`relay.py`: **stdlib only** (raw RFC 6455 handshake + frames; text frames, masking from client),
`python3 relay.py --port 8902 --bind 0.0.0.0`. Error loud on bad args, no defaults you
weren't given except those two flags' documented defaults.
If `websockets` pip package is missing you do NOT fall back to something else — stdlib is the design.

Core behaviour: if `window.NET` is absent or `NET.status().connected===false` the game runs
solo with local input directly (no delay). When connected, `step` only advances when
`NET.inputsFor(tick)` is non-null; otherwise the frame draws a "waiting for ⟨slot⟩" tag.

## 7. Levels (`contra1..3.txt`, `verify_level.py`)

Same ASCII format. Full vocabulary now:
```
.  empty      #  solid      =  one-way     ^  spike     o  mote(coin)   ?  light block
e  walker     x  spiky walker (kept from Apoapsis)
r  runner     s  sniper     t  turret      S  spawner   W  capsule      B  boss
P  spawn      F  beacon (goal)
```
Up to 5 players spawn at `P` fanned 12px apart. Levels are LONG horizontal runs
(≥ 200 columns), mostly ground with pits, elevated one-way plates for snipers,
turrets set INTO walls (a `t` must have solid on at least one side), spawner every
~40 columns, one `W` per level, exactly one `B` near the end before `F`. The boss
needs a flat arena ≥ 24 columns wide with a solid wall behind `B`.
Level 1 jungle-ish open run · level 2 base interior (tight, vertical, turrets) · level 3 waterfall climb (vertical-ish, one-way plates going up, then the boss).
`verify_level.py` must: accept the new glyphs as walkable air, still prove `P→F`
reachability with the same physics, and additionally assert: exactly one `B`, ≥1 `S`,
every `t` touches a solid, the boss arena rule above. Exit 1 with a clear report otherwise.
`build.py` will be switched to load `contra*.txt`; keep `level*.txt` untouched.

## 8. Reference rip (`tools/chr_rip.py`)

`Contra (USA).nes` is mapper 2 (UNROM): header says CHR=0 → **CHR-RAM**, the tile
data lives inside the 128K PRG. Decode the WHOLE PRG as 2bpp 8×8 NES tiles (16 bytes
each) into PNG sheets (say 32 tiles wide, grayscale 4-level or a fixed 4-colour ramp),
write `ref/prg_tiles_<n>.png` per 16K bank plus one contact sheet. Also print which
banks look tile-dense (entropy or ratio of non-zero planes) so we know where to look.
Pillow is available. Reference only — nothing from this goes into the game.

---

Report back: what you built, how you tested it (actually run it), what's broken.
FAFO on a copy — this whole folder IS the copy. Broken things stay reported as broken.
