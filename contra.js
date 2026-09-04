// ============================================================================
// CONTRA — enemies, enemy bullets, spawners, weapon capsule, wall boss.
// One global: window.CONTRA. Cooks against the W object in CONTRACT.md §2.
//
//   build(W)                    level load: scan glyphs r s t S W B, blank them, reset
//   step(W, DT)                 one sim tick (deterministic: W.rng() only, no splice)
//   draw(g, cx, cy, lights, W)  world draw with camera offset; pushes [x,y,r,col,a]
//   hud(W)                      "BOSS ████░░" while a boss is engaged, else ""
//   throwGrenade(W,x,y,vx,vy,o) the core's bomb throw — pooled, returns the slot
//   stepGrenades(W, DT)         grenade physics + the explosion test
//   drawGrenades(g,cx,cy,lights) grenades only; step()/draw() already call these,
//                               they are exported for tests, not for a second call
//
// Determinism: every random draw is W.rng(); entities die by alive=false and
// dead slots are reused in index order; arrays only compact in build().
// ============================================================================
(function () {
  'use strict';

  var TS = 16;
  var G_FALL = 2900, TERM = 900;              // same feel as the core walkers
  var RED = '#E0616B', RED_LO = '#A33F58', STEEL = '#495499', STEEL_HI = '#8B96C8';
  var HOT = '#FFD9DE', WARM = '#F5C15C';
  var BOOM = '#FF7A2A', BOOM_HI = '#FFE0A8', BOOM_LO = '#C0341C';

  // Grenades fall slower than bodies do — G_FALL (2900) at vy=-220 gives an
  // 8px hop, which is not a throw, it is a drop. 900 puts the apex ~27px up and
  // lands it ~5 tiles ahead of a standing player: a lob you can aim by walking.
  var G_GREN = 900;
  var BLAST = 5 * TS;                         // 5 tiles, CONTRACT-INPUT §6
  var BLAST_DMG = 5;                          // to a turret, a boss port, the core

  // ---- weapons contract (2026-09-04) ----
  // One cap for every live projectile in the sim: player shots + missiles,
  // enemy shots, grenades. Full pool = the shot nearest to expiring is recycled
  // first. Pure function of sim state, so every peer recycles the same one.
  // JUICE particles have their own 200-slot pool and are paint, not sim.
  var POOL_CAP = 200;
  var MISSILE_TURN = 3 * Math.PI / 180;       // per tick, not instant lock
  var MISSILE_DMG = 3;
  var DRONE_LIFE = 30, DRONE_CD = 2.0, DRONE_RANGE = 14 * TS;
  var HAWK_TIME = 2.0, HAWK_BOSS = 0.25;
  var BONE = '#E8E0C8', GOLD = '#F0B04A';

  // ---- gameplay depth contract (2026-09-04) ----
  // One boss per stage, each teaching a different skill. The core names which one
  // this level fights (W.bossKind) because the core owns the level table; CONTRA
  // owns what each of them DOES. HP is a multiple of the Dreadnought's 30.
  var K_DREAD = 0, K_WARBOSS = 1, K_TAU = 2, K_SORC = 3;
  var BOSS_HP = [30, 45, 60, 75];
  var BOSS_NAME = ['DREADNOUGHT', 'WARBOSS', 'TAU CMDR', 'SORCERER'];

  // Warboss: rush, wall, stun. The head is only hittable while he is stunned, so
  // the whole fight is "survive the charge, then cash the opening".
  var WB_IDLE = 2.0, WB_STUN = 3.0, WB_SPEED = 300, WB_THROW = 0.8, WB_ADDS = 2;
  // Tau: hovers, so there is no safe ground — you have to aim up. No weak-point
  // gating (always hittable while airborne); the shield phases are the gate.
  var TAU_HOVER = 1.1, TAU_BURST = 0.16, TAU_SHIELD = 3.0, TAU_MISSILES = 2;
  var TAU_STEP = 0.2;                          // HP fraction between shield phases
  // Sorcerer: never stands still. Telegraph, strike, blink. The portal is the
  // real decision — kill it and the adds stop, ignore it and you drown.
  var SORC_TELE = 2.0, SORC_RECOVER = 0.5, SORC_BLINK = 0.5;
  var SORC_PORTAL_CD = 30, SORC_PORTAL_HP = 30, SORC_PORTAL_SPAWN = 5.0;
  var BOLT_DMG_R = 9;                          // how near the bolt line still burns
  var WARP = '#E86FF0', WARP_LO = '#8A3FB0', TAU_BLUE = '#7FD2F0', ORK = '#63C08A';

  // Flamethrower. Not a gun: no projectile, no pool slot, just a cone test on a
  // 3-tick clock. Low per-hit and area, so it trades reach for crowd control.
  var FLAME_LEN = 4 * TS, FLAME_COS = Math.cos(30 * Math.PI / 180);  // 60deg spread
  var FLAME_TICKS = 3, FLAME_FUEL = 10.0;
  var FIRE_HI = '#FFE9A8', FIRE = '#FF9A2A', FIRE_LO = '#D2381C';

  // Co-op revive. A dead player leaves a beacon where they fell; a teammate has to
  // walk back to it, which costs the team forward progress — that is the point.
  var BEACON_LIFE = 15, BEACON_R = 2 * TS, BEACON_HOLD = 3.0, REVIVE_INV = 3.0;

  // Mini-boss gates, at GLOBAL columns (the same count the parallax stages use), so
  // each of the first three stages gets exactly one and stage four gets none — there
  // the boss IS the gate.
  var GATE_COLS = [100, 300, 500];
  var GATE_MIN = 8, GATE_SPAN = 5;             // 8..12 enemies in a wave
  var GATE_WARN = 1.0;

  var st = null;                              // whole module state; rebuilt per level
  var nextId = 1;

  function fresh() {
    nextId = 1;
    return {
      runners: [], snipers: [], turrets: [], spawners: [],
      capsules: [], pickups: [], ebullets: [], grenades: [], boss: null,
      drones: [], hawk: null,
      beacons: [], gates: [], portal: null, camLock: false
    };
  }

  // ---------- helpers ----------
  function nearestPlayer(W, x, y) {
    var best = null, bd = 1e12;
    for (var i = 0; i < W.players.length; i++) {
      var p = W.players[i];
      if (!p.alive || p.dead) continue;
      var dx = (p.x + p.w / 2) - x, dy = (p.y + p.h / 2) - y;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  function hittable(p) { return p.alive && !p.dead && !(p.invT > 0) && !(p.shieldT > 0); }
  function anyPlayerWithin(W, x, tiles) {
    for (var i = 0; i < W.players.length; i++) {
      var p = W.players[i];
      if (!p.alive || p.dead) continue;
      if (Math.abs((p.x + p.w / 2) - x) <= tiles * TS) return true;
    }
    return false;
  }
  function circleRect(bx, by, r, x, y, w, h) {
    var nx = bx < x ? x : (bx > x + w ? x + w : bx);
    var ny = by < y ? y : (by > y + h ? y + h : by);
    var dx = bx - nx, dy = by - ny;
    return dx * dx + dy * dy <= r * r;
  }
  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }
  function floorBelow(W, tx, ty) {           // pixel y of the top of the first solid at/below row ty
    for (var y = ty; y < W.MAP_H; y++) if (W.solidAt(tx, y) || W.oneWayAt(tx, y)) return y * TS;
    return W.MAP_H * TS;
  }
  function bulletDmg(kind) { return kind === 'l' ? 3 : (kind === 'h' ? MISSILE_DMG : 1); }
  function bulletHitOnce(b, id) {            // laser pierces: remember what it already hit
    if (b.kind !== 'l') { b.alive = false; return true; }
    if (!b.cHit) b.cHit = [];
    for (var i = 0; i < b.cHit.length; i++) if (b.cHit[i] === id) return false;
    b.cHit.push(id);
    return true;
  }

  // ---------- projectile pool cap ----------
  function poolRoom(W) {
    if (!st) return;
    var n = 0, oldest = null, i, b;
    var lists = [W.bullets, st.ebullets, st.grenades];
    for (var k = 0; k < lists.length; k++) {
      var L = lists[k]; if (!L) continue;
      for (i = 0; i < L.length; i++) {
        b = L[i]; if (!b.alive) continue;
        n++;
        if (!oldest || b.ttl < oldest.ttl) oldest = b;
      }
    }
    if (n >= POOL_CAP && oldest) oldest.alive = false;
  }
  function poolCount(W) {
    var n = 0, lists = [W.bullets, st ? st.ebullets : null, st ? st.grenades : null];
    for (var k = 0; k < lists.length; k++) { var L = lists[k]; if (!L) continue; for (var i = 0; i < L.length; i++) if (L[i].alive) n++; }
    return n;
  }

  // ---------- enemy bullets ----------
  var curW = null;                            // the W of the running step, for fire()
  function fire(x, y, vx, vy, src) {
    if (curW) poolRoom(curW);
    var eb = st.ebullets, b = null;
    for (var i = 0; i < eb.length; i++) if (!eb[i].alive) { b = eb[i]; break; }
    if (!b) { b = {}; eb.push(b); }
    b.alive = true; b.x = x; b.y = y; b.vx = vx; b.vy = vy; b.r = 2; b.ttl = 180; b.src = src;
    b.x1 = x; b.y1 = y; b.x2 = x; b.y2 = y; b.x3 = x; b.y3 = y;
    /* a recycled slot may have been a missile last life — clear it, or a Tau pod
       would leak its homing onto every plain shot that lands in that slot after */
    b.home = 0;
    return b;
  }
  function fireAt(x, y, tx, ty, speed, src) {
    var dx = tx - x, dy = ty - y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    fire(x, y, dx / d * speed, dy / d * speed, src);
  }
  // The Tau's shoulder pods launch these. Same bend the player's missiles get
  // (MISSILE_TURN a tick, speed kept), pointed the other way — at a player, not
  // at a hostile. A curve you can outrun, not a snap you cannot.
  function steerEnemyMissiles(W, DT) {
    var eb = st.ebullets;
    for (var i = 0; i < eb.length; i++) {
      var b = eb[i]; if (!b.alive || !b.home) continue;
      var t = nearestPlayer(W, b.x, b.y); if (!t) continue;
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
      var cur = Math.atan2(b.vy, b.vx);
      var want = Math.atan2((t.y + t.h / 2) - b.y, (t.x + t.w / 2) - b.x);
      var d = want - cur;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (d > MISSILE_TURN) d = MISSILE_TURN; else if (d < -MISSILE_TURN) d = -MISSILE_TURN;
      var a = cur + d;
      b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
    }
  }
  function stepBullets(W, DT) {
    var eb = st.ebullets;
    for (var i = 0; i < eb.length; i++) {
      var b = eb[i]; if (!b.alive) continue;
      b.x3 = b.x2; b.y3 = b.y2; b.x2 = b.x1; b.y2 = b.y1; b.x1 = b.x; b.y1 = b.y;
      b.x += b.vx * DT; b.y += b.vy * DT;
      b.ttl--;
      if (b.ttl <= 0 || b.y < -40 || b.y > W.MAP_H * TS + 40 || b.x < -40 || b.x > W.MAP_W * TS + 40) { b.alive = false; continue; }
      if (W.solidAt(Math.floor(b.x / TS), Math.floor(b.y / TS))) { b.alive = false; continue; }
      for (var j = 0; j < W.players.length; j++) {
        var p = W.players[j];
        if (!hittable(p)) continue;
        if (circleRect(b.x, b.y, b.r, p.x + 2, p.y + 2, p.w - 4, p.h - 4)) {
          b.alive = false; W.hurt(p);
          W.J('burst', b.x, b.y, RED, 6);
          break;
        }
      }
    }
  }

  // ---------- runners ----------
  function spawnRunner(x, y, fromSpawner) {
    var rs = st.runners, r = null;
    for (var i = 0; i < rs.length; i++) if (!rs[i].alive) { r = rs[i]; break; }
    if (!r) { r = {}; rs.push(r); }
    r.id = nextId++; r.alive = true; r.x = x; r.y = y; r.w = 10; r.h = 14;
    r.vx = 0; r.vy = 0; r.dir = -1; r.onGround = false; r.t = 0; r.jumpCd = 0; r.sp = fromSpawner;
    /* a recycled slot remembers who it used to work for. Clear every allegiance
       here, or a plain spawner runner inherits a dead gate's tag and that gate
       never reads as clear. */
    r.gate = -1; r.boss = false; r.cult = false;
    return r;
  }
  function stepRunners(W, DT) {
    var rs = st.runners, SPEED = 85, JUMP = 390;
    for (var i = 0; i < rs.length; i++) {
      var e = rs[i]; if (!e.alive) continue;
      e.t += DT;
      if (e.jumpCd > 0) e.jumpCd -= DT;
      // only think when near the action; far-off runners (from spawners) still fall/run
      var tgt = nearestPlayer(W, e.x + e.w / 2, e.y + e.h / 2);
      if (tgt) {
        var d = (tgt.x + tgt.w / 2) - (e.x + e.w / 2);
        if (Math.abs(d) > 4) e.dir = d > 0 ? 1 : -1;
      }
      e.vx = e.dir * SPEED;

      // vertical
      e.vy += G_FALL * DT; if (e.vy > TERM) e.vy = TERM;
      e.y += e.vy * DT;
      var ex0 = Math.floor(e.x / TS), ex1 = Math.floor((e.x + e.w - 1) / TS), tx;
      e.onGround = false;
      if (e.vy >= 0) {
        var fy = Math.floor((e.y + e.h) / TS);
        for (tx = ex0; tx <= ex1; tx++) {
          if (W.solidAt(tx, fy) || (W.oneWayAt(tx, fy) && e.y + e.h - e.vy * DT <= fy * TS + 1)) {
            e.y = fy * TS - e.h; e.vy = 0; e.onGround = true; break;
          }
        }
      } else {
        var hy = Math.floor(e.y / TS);
        for (tx = ex0; tx <= ex1; tx++) if (W.solidAt(tx, hy)) { e.y = (hy + 1) * TS; e.vy = 0; break; }
      }
      if (e.y > W.MAP_H * TS + 60) { e.alive = false; continue; }

      // horizontal + wall push-back
      e.x += e.vx * DT;
      var top = Math.floor((e.y + 1) / TS), bot = Math.floor((e.y + e.h - 1) / TS), ty, wall = false;
      var lead = e.vx > 0 ? Math.floor((e.x + e.w - 1) / TS) : Math.floor(e.x / TS);
      for (ty = top; ty <= bot; ty++) if (W.solidAt(lead, ty)) { wall = true; break; }
      if (wall) {
        e.x = e.vx > 0 ? lead * TS - e.w : (lead + 1) * TS;
      }
      // hop: wall in the face, or no ground ahead (1-tile pit)
      if (e.onGround && e.jumpCd <= 0) {
        var below = Math.floor((e.y + e.h + 1) / TS);
        var aheadX = e.vx > 0 ? Math.floor((e.x + e.w + 2) / TS) : Math.floor((e.x - 2) / TS);
        var groundAhead = W.solidAt(aheadX, below) || W.oneWayAt(aheadX, below);
        var hi = Math.floor((e.y + e.h - 1) / TS);
        var wallHi = W.solidAt(aheadX, hi) && !W.solidAt(aheadX, hi - 1) && !W.solidAt(aheadX, hi - 2);
        var pit = !groundAhead && (W.solidAt(aheadX + (e.vx > 0 ? 1 : -1), below) || W.oneWayAt(aheadX + (e.vx > 0 ? 1 : -1), below));
        if (wall || wallHi || pit) { e.vy = -JUMP; e.onGround = false; e.jumpCd = 0.35; }
      }

      // contact
      for (var j = 0; j < W.players.length; j++) {
        var p = W.players[j];
        if (!hittable(p)) continue;
        if (rectsOverlap(e.x + 1, e.y + 1, e.w - 2, e.h - 2, p.x, p.y, p.w, p.h)) W.hurt(p);
      }
    }
  }

  // ---------- snipers ----------
  function stepSnipers(W, DT) {
    var ss = st.snipers;
    for (var i = 0; i < ss.length; i++) {
      var s = ss[i]; if (!s.alive) continue;
      s.t += DT;
      var cx = s.x + s.w / 2, cy = s.y + 4;
      var tgt = nearestPlayer(W, cx, cy);
      if (!tgt) continue;
      var dx = (tgt.x + tgt.w / 2) - cx, dy = (tgt.y + tgt.h / 2) - cy;
      s.face = dx < 0 ? -1 : 1;
      if (dx * dx + dy * dy > (14 * TS) * (14 * TS)) continue;
      s.cd -= DT;
      if (s.cd <= 0) {
        fireAt(cx + s.face * 6, cy, tgt.x + tgt.w / 2, tgt.y + tgt.h / 2, 150, 's');
        s.cd = 1.6 + (W.rng() - 0.5) * 0.5;
        s.flash = 0.12;
        W.J('sfx', 'shoot');
      }
      if (s.flash > 0) s.flash -= DT;
    }
  }

  // ---------- turrets ----------
  var DIR8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  function stepTurrets(W, DT) {
    var ts = st.turrets;
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i]; if (!t.alive) continue;
      t.t += DT;
      if (t.flash > 0) t.flash -= DT;
      var tgt = nearestPlayer(W, t.x, t.y);
      var near = tgt && Math.abs((tgt.x + tgt.w / 2) - t.x) < 18 * TS;
      if (!t.open) {
        if (near) t.cd -= DT;
        if (t.cd <= 0) { t.open = true; t.cd = 0; t.shots = 0; t.gap = 0.25; }
        continue;
      }
      // open: track then volley of 3, then close
      if (tgt) {
        var dx = (tgt.x + tgt.w / 2) - t.x, dy = (tgt.y + tgt.h / 2) - t.y, ang = Math.atan2(dy, dx);
        var k = Math.round(ang / (Math.PI / 4)); if (k < 0) k += 8; k %= 8;
        t.aim = k;
      }
      t.gap -= DT;
      if (t.gap <= 0) {
        if (t.shots < 3) {
          var d = DIR8[t.aim], n = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
          fire(t.x + d[0] / n * 8, t.y + d[1] / n * 8, d[0] / n * 160, d[1] / n * 160, 't');
          t.shots++; t.gap = 0.16; t.flash = 0.08;
          W.J('sfx', 'shoot');
        } else {
          t.open = false; t.cd = 1.0 + W.rng() * 0.3;
        }
      }
    }
  }

  // ---------- spawners ----------
  function stepSpawners(W, DT) {
    var sp = st.spawners;
    for (var i = 0; i < sp.length; i++) {
      var s = sp[i];
      if (!anyPlayerWithin(W, s.x, 12)) continue;
      s.cd -= DT;
      if (s.cd > 0) continue;
      var live = 0;
      for (var j = 0; j < st.runners.length; j++) if (st.runners[j].alive && st.runners[j].sp === i) live++;
      if (live >= 4) continue;
      var camX = W.camX(), tgt = nearestPlayer(W, s.x, s.y), px = tgt ? tgt.x : s.x;
      var left = camX - 14, right = camX + W.VW + 4;
      var x = (right - px) >= (px - left) ? right : left;
      spawnRunner(x, s.y, i);
      s.cd = 1.1 + W.rng() * 0.25;
    }
  }

  // ---------- capsule + pickups ----------
  function stepCapsules(W, DT) {
    var cs = st.capsules;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (c.state === 0) {
        if (anyPlayerWithin(W, c.ax, 10)) {
          c.state = 1; c.t = 0; c.x = W.camX() - 24; c.y = c.ay;
          c.vx = 92; c.alive = true;
        }
        continue;
      }
      if (c.state !== 1) continue;
      c.t += DT;
      c.x += c.vx * DT;
      c.y = c.ay + Math.sin(c.t * 2.4) * 22;
      if (c.x > W.camX() + W.VW + 40) c.state = 2;
    }
    var ps = st.pickups;
    for (i = 0; i < ps.length; i++) {
      var k = ps[i]; if (!k.alive) continue;
      k.t += DT;
      if (!k.grounded) {
        k.vy += G_FALL * 0.35 * DT; if (k.vy > 260) k.vy = 260;
        k.y += k.vy * DT;
        var fy = Math.floor((k.y + 6) / TS), tx = Math.floor(k.x / TS);
        if (W.solidAt(tx, fy) || W.oneWayAt(tx, fy)) { k.y = fy * TS - 6; k.vy = 0; k.grounded = true; }
        if (k.y > W.MAP_H * TS + 40) { k.alive = false; continue; }
      }
      for (var j = 0; j < W.players.length; j++) {
        var p = W.players[j];
        if (!p.alive || p.dead) continue;
        if (rectsOverlap(k.x - 6, k.y - 6, 12, 12, p.x, p.y, p.w, p.h)) {
          k.alive = false;
          if (k.kind === 'b') { p.shieldT = 5; }
          else if (k.kind === 'h') { p.weapon = 'h'; p.hAmmo = 30; }
          else if (k.kind === 'f') { p.weapon = 'f'; p.fuel = FLAME_FUEL; }
          else if (k.kind === 'd') { spawnDrone(W, p); }
          else if (k.kind === 't') { startHawk(W, p); }
          else { p.weapon = k.kind; }
          W.J('sfx', 'pickup'); W.J('burst', k.x, k.y, pickColor(k.kind), 14);
          W.score(500, p);
          break;
        }
      }
    }
  }
  function pickColor(kind) {
    return kind === 'l' ? '#7FD2F0' : kind === 'b' ? '#6EE7F0' : kind === 'h' ? RED :
           kind === 'd' ? BONE : kind === 't' ? GOLD : kind === 'f' ? FIRE : WARM;
  }
  // Capsule odds. T is still the rare one (5%); F takes its 13% out of the
  // shield/laser share rather than off the top, so nothing else got rarer than
  // the day it was tuned except by that much.
  function dropPickup(W, x, y) {
    var roll = W.rng();
    var kind = roll < 0.05 ? 't' : roll < 0.17 ? 'd' : roll < 0.31 ? 'h' :
               roll < 0.44 ? 'f' : roll < 0.65 ? 'b' : roll < 0.81 ? 'l' : 's';
    var ps = st.pickups, k = null;
    for (var i = 0; i < ps.length; i++) if (!ps[i].alive) { k = ps[i]; break; }
    if (!k) { k = {}; ps.push(k); }
    k.alive = true; k.x = x; k.y = y; k.vy = -40; k.kind = kind; k.grounded = false; k.t = 0;
  }

  // ---------- targets: everything a missile can chase or a laser can chip ----------
  // fn(x, y, obj, kind) over every live hostile, index order — the same order on
  // every peer, so "nearest" ties break the same way everywhere.
  function eachTarget(W, fn) {
    var i, o;
    for (i = 0; i < st.runners.length; i++) { o = st.runners[i]; if (o.alive) fn(o.x + o.w / 2, o.y + o.h / 2, o, 'r'); }
    for (i = 0; i < st.snipers.length; i++) { o = st.snipers[i]; if (o.alive) fn(o.x + o.w / 2, o.y + o.h / 2, o, 's'); }
    for (i = 0; i < st.turrets.length; i++) { o = st.turrets[i]; if (o.alive) fn(o.x, o.y, o, 't'); }
    for (i = 0; i < st.capsules.length; i++) { o = st.capsules[i]; if (o.state === 1) fn(o.x, o.y, o, 'c'); }
    var wk = W.enemies;
    if (wk) for (i = 0; i < wk.length; i++) { o = wk[i]; if (o.alive) fn(o.x + o.w / 2, o.y + o.h / 2, o, 'w'); }
    var PT = st.portal;
    if (PT && PT.alive) fn(PT.x, PT.y, PT, 'o');
    var B = st.boss;
    if (B && B.alive && B.engaged) {
      if (B.ports) for (i = 0; i < 3; i++) { o = B.ports[i]; if (o.alive) fn(o.x, o.y, o, 'p'); }
      fn(B.cx, B.cy, B, 'B');
    }
  }
  function nearestTarget(W, x, y, maxD) {
    var best = null, bd = maxD ? maxD * maxD : 1e18;
    eachTarget(W, function (tx, ty, o, kind) {
      var dx = tx - x, dy = ty - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { x: tx, y: ty, o: o, kind: kind }; }
    });
    return best;
  }
  // Chip damage: one point, the same rules a bullet obeys (closed turret and
  // closed boss shell shrug it off). Used by the servo-skull's laser.
  function chip(W, t, owner) {
    var o = t.o, k = t.kind;
    if (k === 'r') { o.alive = false; W.score(100, owner); W.J('burst', t.x, t.y, RED, 12); W.J('sfx', 'enemyDie'); }
    else if (k === 's') { o.alive = false; W.score(200, owner); W.J('burst', t.x, t.y, RED, 12); W.J('sfx', 'enemyDie'); }
    else if (k === 'w') { o.alive = false; W.score(200, owner); W.J('burst', t.x, t.y, '#63C08A', 14); W.J('sfx', 'enemyDie'); }
    else if (k === 'c') { o.state = 2; W.score(100, owner); dropPickup(W, o.x, o.y); W.J('burst', o.x, o.y, WARM, 12); W.J('sfx', 'enemyDie'); }
    else if (k === 't') {
      if (!o.open) { W.J('sfx', 'turretHit'); return; }
      o.hp -= 1; o.flash = 0.1; W.J('sfx', 'turretHit');
      if (o.hp <= 0) { o.alive = false; W.score(500, owner); W.J('burst', o.x, o.y, RED, 18); W.J('sfx', 'enemyDie'); W.J('shake', 0.3); }
    } else if (k === 'p') {
      o.hp -= 1; o.flash = 0.1; W.J('sfx', 'bossHit');
      if (o.hp <= 0) { o.alive = false; W.score(1000, owner); W.J('burst', o.x, o.y, RED, 20); W.J('sfx', 'enemyDie'); W.J('shake', 0.4); }
    } else if (k === 'o') {
      damagePortal(W, o, 1, owner);
    } else if (k === 'B') {
      if (!o.open) { W.J('sfx', 'turretHit'); return; }
      damageBossCore(W, o, 1, owner);
    }
  }

  // ---------- homing missiles ----------
  // The core launches them as bullets of kind 'h'; we bend them. atan2 to the
  // nearest hostile, at most MISSILE_TURN per tick, speed kept — a curve you can
  // watch, not a snap. No target in range: it flies straight like a dumb rocket.
  function steerMissiles(W, DT) {
    var bs = W.bullets;
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i]; if (!b.alive || b.kind !== 'h') continue;
      var t = nearestTarget(W, b.x, b.y, 0);
      if (!t) continue;
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
      var cur = Math.atan2(b.vy, b.vx), want = Math.atan2(t.y - b.y, t.x - b.x);
      var d = want - cur;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (d > MISSILE_TURN) d = MISSILE_TURN; else if (d < -MISSILE_TURN) d = -MISSILE_TURN;
      var a = cur + d;
      b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
    }
  }

  // ---------- servo-skull drone ----------
  // One per player slot, keyed by slot. Lives in st, so a level load (fresh())
  // clears it — the skull is a stage buddy, not a permanent upgrade.
  function spawnDrone(W, p) {
    var d = st.drones[p.slot];
    if (!d) { d = {}; st.drones[p.slot] = d; }
    d.alive = true; d.slot = p.slot; d.life = DRONE_LIFE; d.cd = 0.6; d.t = 0;
    d.x = p.x + p.w / 2 - p.face * 15; d.y = p.y - 20; d.face = p.face; d.bankT = 0;
    d.fireT = 0; d.laserT = 0; d.lx = d.x; d.ly = d.y;
  }
  function stepDrones(W, DT) {
    for (var i = 0; i < st.drones.length; i++) {
      var d = st.drones[i]; if (!d || !d.alive) continue;
      var p = W.players[d.slot];
      d.t += DT; d.life -= DT;
      if (!p || !p.alive || p.dead || d.life <= 0) {
        d.alive = false; W.J('burst', d.x, d.y, BONE, 10); W.J('sfx', 'turretHit');
        continue;
      }
      if (p.face !== d.face) { d.face = p.face; d.bankT = 0.3; }
      if (d.bankT > 0) d.bankT -= DT;
      if (d.fireT > 0) d.fireT -= DT;
      if (d.laserT > 0) d.laserT -= DT;
      var tx = p.x + p.w / 2 - p.face * 15, ty = p.y - 20;
      d.x += (tx - d.x) * 0.15; d.y += (ty - d.y) * 0.15;
      d.cd -= DT;
      if (d.cd <= 0) {
        var t = nearestTarget(W, d.x, d.y, DRONE_RANGE);
        if (t) {
          chip(W, t, p);
          d.lx = t.x; d.ly = t.y; d.laserT = 0.1; d.fireT = 0.2;
          W.J('sfx', 'laser');
          d.cd = DRONE_CD;
        } else d.cd = 0.25;                  // look again soon; the 2s clock starts on a shot
      }
    }
  }

  // ---------- Thunderhawk strafing run ----------
  // One sprite crossing the screen right to left in HAWK_TIME, and a wave of
  // death that follows its nose: every hostile on screen dies as the hawk passes
  // over it, the boss core takes a quarter of its bar once. No projectiles, no
  // pool — the bombs are bursts, the damage is by position.
  function startHawk(W, p) {
    var camX = W.camX(), camY = W.cam ? W.cam.y : 0;
    st.hawk = { on: true, t: 0, x: camX + W.VW + 70, y: camY + 44, x0: camX, owner: p.slot,
      speed: (W.VW + 160) / HAWK_TIME, bombT: 0, bossHit: false };
    W.J('sfx', 'bossDie'); W.J('shake', 0.6);
    if (W.flash) W.flash(0.5, WARM);
  }
  function stepHawk(W, DT) {
    var H = st.hawk; if (!H || !H.on) return;
    var owner = W.players[H.owner] || null;
    H.t += DT; H.x -= H.speed * DT;
    var camX = W.camX(), camY = W.cam ? W.cam.y : 0;
    H.y += ((camY + 44) - H.y) * 0.1;
    if (H.t % 0.1 < DT) W.J('shake', 0.35);               // 4px-ish jitter for the whole run
    H.bombT -= DT;
    if (H.bombT <= 0) {                                    // cosmetic bombs along the path
      H.bombT = 0.12;
      var by = camY + 60 + ((H.t * 7) % 1) * (W.VH - 90);
      W.J('burst', H.x - 20, by, BOOM_HI, 10); W.J('burst', H.x - 20, by, BOOM, 8);
      if (W.flash) W.flash(0.25, BOOM_HI);
    }
    // the death wave: on screen AND behind the nose
    var left = camX - 20, right = camX + W.VW + 20, nose = H.x - 10;
    var kills = [];
    eachTarget(W, function (x, y, o, kind) {
      if (x < left || x > right || x > nose) return;
      if (kind === 'B') return;
      kills.push({ x: x, y: y, o: o, kind: kind });
    });
    for (var i = 0; i < kills.length; i++) {
      var k = kills[i];
      // one bomb is more than a hit point; a turret's shield is no answer to it
      if (k.kind === 't') { k.o.open = true; k.o.hp = 1; }
      if (k.kind === 'p') k.o.hp = 1;
      if (k.kind === 'o') k.o.hp = 1;          /* a warp portal is not proof against a bomb run */
      chip(W, k, owner);                       // score / burst / sfx stay in one place
    }
    var B = st.boss;
    if (B && B.alive && B.engaged && !H.bossHit && B.cx >= left && B.cx <= nose) {
      H.bossHit = true;
      damageBossCore(W, B, Math.ceil(B.hpMax * HAWK_BOSS), owner);
      W.J('burst', B.cx, B.cy, BOOM_HI, 24);
    }
    if (H.x < camX - 90) H.on = false;
  }

  // ---------- boss ----------
  // Four bosses, one per stage, one entry point. Everything they share lives in
  // stepBoss (engagement, the flash timer, the arena the camera pins them to);
  // everything that makes them different lives in their own step below. `B.open`
  // is the one flag the damage code reads, so "where is the weak point open" is
  // the only thing a boss has to answer to be shootable — no boss-kind branches
  // in bulletVsEnemies, explode() or the Thunderhawk.
  var BOSS_PERIOD = 4.0, BOSS_OPEN = 1.5, BOSS_OPEN_LONG = 2.6;

  // The arena is measured off the shared camera, never off `view`: cam is sim
  // state every peer computes identically, view is one browser's opinion.
  // It is bounded VERTICALLY too, and that is not decoration. Level 3's boss
  // floor sits at world y 128 on a map only 18 tiles tall, so a flyer picking a
  // height off `base` alone can hover at y -2: above the ceiling, off the top of
  // the screen, unhittable and unseen. The ceiling is the camera, and the floor
  // is whichever comes first, the bottom of the view or the ground itself.
  function arena(W, B) {
    var camX = W.camX(), camY = (W.cam ? W.cam.y : 0);
    B.aL = camX + 30; B.aR = camX + W.VW - 30;
    B.aT = camY + 34;
    B.aB = Math.min(camY + W.VH - 40, B.base - 28);
    if (B.aB < B.aT) B.aB = B.aT;
  }

  function stepBoss(W, DT) {
    var B = st.boss; if (!B || !B.alive) return;
    var camX = W.camX();
    if (!B.engaged) {
      if (camX + W.VW > B.x - 60) { B.engaged = true; B.t = 0; }
      else return;
    }
    B.t += DT; B.modeT += DT;
    if (B.flash > 0) B.flash -= DT;
    arena(W, B);
    if (B.kind === K_DREAD) stepDread(W, DT, B);
    else if (B.kind === K_WARBOSS) stepWarboss(W, DT, B);
    else if (B.kind === K_TAU) stepTau(W, DT, B);
    else stepSorcerer(W, DT, B);
  }

  function bossMode(B, m) { B.mode = m; B.modeT = 0; }

  // Contact damage for the bosses that move into you. Same shape every hittable
  // player check uses, so a shield or an i-frame reads the same here as anywhere.
  function bossTouch(W, B, x, y, w, h) {
    for (var i = 0; i < W.players.length; i++) {
      var p = W.players[i];
      if (!hittable(p)) continue;
      if (rectsOverlap(x, y, w, h, p.x, p.y, p.w, p.h)) W.hurt(p);
    }
  }

  // ---------- stage 1: Chaos Dreadnought ----------
  // Unchanged from the version that shipped: stomps in place, opens its chest on
  // a fixed 4s clock, three gun ports that die separately and lengthen the window.
  function stepDread(W, DT, B) {
    var portsLeft = 0, i;
    for (i = 0; i < 3; i++) if (B.ports[i].alive) portsLeft++;
    var openWin = portsLeft === 0 ? BOSS_OPEN_LONG : BOSS_OPEN;
    var ph = B.t % BOSS_PERIOD;
    B.open = ph >= BOSS_PERIOD - openWin;
    B.openK = B.open ? Math.min(1, (ph - (BOSS_PERIOD - openWin)) / 0.25) : 0;

    for (i = 0; i < 3; i++) {
      var P = B.ports[i]; if (!P.alive) continue;
      if (P.flash > 0) P.flash -= DT;
      P.cd -= DT;
      if (P.cd <= 0) {
        var tgt = nearestPlayer(W, P.x, P.y);
        if (tgt) {
          if (P.burst === 0) P.burst = 3;
          fireAt(P.x + B.face * 6, P.y, tgt.x + tgt.w / 2, tgt.y + tgt.h / 2, 140, 'b');
          W.J('sfx', 'shoot');
          P.burst--; P.flash = 0.08;
          P.cd = P.burst > 0 ? 0.13 : 2.2 + W.rng() * 0.6;
        } else P.cd = 0.5;
      }
    }
  }

  // ---------- stage 2: Ork Warboss ----------
  // idle (throwing boyz at you) -> charge -> hit the wall -> stunned. The head is
  // the weak point and it is only open in the stun, so the adds are not a side
  // dish: they are what you have to survive while you wait for the window.
  function stepWarboss(W, DT, B) {
    /* Upright his head is 84px up — five tiles, unreachable without standing under
       a boss who is actively charging you. Stunned he is doubled over, so it comes
       down to 48 and a grounded shot can land. The pose the art already draws and
       the only window the fight gives you are the same moment; the hitbox follows
       the picture instead of arguing with it. */
    B.cy = B.base - (B.mode === 2 ? 48 : 84);
    var tgt = nearestPlayer(W, B.cx, B.base - 40);
    if (B.mode === 0) {                        // idle: face the player, lob runners
      B.open = false;
      if (tgt) B.face = (tgt.x + tgt.w / 2) < B.cx ? -1 : 1;
      B.throwCd -= DT;
      if (B.throwCd <= 0) {
        B.throwCd = WB_THROW;
        var live = 0;
        for (var i = 0; i < st.runners.length; i++) if (st.runners[i].alive && st.runners[i].boss) live++;
        if (live < WB_ADDS) {
          var r = spawnRunner(B.cx - B.face * 14, B.base - 30, -1);
          r.boss = true; r.vy = -260; r.dir = B.face;
          W.J('sfx', 'stomp'); W.J('burst', r.x, r.y, ORK, 8);
        }
      }
      if (B.modeT >= WB_IDLE) { bossMode(B, 1); W.J('sfx', 'bossHit'); W.J('shake', 0.3); }
    } else if (B.mode === 1) {                 // charge: no safe distance
      B.open = false;
      B.cx += B.face * WB_SPEED * DT;
      var wall = B.cx <= B.aL || B.cx >= B.aR ||
                 W.solidAt(Math.floor((B.cx + B.face * 20) / TS), Math.floor((B.base - 20) / TS));
      if (wall) {
        B.cx = Math.max(B.aL, Math.min(B.aR, B.cx));
        bossMode(B, 2);
        W.J('sfx', 'bossDie'); W.J('shake', 0.8); W.J('burst', B.cx, B.base - 8, '#8B96C8', 22);
      }
    } else {                                   // stunned: the only window there is
      B.open = true;
      B.openK = Math.min(1, B.modeT / 0.25);
      if (B.modeT >= WB_STUN) { bossMode(B, 0); B.throwCd = 0; B.open = false; }
    }
    bossTouch(W, B, B.cx - 18, B.base - 96, 36, 96);
  }

  // ---------- stage 3: Tau Commander ----------
  // Flies, so the fight is fought upward: aim-up or lose. Always hittable in the
  // air — the gate is the shield, which it drops into every 20% of its bar.
  function stepTau(W, DT, B) {
    var camX = W.camX(), tgt = nearestPlayer(W, B.cx, B.cy);
    if (B.mode !== 3 && B.hp <= B.shieldAt) {  // 20% gone: land and recharge
      bossMode(B, 3);
      B.shieldAt -= Math.ceil(B.hpMax * TAU_STEP);
      W.J('sfx', 'pickup'); W.J('burst', B.cx, B.cy, TAU_BLUE, 24);
    }
    if (B.mode === 3) {                        // shield: grounded, absorbs everything
      B.open = false;
      B.cy += ((B.base - 56) - B.cy) * 0.18;
      if (B.modeT >= TAU_SHIELD) { bossMode(B, 0); B.hoverT = 0; }
      return;
    }
    B.open = true;                             // airborne = hittable, no gating
    B.cx += (B.tx - B.cx) * 0.055;
    B.cy += (B.ty - B.cy) * 0.055;
    if (B.mode === 0) {                        // hover / reposition
      if (B.modeT >= TAU_HOVER) bossMode(B, B.next === 0 ? 1 : 2);
    } else if (B.mode === 1) {                 // burst cannon, three shots down-spread
      B.fireCd -= DT;
      if (B.fireCd <= 0 && B.shots < 3) {
        var aim = tgt ? Math.atan2((tgt.y + tgt.h / 2) - B.cy, (tgt.x + tgt.w / 2) - B.cx) : Math.PI / 2;
        var a = aim + (B.shots - 1) * 0.26;
        fire(B.cx, B.cy + 10, Math.cos(a) * 175, Math.sin(a) * 175, 'b');
        B.shots++; B.fireCd = TAU_BURST; B.flash = 0.08;
        W.J('sfx', 'shoot');
      }
      if (B.shots >= 3) { B.shots = 0; B.fireCd = 0; B.next = 1; reposTau(W, B); }
    } else {                                   // shoulder pods: two homing missiles
      if (B.shots < TAU_MISSILES) {
        B.fireCd -= DT;
        if (B.fireCd <= 0) {
          var side = B.shots ? 1 : -1;
          var m = fire(B.cx + side * 14, B.cy - 6, side * 60, 90, 'm');
          if (m) m.home = 1;
          B.shots++; B.fireCd = 0.35;
          W.J('sfx', 'laser');
        }
      } else { B.shots = 0; B.fireCd = 0; B.next = 0; reposTau(W, B); }
    }
  }
  function reposTau(W, B) {
    bossMode(B, 0);
    B.tx = B.aL + W.rng() * (B.aR - B.aL);
    B.ty = B.aT + W.rng() * (B.aB - B.aT);
  }

  // ---------- stage 4: Chaos Sorcerer ----------
  // Telegraph, strike, blink, repeat — and a portal that keeps paying out cultists
  // until someone spends the damage on it instead of on the boss. That choice is
  // the fight.
  function stepSorcerer(W, DT, B) {
    stepPortal(W, DT, B);
    if (B.mode === 0) {                        // cast: 2s of telegraph, then the bolt
      B.open = true; B.alpha = 1;
      if (B.modeT < SORC_TELE) {
        var tgt = nearestPlayer(W, B.cx, B.cy);
        if (tgt && !B.boltLock) {               // the line is locked when the cast starts
          B.boltX = tgt.x + tgt.w / 2; B.boltY = tgt.y + tgt.h / 2; B.boltLock = 1;
        }
      } else if (B.boltT <= 0 && !B.struck) {
        B.struck = 1; B.boltT = 0.22;
        strikeBolt(W, B);
      }
      if (B.boltT > 0) B.boltT -= DT;
      if (B.modeT >= SORC_TELE + SORC_RECOVER) { bossMode(B, 1); B.open = false; }
    } else {                                   // blink: half a second of untouchable
      B.open = false;
      B.alpha = 0.45;
      if (B.modeT >= SORC_BLINK) {
        B.cx = B.aL + W.rng() * (B.aR - B.aL);
        B.cy = B.aT + W.rng() * (B.aB - B.aT);
        bossMode(B, 0);
        B.boltLock = 0; B.struck = 0; B.alpha = 1;
        W.J('burst', B.cx, B.cy, WARP, 20); W.J('sfx', 'pickup');
      }
    }
  }
  // Warp lightning: a straight line from the sorcerer to where you WERE two
  // seconds ago. Everything within BOLT_DMG_R of that segment burns, so the
  // answer is always "be somewhere else by now".
  function strikeBolt(W, B) {
    var x1 = B.cx, y1 = B.cy, x2 = B.boltX, y2 = B.boltY;
    var dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1;
    for (var i = 0; i < W.players.length; i++) {
      var p = W.players[i];
      if (!hittable(p)) continue;
      var px = p.x + p.w / 2 - x1, py = p.y + p.h / 2 - y1;
      var t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2));
      var ox = px - dx * t, oy = py - dy * t;
      if (ox * ox + oy * oy <= BOLT_DMG_R * BOLT_DMG_R) W.hurt(p);
    }
    W.J('burst', x2, y2, WARP, 22); W.J('sfx', 'laser'); W.J('shake', 0.45);
    if (W.flash) W.flash(0.4, WARP);
  }
  function stepPortal(W, DT, B) {
    var P = st.portal;
    if (!P || !P.alive) {
      B.portalCd -= DT;
      if (B.portalCd <= 0) {
        B.portalCd = SORC_PORTAL_CD;
        st.portal = { id: nextId++, alive: true, hp: SORC_PORTAL_HP, hpMax: SORC_PORTAL_HP,
          x: B.aL + 40 + W.rng() * Math.max(1, (B.aR - B.aL) - 80), y: B.base - 34,
          t: 0, left: 3 + (W.rng() < 0.5 ? 0 : 1), cd: 0.6, flash: 0 };
        W.J('sfx', 'bossHit'); W.J('burst', st.portal.x, st.portal.y, WARP, 26);
      }
      return;
    }
    P.t += DT;
    if (P.flash > 0) P.flash -= DT;
    P.cd -= DT;
    if (P.cd <= 0 && P.left > 0) {
      P.left--;
      P.cd = SORC_PORTAL_SPAWN / 4;
      var r = spawnRunner(P.x - 5, P.y - 8, -1);
      r.cult = true; r.vy = -140;
      W.J('burst', P.x, P.y, WARP, 12); W.J('sfx', 'enemyDie');
    }
    if (P.left <= 0 && P.t > SORC_PORTAL_SPAWN + 1) { P.alive = false; }
  }


  // ---------- flamethrower ----------
  // Not a gun and not a projectile: a cone test on a 3-tick clock, so it never
  // touches the pool and never competes with a shot for a slot. One damage a tick
  // is nothing to a boss and everything to a room full of runners — which is the
  // whole trade. Fuel burns only while the trigger is down; the bar IS the clock.
  function flameOrigin(p) {
    var ax = p.aimX, ay = p.aimY;
    if (ax === 0 && ay === 0) ax = p.face;
    var L = Math.sqrt(ax * ax + ay * ay) || 1;
    return { x: p.x + p.w / 2, y: p.y + (p.prone ? p.h * 0.5 : p.h * 0.4), nx: ax / L, ny: ay / L };
  }
  function inCone(o, tx, ty) {
    var dx = tx - o.x, dy = ty - o.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d > FLAME_LEN || d < 0.001) return d <= FLAME_LEN;
    return (dx * o.nx + dy * o.ny) / d >= FLAME_COS;
  }
  function stepFlames(W, DT) {
    var burn = (W.tick % FLAME_TICKS) === 0;
    for (var i = 0; i < W.players.length; i++) {
      var p = W.players[i];
      if (!p.alive || p.dead || p.weapon !== 'f') continue;
      if (!p.inp || !p.inp.f) continue;
      p.fuel -= DT;
      if (p.fuel <= 0) {                       // out of fuel: the normal gun comes back
        p.fuel = 0; p.weapon = 'n';
        W.J('sfx', 'turretHit');
        continue;
      }
      if (!burn) continue;
      var o = flameOrigin(p), hits = [];
      eachTarget(W, function (tx, ty, obj, kind) {
        if (inCone(o, tx, ty)) hits.push({ x: tx, y: ty, o: obj, kind: kind });
      });
      for (var h = 0; h < hits.length; h++) chip(W, hits[h], p);   // area, not single-target
      if (hits.length) W.J('sfx', 'turretHit');
    }
  }

  // ---------- co-op revive ----------
  // Called by the core the moment a player dies with someone else still standing.
  // The beacon is where they fell, not where the run has got to — the camera only
  // ever advances, so saving a teammate means giving up ground. That cost is the
  // mechanic; without it a revive is just a free respawn with extra steps.
  // x/y come from the core, which knows where the floor is — a beacon has to be
  // somewhere a teammate can STAND, and the commonest death here is a long drop.
  function dropBeacon(W, p, x, y) {
    if (!st) return null;
    var bs = st.beacons, b = null;
    for (var i = 0; i < bs.length; i++) if (!bs[i].alive) { b = bs[i]; break; }
    if (!b) { b = {}; bs.push(b); }
    b.alive = true; b.slot = p.slot;
    b.x = (x === undefined ? p.x + p.w / 2 : x);
    b.y = (y === undefined ? p.y + p.h / 2 : y);
    b.t = BEACON_LIFE; b.prog = 0; b.helpers = 0;
    p.beaconT = BEACON_LIFE;
    W.J('burst', b.x, b.y, GOLD, 16); W.J('sfx', 'coin');
    return b;
  }
  function stepBeacons(W, DT) {
    var camX = W.camX();
    for (var i = 0; i < st.beacons.length; i++) {
      var b = st.beacons[i]; if (!b.alive) continue;
      var p = W.players[b.slot];
      if (!p || !p.dead || !p.alive) { b.alive = false; continue; }
      b.t -= DT;
      /* left behind: the screen has moved on, so the body has. Expiring here (not
         just at 15s) is what stops a beacon quietly holding a player dead off-screen
         while the core waits for a revive that can never happen. */
      if (b.t <= 0 || b.x < camX - 8) {
        b.alive = false; p.beaconT = 0;
        W.J('burst', b.x, b.y, '#5A6080', 10);
        continue;
      }
      /* Nobody left standing means nobody is coming. Without this, a wipe holds
         EVERY player dead behind a beacon only another living player could clear:
         the game stops for fifteen seconds with no way to act and no way to lose,
         and calls it a mechanic. A beacon is a rescue, so it needs a rescuer —
         with none, fall straight through to the ordinary respawn. */
      var n = 0, rescuers = 0;
      for (var j = 0; j < W.players.length; j++) {
        var q = W.players[j];
        if (q === p || !q.alive || q.dead) continue;
        rescuers++;
        var dx = (q.x + q.w / 2) - b.x, dy = (q.y + q.h / 2) - b.y;
        if (dx * dx + dy * dy <= BEACON_R * BEACON_R) n++;
      }
      if (!rescuers) {
        b.alive = false; p.beaconT = 0;
        W.J('burst', b.x, b.y, '#5A6080', 8);
        continue;
      }
      p.beaconT = b.t;
      b.helpers = n;
      /* Hold it, do not bank it: step back out of the circle and the bar drains at
         the same rate it filled. A revive should cost a teammate three seconds of
         standing still in a firefight, not three seconds collected over a minute. */
      b.prog += (n > 0 ? DT : -DT);
      if (b.prog < 0) b.prog = 0;
      if (b.prog >= BEACON_HOLD) {
        b.alive = false; p.beaconT = 0;
        W.revive(p, b.x, b.y, REVIVE_INV);
        W.J('burst', b.x, b.y, GOLD, 30); W.J('sfx', 'start'); W.J('shake', 0.3);
        if (W.flash) W.flash(0.35, GOLD);
      }
    }
  }

  // ---------- mini-boss gates ----------
  // The camera stops, a wave lands, and the run does not continue until the room
  // is clear. One per stage; stage four has none, because there the boss is it.
  function stepGates(W, DT) {
    st.camLock = false;
    for (var i = 0; i < st.gates.length; i++) {
      var G = st.gates[i];
      if (G.state === 3) continue;
      if (G.state === 0) {
        if (!leadPast(W, G.x)) continue;
        G.state = 1; G.t = GATE_WARN;
        W.banner('W A R N I N G', GATE_WARN);
        W.J('sfx', 'hurt'); W.J('shake', 0.5);
        if (W.flash) W.flash(0.4, RED);
      }
      st.camLock = true;                       // held from the warning to the last kill
      if (G.state === 1) {
        G.t -= DT;
        if (G.t <= 0) { G.state = 2; spawnWave(W, G, i); }
        continue;
      }
      var live = 0, j;
      for (j = 0; j < st.runners.length; j++) if (st.runners[j].alive && st.runners[j].gate === i) live++;
      for (j = 0; j < st.snipers.length; j++) if (st.snipers[j].alive && st.snipers[j].gate === i) live++;
      if (live === 0) {
        G.state = 3; st.camLock = false;
        W.banner('CLEAR', 1.2);
        W.J('sfx', 'goal'); W.score(1500, null);
      }
    }
  }
  function leadPast(W, x) {
    for (var i = 0; i < W.players.length; i++) {
      var p = W.players[i];
      if (!p.alive || p.dead) continue;
      if (p.x + p.w / 2 >= x) return true;
    }
    return false;
  }
  // Themed off the stage the gate stands in: orks and cultists in the jungle, all
  // orks on the ork stage, Tau marksmen and cultists in the Tau corridor.
  function spawnWave(W, G, idx) {
    var n = GATE_MIN + Math.floor(W.rng() * GATE_SPAN);
    G.n = n;                                   /* what LANDED, for the tests */
    var camX = W.camX(), left = camX - 20, right = camX + W.VW + 20;
    for (var k = 0; k < n; k++) {
      var fromLeft = W.rng() < 0.5;
      var x = fromLeft ? left - (k % 4) * 22 : right + (k % 4) * 22;
      if (G.stage === 2 && (k % 3) === 0) {    // Tau corridor: marksmen on the deck
        var tx = Math.floor((camX + 40 + W.rng() * (W.VW - 80)) / TS);
        var fy = floorBelow(W, tx, 1);
        st.snipers.push({ id: nextId++, alive: true, x: tx * TS + 3, y: fy - 14, w: 10, h: 14,
          face: -1, cd: 0.9 + W.rng() * 0.7, t: 0, flash: 0, gate: idx });
        continue;
      }
      /* on the floor beneath the SPAWN column, not the gate's floor: the screen
         edge is 200px from the gate and the ground under it is often somewhere
         else entirely. Spawning at the gate's height dropped a third of every
         wave straight into a pit before the player ever saw it. */
      var gy = floorBelow(W, Math.floor(x / TS), 1);
      var r = spawnRunner(x, gy - 20, -1);
      r.gate = idx;
      r.cult = (G.stage !== 1) && ((k % 3) === 1);   // ork stage is orks, full stop
      r.dir = fromLeft ? 1 : -1;
    }
    W.J('sfx', 'bossHit'); W.J('shake', 0.4);
  }

  // ---------- player bullets vs everything of ours ----------
  function bulletVsEnemies(W) {
    var bs = W.bullets;
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i]; if (!b.alive) continue;
      var owner = W.players[b.owner] || null, j;

      for (j = 0; j < st.runners.length; j++) {
        var e = st.runners[j]; if (!e.alive) continue;
        if (!circleRect(b.x, b.y, b.r, e.x, e.y, e.w, e.h)) continue;
        if (!bulletHitOnce(b, e.id)) continue;
        e.alive = false; W.score(100, owner);
        W.J('burst', e.x + e.w / 2, e.y + e.h / 2, RED, 12); W.J('sfx', 'enemyDie');
        if (b.kind !== 'l') break;
      }
      if (!b.alive) continue;

      for (j = 0; j < st.snipers.length; j++) {
        var s = st.snipers[j]; if (!s.alive) continue;
        if (!circleRect(b.x, b.y, b.r, s.x, s.y, s.w, s.h)) continue;
        if (!bulletHitOnce(b, s.id)) continue;
        s.alive = false; W.score(200, owner);
        W.J('burst', s.x + s.w / 2, s.y + s.h / 2, RED, 12); W.J('sfx', 'enemyDie');
        if (b.kind !== 'l') break;
      }
      if (!b.alive) continue;

      for (j = 0; j < st.turrets.length; j++) {
        var t = st.turrets[j]; if (!t.alive) continue;
        if (!circleRect(b.x, b.y, b.r, t.x - 7, t.y - 7, 14, 14)) continue;
        if (!t.open) {                       // shield: absorbs the shot, no damage
          if (b.kind !== 'l') { b.alive = false; W.J('burst', b.x, b.y, STEEL_HI, 3); }
          else if (!bulletHitOnce(b, t.id)) continue;
          W.J('sfx', 'turretHit');
          break;
        }
        if (!bulletHitOnce(b, t.id)) continue;
        t.hp -= bulletDmg(b.kind); t.flash = 0.1;
        W.J('sfx', 'turretHit'); W.J('burst', b.x, b.y, STEEL_HI, 4);
        if (t.hp <= 0) {
          t.alive = false; W.score(500, owner);
          W.J('burst', t.x, t.y, RED, 18); W.J('sfx', 'enemyDie'); W.J('shake', 0.3);
        }
        if (b.kind !== 'l') break;
      }
      if (!b.alive) continue;

      for (j = 0; j < st.capsules.length; j++) {
        var c = st.capsules[j]; if (c.state !== 1) continue;
        if (!circleRect(b.x, b.y, b.r, c.x - 7, c.y - 5, 14, 10)) continue;
        if (!bulletHitOnce(b, c.id)) continue;
        c.state = 2; W.score(100, owner);
        dropPickup(W, c.x, c.y);
        W.J('burst', c.x, c.y, WARM, 12); W.J('sfx', 'enemyDie');
        if (b.kind !== 'l') break;
      }
      if (!b.alive) continue;

      /* The warp portal. A live target like any other, and deliberately fat and
         low: it should be easy to HIT and expensive to CHOOSE. */
      var PT = st.portal;
      if (PT && PT.alive && circleRect(b.x, b.y, b.r, PT.x - 12, PT.y - 18, 24, 34) &&
          bulletHitOnce(b, PT.id)) {
        damagePortal(W, PT, bulletDmg(b.kind), owner);
        if (b.kind !== 'l') { b.alive = false; continue; }
      }
      if (!b.alive) continue;

      var B = st.boss;
      if (B && B.alive && B.engaged) {
        var hitAny = false;
        for (j = 0; B.ports && j < B.ports.length; j++) {
          var P = B.ports[j]; if (!P.alive) continue;
          if (!circleRect(b.x, b.y, b.r, P.x - 7, P.y - 7, 14, 14)) continue;
          if (!bulletHitOnce(b, P.id)) continue;
          P.hp -= bulletDmg(b.kind); P.flash = 0.1; hitAny = true;
          W.J('sfx', 'bossHit'); W.J('burst', b.x, b.y, STEEL_HI, 4);
          if (P.hp <= 0) {
            P.alive = false; W.score(1000, owner);
            W.J('burst', P.x, P.y, RED, 20); W.J('sfx', 'enemyDie'); W.J('shake', 0.4);
          }
          if (b.kind !== 'l') break;
        }
        if (!b.alive) continue;
        var wr = B.wr || 9;
        if (circleRect(b.x, b.y, b.r, B.cx - wr, B.cy - wr, wr * 2, wr * 2)) {
          if (!B.open) {
            if (b.kind !== 'l') { b.alive = false; W.J('burst', b.x, b.y, STEEL_HI, 3); W.J('sfx', 'turretHit'); }
            continue;
          }
          if (!bulletHitOnce(b, B.id)) continue;
          B.hp -= bulletDmg(b.kind); B.flash = 0.12;
          W.J('sfx', 'bossHit'); W.J('burst', b.x, b.y, WARM, 6);
          if (B.hp <= 0) {
            B.alive = false; B.hp = 0; W.levelDone = true; W.score(5000, owner);
            for (var q = 0; B.ports && q < B.ports.length; q++) B.ports[q].alive = false;
            for (q = 0; q < st.ebullets.length; q++) st.ebullets[q].alive = false;
            W.J('burst', B.cx, B.cy, WARM, 60); W.J('burst', B.cx, B.cy, RED, 40);
            W.J('sfx', 'bossDie'); W.J('shake', 1); W.J('hitstop', 6);
          }
        }
      }
    }
  }

  // ---------- grenades ----------
  // The core throws them (it owns p.bombs and the input byte); we own the arc,
  // the fuse and the blast, because everything a blast can touch lives in here.
  // Pooled like ebullets: dead slots reused in index order, no splice, so two
  // peers running the same inputs get the same grenade in the same slot.
  function throwGrenade(W, x, y, vx, vy, owner) {
    if (!st) return null;
    poolRoom(W);
    var gs = st.grenades, b = null;
    for (var i = 0; i < gs.length; i++) if (!gs[i].alive) { b = gs[i]; break; }
    if (!b) { b = {}; gs.push(b); }
    b.alive = true; b.x = x; b.y = y; b.vx = vx; b.vy = vy; b.ttl = 90; b.owner = owner;
    b.x1 = x; b.y1 = y; b.x2 = x; b.y2 = y; b.x3 = x; b.y3 = y;
    W.J('sfx', 'stomp');
    return b;
  }

  function within(x, y, ex, ey) {                     // centre-to-centre, blast radius
    var dx = ex - x, dy = ey - y;
    return dx * dx + dy * dy <= BLAST * BLAST;
  }

  // The portal takes damage like anything else, but killing it is a CHOICE: every
  // point spent here is a point not spent on the sorcerer. That is the whole fight.
  function damagePortal(W, P, n, owner) {
    if (!P || !P.alive) return;
    P.hp -= n; P.flash = 0.1;
    W.J('sfx', 'turretHit'); W.J('burst', P.x, P.y, WARP, 4);
    if (P.hp <= 0) {
      P.alive = false; P.left = 0; W.score(2000, owner);
      W.J('burst', P.x, P.y, WARP, 30); W.J('sfx', 'bossDie'); W.J('shake', 0.5);
    }
  }

  function damageBossCore(W, B, n, owner) {    B.hp -= n; B.flash = 0.12;
    W.J('sfx', 'bossHit');
    if (B.hp <= 0) {
      B.alive = false; B.hp = 0; W.levelDone = true; W.score(5000, owner);
      for (var q = 0; B.ports && q < B.ports.length; q++) B.ports[q].alive = false;
      for (q = 0; q < st.ebullets.length; q++) st.ebullets[q].alive = false;
      W.J('burst', B.cx, B.cy, WARM, 60); W.J('burst', B.cx, B.cy, RED, 40);
      W.J('sfx', 'bossDie'); W.J('shake', 1); W.J('hitstop', 6);
    }
  }

  function explode(W, x, y, ownerSlot) {
    var owner = W.players[ownerSlot] || null, i;

    W.J('sfx', 'bossDie');
    W.J('shake', 0.6);
    W.J('burst', x, y, BOOM_HI, 30);
    W.J('burst', x, y, BOOM, 26);
    W.J('burst', x, y, BOOM_LO, 14);
    if (W.flash) W.flash(0.75, BOOM_HI);

    for (i = 0; i < st.runners.length; i++) {
      var e = st.runners[i]; if (!e.alive) continue;
      if (!within(x, y, e.x + e.w / 2, e.y + e.h / 2)) continue;
      e.alive = false; W.score(100, owner);
      W.J('burst', e.x + e.w / 2, e.y + e.h / 2, RED, 12); W.J('sfx', 'enemyDie');
    }
    for (i = 0; i < st.snipers.length; i++) {
      var s = st.snipers[i]; if (!s.alive) continue;
      if (!within(x, y, s.x + s.w / 2, s.y + s.h / 2)) continue;
      s.alive = false; W.score(200, owner);
      W.J('burst', s.x + s.w / 2, s.y + s.h / 2, RED, 12); W.J('sfx', 'enemyDie');
    }
    // A turret's shield stops bullets, not a blast wave — that is what a bomb is for.
    for (i = 0; i < st.turrets.length; i++) {
      var t = st.turrets[i]; if (!t.alive) continue;
      if (!within(x, y, t.x, t.y)) continue;
      t.hp -= BLAST_DMG; t.flash = 0.1;
      if (t.hp <= 0) {
        t.alive = false; W.score(500, owner);
        W.J('burst', t.x, t.y, RED, 18); W.J('sfx', 'enemyDie');
      } else { W.J('sfx', 'turretHit'); }
    }
    for (i = 0; i < st.capsules.length; i++) {
      var c = st.capsules[i]; if (c.state !== 1) continue;
      if (!within(x, y, c.x, c.y)) continue;
      c.state = 2; W.score(100, owner);
      dropPickup(W, c.x, c.y);
      W.J('burst', c.x, c.y, WARM, 12); W.J('sfx', 'enemyDie');
    }
    // The core's own walkers. W.enemies is the live array, not a copy.
    var walkers = W.enemies;
    if (walkers) {
      for (i = 0; i < walkers.length; i++) {
        var wk = walkers[i]; if (!wk.alive) continue;
        if (!within(x, y, wk.x + wk.w / 2, wk.y + wk.h / 2)) continue;
        wk.alive = false; W.score(200, owner);
        W.J('burst', wk.x + wk.w / 2, wk.y + wk.h / 2, '#63C08A', 14); W.J('sfx', 'enemyDie');
      }
    }
    var B = st.boss;
    if (B && B.alive && B.engaged) {
      for (i = 0; B.ports && i < B.ports.length; i++) {
        var P = B.ports[i]; if (!P.alive) continue;
        if (!within(x, y, P.x, P.y)) continue;
        P.hp -= BLAST_DMG; P.flash = 0.1;
        W.J('sfx', 'bossHit');
        if (P.hp <= 0) {
          P.alive = false; W.score(1000, owner);
          W.J('burst', P.x, P.y, RED, 20); W.J('sfx', 'enemyDie');
        }
      }
      // The shell only takes damage while it is open — same rule the bullets obey.
      if (B.alive && B.open && within(x, y, B.cx, B.cy)) damageBossCore(W, B, BLAST_DMG, owner);
      /* and the portal, which a bomb is a perfectly good answer to */
      if (st.portal && st.portal.alive && within(x, y, st.portal.x, st.portal.y)) {
        damagePortal(W, st.portal, BLAST_DMG, owner);
      }
    }
  }

  function stepGrenades(W, DT) {
    var gs = st.grenades;
    for (var i = 0; i < gs.length; i++) {
      var b = gs[i]; if (!b.alive) continue;
      b.x3 = b.x2; b.y3 = b.y2; b.x2 = b.x1; b.y2 = b.y1; b.x1 = b.x; b.y1 = b.y;
      b.vy += G_GREN * DT;
      if (b.vy > TERM) b.vy = TERM;
      b.x += b.vx * DT; b.y += b.vy * DT;
      b.ttl--;

      var out = (b.y > W.MAP_H * TS + 40 || b.x < -40 || b.x > W.MAP_W * TS + 40);
      if (out) { b.alive = false; continue; }        // gone down a pit: no free blast

      var hit = b.ttl <= 0 || W.solidAt(Math.floor(b.x / TS), Math.floor(b.y / TS));
      if (!hit) {                                     // contact with anything alive
        var j;
        for (j = 0; j < st.runners.length && !hit; j++) {
          var e = st.runners[j];
          if (e.alive && circleRect(b.x, b.y, 3, e.x, e.y, e.w, e.h)) hit = true;
        }
        for (j = 0; j < st.snipers.length && !hit; j++) {
          var s = st.snipers[j];
          if (s.alive && circleRect(b.x, b.y, 3, s.x, s.y, s.w, s.h)) hit = true;
        }
        var walkers = W.enemies;
        for (j = 0; walkers && j < walkers.length && !hit; j++) {
          var wk = walkers[j];
          if (wk.alive && circleRect(b.x, b.y, 3, wk.x, wk.y, wk.w, wk.h)) hit = true;
        }
      }
      if (hit) { b.alive = false; explode(W, b.x, b.y, b.owner); }
    }
  }

  // ---------- build ----------
  function build(W) {
    st = fresh();
    var tiles = W.tiles;
    for (var y = 0; y < W.MAP_H; y++) {
      for (var x = 0; x < W.MAP_W; x++) {
        var ch = tiles[y][x];
        if (ch !== 'r' && ch !== 's' && ch !== 't' && ch !== 'S' && ch !== 'W' && ch !== 'B') continue;
        tiles[y][x] = '.';
        var px = x * TS, py = y * TS;
        if (ch === 'r') {
          spawnRunner(px + 3, py + TS - 14, -1);
        } else if (ch === 's') {
          var fy = floorBelow(W, x, y);
          st.snipers.push({ id: nextId++, alive: true, x: px + 3, y: fy - 14, w: 10, h: 14, face: -1, cd: 0.9 + W.rng() * 0.7, t: 0, flash: 0 });
        } else if (ch === 't') {
          var side = W.solidAt(x + 1, y) ? 1 : W.solidAt(x - 1, y) ? -1 : 0;   // which side the wall is on
          var vert = W.solidAt(x, y - 1) ? -1 : W.solidAt(x, y + 1) ? 1 : 0;
          st.turrets.push({ id: nextId++, alive: true, x: px + TS / 2, y: py + TS / 2, hp: 3, open: false,
            cd: 0.6 + W.rng() * 0.6, gap: 0, shots: 0, aim: 4, t: 0, flash: 0, side: side, vert: vert });
        } else if (ch === 'S') {
          st.spawners.push({ x: px + TS / 2, y: py + TS - 14, cd: 0.3 + W.rng() * 0.5 });
        } else if (ch === 'W') {
          st.capsules.push({ id: nextId++, state: 0, ax: px + TS / 2, ay: py + TS / 2, x: 0, y: 0, vx: 0, t: 0, alive: false });
        } else if (ch === 'B') {
          st.boss = makeBoss(W, x, y, px);
        }
      }
    }
    buildGates(W);
    W.levelDone = false;
  }

  // The core owns the level table, so the core says which boss this level fights;
  // CONTRA owns what each of them does. Demanded, never defaulted: a missing kind
  // would silently hand every stage the same Dreadnought back, which is the exact
  // bug this whole pass exists to kill.
  function makeBoss(W, x, y, px) {
    var kind = W.bossKind;
    if (kind !== 0 && kind !== 1 && kind !== 2 && kind !== 3) {
      throw new Error('CONTRA.build: W.bossKind must be 0..3, got ' + kind +
                      ' — the core has to name which boss this level fights');
    }
    var face = W.solidAt(x + 1, y) || W.solidAt(x + 2, y) ? -1 : 1;   // away from the wall behind
    var base = floorBelow(W, x, y);
    var cx = px + TS / 2;
    var hp = BOSS_HP[kind];
    var B = { id: nextId++, kind: kind, alive: true, engaged: false,
      x: cx, cx: cx, cy: base - 46, base: base, face: face,
      hp: hp, hpMax: hp, open: false, openK: 0, t: 0, modeT: 0, mode: 0, flash: 0,
      aL: cx - 200, aR: cx + 40, alpha: 1, ports: null };
    if (kind === K_DREAD) {
      B.ports = [
        { id: nextId++, alive: true, hp: 6, x: cx + face * 22, y: base - 12, cd: 1.0, burst: 0, flash: 0 },
        { id: nextId++, alive: true, hp: 6, x: cx + face * 24, y: base - 80, cd: 1.7, burst: 0, flash: 0 },
        { id: nextId++, alive: true, hp: 6, x: cx - face * 2, y: base - 104, cd: 2.4, burst: 0, flash: 0 }
      ];
    } else if (kind === K_WARBOSS) {
      B.throwCd = 0; B.cy = base - 84; B.wr = 14;
    } else if (kind === K_TAU) {
      B.shots = 0; B.fireCd = 0; B.next = 0; B.hoverT = 0;
      B.shieldAt = hp - Math.ceil(hp * TAU_STEP);
      B.cy = base - 60; B.tx = cx; B.ty = base - 60; B.wr = 16;   /* arena() re-homes it on engage */
    } else {
      B.boltX = cx; B.boltY = base; B.boltT = 0; B.boltLock = 0; B.struck = 0;
      B.portalCd = SORC_PORTAL_CD * 0.5;      // the first portal comes early, not at 30s
      B.cy = base - 70; B.wr = 14;
    }
    return B;
  }

  // Gate columns are GLOBAL — the same count the parallax stages are cut on — so
  // the core hands over where this level starts in that count and only the gates
  // that land inside it are armed.
  function buildGates(W) {
    var off = W.colOffset;
    if (typeof off !== 'number') {
      throw new Error('CONTRA.build: W.colOffset must be this level\'s first global column');
    }
    for (var i = 0; i < GATE_COLS.length; i++) {
      var local = GATE_COLS[i] - off;
      if (local < 4 || local > W.MAP_W - 6) continue;      // not in this level
      /* no y: the wave spawns at the screen edges and each runner takes the floor
         under its own column, so the gate's own floor height is nobody's business */
      st.gates.push({ col: local, x: local * TS,
        stage: Math.floor(GATE_COLS[i] / 200), state: 0, t: 0, n: 0 });
    }
  }

  // ---------- step ----------
  function step(W, DT) {
    if (!st) return;
    curW = W;
    stepGates(W, DT);
    stepSpawners(W, DT);
    stepRunners(W, DT);
    stepSnipers(W, DT);
    stepTurrets(W, DT);
    stepCapsules(W, DT);
    stepBoss(W, DT);
    stepGrenades(W, DT);
    stepBullets(W, DT);
    steerMissiles(W, DT);
    steerEnemyMissiles(W, DT);
    stepDrones(W, DT);
    stepHawk(W, DT);
    stepFlames(W, DT);
    stepBeacons(W, DT);
    bulletVsEnemies(W);
    curW = null;
  }

  // ---------- draw ----------
  function rrect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function diamond(g, x, y, r) {
    g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
  }

  function draw(g, cx, cy, lights, W) {
    if (!st) return;
    var VW = W.VW, VH = W.VH, tc = W.tclock || 0, i;
    // SPRITES is a page global from the core; absent under node (test_contra.js) and
    // false until every sheet decoded — either way the canvas paths below still draw.
    var SP = (typeof SPRITES !== 'undefined' && SPRITES.loaded) ? SPRITES : null;
    function blit(img, sx, w, h, x, y, flipX, rot, alpha) {
      // draw frame `sx` of a horizontal strip with its CENTRE at (x, y)
      g.save(); g.imageSmoothingEnabled = false;
      g.translate(x, y);
      if (rot) g.rotate(rot);
      if (flipX) g.scale(-1, 1);
      if (alpha !== undefined) g.globalAlpha = alpha;
      g.drawImage(img, sx * w, 0, w, h, -w / 2, -h / 2, w, h);
      g.restore();
    }

    // runners: Ork boy — art faces left, so flip when running right
    for (i = 0; i < st.runners.length; i++) {
      var e = st.runners[i]; if (!e.alive) continue;
      var ex = e.x - cx, ey = e.y - cy;
      if (ex < -30 || ex > VW + 30) continue;
      var bob = e.onGround ? Math.abs(Math.sin(e.t * 18)) * 1.5 : 0;
      if (SP) {
        /* a gate wave and the sorcerer's portal both field cultists — the sheet
           has been sitting in the build unused since the cast was drawn. One pose,
           no walk cycle, so they read as a different body at a glance. */
        if (e.cult && SP.cultist) {
          blit(SP.cultist, 0, 24, 24, ex + e.w / 2, ey + e.h - 12 + bob * 0.5, e.dir > 0, 0);
          lights.push([ex + e.w / 2, ey + e.h / 2, 22, WARP, 0.25]);
          continue;
        }
        // walk sheet: 4-frame charge cycle, one frame every 6 ticks. Its art faces
        // RIGHT (the old single-pose runner faces left), so the flip is inverted.
        if (SP.runnerWalk && e.onGround) {
          blit(SP.runnerWalk, Math.floor((W.tick || 0) / 6) % 4, 24, 24,
               ex + e.w / 2, ey + e.h - 12 + bob * 0.5, e.dir < 0, 0);
        } else {
          blit(SP.runner, 0, 24, 24, ex + e.w / 2, ey + e.h - 12 + bob * 0.5, e.dir > 0, 0);
        }
        lights.push([ex + e.w / 2, ey + e.h / 2, 22, RED, 0.22]);
        continue;
      }
      var lean = e.dir * 2;
      var rg = g.createLinearGradient(0, ey, 0, ey + e.h);
      rg.addColorStop(0, RED); rg.addColorStop(1, RED_LO);
      g.fillStyle = rg;
      rrect(g, ex + lean * 0.5, ey + bob, e.w, e.h - bob, 3); g.fill();
      g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(ex + 1, ey + bob, e.w - 2, 1);
      g.fillStyle = HOT; g.fillRect(ex + (e.dir > 0 ? 6 : 2), ey + bob + 4, 2.2, 2.2);
      // little rifle line
      g.strokeStyle = HOT; g.globalAlpha = 0.7; g.lineWidth = 1;
      g.beginPath(); g.moveTo(ex + e.w / 2, ey + 8); g.lineTo(ex + e.w / 2 + e.dir * 8, ey + 8); g.stroke();
      g.globalAlpha = 1;
      lights.push([ex + e.w / 2, ey + e.h / 2, 22, RED, 0.22]);
    }

    // snipers: Tau fire warrior — art faces right
    for (i = 0; i < st.snipers.length; i++) {
      var s = st.snipers[i]; if (!s.alive) continue;
      var sx = s.x - cx + s.w / 2, sy = s.y - cy;
      if (sx < -30 || sx > VW + 30) continue;
      if (SP) {
        // aim sheet: 0 = rifle straight up, 1 = diag-up, 2 = level. Purely a look —
        // the shot itself is already aimed at the player by stepSnipers. Picked off
        // the ANGLE to the player, not the height gap: a player three tiles up but
        // twelve tiles away is nearly level, and a raw height test would read that
        // as a steep shot. Anything at or below the Tau reads level; snipers perch,
        // so that is the common case and the sheet has no down pose.
        if (SP.sniperAim) {
          var tgt = nearestPlayer(W, s.x + s.w / 2, s.y + 4);
          var af = 2;
          if (tgt) {
            var up = (s.y + s.h / 2) - (tgt.y + tgt.h / 2);
            var across = Math.abs((tgt.x + tgt.w / 2) - (s.x + s.w / 2));
            var a = Math.atan2(Math.max(0, up), across);
            af = a > 1.05 ? 0 : (a > 0.35 ? 1 : 2);   // >60deg / >20deg / level
          }
          blit(SP.sniperAim, af, 32, 32, sx, sy + s.h - 16, s.face < 0, 0);
        } else {
          blit(SP.sniper, 0, 24, 24, sx, sy + s.h - 12, s.face < 0, 0);
        }
      } else {
      g.fillStyle = RED_LO; g.fillRect(sx - 2, sy + 8, 4, 6);
      g.fillStyle = RED; diamond(g, sx, sy + 5, 5.5); g.fill();
      g.fillStyle = HOT; g.fillRect(sx + s.face * 1.5 - 1, sy + 4, 2, 2);
      }
      if (s.flash > 0) {
        g.strokeStyle = HOT; g.globalAlpha = s.flash / 0.12; g.lineWidth = 1;
        g.beginPath(); g.moveTo(sx, sy + 5); g.lineTo(sx + s.face * 14, sy + 5); g.stroke();
        g.globalAlpha = 1;
        lights.push([sx + s.face * 8, sy + 5, 26, HOT, 0.5]);
      }
      lights.push([sx, sy + 5, 20, RED, 0.2]);
    }

    // turrets: Chaos gun-box on a wall bracket; art has the bracket on the LEFT
    for (i = 0; i < st.turrets.length; i++) {
      var t = st.turrets[i]; if (!t.alive) continue;
      var tx = t.x - cx, ty = t.y - cy;
      if (tx < -30 || tx > VW + 30) continue;
      var open = t.open ? 1 : 0;
      if (SP) {
        // side>0 = wall to the right → flip; vert>0 = wall below → bracket points down
        var rot = t.vert ? (t.vert > 0 ? -Math.PI / 2 : Math.PI / 2) : 0;
        blit(SP.turret, open, 24, 24, tx, ty, !!(t.side > 0), rot);
        if (t.flash > 0) { g.fillStyle = '#FFFFFF'; g.globalAlpha = 0.5; g.beginPath(); g.arc(tx, ty, 8, 0, 6.283); g.fill(); g.globalAlpha = 1; }
        if (open) {
          var d2 = DIR8[t.aim], n2 = Math.sqrt(d2[0] * d2[0] + d2[1] * d2[1]);
          g.strokeStyle = t.flash > 0 ? HOT : RED; g.lineWidth = 2; g.globalAlpha = 0.8;
          g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx + d2[0] / n2 * 10, ty + d2[1] / n2 * 10); g.stroke();
          g.globalAlpha = 1;
          lights.push([tx, ty, 26, RED, 0.35]);
        } else lights.push([tx, ty, 14, STEEL_HI, 0.15]);
        continue;
      }
      // mount bar toward the wall
      g.fillStyle = '#2B3159';
      if (t.side) g.fillRect(t.side > 0 ? tx : tx - 8, ty - 3, 8, 6);
      else if (t.vert) g.fillRect(tx - 3, t.vert > 0 ? ty : ty - 8, 6, 8);
      g.fillStyle = t.flash > 0 ? STEEL_HI : STEEL;
      g.beginPath(); g.arc(tx, ty, 7, 0, 6.283); g.fill();
      g.strokeStyle = STEEL_HI; g.lineWidth = 1.2; g.globalAlpha = 0.8;
      g.beginPath(); g.arc(tx, ty, 6, 0, 6.283); g.stroke(); g.globalAlpha = 1;
      if (open) {
        var d = DIR8[t.aim], n = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
        g.fillStyle = RED; g.beginPath(); g.arc(tx, ty, 3.2, 0, 6.283); g.fill();
        g.strokeStyle = t.flash > 0 ? HOT : RED; g.lineWidth = 2;
        g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx + d[0] / n * 9, ty + d[1] / n * 9); g.stroke();
        lights.push([tx, ty, 26, RED, 0.35]);
      } else {
        // closed iris: two steel shutters
        g.fillStyle = '#1B2040';
        g.fillRect(tx - 3, ty - 1, 6, 2);
        lights.push([tx, ty, 14, STEEL_HI, 0.15]);
      }
    }

    // capsule: winged pod with a warm core
    for (i = 0; i < st.capsules.length; i++) {
      var c = st.capsules[i]; if (c.state !== 1) continue;
      var kx = c.x - cx, ky = c.y - cy;
      if (kx < -30 || kx > VW + 30) continue;
      var pulse = 0.5 + 0.5 * Math.sin(tc * 6);
      if (SP) {
        blit(SP.capsule, 0, 16, 16, kx, ky, c.vx < 0, 0);
      } else {
      g.fillStyle = STEEL; rrect(g, kx - 8, ky - 4, 16, 8, 4); g.fill();
      g.fillStyle = STEEL_HI; g.globalAlpha = 0.6; g.fillRect(kx - 12, ky - 1, 24, 1.5); g.globalAlpha = 1;
      g.fillStyle = WARM; g.beginPath(); g.arc(kx, ky, 2.6 + pulse * 0.6, 0, 6.283); g.fill();
      }
      lights.push([kx, ky, 30 + pulse * 8, WARM, 0.4]);
    }
    // pickups: letter-in-a-diamond, S or L
    for (i = 0; i < st.pickups.length; i++) {
      var k = st.pickups[i]; if (!k.alive) continue;
      var px = k.x - cx, py = k.y - cy - (k.grounded ? Math.abs(Math.sin(tc * 3)) * 2 : 0);
      if (px < -30 || px > VW + 30) continue;
      var pc = pickColor(k.kind);
      if (SP && (k.kind === 'l' || k.kind === 'b' || k.kind === 's')) {
        blit(k.kind === 'l' ? SP.pickL : (k.kind === 'b' ? SP.pickB : SP.pickS), 0, 16, 16, px, py, false, 0);
      } else {
      // H / D / T have no sheet: the diamond-and-letter, in their own colour
      g.fillStyle = pc;
      diamond(g, px, py, 7); g.fill();
      g.fillStyle = '#171C33'; g.font = 'bold 7px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(k.kind.toUpperCase(), px, py + 0.5);
      }
      lights.push([px, py, 28, pc, 0.35]);
    }

    // boss: one draw per stage. The Dreadnought keeps the bulkhead-and-iris it
    // always had; the other three are their own shape below, because a thing that
    // charges, flies or blinks cannot be drawn as a hole in a wall.
    var B = st.boss;
    if (B && (B.alive || B.flash > 0)) {
      var bx = B.cx - cx, by = B.cy - cy, f = B.face;
      if (bx > -140 && bx < VW + 140) {
        var baseY = B.base - cy;
        if (B.kind !== K_DREAD) {
          drawBossKind(g, B, bx, by, baseY, cx, cy, lights, SP, blit, tc);
        } else {
        if (SP) {
          // Chaos Dreadnought, feet on the floor. Art's gun is on screen-left; flip so
          // it points the way the boss faces. Ports + core stay drawn on top: targets.
          blit(SP.boss, 0, 128, 128, bx, baseY - 64, f > 0, 0, B.alive ? 1 : 0.6);
          if (B.flash > 0) { g.fillStyle = '#FFFFFF'; g.globalAlpha = 0.35; g.fillRect(bx - 48, baseY - 120, 96, 120); g.globalAlpha = 1; }
        } else {
        // bulkhead slab from floor up, against the wall behind
        var hg = g.createLinearGradient(0, baseY - 128, 0, baseY);
        hg.addColorStop(0, '#333B63'); hg.addColorStop(1, '#191F38');
        g.fillStyle = hg;
        rrect(g, f < 0 ? bx - 14 : bx - 34, baseY - 128, 48, 128, 6); g.fill();
        g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(f < 0 ? bx - 14 : bx - 34, baseY - 128, 48, 1);
        // rib lines
        g.strokeStyle = STEEL; g.globalAlpha = 0.5; g.lineWidth = 1;
        for (var r = 1; r < 6; r++) { g.beginPath(); g.moveTo(bx - 34, baseY - r * 21); g.lineTo(bx + 34, baseY - r * 21); g.stroke(); }
        g.globalAlpha = 1;
        }
        // ports
        for (i = 0; i < 3; i++) {
          var P = B.ports[i], ppx = P.x - cx, ppy = P.y - cy;
          if (!P.alive) {
            g.fillStyle = '#171C33'; g.beginPath(); g.arc(ppx, ppy, 6, 0, 6.283); g.fill();
            continue;
          }
          g.fillStyle = P.flash > 0 ? STEEL_HI : STEEL; g.beginPath(); g.arc(ppx, ppy, 7, 0, 6.283); g.fill();
          g.strokeStyle = STEEL_HI; g.globalAlpha = 0.7; g.beginPath(); g.arc(ppx, ppy, 5.5, 0, 6.283); g.stroke(); g.globalAlpha = 1;
          g.fillStyle = P.flash > 0 ? HOT : RED; g.beginPath(); g.arc(ppx + f * 2, ppy, 2.4, 0, 6.283); g.fill();
          lights.push([ppx, ppy, 18, RED, P.flash > 0 ? 0.5 : 0.2]);
        }
        // core: iris ring + eye
        var beat = 0.5 + 0.5 * Math.sin(tc * (B.open ? 9 : 3));
        g.fillStyle = '#1B2040'; g.beginPath(); g.arc(bx, by, 13, 0, 6.283); g.fill();
        g.strokeStyle = STEEL_HI; g.lineWidth = 1.5; g.beginPath(); g.arc(bx, by, 12, 0, 6.283); g.stroke();
        if (B.alive) {
          var ir = 2 + B.openK * 7;                                   // iris aperture
          g.fillStyle = B.flash > 0 ? '#FFFFFF' : WARM;
          g.beginPath(); g.arc(bx, by, ir + beat * 0.8, 0, 6.283); g.fill();
          if (B.open) { g.fillStyle = '#FFFFFF'; g.globalAlpha = 0.85; g.beginPath(); g.arc(bx - 2, by - 2, 2, 0, 6.283); g.fill(); g.globalAlpha = 1; }
          // shutter plates while closed
          if (!B.open) {
            g.fillStyle = STEEL; g.fillRect(bx - 10, by - 1.5, 20, 3);
          }
          lights.push([bx, by, B.open ? 70 + beat * 12 : 30, WARM, B.open ? 0.6 : 0.25]);
        }
        }
      }
    }

    drawPortal(g, cx, cy, lights, SP, blit, tc);
    drawBeacons(g, cx, cy, lights, tc);
    drawFlames(g, cx, cy, lights, W, tc);

    // servo-skulls: bob on a sine, bank frame while the player turns, firing
    // frame held 200ms after a shot, the laser itself a 1px red line for 100ms
    for (i = 0; i < st.drones.length; i++) {
      var d = st.drones[i]; if (!d || !d.alive) continue;
      var dx = d.x - cx, dy = d.y - cy + Math.sin(d.t * 3) * 2;
      if (dx < -30 || dx > VW + 30) continue;
      var fr = d.fireT > 0 ? 1 : (d.bankT > 0 ? (d.face > 0 ? 3 : 2) : 0);
      if (SP && SP.skull) {
        blit(SP.skull, fr, 24, 24, dx, dy, d.face < 0, 0);
      } else {
        g.fillStyle = BONE; g.beginPath(); g.arc(dx, dy - 2, 5, 0, 6.283); g.fill();
        g.fillStyle = RED; g.fillRect(dx + d.face * 1 - 1, dy - 3, 2, 2);
        g.strokeStyle = '#3A3A3A'; g.lineWidth = 1; g.beginPath(); g.moveTo(dx, dy + 3); g.lineTo(dx - 1, dy + 9); g.stroke();
      }
      if (d.laserT > 0) {
        g.strokeStyle = '#ff0000'; g.lineWidth = 1; g.globalAlpha = 0.9;
        g.beginPath(); g.moveTo(dx + d.face * 3, dy - 2); g.lineTo(d.lx - cx, d.ly - cy); g.stroke();
        g.globalAlpha = 1;
        lights.push([d.lx - cx, d.ly - cy, 22, RED, 0.5]);
      }
      lights.push([dx, dy, 18, RED, d.fireT > 0 ? 0.5 : 0.25]);
    }

    // Thunderhawk: the art faces right, the run goes left — flipped
    var H = st.hawk;
    if (H && H.on) {
      var hx = H.x - cx, hy = H.y - cy;
      if (SP && SP.hawk) {
        blit(SP.hawk, 0, 128, 128, hx, hy, true, 0);
      } else {
        g.fillStyle = '#333B63'; g.fillRect(hx - 40, hy - 10, 80, 20);
        g.fillStyle = GOLD; g.fillRect(hx - 40, hy - 2, 80, 2);
        g.fillStyle = BOOM; g.fillRect(hx + 40, hy - 6, 14, 12);
      }
      lights.push([hx + 48, hy, 40, BOOM, 0.7]);
      lights.push([hx, hy, 60, GOLD, 0.3]);
    }

    // enemy bullets: hot mote with a 3-point trail
    for (i = 0; i < st.ebullets.length; i++) {
      var b = st.ebullets[i]; if (!b.alive) continue;
      var mx = b.x - cx, my = b.y - cy;
      if (mx < -10 || mx > VW + 10 || my < -10 || my > VH + 10) continue;
      g.fillStyle = RED;
      g.globalAlpha = 0.18; g.fillRect(b.x3 - cx - 1, b.y3 - cy - 1, 2, 2);
      g.globalAlpha = 0.36; g.fillRect(b.x2 - cx - 1, b.y2 - cy - 1, 2, 2);
      g.globalAlpha = 0.6; g.fillRect(b.x1 - cx - 1.5, b.y1 - cy - 1.5, 3, 3);
      g.globalAlpha = 1;
      g.fillStyle = HOT; g.beginPath(); g.arc(mx, my, 2, 0, 6.283); g.fill();
      lights.push([mx, my, 14, RED, 0.45]);
    }

    drawGrenades(g, cx, cy, lights);
  }

  // ---------- the three new bosses, drawn ----------
  // Each one is a 128px three-frame sheet plus the marks the FIGHT needs on top:
  // a weak point you can see is open, a shield you can see is up, a telegraph you
  // can read in time. The canvas fallbacks are deliberately crude but carry the
  // same information, so a build with no sprites is still playable.
  function bossFrame(B) {
    if (B.kind === K_WARBOSS) return B.mode;                 // idle / charge / stunned
    if (B.kind === K_TAU) return B.mode === 3 ? 1 : (B.mode === 1 ? 2 : 0);
    return st.portal && st.portal.alive ? 2 : (B.mode === 1 ? 1 : 0);
  }
  function drawBossKind(g, B, bx, by, baseY, cx, cy, lights, SP, blit, tc) {
    var fr = bossFrame(B), al = (B.alpha === undefined ? 1 : B.alpha) * (B.alive ? 1 : 0.6);
    var midY = B.kind === K_WARBOSS ? baseY - 64 : by;
    var sheet = B.kind === K_WARBOSS ? (SP && SP.bossWarboss)
              : B.kind === K_TAU ? (SP && SP.bossTau) : (SP && SP.bossSorcerer);
    if (sheet) {
      /* every one of these sheets is drawn facing right; flip when he faces left */
      blit(sheet, fr, 128, 128, bx, midY, B.face < 0, 0, al);
    } else {
      g.globalAlpha = al;
      g.fillStyle = B.kind === K_WARBOSS ? ORK : (B.kind === K_TAU ? TAU_BLUE : WARP_LO);
      rrect(g, bx - 22, midY - 40, 44, 80, 6); g.fill();
      g.globalAlpha = 1;
    }
    if (B.flash > 0) {
      g.fillStyle = '#FFFFFF'; g.globalAlpha = 0.32;
      g.fillRect(bx - 40, midY - 56, 80, 112); g.globalAlpha = 1;
    }

    if (B.kind === K_WARBOSS) {
      /* the head. Open only in the stun, and it has to LOOK open — a ring you can
         see from across the arena, because the window is three seconds long. */
      var hx = bx, hy = B.cy - cy;
      if (B.open) {
        var beat = 0.5 + 0.5 * Math.sin(tc * 10);
        g.strokeStyle = HOT; g.lineWidth = 2; g.globalAlpha = 0.55 + beat * 0.45;
        g.beginPath(); g.arc(hx, hy, 11 + beat * 2, 0, 6.283); g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = RED; g.beginPath(); g.arc(hx, hy, 3.4, 0, 6.283); g.fill();
        lights.push([hx, hy, 54, RED, 0.55]);
        /* stun stars, so "he is down" reads without reading the health bar */
        for (var k = 0; k < 3; k++) {
          var a = tc * 4 + k * 2.09;
          g.fillStyle = WARM; g.globalAlpha = 0.85;
          g.fillRect(hx + Math.cos(a) * 15 - 1, hy - 16 + Math.sin(a) * 5 - 1, 2.4, 2.4);
        }
        g.globalAlpha = 1;
      } else if (B.mode === 1) {
        /* charge: speed lines off the back, so the rush reads before it lands */
        g.strokeStyle = ORK; g.globalAlpha = 0.5; g.lineWidth = 1;
        for (var q = 0; q < 4; q++) {
          var ly = baseY - 20 - q * 16;
          g.beginPath(); g.moveTo(bx - B.face * 24, ly); g.lineTo(bx - B.face * (44 + q * 6), ly); g.stroke();
        }
        g.globalAlpha = 1;
        lights.push([bx, baseY - 40, 60, ORK, 0.3]);
      }
    } else if (B.kind === K_TAU) {
      if (B.mode === 3) {
        /* shield bubble: nothing gets through, and it must be obvious it does not */
        var sb = 0.5 + 0.5 * Math.sin(tc * 5);
        g.strokeStyle = TAU_BLUE; g.lineWidth = 2; g.globalAlpha = 0.7 + sb * 0.3;
        g.beginPath(); g.arc(bx, midY, 44 + sb * 3, 0, 6.283); g.stroke();
        g.fillStyle = TAU_BLUE; g.globalAlpha = 0.10 + sb * 0.07;
        g.beginPath(); g.arc(bx, midY, 44, 0, 6.283); g.fill();
        g.globalAlpha = 1;
        lights.push([bx, midY, 90, TAU_BLUE, 0.5]);
      } else {
        /* jet wash under the thrusters — the only cue that it is HOLDING altitude */
        for (var t2 = -1; t2 <= 1; t2 += 2) {
          var jf = 6 + Math.abs(Math.sin(tc * 18 + t2)) * 5;
          g.fillStyle = TAU_BLUE; g.globalAlpha = 0.5;
          g.beginPath(); g.moveTo(bx + t2 * 11 - 3, midY + 26); g.lineTo(bx + t2 * 11 + 3, midY + 26);
          g.lineTo(bx + t2 * 11, midY + 26 + jf); g.closePath(); g.fill();
        }
        g.globalAlpha = 1;
        lights.push([bx, midY + 30, 40, TAU_BLUE, 0.4]);
      }
    } else {
      /* the sorcerer's telegraph: a thin line to where you WERE, thickening as the
         two seconds run out. It is the whole tell — draw it so it cannot be missed. */
      if (B.mode === 0 && B.boltLock && !B.struck) {
        var k2 = Math.min(1, B.modeT / SORC_TELE);
        g.strokeStyle = WARP; g.globalAlpha = 0.25 + k2 * 0.6; g.lineWidth = 1 + k2 * 2.5;
        g.beginPath(); g.moveTo(bx, by); g.lineTo(B.boltX - cx, B.boltY - cy); g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = WARP; g.globalAlpha = 0.4 + k2 * 0.6;
        g.beginPath(); g.arc(B.boltX - cx, B.boltY - cy, 3 + k2 * 5, 0, 6.283); g.fill();
        g.globalAlpha = 1;
        lights.push([B.boltX - cx, B.boltY - cy, 30 + k2 * 30, WARP, 0.3 + k2 * 0.4]);
      }
      if (B.boltT > 0) {                       // the strike itself, two frames of it
        g.strokeStyle = '#FFFFFF'; g.lineWidth = 4; g.globalAlpha = 0.9;
        g.beginPath(); g.moveTo(bx, by); g.lineTo(B.boltX - cx, B.boltY - cy); g.stroke();
        g.strokeStyle = WARP; g.lineWidth = 8; g.globalAlpha = 0.45;
        g.beginPath(); g.moveTo(bx, by); g.lineTo(B.boltX - cx, B.boltY - cy); g.stroke();
        g.globalAlpha = 1;
        lights.push([B.boltX - cx, B.boltY - cy, 90, WARP, 0.8]);
      }
      lights.push([bx, by, 50, WARP, B.open ? 0.45 : 0.2]);
    }
    /* the health-bar ring every one of them shares: a thin arc round the weak
       point, full when open. The HUD says how much is left; this says WHERE. */
    if (B.alive && B.open) {
      var wp = 0.5 + 0.5 * Math.sin(tc * 8);
      g.strokeStyle = HOT; g.globalAlpha = 0.3 + wp * 0.3; g.lineWidth = 1;
      g.beginPath(); g.arc(bx, by, 15, 0, 6.283); g.stroke();
      g.globalAlpha = 1;
    }
  }

  // The warp portal: a spiral that keeps paying out cultists, with its own little
  // health bar — the player has to be able to judge "can I afford to close it".
  function drawPortal(g, cx, cy, lights, SP, blit, tc) {
    var P = st.portal; if (!P || !P.alive) return;
    var px = P.x - cx, py = P.y - cy;
    var spin = tc * 3, pulse = 0.5 + 0.5 * Math.sin(tc * 6);
    for (var r = 3; r >= 1; r--) {
      g.strokeStyle = r === 1 ? '#FFFFFF' : WARP;
      g.globalAlpha = 0.25 + pulse * 0.35;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(px, py, r * 6 + pulse * 2, spin + r, spin + r + 4.2);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.fillStyle = '#120A1E'; g.beginPath(); g.arc(px, py, 5, 0, 6.283); g.fill();
    var w = 22, k = Math.max(0, P.hp / P.hpMax);
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(px - w / 2 - 1, py - 26, w + 2, 4);
    g.fillStyle = P.flash > 0 ? '#FFFFFF' : WARP; g.fillRect(px - w / 2, py - 25, w * k, 2);
    lights.push([px, py, 60 + pulse * 14, WARP, 0.55]);
  }

  // The revive beacon: a gold Aquila ring where a teammate fell, its progress bar
  // filling only while somebody is standing in it. The ring shrinks with the
  // fifteen-second clock, so "hurry" is visible from off-screen.
  function drawBeacons(g, cx, cy, lights, tc) {
    for (var i = 0; i < st.beacons.length; i++) {
      var b = st.beacons[i]; if (!b.alive) continue;
      var x = b.x - cx, y = b.y - cy;
      var pulse = 0.5 + 0.5 * Math.sin(tc * (b.helpers ? 12 : 5));
      var life = b.t / BEACON_LIFE;
      g.strokeStyle = GOLD; g.globalAlpha = 0.35 + pulse * 0.45; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, BEACON_R * (0.45 + life * 0.55), 0, 6.283); g.stroke();
      g.globalAlpha = 0.9;
      g.beginPath(); g.arc(x, y, 4 + pulse * 1.5, 0, 6.283); g.stroke();
      g.globalAlpha = 1;
      /* the Aquila, in two strokes: a downward wedge with wings */
      g.fillStyle = GOLD;
      g.beginPath(); g.moveTo(x, y + 4); g.lineTo(x - 5, y - 2); g.lineTo(x + 5, y - 2); g.closePath(); g.fill();
      var w = 26, k = Math.min(1, b.prog / BEACON_HOLD);
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x - w / 2 - 1, y - 20, w + 2, 5);
      g.fillStyle = b.helpers ? '#FFF0C4' : GOLD; g.fillRect(x - w / 2, y - 19, w * k, 3);
      g.font = 'bold 6px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = GOLD; g.globalAlpha = 0.85;
      g.fillText(Math.ceil(b.t) + 's', x, y - 26);
      g.globalAlpha = 1; g.textAlign = 'left';
      lights.push([x, y, 46 + pulse * 14, GOLD, 0.45 + pulse * 0.2]);
    }
  }

  // The flame cone. Drawn, not simulated — stepFlames already decided who burns.
  // Three stacked wedges (deep red, orange, hot core) with the tip jittered off
  // the tick so it flickers without ever asking rng() and desyncing anything.
  function drawFlames(g, cx, cy, lights, W, tc) {
    for (var i = 0; i < W.players.length; i++) {
      var p = W.players[i];
      if (!p.alive || p.dead || p.weapon !== 'f') continue;
      if (!p.inp || !p.inp.f || !(p.fuel > 0)) continue;
      var o = flameOrigin(p), ox = o.x - cx, oy = o.y - cy;
      var ang = Math.atan2(o.ny, o.nx), half = Math.PI / 6;
      var lay = [[FLAME_LEN, FIRE_LO, 0.40], [FLAME_LEN * 0.82, FIRE, 0.55], [FLAME_LEN * 0.5, FIRE_HI, 0.75]];
      for (var L = 0; L < lay.length; L++) {
        var len = lay[L][0] * (0.9 + ((W.tick + L * 5) % 7) / 35);
        g.fillStyle = lay[L][1]; g.globalAlpha = lay[L][2];
        g.beginPath(); g.moveTo(ox, oy);
        g.arc(ox, oy, len, ang - half, ang + half);
        g.closePath(); g.fill();
      }
      g.globalAlpha = 1;
      /* embers: deterministic offsets off the tick, never rng() */
      for (var e = 0; e < 5; e++) {
        var t2 = ((W.tick * 7 + e * 13) % 40) / 40;
        var sp = ang + ((e % 3) - 1) * 0.22;
        g.fillStyle = e % 2 ? FIRE_HI : FIRE; g.globalAlpha = 0.8 - t2 * 0.7;
        g.fillRect(ox + Math.cos(sp) * FLAME_LEN * t2, oy + Math.sin(sp) * FLAME_LEN * t2, 2, 2);
      }
      g.globalAlpha = 1;
      lights.push([ox + o.nx * 20, oy + o.ny * 20, 70, FIRE, 0.6]);
    }
  }

  // Grenades: a small orange bead with the same 3-point trail the enemy bullets
  // use, so the arc reads as a thrown thing and not a slow bullet.
  function drawGrenades(g, cx, cy, lights) {
    if (!st) return;
    for (var i = 0; i < st.grenades.length; i++) {
      var b = st.grenades[i]; if (!b.alive) continue;
      var mx = b.x - cx, my = b.y - cy;
      g.fillStyle = BOOM;
      g.globalAlpha = 0.16; g.fillRect(b.x3 - cx - 1, b.y3 - cy - 1, 2, 2);
      g.globalAlpha = 0.32; g.fillRect(b.x2 - cx - 1, b.y2 - cy - 1, 2, 2);
      g.globalAlpha = 0.55; g.fillRect(b.x1 - cx - 1.5, b.y1 - cy - 1.5, 3, 3);
      g.globalAlpha = 1;
      g.fillStyle = BOOM; g.beginPath(); g.arc(mx, my, 3, 0, 6.283); g.fill();
      // The fuse blinks faster as it runs out — deterministic, straight off ttl.
      var lit = (b.ttl % (b.ttl < 30 ? 4 : 10)) < 2;
      g.fillStyle = lit ? BOOM_HI : BOOM_LO;
      g.beginPath(); g.arc(mx - 0.8, my - 1, 1.2, 0, 6.283); g.fill();
      lights.push([mx, my, lit ? 30 : 20, BOOM, lit ? 0.7 : 0.4]);
    }
  }

  function hud(W) {
    var B = st && st.boss;
    if (!B || !B.engaged) return '';
    /* Name it. Four bosses that all read "BOSS" is four bosses the player cannot
       tell apart in the one place they are looking while they fight. */
    if (!B.alive) return BOSS_NAME[B.kind] + ' DOWN';
    var n = 10, k = Math.ceil(B.hp / B.hpMax * n), s = BOSS_NAME[B.kind] + ' ';
    for (var i = 0; i < n; i++) s += i < k ? '█' : '░';
    /* The portal shares this row on purpose: boss or portal is one decision, so
       it should be one glance. */
    var P = st.portal;
    if (P && P.alive) {
      var pk = Math.ceil(P.hp / P.hpMax * 5);
      s += '  PORTAL ';
      for (i = 0; i < 5; i++) s += i < pk ? '█' : '░';
    }
    return s;
  }

  var CONTRA = { build: build, step: step, draw: draw, hud: hud,
    throwGrenade: throwGrenade, stepGrenades: stepGrenades, drawGrenades: drawGrenades,
    poolRoom: poolRoom, poolCount: poolCount, POOL_CAP: POOL_CAP,
    /* the core owns what a player IS, so it calls this when one dies with a
       teammate still up; CONTRA owns the beacon from there. */
    dropBeacon: dropBeacon,
    camLocked: function () { return !!(st && st.camLock); },
    FLAME_FUEL: FLAME_FUEL,
    /* harness: the pickup effect without the pickup, for screenshots and tests */
    grant: function (W, slot, kind) {
      var p = W.players[slot]; if (!st || !p) return false;
      if (kind === 'h') { p.weapon = 'h'; p.hAmmo = 30; }
      else if (kind === 'f') { p.weapon = 'f'; p.fuel = FLAME_FUEL; }
      else if (kind === 'd') spawnDrone(W, p);
      else if (kind === 't') startHawk(W, p);
      else if (kind === 'b') p.shieldT = 5;
      else p.weapon = kind;
      return true;
    },
    /* what the drive scripts assert on. Sim state only — no rendering, no DOM. */
    _info: function () {
      if (!st) return null;
      var B = st.boss, i, bs = [];
      for (i = 0; i < st.beacons.length; i++) {
        var b = st.beacons[i]; if (!b.alive) continue;
        bs.push({ slot: b.slot, x: Math.round(b.x), t: Math.round(b.t * 10) / 10,
                  prog: Math.round(b.prog * 100) / 100, helpers: b.helpers });
      }
      var gs = [];
      for (i = 0; i < st.gates.length; i++) {
        var G = st.gates[i], live = 0, j;
        for (j = 0; j < st.runners.length; j++) if (st.runners[j].alive && st.runners[j].gate === i) live++;
        for (j = 0; j < st.snipers.length; j++) if (st.snipers[j].alive && st.snipers[j].gate === i) live++;
        gs.push({ col: G.col, stage: G.stage, state: G.state, live: live, n: G.n || 0 });
      }
      return {
        boss: B ? { kind: B.kind, name: BOSS_NAME[B.kind], hp: B.hp, hpMax: B.hpMax,
                    alive: B.alive, engaged: B.engaged, mode: B.mode, open: !!B.open,
                    x: Math.round(B.cx), y: Math.round(B.cy) } : null,
        portal: st.portal && st.portal.alive
          ? { hp: st.portal.hp, left: st.portal.left, x: Math.round(st.portal.x) } : null,
        beacons: bs, gates: gs, camLock: !!st.camLock,
        runners: st.runners.filter(function (r) { return r.alive; }).length,
        snipers: st.snipers.filter(function (r) { return r.alive; }).length
      };
    },
    _state: function () { return st; } };
  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  root.CONTRA = CONTRA;
  if (typeof module !== 'undefined' && module.exports) module.exports = CONTRA;
})();
