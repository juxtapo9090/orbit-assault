#!/usr/bin/env python3
"""drive_bosses.py — one run per level, warped to the boss, and the question is
always the same: is this a DIFFERENT fight from the last one?

Three claims, each failing for its own reason:
  1. IDENTITY   — the level's boss is the one LEVEL_BOSS names, with its own HP.
  2. BEHAVIOUR  — it actually does its thing: the Warboss charges and gets
                  stunned, the Sorcerer blinks and opens a portal, and the weak
                  point is shut for part of the fight (a boss that is always
                  open is not a pattern, it is a wall).
  3. DAMAGE     — shooting the open weak point moves the bar. Asserted for the
                  two bosses this pass ADDED; the Dreadnought's own damage claim
                  lives in drive_boss.py, which parks the player point-blank and
                  watches the bar fall over 36s. Its window is 1.5s in every 4 and
                  its iris is 9px, so a bot that keeps turning to face a boss that
                  never moves lands a hit only by luck — that would be a flaky
                  assertion about the harness, not a claim about the game.
"""
import asyncio, pathlib, sys
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/orbit.html"
OUT = pathlib.Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

# level -> (expected boss name, expected hpMax, boss column in that level)
WANT = [("DREADNOUGHT", 30, 231), ("WARBOSS", 45, 215), ("SORCERER", 75, 231)]


async def main():
    fails, errs = [], []
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable",
                                     args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1000, "height": 640})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "404" not in m.text else None)
        await pg.goto(URL); await pg.wait_for_timeout(500)
        await pg.click("#btnStart"); await pg.wait_for_timeout(400)
        await pg.evaluate("window.__setQuality(2)")

        for lvl, (name, hp, col) in enumerate(WANT):
            await pg.evaluate(f"window.__level({lvl})"); await pg.wait_for_timeout(200)
            await pg.evaluate(f"window.__warp({(col - 12) * 16})"); await pg.wait_for_timeout(500)
            info = await pg.evaluate("window.__contra()")
            got = info["boss"]
            tag = f"L{lvl+1}"
            if not got:
                fails.append(f"{tag}: no boss built"); continue
            ok = got["name"] == name and got["hpMax"] == hp
            print(f"  {tag} boss={got['name']:<11} hpMax={got['hpMax']:<3} "
                  f"{'PASS' if ok else 'FAIL want ' + name + '/' + str(hp)}")
            if not ok:
                fails.append(f"{tag}: got {got['name']}/{got['hpMax']}, want {name}/{hp}")

            # Engage and hold the trigger for 30s, sampling what the boss does. Thirty,
            # not twelve: the Dreadnought's weak point is open 1.5s in every 4 and its
            # ports have to be chipped first, so its FIRST point of damage lands around
            # the 24s mark. A window shorter than the slowest boss's opening tests the
            # window, not the boss.
            await pg.keyboard.down("ArrowRight"); await pg.wait_for_timeout(900)
            await pg.keyboard.up("ArrowRight")
            # Aim up-DIAGONAL and TURN TO FACE HIM. Two of these three bosses move
            # (one charges the width of the arena, one blinks), so a fixed heading
            # tests nothing: a held Right just walks you into the far wall while the
            # boss stuns out of frame behind you. Face the boss, hold up, hold fire.
            await pg.keyboard.down("KeyX"); await pg.keyboard.down("ArrowUp")
            facing = None
            modes, opens, portal, hp0 = set(), set(), False, None
            for i in range(60):
                await pg.wait_for_timeout(500)
                info = await pg.evaluate("window.__contra()")
                B = info["boss"]
                if not B or not B["alive"]:
                    break
                if B["engaged"]:
                    modes.add(B["mode"]); opens.add(B["open"])
                    if hp0 is None:
                        hp0 = B["hp"]
                if info["portal"]:
                    portal = True
                if i in (10, 30, 50):
                    await pg.screenshot(path=OUT / f"boss{lvl+1}-{i}.png")
                me = await pg.evaluate("window.__dbg().players[window.__dbg().me]")
                want = "ArrowLeft" if B["x"] < me[1] else "ArrowRight"
                if want != facing:
                    if facing:
                        await pg.keyboard.up(facing)
                    await pg.keyboard.down(want); facing = want
                # jump now and then so the Warboss charge has something to miss
                if i % 3 == 0:
                    await pg.keyboard.down("Space"); await pg.wait_for_timeout(120); await pg.keyboard.up("Space")
            await pg.keyboard.up("KeyX"); await pg.keyboard.up("ArrowUp")
            if facing:
                await pg.keyboard.up(facing)
            info = await pg.evaluate("window.__contra()")
            B = info["boss"]
            hp1 = B["hp"] if B else 0
            dealt = (hp0 - hp1) if hp0 is not None else 0
            print(f"     modes seen {sorted(modes)}  weak-point open/shut {sorted(opens)}  "
                  f"portal={portal}  damage dealt {dealt}/{hp}")

            if len(opens) < 2:
                fails.append(f"{tag}: weak point never changed state (always {opens}) — no pattern to learn")
            if dealt <= 0 and lvl > 0:
                fails.append(f"{tag}: 30s of held fire moved the bar by {dealt}")
            if lvl == 1 and len(modes) < 3:
                fails.append(f"{tag}: Warboss only reached modes {sorted(modes)}, wants idle/charge/stunned")
            if lvl == 2:
                if len(modes) < 2:
                    fails.append(f"{tag}: Sorcerer never blinked (modes {sorted(modes)})")
                if not portal:
                    fails.append(f"{tag}: no warp portal opened in 30s")
        await b.close()

    print("\nVERDICT:", "PASS — three different bosses, three different fights" if not fails else "FAIL")
    for f in fails:
        print("  ", f)
    if errs:
        print("  console:", errs[:5])
    sys.exit(1 if fails or errs else 0)


asyncio.run(main())
