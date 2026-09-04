#!/usr/bin/env python3
"""Prove the auto-tier without pretending this box is idle.

Three separate claims, tested separately, because they fail for different reasons:

  1. THRESHOLDS — pure function, machine-independent. 50 and 35 are the edges.
  2. APPLICATION — forcing each tier really does change the backing store, the
     transform scale and LIGHT's quality gate. Also writes the visual A/B shots.
  3. MEASUREMENT — the probe reacts to real load. Asserted as MONOTONIC (more CPU
     throttle never yields a higher tier), not as an absolute, because the tier a
     loaded machine picks is a fact about the machine, not about this code. The
     run prints the host's load average so a surprising number is readable.
"""
import asyncio, os, pathlib, sys
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/orbit.html"
OUT = pathlib.Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

# (input fps, expected tier) — both boundaries, and one step either side of each.
THRESHOLDS = [(60, 2), (50, 2), (49.9, 1), (35, 1), (34.9, 0), (10, 0), (0, 0)]


async def page(pw, throttle=1):
    b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable", args=["--no-sandbox"])
    pg = await b.new_page(viewport={"width": 1000, "height": 640})
    if throttle > 1:
        cdp = await pg.context.new_cdp_session(pg)
        await cdp.send("Emulation.setCPUThrottlingRate", {"rate": throttle})
    await pg.goto(URL)
    await pg.wait_for_timeout(1200)
    return b, pg


async def main():
    fails = []
    async with async_playwright() as pw:
        # ---- 1. thresholds ----
        print("thresholds (pure, machine-independent):")
        b, pg = await page(pw)
        for fps, want in THRESHOLDS:
            got = await pg.evaluate("f => window.__pickTier(f)", fps)
            ok = got == want
            print(f"  {fps:>5} fps -> tier {got} {'PASS' if ok else 'FAIL want ' + str(want)}")
            if not ok:
                fails.append(f"pickTier({fps})={got} want {want}")

        # ---- 2. application + the visual A/B ----
        print("\napplication (forced tiers, same scene):")
        await pg.click("#btnStart")
        await pg.wait_for_timeout(600)
        await pg.evaluate("window.__warp(150)")
        want = {2: (2, 960, 540), 1: (1.5, 720, 405), 0: (1, 480, 270)}
        for tier, name in ((2, "high"), (1, "medium"), (0, "low")):
            q = await pg.evaluate("window.__setQuality(%d)" % tier)
            await pg.wait_for_timeout(400)
            ws, ww, wh = want[tier]
            ok = (q["scale"] == ws and q["canvas"] == [ww, wh] and q["lightQ"] == tier)
            print(f"  {name:6s} -> scale {q['scale']}  canvas {q['canvas']}  lightQ {q['lightQ']}  "
                  f"{'PASS' if ok else 'FAIL'}")
            if not ok:
                fails.append(f"tier {name} applied wrong: {q}")
            await pg.screenshot(path=OUT / f"tier-forced-{name}.png")
        await b.close()

        # ---- 3. measurement under real load ----
        try:
            load = os.getloadavg()[0]
        except OSError:
            load = -1.0
        print(f"\nmeasurement (host 1-min load average {load:.1f}):")
        seen = []
        for throttle in (1, 2, 4, 8):
            b, pg = await page(pw, throttle)
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.click("#btnStart")
            await pg.wait_for_function("window.__quality().locked", timeout=90000)
            q = await pg.evaluate("window.__quality()")
            print(f"  throttle {throttle}x -> {q['avgFps']:>5} fps  tier {q['name']}  "
                  f"scale {q['scale']}  canvas {q['canvas']}")
            seen.append((throttle, q["tier"], q["avgFps"]))
            if errs:
                fails.append(f"{throttle}x console: {errs[:3]}")
            await b.close()

        for (t0, q0, f0), (t1, q1, f1) in zip(seen, seen[1:]):
            if q1 > q0:
                fails.append(f"non-monotonic: {t1}x picked tier {q1} but {t0}x picked {q0}")
        if seen[-1][1] != 0:
            fails.append(f"8x throttle ({seen[-1][2]} fps) did not reach Low")
        print("  monotonic:", "FAIL" if any("monotonic" in f for f in fails) else "PASS")

    print("\nVERDICT:", "PASS — thresholds, application and measurement all hold"
          if not fails else "FAIL")
    for f in fails:
        print("  ", f)
    sys.exit(1 if fails else 0)


asyncio.run(main())
