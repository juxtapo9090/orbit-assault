// ============================================================================
// LIGHT — deferred 2D lighting + bloom for the platformer. One global: window.LIGHT.
//
// The game is about a mote of light in a void. That should be a RENDERING fact,
// not just a colour choice: unlit world is genuinely dim, and everything that
// glows genuinely pushes the dark back. When your light drops to one, the radius
// shrinks and the world closes in — the mechanic and the picture are the same
// statement.
//
//   init(canvas, scale)          once; scale = device px per logical px
//   resize(w, h)                 logical size
//   begin(ambient)               start a frame; ambient 0..1 = floor brightness
//   add(x, y, r, color, strength) logical SCREEN coords, additive radial light
//   composite(ctx)               multiply the light buffer onto the main canvas
//   bloom(ctx, amount)           bright-pass → blur → additive glow
//   setQuality(q)                2 = full, 1 = no bloom, 0 = no bloom (caller also
//                                sends fewer lights). LIGHT.QUALITY reads it back.
//
// Order per frame:  begin() → [world draws] → add()×N → composite() → bloom()
//
// Cheap by construction: one 1/2-res buffer for light, one 1/4-res pair for
// bloom, no per-pixel JS. Falls back to a no-op if ctx.filter is unsupported —
// the game must never lose a frame to decoration.
//
// The bright-pass/blur pair is the expensive half: three full-buffer drawImages
// plus a real blur filter, every frame. That is the first thing to drop on a
// tablet, and dropping it costs nothing but glow — the multiply that makes the
// dark actually dark stays on at every tier above zero.
// ============================================================================
(function () {
  'use strict';

  var W = 480, H = 270, S = 1;
  var main = null;
  var lightCv = null, lightCx = null;      // light accumulation, full res
  var bpCv = null, bpCx = null;            // bright pass, quarter res
  var blurCv = null, blurCx = null;        // blurred bright pass
  var ok = false, hasFilter = false, reduced = false;
  var quality = 2;                         // 2 high, 1 medium, 0 low

  function mk(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
    return c;
  }

  function build() {
    var dw = Math.round(W * S), dh = Math.round(H * S);
    lightCv = mk(dw, dh); lightCx = lightCv.getContext('2d');
    var qw = Math.max(1, Math.round(dw / 3)), qh = Math.max(1, Math.round(dh / 3));
    bpCv = mk(qw, qh); bpCx = bpCv.getContext('2d');
    blurCv = mk(qw, qh); blurCx = blurCv.getContext('2d');
    try { hasFilter = (typeof blurCx.filter === 'string'); } catch (e) { hasFilter = false; }
  }

  // ---------- public ----------
  function init(canvas, scale) {
    try {
      main = canvas;
      S = scale || 1;
      try {
        reduced = !!(window.matchMedia &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) { reduced = false; }
      build();
      ok = true;
    } catch (e) { ok = false; }
  }

  function resize(w, h) {
    if (!ok) return;
    try { W = w; H = h; build(); } catch (e) { ok = false; }
  }

  // Ambient is the floor: 0 = pitch black away from light, 1 = fully lit world.
  function begin(ambient) {
    if (!ok) return;
    try {
      var a = Math.max(0, Math.min(1, ambient == null ? 0.5 : ambient));
      var v = Math.round(a * 255);
      lightCx.setTransform(1, 0, 0, 1, 0, 0);
      lightCx.globalCompositeOperation = 'source-over';
      lightCx.globalAlpha = 1;
      lightCx.fillStyle = 'rgb(' + v + ',' + v + ',' + Math.round(v * 1.06) + ')';
      lightCx.fillRect(0, 0, lightCv.width, lightCv.height);
      lightCx.globalCompositeOperation = 'lighter';
    } catch (e) { }
  }

  // x,y,r in LOGICAL screen px. color '#rrggbb'. strength 0..1.
  function add(x, y, r, color, strength) {
    if (!ok || r <= 0) return;
    try {
      var dx = x * S, dy = y * S, dr = r * S;
      // cull offscreen
      if (dx + dr < 0 || dy + dr < 0 || dx - dr > lightCv.width || dy - dr > lightCv.height) return;
      var s = strength == null ? 1 : Math.max(0, Math.min(1, strength));
      if (s <= 0.002) return;
      var c = color || '#ffffff';
      var rgb = hex(c);
      var gr = lightCx.createRadialGradient(dx, dy, 0, dx, dy, dr);
      // Smooth falloff: bright core, long soft tail. Three stops read better
      // than two — a linear ramp makes an obvious hard-edged disc.
      gr.addColorStop(0, 'rgba(' + rgb + ',' + (0.95 * s).toFixed(3) + ')');
      gr.addColorStop(0.28, 'rgba(' + rgb + ',' + (0.55 * s).toFixed(3) + ')');
      gr.addColorStop(0.62, 'rgba(' + rgb + ',' + (0.17 * s).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(' + rgb + ',0)');
      lightCx.fillStyle = gr;
      lightCx.beginPath(); lightCx.arc(dx, dy, dr, 0, 6.283185); lightCx.fill();
    } catch (e) { }
  }

  var hexCache = {};
  function hex(c) {
    var v = hexCache[c];
    if (v) return v;
    var r = 255, g = 255, b = 255;
    try {
      if (c.charAt(0) === '#') {
        var s = c.slice(1);
        if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
        var n = parseInt(s, 16);
        r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
      }
    } catch (e) { }
    v = r + ',' + g + ',' + b;
    hexCache[c] = v;
    return v;
  }

  function composite(ctx) {
    if (!ok) return;
    try {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 1;
      ctx.drawImage(lightCv, 0, 0);
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
    } catch (e) { }
  }

  // Bright-pass by multiplying the frame with itself: mid tones collapse, only
  // genuine highlights survive. Cheaper and more selective than a threshold in JS.
  function bloom(ctx, amount) {
    if (!ok || !hasFilter || !main) return;
    if (quality < 2) return;               // medium and low keep the multiply, lose the glow
    var amt = amount == null ? 0.55 : amount;
    if (amt <= 0.01) return;
    try {
      var qw = bpCv.width, qh = bpCv.height;
      bpCx.setTransform(1, 0, 0, 1, 0, 0);
      bpCx.globalCompositeOperation = 'source-over';
      bpCx.globalAlpha = 1;
      bpCx.clearRect(0, 0, qw, qh);
      bpCx.drawImage(main, 0, 0, qw, qh);
      bpCx.globalCompositeOperation = 'multiply';
      bpCx.drawImage(bpCv, 0, 0);
      bpCx.drawImage(bpCv, 0, 0);
      bpCx.globalCompositeOperation = 'source-over';

      blurCx.setTransform(1, 0, 0, 1, 0, 0);
      blurCx.globalCompositeOperation = 'source-over';
      blurCx.globalAlpha = 1;
      blurCx.clearRect(0, 0, qw, qh);
      blurCx.filter = 'blur(' + (reduced ? 1.6 : 2.4) + 'px)';
      blurCx.drawImage(bpCv, 0, 0);
      blurCx.filter = 'none';

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = amt;
      ctx.drawImage(blurCv, 0, 0, main.width, main.height);
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    } catch (e) { }
  }

  // Tier gate. The bloom buffers stay allocated — a session that dropped to low
  // on a bad first two seconds is not worth a re-allocation, and they are 1/9 res.
  function setQuality(q) {
    q = q | 0;
    quality = q < 0 ? 0 : (q > 2 ? 2 : q);
    LIGHT.QUALITY = quality;
    return quality;
  }

  var LIGHT = {
    init: init, resize: resize, begin: begin,
    add: add, composite: composite, bloom: bloom,
    setQuality: setQuality, QUALITY: 2
  };
  window.LIGHT = LIGHT;
})();
