// test_net.js — lockstep + mid-game join ("hot swap") proof against relay.py.
// node 20+ (global WebSocket). Starts its own relay on a spare port.
//
//   node test_net.js
//
// Case A  2 clients run 600 ticks, a 3rd joins mid-run and replays the log.
// Case B  a client drops mid-run, a new client takes the freed slot.
// Case C  the input-log cap really bounds relay memory.
// Plus    dashboard `/` 200 + `/status.json` valid JSON with log + joinable.

var { spawn } = require("child_process");
var net = require("net");
require("./net.js");
var NET = globalThis.NET;

var D = 3, SLOTS = 5;
var relays = [];

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function assert(c, msg) { if (!c) { throw new Error("FAIL: " + msg); } }
function inp(s, t) { return (((s + 1) * 37 + t * 11) & 255) || 1; }   // never 0, so "0" always means dormant

function freePort() {
  return new Promise(function (res, rej) {
    var s = net.createServer();
    s.listen(0, "127.0.0.1", function () { var p = s.address().port; s.close(function () { res(p); }); });
    s.on("error", rej);
  });
}

async function startRelay(extra) {
  var port = await freePort();
  var args = ["relay.py", "--port", String(port), "--bind", "127.0.0.1"].concat(extra || []);
  var p = spawn("python3", args, { cwd: __dirname, stdio: ["ignore", "ignore", "pipe"] });
  var err = "";
  p.stderr.on("data", function (d) { err += d.toString(); });
  relays.push(p);
  for (var i = 0; i < 100; i++) {
    await sleep(50);
    if (err.indexOf("relay listening") >= 0) return { port: port, proc: p, err: function () { return err; } };
    if (p.exitCode !== null) throw new Error("relay died: " + err);
  }
  throw new Error("relay never came up: " + err);
}

