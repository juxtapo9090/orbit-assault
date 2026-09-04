/* net.js — lockstep lobby + input exchange for contra-orbit (CONTRACT §6, plus
   mid-game join / "hot swap").

   Talks JSON text frames to relay.py over a WebSocket. Dependency-free.
   window.NET is the default instance; NET.create() makes an independent one
   (used by test_net.js to run several clients in one process).

   ---------------------------------------------------------------------
   SLOT MODEL — the core always simulates 5 slots from tick 0.
   ---------------------------------------------------------------------
   A slot is dormant (frozen, invisible, input byte always 0) until it is
   ACTIVATED at a tick the relay picks and broadcasts to everybody. So
   `nPlayers` is always 5 and `inputsFor(tick)` always returns 5 bytes.

   Per slot we keep the *spans* `[from, to)` of ticks during which that slot
   was a live player. Outside every span the slot's byte is 0 and no input is
   awaited; inside one, the byte must arrive before the tick can run. A slot
   that drops and is re-taken by a newcomer has two spans, so replaying the
   history of such a room stays byte-exact.

   Mid-game join: `join()` on a started room resolves with
       {room, slot, resume:{seed, nPlayers, joinTick, inputsByTick,
                            logFrom, logTo, spans}}
   `inputsByTick(tick)` reads the replayed log directly; `inputsFor(tick)`
   answers for those historical ticks too (log for the past, live buffer for
   the present, live values winning when both exist). `status().catchingUp`
   stays true until the core calls `caughtUp()`.

   `status().joinTick` is the tick MY slot goes live: null before the room
   starts, 0 for a founder, the relay's future tick for a latecomer.
   `onDrop(cb)` now calls `cb(slot, tick)` — `tick` is the first tick the
   leaver never sent input for, so every peer zeroes the slot at the same
   tick. The one-argument form callers already use is unchanged.
*/
(function (root) {
  "use strict";

  var KEEP = 120;          // ticks of input history kept behind the newest queried tick
  var STALL_CALLS = 30;    // consecutive null inputsFor() → status().stalled
  var PING_MS = 1000;
  var SLOTS = 5;           // the sim always has this many slots

  var b64decode = (function () {
    if (typeof atob === "function") {
      return function (s) {
        var bin = atob(s), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      };
    }
    return function (s) {
      var b = Buffer.from(s, "base64");
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    };
  })();

  function create() {
    var ws = null, connected = false, room = null, slot = -1, nPlayers = 0;
    var rttMs = -1, pingTimer = null;
    var buf = {};            // tick -> plain array [byte per slot] (holes = not arrived)
    var lowTick = 0;         // lowest tick still possibly in buf
    var spans = [];          // slot -> [[from, to|null], ...]
    var nullStreak = 0;
    var cbLobby = [], cbStart = [], cbDrop = [], cbActivate = [];
    var lobbyState = null;
    var resume = null;       // resume payload once a mid-game join landed
    var logBytes = null, logFrom = 0, logTo = -1, logSlots = SLOTS;
    var joinTick = null, catchingUp = false;
    // WebRTC is optional: the WebSocket stays authoritative for the input log
    // and carries only peers which do not have an open data channel.
    var players = {}, pcs = {}, started = false;
    var RTC = root.RTCPeerConnection;
    var ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

    function fire(list, arg, arg2) {
      for (var i = 0; i < list.length; i++) {
        try { list[i](arg, arg2); } catch (e) { if (root.console) console.error(e); }
      }
    }

    function send(obj) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    }

    function peerSlots() { var out = []; for (var k in players) if (+k !== slot) out.push(+k); return out; }
    function rtcSend(to, obj) { send({ t: obj.t, to: to, sdp: obj.sdp, candidate: obj.candidate }); }
    function p2pUp(s) { var p = pcs[s]; return !!(p && p.dc && p.dc.readyState === "open"); }
    function wireChannel(s, p, dc) {
      p.dc = dc;
      dc.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.t === "in" && typeof m.tick === "number" && typeof m.byte === "number") put(s, m.tick, m.byte); };
      dc.onclose = function () { p.state = "closed"; };
      dc.onerror = function () { p.state = "error"; };
    }
    function ensurePeer(s) {
      if (!RTC || s === slot) return null;
      if (pcs[s]) return pcs[s];
      var pc = new RTC(ICE), p = pcs[s] = { pc: pc, dc: null, candidates: [], state: "connecting" };
      pc.onicecandidate = function (ev) { if (ev.candidate) rtcSend(s, { t: "ice", candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate }); };
      pc.onconnectionstatechange = function () { p.state = pc.connectionState || p.state; if (p.state === "failed") try { pc.close(); } catch (e) {} };
      pc.ondatachannel = function (ev) { wireChannel(s, p, ev.channel); };
      return p;
    }
    function flushCandidates(p) { var q = p.candidates.splice(0); for (var i = 0; i < q.length; i++) p.pc.addIceCandidate(q[i]).catch(function () {}); }
    // One deterministic offerer prevents WebRTC offer glare on lobby updates.
    function offerPeer(s) {
      if (!RTC || s <= slot) return;
      var p = ensurePeer(s); if (!p || p.offerStarted) return;
      p.offerStarted = true;
      wireChannel(s, p, p.pc.createDataChannel("contra-input", { ordered: false, maxRetransmits: 0 }));
      p.pc.createOffer().then(function (offer) { return p.pc.setLocalDescription(offer); }).then(function () { rtcSend(s, { t: "offer", sdp: p.pc.localDescription }); }).catch(function () { p.state = "failed"; });
    }
    function connectPeers() { if (!started || !RTC) return; var all = peerSlots(); for (var i = 0; i < all.length; i++) offerPeer(all[i]); }
    function receiveOffer(m) {
      if (!RTC || typeof m.from !== "number") return;
      var p = ensurePeer(m.from); if (!p) return;
      p.pc.setRemoteDescription(m.sdp).then(function () { flushCandidates(p); return p.pc.createAnswer(); }).then(function (answer) { return p.pc.setLocalDescription(answer); }).then(function () { rtcSend(m.from, { t: "answer", sdp: p.pc.localDescription }); }).catch(function () { p.state = "failed"; });
    }
    function receiveAnswer(m) { var p = pcs[m.from]; if (p && m.sdp) p.pc.setRemoteDescription(m.sdp).then(function () { flushCandidates(p); }).catch(function () { p.state = "failed"; }); }
    function receiveIce(m) { if (!RTC || typeof m.from !== "number" || !m.candidate) return; var p = ensurePeer(m.from); if (p.pc.remoteDescription) p.pc.addIceCandidate(m.candidate).catch(function () {}); else p.candidates.push(m.candidate); }

    function resetSpans() {
      spans = [];
      for (var i = 0; i < SLOTS; i++) spans[i] = [];
    }

    function openSpan(s, tick) {
      if (!spans[s]) spans[s] = [];
      var list = spans[s];
      for (var i = 0; i < list.length; i++) if (list[i][0] === tick && list[i][1] === null) return;
      list.push([tick, null]);
    }

    function closeSpan(s, tick) {
      var list = spans[s] || [];
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i][1] === null) { list[i][1] = Math.max(list[i][0], tick); return; }
      }
    }

    // Was slot `s` a live player on `tick`?
    function activeAt(s, tick) {
      var list = spans[s];
      if (!list) return false;
      for (var i = 0; i < list.length; i++) {
        if (tick >= list[i][0] && (list[i][1] === null || tick < list[i][1])) return true;
      }
      return false;
    }

    function put(s, tick, byte) {
      if (tick < lowTick) return;             // too old, already pruned
      var row = buf[tick];
      if (!row) { row = buf[tick] = []; }
      row[s] = byte & 255;
    }

    function prune(upTo) {
      // drop everything older than upTo-KEEP
      var limit = upTo - KEEP;
      while (lowTick < limit) { delete buf[lowTick]; lowTick++; }
    }

    // One row out of the replayed log, or null when the tick isn't covered.
    function logRow(tick) {
      if (!logBytes || tick < logFrom || tick > logTo) return null;
      var off = (tick - logFrom) * logSlots;
      return logBytes.subarray(off, off + logSlots);
    }

    function applyResume(head, packed) {
      resume = head;
      logBytes = packed;
      logFrom = head.logFrom;
      logTo = head.logTo;
      logSlots = head.slots || SLOTS;
      joinTick = head.joinTick;
      catchingUp = true;
      nPlayers = head.nPlayers;
      started = true;
      resetSpans();
      for (var s = 0; s < SLOTS; s++) {
        var src = (head.spans && head.spans[s]) || [];
        for (var i = 0; i < src.length; i++) spans[s].push([src[i][0], src[i][1]]);
      }
      // Historical ticks are answered from the log; the live buffer only has
      // to hold what arrives from here on.
      lowTick = logFrom;
      fire(cbStart, { seed: head.seed, nPlayers: nPlayers, mySlot: slot, resume: resumeInfo() });
      connectPeers();
    }

    function resumeInfo() {
      if (!resume) return null;
      return {
        seed: resume.seed, nPlayers: resume.nPlayers, joinTick: resume.joinTick,
        logFrom: logFrom, logTo: logTo, slots: logSlots,
        spans: spans, inputsByTick: inputsByTick
      };
    }

    function inputsByTick(tick) {
      var r = logRow(tick);
      if (!r) return null;
      return new Uint8Array(r);
    }

    function onMessage(ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.t) {
        case "in":
          put(m.slot, m.tick, m.byte);
          break;
        case "lobby":
          lobbyState = m;
          players = {};
          for (var lp = 0; lp < m.players.length; lp++) players[m.players[lp].slot] = m.players[lp].name;
          fire(cbLobby, { room: m.room, players: m.players, hostSlot: m.hostSlot });
          connectPeers();
          break;
        case "start":
          nPlayers = m.nPlayers;
          started = true;
          resetSpans();       // activate frames follow and open the founders' spans
          fire(cbStart, { seed: m.seed, nPlayers: nPlayers, mySlot: slot });
          connectPeers();
          break;
        case "activate":
          openSpan(m.slot, m.tick);
          if (m.slot === slot) { joinTick = m.tick; }
          fire(cbActivate, { slot: m.slot, tick: m.tick, name: m.name });
          break;
        case "drop":
          closeSpan(m.slot, typeof m.tick === "number" ? m.tick : 0);
          fire(cbDrop, m.slot, m.tick);
          break;
        case "pong":
          rttMs = Date.now() - m.ts;
          break;
        case "offer": receiveOffer(m); break;
        case "answer": receiveAnswer(m); break;
        case "ice": receiveIce(m); break;
      }
    }

    function connect(url) {
      return new Promise(function (resolve, reject) {
        var W = root.WebSocket;
        if (!W) { reject(new Error("no WebSocket in this environment")); return; }
        var sock = new W(url);
        sock.onopen = function () {
          ws = sock; connected = true;
          send({ t: "ping", ts: Date.now() });
          pingTimer = setInterval(function () { send({ t: "ping", ts: Date.now() }); }, PING_MS);
          resolve(sock);
        };
        sock.onerror = function () { if (!connected) reject(new Error("websocket error connecting to " + url)); };
        sock.onclose = function () {
          connected = false;
          if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
          /* Drop the handle, not just the flag. Keeping a closed socket in `ws`
             made every retry after a failed join fail with "already connected"
             (or, once the browser had also fired onerror, "websocket error") —
             one bad room code and the player was locked out until a reload. */
          if (ws === sock) { ws = null; if (!nPlayers) { room = null; slot = -1; } }
        };
        sock.onmessage = onMessage;
      });
    }

    // Wait for the first "joined" / "resume" / "err" reply after connect.
    // A chunked resume resolves only once its "logend" has landed.
    function enter(url, msg) {
      if (ws) return Promise.reject(new Error("already connected (room " + room + ")"));
      return connect(url).then(function (sock) {
        return new Promise(function (resolve, reject) {
          var prev = sock.onmessage;
          var head = null, chunks = [], nbytes = 0;

          function finish() {
            var packed;
            if (head.log !== undefined) {
              packed = b64decode(head.log);
            } else {
              packed = new Uint8Array(nbytes);
              var off = 0;
              for (var i = 0; i < chunks.length; i++) { packed.set(chunks[i], off); off += chunks[i].length; }
            }
            var want = (head.logTo - head.logFrom + 1) * (head.slots || SLOTS);
            if (head.logTo < head.logFrom) want = 0;
            if (packed.length !== want) {
              sock.onmessage = prev;
              reject(new Error("resume log is " + packed.length + " bytes, expected " + want));
              return;
            }
            room = head.room; slot = head.slot;
            applyResume(head, packed);
            sock.onmessage = prev;
            resolve({ room: room, slot: slot, resume: resumeInfo() });
          }

          sock.onmessage = function (ev) {
            var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.t === "joined") {
              room = m.room; slot = m.slot;
              sock.onmessage = prev;
              resolve({ room: room, slot: slot, resume: null });
            } else if (m.t === "resume") {
              head = m;
              if (!m.chunked) finish();
            } else if (m.t === "logchunk" && head) {
              var d = b64decode(m.data);
              chunks.push(d); nbytes += d.length;
            } else if (m.t === "logend" && head) {
              finish();
            } else if (m.t === "err") {
              sock.onmessage = prev;
              if (ws === sock) ws = null;
              connected = false; room = null; slot = -1;
              try { sock.close(); } catch (e) {}
              reject(new Error(m.msg));
            } else {
              prev(ev);
            }
          };
          send(msg);
        });
      });
    }

    var api = {
      host: function (o) { return enter(o.url, { t: "host", name: o.name || "" }); },
      join: function (o) { return enter(o.url, { t: "join", room: String(o.room || "").toUpperCase(), name: o.name || "" }); },
      onLobby: function (cb) { cbLobby.push(cb); },
      onStart: function (cb) { cbStart.push(cb); },
      onDrop: function (cb) { cbDrop.push(cb); },
      onActivate: function (cb) { cbActivate.push(cb); },
      start: function (seed) { send({ t: "start", seed: seed }); },

      pushInput: function (tick, byte) {
        byte = byte & 255;
        put(slot, tick, byte);                 // echo own input locally
        var fallback = peerSlots();
        for (var i = fallback.length - 1; i >= 0; i--) {
          var s = fallback[i], p = pcs[s];
          if (p2pUp(s)) { try { p.dc.send(JSON.stringify({ t: "in", tick: tick, byte: byte })); fallback.splice(i, 1); } catch (e) { p.state = "error"; } }
        }
        send({ t: "in", tick: tick, byte: byte, to: fallback });
      },

      inputsFor: function (tick) {
        if (!nPlayers) return null;
        prune(tick);
        var row = buf[tick];
        var hist = logRow(tick);
        var out = new Uint8Array(nPlayers);
        for (var s = 0; s < nPlayers; s++) {
          if (!activeAt(s, tick)) { out[s] = 0; continue; }
          if (row && row[s] !== undefined) { out[s] = row[s]; continue; }
          if (hist) { out[s] = hist[s]; continue; }
          nullStreak++;
          return null;
        }
        nullStreak = 0;
        return out;
      },

      // The core calls this once its replay has reached the live edge.
      caughtUp: function () { catchingUp = false; },
      resumeInfo: function () { return resumeInfo(); },

      status: function () {
        var total = 0, up = 0;
        for (var ps in players) if (+ps !== slot) { total++; if (p2pUp(+ps)) up++; }
        return { connected: connected, room: room, slot: slot, nPlayers: nPlayers,
                 rttMs: rttMs, stalled: nullStreak > STALL_CALLS,
                 joinTick: joinTick, catchingUp: catchingUp,
                 transport: !total || !RTC ? "WS" : (up === total ? "P2P" : (up ? "MIX" : "WS")),
                 p2pPeers: up, peerCount: total };
      },

      close: function () { for (var s in pcs) { try { pcs[s].pc.close(); } catch (e) {} } if (ws) ws.close(); },
      _socket: function () { return ws; },     // test hook: kill the underlying socket
      _spans: function () { return spans; },   // test hook
      _dropP2P: function (s) {                 // test hook: force relay fallback for one peer
        var p = pcs[s]; if (p && p.dc) p.dc.close();
      },
      create: create
    };
    return api;
  }

  root.NET = create();
})(typeof window !== "undefined" ? window : globalThis);
