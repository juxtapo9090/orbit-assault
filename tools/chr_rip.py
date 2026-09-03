#!/usr/bin/env python3
"""
chr_rip.py — reference-only NES tile ripper for Contra (USA).nes (mapper 2,
UNROM, CHR-RAM). Since CHR=0 in the header, there is no CHR-ROM: tile graphics
live inside the 128K PRG and get DMA'd to CHR-RAM at runtime. This decodes the
WHOLE PRG as raw 2bpp 8x8 NES tiles, bank by bank, purely so a human can eyeball
where the graphics sit. Nothing here ships in the game (see CONTRACT.md #8).
"""
import sys
import struct
from pathlib import Path
from PIL import Image

ROM_PATH = "/mnt/playground/Downloads/ABDM/Compressed/Contra (USA).nes"
OUT_DIR = Path(__file__).resolve().parent.parent / "ref"

BANK_SIZE = 16 * 1024          # 16K PRG bank
TILE_BYTES = 16                # 8 bytes plane0 + 8 bytes plane1
TILES_PER_BANK = BANK_SIZE // TILE_BYTES  # 1024
TILES_PER_ROW = 32
SCALE = 3

RAMP = [
    (0x00, 0x00, 0x00),   # 0
    (0x55, 0x55, 0x55),   # 1
    (0xAA, 0xAA, 0xAA),   # 2
    (0xFF, 0xFF, 0xFF),   # 3
]


def read_header(data: bytes):
    if len(data) < 16 or data[0:4] != b"NES\x1a":
        raise ValueError(
            f"bad iNES magic: got {data[0:4]!r}, expected b'NES\\x1a' "
            f"-- refusing to guess, this is not an iNES ROM"
        )
    prg_16k_units = data[4]
    chr_8k_units = data[5]
    flags6 = data[6]
    flags7 = data[7]
    trainer_present = bool(flags6 & 0x04)
    mapper = (flags7 & 0xF0) | (flags6 >> 4)
    return {
        "prg_16k_units": prg_16k_units,
        "chr_8k_units": chr_8k_units,
        "trainer_present": trainer_present,
        "mapper": mapper,
    }


def decode_tile(bank: bytes, tile_index: int):
    """Return an 8x8 list-of-rows of 2bpp pixel values (0..3) for one tile."""
    off = tile_index * TILE_BYTES
    plane0 = bank[off:off + 8]
    plane1 = bank[off + 8:off + 16]
    rows = []
    for y in range(8):
        p0 = plane0[y]
        p1 = plane1[y]
        row = []
        for x in range(8):
            bit = 7 - x
            lo = (p0 >> bit) & 1
            hi = (p1 >> bit) & 1
            row.append(lo | (hi << 1))
        rows.append(row)
    return rows


def tile_is_empty_or_full(tile_bytes: bytes) -> bool:
    """True if a tile's 16 raw bytes are all-zero (blank) or all-0xFF (solid)."""
    return tile_bytes == b"\x00" * TILE_BYTES or tile_bytes == b"\xff" * TILE_BYTES


def render_bank(bank: bytes) -> Image.Image:
    n_rows = -(-TILES_PER_BANK // TILES_PER_ROW)  # ceil
    img = Image.new("RGB", (TILES_PER_ROW * 8, n_rows * 8), RAMP[0])
    px = img.load()
    for t in range(TILES_PER_BANK):
        tx = (t % TILES_PER_ROW) * 8
        ty = (t // TILES_PER_ROW) * 8
        rows = decode_tile(bank, t)
        for y, row in enumerate(rows):
            for x, val in enumerate(row):
                px[tx + x, ty + y] = RAMP[val]
    if SCALE != 1:
        img = img.resize((img.width * SCALE, img.height * SCALE), Image.NEAREST)
    return img


def bank_density(bank: bytes) -> float:
    non_trivial = 0
    for t in range(TILES_PER_BANK):
        off = t * TILE_BYTES
        tb = bank[off:off + TILE_BYTES]
        if not tile_is_empty_or_full(tb):
            non_trivial += 1
    return non_trivial / TILES_PER_BANK


def main():
    rom_path = Path(ROM_PATH)
    data = rom_path.read_bytes()
    header = read_header(data)

    if header["mapper"] != 2:
        print(f"warning: mapper is {header['mapper']}, expected 2 (UNROM)", file=sys.stderr)
    if header["chr_8k_units"] != 0:
        print(
            f"warning: CHR units = {header['chr_8k_units']} (expected 0 / CHR-RAM); "
            f"proceeding anyway, ripping PRG as instructed",
            file=sys.stderr,
        )

    offset = 16
    if header["trainer_present"]:
        offset += 512

    prg = data[offset:]
    n_banks = header["prg_16k_units"]
    if len(prg) < n_banks * BANK_SIZE:
        raise ValueError(
            f"PRG data too short: header claims {n_banks} x 16K banks "
            f"({n_banks * BANK_SIZE} bytes) but only {len(prg)} bytes available "
            f"after the header/trainer -- refusing to pad silently"
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    bank_imgs = []
    densities = []
    for n in range(n_banks):
        bank = prg[n * BANK_SIZE:(n + 1) * BANK_SIZE]
        img = render_bank(bank)
        d = bank_density(bank)
        densities.append(d)
        out_path = OUT_DIR / f"prg_bank_{n}.png"
        img.save(out_path)
        bank_imgs.append(img)
        print(f"bank {n}: tile density = {d:.3f}  -> {out_path}")

    # Contact sheet: all banks stacked vertically, each labeled.
    label_h = 20
    contact_w = max(im.width for im in bank_imgs)
    contact_h = sum(im.height + label_h for im in bank_imgs)
    contact = Image.new("RGB", (contact_w, contact_h), (20, 20, 20))
    try:
        from PIL import ImageDraw
        draw = ImageDraw.Draw(contact)
    except ImportError:
        draw = None

    y = 0
    for n, im in enumerate(bank_imgs):
        if draw is not None:
            draw.text((4, y + 3), f"bank {n}  density={densities[n]:.3f}", fill=(255, 255, 0))
        y += label_h
        contact.paste(im, (0, y))
        y += im.height

    contact_path = OUT_DIR / "contact.png"
    contact.save(contact_path)
    print(f"contact sheet -> {contact_path}")


if __name__ == "__main__":
    main()
