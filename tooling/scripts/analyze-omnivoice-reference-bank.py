"""Watch generated native-language reference candidates; retain every diagnostic and failure."""
import argparse
import hashlib
import importlib.util
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from faster_whisper import WhisperModel
from scipy.signal import resample_poly
from transformers import ClapModel, ClapProcessor, WavLMForXVector

spec = importlib.util.spec_from_file_location('voice_analysis', Path(__file__).with_name('analyze-omnivoice-variations.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--references', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--asr-model', type=Path, required=True)
parser.add_argument('--shard', default='0/1')
parser.add_argument('--watch', action='store_true')
parser.add_argument('--no-asr', action='store_true', help='Leave transcription explicitly unverified for a separate independent recognizer.')
args = parser.parse_args()
index, count = map(int, args.shard.split('/'))
if not 0 <= index < count:
    raise ValueError('Expected INDEX/COUNT with 0 <= INDEX < COUNT')
args.output.mkdir(parents=True, exist_ok=True)
target = args.output / f'reference-analysis-{index}.json'
rows = {item['id']: item for item in json.loads(target.read_text(encoding='utf8'))} if target.exists() else {}
torch.set_num_threads(2)
asr = None if args.no_asr else WhisperModel(str(args.asr_model), device='cpu', compute_type='int8', cpu_threads=2, local_files_only=True)
speaker_model = WavLMForXVector.from_pretrained('microsoft/wavlm-base-plus-sv', revision=helpers.SPEAKER_REVISION,
                                              cache_dir='.cache/speaker-verification', local_files_only=True).eval()
style_revision = '8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a'
style_options = dict(revision=style_revision, cache_dir='.cache/settings-oracles', local_files_only=True)
style_model = ClapModel.from_pretrained('laion/clap-htsat-unfused', **style_options).eval()
processor = ClapProcessor.from_pretrained('laion/clap-htsat-unfused', **style_options)
dns_path = Path('.cache/omnivoice-language-audit/dnsmos/sig_bak_ovr.onnx')
if hashlib.sha256(dns_path.read_bytes()).hexdigest() != helpers.DNSMOS_SHA256:
    raise ValueError('DNSMOS model hash differs')
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
dns = ort.InferenceSession(str(dns_path), sess_options=options, providers=['CPUExecutionProvider'])
helpers.atomic_json(args.output / f'environment-{index}.json', {
    'scope': __doc__, 'asrDevice': 'cpu', 'asrFiles': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in args.asr_model.iterdir() if p.is_file()},
    'speakerRevision': helpers.SPEAKER_REVISION, 'styleRevision': style_revision, 'dnsmosSha256': helpers.DNSMOS_SHA256,
    'nativeListening': 'unverified', 'transcriptionRun': not args.no_asr})
last_progress = time.monotonic()


def read_pool(path):
    # Windows can briefly deny reads while the generator atomically replaces this file.
    for attempt in range(20):
        try:
            return json.loads(path.read_text(encoding='utf8'))['speakers'] if path.exists() else []
        except (PermissionError, FileNotFoundError):
            if attempt == 19:
                raise
            time.sleep(.1)


while True:
    pool_path = args.references / 'speakers.json'
    pool = read_pool(pool_path)
    assigned = [speaker for i, speaker in enumerate(pool) if i % count == index]
    for speaker in assigned:
        cached = rows.get(speaker['id'], {})
        path = args.references / (speaker['id'] + '.wav')
        wav_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if cached.get('speakerHash') == speaker['hash'] and cached.get('text') == speaker['text'] and cached.get('wavSha256') == wav_hash and (args.no_asr or 'cer' in cached.get('recognition', {})):
            continue
        pcm = helpers.load_audio(path)
        row = dict(id=speaker['id'], lang=speaker['lang'], text=speaker['text'], speakerHash=speaker['hash'],
                   wavSha256=wav_hash, nativeListening='unverified')
        row['signal'] = helpers.signal_scores(pcm, dns)
        row['recognition'] = dict(status='not-run')
        if asr is not None:
            segments, _ = asr.transcribe(str(path), language={'arb': 'ar'}.get(speaker['lang'], speaker['lang']),
                                         beam_size=3, temperature=0, vad_filter=False, condition_on_previous_text=False,
                                         without_timestamps=True, max_new_tokens=128)
            transcript = ' '.join(segment.text.strip() for segment in segments)
            expected, actual = helpers.normalize(speaker['text']), helpers.normalize(transcript)
            edits = helpers.distance(expected, actual)
            row['recognition'] = dict(transcript=transcript, expectedCharacters=len(expected), edits=edits, cer=edits/max(1, len(expected)))
        samples = resample_poly(pcm, 2, 3).astype(np.float32)
        samples = (samples - samples.mean()) / np.sqrt(samples.var() + 1e-7)
        with torch.inference_mode():
            vector = speaker_model(torch.from_numpy(samples[None, :])).embeddings[0].numpy()
        row['embedding'] = (vector / np.linalg.norm(vector)).tolist()
        inputs = processor(text=['A woman is speaking.', 'A man is speaking.', 'A person is whispering.', 'A person is speaking normally.'], audio=resample_poly(pcm, 2, 1),
                           sampling_rate=48000, return_tensors='pt', padding=True)
        with torch.inference_mode():
            female, male, whisper, normal = style_model(**inputs).logits_per_audio[0].tolist()
        if not np.isfinite([female, male, whisper, normal]).all():
            raise ValueError('Non-finite reference-style scores')
        row['style'] = dict(femaleScore=female, maleScore=male, whisperScore=whisper, normalScore=normal, whisperMargin=whisper-normal, expected=speaker['gender'],
                            expectedMargin=(female-male)*(1 if speaker['gender']=='female' else -1))
        rows[speaker['id']] = row
        helpers.atomic_json(target, list(rows.values()))
        last_progress = time.monotonic()
        print(json.dumps(dict(id=speaker['id'], cer=row['recognition'].get('cer'), overall=row['signal']['dnsmos']['overall'], styleMargin=row['style']['expectedMargin'], whisperMargin=whisper-normal)), flush=True)
    generation = args.references / 'generation.json'
    complete = generation.exists() and json.loads(generation.read_text(encoding='utf8')).get('status') == 'complete'
    # Generation may finish after this iteration's snapshot; include its last appended samples.
    latest_assigned = [speaker for i, speaker in enumerate(read_pool(pool_path)) if i % count == index]
    if not args.watch or (complete and all(rows.get(speaker['id'], {}).get('speakerHash') == speaker['hash'] for speaker in latest_assigned)):
        break
    if time.monotonic()-last_progress > 600:
        raise TimeoutError('No new reference for ten minutes; checkpoints retained')
    time.sleep(2)
