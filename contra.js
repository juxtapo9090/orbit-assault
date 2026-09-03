// ============================================================================
// CONTRA — enemies, enemy bullets, spawners, weapon capsule, wall boss.
// One global: window.CONTRA. Cooks against the W object in CONTRACT.md §2.
//
//   build(W)                    level load: scan glyphs r s t S W B, blank them, reset
//   step(W, DT)                 one sim tick (deterministic: W.rng() only, no splice)
//   draw(g, cx, cy, lights, W)  world draw with camera offset; pushes [x,y,r,col,a]
//   hud(W)                      "BOSS ████░░" while a boss is engaged, else ""
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

  var st = null;                              // whole module state; rebuilt per level
  var nextId = 1;

  function fresh() {
    nextId = 1;
    return {
      runners: [], snipers: [], turrets: [], spawners: [],
      capsules: [], pickups: [], ebullets: [], boss: null
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
  function hittable(p) { return p.alive && !p.dead && !(p.invT > 0); }
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
  function bulletDmg(kind) { return kind === 'l' ? 3 : 1; }
  function bulletHitOnce(b, id) {            // laser pierces: remember what it already hit
    if (b.kind !== 'l') { b.alive = false; return true; }
    if (!b.cHit) b.cHit = [];
    for (var i = 0; i < b.cHit.length; i++) if (b.cHit[i] === id) return false;
    b.cHit.push(id);
    return true;
  }

  // ---------- enemy bullets ----------
  function fire(x, y, vx, vy, src) {
    var eb = st.ebullets, b = null;
    for (var i = 0; i < eb.length; i++) if (!eb[i].alive) { b = eb[i]; break; }
    if (!b) { b = {}; eb.push(b); }
    b.alive = true; b.x = x; b.y = y; b.vx = vx; b.vy = vy; b.r = 2; b.ttl = 180; b.src = src;
    b.x1 = x; b.y1 = y; b.x2 = x; b.y2 = y; b.x3 = x; b.y3 = y;
  }
  function fireAt(x, y, tx, ty, speed, src) {
    var dx = tx - x, dy = ty - y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    fire(x, y, dx / d * speed, dy / d * speed, src);
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
    return r;
  }
  function stepRunners(W, DT) {
    var rs = st.runners, SPEED = 115, JUMP = 390;
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
          k.alive = false; p.weapon = k.kind;
          W.J('sfx', 'pickup'); W.J('burst', k.x, k.y, WARM, 14);
          W.score(500, p);
          break;
        }
      }
    }
  }
  function dropPickup(W, x, y) {
    var kind = W.rng() < 0.3 ? 'l' : 's';
    var ps = st.pickups, k = null;
    for (var i = 0; i < ps.length; i++) if (!ps[i].alive) { k = ps[i]; break; }
    if (!k) { k = {}; ps.push(k); }
    k.alive = true; k.x = x; k.y = y; k.vy = -40; k.kind = kind; k.grounded = false; k.t = 0;
  }

  // ---------- boss ----------
  var BOSS_PERIOD = 4.0, BOSS_OPEN = 1.5, BOSS_OPEN_LONG = 2.6;
  function stepBoss(W, DT) {
    var B = st.boss; if (!B || !B.alive) return;
    var camX = W.camX();
    if (!B.engaged) {
      if (camX + W.VW > B.x - 60) { B.engaged = true; B.t = 0; }
      else return;
    }
    B.t += DT;
    if (B.flash > 0) B.flash -= DT;
    var portsLeft = 0;
    for (var i = 0; i < 3; i++) if (B.ports[i].alive) portsLeft++;
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

      var B = st.boss;
      if (B && B.alive && B.engaged) {
        var hitAny = false;
        for (j = 0; j < 3; j++) {
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
        if (circleRect(b.x, b.y, b.r, B.cx - 9, B.cy - 9, 18, 18)) {
          if (!B.open) {
            if (b.kind !== 'l') { b.alive = false; W.J('burst', b.x, b.y, STEEL_HI, 3); W.J('sfx', 'turretHit'); }
            continue;
          }
          if (!bulletHitOnce(b, B.id)) continue;
          B.hp -= bulletDmg(b.kind); B.flash = 0.12;
          W.J('sfx', 'bossHit'); W.J('burst', b.x, b.y, WARM, 6);
          if (B.hp <= 0) {
            B.alive = false; B.hp = 0; W.levelDone = true; W.score(5000, owner);
            for (var q = 0; q < 3; q++) { B.ports[q].alive = false; }
            for (q = 0; q < st.ebullets.length; q++) st.ebullets[q].alive = false;
            W.J('burst', B.cx, B.cy, WARM, 60); W.J('burst', B.cx, B.cy, RED, 40);
            W.J('sfx', 'bossDie'); W.J('shake', 1); W.J('hitstop', 6);
          }
        }
      }
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
          var face = W.solidAt(x + 1, y) || W.solidAt(x + 2, y) ? -1 : 1;     // face away from the wall behind
          var base = floorBelow(W, x, y);
          var cx = px + TS / 2, cy = base - 46;
          st.boss = { id: nextId++, alive: true, engaged: false, x: cx, cx: cx, cy: cy, base: base, face: face,
            hp: 30, hpMax: 30, open: false, openK: 0, t: 0, flash: 0,
            ports: [
              { id: nextId++, alive: true, hp: 6, x: cx + face * 22, y: base - 12, cd: 1.0, burst: 0, flash: 0 },
              { id: nextId++, alive: true, hp: 6, x: cx + face * 24, y: base - 80, cd: 1.7, burst: 0, flash: 0 },
              { id: nextId++, alive: true, hp: 6, x: cx - face * 2, y: base - 104, cd: 2.4, burst: 0, flash: 0 }
            ] };
        }
      }
    }
    W.levelDone = false;
  }

  // ---------- step ----------
  function step(W, DT) {
    if (!st) return;
    stepSpawners(W, DT);
    stepRunners(W, DT);
    stepSnipers(W, DT);
    stepTurrets(W, DT);
    stepCapsules(W, DT);
    stepBoss(W, DT);
    stepBullets(W, DT);
    bulletVsEnemies(W);
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

    // runners: red rounded slab, lean into the run, hot eye
    for (i = 0; i < st.runners.length; i++) {
      var e = st.runners[i]; if (!e.alive) continue;
      var ex = e.x - cx, ey = e.y - cy;
      if (ex < -30 || ex > VW + 30) continue;
      var bob = e.onGround ? Math.abs(Math.sin(e.t * 18)) * 1.5 : 0;
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

    // snipers: tall diamond on a stem, aim line flickers on fire
    for (i = 0; i < st.snipers.length; i++) {
      var s = st.snipers[i]; if (!s.alive) continue;
      var sx = s.x - cx + s.w / 2, sy = s.y - cy;
      if (sx < -30 || sx > VW + 30) continue;
      g.fillStyle = RED_LO; g.fillRect(sx - 2, sy + 8, 4, 6);
      g.fillStyle = RED; diamond(g, sx, sy + 5, 5.5); g.fill();
      g.fillStyle = HOT; g.fillRect(sx + s.face * 1.5 - 1, sy + 4, 2, 2);
      if (s.flash > 0) {
        g.strokeStyle = HOT; g.globalAlpha = s.flash / 0.12; g.lineWidth = 1;
        g.beginPath(); g.moveTo(sx, sy + 5); g.lineTo(sx + s.face * 14, sy + 5); g.stroke();
        g.globalAlpha = 1;
        lights.push([sx + s.face * 8, sy + 5, 26, HOT, 0.5]);
      }
      lights.push([sx, sy + 5, 20, RED, 0.2]);
    }

    // turrets: steel ring set into the wall; iris opens to a red eye
    for (i = 0; i < st.turrets.length; i++) {
      var t = st.turrets[i]; if (!t.alive) continue;
      var tx = t.x - cx, ty = t.y - cy;
      if (tx < -30 || tx > VW + 30) continue;
      // mount bar toward the wall
      g.fillStyle = '#2B3159';
      if (t.side) g.fillRect(t.side > 0 ? tx : tx - 8, ty - 3, 8, 6);
      else if (t.vert) g.fillRect(tx - 3, t.vert > 0 ? ty : ty - 8, 6, 8);
      var open = t.open ? 1 : 0;
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
      g.fillStyle = STEEL; rrect(g, kx - 8, ky - 4, 16, 8, 4); g.fill();
      g.fillStyle = STEEL_HI; g.globalAlpha = 0.6; g.fillRect(kx - 12, ky - 1, 24, 1.5); g.globalAlpha = 1;
      g.fillStyle = WARM; g.beginPath(); g.arc(kx, ky, 2.6 + pulse * 0.6, 0, 6.283); g.fill();
      lights.push([kx, ky, 30 + pulse * 8, WARM, 0.4]);
    }
    // pickups: letter-in-a-diamond, S or L
    for (i = 0; i < st.pickups.length; i++) {
      var k = st.pickups[i]; if (!k.alive) continue;
      var px = k.x - cx, py = k.y - cy - (k.grounded ? Math.abs(Math.sin(tc * 3)) * 2 : 0);
      if (px < -30 || px > VW + 30) continue;
      g.fillStyle = k.kind === 'l' ? '#7FD2F0' : WARM;
      diamond(g, px, py, 7); g.fill();
      g.fillStyle = '#171C33'; g.font = 'bold 7px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(k.kind === 'l' ? 'L' : 'S', px, py + 0.5);
      lights.push([px, py, 28, k.kind === 'l' ? '#7FD2F0' : WARM, 0.35]);
    }

    // boss: steel bulkhead, three port rings, pulsing warm eye behind an iris
    var B = st.boss;
    if (B && (B.alive || B.flash > 0)) {
      var bx = B.cx - cx, by = B.cy - cy, f = B.face;
      if (bx > -140 && bx < VW + 140) {
        var baseY = B.base - cy;
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
  }

  function hud(W) {
    var B = st && st.boss;
    if (!B || !B.engaged) return '';
    if (!B.alive) return 'BOSS DOWN';
    var n = 10, k = Math.ceil(B.hp / B.hpMax * n), s = 'BOSS ';
    for (var i = 0; i < n; i++) s += i < k ? '█' : '░';
    return s;
  }

  var CONTRA = { build: build, step: step, draw: draw, hud: hud, _state: function () { return st; } };
  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  root.CONTRA = CONTRA;
  if (typeof module !== 'undefined' && module.exports) module.exports = CONTRA;
})();
