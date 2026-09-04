// node test_contra.js — stubs W, drives CONTRA, asserts behaviour + determinism.
'use strict';
var CONTRA = require('./contra.js');
var TS = 16, DT = 1 / 60;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeW(rows, seed, playerX, bossKind) {
  var tiles = rows.map(function (r) { return r.split(''); });
  var MAP_H = tiles.length, MAP_W = tiles[0].length;
  var W = {
    TS: TS, MAP_W: MAP_W, MAP_H: MAP_H, tiles: tiles,
    solidAt: function (tx, ty) {
      if (tx < 0 || tx >= MAP_W) return true;
      if (ty < 0 || ty >= MAP_H) return false;
      return tiles[ty][tx] === '#';
    },
    oneWayAt: function (tx, ty) {
      if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return false;
      return tiles[ty][tx] === '=';
    },
    players: [{ slot: 0, x: playerX, y: 8 * TS - 15, w: 11, h: 15, vx: 0, vy: 0, onGround: true, face: 1,
      aimX: 1, aimY: 0, prone: false, dead: false, invT: 0, light: 2, lives: 3, weapon: 'n', alive: true, color: '#6E9CE8' }],
    bullets: [], rng: mulberry32(seed), seed: seed, tick: 0, cam: { x: 0, y: 0 },
    VW: 480, VH: 270, levelDone: false, tclock: 0,
    /* CONTRA.build demands both of these rather than defaulting them — see
       makeBoss/buildGates. The default here is the Dreadnought, so every test
       written before the four-boss pass still exercises the boss it was written
       against; a test that wants another one passes bossKind. */
    bossKind: (bossKind === undefined ? 0 : bossKind), colOffset: 0,
    banners: [],
    banner: function (t, s) { W.banners.push([t, s]); },
    revives: [],
    revive: function (p, x, y, inv) {
      W.revives.push({ slot: p.slot, x: x, inv: inv });
      p.dead = false; p.deadT = 0; p.light = 2; p.invT = inv; p.shieldT = inv; p.beaconT = 0;
    },
    camX: function () {
      var mn = 1e9;
      for (var i = 0; i < W.players.length; i++) if (W.players[i].alive) mn = Math.min(mn, W.players[i].x);
      var c = mn - W.VW / 2;
      return Math.max(0, Math.min(MAP_W * TS - W.VW, c));
    },
    hurtCalls: 0, scoreTotal: 0, jlog: [],
    hurt: function (p) { if (p.invT > 0) return; W.hurtCalls++; p.invT = 90; },
    score: function (n) { W.scoreTotal += n; },
    enemies: [], flashes: 0,
    flash: function () { W.flashes++; },
    J: function () { W.jlog.push(Array.prototype.slice.call(arguments)); },
    C: function () {}, L: function () {}
  };
  return W;
}

function tick(W) {
  CONTRA.step(W, DT);
  W.tick++;
  var p = W.players[0]; if (p.invT > 0) p.invT--;
  // core removes dead bullets, moves live ones
  var keep = [];
  for (var i = 0; i < W.bullets.length; i++) {
    var b = W.bullets[i]; if (!b.alive) continue;
    b.x += b.vx * DT; b.y += b.vy * DT; b.ttl--;
    if (b.ttl <= 0) continue;
    if (W.solidAt(Math.floor(b.x / TS), Math.floor(b.y / TS))) continue;
    keep.push(b);
  }
  W.bullets = keep;
}
function shoot(W, x, y, vx, vy, kind) {
  W.bullets.push({ x: x, y: y, vx: vx, vy: vy, r: 2, owner: 0, kind: kind || 'n', alive: true, ttl: 120 });
}
function sfxCount(W, name) { var n = 0; for (var i = 0; i < W.jlog.length; i++) if (W.jlog[i][0] === 'sfx' && W.jlog[i][1] === name) n++; return n; }

var fails = 0;
function assert(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; }

// 40 cols. Floor at row 8 with a 1-tile pit at col 12. Turret at 19 with wall at 20.
// Boss at 30 with a wall at 33+. Sniper at 15, runner at 14 (must hop the pit to reach P at 3).
var MAP = [
  '........................................',
  '........................................',
  '........................................',
  '........................................',
  '........................................',
  '........................................',
  '........................................',
  '...P......r...s...t#..S...W..B...#######',
  '############.###########################'
];
// (the 'r' at col 10 is left of the pit; put a second runner right of it via a map variant)
var MAP2 = MAP.slice(); MAP2[7] = '...P..........r.......S...W..B...#######';