function http(port, path) {
  return new Promise(function (res, rej) {
    var s = net.connect(port, "127.0.0.1", function () {
      s.write("GET " + path + " HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    });
    var b = "";
    s.on("data", function (d) { b += d.toString(); });
    s.on("end", function () { res(b); });
    s.on("error", rej);
  });
}

// push a contiguous block of ticks from a set of clients, yielding to the loop
async function pushRange(clients, slots, from, to) {
  for (var t = from; t <= to; t++) {
    for (var i = 0; i < clients.length; i++) clients[i].pushInput(t, inp(slots[i], t));
    if ((t & 63) === 0) await sleep(0);
  }
  await sleep(0);
}

async function waitFor(fn, ms, what) {
  var end = Date.now() + ms;
  for (;;) {
    var v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("FAIL: timeout waiting for " + what);
    await sleep(5);
  }
}

function rowsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ----------------------------------------------------------------- cases

async function caseA(port) {
  console.log("\n=== CASE A — 2 players, 600 ticks, 3rd joins mid-run ===");
  var URL = "ws://127.0.0.1:" + port;
  var c = [NET.create(), NET.create(), NET.create()];
  var starts = [], acts = [[], [], []], lobbies = 0;
  for (var i = 0; i < 3; i++) {
    c[i].onStart((function (i) { return function (s) { starts[i] = s; }; })(i));
    c[i].onActivate((function (i) { return function (a) { acts[i].push(a); }; })(i));
    c[i].onLobby(function () { lobbies++; });
  }

  var h = await c[0].host({ url: URL, name: "host" });
  var j1 = await c[1].join({ url: URL, room: h.room, name: "p1" });
  assert(h.slot === 0 && j1.slot === 1 && j1.resume === null, "lobby join gets slot 1, no resume");
  await NET.create().join({ url: URL, room: "ZZZZ", name: "x" }).then(
    function () { assert(false, "bad room should reject"); },
    function (e) { console.log("  join bad room rejected: " + e.message); });

  c[0].start(42);
  await sleep(200);
  for (i = 0; i < 2; i++) {
    assert(starts[i] && starts[i].seed === 42, "start seed on " + i);
    assert(starts[i].nPlayers === 5, "nPlayers must be 5, got " + starts[i].nPlayers);
    assert(starts[i].mySlot === i, "mySlot " + i);
  }
  console.log("  start: seed=42 nPlayers=5 (5-slot model) on both founders");

  // founders activated at tick 0
  for (i = 0; i < 2; i++) {
    assert(acts[i].length === 2, "client " + i + " saw 2 founder activates, got " + acts[i].length);
    for (var k = 0; k < 2; k++) assert(acts[i][k].tick === 0, "founder activate tick 0");
  }
  var founderSlots = acts[0].map(function (a) { return a.slot; }).sort();
  assert(founderSlots[0] === 0 && founderSlots[1] === 1, "founder activates for slots 0 and 1");
  console.log("  activate: slots 0 and 1 at tick 0 on every peer (founders use the same path as latecomers)");

  // 600 ticks of lockstep between slots 0 and 1
  var TICKS = 600;
  await pushRange([c[0], c[1]], [0, 1], 0, TICKS + D - 1);

  // record locally what each founder sees, tick by tick
  var localRows = [];
  for (var t = 0; t <= TICKS; t++) {
    var r0 = await waitFor(function () { return c[0].inputsFor(t); }, 5000, "tick " + t + " on c0");
    var r1 = await waitFor(function () { return c[1].inputsFor(t); }, 5000, "tick " + t + " on c1");
    assert(r0.length === SLOTS && r1.length === SLOTS, "rows are 5 bytes");
    assert(rowsEqual(r0, r1), "founders agree at tick " + t);
    assert(r0[0] === inp(0, t) && r0[1] === inp(1, t), "real bytes at tick " + t);
    assert(r0[2] === 0 && r0[3] === 0 && r0[4] === 0, "dormant slots read 0 at tick " + t);
    localRows[t] = Uint8Array.from(r0);
  }
  console.log("  lockstep: ticks 0.." + TICKS + " identical 5-byte rows on both founders; slots 2-4 dormant = 0");

  // --- the hot swap ---
  var c2 = c[2];
  var j2 = await c2.join({ url: URL, room: h.room, name: "late" });
  assert(j2.slot === 2, "latecomer got slot 2, got " + j2.slot);
  assert(j2.resume, "join on a started room must resolve with a resume payload");
  var R = j2.resume;
  console.log("  resume: slot=" + j2.slot + " seed=" + R.seed + " nPlayers=" + R.nPlayers +
              " joinTick=" + R.joinTick + " log=" + R.logFrom + ".." + R.logTo +
              " (" + ((R.logTo - R.logFrom + 1) * R.slots) + " packed bytes)");
  assert(R.seed === 42, "resume carries the room's original seed");
  assert(R.nPlayers === 5, "resume nPlayers must be 5");
  assert(R.logFrom === 0, "log starts at tick 0, got " + R.logFrom);
  assert(R.logTo >= TICKS, "log must cover at least tick " + TICKS + ", got " + R.logTo);
  assert(R.joinTick > R.logTo, "joinTick must be in the future of the log");

  // decoded log must be byte-identical to what the founders recorded locally
  var bad = 0;
  for (t = 0; t <= TICKS; t++) {
    var row = R.inputsByTick(t);
    assert(row && row.length === SLOTS, "inputsByTick(" + t + ") is a 5-byte row");
    if (!rowsEqual(row, localRows[t])) { bad++; if (bad < 4) console.error("   tick " + t + " log=" + row + " local=" + localRows[t]); }
  }
  assert(bad === 0, bad + " decoded log rows differ from what the founders recorded");
  console.log("  replay: " + (TICKS + 1) + "/" + (TICKS + 1) + " decoded log rows byte-identical to the founders' local rows");

  // the same rows come back out of inputsFor() on the latecomer
  for (t = 0; t <= TICKS; t += 37) {
    assert(rowsEqual(c2.inputsFor(t), localRows[t]), "latecomer inputsFor(" + t + ") matches history");
  }
  console.log("  latecomer inputsFor() answers for historical ticks too (sampled every 37 ticks)");

  // everyone must have seen the same activate for slot 2
  await sleep(200);
  var seen = [];
  for (i = 0; i < 3; i++) {
    var a = acts[i].filter(function (x) { return x.slot === 2; });
    assert(a.length === 1, "client " + i + " saw exactly one activate for slot 2, got " + a.length);
    seen.push(a[0].tick);
    assert(a[0].name === "late", "activate carries the name");
  }
  assert(seen[0] === seen[1] && seen[1] === seen[2] && seen[0] === R.joinTick,
         "activate tick must match on all peers and equal joinTick: " + seen);
  console.log("  activate slot 2 @ tick " + seen[0] + " seen identically by all three peers");

  var st = c2.status();
  assert(st.joinTick === R.joinTick && st.catchingUp === true, "status catchingUp/joinTick: " + JSON.stringify(st));
  c2.caughtUp();
  assert(c2.status().catchingUp === false, "caughtUp() clears catchingUp");
  console.log("  status: joinTick=" + st.joinTick + " catchingUp=true → caughtUp() → false");

  // from joinTick on, all three are live players
  var JT = R.joinTick, END = JT + 60;
  await pushRange([c[0], c[1]], [0, 1], TICKS + D, END);
  await pushRange([c[0], c[1], c2], [0, 1, 2], JT, END);
  for (t = JT; t <= END; t++) {
    var rows = [
      await waitFor(function () { return c[0].inputsFor(t); }, 5000, "post-join tick " + t + " c0"),
      await waitFor(function () { return c[1].inputsFor(t); }, 5000, "post-join tick " + t + " c1"),
      await waitFor(function () { return c2.inputsFor(t); }, 5000, "post-join tick " + t + " c2")
    ];
    for (i = 0; i < 3; i++) {
      assert(rows[i].length === SLOTS, "5 bytes");
      assert(rowsEqual(rows[i], rows[0]), "peer " + i + " differs at tick " + t + ": " + rows[i] + " vs " + rows[0]);
    }
    assert(rows[0][2] === inp(2, t), "slot 2 is a real player at tick " + t);
    assert(rows[0][3] === 0 && rows[0][4] === 0, "slots 3,4 still dormant");
  }
  console.log("  post-join: ticks " + JT + ".." + END + " identical 5-byte rows on all three, slot 2 live");
  // and the tick just before activation still has slot 2 silent
  var pre = await waitFor(function () { return c2.inputsFor(JT - 1); }, 2000, "tick before joinTick");
  assert(pre[2] === 0, "slot 2 must read 0 at the tick before joinTick, got " + pre[2]);
  console.log("  boundary: tick " + (JT - 1) + " reads slot 2 = 0, tick " + JT + " reads " + inp(2, JT));

  console.log("CASE A PASS");
  return { clients: c, room: h.room, url: URL, localRows: localRows, end: END, joinTick: JT };
}

async function caseB(ctx) {
  console.log("\n=== CASE B — a player drops mid-run, a newcomer takes the freed slot ===");
  var c = ctx.clients, URL = ctx.url;
  var drops = [[], []];
  c[0].onDrop(function (s, t) { drops[0].push([s, t]); });
  c[2].onDrop(function (s, t) { drops[1].push([s, t]); });

  var lastAlive = ctx.end;
  c[1]._socket().close();
  await waitFor(function () { return drops[0].length && drops[1].length; }, 3000, "drop broadcast");
  await sleep(150);
  assert(drops[0][0][0] === 1 && drops[1][0][0] === 1, "onDrop(1) on both survivors");
  var deadAt = drops[0][0][1];
  assert(drops[0][0][1] === drops[1][0][1], "drop tick identical on both peers: " + drops[0][0][1] + " vs " + drops[1][0][1]);
  assert(deadAt === lastAlive + 1, "drop tick is last-sent+1: got " + deadAt + " want " + (lastAlive + 1));
  console.log("  drop: slot 1, deterministic dead-at tick " + deadAt + " (= its last input " + lastAlive + " + 1) on both peers");

  // survivors keep running without slot 1
  var END2 = deadAt + 80;
  await pushRange([c[0], c[2]], [0, 2], deadAt, END2);
  for (var t = deadAt; t <= END2; t++) {
    var r0 = await waitFor(function () { return c[0].inputsFor(t); }, 5000, "post-drop " + t + " c0");
    var r2 = await waitFor(function () { return c[2].inputsFor(t); }, 5000, "post-drop " + t + " c2");
    assert(rowsEqual(r0, r2), "survivors agree at tick " + t);
    assert(r0[1] === 0, "dropped slot 1 reads 0 at tick " + t);
  }
  console.log("  survivors: ticks " + deadAt + ".." + END2 + " agree, slot 1 = 0 throughout");

  // a newcomer takes slot 1
  var c3 = NET.create();
  var acts3 = [], acts0 = [], acts2 = [];
  c3.onActivate(function (a) { acts3.push(a); });
  c[0].onActivate(function (a) { acts0.push(a); });
  c[2].onActivate(function (a) { acts2.push(a); });
  var j3 = await c3.join({ url: URL, room: ctx.room, name: "retake" });
  assert(j3.slot === 1, "newcomer takes the freed slot 1, got " + j3.slot);
  var R = j3.resume;
  assert(R && R.seed === 42 && R.nPlayers === 5, "resume on the retaken slot");
  console.log("  retake: slot " + j3.slot + " joinTick=" + R.joinTick + " log=" + R.logFrom + ".." + R.logTo);

  // HISTORY MUST SURVIVE: slot 1's original inputs before the drop are still real
  var bad = 0;
  for (t = 0; t <= 600; t++) {
    if (!rowsEqual(R.inputsByTick(t), ctx.localRows[t])) bad++;
  }
  assert(bad === 0, bad + " history rows corrupted by the drop/retake");
  console.log("  history intact: 601 pre-drop rows still byte-identical (slot 1's old inputs are NOT zeroed)");

  // between deadAt and the new joinTick, slot 1 must read 0 on the newcomer too
  var gap = c3.inputsFor(deadAt + 5);
  assert(gap && gap[1] === 0, "slot 1 reads 0 in the gap between drop and re-activation");
  var pre = c3.inputsFor(600);
  assert(pre[1] === ctx.localRows[600][1], "slot 1 reads its ORIGINAL byte before the drop");
  console.log("  spans: slot 1 = real before tick " + deadAt + ", 0 in the gap, live again from " + R.joinTick);

  await sleep(200);
  var t1 = acts3.filter(function (a) { return a.slot === 1; });
  var t0 = acts0.filter(function (a) { return a.slot === 1; });
  var t2 = acts2.filter(function (a) { return a.slot === 1; });
  assert(t1.length === 1 && t0.length === 1 && t2.length === 1, "one activate for slot 1 on each peer");
  assert(t0[0].tick === t1[0].tick && t1[0].tick === t2[0].tick && t0[0].tick === R.joinTick,
         "activate tick identical on all three: " + [t0[0].tick, t1[0].tick, t2[0].tick]);
  console.log("  activate slot 1 @ tick " + t0[0].tick + " seen identically by all three peers");

  var JT = R.joinTick, END3 = JT + 40;
  await pushRange([c[0], c[2]], [0, 2], END2 + 1, END3);
  await pushRange([c[0], c[2], c3], [0, 2, 1], JT, END3);
  for (t = JT; t <= END3; t++) {
    var rows = [
      await waitFor(function () { return c[0].inputsFor(t); }, 5000, "retake tick " + t + " c0"),
      await waitFor(function () { return c[2].inputsFor(t); }, 5000, "retake tick " + t + " c2"),
      await waitFor(function () { return c3.inputsFor(t); }, 5000, "retake tick " + t + " c3")
    ];
    for (var i = 0; i < 3; i++) assert(rowsEqual(rows[i], rows[0]), "peer " + i + " differs at tick " + t);
    assert(rows[0][1] === inp(1, t), "slot 1 live again at tick " + t);
    assert(rows[0][3] === 0 && rows[0][4] === 0, "slots 3,4 still dormant");
  }
  console.log("  post-retake: ticks " + JT + ".." + END3 + " identical 5-byte rows on all three, slot 1 live again");
  console.log("CASE B PASS");
  return { c3: c3, keep: [c[0], c[2], c3] };
}

async function caseC() {
  console.log("\n=== CASE C — the log cap really bounds relay memory ===");
  var CAP = 500, SLACK = 64, PUSH = 4000;
  var r = await startRelay(["--log-cap", String(CAP), "--log-slack", String(SLACK)]);
  var URL = "ws://127.0.0.1:" + r.port;
  var a = NET.create(), b = NET.create();
  var h = await a.host({ url: URL, name: "a" });
  await b.join({ url: URL, room: h.room, name: "b" });
  a.start(7);
  await sleep(200);
  await pushRange([a, b], [0, 1], 0, PUSH);

  var body = await http(r.port, "/status.json");
  var snap = JSON.parse(body.split("\r\n\r\n")[1]);
  var room = snap.rooms[0];
  // the pushes are queued on the socket; let the relay drain them
  for (var w = 0; w < 400 && room.maxTick < PUSH; w++) {
    await sleep(50);
    body = await http(r.port, "/status.json");
    snap = JSON.parse(body.split("\r\n\r\n")[1]);
    room = snap.rooms[0];
  }
  console.log("  pushed " + (PUSH + 1) + " ticks with cap=" + CAP + " slack=" + SLACK);
  console.log("  relay holds: logTicks=" + room.logTicks + "  logBytes=" + room.logBytes +
              "  window=" + room.logFrom + ".." + room.logTo + "  maxTick=" + room.maxTick);
  assert(room.logTicks <= CAP + SLACK, "log must be <= cap+slack, got " + room.logTicks);
  assert(room.logBytes === room.logTicks * 5, "5 bytes per tick, got " + room.logBytes);
  assert(room.logFrom > 0, "old ticks must have been trimmed, logFrom=" + room.logFrom);
  assert(room.logTo === PUSH, "newest tick still recorded");
  var unbounded = (PUSH + 1) * 5;
  console.log("  bounded: " + room.logBytes + " bytes held vs " + unbounded + " unbounded (" +
              (100 - Math.round(room.logBytes * 100 / unbounded)) + "% trimmed)");

  // a latecomer into a trimmed room is told the truth: logFrom > 0
  var late = NET.create();
  var j = await late.join({ url: URL, room: h.room, name: "late" });
  assert(j.resume && j.resume.logFrom === room.logFrom && j.resume.logFrom > 0,
         "resume reports the trimmed logFrom honestly: " + JSON.stringify(j.resume && j.resume.logFrom));
  assert(j.resume.inputsByTick(0) === null, "trimmed tick 0 is null, not a fabricated zero row");
  console.log("  trimmed room: resume.logFrom=" + j.resume.logFrom + ", inputsByTick(0)=null (no fabricated history)");
  a.close(); b.close(); late.close();
  await sleep(100);
  console.log("CASE C PASS");
}

async function caseD(port) {
  console.log("\n=== DASHBOARD ===");
  // `/` is the GAME now, not the dashboard. A hosted service gets exactly one
  // port, so the relay is the only door and the page has to be behind the front
  // one; the dashboard moved to /dash. Asserted both ways round, because the
  // failure that matters here is the quiet one — a deploy serving the dashboard
  // where the game should be looks healthy to everyone except a player.
  var game = await http(port, "/");
  assert(game.startsWith("HTTP/1.1 200 OK"), "/ must be 200, got: " + game.slice(0, 40));
  assert(game.indexOf("Purge Protocol") > 0, "/ serves the game");
  assert(game.indexOf("Contra Orbit relay") < 0, "/ is not the dashboard any more");
  console.log("  GET /              200 OK, " + game.length + " bytes, the built page");
  var missing = await http(port, "/no-such-thing");
  assert(missing.startsWith("HTTP/1.1 404"),
         "an unknown path 404s instead of quietly falling back to the dashboard");
  console.log("  GET /no-such-thing 404, no silent fallback");
  var html = await http(port, "/dash");
  assert(html.startsWith("HTTP/1.1 200 OK"), "/dash must be 200, got: " + html.slice(0, 40));
  assert(html.indexOf("Contra Orbit relay") > 0, "/dash renders the dashboard");
  assert(html.indexOf("log ") > 0, "/dash shows the log size");
  console.log("  GET /dash          200 OK, " + html.length + " bytes, shows log size + joinable state");
  var raw = await http(port, "/status.json");
  assert(raw.startsWith("HTTP/1.1 200 OK"), "/status.json must be 200");
  var snap = JSON.parse(raw.split("\r\n\r\n")[1]);
  var r = snap.rooms[0];
  assert(typeof r.logTicks === "number" && typeof r.logBytes === "number", "status.json has log size");
  assert(typeof r.joinable === "boolean", "status.json has joinable");
  assert(r.nPlayers === 5, "status.json reports 5 slots");
  console.log("  GET /status.json 200 OK, valid JSON: room=" + r.room + " started=" + r.started +
              " joinable=" + r.joinable + " freeSlot=" + r.freeSlot +
              " logTicks=" + r.logTicks + " logBytes=" + r.logBytes);
  console.log("  spans: " + JSON.stringify(r.spans));
  console.log("  production cap " + snap.logCapTicks + " ticks = " + snap.logCapBytesPerRoom +
              " bytes/room (" + (snap.logCapBytesPerRoom / 1048576).toFixed(2) + " MB, " +
              (snap.logCapTicks / 3600).toFixed(1) + " min of play at 1/60 s)");
  console.log("DASHBOARD PASS");
}

async function caseE() {
  console.log("\n=== CASE E — chunked resume (log too big for one frame) ===");
  var TICKS = 11000;   // 11001*5 = 55005 packed bytes > the 49152-byte inline limit
  var r = await startRelay([]);
  var URL = "ws://127.0.0.1:" + r.port;
  var a = NET.create(), b = NET.create();
  var h = await a.host({ url: URL, name: "a" });
  await b.join({ url: URL, room: h.room, name: "b" });
  a.start(99);
  await sleep(200);
  var t0 = Date.now();
  await pushRange([a, b], [0, 1], 0, TICKS);
  for (var w = 0; w < 600; w++) {
    var s = JSON.parse((await http(r.port, "/status.json")).split("\r\n\r\n")[1]);
    var pl = s.rooms[0].players;
    if (pl.length === 2 && pl[0].tick >= TICKS && pl[1].tick >= TICKS) break;
    await sleep(50);
  }
  console.log("  recorded " + (TICKS + 1) + " ticks in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

  var late = NET.create();
  var j = await late.join({ url: URL, room: h.room, name: "chunky" });
  var R = j.resume;
  var packed = (R.logTo - R.logFrom + 1) * R.slots;
  assert(packed > 49152, "this case must exceed the inline limit, packed=" + packed);
  assert(R.logFrom === 0 && R.logTo >= TICKS, "chunked log still covers 0.." + TICKS);
  console.log("  chunked resume reassembled: " + packed + " bytes, ticks " + R.logFrom + ".." + R.logTo);

  var bad = 0;
  for (var t = 0; t <= TICKS; t++) {
    var row = R.inputsByTick(t);
    if (!row || row[0] !== inp(0, t) || row[1] !== inp(1, t) || row[2] || row[3] || row[4]) {
      bad++;
      if (bad < 4) console.error("   tick " + t + " got " + row + " want " + [inp(0, t), inp(1, t), 0, 0, 0]);
    }
  }
  assert(bad === 0, bad + " rows wrong after chunk reassembly");
  console.log("  all " + (TICKS + 1) + " reassembled rows correct");
  a.close(); b.close(); late.close();
  await sleep(100);
  console.log("CASE E PASS");
}

async function caseF() {
  console.log("\n=== CASE F — stall flag + bounded live buffer (regression from the old suite) ===");
  var r = await startRelay([]);
  var URL = "ws://127.0.0.1:" + r.port;
  var a = NET.create(), b = NET.create();
  var h = await a.host({ url: URL, name: "a" });
  await b.join({ url: URL, room: h.room, name: "b" });
  a.start(5);
  await sleep(200);
  await pushRange([a, b], [0, 1], 0, 400);
  await waitFor(function () { return a.inputsFor(400); }, 5000, "tick 400");

  assert(a.inputsFor(0) === null, "tick 0 must be pruned from the live buffer");
  console.log("  bounded live buffer: tick 0 pruned after querying tick 400");

  for (var i = 0; i < 31; i++) a.inputsFor(1200);      // nobody pushed 1200
  assert(a.status().stalled === true, "stalled must set after 31 null reads");
  a.pushInput(1200, 9); b.pushInput(1200, 8);
  await waitFor(function () { return a.inputsFor(1200); }, 3000, "tick 1200");
  assert(a.status().stalled === false, "stalled must clear on a successful read");
  console.log("  stall: set after 31 nulls, cleared once the row completed");
  assert(a.status().rttMs >= 0, "rtt measured");
  console.log("  rtt measured: " + a.status().rttMs + "ms");
  assert(a.status().joinTick === 0 && a.status().catchingUp === false,
         "a founder goes live at tick 0 and is never catchingUp: " + JSON.stringify(a.status()));
  console.log("  founder status: joinTick=0 (activated at tick 0) catchingUp=false");
  a.close(); b.close();
  await sleep(100);
  console.log("CASE F PASS");
}

(async function () {
  var main = await startRelay([]);
  try {
    var ctx = await caseA(main.port);
    var kept = await caseB(ctx);
    await caseD(main.port);
    await caseC();
    await caseE();
    await caseF();
    for (var i = 0; i < kept.keep.length; i++) kept.keep[i].close();
    await sleep(100);
    console.log("\nALL PASS");
    process.exitCode = 0;
  } catch (e) {
    console.error("\n" + (e.stack || e));
    process.exitCode = 1;
  } finally {
    for (var k = 0; k < relays.length; k++) relays[k].kill();
    await sleep(100);
    process.exit(process.exitCode || 0);
  }
})();
