// ============================================================================
// COSMOS — the void behind the world. Paste-in module, one global: window.COSMOS.
// Canvas 2D only, no libraries, no files. Deterministic from `seed` (own PRNG;
// the draw path never calls Math.random). Everything heavy is precomputed in
// init/resize/level; draw() allocates nothing.
//
//   init(canvas, seed)                once at boot
//   resize(w, h)                      logical canvas size
//   update(dt)                        every fixed step
//   draw(ctx, camX, camY, mapW, mapH) BEFORE the tiles
//   arc(points)                       last jump as [{x,y}] world px — ghost trail
//   level(n)                          0-based palette shift
//
// Layers, back to front: indigo void → nebula wash (parallax .06) → four star
// layers (.04 .12 .28 .55) → calibration rules (.3) → instrument frame at the
// map edge (1.0) → ghost arc (1.0) → vignette (screen).
// prefers-reduced-motion → no twinkle, no drift, static sky. Arc still fades.
// ============================================================================
(function () {
  'use strict';

  // ---------- state ----------
  var W = 480, H = 270;
  var seed = 1;
  var t = 0;
  var lvl = 0;
  var reduced = false;
  try {
    reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { reduced = false; }

  // ---------- PRNG (mulberry32) ----------
  function rng(s) {
    var a = s >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- palettes per level ----------
  // void: base fill. neb: two nebula tints. star: star tint (rgb string prefix).
  // rule: calibration rule colour. warm: gold accent for the brightest stars.
  var PAL = [
    { // I. Perigee — closest to the ground, a little warmth still reaches
      void_: '#0b0d22', neb: ['rgba(64,40,120,', 'rgba(150,90,40,'],
      star: '210,220,255', warm: '255,214,140', rule: 'rgba(120,130,200,' },
    { // II. Umbra — the shadow; violet and cold teal
      void_: '#07081a', neb: ['rgba(50,20,100,', 'rgba(20,80,110,'],
      star: '200,210,255', warm: '220,200,255', rule: 'rgba(100,110,190,' },
    { // III. Apoapsis — the far point; nearly black, pale cyan, sparse
      void_: '#040511', neb: ['rgba(20,40,90,', 'rgba(70,40,110,'],
      star: '190,225,255', warm: '170,240,255', rule: 'rgba(90,120,180,' }
  ];
  function pal() { return PAL[Math.min(PAL.length - 1, Math.max(0, lvl))]; }

  // ---------- star layers ----------
  // Each layer is a viewport-sized tile; a star at (x,y) appears once per frame at
  // ((x - cam*f) mod W, (y - cam*f) mod H). Typed arrays, filled once.
  var LAYERS = [
    { f: 0.04, n: 90,  smin: 1, smax: 1, a: 0.35, tw: 0.6 },
    { f: 0.12, n: 70,  smin: 1, smax: 1, a: 0.55, tw: 0.9 },
    { f: 0.28, n: 40,  smin: 1, smax: 2, a: 0.8,  tw: 1.3 },
    { f: 0.55, n: 16,  smin: 2, smax: 2, a: 1.0,  tw: 1.8 }
  ];
  var stars = []; // per layer: {x,y,s,ph,b,warm}

  function buildStars() {
    var r = rng(seed * 7919 + 17);
    stars.length = 0;
    for (var L = 0; L < LAYERS.length; L++) {
      var cfg = LAYERS[L];
      var n = Math.round(cfg.n * (W * H) / (480 * 270));
      var s = {
        n: n,
        x: new Float32Array(n), y: new Float32Array(n), s: new Uint8Array(n),
        ph: new Float32Array(n), b: new Float32Array(n), warm: new Uint8Array(n)
      };
      for (var i = 0; i < n; i++) {
        s.x[i] = r() * W;
        s.y[i] = r() * H;
        s.s[i] = cfg.smin + (r() < 0.25 ? cfg.smax - cfg.smin : 0);
        s.ph[i] = r() * Math.PI * 2;
        s.b[i] = 0.5 + r() * 0.5;
        s.warm[i] = (L >= 2 && r() < 0.3) ? 1 : 0;
      }
      stars.push(s);
    }
  }

  // ---------- offscreen: nebula (per level) and vignette (per size) ----------
  var nebC = null, vigC = null;

  function makeCanvas(w, h) {
    try {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    } catch (e) { return null; }
  }

  function buildNebula() {
    nebC = makeCanvas(W, H);
    if (!nebC) return;
    var g = nebC.getContext('2d');
    var p = pal();
    var r = rng(seed * 104729 + lvl * 31 + 5);
    g.clearRect(0, 0, W, H);
    // three soft blobs, wrapped so the tile seams don't show
    for (var i = 0; i < 3; i++) {
      var cx = r() * W, cy = r() * H;
      var rad = (0.35 + r() * 0.35) * Math.max(W, H);
      var col = p.neb[i & 1];
      for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) {
        var x = cx + ox * W, y = cy + oy * H;
        if (x + rad < 0 || x - rad > W || y + rad < 0 || y - rad > H) continue;
        var gr = g.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, col + '0.16)');
        gr.addColorStop(0.55, col + '0.05)');
        gr.addColorStop(1, col + '0)');
        g.fillStyle = gr;
        g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
    }
  }

  function buildVignette() {
    vigC = makeCanvas(W, H);
    if (!vigC) return;
    var g = vigC.getContext('2d');
    var gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
  }

  // ---------- ghost arc ----------
  var ARC_MAX = 96;
  var arcX = new Float32Array(ARC_MAX), arcY = new Float32Array(ARC_MAX);
  var arcN = 0, arcAge = 0;
  var ARC_LIFE = 2.4;

  // ---------- helpers ----------
  function wrap(v, m) { v = v % m; return v < 0 ? v + m : v; }

  // drawing a wrapped tile: up to 4 copies so the seam never shows
  function drawTiled(ctx, img, ox, oy) {
    ox = wrap(ox, W); oy = wrap(oy, H);
    ctx.drawImage(img, ox - W, oy - H);
    ctx.drawImage(img, ox, oy - H);
    ctx.drawImage(img, ox - W, oy);
    ctx.drawImage(img, ox, oy);
  }

  // ---------- public ----------
  window.COSMOS = {
    init: function (canvas, s) {
      try {
        seed = (s | 0) || 1;
        if (canvas && canvas.width && canvas.height) { W = canvas.width | 0; H = canvas.height | 0; }
        t = 0; arcN = 0;
        buildStars(); buildNebula(); buildVignette();
      } catch (e) {}
    },

    resize: function (w, h) {
      try {
        w = w | 0; h = h | 0;
        if (w <= 0 || h <= 0 || (w === W && h === H)) return;
        W = w; H = h;
        buildStars(); buildNebula(); buildVignette();
      } catch (e) {}
    },

    level: function (n) {
      try {
        n = n | 0;
        if (n === lvl) return;
        lvl = n;
        buildNebula();
      } catch (e) {}
    },

    arc: function (pts) {
      try {
        if (!pts || !pts.length) return;
        var step = pts.length > ARC_MAX ? pts.length / ARC_MAX : 1;
        var n = 0;
        for (var i = 0; i < pts.length && n < ARC_MAX; i += step) {
          var p = pts[i | 0];
          arcX[n] = +p.x; arcY[n] = +p.y; n++;
        }
        arcN = n; arcAge = 0;
      } catch (e) {}
    },

    update: function (dt) {
      try {
        var d = +dt; if (!(d > 0)) d = 1 / 60;
        if (!reduced) t += d;
        if (arcN) { arcAge += d; if (arcAge > ARC_LIFE) arcN = 0; }
      } catch (e) {}
    },

    draw: function (ctx, camX, camY, mapW, mapH) {
      try {
        if (!ctx) return;
        var cx = +camX || 0, cy = +camY || 0;
        var p = pal();
        var drift = reduced ? 0 : t * 1.5;   // px/s autonomous drift on far layers

        // 1. void
        ctx.fillStyle = p.void_;
        ctx.fillRect(0, 0, W, H);

        // 2. nebula wash
        if (nebC) drawTiled(ctx, nebC, -cx * 0.06 - drift * 0.4, -cy * 0.06);

        // 3. stars
        var i, L, s, cfg, x, y, b, size;
        for (L = 0; L < stars.length; L++) {
          s = stars[L]; cfg = LAYERS[L];
          var ox = -cx * cfg.f - drift * (1 - cfg.f) * 0.5;
          var oy = -cy * cfg.f;
          var cold = 'rgba(' + p.star + ',';
          var warm = 'rgba(' + p.warm + ',';
          for (i = 0; i < s.n; i++) {
            x = wrap(s.x[i] + ox, W);
            y = wrap(s.y[i] + oy, H);
            b = s.b[i];
            if (!reduced) b *= 0.72 + 0.28 * Math.sin(t * cfg.tw + s.ph[i]);
            b *= cfg.a;
            size = s.s[i];
            ctx.fillStyle = (s.warm[i] ? warm : cold) + b.toFixed(2) + ')';
            ctx.fillRect(x | 0, y | 0, size, size);
          }
        }

        // 4. calibration rules — a faint grid at parallax .3, brighter every 4th
        var gx = wrap(-cx * 0.3, 64), gy = wrap(-cy * 0.3, 64);
        ctx.fillStyle = p.rule + '0.035)';
        for (x = gx - 64; x < W; x += 16) ctx.fillRect(x | 0, 0, 1, H);
        for (y = gy - 64; y < H; y += 16) ctx.fillRect(0, y | 0, W, 1);
        ctx.fillStyle = p.rule + '0.11)';
        for (x = gx - 64; x < W; x += 64) ctx.fillRect(x | 0, 0, 1, H);
        for (y = gy - 64; y < H; y += 64) ctx.fillRect(0, y | 0, W, 1);

        // 5. instrument frame — the map's own edges, at parallax 1
        var mw = +mapW || 0, mh = +mapH || 0;
        if (mw > 0 && mh > 0) {
          ctx.fillStyle = p.rule + '0.22)';
          var fx0 = -cx, fx1 = mw - cx, fy0 = -cy, fy1 = mh - cy;
          if (fx0 >= 0 && fx0 < W) ctx.fillRect(fx0 | 0, 0, 1, H);
          if (fx1 >= 0 && fx1 < W) ctx.fillRect(fx1 | 0, 0, 1, H);
          if (fy0 >= 0 && fy0 < H) ctx.fillRect(0, fy0 | 0, W, 1);
          if (fy1 >= 0 && fy1 < H) ctx.fillRect(0, fy1 | 0, W, 1);
          // tick marks along the top edge every 64 world px
          if (fy0 >= 0 && fy0 < H) {
            for (x = wrap(-cx, 64); x < W; x += 64) ctx.fillRect(x | 0, fy0 | 0, 1, 4);
          }
        }

        // 6. ghost arc — your last jump, hanging in space, gold at the apex, fading
        if (arcN > 1) {
          var k = 1 - arcAge / ARC_LIFE;
          var a = k * 0.75;
          ctx.save();
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = 'rgba(' + p.warm + ',' + a.toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(arcX[0] - cx, arcY[0] - cy);
          for (i = 1; i < arcN; i++) ctx.lineTo(arcX[i] - cx, arcY[i] - cy);
          ctx.stroke();
          // the apex — the apoapsis — as a single brighter dot
          var top = 0;
          for (i = 1; i < arcN; i++) if (arcY[i] < arcY[top]) top = i;
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(' + p.warm + ',' + (a * 1.6).toFixed(3) + ')';
          ctx.fillRect((arcX[top] - cx - 1) | 0, (arcY[top] - cy - 1) | 0, 3, 3);
          ctx.fillStyle = 'rgba(' + p.warm + ',' + (a * 0.5).toFixed(3) + ')';
          ctx.fillRect((arcX[top] - cx - 2) | 0, (arcY[top] - cy - 2) | 0, 5, 5);
          ctx.restore();
        }

        // 7. vignette — screen space, keeps the eye on the centre
        if (vigC) ctx.drawImage(vigC, 0, 0);
      } catch (e) {}
    }
  };
})();
