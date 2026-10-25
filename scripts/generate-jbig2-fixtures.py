"""Original MQ/refinement vectors and externally encoded authored JBIG2 images."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import hashlib
import json
from pathlib import Path

# Numeric probability facts: ITU-T T.88 Annex E, Table E.1 (not sample bytes).
QE = [0x5601,0x3401,0x1801,0xac1,0x521,0x221,0x5601,0x5401,0x4801,0x3801,0x3001,0x2401,0x1c01,0x1601,0x5601,0x5401,0x5101,0x4801,0x3801,0x3401,0x3001,0x2801,0x2401,0x2201,0x1c01,0x1801,0x1601,0x1401,0x1201,0x1101,0xac1,0x9c1,0x8a1,0x521,0x441,0x2a1,0x221,0x141,0x111,0x85,0x49,0x25,0x15,9,5,1,0x5601]
NMPS = list(range(1,6)) + [38] + list(range(7,14)) + [29] + list(range(15,46)) + [45,46]
NLPS = [1,6,9,12,29,33,6,14,14,14,17,18,20,21,14,14,15,16,17,18,19,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,46]
assert len(QE) == len(NMPS) == len(NLPS) == 47


class MqEncoder:
    """Independent fixture writer from T.88 E.2 interval/byte conventions."""
    def __init__(self):
        self.a, self.c, self.ct = 0x8000, 0, 12
        self.output = [0]
        self.contexts = {}

    def byte_out(self):
        if self.output[-1] != 255 and self.c >= 0x8000000:
            self.output[-1] += 1
            self.c &= 0x7ffffff
        stuffed = self.output[-1] == 255
        self.output.append(self.c >> (20 if stuffed else 19))
        self.c &= 0xfffff if stuffed else 0x7ffff
        self.ct = 7 if stuffed else 8

    def write(self, context, bit):
        index, mps = self.contexts.get(context, (0, 0))
        qe = QE[index]
        self.a -= qe
        if bit == mps:
            if self.a >= 0x8000:
                self.c += qe
                return
            if self.a < qe:
                self.a = qe
            else:
                self.c += qe
            index = NMPS[index]
        else:
            if self.a < qe:
                self.c += qe
            else:
                self.a = qe
            if index in (0, 6, 14):
                mps ^= 1
            index = NLPS[index]
        self.contexts[context] = (index, mps)
        while self.a < 0x8000:
            self.a <<= 1
            self.c <<= 1
            self.ct -= 1
            if not self.ct:
                self.byte_out()

    def finish(self):
        upper = self.c + self.a
        self.c |= 0xffff
        if self.c >= upper:
            self.c -= 0x8000
        self.c <<= self.ct
        self.byte_out()
        self.c <<= self.ct
        self.byte_out()
        if self.output[-1] != 255:
            self.output.append(255)
        self.output.append(172)
        return bytes(self.output[1:])


def refinement(template):
    rows = ['11111', '10001', '10101', '10101', '10001', '11111', '00100', '00100']
    source = [[int(x) for x in row] for row in rows]
    target = [[value ^ int(x == 2 and y == 3) for x, value in enumerate(row)] for y, row in enumerate(source)]
    def pixel(image, x, y):
        return image[y][x] if 0 <= x < 5 and 0 <= y < 8 else 0
    # Coordinate facts from T.88 Figures 12 and 13, in significance order.
    output_points = [(-1,-1),(0,-1),(1,-1),(-1,0)] if template else [(0,-1),(1,-1),(-1,0)]
    reference_points = [(0,-1),(-1,0),(0,0),(1,0),(0,1),(1,1)] if template else [(0,-1),(1,-1),(-1,0),(0,0),(1,0),(-1,1),(0,1),(1,1)]
    encoder = MqEncoder()
    for y in range(8):
        for x in range(5):
            context = 0
            for dx, dy in output_points:
                context = context * 2 + pixel(target, x + dx, y + dy)
            for dx, dy in reference_points:
                context = context * 2 + pixel(source, x + dx, y + dy)
            if not template:
                context = context * 2 + pixel(target, x - 1, y - 1)
                context = context * 2 + pixel(source, x - 1, y - 1)
            encoder.write(context, target[y][x])
    packed = lambda image: bytes(sum(value << (7-x) for x, value in enumerate(row)) for row in image)
    return {'template': template, 'width': 5, 'height': 8, 'referenceHex': packed(source).hex(), 'targetHex': packed(target).hex(), 'encodedHex': encoder.finish().hex()}


parser = argparse.ArgumentParser()
parser.add_argument('--external', type=Path, required=True)
args = parser.parse_args()
source = bytes(((i * 43) ^ 0xa5) & 255 for i in range(32))
encoder = MqEncoder()
for byte in source:
    for shift in range(7, -1, -1):
        encoder.write(0, byte >> shift & 1)
result = {'schemaVersion': 1, 'author': 'Felix Olsson', 'license': 'GPL-3.0-or-later',
          'provenance': 'Original deterministic source bits and geometric refinement bitmaps; own development encoder from normative algorithm/facts, not published example bytes. External authored-image execution is verified separately.',
          'singleContext': {'sourceHex': source.hex(), 'encodedHex': encoder.finish().hex()},
          'refinements': [refinement(0), refinement(1)]}
if args.external:
    base = args.external.resolve()
    encoder_manifest = json.loads((base / 'encoder-manifest.json').read_text(encoding='utf-8'))
    inputs_path = Path(encoder_manifest['inputsManifest']['path'])
    inputs_bytes = inputs_path.read_bytes()
    if hashlib.sha256(inputs_bytes).hexdigest() != encoder_manifest['inputsManifest']['sha256']:
        raise RuntimeError('Original encoder input manifest changed')
    inputs = json.loads(inputs_bytes)
    result['encoder'] = {key: encoder_manifest[key] for key in ('docker', 'dependencies', 'commands', 'templates')}
    result['encoder']['source'] = {key: encoder_manifest['source'][key] for key in ('url', 'revision', 'version', 'license')}
    result['encoder']['refinement'] = {'status': 'External encoder refuses refinement; no coverage claimed from its -r option.'}
    result['inputs'] = inputs['entries']
    result['external'] = {file.name: {'bytes': len(file.read_bytes()), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'hex': file.read_bytes().hex()}
                          for file in sorted(base.iterdir()) if file.is_file() and (file.suffix == '.jb2' or file.name in ('symbols.sym', 'symbols.0000'))}
    for name, entry in result['external'].items():
        if entry['sha256'] != encoder_manifest['outputs'][name]['sha256']:
            raise RuntimeError('Independent encoder output changed: ' + name)
output = Path(__file__).resolve().parents[1] / 'tests/pdf-engine/fixtures/jbig2-original.json'
output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'output': str(output), 'singleContextBytes': len(bytes.fromhex(result['singleContext']['encodedHex'])), 'refinementBytes': [len(bytes.fromhex(r['encodedHex'])) for r in result['refinements']]}))
