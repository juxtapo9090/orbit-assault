#!/usr/bin/env python3
"""Warp to the boss arena of stage 1, hold fire, watch it die (or not)."""
import asyncio, pathlib, sys
from playwright.async_api import async_playwright
URL = "http://127.0.0.1:8901/orbit.html"
OUT = pathlib.Path(__file__).parent / "shots"
COL = int(sys.argv[1]) if len(sys.argv) > 1 else 200

async def main():
    errs = []
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1000, "height": 640})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "404" not in m.text else None)
        await pg.goto(URL); await pg.wait_for_timeout(400)
        await pg.click("#btnStart"); await pg.wait_for_timeout(300)
        await pg.evaluate(f"window.__warp({(COL-14)*16})"); await pg.wait_for_timeout(400)
        await pg.screenshot(path=OUT / "boss-0.png")
        await pg.keyboard.down("ArrowRight"); await pg.wait_for_timeout(1400); await pg.keyboard.up("ArrowRight")
        await pg.keyboard.down("KeyX"); await pg.keyboard.down("ArrowRight"); await pg.keyboard.down("ArrowUp")
        for i in range(1, 25):
            await pg.wait_for_timeout(1500)
            if i % 2 == 0:
                await pg.keyboard.down("Space"); await pg.wait_for_timeout(200); await pg.keyboard.up("Space")
            await pg.screenshot(path=OUT / f"boss-{i}.png")
            hud = await pg.inner_text("#hBoss"); d = await pg.evaluate("window.__dbg()")
            print(f"t={i*1.5:>4}s boss[{hud}] score={d['score']} state={d['state']} players={d['players']}")
            if d['state'] != 'play': break
        await pg.keyboard.up("KeyX")
        await b.close()
    print("errors:", errs[:5])
asyncio.run(main())
