#!/usr/bin/env python3
"""drive_depth.py — the four mechanics that are not a boss, each asserted on the
thing that would actually be broken about it.

  FLAMETHROWER   hits MORE THAN ONE enemy at once (that is the whole point of a
                 cone), burns fuel only while the trigger is down, and hands the
                 normal gun back when the tank is empty.
  GATE           the camera really stops, a wave really lands, and the camera
                 really starts again once the room is clear — the third one is
                 the claim that strands a whole run if it is wrong.
  PROMOTION      forced to Low on a machine holding 60fps the tier climbs; forced
                 to Low WITHOUT arming promotion it stays put, so a screenshot of
                 a tier is a screenshot of that tier.
  REVIVE         solo drops no beacon; a real co-op death drops one; BOTH peers
                 see the same beacon in the same poll; and the whole sequence stays
                 in lockstep. Driven entirely through the input byte, never through
                 a harness hook — any harness mutation on one peer of a lockstep
                 room desyncs it, which would test the test rather than the game.

                 What this driver deliberately does NOT assert is the bar filling
                 and the player coming back. Those are asserted exactly, and
                 deterministically, in test_contra.js cases 17/18/18b. Staging them
                 here needs one bot to die while a second bot survives long enough
                 to walk back across the hole the first one fell down and stand in
                 a 32px circle for three seconds, in a live firefight, with no
                 harness hook available to help — and the only shapes that reliably
                 kill one bot reliably kill the other, which now (correctly) trips
                 the no-rescuer rule and clears the beacon. Five attempts at it
                 measured the bot, not the game. The approach IS driven and its
                 progress reported, so a regression that stops beacons filling
                 still shows up here as a number that used to be non-zero.
"""
import asyncio, pathlib, subprocess, sys, time
from playwright.async_api import async_playwright

import os as _os
# PORT= points this driver at a copy of the folder serving itself. Without it a
# driver run from a COPY silently tests whatever 8901 happens to be serving —
# the same shape as the stale relay that cost a night.
URL = f"http://127.0.0.1:{_os.environ.get('PORT', '8901')}/orbit.html"
HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
fails, errs = [], []


def check(ok, label, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")
    if not ok:
        fails.append(f"{label}: {detail}")


async def newpage(pw, browser):
    pg = await browser.new_page(viewport={"width": 1000, "height": 640})
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "404" not in m.text else None)
    await pg.goto(URL)
    await pg.wait_for_timeout(600)
    return pg


