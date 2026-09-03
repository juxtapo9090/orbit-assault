#!/usr/bin/env python3
"""relay.py — WebSocket lockstep relay + input recorder for orbit-assault (stdlib only).

    python3 relay.py [--port 8902] [--bind 0.0.0.0]

--port  TCP port to listen on            (default 8902)
--bind  address to bind                  (default 0.0.0.0)
Any other / malformed argument → error to stderr, exit 2.

=====================================================================
 THE SLOT MODEL  (read this before touching anything below)
=====================================================================
Every room has exactly MAX_PLAYERS (5) slots and the core ALWAYS simulates
all 5 of them from tick 0. A slot nobody has joined is *dormant*: simulated,
but frozen and invisible, and its input byte is always 0. A slot becomes a
real player only when it is ACTIVATED at a specific tick.

Therefore:
  * `start` always reports `nPlayers: 5`. So does `resume`. Always. The count
    of humans in the room is irrelevant to the sim; only activation matters.
  * When the host starts a room, the relay broadcasts one
    `activate{slot, tick:0, name}` for every slot that is occupied at that
    moment. Founders are activated exactly the same way a latecomer is —
    there is no special "founder" path in the core.
  * A latecomer is activated at `joinTick`, a tick safely in the future
    (newest tick any client has reported + JOIN_LEAD), broadcast to everyone
    in the room including the joiner, so all peers flip the same slot on at
    the same tick.

Per slot the relay keeps a list of *spans* `[from, to)` of ticks during which
that slot was an active player (`to = None` = still active). A slot that
drops and is later re-taken by a new client gets a second span. Spans travel
in the `resume` payload so a latecomer replaying history knows, for every
tick, which slots were real. Without them, replaying a room where somebody
dropped would feed zeros where the original run had real input → desync.

A drop closes the open span at `last_tick + 1` — the first tick for which the
leaving client never sent input. Every peer therefore zeroes that slot from
exactly the same tick, whatever tick each peer happens to be simulating.

=====================================================================
 PROTOCOL  (JSON text frames; → to relay, ← from relay)
=====================================================================
→ {t:"host", name}                     ← {t:"joined", room, slot}
→ {t:"join", room, name}               ← {t:"joined", room, slot}   (not started)
                                       ← {t:"resume", ...}          (started)
                                       ← {t:"err", msg}
→ {t:"start", seed}   (host only)      ← {t:"start", seed, nPlayers:5, tick0:0}
→ {t:"in", tick, byte}                 ← {t:"in", slot, tick, byte}  (to the others)
→ {t:"ping", ts}                       ← {t:"pong", ts}
                                       ← {t:"lobby", room, players:[{slot,name}], hostSlot}
                                       ← {t:"activate", slot, tick, name}
                                       ← {t:"drop", slot, tick}

resume (reply to a join into a started room):
  {t:"resume", room, slot, seed, nPlayers:5, joinTick,
   logFrom, logTo, slots:5, spans:[[[from,to],...] x5],
   log:"<base64>"        # inline, when the packed log is <= INLINE_MAX bytes
   chunked:true}         # otherwise: no `log` key; the packed bytes follow as
                         #   {t:"logchunk", seq, data:"<base64>"} frames, in
                         #   order, terminated by {t:"logend", seq, bytes}
The packed log is (logTo-logFrom+1) rows of `slots` bytes, row-major, one byte
per slot per tick, covering ticks logFrom..logTo inclusive. logTo = -1 and an
empty log mean nothing has been recorded yet.

A plain HTTP GET on the same port (no Upgrade header) still serves the live
dashboard: `/` is HTML (auto-refresh 2s), `/status.json` the same as JSON,
now carrying each room's log size and whether it is joinable.

=====================================================================
 LOG MEMORY
=====================================================================
The log is one flat bytearray, 5 bytes per tick, base tick `log_from`. Cap is
LOG_CAP ticks; once storage exceeds LOG_CAP + LOG_SLACK the oldest ticks are
trimmed in one slice so trimming is amortised, not per-tick.

    LOG_CAP = 200_000 ticks * 5 slots = 1,000,000 bytes = 1.0 MB per room
    worst case with slack:  204,096 * 5 = 1,020,480 bytes ≈ 1.02 MB per room

200_000 ticks at 1/60 s is 55m33s of play. Cost of the cap: a client joining a
room that has run longer than that gets `logFrom > 0` and cannot replay from
tick 0 — the relay says so honestly via logFrom rather than pretending. There
is no state transfer, so such a join cannot be made sound; the core is
expected to refuse it. Nothing here silently truncates behind your back.
"""
import argparse
import base64
import hashlib
import json
import random
import socket
import struct
import sys
import threading
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_PLAYERS = 5
ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
MAX_FRAME = 1 << 20  # 1 MiB payload cap

