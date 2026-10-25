"""Independent local speech screening; automatic sample acceptance is not human listening."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import hashlib
import json
import math
import time
import unicodedata
import urllib.request
import wave
import soundfile as sf
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from scipy.signal import resample_poly
from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline
from omnilingual_asr.models.wav2vec2_llama.lang_ids import supported_langs
from fairseq2.models.hub import load_model
from fairseq2.data.tokenizers.hub import load_tokenizer

ROOT = Path(__file__).resolve().parent.parent
NORMALIZER_VERSION = 1
MODEL = 'omniASR_CTC_1B_v2'
ANALYSIS_VERSION = 2
DNSMOS_REVISION = '591184a9fcb2cbdec02520fed81a32bbbf9d73ff'
DNSMOS_SHA256 = '269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd'


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def dnsmos_model():
    path = ROOT / '.cache/omnivoice-language-audit/dnsmos/sig_bak_ovr.onnx'
    url = f'https://raw.githubusercontent.com/microsoft/DNS-Challenge/{DNSMOS_REVISION}/DNSMOS/DNSMOS/sig_bak_ovr.onnx'
    if not path.is_file():
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != DNSMOS_SHA256:
            raise ValueError('DNSMOS download does not match the pinned model hash')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    if hashlib.sha256(path.read_bytes()).hexdigest() != DNSMOS_SHA256:
        raise ValueError('Cached DNSMOS model does not match the pinned hash')
    atomic_json(path.parent / 'provenance.json', {'url':url, 'revision':DNSMOS_REVISION, 'sha256':DNSMOS_SHA256})
    return path


def normalize(text):
    text = unicodedata.normalize('NFKC', text).casefold()
    # Arabic vowel marks are optional spelling, unlike vowel signs in Indic scripts.
    text = ''.join(c for c in text if not ('\u064b' <= c <= '\u065f' or c == '\u0670'))
    return ''.join(c for c in text if unicodedata.category(c)[0] in 'LMN')


def distance(left, right):
    row = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        new = [i]
        for j, b in enumerate(right, 1):
            new.append(min(new[-1] + 1, row[j] + 1, row[j - 1] + (a != b)))
        row = new
    return row[-1]


def transcribe(pipeline, path, expected):
    text = pipeline.transcribe([str(path)], batch_size=1)[0]
    target, actual = normalize(expected), normalize(text)
    edits = distance(target, actual)
    return {'transcript': text, 'expectedCharacters': len(target), 'edits': edits,
            'cer': edits / max(1, len(target))}


def signal_scores(path, session):
    with wave.open(str(path), 'rb') as stream:
        if stream.getnchannels() != 1 or stream.getsampwidth() != 2 or stream.getframerate() != 24000:
            raise ValueError('Unexpected WAV format')
        pcm = np.frombuffer(stream.readframes(stream.getnframes()), dtype='<i2').astype(np.float32) / 32768
    if not len(pcm) or not np.isfinite(pcm).all():
        raise ValueError('Empty or non-finite audio')
    energy = float(np.mean(pcm ** 2))
    rms = math.sqrt(energy)
    clipping = float(np.mean(np.abs(pcm) >= .999))
    crossings = float(np.mean(pcm[1:] * pcm[:-1] < 0))
    difference = float(np.mean(np.diff(pcm) ** 2) / max(energy, 1e-20))
    silence = float(np.var(pcm)) < 1e-10
    static = crossings > .35 and difference > 1.5
    audio = resample_poly(pcm, 2, 3).astype(np.float32)
    length = int(9.01 * 16000)
    while len(audio) < length:
        audio = np.concatenate([audio, audio])
    scores = []
    for start in range(0, len(audio) - length + 1, 16000):
        sig, bak, overall = session.run(None, {'input_1': audio[start:start + length][None, :]})[0][0]
        # Published DNSMOS P.835 calibration, non-personalized variant.
        scores.append([np.polyval([-.08397278, 1.22083953, .0052439], sig),
                       np.polyval([-.13166888, 1.60915514, -.39604546], bak),
                       np.polyval([-.06766283, 1.11546468, .04602535], overall)])
    sig, bak, overall = np.mean(scores, axis=0).tolist()
    return {'seconds': len(pcm) / 24000, 'rms': rms, 'clippedFraction': clipping,
            'zeroCrossingRate': crossings, 'differenceEnergyRatio': difference,
            'physicalFailure': silence or static or clipping > .2,
            'dnsmos': {'speech': sig, 'background': bak, 'overall': overall},
            'acousticReview': sig < 2.5 or bak < 2 or overall < 2.5}


def reference_check(pipeline, case, directory):
    if case.get('source') != 'facebook/omnilingual-asr-corpus':
        return None
    config, split, row_id = case['sourceId'].split('/')
    cached = ROOT / '.cache/omnivoice-language-audit/sources' / f'omni-{config}-{split}.json'
    rows = json.loads(cached.read_text(encoding='utf-8'))['rows']
    row = next(item['row'] for item in rows if str(item['row_idx']) == row_id)
    audio = row['audio']
    url = audio[0]['src'] if isinstance(audio, list) else audio['src']
    cache = ROOT / '.cache/omnivoice-language-audit/reference-audio'
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f'{case["code"]}.wav'
    if not path.is_file():
        with urllib.request.urlopen(url, timeout=30) as response:
            path.write_bytes(response.read())
    # Source recordings can exceed the recognizer's 40-second limit; retain the
    # complete transcript by decoding consecutive 30-second waveform segments.
    audio, rate = sf.read(path, dtype='float32')
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    chunks = [{'waveform': audio[start:start + rate * 30], 'sample_rate': rate}
              for start in range(0, len(audio), rate * 30)]
    text = ' '.join(pipeline.transcribe(chunks, batch_size=1))
    expected = normalize(row['raw_text'])
    edits = distance(expected, normalize(text))
    result = {'transcript': text, 'expectedCharacters': len(expected), 'edits': edits,
              'cer': edits / max(1, len(expected))}
    result['audioSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    result['sourceId'] = case['sourceId']
    return result


def summarize(directory):
    results = [json.loads(path.read_text(encoding='utf-8')) for path in sorted((directory / 'analysis').glob('*.json'))]
    counts = {}
    for result in results:
        counts[result['status']] = counts.get(result['status'], 0) + 1
    report = {'scope': 'Automatic sample screening only; no human listening or whole-language certification.',
              'firstPassModel': MODEL,
              'secondOpinionModel': 'omniASR_LLM_7B_v2' if any(result.get('strongRecognition') for result in results) else None,
              'normalizerVersion': NORMALIZER_VERSION,
              'thresholds': {'maximumSampleCer': .10, 'minimumDnsMosSpeech': 2.5,
                             'minimumDnsMosBackground': 2, 'minimumDnsMosOverall': 2.5},
              'analyzed': len(results), 'counts': counts, 'languages': results}
    atomic_json(directory / 'summary.json', report)
    return counts


def strong_review_targets(directory, watch):
    seen = set()
    last_progress = time.monotonic()
    while True:
        found = False
        paths = sorted((directory / 'analysis').glob('*.json'))
        for path in paths:
            if path in seen:
                continue
            result = json.loads(path.read_text(encoding='utf-8'))
            if result['status'] in {'review-transcript', 'review-acoustics'} and not result.get('strongRecognition'):
                seen.add(path)
                found = True
                last_progress = time.monotonic()
                yield path
        if not watch or (len(paths) == 646 and not found):
            return
        if not found:
            if time.monotonic() - last_progress > 600:
                raise TimeoutError('No new analyses for ten minutes; strong review checkpoints were saved.')
            time.sleep(2)


def strong_review(directory, watch=False):
    """Second recognition opinion; never provide the target transcript to ASR."""
    model = 'omniASR_LLM_7B_v2'
    corpus = {case['code']: case for case in json.loads((directory / 'corpus.json').read_text(encoding='utf-8'))['languages']}
    torch.set_num_threads(4)
    # The official loader's mmap option avoids materializing the complete 30 GB
    # FP32 checkpoint in host RAM before loading the unchanged BF16 GPU model.
    loaded = load_model(model, device=torch.device('cuda'), dtype=torch.bfloat16, mmap=True)
    pipeline = ASRInferencePipeline(model_card=None, model=loaded, tokenizer=load_tokenizer(model),
                                    device='cuda', dtype=torch.bfloat16)
    atomic_json(directory / 'strong-analysis-environment.json', {'model': model, 'torch': torch.__version__,
                'device': torch.cuda.get_device_name(), 'dtype': 'bfloat16',
                'checkpointLoading': 'Official fairseq2 memory-mapped loader; original checkpoint unchanged.',
                'conditioning': 'Audio and language ID only; expected text is used only after decoding for scoring.'})
    aliases = {'sqi': 'als', 'nor': 'nob', 'swa': 'swh', 'fas': 'pes', 'aze': 'azj',
               'uzb': 'uzn', 'pus': 'pbt', 'orm': 'gaz', 'mon': 'khk', 'grn': 'gug',
               'ipk': 'ike', 'ara': 'arb', 'zho': 'cmn'}
    reviewed = 0
    for target in strong_review_targets(directory, watch):
        result = json.loads(target.read_text(encoding='utf-8'))
        if result['status'] not in {'review-transcript', 'review-acoustics'} or result.get('strongRecognition'):
            continue
        case = corpus[result['code']]
        candidates = []
        for iso in [case.get('sourceIso'), case['iso'], aliases.get(case['iso'])]:
            matches = sorted(code for code in supported_langs if code.split('_')[0] == iso)
            if matches:
                candidates = matches
                break
        lang = next((code for code in candidates if code.endswith('_' + case.get('script', '?'))), None)
        if not lang and len(candidates) == 1:
            lang = candidates[0]
        if not lang and candidates:
            script_names = {'LATIN': 'Latn', 'CYRILLIC': 'Cyrl', 'ARABIC': 'Arab', 'DEVANAGARI': 'Deva',
                            'BENGALI': 'Beng', 'GREEK': 'Grek', 'GEORGIAN': 'Geor', 'ARMENIAN': 'Armn'}
            names = [unicodedata.name(c, '') for c in case['text'] if unicodedata.category(c).startswith('L')]
            for name, script in script_names.items():
                if sum(name in value for value in names) > len(names) / 2:
                    lang = next((code for code in candidates if code.endswith('_' + script)), None)
                    break
        path = directory / result['wav']
        if hashlib.sha256(path.read_bytes()).hexdigest() != result['wavSha256']:
            raise ValueError(f'Stale WAV in strong review: {result["code"]}')
        try:
            text = pipeline.transcribe([str(path)], lang=[lang], batch_size=1)[0]
            expected = normalize(case['text'])
            edits = distance(expected, normalize(text))
            result['strongRecognition'] = {'model': model, 'languageHint': lang, 'transcript': text,
                                            'expectedCharacters': len(expected), 'edits': edits,
                                            'cer': edits / max(1, len(expected))}
            result['ctcStatus'] = result['status']
            if result['status'] == 'review-transcript' and result['strongRecognition']['cer'] <= .10 and case.get('referenceKind') != 'phonetic-numeral':
                result['status'] = 'automatic-sample-pass'
            atomic_json(target, result)
            reviewed += 1
            summarize(directory)
            print(json.dumps({'strongReviewed': reviewed, 'code': result['code'], 'status': result['status'],
                              'ctcCer': result['recognition']['cer'], 'strongCer': result['strongRecognition']['cer']}), flush=True)
        except Exception as error:
            result['strongRecognitionError'] = str(error)
            atomic_json(target, result)
            print(json.dumps({'code': result['code'], 'strongRecognitionError': str(error)}), flush=True)
    summarize(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'artifacts/omnivoice-language-audit')
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--device', default='cpu', choices=['cpu', 'cuda'])
    parser.add_argument('--strong-review', action='store_true', help='After capture: recheck flagged WAVs using 7B LLM ASR on the GPU.')
    args = parser.parse_args()
    directory = args.directory
    if args.strong_review:
        strong_review(directory, args.watch)
        return
    (directory / 'analysis').mkdir(parents=True, exist_ok=True)
    corpus = {item['code']: item for item in json.loads((directory / 'corpus.json').read_text(encoding='utf-8'))['languages']}
    torch.set_num_threads(4)
    pipeline = ASRInferencePipeline(model_card=MODEL, device=args.device,
                                    dtype=torch.float32 if args.device == 'cpu' else torch.bfloat16)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    dns_path = dnsmos_model()
    session = ort.InferenceSession(str(dns_path), sess_options=options, providers=['CPUExecutionProvider'])
    environment = {'model': MODEL, 'torch': torch.__version__,
                'device': args.device, 'onnxruntime': ort.__version__, 'dnsmosSha256': hashlib.sha256(dns_path.read_bytes()).hexdigest(),
                'supportedAsrLanguages': len(supported_langs), 'normalizerVersion': NORMALIZER_VERSION}
    atomic_json(directory / 'analysis-environment.json', environment)
    atomic_json(directory / f'analysis-environment-{args.device}.json', environment)
    last_progress = time.monotonic()
    supported = {code.split('_')[0] for code in supported_langs}
    while True:
        corpus = {item['code']: item for item in json.loads((directory / 'corpus.json').read_text(encoding='utf-8'))['languages']}
        changed = False
        for record in sorted((directory / 'records').glob('*.json')):
            try:
                item = json.loads(record.read_text(encoding='utf-8'))
            except json.JSONDecodeError:
                continue
            if item['nativeText'] and item['text'] != corpus[item['code']]['text']:
                continue
            target = directory / 'analysis' / record.name
            if target.is_file():
                previous = json.loads(target.read_text(encoding='utf-8'))
                if previous.get('analysisVersion') == ANALYSIS_VERSION and previous.get('wavSha256') == item.get('wavSha256') and previous.get('requestSha256') == item['requestSha256']:
                    continue
            result = {key: item.get(key) for key in ['code', 'name', 'iso', 'nativeText', 'text', 'source', 'sourceUrl', 'wav', 'wavSha256', 'requestSha256']}
            result['analysisVersion'] = ANALYSIS_VERSION
            result['recognizer'] = {'model': MODEL, 'device': args.device,
                                    'dtype': 'float32' if args.device == 'cpu' else 'bfloat16'}
            result['status'] = 'synthesis-failed'
            if item.get('wav'):
                path = directory / item['wav']
                try:
                    if hashlib.sha256(path.read_bytes()).hexdigest() != item['wavSha256']:
                        raise ValueError('WAV hash differs from browser capture')
                    result['signal'] = signal_scores(path, session)
                    result['recognition'] = transcribe(pipeline, path, item['text'])
                    result['asrLanguageListed'] = item['iso'] in supported or corpus[item['code']].get('sourceIso') in supported
                    if not item['nativeText']:
                        result['status'] = 'signal-only-no-native-reference'
                    elif result['signal']['physicalFailure']:
                        result['status'] = 'signal-failed'
                    elif result['signal']['acousticReview']:
                        result['status'] = 'review-acoustics'
                    elif corpus[item['code']].get('referenceKind') == 'phonetic-numeral':
                        result['status'] = 'unverified-phonetic-reference'
                    elif result['recognition']['cer'] > .10:
                        result['status'] = 'review-transcript'
                    else:
                        result['status'] = 'automatic-sample-pass'
                    if item['nativeText'] and result['recognition']['cer'] > .10:
                        try:
                            baseline = reference_check(pipeline, corpus[item['code']], directory)
                            if baseline:
                                result['nativeReferenceRecognition'] = baseline
                                if baseline['cer'] > .10:
                                    result['asrBaselineLimited'] = True
                        except Exception as error:
                            result['nativeReferenceError'] = str(error)
                except Exception as error:
                    result['status'] = 'analysis-error'
                    result['error'] = str(error)
            atomic_json(target, result)
            changed = True
            last_progress = time.monotonic()
            counts = summarize(directory)
            print(json.dumps({'analyzed': sum(counts.values()), 'code': item['code'], 'status': result['status'],
                              'cer': result.get('recognition', {}).get('cer'), 'counts': counts}), flush=True)
        completed = len(list((directory / 'analysis').glob('*.json')))
        if not args.watch or completed == 646:
            break
        if not changed:
            if time.monotonic() - last_progress > 600:
                raise TimeoutError('No new browser recordings for ten minutes; analysis checkpoints were saved.')
            time.sleep(2)
    summarize(directory)


if __name__ == '__main__':
    assert distance('abc', 'axc') == 1 and distance('', 'abc') == 3
    assert normalize('Å, a\u030a!') == 'åå'
    main()
