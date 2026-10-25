// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original byte-pair encoder. Vocabulary and merge ranks are licensed model data.
const MODEL_PATTERN = String.raw`(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`;
// The downloaded pattern must match the supported format; it is never executed.
const WORDS = /'(?:s|t|re|ve|m|ll|d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu;
const encoder = new TextEncoder();
let extended = 256;
const BYTE_ALPHABET = Array.from({ length: 256 }, (_, byte) => String.fromCodePoint(
  (byte >= 33 && byte <= 126) || (byte >= 161 && byte <= 172) || byte >= 174 ? byte : extended++));
const pairKey = (a, b) => `${a}\0${b}`;

class MergeHeap {
  constructor() { this.items = []; }
  before(a, b) { return a.rank < b.rank || (a.rank === b.rank && a.left < b.left); }
  push(item) {
    let i = this.items.length;
    this.items.push(item);
    while (i) {
      const parent = (i - 1) >> 1;
      if (!this.before(item, this.items[parent])) break;
      this.items[i] = this.items[parent]; i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0], last = this.items.pop();
    if (!this.items.length) return first;
    let i = 0;
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.items.length && this.before(this.items[child + 1], this.items[child])) child++;
      if (!this.before(this.items[child], last)) break;
      this.items[i] = this.items[child]; i = child;
    }
    this.items[i] = last;
    return first;
  }
}

