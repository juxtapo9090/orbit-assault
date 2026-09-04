#!/usr/bin/env python3
"""prep.py — turn the Gemini renders in sprites/ into real game sprite sheets.

The raw files are big RGB renders (1000px per figure) with a FAKE checkerboard
painted into the pixels — no alpha at all. This keys the checkerboard out,
finds each figure, and packs them into small RGBA strips (lossless webp) in
sprites/out/, which build.py then inlines.

    python3 sprites/prep.py

Every count is asserted: if a sheet splits into the wrong number of frames the
script stops and says so — no guessing which blob is which.
"""

import pathlib
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = pathlib.Path(__file__).parent
OUT = HERE / "out"

# raw file -> (cell size, expected frame count, anchor, output name(s))
# anchor: "bottom" = feet on the cell floor, "center" = centred in the cell.
SHEETS = [
    ("player-blue-wh40k.webp", 32, 4, "bottom", "player-0"),      # Ultramarines
    ("player-yellow-poses.webp", 32, 4, "bottom", "player-1"),    # Imperial Fists
    ("player-green-poses.webp", 32, 4, "bottom", "player-2"),     # Salamanders
    ("player-purple-poses.webp", 32, 4, "bottom", "player-3"),    # Emperor's Children
    ("player-red-poses.webp", 32, 4, "bottom", "player-4"),       # Blood Angels
    ("enemies.webp", 24, 3, "bottom", ["runner", "sniper", "cultist"]),
    ("turret-chaos.webp", 24, 2, "center", "turret"),
    ("boss-dreadnought.webp", 128, 1, "bottom", "boss"),
    # gameplay-depth contract (2026-09-04): one boss per stage, three frames each.
    #   warboss  = idle / charge / stunned   feet on the floor, so "bottom"
    #   tau      = hover / shield / fire     it flies, so "center"
    #   sorcerer = cast / teleport / portal  it floats, so "center"
    # All three renders are drawn as FRAMED panels, which the grey key cannot see;
    # "unbox" takes the boxes off and re-keys a tinted checker inside one. See unbox().
    ("boss-warboss.webp", 128, 3, "bottom", "boss-warboss", "unbox", "despeck", "noline"),
    ("boss-tau-commander.webp", 128, 3, "center", "boss-tau", "unbox", "despeck", "noline"),
    ("boss-chaos-sorcerer.webp", 128, 3, "center", "boss-sorcerer", "unbox", "despeck", "noline"),
    ("pickups.webp", 16, 5, "center", ["capsule", "pick-s", "pick-l", "pick-b", "crate"]),
    # weapons contract (2026-09-04): missile frames = straight, up, down, flare;
    # skull frames = idle, firing, bank-left, bank-right; hawk = one frame, faces right.
    ("homing-missile.webp", 16, 4, "center", "missile", "despeck"),
    ("servo-skull.webp", 24, 4, "center", "skull", "trim", "despeck"),
    ("thunderhawk.webp", 128, 1, "center", "hawk", "despeck", "tonekey", "solid"),
    # animation contract (2026-09-04): walk = 4 frames (neutral, left step, mid,
    # right step); aim = 3 frames (up, diag-up, diag-down/straight). Both sets of
    # renders carry a hazy smoke backdrop, hence despeck on every one. The ref=
    # scale pins each sheet's neutral frame to the height the existing pose sheet
    # already ships at (marine 24, ork 15, tau 18), so the figure does not change
    # size the moment it starts walking or raises its gun.
    ("player-blue-walk.webp", 32, 4, "bottom", "player-0-walk", "despeck", "ref=0:24"),
    ("player-yellow-walk.webp", 32, 4, "bottom", "player-1-walk", "despeck", "ref=0:24"),
    ("player-green-walk.webp", 32, 4, "bottom", "player-2-walk", "despeck", "ref=0:24"),
    ("player-purple-walk.webp", 32, 4, "bottom", "player-3-walk", "despeck", "ref=0:24"),
    ("player-red-walk.webp", 32, 4, "bottom", "player-4-walk", "despeck", "ref=0:24"),
    ("player-blue-aim.webp", 40, 3, "bottom", "player-0-aim", "despeck", "ref=1:24"),
    ("player-yellow-aim.webp", 40, 3, "bottom", "player-1-aim", "despeck", "ref=1:24"),
    ("player-green-aim.webp", 40, 3, "bottom", "player-2-aim", "despeck", "ref=1:24"),
    ("player-purple-aim.webp", 40, 3, "bottom", "player-3-aim", "despeck", "ref=1:24"),
    ("player-red-aim.webp", 40, 3, "bottom", "player-4-aim", "despeck", "ref=1:24"),
    ("enemy-runner-walk.webp", 24, 4, "bottom", "runner-walk", "despeck", "noline", "ref=0:15"),
    ("enemy-sniper-aim.webp", 32, 3, "bottom", "sniper-aim", "despeck", "noline", "ref=2:18"),
]

