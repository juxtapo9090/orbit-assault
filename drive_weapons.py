#!/usr/bin/env python3
"""Weapons + backgrounds contract (2026-09-04): grant each new pickup via the harness
hook, screenshot it, walk the stage lines for the crossfade, check the pool cap."""
import asyncio, pathlib, sys
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/orbit.html"
OUT = pathlib.Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

async def main():
    errors, fails = [], []
    def check(name, ok, info=""):
        print(("PASS " if ok else "FAIL ") + name + (" — " + str(info) if info else ""))
        if not ok: fails.append(name)
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1000, "height": 640})
        pg.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") and "404" not in m.text else None)
        pg.on("response", lambda r: print("  404:", r.url) if r.status == 404 else None)
        pg.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        await pg.goto(URL); await pg.wait_for_timeout(900)
        await pg.click("#btnStart"); await pg.wait_for_timeout(500)
        st = await pg.evaluate("window.__stage()")
        check("backgrounds decoded", all(st["far"]) and all(st["near"]) and len(st["far"]) == 4, st)

        # --- homing missiles ---
        check("give H", await pg.evaluate("window.__give('h')"))
        await pg.keyboard.down("ArrowRight"); await pg.keyboard.down("KeyX")
        await pg.wait_for_timeout(700)
        await pg.screenshot(path=OUT / "w-missile.png")
        hud = await pg.inner_text("#hGun")
        check("HUD shows H ammo", hud.startswith("H"), hud)
        await pg.wait_for_timeout(2500)
        hud2 = await pg.inner_text("#hGun")
        check("H reverts to N after 30 shots", hud2.startswith("N"), hud2)
        await pg.keyboard.up("KeyX")

        # --- servo-skull ---
        check("give D", await pg.evaluate("window.__give('d')"))
        await pg.wait_for_timeout(400)
        check("drone alive", await pg.evaluate("CONTRA._state().drones.some(function(d){return d&&d.alive})"))
        await pg.screenshot(path=OUT / "w-skull.png")
        await pg.keyboard.up("ArrowRight"); await pg.keyboard.down("ArrowLeft"); await pg.wait_for_timeout(120)
        await pg.screenshot(path=OUT / "w-skull-bank.png")
        await pg.keyboard.up("ArrowLeft"); await pg.keyboard.down("ArrowRight")
        for i in range(8):
            await pg.wait_for_timeout(300)
            drones = await pg.evaluate("CONTRA._state().drones.filter(function(d){return d&&d.alive}).length")
            if drones and await pg.evaluate("CONTRA._state().drones.some(function(d){return d&&d.alive&&d.laserT>0})"):
                await pg.screenshot(path=OUT / "w-skull-laser.png"); break
        # (the skull despawns with its player — a dead runner by now is fine)

        # --- thunderhawk ---
        check("give T", await pg.evaluate("window.__give('t')"))
        for i in range(5):
            await pg.wait_for_timeout(330)
            await pg.screenshot(path=OUT / f"w-hawk{i}.png")
        await pg.wait_for_timeout(600)
        check("hawk finished", not await pg.evaluate("(CONTRA._state().hawk||{}).on"))
        await pg.keyboard.up("ArrowRight")

        # --- pool cap: spam spread gun + count ---
        await pg.evaluate("window.__give('s')")
        await pg.keyboard.down("KeyX"); await pg.wait_for_timeout(2000)
        pool = await pg.evaluate("window.__pool()")
        check("pool under cap", pool["alive"] <= pool["cap"], pool)
        await pg.keyboard.up("KeyX")

        # --- stages: level 1 col 0 / 210 (stage 2 after fade) ---
        await pg.evaluate("window.__warp(150*16)"); await pg.wait_for_timeout(200)
        await pg.screenshot(path=OUT / "w-stage1.png")
        await pg.evaluate("window.__warp(205*16)"); await pg.wait_for_timeout(700)
        st = await pg.evaluate("window.__stage()")
        check("crossfade running at col 200", st["stage"] == 1 and st["prev"] == 0 and st["fade"] > 0, st)
        await pg.screenshot(path=OUT / "w-stage-fade.png")
        await pg.wait_for_timeout(1800)
        st = await pg.evaluate("window.__stage()")
        check("crossfade done", st["stage"] == 1 and st["fade"] == 0, st)
        await pg.screenshot(path=OUT / "w-stage2.png")
        # level 2 start = global col 240 (stage 2), col 200 in level 2 = global 440 (stage 3)
        await pg.evaluate("window.__level(1)"); await pg.evaluate("window.__warp(190*16)"); await pg.wait_for_timeout(2600)
        st = await pg.evaluate("window.__stage()")
        check("level 2 col 190 = stage 3", st["stage"] == 2, st)
        await pg.screenshot(path=OUT / "w-stage3.png")
        await pg.evaluate("window.__level(2)"); await pg.evaluate("window.__warp(180*16)"); await pg.wait_for_timeout(2600)
        st = await pg.evaluate("window.__stage()")
        check("level 3 col 180 = stage 4", st["stage"] == 3, st)
        await pg.screenshot(path=OUT / "w-stage4.png")
        # tiers
        for q in (0, 1):
            await pg.evaluate(f"window.__setQuality({q})"); await pg.wait_for_timeout(200)
            await pg.screenshot(path=OUT / f"w-stage4-q{q}.png")
        await b.close()
    print("console:", len(errors))
    for e in errors[:20]: print("  ", e)
    check("no console errors", not errors)
    print("\nALL GREEN" if not fails else f"\nFAILED: {fails}")
    sys.exit(1 if fails else 0)

asyncio.run(main())