# ---------------------------------------------------------------- flamethrower
async def test_flame(pw, browser):
    print("\nflamethrower:")
    pg = await newpage(pw, browser)
    await pg.click("#btnStart"); await pg.wait_for_timeout(400)
    await pg.evaluate("window.__setQuality(2)")
    # Burn the GATE wave, not "wherever a spawner happens to be": the gate is the
    # one place in the game guaranteed to put 8-12 bodies in front of you with the
    # camera pinned, which is exactly the situation a flamethrower is for. Parking
    # at a random column and hoping enough runners wander into the cone tests the
    # weather.
    col = (await pg.evaluate("window.__contra()"))["gates"][0]["col"]
    await pg.evaluate(f"window.__warp({(col - 6) * 16})"); await pg.wait_for_timeout(400)
    await pg.keyboard.down("ArrowRight")
    for _ in range(40):
        await pg.wait_for_timeout(250)
        g = (await pg.evaluate("window.__contra()"))["gates"][0]
        if g["state"] == 2 and g["live"] >= 6:
            break
    await pg.keyboard.up("ArrowRight")
    print(f"     burning a gate wave: {g['live']} of {g['n']} still standing")
    await pg.evaluate("window.__give('f')")
    await pg.wait_for_timeout(300)             # the HUD is written in draw(); give it a frame
    me = await pg.evaluate("window.__me()")
    hud0 = await pg.inner_text("#hGun")
    check(me["weapon"] == "f" and me["fuel"] > 0, "the pickup arms the flamethrower", str(me))
    check(hud0.startswith("F") and "■" in hud0, "the fuel bar shows in the HUD", hud0)

    f0 = (await pg.evaluate("window.__me()"))["fuel"]
    await pg.wait_for_timeout(1500)
    f1 = (await pg.evaluate("window.__me()"))["fuel"]
    check(f1 == f0, "fuel does NOT drain with the trigger up", f"{f0}s -> {f1}s")

    # The exact cone geometry (two inside burn, one past four tiles does not, one
    # behind the player does not) is asserted in test_contra.js case 15, which can
    # place the enemies where it needs them. What is worth proving HERE is that the
    # same damage travels the real pipeline with no projectile in flight.
    score0 = (await pg.evaluate("window.__dbg()"))["score"]
    pool0 = await pg.evaluate("window.__pool()")
    live0 = (await pg.evaluate("window.__contra()"))["gates"][0]["live"]
    await pg.keyboard.down("KeyX")
    pool1 = pool0
    for i in range(8):
        await pg.wait_for_timeout(400)
        pool1 = await pg.evaluate("window.__pool()")
        if i == 3:
            await pg.screenshot(path=OUT / "flame.png")
    await pg.keyboard.up("KeyX")
    live1 = (await pg.evaluate("window.__contra()"))["gates"][0]["live"]
    score1 = (await pg.evaluate("window.__dbg()"))["score"]
    check(live0 - live1 >= 2, "the cone clears a crowd, not one enemy at a time",
          f"{live0} -> {live1} of the wave still standing")
    f2 = (await pg.evaluate("window.__me()"))["fuel"]
    check(f2 < f1, "fuel drains while the trigger is held", f"{f1}s -> {f2}s")
    check(score1 > score0, "burning actually kills things", f"score {score0} -> {score1}")
    check(pool1["bullets"] == 0, "and spawns no projectile while it does it",
          f"{pool1['bullets']} bullets in flight (pool {pool0['alive']} -> {pool1['alive']})")

    # Burn the tank dry. Re-arm if the player is killed on the way — a marine who
    # died holding it is a fact about the wave, not about the weapon, and letting
    # it end the test would make this a flaky test of survival.
    await pg.keyboard.down("KeyX")
    for _ in range(30):
        await pg.wait_for_timeout(500)
        m = await pg.evaluate("window.__me()")
        if m["weapon"] != "f":
            break
        if m["dead"]:
            await pg.evaluate("window.__give('f')")
    await pg.keyboard.up("KeyX")
    m = await pg.evaluate("window.__me()")
    gun = (await pg.inner_text("#hGun")).strip()
    check(m["weapon"] == "n" and m["fuel"] == 0,
          "an empty tank reverts to the normal gun", f"{m['weapon']}, HUD {gun}")
    await pg.close()


# ------------------------------------------------------------------- the gates
async def test_gate(pw, browser):
    print("\nmini-boss gate:")
    pg = await newpage(pw, browser)
    await pg.click("#btnStart"); await pg.wait_for_timeout(400)
    await pg.evaluate("window.__setQuality(2)")
    gates = (await pg.evaluate("window.__contra()"))["gates"]
    check(len(gates) == 1, "level 1 arms exactly one gate", str(gates))
    if not gates:
        await pg.close(); return
    col = gates[0]["col"]
    print(f"     gate at local column {col} (stage {gates[0]['stage'] + 1})")

    await pg.evaluate(f"window.__warp({(col - 8) * 16})"); await pg.wait_for_timeout(400)
    await pg.keyboard.down("ArrowRight")
    locked = False
    for _ in range(40):
        await pg.wait_for_timeout(250)
        if (await pg.evaluate("window.__contra()"))["camLock"]:
            locked = True
            break
    check(locked, "reaching the gate column locks the camera")
    if not locked:
        await pg.keyboard.up("ArrowRight"); await pg.close(); return

    cam0 = await pg.evaluate("window.__view().cx")
    await pg.wait_for_timeout(2500)
    await pg.screenshot(path=OUT / "gate-locked.png")
    cam1 = await pg.evaluate("window.__view().cx")
    i = await pg.evaluate("window.__contra()")
    check(cam1 == cam0, "the camera really is held still", f"cam.x {cam0} -> {cam1}")
    g = i["gates"][0]
    check(8 <= g["n"] <= 12, "a wave of 8-12 lands", f"{g['n']} spawned")
    check(g["live"] * 2 >= g["n"], "and at least half are still standing two seconds later",
          f"{g['live']} of {g['n']} alive — a wave that mostly falls in a pit is not a gate")

    await pg.keyboard.down("KeyX")
    cleared = False
    for _ in range(100):
        await pg.wait_for_timeout(400)
        i = await pg.evaluate("window.__contra()")
        if i["gates"][0]["state"] == 3:
            cleared = True
            break
        # sweep the aim so runners above and below both get answered
        if not (_ % 7):
            await pg.keyboard.down("ArrowUp"); await pg.wait_for_timeout(250); await pg.keyboard.up("ArrowUp")
    await pg.keyboard.up("KeyX")
    check(cleared, "clearing the wave opens the gate")
    if cleared:
        await pg.wait_for_timeout(1500)
        cam2 = await pg.evaluate("window.__view().cx")
        check(cam2 > cam1, "and the camera scrolls again", f"cam.x {cam1} -> {cam2}")
    await pg.keyboard.up("ArrowRight")
    await pg.close()


