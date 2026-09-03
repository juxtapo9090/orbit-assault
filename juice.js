// ============================================================================
// JUICE — audio + screen-shake + particles for the platformer. Paste-in module.
// Exposes exactly one global: window.JUICE. Every public call is wrapped; nothing
// escapes. Audio is WebAudio-synthesized (square/triangle/saw + gain envelopes),
// context created lazily on the first sfx() after a user gesture.
//
// Interface (names fixed by the brief):
//   init(canvas)                 once
//   sfx(name)                    "jump"|"land"|"coin"|"stomp"|"hurt"|"goal"|"start"
//   shake(power)                 0..1, decays on its own
//   burst(x, y, color, count)    particle burst — coords are in the SAME space as
//                                the world you draw; draw() subtracts camX/camY.
//                                (If you burst in screen space, call draw(ctx,0,0).)
//   update(dt)                   every fixed step, dt = 1/60
//   draw(ctx, camX, camY)        after your world render
//   shakeOffset()                {x, y} — apply before drawing the world
//   hitstop(frames)              optional extra: freeze request, 2-3 frames on stomp
//   frozen()                     true while a hitstop is active — skip your sim step
//
//   musicStart(name)             "apoapsis" | "contra" — starts, or crossfades to it
//   musicStop()                  fades out
//   musicIntensity(v)            0..1 every step: how hard the player is reaching.
//                                "apoapsis" swells with it; "contra" ignores it.
//   musicLevel(n)                0-based; "apoapsis" darkens per level (key drops)
//   musicMute(on)                optional mute for the music bus only; SFX unaffected
//
// Music is synthesized on the same lazy context, on its own bus under the SFX
// master, at a polite volume. If musicStart() lands before a user gesture it is
// remembered and started on the first sfx() that gets the context running.
//
// prefers-reduced-motion: shakeOffset() is always {0,0}, particles half count/speed.
// ============================================================================
(function () {
  'use strict';

  // ---------- state ----------
  var canvas = null;
  var reducedMotion = false;
  try {
    reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { reducedMotion = false; }

  // shake
  var trauma = 0;          // 0..1
  var shakeX = 0, shakeY = 0;
  var shakeSeed = 0;
  var MAX_SHAKE = 10;      // px at trauma 1

  // hitstop
  var stopFrames = 0;

  // particles (pooled, preallocated)
  var MAX_P = 200;
  var P = new Array(MAX_P);
  for (var i = 0; i < MAX_P; i++) {
    P[i] = { on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, color: '#fff' };
  }
  var GRAV = 700;          // px/s^2 on particles
  var DRAG = 0.985;

  // audio
  var ac = null;
  var master = null;
  var audioDead = false;   // set once creation fails; stay silent forever after
  var voices = 0;
  var MAX_VOICES = 12;
  var lastFire = {};       // name -> ac.currentTime of last fire
  var DEDUPE = 0.04;       // s; same name within this window is dropped

  // ---------- audio core ----------
  function ensureAudio() {
    if (ac) {
      if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
      return ac.state === 'running';
    }
    if (audioDead) return false;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { audioDead = true; return false; }
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
      if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
      return ac.state === 'running';
    } catch (e) {
      audioDead = true;
      ac = null;
      return false;
    }
  }

  // one voice: oscillator with freq ramp f0->f1 and a fast-attack / exp-decay envelope
  // t0 = absolute start time (ac.currentTime based), dur seconds, vol 0..1
  function tone(type, f0, f1, t0, dur, vol) {
    if (voices >= MAX_VOICES) return;
    var osc = ac.createOscillator();
    var g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    voices++;
    osc.onended = function () {
      voices--;
      try { osc.disconnect(); g.disconnect(); } catch (e) {}
    };
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // note helper: semitone offset from A4 -> Hz
  function hz(semi) { return 440 * Math.pow(2, semi / 12); }

  var SOUNDS = {
    // short rising arpeggio, confident — C5 E5 G5 C6
    start: function (t) {
      var seq = [3, 7, 10, 15];
      for (var i = 0; i < seq.length; i++) {
        tone('square', hz(seq[i]), hz(seq[i]), t + i * 0.07, i === 3 ? 0.18 : 0.08, 0.22);
      }
    },
    // short blip, pitch rises
    jump: function (t) {
      tone('square', 240, 720, t, 0.12, 0.25);
    },
    // soft low thud, quiet
    land: function (t) {
      tone('triangle', 130, 55, t, 0.08, 0.14);
    },
    // bright two-note ping — B5 then E6
    coin: function (t) {
      tone('square', hz(14), hz(14), t, 0.06, 0.22);
      tone('square', hz(19), hz(19), t + 0.06, 0.16, 0.22);
    },
    // satisfying downward squash
    stomp: function (t) {
      tone('square', 420, 70, t, 0.16, 0.28);
      tone('triangle', 200, 40, t, 0.14, 0.2);
    },
    // harsh descending, not long
    hurt: function (t) {
      tone('sawtooth', 440, 90, t, 0.3, 0.26);
      tone('square', 330, 60, t + 0.02, 0.28, 0.14);
    },
    // 6-note flourish, the payoff — C5 E5 G5 C6 E6 G6, last held
    goal: function (t) {
      var seq = [3, 7, 10, 15, 19, 22];
      for (var i = 0; i < seq.length; i++) {
        var last = i === seq.length - 1;
        tone('square', hz(seq[i]), hz(seq[i]), t + i * 0.09, last ? 0.5 : 0.1, 0.2);
        tone('triangle', hz(seq[i] - 12), hz(seq[i] - 12), t + i * 0.09, last ? 0.5 : 0.1, 0.16);
      }
    },
    // ---- contra layer (bee contra) ----
    // dry pop, quick, the pea-shooter
    shoot: function (t) {
      tone('square', 880, 220, t, 0.05, 0.16);
    },
    // three pops fanned out — the spread gun
    spread: function (t) {
      tone('square', 760, 240, t, 0.06, 0.14);
      tone('square', 640, 200, t + 0.02, 0.06, 0.12);
      tone('square', 520, 170, t + 0.04, 0.06, 0.1);
    },
    // rising zap, a beam charging up
    laser: function (t) {
      tone('sawtooth', 180, 1400, t, 0.14, 0.14);
      tone('square', 90, 700, t + 0.01, 0.12, 0.08);
    },
    // short crunch downward — a soldier folding
    enemyDie: function (t) {
      tone('square', 300, 60, t, 0.12, 0.22);
      tone('sawtooth', 150, 40, t + 0.01, 0.1, 0.12);
    },
    // metallic clink off a shield
    turretHit: function (t) {
      tone('triangle', 1500, 900, t, 0.04, 0.18);
      tone('square', 2200, 1600, t, 0.03, 0.08);
    },
    // heavy thunk, deeper than turretHit
    bossHit: function (t) {
      tone('square', 240, 110, t, 0.09, 0.24);
      tone('triangle', 900, 400, t, 0.05, 0.12);
    },
    // long descending rumble with a bright crack on top
    bossDie: function (t) {
      tone('sawtooth', 220, 30, t, 0.9, 0.3);
      tone('square', 110, 25, t + 0.05, 0.8, 0.2);
      tone('square', 1600, 200, t, 0.18, 0.18);
      tone('triangle', 60, 20, t + 0.2, 0.7, 0.24);
    },
    // two-note lift, brighter than coin — new gun in hand
    pickup: function (t) {
      tone('square', hz(10), hz(10), t, 0.07, 0.2);
      tone('square', hz(17), hz(17), t + 0.07, 0.12, 0.2);
      tone('triangle', hz(22), hz(22), t + 0.14, 0.18, 0.16);
    }
  };

  // ---------- particles ----------
  function spawn(x, y, color, count) {
    var n = count | 0;
    if (n <= 0) n = 8;
    var spd = 220;
    if (reducedMotion) { n = Math.max(1, n >> 1); spd = 110; }
    for (var i = 0; i < MAX_P && n > 0; i++) {
      var p = P[i];
      if (p.on) continue;
      var a = Math.random() * Math.PI * 2;
      var s = spd * (0.35 + Math.random() * 0.65);
      p.on = true;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s - spd * 0.35;   // slight upward bias
      p.max = 0.3 + Math.random() * 0.4;
      p.life = p.max;
      p.size = 2 + (Math.random() * 3) | 0;
      p.color = color || '#fff';
      n--;
    }
  }

  // ======================================================================
  // MUSIC — two synthesized tracks on a lookahead scheduler.
  //   "apoapsis": slow, wide, patient. Swells with musicIntensity().
  //   "contra":   NES run-and-gun. Original tune. Does not breathe.
  // ======================================================================
  var musicBus = null;       // GainNode → master
  var MUSIC_VOL = 0.16;      // polite; SFX master is 0.5
  var musicMuted = false;
  var tracks = [];           // live track states (crossfade means up to 2)
  var current = null;
  var pendingMusic = null;   // name requested before the context could run
  var intensity = 0, intensitySm = 0;
  var musicLevelN = 0;
  var musicTimer = null;
  var LOOKAHEAD = 0.30, TICK_MS = 60;
  var noiseBuf = null, pulse25 = null;

  function m2hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function ensureMusicBus() {
    if (musicBus) return;
    musicBus = ac.createGain();
    musicBus.gain.value = musicMuted ? 0 : MUSIC_VOL;
    musicBus.connect(master);
    // 1s of white noise for drums
    var n = ac.sampleRate | 0;
    noiseBuf = ac.createBuffer(1, n, ac.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    // 25% pulse wave via Fourier series: b_n = 2/(nπ) · sin(nπ·duty)
    var N = 32, re = new Float32Array(N), im = new Float32Array(N);
    for (var k = 1; k < N; k++) im[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25);
    pulse25 = ac.createPeriodicWave(re, im);
    try { document.addEventListener('visibilitychange', onVis); } catch (e) {}
  }

  function onVis() {
    try {
      if (!musicBus) return;
      var g = (document.hidden || musicMuted) ? 0 : MUSIC_VOL;
      musicBus.gain.setTargetAtTime(g, ac.currentTime, 0.1);
    } catch (e) {}
  }

  // one music voice. type = oscillator type string, or 'pulse' for the 25% wave.
  function mv(dest, type, f0, f1, t0, dur, vol, atk, rel, detune) {
    var o = ac.createOscillator(), g = ac.createGain();
    if (type === 'pulse') o.setPeriodicWave(pulse25); else o.type = type;
    if (detune) o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    atk = atk || 0.005; rel = rel || 0.05;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + atk);
    g.gain.setValueAtTime(vol, t0 + Math.max(atk, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + rel);
    o.connect(g); g.connect(dest);
    o.onended = function () { try { o.disconnect(); g.disconnect(); } catch (e) {} };
    o.start(t0); o.stop(t0 + dur + rel + 0.02);
  }

  // noise hit through a filter: for hats and snares
  function mnoise(dest, t0, dur, vol, ftype, freq) {
    var s = ac.createBufferSource(), g = ac.createGain(), f = ac.createBiquadFilter();
    s.buffer = noiseBuf;
    f.type = ftype; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.onended = function () { try { s.disconnect(); f.disconnect(); g.disconnect(); } catch (e) {} };
    s.start(t0); s.stop(t0 + dur + 0.01);
  }

  // ---- track: apoapsis --------------------------------------------------
  // 66 bpm, 8th-note steps, 8 bars. A minor: i VI III VII | i VI iv V — the V
  // is the "somewhere to go". Chord tones as semitones above the root.
  var APO_CHORDS = [
    [0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5],
    [0, 3, 7], [-4, 0, 3], [-7, -4, 0], [-5, -1, 2]
  ];
  var APO_PATTERN = [0, 1, 2, 3, 4, 3, 2, 1];   // index into [r, 3, 5, r+12, 3+12]

  function makeApoapsis() {
    var out = ac.createGain(); out.gain.value = 0;
    out.connect(musicBus);
    // arp → lowpass → out ; pad → lowpass → out ; both → delay → out (wet)
    var arpF = ac.createBiquadFilter(); arpF.type = 'lowpass'; arpF.Q.value = 0.7; arpF.frequency.value = 600;
    var padF = ac.createBiquadFilter(); padF.type = 'lowpass'; padF.Q.value = 0.5; padF.frequency.value = 260;
    var dry = ac.createGain(); dry.gain.value = 1;
    var delay = ac.createDelay(1.0); delay.delayTime.value = 0.68;
    var fb = ac.createGain(); fb.gain.value = 0.38;
    var wet = ac.createGain(); wet.gain.value = 0.15;
    arpF.connect(dry); padF.connect(dry); dry.connect(out);
    arpF.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(out);
    var shimmer = ac.createGain(); shimmer.gain.value = 0; shimmer.connect(delay); shimmer.connect(out);
    var bpm = 66, stepDur = 60 / bpm / 2;
    var tr = {
      name: 'apoapsis', out: out, stepDur: stepDur, step: 0, next: ac.currentTime + 0.05,
      trans: 0,
      breathe: function (v) {
        // v = smoothed intensity 0..1. Open the filters, bring in the shimmer, widen.
        var t = ac.currentTime;
        var base = [600, 480, 380][Math.min(2, musicLevelN)];
        arpF.frequency.setTargetAtTime(base + v * v * 5200, t, 0.08);
        padF.frequency.setTargetAtTime(260 + v * 1700, t, 0.12);
        wet.gain.setTargetAtTime(0.15 + v * 0.3, t, 0.15);
        shimmer.gain.setTargetAtTime(v * v * 0.9, t, 0.1);
      },
      schedule: function (t, step) {
        var bar = (step >> 3) % 8, s = step & 7;
        if (s === 0) tr.trans = [0, -2, -5][Math.min(2, musicLevelN)];   // key drops per level, on the bar
        var root = 57 + tr.trans;                                       // A3
        var ch = APO_CHORDS[bar];
        var tones = [ch[0], ch[1], ch[2], ch[0] + 12, ch[1] + 12];
        // arpeggio: triangle, long tail so notes overlap into a wash
        var m = root + tones[APO_PATTERN[s]];
        mv(arpF, 'triangle', m2hz(m), 0, t, stepDur * 0.9, 0.5, 0.02, 1.4);
        // shimmer: the counter-voice two octaves up, only audible while reaching
        mv(shimmer, 'sine', m2hz(m + 24), 0, t + stepDur * 0.5, stepDur * 0.6, 0.35, 0.03, 0.9);
        if (s === 0) {
          // pad: two detuned saws + a sine sub, one bar, slow attack
          var barDur = stepDur * 8;
          for (var i = 0; i < 3; i++) {
            var f = m2hz(root + ch[i]);
            mv(padF, 'sawtooth', f, 0, t, barDur, 0.09, 0.7, 0.8, -6);
            mv(padF, 'sawtooth', f, 0, t, barDur, 0.09, 0.7, 0.8, 6);
          }
          mv(padF, 'sine', m2hz(root + ch[0] - 12), 0, t, barDur, 0.4, 0.3, 0.6);
        }
      }
    };
    return tr;
  }

  // ---- track: contra ------------------------------------------------------
  // 150 bpm, 16th-note steps, 8 bars in E minor. Original hook. No apologies.
  var CON_CHORDS = [   // per bar: root midi, chord tones (semitones)
    [52, [0, 3, 7]], [52, [0, 3, 7]], [48, [0, 4, 7]], [50, [0, 4, 7]],
    [52, [0, 3, 7]], [52, [0, 3, 7]], [48, [0, 4, 7]], [47, [0, 4, 7]]
  ];
  var CON_BASS = [0, 12, 7, 12, 0, 12, 7, 10];   // 8ths, semitones from root
  // lead: [step-in-bar, midi, length in steps] per bar
  var CON_LEAD = [
    [[0, 76, 2], [2, 79, 2], [4, 81, 3], [8, 83, 2], [10, 81, 2], [12, 79, 2], [14, 76, 2]],
    [[0, 74, 2], [2, 76, 2], [4, 79, 4], [8, 74, 2], [10, 76, 2], [12, 71, 4]],
    [[0, 72, 2], [2, 76, 2], [4, 79, 3], [8, 84, 2], [10, 83, 2], [12, 79, 2], [14, 76, 2]],
    [[0, 74, 2], [2, 78, 2], [4, 81, 4], [8, 83, 2], [10, 81, 2], [12, 78, 2], [14, 74, 2]],
    [[0, 76, 2], [2, 79, 2], [4, 81, 3], [8, 83, 2], [10, 81, 2], [12, 79, 2], [14, 76, 2]],
    [[0, 74, 2], [2, 76, 2], [4, 79, 4], [8, 74, 2], [10, 76, 2], [12, 71, 4]],
    [[0, 72, 2], [2, 76, 2], [4, 79, 3], [8, 84, 2], [10, 83, 2], [12, 79, 2], [14, 76, 2]],
    [[0, 71, 2], [2, 75, 2], [4, 78, 3], [8, 83, 4], [12, 87, 4]]
  ];
  var CON_KICK = [0, 6, 8, 10], CON_SNARE = [4, 12];

  function makeContra() {
    var out = ac.createGain(); out.gain.value = 0;
    out.connect(musicBus);
    var bpm = 150, stepDur = 60 / bpm / 4;
    var tr = {
      name: 'contra', out: out, stepDur: stepDur, step: 0, next: ac.currentTime + 0.05,
      breathe: function () {},
      schedule: function (t, step) {
        var bar = (step >> 4) % 8, s = step & 15;
        var root = CON_CHORDS[bar][0], ch = CON_CHORDS[bar][1];
        // arp pulse: 16ths through r 3 5 r+12
        var tones = [ch[0], ch[1], ch[2], ch[0] + 12];
        mv(out, 'pulse', m2hz(root + 12 + tones[s & 3]), 0, t, stepDur * 0.5, 0.11, 0.003, 0.02);
        // bass: triangle 8ths, octave bounce
        if ((s & 1) === 0) mv(out, 'triangle', m2hz(root - 12 + CON_BASS[s >> 1]), 0, t, stepDur * 1.6, 0.42, 0.004, 0.03);
        // lead: square
        var notes = CON_LEAD[bar];
        for (var i = 0; i < notes.length; i++) {
          if (notes[i][0] === s) mv(out, 'square', m2hz(notes[i][1]), 0, t, stepDur * notes[i][2] * 0.85, 0.2, 0.004, 0.03);
        }
        // drums
        for (i = 0; i < CON_KICK.length; i++) if (CON_KICK[i] === s) mv(out, 'sine', 160, 45, t, 0.11, 0.6, 0.002, 0.03);
        for (i = 0; i < CON_SNARE.length; i++) if (CON_SNARE[i] === s) {
          mnoise(out, t, 0.13, 0.35, 'bandpass', 1800);
          mv(out, 'triangle', 220, 120, t, 0.06, 0.3, 0.002, 0.02);
        }
        if ((s & 1) === 0) mnoise(out, t, (s & 2) ? 0.05 : 0.03, (s & 2) ? 0.12 : 0.08, 'highpass', 7000);
      }
    };
    return tr;
  }

  // ---- scheduler + crossfade --------------------------------------------
  function musicTick() {
    try {
      var horizon = ac.currentTime + LOOKAHEAD;
      for (var i = 0; i < tracks.length; i++) {
        var tr = tracks[i];
        if (tr.dead) continue;
        while (tr.next < horizon) {
          tr.schedule(tr.next, tr.step);
          tr.step++;
          tr.next += tr.stepDur;
        }
      }
      // sweep tracks that finished fading out
      for (i = tracks.length - 1; i >= 0; i--) {
        if (tracks[i].dead && ac.currentTime > tracks[i].deadAt) {
          try { tracks[i].out.disconnect(); } catch (e) {}
          tracks.splice(i, 1);
        }
      }
      if (!tracks.length && musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    } catch (e) {}
  }

  function fadeOut(tr, secs) {
    var t = ac.currentTime;
    tr.out.gain.cancelScheduledValues(t);
    tr.out.gain.setValueAtTime(tr.out.gain.value, t);
    tr.out.gain.linearRampToValueAtTime(0, t + secs);
    tr.dead = true; tr.deadAt = t + secs + 0.1;
  }

  function startMusic(name) {
    ensureMusicBus();
    if (current && current.name === name && !current.dead) return;
    var tr = name === 'contra' ? makeContra() : name === 'apoapsis' ? makeApoapsis() : null;
    if (!tr) return;
    var t = ac.currentTime;
    if (current && !current.dead) fadeOut(current, 1.5);
    tr.out.gain.setValueAtTime(0, t);
    tr.out.gain.linearRampToValueAtTime(1, t + 1.5);
    tracks.push(tr);
    current = tr;
    if (!musicTimer) musicTimer = setInterval(musicTick, TICK_MS);
    musicTick();
  }

  function flushPendingMusic() {
    if (pendingMusic && ac && ac.state === 'running') {
      var n = pendingMusic; pendingMusic = null;
      startMusic(n);
    }
  }

  var lastMusicTry = 0;

  // ---------- public ----------
  window.JUICE = {
    init: function (c) {
      try { canvas = c || null; } catch (e) {}
    },

    sfx: function (name) {
      try {
        var fn = SOUNDS[name];
        if (!fn) return;
        if (!ensureAudio()) return;
        flushPendingMusic();
        var now = ac.currentTime;
        if (lastFire[name] !== undefined && now - lastFire[name] < DEDUPE) return;
        lastFire[name] = now;
        fn(now);
      } catch (e) { /* silent by design */ }
    },

    shake: function (power) {
      try {
        var p = +power;
        if (!(p > 0)) return;
        if (p > 1) p = 1;
        trauma = Math.min(1, trauma + p);
      } catch (e) {}
    },

    burst: function (x, y, color, count) {
      try { spawn(+x || 0, +y || 0, color, count); } catch (e) {}
    },

    hitstop: function (frames) {
      try {
        var f = frames | 0;
        if (f > stopFrames) stopFrames = f;
      } catch (e) {}
    },

    frozen: function () {
      return stopFrames > 0;
    },

    musicStart: function (name) {
      try {
        name = String(name || '');
        if (name !== 'apoapsis' && name !== 'contra') return;
        if (ensureAudio()) startMusic(name);
        else pendingMusic = name;
      } catch (e) {}
    },

    musicStop: function () {
      try {
        pendingMusic = null;
        if (current && !current.dead) fadeOut(current, 1.2);
        current = null;
      } catch (e) {}
    },

    musicIntensity: function (v) {
      try {
        v = +v; if (!(v >= 0)) v = 0; if (v > 1) v = 1;
        intensity = v;
      } catch (e) {}
    },

    musicLevel: function (n) {
      try { musicLevelN = Math.max(0, n | 0); } catch (e) {}
    },

    musicMute: function (on) {
      try {
        musicMuted = !!on;
        if (musicBus) musicBus.gain.setTargetAtTime(musicMuted ? 0 : MUSIC_VOL, ac.currentTime, 0.05);
      } catch (e) {}
    },

    update: function (dt) {
      try {
        var d = +dt; if (!(d > 0)) d = 1 / 60;

        if (stopFrames > 0) stopFrames--;

        // music: smooth the reach signal and let the score breathe; retry a
        // pending start every half second until the context is allowed to run
        intensitySm += (intensity - intensitySm) * 0.08;
        if (current && !current.dead) current.breathe(intensitySm);
        if (pendingMusic) {
          var nowMs = Date.now();
          if (nowMs - lastMusicTry > 500) { lastMusicTry = nowMs; if (ensureAudio()) flushPendingMusic(); }
        }

        // shake: trauma decays linearly, offset scales with trauma^2
        if (trauma > 0) {
          trauma -= d * 2.2;
          if (trauma < 0) trauma = 0;
          var amp = trauma * trauma * MAX_SHAKE;
          shakeSeed += d * 60;
          shakeX = amp * (Math.random() * 2 - 1);
          shakeY = amp * (Math.random() * 2 - 1);
        } else { shakeX = 0; shakeY = 0; }

        // particles
        for (var i = 0; i < MAX_P; i++) {
          var p = P[i];
          if (!p.on) continue;
          p.life -= d;
          if (p.life <= 0) { p.on = false; continue; }
          p.vy += GRAV * d;
          p.vx *= DRAG; p.vy *= DRAG;
          p.x += p.vx * d;
          p.y += p.vy * d;
        }
      } catch (e) {}
    },

    draw: function (ctx, camX, camY) {
      try {
        if (!ctx) return;
        var cx = +camX || 0, cy = +camY || 0;
        var prevAlpha = ctx.globalAlpha;
        var prevFill = ctx.fillStyle;
        for (var i = 0; i < MAX_P; i++) {
          var p = P[i];
          if (!p.on) continue;
          var k = p.life / p.max;
          ctx.globalAlpha = k;
          ctx.fillStyle = p.color;
          var s = p.size * (0.5 + k * 0.5);
          ctx.fillRect((p.x - cx - s * 0.5) | 0, (p.y - cy - s * 0.5) | 0, s | 0 || 1, s | 0 || 1);
        }
        ctx.globalAlpha = prevAlpha;
        ctx.fillStyle = prevFill;
      } catch (e) {}
    },

    shakeOffset: function () {
      if (reducedMotion) return { x: 0, y: 0 };
      return { x: shakeX, y: shakeY };
    }
  };
})();
