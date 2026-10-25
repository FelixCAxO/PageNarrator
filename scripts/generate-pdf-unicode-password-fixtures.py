"""Independent development-only AES256/R6 fixtures, with prepared password bytes."""
from io import BytesIO
from pathlib import Path
import hashlib
import json
import platform
import stringprep
import unicodedata
import fitz
import pypdf

root = Path(__file__).resolve().parents[1]
target = root / 'tests/pdf-engine/fixtures/unicode-passwords'
target.mkdir(parents=True, exist_ok=True)


def prepare(value):
    return unicodedata.ucd_3_2_0.normalize('NFKC', ''.join(
        ' ' if stringprep.in_table_c12(c) else c for c in value if not stringprep.in_table_b1(c)))


entries = []
for identifier, value, variants in [
    ('mapping', 'I\u00adX', ['IX', '\u2168']),
    ('spaces', 'pa\u00a0\u00aa', ['pa a', 'pa\u1680a', 'p\u200ba a']),
    ('canonical', 'A\u030arup\ufb03', ['\u00c5rupffi', '\u212brupffi']),
    ('rtl', '\u0627\u0031\u0627', []),
    ('historical-cjk', '\U0002f868', ['\U0002136a']),
    ('truncate-bytes', 'A' * 126 + '\u00e9Z', ['A' * 126 + '\u00e9different']),
]:
    prepared = prepare(value).encode('utf-8')[:127]
    owner = prepare('A\u030a-owner').encode('utf-8')
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((54, 92), 'Original Unicode password fixture.', fontsize=12)
    document.set_metadata({'title': 'Unicode password source title'})
    writer = pypdf.PdfWriter(clone_from=pypdf.PdfReader(BytesIO(document.tobytes())))
    writer.encrypt(user_password=prepared, owner_password=owner, algorithm='AES-256')
    filename = f'{identifier}.pdf'
    writer.write(target / filename)
    document.close()
    check = pypdf.PdfReader(target / filename, password=prepared)
    assert check.pages[0].extract_text().strip() == 'Original Unicode password fixture.'
    raw = (target / filename).read_bytes()
    entries.append({'id': identifier, 'file': filename, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                    'password': value, 'equivalents': variants, 'preparedBytesHex': prepared.hex(),
                    'owner': '\u212b-owner', 'ownerPreparedBytesHex': owner.hex(), 'independentReadPassed': True})

report = {'schemaVersion': 1, 'python': platform.python_version(), 'pypdf': pypdf.__version__,
          'mupdf': fitz.VersionBind, 'unicodeVersion': unicodedata.ucd_3_2_0.unidata_version,
          'scope': 'Independent AES256/R6 writer and reader; explicit prepared bytes avoid relying on its string normalization.', 'entries': entries}
(target / 'manifest.json').write_text(json.dumps(report, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'fixtures': len(entries), 'independentReadPassed': True}))
