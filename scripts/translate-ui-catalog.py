"""Development-only local translation drafting. No model or Python dependency is packaged."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import json
import re
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--batch-size', type=int, default=12)
    args = parser.parse_args()
    import torch
    from transformers import M2M100ForConditionalGeneration, M2M100Tokenizer
    torch.set_num_threads(4)
    tokenizer = M2M100Tokenizer.from_pretrained(args.model, src_lang='en', local_files_only=True)
    model = M2M100ForConditionalGeneration.from_pretrained(args.model, local_files_only=True,
                                                          torch_dtype=torch.float16).to('cuda').eval()
    source = json.loads((args.root / '_locales/en/messages.json').read_text(encoding='utf-8'))
    rollout = json.loads((args.root / 'config/language-rollout.json').read_text(encoding='utf-8'))
    cache_dir = args.root / 'artifacts/ui-translations/drafts'
    cache_dir.mkdir(parents=True, exist_ok=True)
    # Preserve brands and substitutions exactly; distinct numeric sentinels survive tokenization.
    brands = ['PageNarrator', 'OmniVoice', 'Kokoro', 'Hugging Face', 'WebAssembly', 'WebGPU']
    prepared = []
    for key, entry in source.items():
        text = entry['message']
        mapping = []
        pattern = r'\$[a-zA-Z][a-zA-Z0-9_]*\$|' + '|'.join(re.escape(brand) for brand in brands)
        def protect(match):
            marker = str(98761001 + len(mapping))
            mapping.append((marker, match.group()))
            return marker
        text = re.sub(pattern, protect, text)
        prepared.append((key, text, mapping))
    for language in rollout['languages']:
        if language['code'] == 'en':
            continue
        output = cache_dir / (language['code'] + '.json')
        previous = json.loads(output.read_text(encoding='utf-8')) if output.is_file() else {}
        result = dict(previous)
        missing = [(key, text, mapping) for key, text, mapping in prepared if key not in result or result[key].get('errors')]
        for offset in range(0, len(missing), args.batch_size):
            batch = missing[offset:offset + args.batch_size]
            encoded = tokenizer([item[1] for item in batch], return_tensors='pt', padding=True, truncation=False).to('cuda')
            with torch.inference_mode():
                generated = model.generate(**encoded, forced_bos_token_id=tokenizer.get_lang_id(language['code']), num_beams=4, max_new_tokens=256)
            translated = tokenizer.batch_decode(generated, skip_special_tokens=True)
            for (key, original, mapping), text in zip(batch, translated):
                errors = []
                for marker, value in mapping:
                    pattern = r'[\s,.\u00a0]*'.join(marker)
                    if not re.search(pattern, text):
                        errors.append(f'Missing protected token: {value}')
                    else:
                        text = re.sub(pattern, lambda match: value, text, count=1)
                result[key] = {'message': text, 'errors': errors}
            temporary = output.with_suffix('.tmp')
            temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            temporary.replace(output)
        print(json.dumps({'language': language['code'], 'translated': len(missing), 'remainingTokenErrors': sum(bool(item.get('errors')) for item in result.values())}), flush=True)
    print('Local translation drafting complete.', flush=True)


if __name__ == '__main__':
    main()