// ---- 1. runner reaches player and hurts (with a pit hop) ----
(function () {
  var W = makeW(MAP2, 7, 3 * TS); CONTRA.build(W);
  assert(W.tiles[7][14] === '.', 'build blanks glyphs');
  var r = CONTRA._state().runners[0];
  var minX = r.x;
  for (var i = 0; i < 600; i++) { tick(W); if (r.alive) minX = Math.min(minX, r.x); }
  assert(r.alive, 'runner survived the pit (hopped it)  x=' + r.x.toFixed(1));
  assert(W.hurtCalls > 0, 'runner reached player, hurt() called ' + W.hurtCalls + 'x');
})();

// ---- 2. sniper fires ----
(function () {
  var W = makeW(MAP, 7, 3 * TS); CONTRA.build(W);
  for (var i = 0; i < 200; i++) tick(W);
  var eb = CONTRA._state().ebullets, n = 0;
  for (i = 0; i < eb.length; i++) if (eb[i].src === 's') n++;
  assert(n > 0 || sfxCount(W, 'shoot') > 0, 'sniper fired (shoot sfx x' + sfxCount(W, 'shoot') + ')');
})();

// ---- 3. turret: no damage closed, dies after 3 hits open ----
(function () {
  var W = makeW(MAP, 7, 17 * TS); CONTRA.build(W);
  var t = CONTRA._state().turrets[0];
  // closed phase: pepper it
  var i = 0, closedDmg = 0, closedTicks = 0;
  while (!t.open && i < 600) {
    shoot(W, t.x, t.y, 0, 0); var hp = t.hp; tick(W); i++;
    if (!t.open) { closedTicks++; if (t.hp < hp) closedDmg++; }
  }
  assert(closedTicks > 10 && closedDmg === 0, 'turret took no damage across ' + closedTicks + ' closed ticks');
  assert(t.open, 'turret opened');
  var hits = 0;
  while (t.alive && hits < 3) { shoot(W, t.x, t.y, 0, 0); tick(W); hits++; }
  assert(!t.alive, 'turret dead after ' + hits + ' hits during open phase');
})();

// ---- 4. boss dies -> levelDone ----
(function () {
  var W = makeW(MAP, 7, 24 * TS); CONTRA.build(W);
  var B = CONTRA._state().boss;
  var openHits = 0, closedHits = 0, hp0 = 30;
  for (var i = 0; i < 1500 && B.alive; i++) {
    shoot(W, B.cx, B.cy, 0, 0, 'n');
    var before = B.hp; tick(W);
    if (B.hp < before) { if (B.open) openHits++; else closedHits++; }
  }
  assert(B.engaged, 'boss engaged');
  assert(closedHits === 0, 'core took no damage while closed');
  assert(openHits === 30, 'core took 30 normal hits while open (' + openHits + ')');
  assert(!B.alive && W.levelDone === true, 'boss dead, levelDone=' + W.levelDone);
  assert(sfxCount(W, 'bossDie') === 1, 'bossDie sfx once');
  /* named per boss now — four fights that all read "BOSS" are four fights the
     player cannot tell apart in the one place they look while fighting */
  assert(CONTRA.hud(W) === 'DREADNOUGHT DOWN', 'hud reads ' + CONTRA.hud(W));
})();

// ---- 5. determinism: same seed twice -> identical state ----
function run(seed) {
  var W = makeW(MAP2, seed, 3 * TS); CONTRA.build(W);
  for (var i = 0; i < 600; i++) {
    // scripted player: walk right slowly, shoot every 10 ticks
    var p = W.players[0]; p.x += 0.6;
    if (i % 10 === 0) shoot(W, p.x + 12, p.y + 6, 300, 0, i % 30 === 0 ? 'l' : 'n');
    tick(W);
  }
  return JSON.stringify(CONTRA._state()) + '|' + W.hurtCalls + '|' + W.scoreTotal + '|' + W.jlog.length;
}
var a = run(1234), b = run(1234), c = run(99);
assert(a === b, 'same seed twice -> byte-identical state (' + a.length + ' bytes)');
assert(a !== c, 'different seed -> different state');

