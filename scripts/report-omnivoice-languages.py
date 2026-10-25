"""Build a local review gallery from the captured OmniVoice WAVs and independent analyses."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import hashlib
import html
import json
import argparse
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / 'artifacts/omnivoice-language-audit'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-pass', action='store_true', help='Exit nonzero unless every catalog sample has an unrestricted automatic pass.')
    args = parser.parse_args()
    corpus = read(DIRECTORY / 'corpus.json')['languages']
    assert len(corpus) == len({case['code'] for case in corpus}) == 646
    rows, accepted, pending = [], [], []
    for case in corpus:
        record_path = DIRECTORY / 'records' / f'{case["code"]}.json'
        analysis_path = DIRECTORY / 'analysis' / record_path.name
        record = read(record_path) if record_path.is_file() else {}
        result = read(analysis_path) if analysis_path.is_file() else {}
        matching = (result.get('analysisVersion') == 2 and result.get('requestSha256') == record.get('requestSha256')
                    and result.get('wavSha256') == record.get('wavSha256')
                    and record.get('nativeText') == case['nativeText']
                    and (not case['nativeText'] or record.get('text') == case['text']))
        if matching and record.get('wav'):
            matching = hashlib.sha256((DIRECTORY / record['wav']).read_bytes()).hexdigest() == record['wavSha256']
        if matching:
            accepted.append(result)
        else:
            pending.append(case['code'])
            result = {'status': 'pending'}
        signal = result.get('signal', {})
        recognition = result.get('strongRecognition') or result.get('recognition', {})
        quality = signal.get('dnsmos', {})
        overall = f'{quality["overall"]:.2f}' if quality else '—'
        cer = f'{recognition["cer"]:.1%}' if recognition else '—'
        baseline = result.get('nativeReferenceRecognition')
        note = ''
        if case.get('referenceLimit'):
            note = case['referenceLimit'] + ' '
        if result.get('strongRecognition'):
            note += f'Stronger 7B ASR checked this WAV; initial CTC error was {result["recognition"]["cer"]:.1%}. '
        if baseline:
            note += f'Original native recording CTC error: {baseline["cer"]:.1%}.'
        if result.get('asrBaselineLimited'):
            note += ' The smaller recognizer also struggles with the native recording; its mismatch alone cannot establish a speech failure.'
        if result.get('nativeReferenceError'):
            note += ' Native recording comparison unavailable: ' + result['nativeReferenceError']
        if result.get('error'):
            note += ' ' + result['error']
        if record.get('status') == 'synthesis-failed':
            note += ' ' + ' '.join(attempt.get('error', '') for attempt in record.get('attempts', []))
        esc = lambda value: html.escape(str(value), quote=True)
        player = f'<audio controls preload="none" src="{esc(record["wav"])}"></audio>' if matching and record.get('wav') else ''
        source = f'<a href="{esc(case["sourceUrl"])}">Native source</a>' if case.get('sourceUrl') else 'No native reference'
        rows.append(f'<tr data-status="{esc(result["status"])}"><td><strong>{esc(case["name"])}</strong> '
                    f'<code>{esc(case["code"])}</code><p>{source}</p></td><td>{esc(result["status"])}'
                    f'<p>{esc(note)}</p></td><td>{overall}</td><td>{cer}</td><td dir="auto">{esc(case.get("text") or "Signal-only English probe; no language acceptance.")}'
                    f'</td><td dir="auto">{esc(recognition.get("transcript", ""))}</td><td>{player}</td></tr>')
    counts = Counter(result['status'] for result in accepted)
    native_count = sum(case['nativeText'] for case in corpus)
    restricted_references = [case['code'] for case in corpus if case.get('referenceLimit')]
    missing = [case['code'] for case in corpus if not case['nativeText']]
    baseline_limited = sum(bool(result.get('asrBaselineLimited')) for result in accepted)
    snapshot = {'complete': not pending, 'catalogLanguages': 646, 'nativeReferences': native_count,
                'missingNativeReferences': missing, 'restrictedReferences': restricted_references, 'verifiedAnalyses': len(accepted), 'pending': pending,
                'counts': dict(counts), 'asrBaselineLimited': baseline_limited}
    (DIRECTORY / 'verified-summary.json').write_text(json.dumps(snapshot, indent=2), encoding='utf-8')
    scope = ('One fixed-voice sample per catalog language: female, variation 1, normal speech, seed 42, 24 steps. '
             'These are automatic sample checks, not human listening or whole-language certification. '
             'An acceptable sample needs character error rate ≤10%, DNSMOS speech ≥2.5, background ≥2.0, '
             'overall ≥2.5, and no physical audio failure. These screening thresholds are review rules, '
             'not validated language-specific acceptance standards. Missing native references never pass.')
    counts_text = ' · '.join(f'{status}: {count}' for status, count in sorted(counts.items()))
    document = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>OmniVoice language audit</title><style>
body{font:15px/1.5 system-ui;margin:32px;color:#182331;background:#f6f8fb}h1{margin-bottom:8px}
p{max-width:1100px}.metrics{padding:18px;background:#fff;border:1px solid #d5dfeb;border-radius:12px}
input,select{font:inherit;padding:8px;margin:8px 8px 16px 0}table{border-collapse:collapse;width:100%;background:#fff}
th,td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid #dce3ed}th{position:sticky;top:0;background:#eaf0f7}
td p{font-size:12px;max-width:300px;margin:8px 0;color:#516173}td:nth-child(5),td:nth-child(6){min-width:190px;max-width:300px}
code{color:#536b86}audio{width:220px}tr[data-status="automatic-sample-pass"] td:first-child{border-left:4px solid #2d885f}
tr[data-status="review-acoustics"] td:first-child,tr[data-status="signal-failed"] td:first-child,
tr[data-status="synthesis-failed"] td:first-child{border-left:4px solid #c75050}a{color:#175da1}
</style><h1>OmniVoice language audit</h1>'''
    document += f'<p>{html.escape(scope)}</p><div class="metrics"><strong>{len(accepted)} / 646 verified analyses</strong>'
    document += f'<p>{html.escape(counts_text)}</p><p>Native references: {native_count}. Missing: {html.escape(", ".join(missing)) or "none"}. '
    document += f'Restricted reference checks: {html.escape(", ".join(restricted_references)) or "none"}. '
    document += f'The smaller recognizer also struggled on the original native recording in {baseline_limited} cases.</p></div>'
    document += '<p><a href="report.md">Method and results</a> · <a href="verified-summary.json">Verified summary</a> · <a href="corpus.json">Input provenance</a> · <a href="runtime.json">Runtime</a></p>'
    document += '<input id="search" placeholder="Search language, text or code" aria-label="Search"><select id="filter" aria-label="Status"><option value="">All statuses</option>'
    document += ''.join(f'<option>{html.escape(status)}</option>' for status in sorted(set(counts) | ({'pending'} if pending else set())))
    document += '</select><table><thead><tr><th>Language</th><th>Verdict / uncertainty</th><th>DNSMOS</th><th>ASR error</th><th>Input</th><th>Recognition</th><th>Captured WAV</th></tr></thead><tbody>'
    document += ''.join(rows) + '''</tbody></table><script>
const search=document.querySelector('#search'),filter=document.querySelector('#filter');
function update(){const query=search.value.toLocaleLowerCase();for(const row of document.querySelectorAll('tbody tr'))
row.hidden=!!((filter.value&&row.dataset.status!==filter.value)||!row.textContent.toLocaleLowerCase().includes(query));}
search.addEventListener('input',update);filter.addEventListener('change',update);
</script></html>'''
    (DIRECTORY / 'index.html').write_text(document, encoding='utf-8')
    report = ['# OmniVoice automatic language audit', '', scope, '',
              f'Verified analyses: **{len(accepted)}/646**. Native references: **{native_count}/646**.', '',
              '| Status | Samples |', '|---|---:|', *[f'| {key} | {value} |' for key, value in sorted(counts.items())], '',
              f'Missing native references: {", ".join(missing) or "none"}.', '',
              f'Restricted references: {", ".join(restricted_references) or "none"}. Maba uses an attributed phonetic numeral phrase; '
              'this exercises native phonetic material but cannot give ordinary-language acceptance.', '',
              f'The smaller recognizer also had >10% error on {baseline_limited} original native recordings. '
              'Those baseline failures are recorded as uncertainty. A separate matching 7B decode can resolve a CTC transcript flag; '
              'an unresolved mismatch is not proof that the language itself is broken.', '',
              'The HTML gallery includes every input, recognized transcript, WAV and native source. '
              'Each verified result matches the captured request and WAV SHA-256. '
              'Capture errors retain both attempts. Fixed parameters and fresh worker retries are used; '
              'voice settings are not silently changed to obtain a passing sample.', '',
              'Independent checks: [OmniASR](https://github.com/facebookresearch/omnilingual-asr) CTC 1B v2 '
              '(CPU initially, with GPU completion after capture), a second opinion from OmniASR LLM 7B v2 (GPU) '
              'on flagged WAVs when available, and [Microsoft DNSMOS P.835](https://github.com/microsoft/DNS-Challenge/tree/master/DNSMOS) (ONNX CPU). '
              'The stronger recognizer receives only audio and a language hint; it never receives the expected text. '
              'A clean captured speech sample and deliberately corrupted versions validate that the '
              'acoustic screen rejects silence, broadband static and severe clipping (calibration/results.json).', '',
              'Native inputs come from the official OmniVoice FLEURS benchmark, Meta Omnilingual ASR corpus, '
              'UDHR translations, BibleNLP eBible, Mozilla Common Voice and attributed supplemental research or native text sources. Per-excerpt source, revision/hash '
              'and attribution are in corpus.json. Inputs and recordings are local audit artifacts, not release assets.', '',
              'This run checks default normal speech. It does not certify all voice variations, genders, whispering, '
              'multi-section continuity, accents or arbitrary text. Published model language coverage is not proof of output quality.', '',
              '## Repeating the local check', '',
              'From the repository root, run `python scripts/prepare-omnivoice-language-audit.py`, then opt in to '
              '`tests/e2e/omnivoice-language-audit.e2e.js` with `PN_E2E_LANGUAGE_AUDIT=1` and '
              '`PN_E2E_EXTENSION_DIR` pointing at the unpacked release. Optional capture sharding uses '
              '`PN_E2E_LANGUAGE_AUDIT_SHARD=0/3` (and 1/3, 2/3 in separate processes). '
              'Run `scripts/analyze-omnivoice-languages.py --watch` in the isolated Python 3.12 audit environment; '
              '`--device cuda` can finish outstanding checkpoints after capture. Then use `--strong-review` '
              'for flagged samples and `python scripts/report-omnivoice-languages.py` for the gallery. '
              'Package versions and model hashes are saved in environment-provenance.json. '
              'DNSMOS model provenance is in .cache/omnivoice-language-audit/dnsmos/provenance.json. '
              'The optional public-page and supplemental source snapshots live in the ignored audit cache; '
              'without those snapshots, the builder retains explicit gaps rather than inventing native text.', '',
              '## Acoustic and synthesis review', '']
    for result in accepted:
        if result['status'] in {'review-acoustics', 'signal-failed', 'synthesis-failed', 'analysis-error'}:
            score = result.get('signal', {}).get('dnsmos', {}).get('overall')
            detail = f', DNSMOS overall {score:.2f}' if score is not None else ''
            report.append(f'- **{result["name"]}** (`{result["code"]}`): {result["status"]}{detail}.')
    (DIRECTORY / 'report.md').write_text('\n'.join(report) + '\n', encoding='utf-8')
    print(json.dumps(snapshot))
    if args.require_pass and (pending or missing or restricted_references or counts.get('automatic-sample-pass', 0) != 646):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
