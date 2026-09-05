#!/usr/bin/env python3
"""drive_gate2.py — why does the stage-2 mini-boss gate strand the run?

Found by playing, not by testing: WARNING fired, the camera locked, and the room
never cleared — an enemy the gate is still counting that the player can never reach.

drive_depth.py's gate test only ever drives LEVEL 1. This one drives each level's
gate and, when the room does not clear, reports WHERE every enemy the gate is
still counting actually is: on screen, off the left edge, inside a wall, standing
still. A live count alone cannot tell those apart, and the difference is the bug.
"""
import asyncio, pathlib, sys
from playwright.async_api import async_playwright

import os as _os
URL = f"http://127.0.0.1:{_os.environ.get('PORT', '8913')}/orbit.html"
OUT = pathlib.Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

# Everything the gate counts, plus where it is relative to what the player can see
# and whether it has moved at all since the last poll.
CENSUS = """() => {
  const st = CONTRA._state(), v = window.__view(), cam = v.cx;
  const VW = window.__stage ? 480 : 480;
  const out = [];
  const take = (list, kind) => {
    for (const e of list) {
      if (!e.alive || e.gate !== 0) continue;
      out.push({kind, id: e.id, x: Math.round(e.x), y: Math.round(e.y),
                vx: Math.round(e.vx || 0), vy: Math.round(e.vy || 0),
                onGround: !!e.onGround,
                screen: Math.round(e.x - cam)});
    }
  };
  take(st.runners, 'runner'); take(st.snipers, 'sniper');
  return {cam, VW, gates: st.gates.map(g => ({col: g.col, stage: g.stage, state: g.state, n: g.n})),
          enemies: out};
}"""


async def probe(browser, level):
    print(f"\n=== level {level + 1} ===")
    pg = await browser.new_page(viewport={"width": 1000, "height": 640})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(URL)
    await pg.wait_for_timeout(600)
    await pg.click("#btnStart")
    await pg.wait_for_timeout(400)
    await pg.evaluate("window.__setQuality(2)")
    await pg.evaluate(f"window.__level({level})")
    await pg.wait_for_timeout(400)

    gates = (await pg.evaluate("window.__contra()"))["gates"]
    print(f"  gates armed: {gates}")
    if not gates:
        print("  no gate on this level — nothing to strand")
        await pg.close()
        return
    col = gates[0]["col"]
    print(f"  gate at local col {col} (stage {gates[0]['stage'] + 1})")

    await pg.evaluate(f"window.__warp({(col - 8) * 16})")
    await pg.wait_for_timeout(400)
    # Hold right AND jump. Level 2 puts a three-tile pillar immediately before its
    # gate column; a driver that only walks never reaches the trigger at all, and
    # reports "no gate here" for what is really "I cannot climb".
    await pg.keyboard.down("ArrowRight")
    locked = False
    for _ in range(40):
        await pg.keyboard.down("Space")
        await pg.wait_for_timeout(400)
        await pg.keyboard.up("Space")
        await pg.wait_for_timeout(200)
        if (await pg.evaluate("window.__contra()"))["camLock"]:
            locked = True
            break
    print(f"  camera locked: {locked}")
    if not locked:
        print("  never reached the trigger:", await pg.evaluate("window.__why()"))
    if not locked:
        await pg.keyboard.up("ArrowRight")
        await pg.close()
        return

    await pg.wait_for_timeout(2000)
    c = await pg.evaluate(CENSUS)
    print(f"  wave landed: {c['gates'][0]['n']} declared, {len(c['enemies'])} alive, cam={c['cam']}")

    # Now play it out: fire, sweep the aim, and see whether the room ever clears.
    await pg.keyboard.down("KeyX")
    cleared = False
    last = {}
    for step in range(180):
        await pg.wait_for_timeout(500)
        info = await pg.evaluate("window.__contra()")
        if not (step % 10):
            print(f"    t+{step*0.5:5.1f}s live={info['gates'][0]['live']}")
        if info["gates"][0]["state"] == 3:
            cleared = True
            print(f"    cleared at t+{step*0.5:.1f}s")
            break
        if not (step % 6):
            await pg.keyboard.down("ArrowUp")
            await pg.wait_for_timeout(250)
            await pg.keyboard.up("ArrowUp")
        if not (step % 4):
            await pg.keyboard.down("Space")
            await pg.wait_for_timeout(400)
            await pg.keyboard.up("Space")
    await pg.keyboard.up("KeyX")
    await pg.keyboard.up("ArrowRight")

    print(f"  CLEARED: {cleared}")
    if not cleared:
        c = await pg.evaluate(CENSUS)
        print(f"  STRANDED — {len(c['enemies'])} enemies still counted, cam={c['cam']}, VW={c['VW']}")
        await pg.screenshot(path=OUT / f"gate-stuck-L{level + 1}.png")
        for e in c["enemies"]:
            where = "ON SCREEN" if 0 <= e["screen"] <= c["VW"] else (
                "OFF LEFT" if e["screen"] < 0 else "OFF RIGHT")
            print(f"    {e['kind']} #{e['id']} x={e['x']} y={e['y']} "
                  f"screenX={e['screen']} ({where}) vx={e['vx']} vy={e['vy']} "
                  f"ground={e['onGround']}")
        print("  player:", await pg.evaluate("window.__why()"))
        if c["enemies"]:
            e0 = c["enemies"][0]
            g = await pg.evaluate(f"window.__grid({e0['x']}, {e0['y']}, 20, 8)")
            print(f"  terrain around the stuck runner (from col {g['from'][0]}, row {g['from'][1]}):")
            for row in g["grid"]:
                print("   ", row)
        # Did any of them move at all over a second?
        await pg.wait_for_timeout(1000)
        c2 = await pg.evaluate(CENSUS)
        pos = {e["id"]: (e["x"], e["y"]) for e in c["enemies"]}
        for e in c2["enemies"]:
            p = pos.get(e["id"])
            if p and p == (e["x"], e["y"]):
                print(f"    -> #{e['id']} has not moved a pixel in a second: WEDGED")
    if errs:
        print("  console errors:", errs[:4])
    await pg.close()


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path="/usr/bin/google-chrome-stable", args=["--no-sandbox"])
        for lv in (0, 1, 2):
            await probe(browser, lv)
        await browser.close()


asyncio.run(main())
