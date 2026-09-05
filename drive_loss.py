#!/usr/bin/env python3
"""drive_coop, but with 15% of every WebRTC datagram thrown away on the way out.

Loopback never drops a packet, so drive_coop.py cannot see the one failure that
actually kills a room on a real link: the P2P input channel is unreliable by
design, and lockstep has no retransmit — a byte that never lands is a tick that
never runs, forever, for everybody. Before the redundancy window in net.js this
run froze both peers at spawn (tick 7, x=242). It must now reach the same place
drive_coop.py does.

Proof = every sim tick both peers recorded has an identical fingerprint, and the
players actually moved."""
import asyncio, pathlib, subprocess, sys, time
from playwright.async_api import async_playwright

import os as _os
# PORT= points this driver at a copy of the folder serving itself. Without it a
# driver run from a COPY silently tests whatever 8901 happens to be serving —
# the same shape as the stale relay that cost a night.
URL = f"http://127.0.0.1:{_os.environ.get('PORT', '8901')}/orbit.html"
OUT = pathlib.Path(__file__).parent / "shots"
HERE = pathlib.Path(__file__).parent

async def main():
    relay = subprocess.Popen([sys.executable, str(HERE / "relay.py"), "--port", "8907"], stderr=subprocess.PIPE, text=True)
    time.sleep(0.6)
    errs = {"A": [], "B": []}
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable", args=["--no-sandbox"])
            pages = {}
            for k in ("A", "B"):
                pg = await b.new_page(viewport={"width": 1000, "height": 640})
                pg.on("pageerror", lambda e, k=k: errs[k].append(str(e)))
                pg.on("console", lambda m, k=k: errs[k].append(m.text) if m.type == "error" and "404" not in m.text else None)
                await pg.add_init_script("(function(){var s=RTCDataChannel.prototype.send;RTCDataChannel.prototype.send=function(d){if(Math.random()<0.15)return;return s.call(this,d);};})()"); await pg.goto(URL); await pg.wait_for_timeout(400)
                await pg.fill("#inName", "p1" if k == "A" else "p2")
                await pg.fill("#inRelay", "ws://127.0.0.1:8907")
                pages[k] = pg
            A, B = pages["A"], pages["B"]
            await A.click("#btnHost"); await A.wait_for_timeout(500)
            room = await A.evaluate("NET.status().room")
            print("room", room)
            await B.fill("#inRoom", room); await B.click("#btnJoin"); await B.wait_for_timeout(600)
            print("lobby A:", await A.inner_text("#lobby"))
            await A.click("#btnLaunch"); await A.wait_for_timeout(800)
            for pg in (A, B):
                await pg.keyboard.down("ArrowRight"); await pg.keyboard.down("KeyX")
            await A.keyboard.down("ShiftLeft")
            for i in range(5):
                await A.wait_for_timeout(600)
                await B.keyboard.down("Space"); await B.wait_for_timeout(150); await B.keyboard.up("Space")
            await A.screenshot(path=OUT / "coop-A.png"); await B.screenshot(path=OUT / "coop-B.png")
            for pg in (A, B):
                await pg.keyboard.up("ArrowRight"); await pg.keyboard.up("KeyX")
            await A.wait_for_timeout(500)
            da = await A.evaluate("window.__dbg()"); db = await B.evaluate("window.__dbg()")
            for tag, pg in (("A", A), ("B", B)):
                v = await pg.evaluate("({me:window.__dbg().me, view:window.__view?window.__view():null})")
                print(tag, "me=", v["me"], "view=", v["view"])
            print("A tick", da["tick"], da["players"], "B tick", db["tick"], db["players"])
            common = sorted(set(da["hist"]) & set(db["hist"]), key=int)
            bad = [t for t in common if da["hist"][t] != db["hist"][t]]
            print(f"compared {len(common)} ticks, mismatches: {len(bad)}")
            for t in bad[:3]: print("  tick", t, "\n   A", da["hist"][t], "\n   B", db["hist"][t])
            print("HUD A:", await A.inner_text("#hNet"), "| HUD B:", await B.inner_text("#hNet"))
            await b.close()
    finally:
        relay.terminate()
        try: print("relay log:\n" + relay.stderr.read()[-800:])
        except Exception: pass
    for k in errs: print(k, "errors:", errs[k][:5])

asyncio.run(main())