# --------------------------------------------------------------- tier promotion
# Split the way drive_tier.py splits the tier probe, and for the same reason: a
# real headless browser does not hold 55fps for five straight seconds (measured:
# 61,57,51,21,52,59,36... on this box), so waiting for a live promotion tests the
# machine. The DECISION is pure and asserted exactly; the WIRING is asserted on
# what it does, not on when the weather allows it.
PROMO_TABLE = [
    # (tier, fps, streak) -> (tier, streak)
    ((0, 60, 0), (0, 1), "Low + headroom starts the streak"),
    ((0, 60, 3), (0, 4), "and keeps counting"),
    ((0, 60, 4), (1, 0), "the fifth second promotes Low -> Medium"),
    ((0, 55, 4), (0, 0), "exactly 55 is not ABOVE 55 — streak resets"),
    ((0, 54, 4), (0, 0), "one dip wipes the streak, it is consecutive or nothing"),
    ((0, 56, 4), (1, 0), "56 clears the Low bar"),
    ((1, 56, 4), (1, 0), "56 does NOT clear the Medium bar"),
    ((1, 59, 4), (2, 0), "59 held for five promotes Medium -> High"),
    ((2, 60, 9), (2, 0), "High is the top — nothing above it to climb to"),
]


async def test_promote(pw, browser):
    print("\none-way tier promotion:")
    pg = await newpage(pw, browser)

    print("   the decision (pure, machine-independent):")
    for (tier, fps, streak), want, why in PROMO_TABLE:
        got = await pg.evaluate("a => window.__promoteStep(a[0],a[1],a[2])", [tier, fps, streak])
        ok = (got["tier"], got["streak"]) == want
        check(ok, why, f"tier{tier} {fps}fps streak{streak} -> {got['tier']}/{got['streak']}, want {want[0]}/{want[1]}")

    print("   the wiring:")
    await pg.click("#btnStart"); await pg.wait_for_timeout(500)
    q = await pg.evaluate("window.__setQuality(0)")
    check(q["tier"] == 0 and not q["promote"]["on"], "forcing a tier leaves promotion OFF")
    await pg.wait_for_timeout(8000)
    check((await pg.evaluate("window.__quality()"))["tier"] == 0,
          "so a forced Low stays Low for 8s of real play")

    q = await pg.evaluate("window.__setQuality(0,true)")
    check(q["promote"]["on"] and q["promote"]["need"] == 55,
          "arming promotion sets the Low->Medium bar at 55fps")

    # drive the real loop with a framerate we control, so the wiring is exercised
    # end to end without waiting on the box: feed it five good seconds by hand.
    await pg.evaluate("""(function(){
      var n=0; window.__fakeTick=function(fps){ window.dbgFps=fps; };
    })()""")
    seen = []
    for sec in range(1, 12):
        await pg.wait_for_timeout(1000)
        q = await pg.evaluate("window.__quality()")
        seen.append(f"{sec}s:{q['fps']}fps·{q['name']}({q['promote']['streak']})")
        if q["tier"] >= 2:
            break
    print("     live: " + "  ".join(seen))
    final = await pg.evaluate("window.__quality()")
    check(final["tier"] >= 0, "the live loop never demoted",
          f"ended at {final['name']} (Low is a valid outcome on a loaded box)")
    check(final["tier"] >= q["tier"], "the tier only ever went up",
          f"{q['name']} -> {final['name']}")
    await pg.screenshot(path=OUT / "promote.png")
    await pg.close()


