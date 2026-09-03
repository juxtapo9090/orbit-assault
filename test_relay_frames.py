#!/usr/bin/env python3
"""test_relay_frames.py — raw RFC 6455 probe: 70KB text frame (16-bit len), control ping/pong, close."""
import base64, json, os, socket, struct, sys

PORT = int(os.environ.get("PORT", "8902"))

def mask_frame(op, data):
    key = os.urandom(4)
    n = len(data)
    if n < 126: head = struct.pack("!BB", 0x80 | op, 0x80 | n)
    elif n < 65536: head = struct.pack("!BBH", 0x80 | op, 0x80 | 126, n)
    else: head = struct.pack("!BBQ", 0x80 | op, 0x80 | 127, n)
    return head + key + bytes(b ^ key[i & 3] for i, b in enumerate(data))

def recv_exact(s, n):
    b = b""
    while len(b) < n:
        c = s.recv(n - len(b)); assert c, "closed"; b += c
    return b

def read_frame(s):
    b0, b1 = struct.unpack("!BB", recv_exact(s, 2))
    ln = b1 & 0x7F
    if ln == 126: ln = struct.unpack("!H", recv_exact(s, 2))[0]
    elif ln == 127: ln = struct.unpack("!Q", recv_exact(s, 8))[0]
    assert not (b1 & 0x80), "server frames must be unmasked"
    return b0 & 0x0F, recv_exact(s, ln)

s = socket.create_connection(("127.0.0.1", PORT))
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % key).encode())
buf = b""
while b"\r\n\r\n" not in buf: buf += s.recv(4096)
assert buf.startswith(b"HTTP/1.1 101"), buf
print("handshake: 101 ok")

# 70KB text frame → 16-bit length path; relay must parse JSON and answer pong
pad = "x" * 70000
s.sendall(mask_frame(0x1, json.dumps({"t": "ping", "ts": 7, "pad": pad}).encode()))
op, data = read_frame(s)
assert op == 0x1 and json.loads(data) == {"t": "pong", "ts": 7}, (op, data[:80])
print("70KB text frame (16-bit len): parsed, pong ts=7 ok")

# 64-bit length path too: 70000 bytes but forced 127 encoding
body = json.dumps({"t": "ping", "ts": 8, "pad": pad}).encode()
k = os.urandom(4)
s.sendall(struct.pack("!BBQ", 0x81, 0x80 | 127, len(body)) + k + bytes(b ^ k[i & 3] for i, b in enumerate(body)))
op, data = read_frame(s)
assert json.loads(data) == {"t": "pong", "ts": 8}
print("70KB text frame (64-bit len): parsed, pong ts=8 ok")

# control ping → pong with same payload
s.sendall(mask_frame(0x9, b"hello"))
op, data = read_frame(s)
assert op == 0xA and data == b"hello", (op, data)
print("control ping/pong: opcode 0xA payload echoed ok")

# close handshake
s.sendall(mask_frame(0x8, struct.pack("!H", 1000)))
op, data = read_frame(s)
assert op == 0x8, op
print("close: server echoed close frame ok")
print("FRAMES PASS")