// ---- 6. draw smoke test: fake ctx, every entity kind on screen, no throw ----
(function () {
  var W = makeW(MAP2, 5, 24 * TS); CONTRA.build(W);
  var s = CONTRA._state();
  s.capsules[0].state = 1; s.capsules[0].x = 26 * TS; s.capsules[0].y = 6 * TS;
  s.pickups.push({ alive: true, x: 27 * TS, y: 7 * TS, vy: 0, kind: 'l', grounded: true, t: 0 });
  for (var i = 0; i < 240; i++) tick(W);
  var calls = 0, gradient = { addColorStop: function () {} };
  var g = new Proxy({}, {
    get: function (o, k) { if (k === 'createLinearGradient') return function () { return gradient; }; return function () { calls++; }; },
    set: function () { return true; }
  });
  var lights = [], threw = null;
  try { CONTRA.draw(g, W.camX(), 0, lights, W); } catch (e) { threw = e; }
  assert(!threw, 'draw() ran without throwing' + (threw ? ': ' + threw.message : '') + ', ' + calls + ' ctx calls');
  assert(lights.length > 5 && lights.every(function (l) { return l.length === 5 && typeof l[3] === 'string'; }), 'draw pushed ' + lights.length + ' well-formed lights');
})();

// ---- 7. grenades: the arc, the fuse, the blast ----
(function () {
  // Thrown flat off the floor: it must fall, hit the floor, and go off there.
  var W = makeW(MAP2, 3, 3 * TS); CONTRA.build(W);
  var gr = CONTRA.throwGrenade(W, 4 * TS, 6 * TS, 180, -220, 0);
  assert(!!gr && gr.alive, 'throwGrenade returned a live slot');
  var apex = gr.y, i;
  for (i = 0; i < 20; i++) { tick(W); apex = Math.min(apex, gr.y); }
  assert(apex < 6 * TS - 15, 'grenade arced up ' + (6 * TS - apex).toFixed(1) + 'px before falling');
  for (i = 0; i < 120 && gr.alive; i++) tick(W);
  assert(!gr.alive, 'grenade detonated (ground contact) at tick ' + i);
  assert(W.flashes === 1, 'blast asked for exactly one screen flash (' + W.flashes + ')');
  assert(sfxCount(W, 'bossDie') === 1, 'blast played the boom once');

  // Pool: the next throw reuses the dead slot, it does not grow the array.
  var n0 = CONTRA._state().grenades.length;
  CONTRA.throwGrenade(W, 4 * TS, 6 * TS, 0, 0, 0);
  assert(CONTRA._state().grenades.length === n0, 'dead grenade slot reused, pool still ' + n0);
})();

// ---- 8. blast radius: the boundary is really at 5 tiles ----
(function () {
  var W = makeW(MAP2, 3, 3 * TS); CONTRA.build(W);
  // Blast centre x=96. Walkers are 14 wide, so centre = x+7: one at 76px out
  // (inside 80), one at 84px out (outside). Eight pixels decide it.
  var near = { alive: true, x: 165, y: 7 * TS, w: 14, h: 14 };
  var far = { alive: true, x: 173, y: 7 * TS, w: 14, h: 14 };
  W.enemies.push(near, far);
  var r = CONTRA._state().runners[0];
  r.x = 8 * TS; r.y = 7 * TS;                                        // 2 tiles away
  var gr = CONTRA.throwGrenade(W, 6 * TS, 7 * TS + 7, 0, 0, 0);
  gr.ttl = 1; tick(W);
  assert(!gr.alive, 'fuse ran out, grenade gone');
  assert(!r.alive, 'runner inside the blast died');
  assert(!near.alive, 'walker 76px out died');
  assert(far.alive, 'walker 84px out survived — the radius is a radius');
})();

// ---- 9. blast breaks a turret's shield (bullets cannot) ----
(function () {
  var W = makeW(MAP, 3, 17 * TS); CONTRA.build(W);
  var t = CONTRA._state().turrets[0];
  assert(!t.open, 'turret starts closed');
  var gr = CONTRA.throwGrenade(W, t.x, t.y, 0, 0, 0);
  gr.ttl = 1; tick(W);
  assert(!t.alive, 'closed turret died to a 5-damage blast (hp was 3)');
})();