LOG_CAP = 200_000     # ticks retained per room (see LOG MEMORY above)
LOG_SLACK = 4096      # trim only once this far over the cap (amortised slicing)
JOIN_LEAD = 120       # ticks into the future a latecomer is activated
MAX_AHEAD = 3600      # reject `in` ticks more than this far past the room's max
INLINE_MAX = 48 << 10 # packed log bytes still sent inline in the resume frame
CHUNK = 48 << 10      # packed log bytes per logchunk frame


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- framing

class WSClosed(Exception):
    pass


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise WSClosed()
        buf += chunk
    return buf


def read_frame(sock):
    """Return (opcode, payload bytes). Reassembles fragmented messages."""
    payload = b""
    first_op = None
    while True:
        b0, b1 = struct.unpack("!BB", recv_exact(sock, 2))
        fin = b0 & 0x80
        op = b0 & 0x0F
        masked = b1 & 0x80
        ln = b1 & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", recv_exact(sock, 2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", recv_exact(sock, 8))[0]
        if ln > MAX_FRAME:
            raise WSClosed()
        if not masked:
            # RFC 6455 §5.1: client frames MUST be masked
            raise WSClosed()
        key = recv_exact(sock, 4)
        data = bytearray(recv_exact(sock, ln))
        for i in range(ln):
            data[i] ^= key[i & 3]
        data = bytes(data)
        if op in (0x8, 0x9, 0xA):          # control frames: never fragmented
            return op, data
        if op == 0x0:                      # continuation
            payload += data
        else:
            first_op = op
            payload = data
        if fin:
            return first_op, payload


def encode_frame(op, data):
    b0 = 0x80 | op
    n = len(data)
    if n < 126:
        head = struct.pack("!BB", b0, n)
    elif n < 65536:
        head = struct.pack("!BBH", b0, 126, n)
    else:
        head = struct.pack("!BBQ", b0, 127, n)
    return head + data


def handshake(sock):
    """Read HTTP upgrade request, reply 101. Returns True on success."""
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            return False
        buf += chunk
        if len(buf) > 65536:
            return False
    head = buf.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    lines = head.split("\r\n")
    if not lines[0].startswith("GET "):
        return False
    hdrs = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            hdrs[k.strip().lower()] = v.strip()
    key = hdrs.get("sec-websocket-key")
    if not key or "websocket" not in hdrs.get("upgrade", "").lower():
        path = lines[0].split(" ")[1] if len(lines[0].split(" ")) > 1 else "/"
        serve_http(sock, path)
        return False
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    resp = ("HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: " + accept + "\r\n\r\n")
    sock.sendall(resp.encode())
    return True


# ---------------------------------------------------------------- rooms

class Client:
    def __init__(self, sock, addr):
        self.sock = sock
        self.addr = addr
        self.room = None
        self.slot = None
        self.name = ""
        self.lock = threading.Lock()
        self.rtt_ms = None
        self.last_tick = None
        self.since = time.time()

    def send(self, obj):
        data = encode_frame(0x1, json.dumps(obj, separators=(",", ":")).encode())
        try:
            with self.lock:
                self.sock.sendall(data)
        except OSError:
            pass

    def send_raw(self, op, data):
        try:
            with self.lock:
                self.sock.sendall(encode_frame(op, data))
        except OSError:
            pass


