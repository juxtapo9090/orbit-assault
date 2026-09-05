#!/usr/bin/env python3
"""Drive the bomb: throw one, watch it arc, watch it blow, watch a coin refill it.

Proves the four things the contract asks for that no existing driver touches —
edge-trigger (a held key throws once), the pool, the blast, and coins-as-ammo.
"""
import asyncio, pathlib
from playwright.async_api import async_playwright

import os as _os
# PORT= points this driver at a copy of the folder serving itself. Without it a
# driver run from a COPY silently tests whatever 8901 happens to be serving —
# the same shape as the stale relay that cost a night.
URL = f"http://127.0.0.1:{_os.environ.get('PORT', '8901')}/orbit.html"
OUT = pathlib.Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

STATE = """(() => {
  const s = CONTRA._state();
  const p = window.__dbg().players;
  return {
    grenades: s.grenades.filter(g => g.alive).length,
    pool: s.grenades.length,
    bombs: [...document.querySelectorAll('.stat')].map(x=>x.textContent.trim()).find(t=>t.startsWith('bomb')),
  };
})()"""

async def main():
    errors = []
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1000, "height": 640})
        pg.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" and "404" not in m.text else None)
        pg.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        await pg.goto(URL)
        await pg.wait_for_timeout(500)
        await pg.click("#btnStart")
        await pg.wait_for_timeout(500)

        print("before:", await pg.evaluate(STATE))

        # HELD for a full second: edge-trigger means exactly ONE grenade.
        await pg.keyboard.down("KeyC")
        await pg.wait_for_timeout(120)
        mid = await pg.evaluate(STATE)
        print("held 120ms:", mid)
        await pg.screenshot(path=OUT / "bomb-arc.png")
        await pg.wait_for_timeout(900)
        print("held 1.0s :", await pg.evaluate(STATE), "  <- bombs must have dropped by exactly 1")
        await pg.keyboard.up("KeyC")

        await pg.wait_for_timeout(1200)
        print("after boom:", await pg.evaluate(STATE))
        await pg.screenshot(path=OUT / "bomb-after.png")

        # Second throw: cooldown has expired, one bomb left, it should fire.
        await pg.keyboard.down("KeyC"); await pg.wait_for_timeout(100); await pg.keyboard.up("KeyC")
        await pg.wait_for_timeout(100)
        print("2nd throw:", await pg.evaluate(STATE))
        await pg.wait_for_timeout(1600)

        # Empty pouch: a third press must do nothing.
        await pg.keyboard.down("KeyC"); await pg.wait_for_timeout(100); await pg.keyboard.up("KeyC")
        await pg.wait_for_timeout(200)
        print("empty    :", await pg.evaluate(STATE), "  <- bombs 0, no new grenade")

        # Run right into the coin field: coins are ammo now.
        await pg.keyboard.down("ArrowRight"); await pg.keyboard.down("ShiftLeft")
        await pg.wait_for_timeout(2600)
        await pg.keyboard.up("ArrowRight"); await pg.keyboard.up("ShiftLeft")
        print("post-coin:", await pg.evaluate(STATE), "  <- bombs refilled from coins")
        await pg.screenshot(path=OUT / "bomb-coins.png")

        await b.close()
    print("console errors:", len(errors))
    for e in errors[:10]: print("  ", e)

asyncio.run(main())
