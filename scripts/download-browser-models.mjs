// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { downloadTestModels } from './download-test-models.mjs';
import manifest from '../tests/fixtures/browser-speech-models.json' with { type: 'json' };

const groups = { '--tokenizer': file => file.path.startsWith('tokenizer'),
  '--decoder': file => file.path === 'omnivoice-decoder-webgpu.onnx', '--graphs': file => !file.path.endsWith('_data'), '--speech': () => true };
const flags = process.argv.slice(2);
if (flags.length !== 1 || !Object.hasOwn(groups, flags[0])) throw new Error('Usage: node scripts/download-browser-models.mjs --tokenizer|--decoder|--graphs|--speech');
const fixtures = { ...manifest, files: manifest.files.filter(groups[flags[0]]) };
const result = await downloadTestModels({ fixtures, root: process.env.PN_BROWSER_MODEL_DIR || '.cache/engine-models' });
console.log(`Verified ${result.files} pinned browser model files (${result.downloaded} downloaded): ${result.directory}`);
