// ============================================================================
// INPUT — the one place every input source lives: keyboard, gamepad, touch.
// Exposes exactly one global: window.INPUT.
//
//   init(opts)   once, after the DOM exists.
//                opts.onAction(name)  REQUIRED — "reset" | "pause" | "mute".
//                                     The core owns what those mean; we only
//                                     name them. No default: a silent no-op
//                                     here would eat the escape key forever.
//                opts.padRoot         optional element holding the touch pad
//                                     (default: document.querySelector(".pad"))
//   poll()       once per tick, before the byte is packed. Samples the gamepad
//                and folds all three sources into one merged state.
//   get()        {l,r,u,d,j,f,s,b} — 0/1 each, OR'd across every source.
//   clear()      drop everything held (blur, pause, level transit).
//
// Merge rule: OR. Keyboard, pad and touch are peers — hold the stick and press
// the on-screen fire and both land. Nothing here is ever consulted by the sim
// directly; the core packs get() into the one input byte and that byte is the
// only thing the network and the simulation ever see. So a peer on a gamepad
// and a peer on a phone stay in perfect lockstep: same byte, same tick.
//
// Bits (CONTRACT-INPUT §): l r u d j f s b  — b is the bomb throw.
// ============================================================================
(function () {
  'use strict';

  var BITS = ['l', 'r', 'u', 'd', 'j', 'f', 's', 'b'];

  var keys = {};          // keyboard
  var pad = {};           // touch overlay
  var gp = {};            // gamepad, rebuilt every poll
  var merged = { l: 0, r: 0, u: 0, d: 0, j: 0, f: 0, s: 0, b: 0 };

  var onAction = null;
  var padRoot = null;
  var started = false;

  var DEADZONE = 0.3;     // stick noise floor; below this the axis reads centred
  var gamepadOn = false;
  var isTouch = false;

  // ---------- keyboard ----------
  // Same table the core used to own, plus C/V for the bomb.
  var CODES = {
    ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r',
    Space: 'j', KeyW: 'j', ArrowUp: 'u', ArrowDown: 'd', KeyS: 'd',
    KeyX: 'f', KeyK: 'f', KeyJ: 'f',
    ShiftLeft: 's', ShiftRight: 's',
    KeyC: 'b', KeyV: 'b',
    KeyR: 'reset', Escape: 'pause', KeyP: 'pause', KeyM: 'mute'
  };

  function onKeyDown(e) {
    var k = CODES[e.code]; if (!k) return;
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
    if (k === 'reset' || k === 'pause' || k === 'mute') { onAction(k); return; }
    keys[k] = true;
  }
  function onKeyUp(e) { var k = CODES[e.code]; if (k) keys[k] = false; }

  // ---------- gamepad ----------
  // Standard Gamepad layout. Never index 0 blindly — a disconnected pad can sit
  // in slot 0 with a live one behind it, and getGamepads() keeps the hole.
  function firstPad() {
    var list;
    if (!navigator.getGamepads) return null;
    try { list = navigator.getGamepads(); } catch (e) { return null; }
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].connected) return list[i];
    return null;
  }
  function pollGamepad() {
    for (var i = 0; i < BITS.length; i++) gp[BITS[i]] = 0;
    var g = firstPad();
    if (!g) { setGamepad(false); return; }
    setGamepad(true);
    var ax = g.axes || [], bt = g.buttons || [];
    function btn(n) { var b = bt[n]; return !!(b && (b.pressed || b.value > 0.5)); }
    var x = ax.length > 0 ? ax[0] : 0, y = ax.length > 1 ? ax[1] : 0;
    if (x < -DEADZONE || btn(14)) gp.l = 1;          // stick left  / dpad left
    if (x > DEADZONE || btn(15)) gp.r = 1;           // stick right / dpad right
    if (y < -DEADZONE || btn(12)) gp.u = 1;          // stick up    / dpad up
    if (y > DEADZONE || btn(13)) gp.d = 1;           // stick down  / dpad down
    if (btn(0)) gp.j = 1;                            // A
    if (btn(2) || btn(5)) gp.f = 1;                  // X or R1
    if (btn(4) || btn(1)) gp.s = 1;                  // L1 or B
    if (btn(3)) gp.b = 1;                            // Y — bomb
  }
  function setGamepad(on) {
    if (gamepadOn === on) return;
    gamepadOn = on;
    // Gamepad wins the screen: a pad on a tablet means the overlay is just
    // fingerprints over the game.
    try { document.body.classList.toggle('gamepad', on); } catch (e) {}
  }

  // ---------- touch: the dpad ----------
  // One circle, eight regions. Tracked by touch identifier so a second finger on
  // Fire can never move or release the dpad — that is the whole point of doing
  // this by hand instead of five buttons.
  var dpadEl = null, dpadId = null;

  function clearDpad() { pad.l = pad.r = pad.u = pad.d = 0; if (dpadEl) dpadEl.classList.remove('on'); }

  function dpadAim(t) {
    var r = dpadEl.getBoundingClientRect();
    var dx = t.clientX - (r.left + r.width / 2);
    var dy = t.clientY - (r.top + r.height / 2);
    pad.l = pad.r = pad.u = pad.d = 0;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < r.width * 0.18) return;                  // dead centre: no direction
    var oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    if (oct === 4 || oct === -4) { pad.l = 1; }
    else if (oct === -3) { pad.l = 1; pad.u = 1; }
    else if (oct === -2) { pad.u = 1; }
    else if (oct === -1) { pad.r = 1; pad.u = 1; }
    else if (oct === 0) { pad.r = 1; }
    else if (oct === 1) { pad.r = 1; pad.d = 1; }
    else if (oct === 2) { pad.d = 1; }
    else if (oct === 3) { pad.l = 1; pad.d = 1; }
  }
  function findTouch(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  }
  function bindDpad(el) {
    dpadEl = el;
    el.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (dpadId !== null) return;
      var t = e.changedTouches[0];
      dpadId = t.identifier; el.classList.add('on'); dpadAim(t);
    }, { passive: false });
    el.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (dpadId === null) return;
      var t = findTouch(e.changedTouches, dpadId);
      if (t) dpadAim(t);
    }, { passive: false });
    function end(e) {
      e.preventDefault();
      if (dpadId === null) return;
      if (!findTouch(e.changedTouches, dpadId)) return;
      dpadId = null; clearDpad();
    }
    el.addEventListener('touchend', end, { passive: false });
    el.addEventListener('touchcancel', end, { passive: false });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // ---------- touch: the buttons ----------
  // Pointer events with capture, not touch events: capture is what guarantees the
  // release lands on the button even when the finger slides off it, and it is
  // already multi-touch (one pointerId per finger). Same behaviour the old inline
  // pad had, kept because it was the part that worked.
  function bindButton(btn) {
    var k = btn.getAttribute('data-hold');
    if (!k) return;
    function press(e) {
      e.preventDefault(); pad[k] = 1; btn.classList.add('on');
      if (btn.setPointerCapture && e.pointerId != null) {
        try { btn.setPointerCapture(e.pointerId); } catch (err) {}
      }
    }
    function rel(e) { if (e) e.preventDefault(); pad[k] = 0; btn.classList.remove('on'); }
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', rel);
    btn.addEventListener('pointercancel', rel);
    btn.addEventListener('lostpointercapture', rel);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // ---------- public ----------
  function clear() {
    keys = {}; pad = {}; dpadId = null;
    for (var i = 0; i < BITS.length; i++) { gp[BITS[i]] = 0; merged[BITS[i]] = 0; }
    if (dpadEl) dpadEl.classList.remove('on');
    if (padRoot) {
      var on = padRoot.querySelectorAll('.on');
      for (var j = 0; j < on.length; j++) on[j].classList.remove('on');
    }
  }

  function poll() {
    pollGamepad();
    for (var i = 0; i < BITS.length; i++) {
      var k = BITS[i];
      merged[k] = (keys[k] || pad[k] || gp[k]) ? 1 : 0;
    }
  }

  function get() { return merged; }

  function init(opts) {
    if (started) return;
    opts = opts || {};
    if (typeof opts.onAction !== 'function') {
      throw new Error('INPUT.init: onAction(name) is required — reset/pause/mute have no meaning in here');
    }
    started = true;
    onAction = opts.onAction;
    padRoot = opts.padRoot || document.querySelector('.pad');

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);

    isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    try { document.body.classList.toggle('touch', isTouch); } catch (e) {}

    if (padRoot) {
      var d = padRoot.querySelector('[data-dpad]');
      if (d) bindDpad(d);
      var bs = padRoot.querySelectorAll('button[data-hold]');
      for (var i = 0; i < bs.length; i++) bindButton(bs[i]);
      // The pad swallows scroll/zoom itself; the canvas keeps its own handlers,
      // so nothing here calls stopPropagation.
      padRoot.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    }

    window.addEventListener('gamepadconnected', function () { pollGamepad(); });
    window.addEventListener('gamepaddisconnected', function () { setGamepad(false); clear(); });
    pollGamepad();
  }

  var INPUT = {
    init: init, poll: poll, get: get, clear: clear,
    hasGamepad: function () { return gamepadOn; },
    isTouch: function () { return isTouch; }
  };
  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  root.INPUT = INPUT;
  if (typeof module !== 'undefined' && module.exports) module.exports = INPUT;
})();