// ====================== gameplay depth (2026-09-04) ======================

// ---- 10. the boss kind is DEMANDED, never defaulted ----
(function () {
  var W = makeW(MAP, 3, 3 * TS);
  delete W.bossKind;
  var threw = '';
  try { CONTRA.build(W); } catch (e) { threw = e.message; }
  assert(/bossKind/.test(threw), 'build refuses a level with no boss named: ' + (threw || 'it did not throw'));
  W = makeW(MAP, 3, 3 * TS); W.bossKind = 7;
  threw = '';
  try { CONTRA.build(W); } catch (e) { threw = e.message; }
  assert(/0\.\.3/.test(threw), 'and refuses a kind outside 0..3');
  W = makeW(MAP, 3, 3 * TS); delete W.colOffset;
  threw = '';
  try { CONTRA.build(W); } catch (e) { threw = e.message; }
  assert(/colOffset/.test(threw), 'and refuses a level with no column offset');
})();

// ---- 11. each kind builds its own boss, with its own bar ----
(function () {
  var want = [['DREADNOUGHT', 30, true], ['WARBOSS', 45, false],
              ['TAU CMDR', 60, false], ['SORCERER', 75, false]];
  for (var k = 0; k < 4; k++) {
    var W = makeW(MAP, 3, 3 * TS, k); CONTRA.build(W);
    var B = CONTRA._state().boss;
    assert(B && B.kind === k && B.hpMax === want[k][1],
           want[k][0] + ' built with ' + want[k][1] + ' hp (got ' + (B && B.hpMax) + ')');
    assert(!!(B.ports && B.ports.length) === want[k][2],
           want[k][0] + (want[k][2] ? ' has gun ports' : ' has no gun ports'));
  }
})();

// ---- 12. the Warboss really cycles idle -> charge -> stunned ----
(function () {
  var W = makeW(MAP, 3, 3 * TS, 1); CONTRA.build(W);
  var B = CONTRA._state().boss;
  W.players[0].x = B.x - 60;                       // walk into engagement range
  var modes = {}, openWhileNotStunned = 0, moved = 0, x0 = B.cx;
  for (var i = 0; i < 900; i++) {
    tick(W);
    if (!B.engaged) continue;
    modes[B.mode] = (modes[B.mode] || 0) + 1;
    if (B.open && B.mode !== 2) openWhileNotStunned++;
    moved = Math.max(moved, Math.abs(B.cx - x0));
  }
  assert(modes[0] && modes[1] && modes[2],
         'Warboss cycled idle/charge/stunned (' + JSON.stringify(modes) + ')');
  assert(openWhileNotStunned === 0, 'his head is open ONLY in the stun');
  assert(moved > 40, 'he actually charges across the arena (' + moved.toFixed(0) + 'px)');
  var adds = 0, rs = CONTRA._state().runners;
  for (i = 0; i < rs.length; i++) if (rs[i].boss) adds++;
  assert(adds > 0, 'and throws boyz at you while he waits (' + adds + ' spawned)');
})();

// ---- 12b. the Tau Commander flies, shields on a schedule, and stays on screen ----
// This one gets the same scrutiny as the two that ship in a level even though no
// level currently reaches it: an untested boss that is one table entry away from
// being live is a trap with a fuse in it.
(function () {
  var W = makeW(MAP, 4, 3 * TS, 2); CONTRA.build(W);
  var B = CONTRA._state().boss;
  W.players[0].x = B.x - 60;
  var base = B.base, minY = 1e9, maxY = -1e9, shielded = 0, openWhileShielded = 0;
  var homing = 0, modes = {}, aboveGround = 0, ticks = 0;
  for (var i = 0; i < 2000; i++) {
    tick(W);
    if (!B.engaged) continue;
    /* keep shooting it: the shield phase is triggered by the BAR falling, so a
       test that never damages it never sees the mechanic it came to check */
    if (i % 30 === 0) shoot(W, B.cx - 30, B.cy, 400, 0, 'n');
    ticks++;
    modes[B.mode] = 1;
    minY = Math.min(minY, B.cy); maxY = Math.max(maxY, B.cy);
    if (B.cy < base - 20) aboveGround++;
    if (B.mode === 3) { shielded++; if (B.open) openWhileShielded++; }
    var eb = CONTRA._state().ebullets;
    for (var j = 0; j < eb.length; j++) if (eb[j].alive && eb[j].home) homing++;
  }
  assert(aboveGround > ticks * 0.5, 'Tau spends most of the fight airborne (' +
         Math.round(aboveGround / ticks * 100) + '% of it)');
  assert(maxY - minY > 20, 'and changes altitude (' + (maxY - minY).toFixed(0) + 'px of it)');
  assert(minY >= B.aT - 1, 'never above the top of the camera (min y ' + minY.toFixed(0) +
         ', ceiling ' + B.aT.toFixed(0) + ') — off-screen is unhittable');
  assert(shielded > 0, 'it drops into a shield phase as its bar falls');
  assert(openWhileShielded === 0, 'and takes nothing at all while shielded');
  assert(homing > 0, 'its shoulder pods launch homing missiles (' + homing + ' tick-sightings)');
  assert(modes[1] || modes[2], 'and it uses its guns (' + JSON.stringify(modes) + ')');
})();

