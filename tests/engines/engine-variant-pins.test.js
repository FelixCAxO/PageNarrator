import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { engineVariantPins } from '../../tooling/scripts/lib/engine-source-pins.mjs';

const digest = source => createHash('sha256').update(source).digest('hex');
const sources = new Map([['/src/engines/kernel.js', 'original kernel']]);
const candidate = { 'src/engines/kernel.js': digest('optimized kernel') };

it('records the baseline bytes served to both arms of an A/A control', () => {
  expect(engineVariantPins(sources, candidate, { control: true })).toEqual({
    '/src/engines/kernel.js': { baseline: digest('original kernel'), candidate: digest('original kernel') },
  });
});

it('records distinct baseline and candidate bytes for A/B', () => {
  expect(engineVariantPins(sources, candidate)).toEqual({
    '/src/engines/kernel.js': { baseline: digest('original kernel'), candidate: digest('optimized kernel') },
  });
});
