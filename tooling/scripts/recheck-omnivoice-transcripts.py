"""Independent OmniASR second opinion for retained voice diagnostics; no target text is fed to ASR."""
import argparse
import hashlib
import json
from pathlib import Path
import unicodedata
import time

import torch
from fairseq2.models.hub import load_model
from fairseq2.data.tokenizers.hub import load_tokenizer
from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline


def normalize(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold()
                   if unicodedata.category(c)[0] in 'LMN' and not '\u064b' <= c <= '\u065f')


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(current[-1] + 1, row[j] + 1, row[j - 1] + (x != y)))
        row = current
    return row[-1]


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--plan', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--model', default='omniASR_LLM_7B_v2', choices=['omniASR_LLM_7B_v2', 'omniASR_CTC_1B_v2'])
parser.add_argument('--device', default='cuda', choices=['cuda', 'cpu'])
parser.add_argument('--watch', action='store_true', help='Read appended plan jobs until its complete flag is true.')
args = parser.parse_args()
jobs = json.loads(args.plan.read_text(encoding='utf8'))['jobs']
args.output.parent.mkdir(parents=True, exist_ok=True)
rows = json.loads(args.output.read_text(encoding='utf8'))['results'] if args.output.exists() else []
torch.set_num_threads(4)
dtype = torch.bfloat16 if args.device == 'cuda' else torch.float32
loaded = load_model(args.model, device=torch.device(args.device), dtype=dtype, mmap=True)
pipeline = ASRInferencePipeline(model_card=None, model=loaded, tokenizer=load_tokenizer(args.model), device=args.device, dtype=dtype)
last_progress = time.monotonic()
while True:
    plan = json.loads(args.plan.read_text(encoding='utf8'))
    for job in plan['jobs']:
        path = Path(job['wav'])
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if any(row['id'] == job['id'] and row['wavSha256'] == digest and row['text'] == job['text'] for row in rows):
            continue
        transcript = pipeline.transcribe([str(path)], lang=[job['language']], batch_size=1)[0]
        expected, actual = normalize(job['text']), normalize(transcript)
        edits = distance(expected, actual)
        row = dict(id=job['id'], wavSha256=digest, model=args.model, device=args.device, dtype=str(dtype), language=job['language'],
                   text=job['text'], transcript=transcript, edits=edits, cer=edits/max(1, len(expected)))
        rows = [r for r in rows if r['id'] != job['id']] + [row]
        temporary = args.output.with_suffix('.tmp')
        temporary.write_text(json.dumps(dict(model=args.model, conditioning='Audio and language ID only', results=rows), ensure_ascii=False, indent=2), encoding='utf8')
        temporary.replace(args.output)
        last_progress = time.monotonic()
        print(json.dumps(row, ensure_ascii=False), flush=True)
    if not args.watch or plan.get('complete'):
        break
    if time.monotonic() - last_progress > 1800:
        raise TimeoutError('No appended recognition jobs for thirty minutes; checkpoints retained.')
    time.sleep(5)