// ---- 13. the Sorcerer blinks, and is untouchable while he does ----
(function () {
  var W = makeW(MAP, 5, 3 * TS, 3); CONTRA.build(W);
  var B = CONTRA._state().boss;
  W.players[0].x = B.x - 60;
  var blinked = 0, openWhileBlinking = 0, portal = false, moves = {};
  for (var i = 0; i < 2400; i++) {
    tick(W);
    if (!B.engaged) continue;
    if (B.mode === 1) { blinked++; if (B.open) openWhileBlinking++; }
    moves[Math.round(B.cx / 20)] = 1;
    if (CONTRA._state().portal) portal = true;
  }
  assert(blinked > 0, 'Sorcerer blinked (' + blinked + ' ticks of it)');
  assert(openWhileBlinking === 0, 'and takes nothing while blinking');
  assert(Object.keys(moves).length > 2,
         'he does not stay put (' + Object.keys(moves).length + ' places)');
  assert(portal, 'and opened a warp portal');
})();

// ---- 14. the portal is destructible, and killing it stops the spawns ----
(function () {
  var W = makeW(MAP, 5, 3 * TS, 3); CONTRA.build(W);
  var B = CONTRA._state().boss;
  W.players[0].x = B.x - 60;
  var P = null;
  for (var i = 0; i < 2400 && !P; i++) { tick(W); P = CONTRA._state().portal; }
  assert(!!P, 'portal opened');
  if (P) {
    assert(P.hpMax === 30, 'with 30 hp (' + P.hpMax + ')');
    var left0 = P.left;
    for (i = 0; i < 40; i++) shoot(W, P.x - 6, P.y, 400, 0, 'n');
    for (i = 0; i < 20; i++) tick(W);
    assert(!P.alive, 'shot down by sustained fire');
    assert(P.left === 0, 'and its queued cultists (' + left0 + ') stop coming');
  }
})();

// ---- 15. the flame cone: area, short, and it burns its own fuel ----
(function () {
  var W = makeW(MAP2, 3, 3 * TS); CONTRA.build(W);
  var p = W.players[0];
  p.weapon = 'f'; p.fuel = 10; p.inp = { f: 1 }; p.aimX = 1; p.aimY = 0; p.face = 1;
  // three walkers: two inside the 4-tile cone, one a tile beyond it
  var a = { alive: true, x: p.x + 30, y: p.y, w: 14, h: 14 };
  var b = { alive: true, x: p.x + 50, y: p.y, w: 14, h: 14 };
  var far = { alive: true, x: p.x + 90, y: p.y, w: 14, h: 14 };
  var behind = { alive: true, x: p.x - 40, y: p.y, w: 14, h: 14 };
  W.enemies.push(a, b, far, behind);
  var pool0 = CONTRA.poolCount(W);
  for (var i = 0; i < 12; i++) tick(W);
  assert(!a.alive && !b.alive, 'both enemies inside the cone burned — it is AREA damage');
  assert(far.alive, 'one past 4 tiles did not (' + (far.alive ? 'survived' : 'died') + ')');
  assert(behind.alive, 'and one behind the player did not — it is a cone, not a circle');
  assert(CONTRA.poolCount(W) === pool0, 'no projectile was ever spawned (pool untouched)');
  assert(p.fuel < 10 && p.fuel > 0, 'fuel burned down (' + p.fuel.toFixed(2) + 's left)');
})();

