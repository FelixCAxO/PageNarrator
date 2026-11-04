"""Author deterministic geometric bilevel inputs for independent JBIG2 encoders."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
output = parser.parse_args().output.resolve()
output.mkdir(parents=True, exist_ok=True)

glyphs = [
    ['11111', '10001', '10101', '10101', '10001', '11111', '00100', '00100'],
    ['00100', '01110', '11011', '10001', '11011', '01110', '00100', '11111'],
]


def write_image(name, width, height, black):
    stride = (width + 7) // 8
    data = bytearray(stride * height)
    for y in range(height):
        for x in range(width):
            if black(x, y):
                data[y * stride + x // 8] |= 128 >> (x & 7)
    pbm = f'P4\n{width} {height}\n'.encode('ascii') + data
    (output / f'{name}.pbm').write_bytes(pbm)
    return {'id': name, 'file': f'{name}.pbm', 'width': width, 'height': height,
            'pbmSha256': hashlib.sha256(pbm).hexdigest(),
            'blackPackedSha256': hashlib.sha256(data).hexdigest(), 'blackPackedHex': data.hex()}


def symbol_pixel(x, y, refined):
    column, xlocal = divmod(x - 14, 34)
    row, ylocal = divmod(y - 10, 40)
    if not (0 <= column < 8 and 0 <= row < 3 and 0 <= xlocal < 10 and 0 <= ylocal < 16):
        return False
    gx, gy = xlocal // 2, ylocal // 2
    value = glyphs[(row + column) % 2][gy][gx] == '1'
    return value ^ bool(refined and column % 3 == 1 and gx == 2 and gy == 3)


entries = [
    write_image('generic-17x11', 17, 11, lambda x, y: (x * 7 + y * 11) % 13 < 5 or x == y),
    write_image('generic-32x24', 32, 24, lambda x, y: (x // 4 + y // 3) % 2 == 0),
    write_image('symbols-320x144', 320, 144, lambda x, y: symbol_pixel(x, y, False)),
    write_image('refined-320x144', 320, 144, lambda x, y: symbol_pixel(x, y, True)),
    write_image('symbol-5x8', 5, 8, lambda x, y: glyphs[0][y][x] == '1'),
]
manifest = {'schemaVersion': 1, 'provenance': 'Original PageNarrator geometric pixels; no upstream image or font data.',
            'author': 'Felix Olsson', 'license': 'GPL-3.0-or-later', 'entries': entries}
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'output': str(output), 'files': len(entries), 'inputSha256': {e['id']: e['pbmSha256'] for e in entries}}))
