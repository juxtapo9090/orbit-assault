#!/usr/bin/env python3
"""build.py — assemble the shippable Orbit Assault from its parts.

Inputs: the core (orbit.src.html) with placeholders, the modules
(juice / cosmos / light / net / contra), and the levels (contra1..3.txt),
each verified by verify_level.py before it is allowed in. Nothing is
hand-copied between them, so the level that ships is the level that passed.

    python3 build.py
"""

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
}
LEVELS = ["contra1.txt", "contra2.txt", "contra3.txt"]


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

    src = SRC.read_text()
    if "/*__LEVELS__*/" not in src:
        sys.exit("placeholder /*__LEVELS__*/ missing from source")
    out = src.replace("/*__LEVELS__*/", levels_js)
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