// ---- 15b. the flame's 3-tick clock is a real clock, not "every frame" ----
// The contract is 1 damage every 3 ticks. Nothing else in the game reads that
// number, so nothing else would notice if it quietly became 1 every tick — which
// is a flamethrower that melts a 75hp boss in 1.25 seconds.
(function () {
  var W = makeW(MAP, 3, 3 * TS, 0); CONTRA.build(W);
  var B = CONTRA._state().boss;
  var p = W.players[0];
  /* a gun PORT, not the core: the core's iris is re-decided by stepBoss every
     tick from its own 4s clock, so a test that props it open is overwritten
     before the flame ever looks. A port is always hittable, which is what a
     cadence measurement needs — a target that only counts the hits. */
  var P = B.ports[0];
  P.hp = 999;
  B.engaged = true;
  p.weapon = 'f'; p.fuel = 10; p.inp = { f: 1 };
  p.x = P.x - 40; p.y = P.y - 7;
  p.aimX = 1; p.aimY = 0; p.face = 1;
  var hp0 = P.hp;
  for (var i = 0; i < 30; i++) { p.x = P.x - 40; p.y = P.y - 7; tick(W); }
  var dealt = hp0 - P.hp;
  assert(dealt === 10, '30 ticks of flame dealt exactly 10 damage (got ' + dealt + ') — 1 per 3 ticks');
})();

// ---- 16. fuel burns only on the trigger, and an empty tank gives the gun back ----
(function () {
  var W = makeW(MAP2, 3, 3 * TS); CONTRA.build(W);
  var p = W.players[0];
  p.weapon = 'f'; p.fuel = 10; p.inp = { f: 0 };
  for (var i = 0; i < 120; i++) tick(W);
  assert(p.fuel === 10, 'two seconds with the trigger UP burned nothing');
  p.inp.f = 1;
  for (i = 0; i < 700; i++) tick(W);
  assert(p.weapon === 'n' && p.fuel === 0,
         'an empty tank hands the normal gun back (weapon=' + p.weapon + ')');
})();

// ---- 17. the beacon: only in co-op, and holding it revives ----
(function () {
  var W = makeW(MAP2, 3, 3 * TS); CONTRA.build(W);
  var p = W.players[0];
  /* the teammate exists from the start and stands well clear: a beacon with no
     living teammate at all now clears itself (case 18b), so "nobody is standing
     ON it" has to be tested with somebody standing somewhere ELSE. */
  var mate = { slot: 1, x: p.x + 300, y: p.y, w: 11, h: 15, vx: 0, vy: 0, onGround: true,
    face: 1, aimX: 1, aimY: 0, prone: false, dead: false, alive: true, active: true,
    invT: 0, light: 2, lives: 3, weapon: 'n', inp: {}, color: '#fff' };
  W.players.push(mate);
  p.dead = true; p.beaconT = 0; p.active = true;
  var b = CONTRA.dropBeacon(W, p, p.x + p.w / 2, p.y + p.h / 2);
  assert(!!b && b.slot === 0 && p.beaconT > 0, 'dropBeacon lights one where the player fell');

  // a teammate is up, but 300px away: the bar does not fill
  for (var i = 0; i < 30; i++) tick(W);
  assert(b.prog === 0, 'with nobody standing on it the bar stays empty');
  assert(b.alive, 'and it stays lit, because somebody could still come');

  // now the teammate walks in
  mate.x = b.x - 4; mate.y = b.y - 7;
  var filled = 0;
  for (i = 0; i < 200 && b.alive; i++) { tick(W); filled = Math.max(filled, b.prog); }
  assert(!b.alive && W.revives.length === 1, 'a teammate holding it for 3s revives the player');
  assert(W.revives[0].inv === 3, 'and they come back with 3s of invulnerability');
  assert(p.beaconT === 0, 'the beacon flag is cleared, so the core respawns normally again');
})();