class Room:
    def __init__(self, code):
        self.code = code
        self.slots = [None] * MAX_PLAYERS
        self.started = False
        self.seed = None
        self.max_tick = -1                       # newest tick any client reported
        self.log = bytearray()                   # MAX_PLAYERS bytes per tick
        self.log_from = 0                        # tick of the first row in self.log
        self.spans = [[] for _ in range(MAX_PLAYERS)]   # slot -> [[from, to|None], ...]

    # ---- input log ----------------------------------------------------

    def log_to(self):
        """Newest tick recorded, or log_from-1 when the log is empty."""
        return self.log_from + len(self.log) // MAX_PLAYERS - 1

    def record(self, slot, tick, byte):
        """Write one slot's byte for `tick`. Late writes for old ticks are kept
        as long as the tick has not been trimmed away. Returns False if the
        tick is out of the acceptable window (caller should reject the frame)."""
        if tick < 0 or tick > self.max_tick + MAX_AHEAD:
            return False
        if tick > self.max_tick:
            self.max_tick = tick
        if tick < self.log_from:
            return True                          # already trimmed; silently past
        end = (tick - self.log_from + 1) * MAX_PLAYERS
        if end > len(self.log):
            self.log.extend(b"\0" * (end - len(self.log)))
        self.log[(tick - self.log_from) * MAX_PLAYERS + slot] = byte
        self.trim()
        return True

    def trim(self):
        ticks = len(self.log) // MAX_PLAYERS
        if ticks > LOG_CAP + LOG_SLACK:
            drop = ticks - LOG_CAP
            del self.log[:drop * MAX_PLAYERS]
            self.log_from += drop

    def span_open(self, slot, tick):
        self.spans[slot].append([tick, None])

    def span_close(self, slot, tick):
        for sp in reversed(self.spans[slot]):
            if sp[1] is None:
                sp[1] = max(sp[0], tick)
                return

    def spans_json(self):
        return [[list(sp) for sp in s] for s in self.spans]

    def join_tick(self):
        return self.max_tick + 1 + JOIN_LEAD

    # ---- room bookkeeping ---------------------------------------------

    def players(self):
        return [c for c in self.slots if c is not None]

    def free_slot(self):
        for i, c in enumerate(self.slots):
            if c is None:
                return i
        return None

    def host_slot(self):
        for i, c in enumerate(self.slots):
            if c is not None:
                return i
        return None

    def lobby_msg(self):
        return {"t": "lobby", "room": self.code,
                "players": [{"slot": c.slot, "name": c.name} for c in self.players()],
                "hostSlot": self.host_slot()}

    def broadcast(self, obj, exclude=None):
        for c in self.players():
            if c is not exclude:
                c.send(obj)

    def send_resume(self, cl, join_tick):
        """Send the resume header (+ chunks if the log is big) to one client.
        Caller must hold rooms_lock so no `in` frame can slip in front of it."""
        packed = bytes(self.log)
        head = {"t": "resume", "room": self.code, "slot": cl.slot,
                "seed": self.seed, "nPlayers": MAX_PLAYERS,
                "joinTick": join_tick,
                "logFrom": self.log_from, "logTo": self.log_to(),
                "slots": MAX_PLAYERS, "spans": self.spans_json()}
        if len(packed) <= INLINE_MAX:
            head["log"] = base64.b64encode(packed).decode()
            cl.send(head)
            return
        head["chunked"] = True
        cl.send(head)
        seq = 0
        for off in range(0, len(packed), CHUNK):
            cl.send({"t": "logchunk", "seq": seq,
                     "data": base64.b64encode(packed[off:off + CHUNK]).decode()})
            seq += 1
        cl.send({"t": "logend", "seq": seq, "bytes": len(packed)})


rooms = {}
rooms_lock = threading.Lock()


def new_code():
    while True:
        code = "".join(random.choice(ROOM_CHARS) for _ in range(4))
        if code not in rooms:
            return code