# Stage backgrounds: opaque RGB renders, no checkerboard to key. Scaled to the
# H-tier viewport height (270 logical px * scale 2) and saved lossy — a sky does
# not need lossless, and eight of them lossless would triple the build.
BG_H = 540
BG_Q = 80
BGS = ["bg-stage%d-%s" % (n, k) for n in (1, 2, 3, 4) for k in ("far", "near")]


def keep_solid(alpha):
    """The hawk render has a dithered dust-smear painted over the checker above and
    below the hull — dark isolated pixels that survive the key as a mesh joining
    every checker cell to the sprite. Opening kills a dither and leaves a solid
    hull; keep the biggest solid body, grown back a little so its edge survives."""
    solid = ndimage.binary_opening(alpha > 0, iterations=2)
    lab, n = ndimage.label(solid)
    if n < 1:
        sys.exit("keep_solid: nothing solid left after opening")
    sizes = ndimage.sum(solid, lab, index=np.arange(1, n + 1))
    body = lab == (int(sizes.argmax()) + 1)
    mask = ndimage.binary_dilation(body, iterations=3)
    return np.where(mask, alpha, 0).astype(np.uint8)


def strip_panel_boxes(alpha, rgb):
    """The boss renders are drawn as framed panels — a thin dark box round each
    pose. It is too dark for the checker key to touch, and on the sorcerer sheet
    the three boxes share their edges, so the border comes through as one long
    rectangle that welds all three poses into a single blob: split_frames then
    sees one figure where there are three.

    A drawn box is the one thing on these sheets that is dark, huge and hollow.
    Measured over the three: every box fills under 4% of its own bounding box,
    every figure fills over 16%. Cut at 12%, and only for a blob big enough to be
    a frame in the first place, so a dark gun-barrel is never mistaken for one."""
    dark = (alpha > 0) & (rgb.astype(int).mean(axis=2) < 85)
    lab, n = ndimage.label(dark)
    if n < 1:
        return alpha
    objs = ndimage.find_objects(lab)
    sizes = ndimage.sum(dark, lab, index=np.arange(1, n + 1))
    h, w = alpha.shape
    for i in range(n):
        sl = objs[i]
        bw, bh = sl[1].stop - sl[1].start, sl[0].stop - sl[0].start
        if bw < w * 0.25 and bh < h * 0.25:
            continue
        if sizes[i] / (bw * bh) >= 0.12:
            continue
        alpha[lab == i + 1] = 0
        print(f"    unbox: panel frame {bw}x{bh} removed ({int(sizes[i])} px, fill {sizes[i]/(bw*bh):.3f})")
    return alpha


