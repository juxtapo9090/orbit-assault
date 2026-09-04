#!/usr/bin/env python3
"""Drive the walk/aim animation contract: hold each pose, crop tight on the marine.

Reads the player's live position out of the page and crops the canvas around it, so
the check is "is the right frame on screen", not "can I find a 20px marine in a
1000px screenshot". Writes shots/anim-*.png and prints which sheet each pose used.
"""
import asyncio, pathlib
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/orbit.html"
OUT = pathlib.Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

# name -> keys held while the shot is taken
POSES = [
    ("stand", []),
    ("walk-a", ["ArrowRight"]),
    ("walk-b", ["ArrowRight"]),
    ("aim-up", ["ArrowUp"]),
    ("aim-diagup", ["ArrowRight", "ArrowUp"]),
    ("aim-diagdown", ["Space", "ArrowDown"]),   # down only aims while airborne
    ("prone", ["ArrowDown"]),
]

# the marine's on-screen box, read from the same globals the renderer uses
PROBE = """() => {
  const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect();
  const w = window.__pose ? window.__pose() : null;
  if (w) w.raw = INPUT.get();
  return w ? {...w, left: r.left, top: r.top, cw: r.width, ch: r.height} : null;
}"""


async def shoot(pg, name, keys):
    # a shield every pose: warping into open level drops the marine among orks, and a
    # dead marine is not drawn at all — the crop would be a screenshot of his killer.
    await pg.evaluate("() => window.__give('b')")
    for k in keys:
        await pg.keyboard.down(k)
        await pg.wait_for_timeout(60)
    await pg.wait_for_timeout(180 if "diagdown" in name else 360)
    d = await pg.evaluate(PROBE)
    if d and d.get('dead'):
        raise SystemExit(f'{name}: marine is dead — the shield lapsed, nothing to photograph')
    if not d:
        raise SystemExit("no __pose on the page — rebuild, the harness hook is missing")
    sx, sy = d["cw"] / d["VW"], d["ch"] / d["VH"]
    x = d["left"] + (d["px"] - d["cx"]) * sx
    y = d["top"] + (d["py"] - d["cy"]) * sy
    pad = 40 * sx
    await pg.screenshot(path=OUT / f"anim-{name}.png", clip={
        "x": x - pad, "y": y - pad, "width": pad * 2, "height": pad * 2})
    print(f"  {name:<13} {d['kind']:<5} frame={d['frame']} cell={d['cell']}"
          f"  aim=({d['aimX']},{d['aimY']}) keys={''.join(k for k in 'lrud' if d['raw'][k])or'-'}"
          f" onGround={d['onGround']} prone={d['prone']}")
    for k in reversed(keys):
        await pg.keyboard.up(k)
    await pg.wait_for_timeout(260)


async def main():
    errors = []
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome-stable", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1000, "height": 640})
        pg.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        pg.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        await pg.goto(URL)
        await pg.wait_for_timeout(600)
        await pg.click("#btnStart")
        await pg.wait_for_timeout(500)
        # away from the map edge, so a tight crop around the marine is never clamped
        await pg.evaluate("() => window.__warp(700)")
        await pg.wait_for_timeout(500)
        print("poses:")
        for name, keys in POSES:
            await shoot(pg, name, keys)
        await b.close()
    hard = [e for e in errors if "404" not in e]
    print("console errors:", len(hard))
    for e in hard[:10]:
        print("  ", e)

asyncio.run(main())
