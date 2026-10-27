"""Local screening of fixed voice presets; no automated native-listening approval."""
import argparse
import hashlib
import json
import math
import os
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from faster_whisper import WhisperModel
from scipy.signal import resample_poly
from transformers import WavLMForXVector, ClapModel, ClapProcessor

ROOT = Path(__file__).resolve().parent.parent
DNSMOS_SHA256 = '269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd'
SPEAKER_REVISION = 'feb593a6c23c1cc3d9510425c29b0a14d2b07b1e'


def normalize(text):
    text = unicodedata.normalize('NFKC', text).casefold()
    return ''.join(c for c in text if unicodedata.category(c)[0] in 'LMN' and not '\u064b' <= c <= '\u065f')


def distance(left, right):
    row = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, row[j] + 1, row[j - 1] + (a != b)))
        row = current
    return row[-1]


def load_audio(path):
    with wave.open(str(path), 'rb') as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 24000):
            raise ValueError('Expected mono 16-bit 24 kHz WAV')
        pcm = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768
    if not len(pcm) or not np.isfinite(pcm).all():
        raise ValueError('Empty or non-finite audio')
    return pcm


def signal_scores(pcm, session):
    energy = float(np.mean(pcm ** 2))
    clipping = float(np.mean(np.abs(pcm) >= .999))
    crossings = float(np.mean(pcm[1:] * pcm[:-1] < 0))
    difference = float(np.mean(np.diff(pcm) ** 2) / max(energy, 1e-20))
    audio = resample_poly(pcm, 2, 3).astype(np.float32)
    length = 144160
    while len(audio) < length:
        audio = np.concatenate([audio, audio])
    scores = []
    for start in range(0, len(audio) - length + 1, 16000):
        sig, bak, overall = session.run(None, {'input_1': audio[start:start + length][None, :]})[0][0]
        scores.append([np.polyval([-.08397278, 1.22083953, .0052439], sig),
                       np.polyval([-.13166888, 1.60915514, -.39604546], bak),
                       np.polyval([-.06766283, 1.11546468, .04602535], overall)])
    sig, bak, overall = map(float, np.mean(scores, axis=0))
    return {'seconds': len(pcm) / 24000, 'rms': math.sqrt(energy), 'clippedFraction': clipping,
            'zeroCrossingRate': crossings, 'differenceEnergyRatio': difference,
            'physicalFailure': energy < 1e-10 or (crossings > .35 and difference > 1.5) or clipping > .2,
            'dnsmos': {'speech': sig, 'background': bak, 'overall': overall},
            'acousticReview': sig < 2.5 or bak < 2 or overall < 2.5}


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'artifacts/omnivoice-fixed-voices/quality-native-v1')
    parser.add_argument('--asr-model', type=Path, required=True)
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--device', choices=['cpu','cuda'], default='cpu')
    parser.add_argument('--reference-directory', type=Path, default=ROOT / 'artifacts/omnivoice-fixed-voices/reference-selected-native-v1')
    parser.add_argument('--references-only', action='store_true')
    parser.add_argument('--reference-analysis', type=Path)
    parser.add_argument('--analysis-directory', type=Path)
    parser.add_argument('--shard', default='0/1')
    parser.add_argument('--no-asr', action='store_true', help='Require separately bound independent recognition before passing a sample.')
    args = parser.parse_args()
    directory = args.directory
    analysis = args.analysis_directory or directory / 'analysis'
    shard_index, shard_count = map(int,args.shard.split('/'))
    if not 0 <= shard_index < shard_count:
        raise ValueError('Expected --shard=INDEX/COUNT with 0 <= INDEX < COUNT')
    metadata = directory / f'metadata-{analysis.name}-{shard_index}' if shard_count > 1 else directory
    metadata.mkdir(parents=True,exist_ok=True)
    analysis.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(2)
    if args.device == 'cuda' and os.name == 'nt':
        dll_directory = os.add_dll_directory(str(Path(torch.__file__).parent / 'lib'))
    asr = None if args.no_asr else WhisperModel(str(args.asr_model), device=args.device, compute_type='float16' if args.device == 'cuda' else 'int8', cpu_threads=2, local_files_only=True)
    style_revision = '8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a'
    style_options = dict(revision=style_revision, cache_dir=str(ROOT / '.cache/settings-oracles'), local_files_only=True)
    style_model = ClapModel.from_pretrained('laion/clap-htsat-unfused', **style_options).eval()
    style_processor = ClapProcessor.from_pretrained('laion/clap-htsat-unfused', **style_options)
    speaker_model = WavLMForXVector.from_pretrained('microsoft/wavlm-base-plus-sv', revision=SPEAKER_REVISION,
                                                  cache_dir=str(ROOT / '.cache/speaker-verification'), local_files_only=True).eval()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    dns_path = ROOT / '.cache/omnivoice-language-audit/dnsmos/sig_bak_ovr.onnx'
    if hashlib.sha256(dns_path.read_bytes()).hexdigest() != DNSMOS_SHA256:
        raise ValueError('DNSMOS model hash differs')
    dns = ort.InferenceSession(str(dns_path), sess_options=options, providers=['CPUExecutionProvider'])

    def embedding(pcm):
        samples = resample_poly(pcm, 2, 3).astype(np.float32)
        samples = (samples - samples.mean()) / np.sqrt(samples.var() + 1e-7)
        with torch.inference_mode():
            value = speaker_model(torch.from_numpy(samples[None, :])).embeddings[0].numpy()
        return value / np.linalg.norm(value)

    def recognition(path, text, language):
        if asr is None:
            return {'status': 'not-run'}
        code = {'arb': 'ar', 'no': 'no'}.get(language, language)
        segments, _ = asr.transcribe(str(path), language=code, beam_size=3, temperature=0,
                                     vad_filter=False, condition_on_previous_text=False)
        transcript = ' '.join(s.text.strip() for s in segments)
        expected, actual = normalize(text), normalize(transcript)
        edits = distance(expected, actual)
        return {'transcript': transcript, 'expectedCharacters': len(expected), 'edits': edits,
                'cer': edits / max(1, len(expected))}

    reference_root = args.reference_directory
    references = json.loads((reference_root / 'speakers.json').read_text(encoding='utf8'))
    reference_cache = json.loads(args.reference_analysis.read_text(encoding='utf8')) if args.reference_analysis else []
    vectors, reference_results = {}, []
    for speaker in references['speakers']:
        path = reference_root / f'{speaker["id"]}.wav'
        pcm = load_audio(path)
        wav_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        cached = next((item for item in reference_cache if item['speakerHash']==speaker['hash'] and item['wavSha256']==wav_hash),None)
        if cached:
            vectors[speaker['id']] = np.asarray(cached['embedding'],dtype=np.float32)
            reference_results.append({**cached,'id':speaker['id'],'cachedFrom':str(args.reference_analysis)})
        else:
            vectors[speaker['id']] = embedding(pcm)
            reference_results.append({'id': speaker['id'], 'speakerHash': speaker['hash'], 'wavSha256':wav_hash,
                                      'embedding':vectors[speaker['id']].tolist(),
                                      'signal': signal_scores(pcm, dns), 'recognition': recognition(path, speaker.get('text') or references['text'], speaker.get('lang','en'))})
        print(json.dumps({'reference': speaker['id'], 'cer': reference_results[-1]['recognition'].get('cer')}), flush=True)
    atomic_json(metadata / 'reference-analysis.json', reference_results)
    atomic_json(metadata / 'analysis-environment.json', {
        'asr': None if args.no_asr else 'faster-whisper-large-v3-turbo', 'asrModelFiles': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in args.asr_model.iterdir() if p.is_file()},
        'styleRevision': style_revision,
        'speakerModel': 'microsoft/wavlm-base-plus-sv', 'speakerRevision': SPEAKER_REVISION,
        'dnsmosSha256': DNSMOS_SHA256, 'device': args.device, 'torch': torch.__version__,
        'scope': 'Automated development screening. Native listening, cross-device identity and performance qualification remain unverified.'})
    if args.references_only:
        return
    corpus = json.loads((directory / 'corpus.json').read_text(encoding='utf8'))['languages']
    assigned = {item['id'] for i,item in enumerate(corpus) if i % shard_count == shard_index}
    last_progress = time.monotonic()
    while True:
        for path in sorted((directory / 'records').glob('*.json')):
            record = json.loads(path.read_text(encoding='utf8'))
            if record['id'] not in assigned:
                continue
            target = analysis / path.name
            if record['status'] == 'unsupported-whisper':
                atomic_json(target, {key:record[key] for key in ['id','code','status','workerSha256','requestSha256']})
                continue
            if target.exists():
                old = json.loads(target.read_text(encoding='utf8'))
                if old.get('wavSha256') == record.get('wavSha256') and old.get('requestSha256') == record['requestSha256'] and old.get('asrDevice') == args.device and old.get('style') and (args.no_asr or 'cer' in old.get('recognition', {})):
                    continue
            result = {'id': record['id'], 'code': record['code'], 'text': record['text'], 'wav': record.get('wav'),
                      'wavSha256': record.get('wavSha256'), 'requestSha256': record['requestSha256'], 'workerSha256': record['workerSha256'],
                      'speakerId': record['request']['speakerId'], 'asrDevice':args.device,'nativeListening': 'unverified', 'status': 'synthesis-failed'}
            try:
                if record.get('wav'):
                    wav = directory / record['wav']
                    if hashlib.sha256(wav.read_bytes()).hexdigest() != record['wavSha256']:
                        raise ValueError('WAV hash differs from captured record')
                    pcm = load_audio(wav)
                    result['signal'] = signal_scores(pcm, dns)
                    result['recognition'] = recognition(wav, record['text'], record['code'])
                    inputs = style_processor(text=['A person is whispering.', 'A person is speaking normally.'],
                        audio=resample_poly(pcm, 2, 1), sampling_rate=48000, return_tensors='pt', padding=True)
                    with torch.inference_mode():
                        whisper, normal = style_model(**inputs).logits_per_audio[0].tolist()
                    if not np.isfinite([whisper, normal]).all():
                        raise ValueError('Non-finite style scores')
                    result['style'] = dict(whisperScore=whisper, normalScore=normal, whisperMargin=whisper-normal)
                    value = embedding(pcm)
                    actual_speaker = next(attempt['speaker'] for attempt in record['attempts'] if attempt.get('speaker'))
                    reference_id = actual_speaker.get('referenceId') or result['speakerId']
                    reference_language = next(speaker.get('lang','en') for speaker in references['speakers'] if speaker['id']==reference_id)
                    allowed = {speaker['id'] for speaker in references['speakers'] if speaker.get('lang','en')==reference_language}
                    similarities = sorted(((id, float(value @ vector)) for id, vector in vectors.items() if id in allowed), key=lambda pair: -pair[1])
                    result['identityDiagnostic'] = {'referenceId':reference_id,'expectedCosine': dict(similarities)[reference_id],
                                                    'nearestPreset': similarities[0][0], 'nearestCosine': similarities[0][1]}
                    if result['signal']['physicalFailure']:
                        result['status'] = 'signal-failed'
                    elif result['signal']['acousticReview'] and not record['request'].get('whisper'):
                        result['status'] = 'review-acoustics'
                    elif 'cer' not in result['recognition']:
                        result['status'] = 'awaiting-independent-recognition'
                    elif result['recognition']['cer'] > .10:
                        result['status'] = 'review-transcript'
                    elif record['request'].get('whisper') and result['style']['whisperMargin'] <= 0:
                        result['status'] = 'review-whisper-style'
                    else:
                        result['status'] = 'automatic-sample-pass'
            except Exception as error:
                result['status'] = 'analysis-error'
                result['error'] = str(error)
            atomic_json(target, result)
            last_progress = time.monotonic()
            print(json.dumps({'id': record['id'], 'status': result['status'], 'cer': result.get('recognition', {}).get('cer')}), flush=True)
        count = sum(path.stem in assigned for path in analysis.glob('*.json'))
        if not args.watch or count == len(assigned):
            break
        if time.monotonic() - last_progress > 600:
            raise TimeoutError('No capture progress for ten minutes; analysis checkpoints are saved')
        time.sleep(2)


if __name__ == '__main__':
    assert distance('abc', 'axc') == 1 and distance('', 'abc') == 3
    assert normalize('Å a\u030a') == 'åå'
    main()
