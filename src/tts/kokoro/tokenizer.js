// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { KOKORO_PHONEMES } from './phoneme-vocabulary.js';

/** The pinned Kokoro model uses characters, not a Transformers/BPE runtime.
 * @param {any} model @param {any} config */
export function createKokoroTokenizer(model, config) {
  const vocab = model?.model?.vocab;
  if (!vocab || Object.keys(vocab).length !== Object.keys(KOKORO_PHONEMES).length
    || Object.entries(KOKORO_PHONEMES).some(([phone, id]) => vocab[phone] !== id)
    || config?.model_max_length !== 512 || config.pad_token !== '$' || config.unk_token !== '$'
    || model?.normalizer?.type !== 'Replace' || model.normalizer.content !== ''
    || model.normalizer.pattern?.Regex !== `[^${Object.keys(KOKORO_PHONEMES).join('')}]`
    || model?.pre_tokenizer?.type !== 'Split' || model.pre_tokenizer.pattern?.Regex !== ''
    || model.pre_tokenizer.behavior !== 'Isolated' || model.pre_tokenizer.invert !== false
    || model?.added_tokens?.length || model?.decoder !== null
    || model?.post_processor?.type !== 'TemplateProcessing' || JSON.stringify(model?.post_processor?.single) !== JSON.stringify([
      { SpecialToken: { id: '$', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, { SpecialToken: { id: '$', type_id: 0 } },
    ]) || model.post_processor.special_tokens?.$?.ids?.join(',') !== '0'
    || model.post_processor.special_tokens?.$?.tokens?.join('') !== '$') throw new Error('Unsupported Kokoro tokenizer data.');

  /** @param {string} text @param {{truncation?: boolean, strict?: boolean}} [options] */
  function encode(text, { truncation = false, strict = false } = {}) {
    if (typeof text !== 'string' || text.length > 16_384) throw new RangeError('Kokoro phoneme input is invalid or too long.');
    const result = [0];
    for (const phone of text) {
      if (Object.hasOwn(vocab, phone)) result.push(vocab[phone]);
      else if (strict) throw new Error(`Kokoro does not support phoneme ${phone}.`);
    }
    result.push(0);
    if (result.length > 512) {
      if (!truncation) throw new RangeError('Kokoro phoneme sequence exceeds 512 IDs; split the text.');
      result.length = 512; result[511] = 0;
    }
    return BigInt64Array.from(result, BigInt);
  }
  const tokenizer = (/** @type {string} */ text, options = {}) => ({ input_ids: encode(text, options) });
  tokenizer.encode = encode;
  tokenizer.model_max_length = 512;
  tokenizer.dispose = () => {};
  return tokenizer;
}