// ---- 18. a beacon the run has scrolled past expires instead of stranding a player ----
(function () {
  var W = makeW(MAP2, 3, 3 * TS); CONTRA.build(W);
  var p = W.players[0];
  p.dead = true; p.active = true;
  var b = CONTRA.dropBeacon(W, p);
  b.x = -400;                                   // far behind the camera
  tick(W);
  assert(!b.alive && p.beaconT === 0,
         'a beacon left behind by the camera expires and frees the respawn');
})();

// ---- 18b. a wipe must not hold everyone dead behind their own beacons ----
// The whole team down is the one state where a beacon cannot possibly be
// answered. Left alone it freezes the run for fifteen seconds with nothing to do
// and no way to lose it.
(function () {
  var W = makeW(MAP2, 3, 3 * TS); CONTRA.build(W);
  var p = W.players[0];
  var mate = { slot: 1, x: p.x + 12, y: p.y, w: 11, h: 15, vx: 0, vy: 0, onGround: true,
    face: 1, aimX: 1, aimY: 0, prone: false, dead: false, alive: true, active: true,
    invT: 0, light: 2, lives: 3, weapon: 'n', inp: {}, color: '#fff' };
  W.players.push(mate);
  p.dead = true; p.active = true;
  var b = CONTRA.dropBeacon(W, p, p.x, p.y);
  tick(W);
  assert(b.alive && p.beaconT > 0, 'with a teammate up, the beacon holds the respawn');
  mate.dead = true;                              // and now the team is wiped
  tick(W);
  assert(!b.alive && p.beaconT === 0,
         'with nobody left standing it clears itself, so the run keeps moving');
})();

// ---- 19. gates arm off the GLOBAL column, and lock the camera ----
(function () {
  var W = makeW(MAP, 3, 3 * TS);
  W.colOffset = 100 - 20;                       // puts global gate col 100 at local 20
  CONTRA.build(W);
  var gs = CONTRA._state().gates;
  assert(gs.length === 1 && gs[0].col === 20, 'one gate armed at the right local column');
  assert(!CONTRA.camLocked(), 'camera free before anyone reaches it');
  W.players[0].x = 21 * TS;
  tick(W);
  assert(CONTRA.camLocked(), 'reaching it locks the camera');
  assert(W.banners.length === 1 && /WARNING/.test(W.banners[0][0].replace(/ /g, '')),
         'and puts WARNING on the screen');
  for (var i = 0; i < 90; i++) tick(W);
  var n = 0, rs = CONTRA._state().runners, ss = CONTRA._state().snipers;
  for (i = 0; i < rs.length; i++) if (rs[i].alive && rs[i].gate === 0) n++;
  for (i = 0; i < ss.length; i++) if (ss[i].alive && ss[i].gate === 0) n++;
  assert(n >= 8 && n <= 12, 'a wave of 8-12 landed (' + n + ')');
  // clear the room by hand and the camera must come back
  for (i = 0; i < rs.length; i++) if (rs[i].gate === 0) rs[i].alive = false;
  for (i = 0; i < ss.length; i++) if (ss[i].gate === 0) ss[i].alive = false;
  tick(W);
  assert(!CONTRA.camLocked(), 'clearing the room unlocks it again');
})();

// ---- 20. a level with no gate column in range arms none ----
(function () {
  var W = makeW(MAP, 3, 3 * TS);
  W.colOffset = 640;                            // stage 4: the boss IS the gate
  CONTRA.build(W);
  assert(CONTRA._state().gates.length === 0, 'stage 4 arms no gate');
})();

// ---- 21. still deterministic with all of it running ----
(function () {
  function run(kind) {
    var W = makeW(MAP2, 9, 3 * TS, kind); CONTRA.build(W);
    var p = W.players[0];
    p.weapon = 'f'; p.fuel = 10; p.inp = { f: 1 };
    W.players[0].x = CONTRA._state().boss.x - 70;
    for (var i = 0; i < 600; i++) {
      if (i % 40 === 0) shoot(W, p.x + 8, p.y + 6, 380, -60, 'n');
      tick(W);
    }
    return JSON.stringify(CONTRA._state(), function (k, v) {
      return (k === 'cHit') ? undefined : v;
    });
  }
  for (var k = 1; k <= 3; k++) {
    var a = run(k), b = run(k);
    assert(a === b, 'boss kind ' + k + ': same seed twice -> byte-identical state (' + a.length + ' bytes)');
  }
})();

console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL GREEN');
process.exit(fails ? 1 : 0);
