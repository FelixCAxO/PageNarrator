"""Collect attributed native-language excerpts for a local, non-published speech audit."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import concurrent.futures
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

CACHE = Path('.cache/omnivoice-language-audit')
OUT = Path('artifacts/omnivoice-language-audit')
ALIASES = {'sqi': 'als', 'nor': 'nob', 'swa': 'swh', 'fas': 'pes', 'aze': 'azj',
           'uzb': 'uzn', 'pus': 'pbt', 'orm': 'gaz', 'mon': 'khk', 'grn': 'gug', 'ipk': 'ike'}


def read_json(name):
    return json.loads((CACHE / name).read_text(encoding='utf-8'))


def prepare_inputs():
    """Bootstrap public metadata on a fresh checkout; never need private credentials."""
    CACHE.mkdir(parents=True, exist_ok=True)
    pins = {'fleurs': '699beb854ab40a8a38bd48285e67e22697fc6e63',
            'omni': '8648ba8946377697b427ae952076e49fc0e5e44d',
            'udhr': '588b3f4b2d0467aff54842a4b926551b69d5a66a',
            'bible': 'c531ff2da02843ded6d09afbe29a197ab844981f',
            'cv': 'a76d5c3be524e50489386616f9162e02c1dbf63d'}
    source = Path('src/tts/omnivoice/languages.js').read_text(encoding='utf-8')
    catalog = [dict(zip(['code', 'name', 'iso'], json.loads(line.strip().rstrip(','))))
               for line in source.splitlines() if re.match(r'^\s*\["', line)]
    assert len(catalog) == 646
    (CACHE / 'catalog-iso.json').write_text(json.dumps(catalog, ensure_ascii=False), encoding='utf-8')
    metadata = {'tts-eval-info.json': pins['fleurs'], 'omnicorpus-info.json': pins['omni'],
                'commonvoice-revision.json': pins['cv']}
    for name, sha in metadata.items():
        if not (CACHE / name).is_file():
            (CACHE / name).write_text(json.dumps({'sha':sha}), encoding='utf-8')
    urls = {
        'fleurs_multilingual_102.jsonl': f'https://huggingface.co/datasets/k2-fsa/TTS_eval_datasets/resolve/{pins["fleurs"]}/fleurs_multilingual_102.jsonl',
        'omnicorpus-splits.json': 'https://datasets-server.huggingface.co/splits?dataset=facebook%2Fomnilingual-asr-corpus',
        'udhr-tree.json': f'https://api.github.com/repos/eric-muller/udhr/git/trees/{pins["udhr"]}?recursive=1',
        'udhr-index.xml': f'https://raw.githubusercontent.com/eric-muller/udhr/{pins["udhr"]}/data/udhr/index.xml',
        'ebible-tree.json': f'https://api.github.com/repos/BibleNLP/ebible-corpus/git/trees/{pins["bible"]}?recursive=1',
        'commonvoice-data-dirs.json': f'https://api.github.com/repos/common-voice/common-voice/contents/server/data?ref={pins["cv"]}',
    }
    for name, url in urls.items():
        if not (CACHE / name).is_file():
            (CACHE / name).write_bytes(fetch(url, 'metadata-' + name))


def fetch(url, name, limit=None):
    path = CACHE / 'sources' / name
    if path.is_file():
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'PageNarrator-local-language-audit'})
            with urllib.request.urlopen(request, timeout=25) as response:
                data = response.read(limit) if limit else response.read()
            path.write_bytes(data)
            return data
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt * 2)


def excerpt(text):
    text = re.sub(r'\s+', ' ', text).strip().replace('\ufeff', '')
    if any(marker in text for marker in ['<', '>', '[', ']']) or not text or len(text) < 20:
        return None
    # Preserve a verbatim sentence/clause when possible, otherwise a word-bounded excerpt.
    pieces = re.split(r'(?<=[.!?。！？।;])\s*', text)
    for piece in pieces:
        if 35 <= len(piece) <= 120:
            return piece
    if 20 <= len(text) <= 120:
        return text
    end = text.rfind(' ', 45, 110)
    if end > 45:
        return text[:end]
    return text[:60] if len(text) >= 60 else None


def main():
    prepare_inputs()
    OUT.mkdir(parents=True, exist_ok=True)
    catalog = read_json('catalog-iso.json')
    fleurs = [json.loads(line) for line in (CACHE / 'fleurs_multilingual_102.jsonl').read_text(encoding='utf-8').splitlines()]
    fleurs_pin = read_json('tts-eval-info.json')['sha']
    omni_pin = read_json('omnicorpus-info.json')['sha']
    splits = read_json('omnicorpus-splits.json')['splits']
    udhr_pin = read_json('udhr-tree.json')['sha']
    udhr = list(ET.parse(CACHE / 'udhr-index.xml').getroot())
    bible = read_json('ebible-tree.json')
    cv_pin = read_json('commonvoice-revision.json')['sha']
    cv_dirs = {item['name'] for item in read_json('commonvoice-data-dirs.json')}
    # Optional public-page excerpts collected through the ordinary guest UI.
    # Keep these local inputs attributed; never require credentials or uploads.
    cv_public_path = CACHE / 'commonvoice-public-prompts.json'
    cv_public = json.loads(cv_public_path.read_text(encoding='utf-8')) if cv_public_path.is_file() else {}
    cv_variant_path = CACHE / 'commonvoice-public-provenance.json'
    cv_variants = json.loads(cv_variant_path.read_text(encoding='utf-8')) if cv_variant_path.is_file() else {}
    supplemental_path = CACHE / 'supplemental-native-references.json'
    supplemental = json.loads(supplemental_path.read_text(encoding='utf-8')) if supplemental_path.is_file() else {}
    bible_files = [item['path'] for item in bible['tree'] if item['path'].startswith('corpus/') and item['path'].endswith('.txt')]
    results = []

    def collect(language):
        code, iso = language['code'], language['iso']
        errors = []
        for item in fleurs:
            if item['language_id'] == code:
                text = excerpt(item['text'])
                if text:
                    return {**language, 'text': text, 'nativeText': True, 'source': 'k2-fsa/TTS_eval_datasets/FLEURS',
                            'sourceRevision': fleurs_pin, 'sourceId': item['id'], 'sourceUrl': f'https://huggingface.co/datasets/k2-fsa/TTS_eval_datasets/blob/{fleurs_pin}/fleurs_multilingual_102.jsonl',
                            'license': 'FLEURS source attribution retained by benchmark publisher; local evaluation only'}
        iso_codes = [iso, ALIASES.get(iso)]
        configs = sorted({item['config'] for item in splits if item['config'].split('_')[0] in iso_codes})
        for config in configs:
            for split in ['test', 'dev', 'train']:
                if not any(s['config'] == config and s['split'] == split for s in splits):
                    continue
                url = 'https://datasets-server.huggingface.co/first-rows?' + urllib.parse.urlencode({
                    'dataset': 'facebook/omnilingual-asr-corpus', 'config': config, 'split': split})
                try:
                    raw = fetch(url, f'omni-{config}-{split}.json')
                    data = json.loads(raw)
                    for item in data['rows']:
                        row = item['row']
                        text = excerpt(row.get('raw_text', ''))
                        if text:
                            return {**language, 'text': text, 'nativeText': True, 'source': 'facebook/omnilingual-asr-corpus',
                                    'sourceMetadataRevision': omni_pin, 'sourceId': f'{config}/{split}/{item["row_idx"]}',
                                    'sourceUrl': url, 'sourceResponseSha256': hashlib.sha256(raw).hexdigest(),
                                    'sourceIso': row.get('iso_639_3'), 'script': row.get('iso_15924'), 'license': 'CC-BY-4.0'}
                except Exception as error:
                    errors.append(f'{config}/{split}: {error}')
        entries = sorted((item for item in udhr if (item.get('iso639-3') in iso_codes or item.get('bcp47') == code)
                          and item.get('stage') in ['3', '4', '5']), key=lambda item: -int(item.get('stage')))
        for item in entries:
            name = f'udhr_{item.get("f")}.xml'
            url = f'https://raw.githubusercontent.com/eric-muller/udhr/{udhr_pin}/data/udhr/{name}'
            try:
                raw = fetch(url, name)
                tree = ET.fromstring(raw)
                for article in tree.iter():
                    if article.tag.split('}')[-1] != 'article':
                        continue
                    for para in article.iter():
                        if para.tag.split('}')[-1] == 'para':
                            text = excerpt(''.join(para.itertext()))
                            if text:
                                return {**language, 'text': text, 'nativeText': True, 'source': 'UDHR in XML',
                                        'sourceRevision': udhr_pin, 'sourceId': name, 'sourceUrl': url,
                                        'sourceResponseSha256': hashlib.sha256(raw).hexdigest(), 'sourceIso': item.get('iso639-3'),
                                        'script': item.get('iso15924'), 'license': 'Source attribution retained; local evaluation only'}
            except Exception as error:
                errors.append(f'{name}: {error}')
        paths = sorted(path for path in bible_files if path.split('/')[-1].split('-')[0] in iso_codes)
        for name in paths[:2]:
            url = f'https://raw.githubusercontent.com/BibleNLP/ebible-corpus/{bible["sha"]}/{name}'
            try:
                raw = fetch(url, Path(name).name, limit=524288)
                for index, line in enumerate(raw.decode('utf-8', errors='ignore').splitlines()):
                    text = excerpt(line)
                    if text:
                        return {**language, 'text': text, 'nativeText': True, 'source': 'BibleNLP/eBible',
                                'sourceRevision': bible['sha'], 'sourceId': f'{name}:{index + 1}', 'sourceUrl': url,
                                'sourcePrefixSha256': hashlib.sha256(raw).hexdigest(),
                                'licenseUrl': f'https://github.com/BibleNLP/ebible-corpus/tree/{bible["sha"]}/metadata/licenses',
                                'license': 'Version-specific source license retained; local evaluation only'}
            except Exception as error:
                errors.append(f'{name}: {error}')
        if code in cv_dirs:
            url = f'https://raw.githubusercontent.com/common-voice/common-voice/{cv_pin}/server/data/{code}/sentence-collector.txt'
            try:
                raw = fetch(url, f'cv-{code}.txt', limit=524288)
                for index, line in enumerate(raw.decode('utf-8', errors='ignore').splitlines()):
                    text = excerpt(line)
                    if text:
                        return {**language, 'text': text, 'nativeText': True, 'source': 'Mozilla Common Voice sentences',
                                'sourceRevision': cv_pin, 'sourceId': f'{code}:{index + 1}', 'sourceUrl': url,
                                'sourcePrefixSha256': hashlib.sha256(raw).hexdigest(), 'license': 'CC0 sentence contributions'}
            except Exception as error:
                errors.append(f'Common Voice {code}: {error}')
        if code in cv_public and (text := excerpt(cv_public[code])):
            return {**language, 'text': text, 'nativeText': True, 'source': 'Mozilla Common Voice public prompts',
                    'sourceId': code, 'sourceUrl': f'https://commonvoice.mozilla.org/{code}/speak',
                    'sourceVariant': cv_variants.get(code),
                    'sourceRetrievedDate': '2026-10-20', 'sourceExcerptSha256': hashlib.sha256(cv_public[code].encode()).hexdigest(),
                    'license': 'CC0 sentence contributions; public guest UI, no recording or upload'}
        if code in supplemental and (text := excerpt(supplemental[code]['text'])):
            return {**language, **supplemental[code], 'text': text, 'nativeText': True}
        return {**language, 'nativeText': False, 'text': None, 'status': 'missing-native-reference', 'sourceErrors': errors}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for future in concurrent.futures.as_completed([pool.submit(collect, language) for language in catalog]):
            result = future.result()
            if result['text']:
                result['textSha256'] = hashlib.sha256(result['text'].encode()).hexdigest()
            results.append(result)
            if len(results) % 25 == 0:
                print(json.dumps({'collected': len(results), 'nativeReferences': sum(bool(r['text']) for r in results)}), flush=True)
            ordered = sorted(results, key=lambda item: next(i for i, language in enumerate(catalog) if language['code'] == item['code']))
            (OUT / 'corpus.json').write_text(json.dumps({'scope': 'Local audit inputs, not for source/release redistribution.', 'languages': ordered}, ensure_ascii=False, indent=2), encoding='utf-8')
    assert len(results) == len(catalog) == len({r['code'] for r in results}) == 646
    assert all(not r['text'] or (20 <= len(r['text']) <= 120 and r['sourceUrl']) for r in results)
    print(json.dumps({'total': len(results), 'nativeReferences': sum(bool(r['text']) for r in results), 'missing': [r['code'] for r in results if not r['text']]}), flush=True)


if __name__ == '__main__':
    main()
