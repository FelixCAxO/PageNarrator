// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEnglishPhonemizer } from '../../src/tts/kokoro/english-phonemizer.js';

const wasmBinary = readFileSync('public/assets/phonemizer/english.wasm');
const pronunciationData = readFileSync('public/assets/phonemizer/pronunciations.bin');

describe.each(['en-us', 'en-gb', 'en'])('read context through the actual native phonemizer in %s', dialect => {
  it('preserves contextual cache separation, perfect verbs and nominal permissions', async () => {
    const engine = await createEnglishPhonemizer({ wasmBinary, pronunciationData });
    try {
      for (const [source, expected] of [
        ['They have just read the note.', 'ɹˈɛd'],
        ['They will just read the note.', 'ɹˈiːd'],
        ['These accounts have only read access.', 'ɹˈiːd'],
        ['These accounts have not only read and write permissions.', 'ɹˈiːd'],
        ['They have already read access logs.', 'ɹˈɛd'],
        ['They have just read the note.', 'ɹˈɛd'],
      ]) {
        const phones = await engine.phonemizeText(source, dialect);
        expect(phones.split(' ').filter(phone => /^ɹˈ(?:ɛ|iː)d$/u.test(phone)), source).toEqual([expected]);
      }
      expect(engine.diagnostics().cache).toBeGreaterThan(0);
    } finally { engine.dispose(); }
    expect(engine.diagnostics().cachedWords).toBe(0);
    expect(engine.diagnostics().nativeMemoryBytes).toBe(0);
  });
});