def handle_msg(cl, m):
    t = m.get("t")
    if t == "ping":
        cl.send({"t": "pong", "ts": m.get("ts")})
        return
    if t == "host":
        with rooms_lock:
            if cl.room is not None:
                cl.send({"t": "err", "msg": "already in a room"}); return
            code = new_code()
            room = Room(code)
            rooms[code] = room
            cl.room, cl.slot, cl.name = room, 0, str(m.get("name", ""))[:24]
            room.slots[0] = cl
            cl.send({"t": "joined", "room": code, "slot": 0})
            room.broadcast(room.lobby_msg())
        log("host  %s:%d room=%s name=%r" % (cl.addr[0], cl.addr[1], code, cl.name))
        return
    if t == "join":
        code = str(m.get("room", "")).upper()
        with rooms_lock:
            if cl.room is not None:
                cl.send({"t": "err", "msg": "already in a room"}); return
            room = rooms.get(code)
            if room is None:
                cl.send({"t": "err", "msg": "no such room " + code}); return
            slot = room.free_slot()
            if slot is None:
                cl.send({"t": "err", "msg": "room full"}); return
            cl.room, cl.slot, cl.name = room, slot, str(m.get("name", ""))[:24]
            room.slots[slot] = cl
            if not room.started:
                cl.send({"t": "joined", "room": code, "slot": slot})
                room.broadcast(room.lobby_msg())
                mode = "lobby"
            else:
                # Mid-game join: hand over the recorded input log, then tell the
                # whole room (joiner included) to switch this slot on at the
                # same future tick. Both happen under rooms_lock so no `in`
                # frame can be interleaved between snapshot and activation.
                jt = room.join_tick()
                room.send_resume(cl, jt)
                room.span_open(slot, jt)
                room.broadcast({"t": "activate", "slot": slot, "tick": jt, "name": cl.name})
                room.broadcast(room.lobby_msg())
                mode = "resume joinTick=%d logFrom=%d logTo=%d" % (jt, room.log_from, room.log_to())
        log("join  %s:%d room=%s slot=%d name=%r %s" % (cl.addr[0], cl.addr[1], code, slot, cl.name, mode))
        return
    room = cl.room
    if room is None:
        cl.send({"t": "err", "msg": "not in a room"})
        return
    if t == "start":
        with rooms_lock:
            if cl.slot != room.host_slot():
                cl.send({"t": "err", "msg": "only host can start"}); return
            if room.started:
                cl.send({"t": "err", "msg": "room already started"}); return
            room.started = True
            room.seed = m.get("seed")
            # Always 5: the core simulates 5 slots from tick 0, dormant until
            # activated. Founders are activated at tick 0 like anybody else.
            room.broadcast({"t": "start", "seed": room.seed,
                            "nPlayers": MAX_PLAYERS, "tick0": 0})
            for c in room.players():
                room.span_open(c.slot, 0)
                room.broadcast({"t": "activate", "slot": c.slot, "tick": 0, "name": c.name})
            n = len(room.players())
        log("start room=%s seed=%r nPlayers=%d occupied=%d" % (room.code, room.seed, MAX_PLAYERS, n))
        return
    if t == "in":
        tick, byte = m.get("tick"), m.get("byte")
        if not isinstance(tick, int) or isinstance(tick, bool) or not isinstance(byte, int) or isinstance(byte, bool):
            cl.send({"t": "err", "msg": "in: tick and byte must be integers"}); return
        byte &= 255
        with rooms_lock:
            if cl.room is not room:
                return
            if not room.record(cl.slot, tick, byte):
                cl.send({"t": "err", "msg": "in: tick %d out of window (max %d + %d)"
                                            % (tick, room.max_tick, MAX_AHEAD)})
                return
            cl.last_tick = tick
            room.broadcast({"t": "in", "slot": cl.slot, "tick": tick, "byte": byte}, exclude=cl)
        return
    cl.send({"t": "err", "msg": "unknown message type %r" % (t,)})


def drop(cl):
    room = cl.room
    if room is None:
        return
    with rooms_lock:
        room.slots[cl.slot] = None
        cl.room = None
        # First tick this client never sent input for — every peer zeroes the
        # slot from exactly here, so the drop lands deterministically.
        dead_at = 0 if cl.last_tick is None else cl.last_tick + 1
        room.span_close(cl.slot, dead_at)
        room.broadcast({"t": "drop", "slot": cl.slot, "tick": dead_at})
        if room.started:
            room.broadcast(room.lobby_msg())
        if not room.players():
            rooms.pop(room.code, None)
    log("drop  %s:%d room=%s slot=%d deadAt=%d" % (cl.addr[0], cl.addr[1], room.code, cl.slot, dead_at))


# ---------------------------------------------------------------- dashboard

START = time.time()
clients = set()
clients_lock = threading.Lock()