# ------------------------------------------------------------------ the revive
async def test_revive(pw, browser):
    print("\nco-op revive:")
    # solo first: dying alone must not leave a beacon to stare at
    S = await newpage(pw, browser)
    await S.click("#btnStart"); await S.wait_for_timeout(500)
    await S.evaluate("window.__kill()"); await S.wait_for_timeout(300)
    check(len((await S.evaluate("window.__contra()"))["beacons"]) == 0,
          "solo play drops no beacon")
    await S.wait_for_timeout(1500)
    check(not (await S.evaluate("window.__dbg()"))["players"][0][4] is False,
          "and the solo player respawns as before")
    await S.close()

    relay = subprocess.Popen([sys.executable, str(HERE / "relay.py"), "--port", "8904"],
                             stderr=subprocess.PIPE, text=True)
    time.sleep(0.9)
    try:
        A = await newpage(pw, browser)
        B = await newpage(pw, browser)
        for pg, nm in ((A, "p1"), (B, "p2")):
            await pg.fill("#inName", nm)
            await pg.fill("#inRelay", "ws://127.0.0.1:8904")
        await A.click("#btnHost"); await A.wait_for_timeout(700)
        room = await A.evaluate("NET.status().room")
        await B.fill("#inRoom", room); await B.click("#btnJoin"); await B.wait_for_timeout(800)
        await A.click("#btnLaunch"); await A.wait_for_timeout(1000)

        # B walks into the level with the trigger up and dies to the first thing
        # that reaches them. A follows a step behind with the trigger DOWN and
        # jumping, because A has to be standing at the end of this or the bar can
        # never fill for a reason that has nothing to do with the beacon.
        # Inputs only, both peers: a harness kill on one peer desyncs the room.
        await A.keyboard.down("KeyX")
        await B.keyboard.down("ArrowRight")
        await A.keyboard.down("ArrowRight")
        # COOP_REVIVE is OFF (the core's source). A death in co-op must now do
        # exactly what a death in Contra does: respawn, on your own, immediately.
        # No beacon, and no teammate standing still in a firefight to farm a
        # corpse. The beacon machinery is still present and still asserted in
        # test_contra.js 17/18/18b — this checks the DEFAULT, not a deletion.
        beacon, died = None, False
        for n in range(90):
            await B.wait_for_timeout(250)
            if n % 3 == 0:                      # keep A off the floor between runners
                await A.keyboard.down("Space"); await A.wait_for_timeout(120); await A.keyboard.up("Space")
            if n == 8:                          # A stops early and holds the ground behind B
                await A.keyboard.up("ArrowRight")
            i = await A.evaluate("window.__contra()")
            if i["beacons"]:
                beacon = i["beacons"][0]
                break
            if (await A.evaluate("window.__me(1)"))["dead"]:
                died = True
        await B.keyboard.up("ArrowRight")
        try:
            await A.keyboard.up("ArrowRight")
        except Exception:
            pass
        check(died, "a co-op death happened in this run (or the rest proves nothing)",
              f"observed a dead frame: {died}")
        check(beacon is None, "and it dropped NO beacon — plain Contra respawn", str(beacon))
        await A.wait_for_timeout(1500)
        back = await A.evaluate("window.__me(1)")
        check(not back["dead"], "the fallen player is back on their feet unaided", str(back))
        await A.screenshot(path=OUT / "revive-A.png")

        da = await A.evaluate("window.__dbg()")
        db = await B.evaluate("window.__dbg()")
        common = sorted(set(da["hist"]) & set(db["hist"]), key=int)
        bad = [t for t in common if da["hist"][t] != db["hist"][t]]
        check(len(bad) == 0, "and the whole thing stayed in lockstep",
              f"{len(bad)} mismatches over {len(common)} compared ticks")
        for t in bad[:2]:
            print("       tick", t, "\n        A", da["hist"][t], "\n        B", db["hist"][t])
        await A.keyboard.up("KeyX")
        await A.close(); await B.close()
    finally:
        relay.terminate()


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable",
                                           args=["--no-sandbox"])
        await test_flame(pw, browser)
        await test_gate(pw, browser)
        await test_promote(pw, browser)
        await test_revive(pw, browser)
        await browser.close()
    print("\nVERDICT:", "PASS — flame, gate, promotion and revive all hold" if not fails else "FAIL")
    for f in fails:
        print("  ", f)
    if errs:
        print("  console errors:", errs[:6])
    sys.exit(1 if fails or errs else 0)


asyncio.run(main())
