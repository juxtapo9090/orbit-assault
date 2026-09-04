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

function makeW(rows, seed, playerX) {
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
  assert(CONTRA.hud(W) === 'BOSS DOWN', 'hud reads ' + CONTRA.hud(W));
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

console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL GREEN');
process.exit(fails ? 1 : 0);