export class BytePairTokenizer {
  constructor(json, config = {}) {
    const model = json?.model, [split, byteLevel] = json?.pre_tokenizer?.pretokenizers ?? [];
    if (model?.type !== 'BPE' || model.dropout || model.unk_token || model.continuing_subword_prefix
      || model.end_of_word_suffix || model.fuse_unk || model.byte_fallback || model.ignore_merges
      || json.pre_tokenizer?.type !== 'Sequence' || split?.type !== 'Split' || split.pattern?.Regex !== MODEL_PATTERN
      || split.behavior !== 'Isolated' || split.invert || byteLevel?.type !== 'ByteLevel' || byteLevel.add_prefix_space || byteLevel.use_regex
      || (json.normalizer && json.normalizer.type !== 'NFC') || json.post_processor?.type !== 'ByteLevel'
      || json.padding || json.truncation || config.add_prefix_space || config.bos_token || config.unk_token) {
      throw new Error('Unsupported byte-pair tokenizer configuration.');
    }
    this.normalize = Boolean(json.normalizer);
    /** @type {Map<string, number>} */
    this.vocab = new Map();
    this.ranks = new Map();
    this.special = { children: new Map(), token: null };
    this.cache = new Map();
    const ids = new Set();
    const entries = Object.entries(model.vocab ?? {});
    if (!entries.length || entries.length > 1000000 || !Array.isArray(model.merges) || model.merges.length > 2000000) throw new Error('Invalid byte-pair vocabulary or merge count.');
    for (const [token, id] of entries) {
      if (!token || token.length > 16384 || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id > 0x7fffffff || ids.has(id)) throw new Error('Invalid or duplicate byte-pair vocabulary ID.');
      this.vocab.set(token, id); ids.add(id);
    }
    const available = new Set(BYTE_ALPHABET);
    model.merges.forEach((merge, rank) => {
      const pair = typeof merge === 'string' ? merge.split(' ') : merge;
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(token => typeof token !== 'string' || !token)
        || !this.vocab.has(pair[0]) || !this.vocab.has(pair[1]) || !available.has(pair[0]) || !available.has(pair[1])
        || !this.vocab.has(pair[0] + pair[1]) || this.ranks.has(pairKey(...pair))) throw new Error('Invalid or duplicate byte-pair merge.');
      this.ranks.set(pairKey(...pair), rank);
      available.add(pair[0] + pair[1]);
    });
    if (!Array.isArray(json.added_tokens) || json.added_tokens.length > 10000) throw new Error('Invalid added-token list.');
    const specialIds = new Set();
    for (const token of json.added_tokens) {
      if (typeof token.content !== 'string' || !token.content || token.content.length > 1024 || !Number.isSafeInteger(token.id) || token.id < 0
        || token.id > 0x7fffffff || token.single_word || token.lstrip || token.rstrip || token.normalized || specialIds.has(token.id)
        || (ids.has(token.id) && this.vocab.get(token.content) !== token.id)) throw new Error('Unsupported or duplicate added token.');
      specialIds.add(token.id);
      let branch = this.special;
      for (const char of token.content) {
        if (!branch.children.has(char)) branch.children.set(char, { children: new Map(), token: null });
        branch = branch.children.get(char);
      }
      if (branch.token) throw new Error('Duplicate added-token text.');
      branch.token = token;
    }
  }

  addedAt(text, offset) {
    let branch = this.special, match = null, at = offset;
    while (at < text.length) {
      const char = String.fromCodePoint(text.codePointAt(at));
      branch = branch.children.get(char);
      if (!branch) break;
      at += char.length;
      if (branch.token) match = { id: branch.token.id, end: at };
    }
    return match;
  }

  encode(text, { add_special_tokens = false } = {}) {
    if (typeof text !== 'string') throw new TypeError('Tokenizer input must be a string.');
    if (text.length > 262144) throw new RangeError('Tokenizer input exceeds its bounded text limit.');
    if (add_special_tokens) throw new Error('Automatic special-token insertion is unsupported.');
    const output = [];
    let plainStart = 0, at = 0;
    while (at < text.length) {
      const match = this.addedAt(text, at);
      if (match) {
        this.encodePlain(text.slice(plainStart, at), output); output.push(match.id);
        at = match.end; plainStart = at;
      } else at += text.codePointAt(at) > 0xffff ? 2 : 1;
    }
    this.encodePlain(text.slice(plainStart), output);
    return output;
  }

  encodePlain(text, output) {
    if (this.normalize) text = text.normalize('NFC');
    for (const match of text.matchAll(WORDS)) {
      const piece = match[0];
      let ids = this.cache.get(piece);
      if (ids) { this.cache.delete(piece); this.cache.set(piece, ids); }
      else {
        ids = this.merge(piece);
        if (piece.length <= 256) {
          this.cache.set(piece, ids);
          if (this.cache.size > 2048) this.cache.delete(this.cache.keys().next().value);
        }
      }
      for (const id of ids) output.push(id);
    }
  }

  merge(piece) {
    const parts = Array.from(encoder.encode(piece), byte => BYTE_ALPHABET[byte]);
    const length = parts.length, previous = new Int32Array(length), next = new Int32Array(length);
    const revisions = new Uint32Array(length), alive = new Uint8Array(length).fill(1), heap = new MergeHeap();
    for (let i = 0; i < length; i++) { previous[i] = i - 1; next[i] = i + 1 < length ? i + 1 : -1; }
    const add = left => {
      if (left < 0 || next[left] < 0) return;
      const right = next[left], rank = this.ranks.get(pairKey(parts[left], parts[right]));
      if (rank !== undefined) heap.push({ rank, left, right, lv: revisions[left], rv: revisions[right] });
    };
    for (let i = 0; i < length - 1; i++) add(i);
    while (heap.items.length) {
      const { left, right, lv, rv } = heap.pop();
      if (!alive[left] || !alive[right] || next[left] !== right || revisions[left] !== lv || revisions[right] !== rv) continue;
      parts[left] += parts[right]; revisions[left]++; alive[right] = 0; next[left] = next[right];
      if (next[right] >= 0) previous[next[right]] = left;
      add(previous[left]); add(left);
    }
    const ids = [];
    for (let i = 0; i < length; i = next[i]) {
      const id = this.vocab.get(parts[i]);
      if (id === undefined) throw new Error('Tokenizer vocabulary is missing a byte sequence.');
      ids.push(id);
      if (next[i] < 0) break;
    }
    return ids;
  }
}
