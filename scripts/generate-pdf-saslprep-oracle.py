"""Original Unicode3.2/stringprep generator is matching source; upstream Python libraries are excluded from the extension."""
import hashlib
import json
import platform
import random
import stringprep
import struct
import unicodedata
from pathlib import Path

root = Path(__file__).resolve().parents[1]
ucd = unicodedata.ucd_3_2_0
table_names = ['a1', 'b1', 'c12', 'c21', 'c22', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'd1', 'd2']
tables = [getattr(stringprep, 'in_table_' + name) for name in table_names]


def prepare(value):
    mapped = ''.join(' ' if stringprep.in_table_c12(c) else c for c in value if not stringprep.in_table_b1(c))
    normalized = ucd.normalize('NFKC', mapped)
    if any(stringprep.in_table_a1(c) or any(table(c) for table in tables[2:12]) for c in normalized):
        raise ValueError('prohibited')
    if any(stringprep.in_table_d1(c) for c in normalized) and (
        any(stringprep.in_table_d2(c) for c in normalized)
        or not stringprep.in_table_d1(normalized[0]) or not stringprep.in_table_d1(normalized[-1])
    ):
        raise ValueError('bidi')
    return normalized


normalization = hashlib.sha256()
membership = hashlib.sha256()
for code in range(0x110000):
    character = chr(code)
    for normalized in ucd.normalize('NFKC', character):
        normalization.update(struct.pack('<I', ord(normalized)))
    normalization.update(b'\xff\xff\xff\xff')
    flags = sum(1 << index for index, table in enumerate(tables) if table(character))
    membership.update(struct.pack('<H', flags))

pool = [chr(code) for code in range(0x110000) if ucd.decomposition(chr(code)) or ucd.combining(chr(code))]
pool.extend(['a', ' ', '\u05d0', '\u0627', '\u00ad', '\u200b', '\u00a0', '\u0221', '\U0001f600', '\ud800', '\ufeff'])
pool.extend(chr(code) for code in range(0xac00, 0xd7a4, 137))
rng = random.Random(3454)
values = ['', 'I\u00adX', '\u2168', '\u00aa', '\u0627\u0031', '\u0627\u0031\u0627',
          '\u1100\u0300\u1161', '\u0b47\u0300\u0b3e', '\u212b\u0323', '\ufb03',
          '\U0002f868', '\U0002f874', '\U0002f91f', '\U0002f95f', '\U0002f9bf']
values.extend(''.join(rng.choice(pool) for _ in range(rng.randrange(1, 17))) for _ in range(1024))
samples = []
for value in values:
    sample = {'input': value, 'nfkc': ucd.normalize('NFKC', value)}
    try:
        sample['prepared'] = prepare(value)
    except ValueError:
        sample['invalid'] = True
    samples.append(sample)

report = {'schemaVersion': 1, 'scope': 'Independent development oracle; original generator scripts are matching source. Upstream Python/runtime/library implementations are excluded from the extension.',
          'python': platform.python_version(), 'unicodeVersion': ucd.unidata_version,
          'tableOrder': table_names, 'scalarCount': 0x110000,
          'normalizationScalarSha256': normalization.hexdigest(), 'stringprepScalarSha256': membership.hexdigest(),
          'samples': samples}
target = root / 'tests/pdf-engine/fixtures/saslprep-python.json'
target.write_text(json.dumps(report, ensure_ascii=True, separators=(',', ':')) + '\n', encoding='utf-8')
print(json.dumps({'samples': len(samples), 'bytes': target.stat().st_size,
                  'normalizationScalarSha256': report['normalizationScalarSha256'],
                  'stringprepScalarSha256': report['stringprepScalarSha256']}))
