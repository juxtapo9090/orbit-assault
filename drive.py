#!/usr/bin/env python3
"""Drive the build headless: start solo, run right + fire, screenshot, collect console errors."""
import asyncio, sys, pathlib
from playwright.async_api import async_playwright

import os as _os
# PORT= points this driver at a copy of the folder serving itself. Without it a
# driver run from a COPY silently tests whatever 8901 happens to be serving —
# the same shape as the stale relay that cost a night.
URL = f"http://127.0.0.1:{_os.environ.get('PORT', '8901')}/orbit.html"
OUT = pathlib.Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

async def main():
    errors = []
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1000, "height": 640})
        pg.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        await pg.goto(URL)
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=OUT / "c-title.png")
        await pg.click("#btnStart")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path=OUT / "c-start.png")
        # run right, fire, a few jumps
        await pg.keyboard.down("ArrowRight"); await pg.keyboard.down("ShiftLeft"); await pg.keyboard.down("KeyX")
        for i in range(6):
            await pg.wait_for_timeout(500)
            if i % 2 == 0:
                await pg.keyboard.down("Space"); await pg.wait_for_timeout(180); await pg.keyboard.up("Space")
            await pg.screenshot(path=OUT / f"c-run{i}.png")
        await pg.keyboard.up("ArrowRight")
        # aim up + prone
        await pg.keyboard.down("ArrowUp"); await pg.wait_for_timeout(300); await pg.screenshot(path=OUT / "c-aimup.png")
        await pg.keyboard.up("ArrowUp"); await pg.keyboard.down("ArrowDown"); await pg.wait_for_timeout(300)
        await pg.screenshot(path=OUT / "c-prone.png")
        await pg.keyboard.up("ArrowDown"); await pg.keyboard.up("KeyX"); await pg.keyboard.up("ShiftLeft")
        hud = await pg.evaluate("[...document.querySelectorAll('.stat')].map(s=>s.textContent.trim()).join(' | ')")
        print("HUD:", hud)
        await b.close()
    print("console:", len(errors))
    for e in errors[:20]: print("  ", e)

asyncio.run(main())