def snapshot():
    with rooms_lock:
        rs = []
        for code, room in sorted(rooms.items()):
            rs.append({"room": code, "started": room.started, "hostSlot": room.host_slot(),
                       "seed": room.seed, "nPlayers": MAX_PLAYERS,
                       "joinable": room.free_slot() is not None,
                       "freeSlot": room.free_slot(),
                       "maxTick": room.max_tick,
                       "logFrom": room.log_from, "logTo": room.log_to(),
                       "logTicks": len(room.log) // MAX_PLAYERS,
                       "logBytes": len(room.log), "logCapTicks": LOG_CAP,
                       "spans": room.spans_json(),
                       "players": [{"slot": c.slot, "name": c.name, "addr": c.addr[0],
                                    "rttMs": c.rtt_ms, "tick": c.last_tick,
                                    "upS": int(time.time() - c.since)} for c in room.players()]})
    with clients_lock:
        idle = [c.addr[0] for c in clients if c.room is None]
    return {"uptimeS": int(time.time() - START), "rooms": rs, "idle": idle,
            "logCapTicks": LOG_CAP, "logCapBytesPerRoom": LOG_CAP * MAX_PLAYERS}


DASH = """<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Orbit Assault relay</title>
<style>body{background:#080A12;color:#ECEAF4;font:13px "Martian Mono",ui-monospace,monospace;padding:28px;max-width:860px;margin:auto}
h1{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#E0616B;margin:0 0 6px}
.sub{color:#5E6588;font-size:11px;margin-bottom:22px}
.room{background:#12162A;border:1px solid #232A46;border-radius:10px;padding:14px 18px;margin-bottom:12px}
.room h2{font-size:12px;margin:0 0 10px;letter-spacing:.12em;color:#F5C15C}.room h2 i{font-style:normal;color:#5E6588;margin-left:10px;letter-spacing:.06em}
table{border-collapse:collapse;width:100%%}td,th{text-align:left;padding:5px 8px;font-size:12px}th{color:#5E6588;font-weight:400;font-size:10px;letter-spacing:.1em;text-transform:uppercase}
td.s{width:2.4em}.c0{color:#6E9CE8}.c1{color:#F5C15C}.c2{color:#6FD0A4}.c3{color:#E58BD6}.c4{color:#FF9A5C}
.host::after{content:" host";color:#5E6588;font-size:10px}.dim{color:#5E6588}.bad{color:#E0616B}
.empty{color:#5E6588;padding:18px;border:1px dashed #232A46;border-radius:10px;text-align:center}
</style><h1>&#9679; Orbit Assault relay</h1><div class="sub">up %(up)s &middot; %(nrooms)d room(s) &middot; %(nplayers)d player(s) &middot; %(idle)d connected, not in a room &middot; <a href="/status.json" style="color:#6E9CE8">json</a></div>
%(body)s"""


def fmt_up(sec):
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    return "%d:%02d:%02d" % (h, m, s)


def render_dash(snap):
    if not snap["rooms"]:
        body = '<div class="empty">no rooms yet &mdash; press Host in the game</div>'
    else:
        parts = []
        for r in snap["rooms"]:
            rows = []
            for pl in sorted(r["players"], key=lambda x: x["slot"]):
                rtt = "&mdash;" if pl["rttMs"] is None else "%d ms" % pl["rttMs"]
                rcls = "bad" if (pl["rttMs"] or 0) > 120 else ""
                tick = "&mdash;" if pl["tick"] is None else str(pl["tick"])
                host = " host" if pl["slot"] == r["hostSlot"] else ""
                rows.append('<tr><td class="s c%d">%d</td><td class="c%d%s">%s</td><td class="dim">%s</td>'
                            '<td class="%s">%s</td><td class="dim">%s</td><td class="dim">%s</td></tr>' % (
                                pl["slot"], pl["slot"] + 1, pl["slot"], host, pl["name"] or "?", pl["addr"],
                                rcls, rtt, tick, fmt_up(pl["upS"])))
            state = "in game" if r["started"] else "lobby"
            if r["started"]:
                state += " &middot; log %d ticks (%.1f KB)" % (r["logTicks"], r["logBytes"] / 1024.0)
            state += " &middot; " + ("joinable slot %d" % r["freeSlot"] if r["joinable"] else "full")
            parts.append('<div class="room"><h2>%s <i>%s</i></h2><table><tr><th>#</th><th>name</th><th>from</th>'
                         '<th>rtt</th><th>tick</th><th>connected</th></tr>%s</table></div>' % (r["room"], state, "".join(rows)))
        body = "".join(parts)
    n = sum(len(r["players"]) for r in snap["rooms"])
    return DASH % {"up": fmt_up(snap["uptimeS"]), "nrooms": len(snap["rooms"]), "nplayers": n,
                   "idle": len(snap["idle"]), "body": body}


