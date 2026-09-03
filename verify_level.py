#!/usr/bin/env python3
"""verify_level.py — prove a Ledger Run level is completable before it ships.

Not a gap-width heuristic. This simulates the real player physics (the same
constants the game runs) and does a BFS over every position the player can
actually stand on, following every jump arc with collision. What it reports is
reachability, not a guess at it.

    python3 verify_level.py <level.txt>

Exit 0 = level passes. Exit 1 = something is unreachable; the report says what.

Tile vocabulary
    .  empty        #  solid          =  one-way platform (land from above only)
    ^  spike        o  coin           ?  light block (solid)
    e  walker       x  spiky walker
    r  runner       s  sniper         t  turret        S  spawner
    W  capsule      B  boss
    P  player spawn F  goal flag

Contra glyphs (r s t S W B) are walkable air for reachability. Structural rules
(CONTRACT §7) are asserted on top of P->F reachability:
    exactly one B, at least one S, every t touches a solid tile on one of its
    4 sides, every r/s/e/x has ground (solid or one-way) beneath it, the boss
    arena is a flat solid floor >= ARENA_W columns wide ending at a solid wall
    column immediately behind B (side away from P) at least WALL_H tall, F is
    past B in x, and the 5 tiles right of P are empty air with solid floor
    beneath (5 players fan out 12px apart at spawn).

A level file is plain text, one row per line, top row first. Rows may be ragged;
they are padded with '.' to the longest.
"""

import sys
from collections import deque

# ---- physics: must match the constants in the shipped game -------------------
TS        = 16
G_RISE    = 1250.0
G_FALL    = 2900.0
J_VEL     = 430.0
S_BONUS   = 0.18
MAX_RUN   = 250.0
WALK_FRAC = 0.56
TERM_VEL  = 900.0
DT        = 1.0 / 60
PW, PH    = 11, 15          # player box

# ---- structural rules (CONTRACT §7) ------------------------------------------
ARENA_W   = 24              # boss arena: flat solid floor at least this wide
ARENA_HEAD= 2               # rows above the arena floor that must be clear
WALL_H    = 4               # wall behind B: solid for at least this many rows
SPAWN_FAN = 5               # tiles right of P that must be clear air over floor
AIR       = ".rsStWBoePF"   # glyphs the player passes through


class Level:
    def __init__(self, rows):
        self.w = max(len(r) for r in rows)
        self.rows = [r.ljust(self.w, ".") for r in rows]
        self.h = len(self.rows)

    def at(self, tx, ty):
        if tx < 0 or tx >= self.w or ty < 0 or ty >= self.h:
            return "#" if (tx < 0 or tx >= self.w) else "."
        return self.rows[ty][tx]

    def solid(self, tx, ty):
        return self.at(tx, ty) in "#?u"

    def oneway(self, tx, ty):
        return self.at(tx, ty) == "="

    def spike(self, tx, ty):
        return self.at(tx, ty) == "^"

    def find(self, ch):
        out = []
        for y in range(self.h):
            for x in range(self.w):
                if self.rows[y][x] == ch:
                    out.append((x, y))
        return out


