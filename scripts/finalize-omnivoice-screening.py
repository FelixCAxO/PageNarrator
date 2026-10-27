"""Bind independent audio-only recognition to captured worker samples; retain all diagnostics."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--directory', type=Path, required=True)
parser.add_argument('--recognition', type=Path, required=True)
parser.add_argument('--confirmation', type=Path, help='Independent CTC confirmation for first-pass/primary disagreements.')
args = parser.parse_args()
root = args.directory
opinion = json.loads(args.recognition.read_text(encoding='utf8'))
assert opinion['conditioning'] == 'Audio and language ID only'
assert opinion['model'] == 'omniASR_LLM_7B_v2'
recognition = {row['id']: row for row in opinion['results']}
confirmations = {}
if args.confirmation:
    confirmation = json.loads(args.confirmation.read_text(encoding='utf8'))
    assert confirmation['model'] == 'omniASR_CTC_1B_v2' and confirmation['conditioning'] == 'Audio and language ID only'
    confirmations = {row['id']: row for row in confirmation['results']}
corpus = json.loads((root / 'corpus.json').read_text(encoding='utf8'))['languages']
records = {item['id']: json.loads((root / 'records' / (item['id'] + '.json')).read_text(encoding='utf8')) for item in corpus}
rows = {}
for item in corpus:
    id = item['id']
    record = records[id]
    if record['status'] == 'unsupported-whisper':
        continue
    path = root / 'analysis' / (id + '.json')
    row = json.loads(path.read_text(encoding='utf8'))
    result = recognition.get(id)
    if result is None and item.get('replayOf'):
        baseline = recognition.get(item['replayOf'])
        if baseline and baseline['wavSha256'] == record['wavSha256']:
            result = {**baseline, 'id': id, 'reusedIdenticalWavFrom': item['replayOf']}
    if result is None:
        # Keep passing first-pass recognition; second opinions are required for disagreements and Cantonese.
        result = {**row['recognition'], 'model': 'faster-whisper-large-v3-turbo', 'wavSha256': row['wavSha256'], 'text': row['text']}
        assert record['code'] != 'yue' and result['cer'] <= .1
    assert result['wavSha256'] == row['wavSha256'] == record['wavSha256']
    assert hashlib.sha256((root / record['wav']).read_bytes()).hexdigest() == result['wavSha256']
    assert result['text'] == record['text']
    row['originalRecognition'] = row.get('originalRecognition', row['recognition'])
    row['recognition'] = result
    row['recognitionReportSha256'] = hashlib.sha256(args.recognition.read_bytes()).hexdigest()
    metric = result.get('phonetic', {}).get('errorRate', result['cer'])
    row['recognitionMetric'] = 'toned-jyutping-syllable-error' if 'phonetic' in result else 'character-error'
    row['recognitionErrorRate'] = metric
    third = confirmations.get(id)
    if third is not None:
        assert third['wavSha256'] == record['wavSha256'] and third['text'] == record['text']
        row['recognitionConfirmation'] = third
        first_error = row['originalRecognition'].get('cer', float('inf'))
        if 'phonetic' not in result and metric > .1 and first_error <= .1 and third['cer'] <= .1:
            # A larger recognizer can also mishear; require two audio-only confirmations, not the best score.
            metric = max(first_error, third['cer'])
            row['recognitionMetric'] = 'two-confirming-character-errors'
            row['recognitionErrorRate'] = metric
            row['recognitionDecision'] = dict(primaryError=result['cer'], firstError=first_error,
                confirmationError=third['cer'], maximumError=.1, rule='Both confirming recognizers must pass the unchanged bound.')
    if row['signal']['physicalFailure']:
        row['status'] = 'signal-failed'
    elif not record['request'].get('whisper') and row['signal']['acousticReview']:
        row['status'] = 'review-acoustics'
    elif metric > .1:
        row['status'] = 'review-transcript'
    elif record['request'].get('whisper') and row['style']['whisperMargin'] <= 0:
        row['status'] = 'review-whisper-style'
    else:
        row['status'] = 'automatic-sample-pass'
    rows[id] = row
for item in corpus:
    id = item['id']
    if id not in rows:
        continue
    if item['omniVoice'].get('whisper'):
        parent = item.get('replayOf', id).removesuffix('-whisper')
        normal = records[parent]
        row = rows[id]
        row['backingSpeech'] = dict(id=parent, equalPcm=records[id].get('backingPcmSha256') is not None and
            records[id]['backingPcmSha256'] == normal.get('backingPcmSha256'),
            status=rows[parent]['status'])
        if not row['backingSpeech']['equalPcm']:
            row['status'] = 'backing-speech-mismatch'
        elif rows[parent]['status'] != 'automatic-sample-pass' and row['status'] == 'automatic-sample-pass':
            row['status'] = 'review-backing-speech'
    path = root / 'analysis' / (id + '.json')
    path.write_text(json.dumps(rows[id], ensure_ascii=False, indent=2), encoding='utf8')
counts = {}
for item in corpus:
    if not item.get('replayOf'):
        status = rows[item['id']]['status'] if item['id'] in rows else records[item['id']]['status']
        counts[status] = counts.get(status, 0) + 1
print(json.dumps(dict(samples=len(corpus), counts=counts, nativeListening='unverified')))