def strip_panel_tint(alpha, rgb, frames, tol=30):
    """One panel (the sorcerer's cast pose) has its OWN checkerboard painted in,
    tinted purple — the grey key leaves it as a solid slab behind the figure.
    Whatever still hugs a panel's inner ring after the box is off IS that panel's
    background: take the two colours that dominate the ring and key them out.
    A panel that is already clean has an empty ring and is left alone.
    Returns the frame boxes re-fitted to what actually survives."""
    out = []
    for (x0, y0, x1, y1) in frames:
        sub_a, sub_c = alpha[y0:y1, x0:x1], rgb[y0:y1, x0:x1].astype(int)
        ring = np.zeros(sub_a.shape, bool)
        m = max(4, int(min(sub_a.shape) * 0.05))
        ring[:m, :] = ring[-m:, :] = ring[:, :m] = ring[:, -m:] = True
        lit = ring & (sub_a > 0)
        if lit.sum() > ring.sum() * 0.30:
            q = sub_c[lit] // 16
            keys, counts = np.unique(q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2], return_counts=True)
            for k in keys[np.argsort(counts)[-2:]]:
                c = np.array([(k // 256) * 16 + 8, ((k // 16) % 16) * 16 + 8, (k % 16) * 16 + 8])
                sub_a[np.sqrt(((sub_c - c) ** 2).sum(axis=2)) < tol] = 0
            # the keyed check leaves a crumb at every cell corner; open them off
            body = ndimage.binary_dilation(ndimage.binary_opening(sub_a > 0, iterations=2), iterations=2)
            sub_a[~body] = 0
            alpha[y0:y1, x0:x1] = sub_a
            print(f"    unbox: tinted panel at x={x0} re-keyed")
        ys, xs = np.nonzero(sub_a > 0)
        if not len(xs):
            sys.exit(f"unbox: panel at x={x0} emptied out — the ring key ate the figure")
        out.append((x0 + int(xs.min()), y0 + int(ys.min()), x0 + int(xs.max()) + 1, y0 + int(ys.max()) + 1))
    return out


def trim_thin_edges(alpha, x0, y0, x1, y1):
    """Peel off edge columns that are nearly empty — the servo-skull's firing frame
    has its laser beam painted into the render, which would set the shared scale
    for the whole sheet. The beam is drawn by the game, not the sprite."""
    h = y1 - y0
    thin = int(h * 0.06)
    while x1 - x0 > 8 and (alpha[y0:y1, x1 - 1] > 0).sum() < thin:
        x1 -= 1
    while x1 - x0 > 8 and (alpha[y0:y1, x0] > 0).sum() < thin:
        x0 += 1
    return (x0, y0, x1, y1)


def prep_backgrounds():
    d = OUT / "bg"
    d.mkdir(exist_ok=True)
    for old in d.glob("*.webp"):
        old.unlink()
    print("backgrounds:")
    for name in BGS:
        src = HERE / f"{name}.webp"
        if not src.exists():
            sys.exit(f"{name}.webp missing — every stage listed needs both layers")
        im = Image.open(src).convert("RGB")
        w = round(im.width * BG_H / im.height)
        im = im.resize((w, BG_H), Image.LANCZOS)
        p = d / f"{name}.webp"
        im.save(p, "WEBP", quality=BG_Q)
        print(f"  {p.name:<20} {w}x{BG_H}  {p.stat().st_size // 1024}K")


def key_checkerboard(rgb, tonekey=False, noline=False):
    """Return an alpha mask (uint8) with the painted checkerboard removed.
    tonekey: only the checker's own two greys count as background — for a sprite
    that is itself grey metal (the Thunderhawk hull keyed out as a "checker hole"
    under the loose rule, because a riveted hull is big, grey and two-toned too).
    noline: skip the floor-line sweep below — see the comment there."""
    r, g, b = rgb[..., 0].astype(int), rgb[..., 1].astype(int), rgb[..., 2].astype(int)
    hi = np.maximum(np.maximum(r, g), b)
    lo = np.minimum(np.minimum(r, g), b)
    greyish = ((hi - lo) < 24) & (hi > 80)
    if tonekey:
        # the two checker tones, read off the border where nothing else lives
        m0 = max(4, int(min(hi.shape) * 0.03))
        edge = np.concatenate([hi[:m0].ravel(), hi[-m0:].ravel(), hi[:, :m0].ravel(), hi[:, -m0:].ravel()])
        hist = np.bincount(edge, minlength=256)
        t1 = int(hist.argmax()); hist[max(0, t1 - 20):t1 + 20] = 0
        t2 = int(hist.argmax())
        greyish &= (np.abs(hi - t1) <= 14) | (np.abs(hi - t2) <= 14)
    lab, n = ndimage.label(greyish)
    h, w = greyish.shape
    ring = np.zeros_like(greyish)
    m = max(4, int(min(h, w) * 0.03))
    ring[:m, :] = ring[-m:, :] = ring[:, :m] = ring[:, -m:] = True
    edge_ids = np.unique(lab[ring & greyish])
    bg = np.isin(lab, edge_ids[edge_ids > 0])
    # enclosed checker holes (between an arm and the body): a grey blob that is
    # big AND two-toned is checkerboard, a flat grey blob is sprite metal.
    sizes = ndimage.sum(greyish, lab, index=np.arange(1, n + 1))
    for i in np.nonzero(sizes > 1500)[0]:
        idx = i + 1
        if idx in edge_ids:
            continue
        vals = hi[lab == idx]
        if vals.std() > 14:
            bg |= lab == idx
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    # some renders draw a dark-grey "floor" line right across the sheet under the
    # feet. It is too dark for the checker key, so: on rows where grey pixels
    # make up a big share of the width, the grey IS the line — erase only those
    # grey pixels, coloured armour on the same row survives.
    # (A grey-hulled sprite IS wide grey rows — the floor-line rule is what ate the
    # Thunderhawk, so it is off under tonekey.)
    # (A four-frame sheet of drab figures IS wide grey rows too: the orks' boots and
    # the Tau's grey plate line up across all four poses, so the rule read a leg row
    # as a floor line and erased every leg. Those sheets carry no floor line, hence
    # noline.)
    if not tonekey and not noline:
        grey = (hi - lo) < 24
        line_rows = ((grey & (alpha > 0)).mean(axis=1) > 0.25)
        alpha[line_rows[:, None] & grey] = 0
    # eat the 1px grey halo the blur left around every outline
    alpha = ndimage.binary_erosion(alpha > 0, iterations=1).astype(np.uint8) * 255
    return alpha


def split_frames(alpha, expect, name, despeck=False):
    """A pose is often several disconnected blobs (torso separated from legs by a
    belt-line the key ate, a raised arm from the body). Group blobs by CENTROID X
    instead of by size: cut the sorted centroids at the (expect-1) biggest gaps,
    so each pose's parts land in one group regardless of how many pieces it is."""
    lab, n = ndimage.label(alpha > 0)
    objs = ndimage.find_objects(lab)
    sizes = ndimage.sum(alpha > 0, lab, index=np.arange(1, n + 1))
    # drop specks the key left behind. The newer renders (missile, skull, hawk)
    # carry faint grey motion-ghosts that survive the key as hundreds of 40-400px
    # crumbs, so those sheets ignore anything under 2% of the biggest blob.
    floor = max(40, sizes.max() * 0.02) if despeck else 40
    keep = np.nonzero(sizes >= floor)[0]
    if despeck:                                  # erase the crumbs, not just ignore them
        alpha[np.isin(lab, np.nonzero(sizes < floor)[0] + 1)] = 0
    if len(keep) < expect:
        sys.exit(f"{name}: only {len(keep)} usable blobs, expected at least {expect}")
    cx = np.array([(objs[i][1].start + objs[i][1].stop) / 2 for i in keep])
    order = np.argsort(cx)
    keep, cx = keep[order], cx[order]
    gaps = np.diff(cx)
    cuts = np.sort(np.argsort(gaps)[-(expect - 1):]) + 1 if expect > 1 else []
    groups = np.split(np.arange(len(keep)), cuts)
    frames = []
    for grp in groups:
        b = [1e9, 1e9, -1e9, -1e9]
        for gi in grp:
            sl = objs[keep[gi]]
            b[0] = min(b[0], sl[1].start); b[1] = min(b[1], sl[0].start)
            b[2] = max(b[2], sl[1].stop); b[3] = max(b[3], sl[0].stop)
        frames.append(tuple(b))
    if len(frames) != expect:
        sys.exit(f"{name}: grouped into {len(frames)} frames, expected {expect} — {frames}")
    areas = [(x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in frames]
    if min(areas) < max(areas) * 0.1:
        sys.exit(f"{name}: frame sizes wildly uneven {areas} — a figure split or a blob is not a figure")
    return frames


def pack(rgba, frames, cell, anchor, ref=None):
    """Fit every frame into cell×cell with ONE shared scale so poses keep proportion.

    By default the scale comes from the sheet's biggest bounding box. That is wrong
    for an aim sheet: the frame with the bolter raised straight up has a box half a
    figure taller than the rest, so scaling to it would shrink the marine every time
    he aims. `ref=(frame, px)` pins the scale to one frame's HEIGHT instead — the
    neutral pose — and lets a raised weapon legitimately stick up out of the body's
    share of the cell."""
    if ref is not None:
        i, px = ref
        x0, y0, x1, y1 = frames[i]
        s = px / (y1 - y0)
        over = max(max((x1 - x0), (y1 - y0)) * s for x0, y0, x1, y1 in frames)
        if over > cell + 0.5:
            sys.exit(f"pack: ref scale needs {over:.1f}px but the cell is {cell} — raise the cell")
    else:
        big = max(max(x1 - x0, y1 - y0) for x0, y0, x1, y1 in frames)
        s = cell / big
    sheet = Image.new("RGBA", (cell * len(frames), cell), (0, 0, 0, 0))
    for i, (x0, y0, x1, y1) in enumerate(frames):
        fr = Image.fromarray(rgba[y0:y1, x0:x1])
        w, h = max(1, round((x1 - x0) * s)), max(1, round((y1 - y0) * s))
        fr = fr.resize((w, h), Image.BOX)
        # kill colour under transparent pixels so nothing bleeds when drawn scaled
        a = np.array(fr); a[a[..., 3] == 0, :3] = 0
        # snap soft edges: it is pixel art, not a photo
        a[..., 3] = np.where(a[..., 3] < 90, 0, 255)
        fr = Image.fromarray(a)
        ox = i * cell + (cell - w) // 2
        oy = cell - h if anchor == "bottom" else (cell - h) // 2
        sheet.paste(fr, (ox, oy), fr)
    return sheet


def save(img, name):
    p = OUT / f"{name}.webp"
    img.save(p, "WEBP", lossless=True)
    print(f"  {p.name:<14} {img.size[0]}x{img.size[1]}")


def main():
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.webp"):
        old.unlink()
    print("prep:")
    for sheet in SHEETS:
        raw, cell, expect, anchor, names = sheet[:5]
        flags = sheet[5:]
        trim = "trim" in flags
        ref = None
        for f in flags:
            if f.startswith("ref="):          # "ref=<frame>:<px>" — see pack()
                a, b = f[4:].split(":")
                ref = (int(a), int(b))
        rgb = np.array(Image.open(HERE / raw).convert("RGB"))
        alpha = key_checkerboard(rgb, tonekey="tonekey" in flags, noline="noline" in flags)
        if "solid" in flags:
            alpha = keep_solid(alpha)
        if "unbox" in flags:
            print(f"  {raw}:")
            alpha = strip_panel_boxes(alpha, rgb)
        frames = split_frames(alpha, expect, raw, despeck="despeck" in flags)
        if "unbox" in flags:
            frames = strip_panel_tint(alpha, rgb, frames)
        if trim:
            frames = [trim_thin_edges(alpha, *f) for f in frames]
        # AFTER every edit to alpha, not before: dstack copies, so an rgba built up
        # top would still carry the crumbs despeck and unbox just erased.
        rgba = np.dstack([rgb, alpha])
        if isinstance(names, str):
            save(pack(rgba, frames, cell, anchor, ref), names)
        else:
            for fr, n in zip(frames, names):
                save(pack(rgba, [fr], cell, anchor), n)
    prep_backgrounds()
    print("done")


if __name__ == "__main__":
    main()