def hits_solid(lv, px, py):
    """Player AABB at pixel (px,py) overlapping any hard tile."""
    x0, x1 = int(px // TS), int((px + PW - 1) // TS)
    y0, y1 = int(py // TS), int((py + PH - 1) // TS)
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            if lv.solid(tx, ty):
                return True
    return False


def hits_spike(lv, px, py):
    x0, x1 = int((px + 2) // TS), int((px + PW - 3) // TS)
    y0, y1 = int((py + 3) // TS), int((py + PH - 1) // TS)
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            if lv.spike(tx, ty):
                return True
    return False


def landed(lv, px, py, prev_bottom):
    """Standing on a hard tile, or landing on a one-way from above."""
    fy = int((py + PH) // TS)
    x0, x1 = int(px // TS), int((px + PW - 1) // TS)
    for tx in range(x0, x1 + 1):
        if lv.solid(tx, fy):
            return True
        if lv.oneway(tx, fy) and prev_bottom <= fy * TS + 2:
            return True
    return False


def simulate(lv, sx, sy, vx, hold_frames, max_t=3.0):
    """One jump from pixel (sx,sy) at horizontal speed vx.

    hold_frames = how long the jump button is held (variable height).
    Returns (landing_px, landing_py) or None if it dies / never lands.
    """
    frac = min(1.0, abs(vx) / MAX_RUN)
    px, py = float(sx), float(sy)
    vy = -(J_VEL * (1 + frac * S_BONUS))
    t = 0.0
    f = 0
    rising = True
    while t < max_t:
        prev_bottom = py + PH
        held = f < hold_frames
        if vy < 0 and held and rising:
            vy += G_RISE * DT
        else:
            rising = False
            vy += G_FALL * DT
        vy = min(vy, TERM_VEL)

        # x first, then y — same order as the game
        nx = px + vx * DT
        if not hits_solid(lv, nx, py):
            px = nx
        else:
            vx = 0.0

        ny = py + vy * DT
        if hits_solid(lv, px, ny):
            if vy > 0:                       # landed on something hard
                py = float(int((ny + PH) // TS) * TS - PH)
                return (px, py)
            vy = 0.0                          # bonked a ceiling
        else:
            py = ny
            if vy > 0 and landed(lv, px, py, prev_bottom):
                py = float(int((py + PH) // TS) * TS - PH)
                return (px, py)

        if hits_spike(lv, px, py):
            return None
        if py > lv.h * TS + 40:
            return None
        t += DT
        f += 1
    return None


def standable(lv):
    """Every tile position the player could rest on."""
    out = set()
    for y in range(lv.h):
        for x in range(lv.w):
            if not (lv.solid(x, y) or lv.oneway(x, y)):
                continue
            py = y * TS - PH
            px = x * TS
            if py < 0:
                continue
            if hits_solid(lv, px, py) or hits_spike(lv, px, py):
                continue
            out.add((int(px), int(py)))
    return out


def reachable(lv, start):
    """BFS over standing spots, expanding through simulated jumps and walks."""
    walk = MAX_RUN * WALK_FRAC
    speeds = [0.0, walk, -walk, MAX_RUN, -MAX_RUN]
    holds = [3, 7, 12, 20, 40]

    seen = {start}
    q = deque([start])
    while q:
        px, py = q.popleft()

        # walking along the surface, both directions
        for d in (-1, 1):
            wx = px
            for _ in range(int(MAX_RUN * 1.2 / TS) + 2):
                nx = wx + d * TS
                if nx < 0 or nx > lv.w * TS:
                    break
                if hits_solid(lv, nx, py) or hits_spike(lv, nx, py):
                    break
                if not landed(lv, nx, py, py + PH):
                    break                       # walked off an edge; jumps cover it
                wx = nx
                if (int(wx), int(py)) not in seen:
                    seen.add((int(wx), int(py)))
                    q.append((int(wx), int(py)))

        # jumps, and walking off the ledge (hold 0)
        for vx in speeds:
            for hold in holds:
                r = simulate(lv, px, py, vx, hold)
                if r is None:
                    continue
                key = (int(r[0]), int(r[1]))
                if key not in seen:
                    seen.add(key)
                    q.append(key)
            r = simulate(lv, px, py, vx, 0)      # step off, no jump
            if r:
                key = (int(r[0]), int(r[1]))
                if key not in seen:
                    seen.add(key)
                    q.append(key)
    return seen


def near(reach, tx, ty, slack=TS * 1.6):
    """Is any reachable standing spot close enough to touch this tile?"""
    cx, cy = tx * TS + TS / 2, ty * TS + TS / 2
    for (px, py) in reach:
        if abs(px + PW / 2 - cx) < slack and -TS * 4.5 < (py + PH / 2 - cy) < TS * 2.2:
            return True
    return False


def structural(lv, sxp, syp, fx, fy):
    """CONTRACT §7 assertions. Returns a list of failure strings."""
    bad = []

    # -- exactly one boss, at least one spawner
    bosses = lv.find("B")
    if len(bosses) != 1:
        bad.append(f"boss: need exactly one B, found {len(bosses)}")
    if not lv.find("S"):
        bad.append("spawner: need at least one S, found none")

    # -- turrets set into walls
    for (tx, ty) in lv.find("t"):
        if not any(lv.solid(tx + dx, ty + dy)
                   for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            bad.append(f"turret at tile ({tx},{ty}) touches no solid tile")

    # -- ground enemies need ground
    for ch in "rsex":
        for (ex, ey) in lv.find(ch):
            if not (lv.solid(ex, ey + 1) or lv.oneway(ex, ey + 1)):
                bad.append(f"enemy '{ch}' at tile ({ex},{ey}) has no ground beneath")

    # -- spawn fan: P and the 5 tiles to its right are air over solid floor
    for dx in range(0, SPAWN_FAN + 1):
        x = sxp + dx
        if lv.at(x, syp) not in AIR or lv.at(x, syp) == "F":
            bad.append(f"spawn fan: tile ({x},{syp}) must be empty air, is '{lv.at(x, syp)}'")
        if not lv.solid(x, syp + 1):
            bad.append(f"spawn fan: tile ({x},{syp + 1}) under the fan must be solid floor")

    if len(bosses) != 1:
        return bad
    bx, by = bosses[0]
    d = 1 if bx >= sxp else -1          # +1: P is left of B, wall is on B's right

    # -- F must be past B (on the far side from P)
    if (fx - bx) * d <= 0:
        bad.append(f"flag: F at x={fx} must be past B at x={bx} (away from P)")

    # -- arena floor: first solid row below B at B's column
    fl = by + 1
    while fl < lv.h and not lv.solid(bx, fl):
        fl += 1
    if fl >= lv.h:
        bad.append(f"boss: no solid floor below B at tile ({bx},{by})")
        return bad
    if fl - by > WALL_H:
        bad.append(f"boss: B at ({bx},{by}) floats {fl - by} rows above its floor (max {WALL_H})")

    # -- wall column immediately behind B, solid from floor-1 up at least WALL_H rows
    wx = bx + d
    wall_rows = [r for r in range(fl - 1, fl - 1 - WALL_H, -1) if r >= 0]
    missing = [r for r in wall_rows if not lv.solid(wx, r)]
    if missing:
        bad.append(f"boss: wall column x={wx} not solid at rows {missing} "
                   f"(need rows {fl - 1}..{fl - WALL_H})")
    if not lv.solid(wx, by):
        bad.append(f"boss: wall column x={wx} must be solid at B's row {by}")

    # -- arena: ARENA_W columns of flat solid floor ending at the wall,
    #    with ARENA_HEAD rows of clear headroom above it
    span = [wx - d * k for k in range(1, ARENA_W + 1)]
    holes = [x for x in span if not lv.solid(x, fl)]
    if holes:
        bad.append(f"boss arena: floor row {fl} not solid across x={min(span)}..{max(span)} "
                   f"(holes at {holes[:8]}{'...' if len(holes) > 8 else ''})")
    blocked = [(x, r) for x in span for r in range(fl - 1, fl - 1 - ARENA_HEAD, -1)
               if lv.solid(x, r) or lv.spike(x, r)]
    if blocked:
        bad.append(f"boss arena: not flat, obstacles above floor at {blocked[:8]}"
                   f"{'...' if len(blocked) > 8 else ''}")
    if bx not in span:
        bad.append(f"boss: B at x={bx} not inside its own arena span")
    return bad


def main():
    if len(sys.argv) < 2:
        print("usage: verify_level.py <level.txt>")
        return 2
    rows = [l.rstrip("\n") for l in open(sys.argv[1]) if l.strip("\n")]
    lv = Level(rows)

    print(f"level: {lv.w} x {lv.h} tiles")

    spawns = lv.find("P")
    flags = lv.find("F")
    problems = []
    if len(spawns) != 1:
        problems.append(f"need exactly one P spawn, found {len(spawns)}")
    if len(flags) != 1:
        problems.append(f"need exactly one F flag, found {len(flags)}")
    if problems:
        for p in problems:
            print("  FAIL:", p)
        return 1

    sxp, syp = spawns[0]
    start = (sxp * TS + 2, syp * TS)
    # settle the spawn onto the ground below it
    r = simulate(lv, start[0], start[1], 0.0, 0)
    if r:
        start = (int(r[0]), int(r[1]))
    print(f"spawn settles at pixel {start}")

    reach = reachable(lv, start)
    print(f"reachable standing spots: {len(reach)}")

    fx, fy = flags[0]
    ok_flag = near(reach, fx, fy) or near(reach, fx, fy + 1)
    print(f"flag at tile ({fx},{fy}): {'REACHABLE' if ok_flag else 'UNREACHABLE  <<<'}")

    coins = lv.find("o")
    bad_coins = [c for c in coins if not near(reach, *c)]
    print(f"coins: {len(coins)} total, {len(coins)-len(bad_coins)} reachable")
    for c in bad_coins:
        print(f"    unreachable coin at tile {c}")

    counts = {ch: len(lv.find(ch)) for ch in "rstSWBex"}
    print("contra: " + "  ".join(f"{ch}={n}" for ch, n in counts.items()))

    rules = structural(lv, sxp, syp, fx, fy)
    print(f"structure: {len(rules)} rule violation(s)")
    for r in rules:
        print("    FAIL:", r)

    print()
    if not ok_flag or rules:
        why = []
        if not ok_flag:
            why.append("flag unreachable")
        why += rules
        print("VERDICT: FAIL — " + "; ".join(why))
        return 1
    if bad_coins:
        print(f"VERDICT: PASS (completable) — {len(bad_coins)} coin(s) unreachable, cosmetic")
        return 0
    print("VERDICT: PASS — flag reachable, every coin reachable, structure OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
