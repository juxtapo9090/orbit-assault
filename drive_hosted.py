#!/usr/bin/env python3
"""drive_hosted.py — the deploy shape, end to end, on one port.

A hosted service (mojave, fly, anything) gets ONE port. So the page and the
websocket have to come from the same origin, and the page must work out where its
relay is WITHOUT being told — because nobody hosting a public link is going to
type a relay URL into a text box.

This drives exactly that and nothing else:
  * relay.py is the only server, started with $PORT and no arguments
  * both browsers load the game FROM the relay
  * neither one touches #inRelay — the default has to be right on its own
  * then they play, and every tick both recorded must fingerprint identically

If this passes, the same tree deploys. If the relay default regresses to a
hardcoded port, this fails where drive_coop.py (which fills the field in) cannot.
"""
import asyncio, os, pathlib, subprocess, sys, time
from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).parent
PORT = os.environ.get("HOSTED_PORT", "8932")
URL = f"http://127.0.0.1:{PORT}/"
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
fails = []


def check(ok, label, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")
    if not ok:
        fails.append(label)


async def main():
    env = dict(os.environ, PORT=PORT)          # exactly how a platform starts it
    relay = subprocess.Popen([sys.executable, str(HERE / "relay.py")],
                             env=env, stderr=subprocess.PIPE, text=True)
    time.sleep(1.0)
    errs = {"A": [], "B": []}
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable",
                                         args=["--no-sandbox"])
            pages = {}
            for k in ("A", "B"):
                pg = await b.new_page(viewport={"width": 1000, "height": 640})
                pg.on("pageerror", lambda e, k=k: errs[k].append(str(e)))
                pg.on("console", lambda m, k=k: errs[k].append(m.text)
                      if m.type == "error" and "404" not in m.text else None)
                # A fresh context every time: a remembered relay in localStorage
                # would hide exactly the bug this file exists to catch.
                await pg.goto(URL)
                await pg.evaluate("try{localStorage.removeItem('contra.relay')}catch(e){}")
                await pg.reload()
                await pg.wait_for_timeout(500)
                await pg.fill("#inName", "p1" if k == "A" else "p2")
                pages[k] = pg
            A, B = pages["A"], pages["B"]

            got = await A.input_value("#inRelay")
            check(got == f"ws://127.0.0.1:{PORT}",
                  "the page defaults its relay to its own origin, untouched", got)

            await A.click("#btnHost"); await A.wait_for_timeout(700)
            room = await A.evaluate("NET.status().room")
            check(bool(room), "hosting works over that default", str(room))
            if not room:
                await b.close(); return
            await B.fill("#inRoom", room); await B.click("#btnJoin")
            await B.wait_for_timeout(800)
            await A.click("#btnLaunch"); await A.wait_for_timeout(1000)

            for pg in (A, B):
                await pg.keyboard.down("ArrowRight"); await pg.keyboard.down("KeyX")
            for _ in range(5):
                await A.wait_for_timeout(600)
                await B.keyboard.down("Space"); await B.wait_for_timeout(150)
                await B.keyboard.up("Space")
            for pg in (A, B):
                await pg.keyboard.up("ArrowRight"); await pg.keyboard.up("KeyX")
            await A.wait_for_timeout(500)
            await A.screenshot(path=OUT / "hosted-A.png")

            da = await A.evaluate("window.__dbg()")
            db = await B.evaluate("window.__dbg()")
            common = sorted(set(da["hist"]) & set(db["hist"]), key=int)
            bad = [t for t in common if da["hist"][t] != db["hist"][t]]
            check(len(common) > 10, "the two peers actually ran together",
                  f"{len(common)} common ticks")
            check(len(bad) == 0, "and stayed in lockstep through the one port",
                  f"{len(bad)} mismatches over {len(common)} ticks")
            print("     HUD A:", await A.inner_text("#hNet"),
                  "| HUD B:", await B.inner_text("#hNet"))
            await b.close()
    finally:
        relay.terminate()
    for k in errs:
        if errs[k]:
            print(f"  {k} console errors:", errs[k][:4])
        check(not errs[k], f"peer {k} raised no page errors", str(errs[k][:2]))
    print("\nVERDICT:", "PASS — this tree deploys as a single service" if not fails else "FAIL")
    sys.exit(1 if fails else 0)


asyncio.run(main())
