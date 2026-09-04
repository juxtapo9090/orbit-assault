#!/usr/bin/env python3
"""build.py — assemble the shippable Contra Orbit from its parts.

Inputs: the core (orbit.src.html) with placeholders, the modules
(juice / cosmos / light / net / contra / input), and the levels (contra1..3.txt),
each verified by verify_level.py before it is allowed in. Nothing is
hand-copied between them, so the level that ships is the level that passed.

    python3 build.py
"""

import base64
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / "orbit.src.html"
OUT = HERE / "orbit.html"
MODULES = {
    "/*__JUICE__*/": HERE / "juice.js",
    "/*__COSMOS__*/": HERE / "cosmos.js",
    "/*__LIGHT__*/": HERE / "light.js",
    "/*__NET__*/": HERE / "net.js",
    "/*__CONTRA__*/": HERE / "contra.js",
    "/*__INPUT__*/": HERE / "input.js",
}
LEVELS = ["contra1.txt", "contra2.txt", "contra3.txt"]
SPRITES = HERE / "sprites" / "out"       # produced by sprites/prep.py from the raw renders


def inline_dir(folder, var, what):
    """Inline every webp in `folder` as a data URI under one JS object. An empty
    folder is allowed (the game falls back to canvas paths) but it is said out
    loud, never assumed."""
    files = sorted(folder.glob("*.webp")) if folder.is_dir() else []
    if not files:
        print(f"  ! no {what} in {folder.relative_to(HERE)} — build ships without them")
        return f"var {var}={{}};"
    parts = []
    for p in files:
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        parts.append('  "%s": "data:image/webp;base64,%s"' % (p.stem, b64))
        print(f"  + {p.name}: {p.stat().st_size} bytes")
    return f"var {var}={{\n" + ",\n".join(parts) + "\n};"


def load_sprites():
    """Sheets and stage backgrounds are two bundles on purpose: the sprite cast is
    all-or-nothing (one bad sheet = whole cast falls back), while a background
    that fails only loses that one stage's parallax."""
    return inline_dir(SPRITES, "SPRITE_DATA", "sprites") + "\n" + inline_dir(SPRITES / "bg", "BG_DATA", "backgrounds")


def load_levels():
    blocks = []
    for name in LEVELS:
        p = HERE / name
        if not p.exists():
            sys.exit(f"level {name} missing — every listed level must exist")
        rows = [r.rstrip("\n") for r in p.read_text().splitlines() if r.strip("\n")]
        w = max(len(r) for r in rows)
        rows = [r.ljust(w, ".") for r in rows]
        print(f"  + {name}: {w} x {len(rows)}")
        body = ",\n".join('  "%s"' % r for r in rows)
        blocks.append("[\n%s\n]" % body)
    return "var LEVELS=[\n" + ",\n".join(blocks) + "\n];"


def verify_all():
    ok = True
    for name in LEVELS:
        r = subprocess.run(
            [sys.executable, str(HERE / "verify_level.py"), str(HERE / name)],
            capture_output=True, text=True,
        )
        tail = [l for l in r.stdout.splitlines() if l.startswith("VERDICT")]
        print(f"  {name}: {tail[0] if tail else 'no verdict'}")
        if r.returncode != 0:
            ok = False
            print(r.stdout)
    return ok


def main():
    print("levels:")
    levels_js = load_levels()
    print("verifying:")
    if not verify_all():
        sys.exit("REFUSING TO BUILD — a level failed verification")

    print("sprites:")
    sprites_js = load_sprites()

    src = SRC.read_text()
    for tok in ("/*__LEVELS__*/", "/*__SPRITES__*/"):
        if tok not in src:
            sys.exit(f"placeholder {tok} missing from source")
    out = src.replace("/*__LEVELS__*/", levels_js).replace("/*__SPRITES__*/", sprites_js)
    for token, path in MODULES.items():
        if token not in src:
            sys.exit(f"placeholder {token} missing from source")
        if not path.exists():
            sys.exit(f"module {path.name} missing — no silent stub")
        out = out.replace(token, path.read_text())
    OUT.write_text(out)
    print(f"\nbuilt {OUT.name} — {len(out)} bytes")


if __name__ == "__main__":
    main()