def serve_http(sock, path):
    snap = snapshot()
    if path.startswith("/status.json"):
        body = json.dumps(snap).encode()
        ctype = "application/json"
    else:
        body = render_dash(snap).encode()
        ctype = "text/html; charset=utf-8"
    head = ("HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n" % (ctype, len(body)))
    try:
        sock.sendall(head.encode() + body)
    except OSError:
        pass


def pinger():
    """Every 2s ping every live socket with a timestamp; the pong measures rtt."""
    while True:
        time.sleep(2)
        with clients_lock:
            live = list(clients)
        for c in live:
            c.send_raw(0x9, ("%.6f" % time.time()).encode())


def serve(sock, addr):
    cl = Client(sock, addr)
    with clients_lock:
        clients.add(cl)
    try:
        if not handshake(sock):
            return
        log("conn  %s:%d" % addr)
        while True:
            op, data = read_frame(sock)
            if op == 0x8:                      # close
                cl.send_raw(0x8, data[:2])
                break
            if op == 0x9:                      # ping → pong
                cl.send_raw(0xA, data)
                continue
            if op == 0xA:                      # pong: measure rtt from our own ping
                try:
                    cl.rtt_ms = int((time.time() - float(data.decode())) * 1000)
                except (ValueError, UnicodeDecodeError):
                    pass
                continue
            if op != 0x1:                      # binary etc: ignore
                continue
            try:
                m = json.loads(data.decode("utf-8"))
            except ValueError:
                cl.send({"t": "err", "msg": "bad json"})
                continue
            if not isinstance(m, dict):
                cl.send({"t": "err", "msg": "bad json"})
                continue
            handle_msg(cl, m)
    except (WSClosed, OSError, ConnectionError):
        pass
    finally:
        drop(cl)
        with clients_lock:
            clients.discard(cl)
        try:
            sock.close()
        except OSError:
            pass


def main():
    global LOG_CAP, LOG_SLACK
    ap = argparse.ArgumentParser(description="orbit-assault lockstep WebSocket relay (stdlib only)")
    ap.add_argument("--port", type=int, default=8902, help="TCP port to listen on (default 8902)")
    ap.add_argument("--bind", default="0.0.0.0", help="address to bind (default 0.0.0.0)")
    ap.add_argument("--log-cap", type=int, default=LOG_CAP,
                    help="input-log ticks retained per room (default %d = %d bytes/room)"
                         % (LOG_CAP, LOG_CAP * MAX_PLAYERS))
    ap.add_argument("--log-slack", type=int, default=LOG_SLACK,
                    help="ticks over the cap tolerated before trimming (default %d)" % LOG_SLACK)
    args = ap.parse_args()          # argparse exits 2 on unknown/malformed args
    if not (0 < args.port < 65536):
        log("error: --port must be 1..65535, got %d" % args.port)
        sys.exit(2)
    if args.log_cap < 1:
        log("error: --log-cap must be >= 1, got %d" % args.log_cap)
        sys.exit(2)
    if args.log_slack < 0:
        log("error: --log-slack must be >= 0, got %d" % args.log_slack)
        sys.exit(2)
    LOG_CAP, LOG_SLACK = args.log_cap, args.log_slack

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((args.bind, args.port))
    except OSError as e:
        log("error: cannot bind %s:%d: %s" % (args.bind, args.port, e))
        sys.exit(2)
    srv.listen(16)
    log("relay listening on ws://%s:%d  (dashboard: http://%s:%d/)  log cap %d ticks = %d bytes/room"
        % (args.bind, args.port, args.bind, args.port, LOG_CAP, LOG_CAP * MAX_PLAYERS))
    threading.Thread(target=pinger, daemon=True).start()
    try:
        while True:
            s, a = srv.accept()
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            threading.Thread(target=serve, args=(s, a), daemon=True).start()
    except KeyboardInterrupt:
        log("relay stopped")


if __name__ == "__main__":
    main()
