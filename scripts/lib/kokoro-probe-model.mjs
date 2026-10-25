// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyKokoroPhaseCorrection } from '../../src/tts/kokoro/phase-correction.js';

export function kokoroProbeModelMode(args = process.argv.slice(2)) {
  if (args.includes('--unmodified-model') && args.includes('--phase-correction')) {
    throw new Error('Choose the production graph or --unmodified-model, not both.');
  }
  return args.includes('--unmodified-model') ? 'unmodified-model' : 'production';
}

/** Both execution paths must consume these same bytes, including the production phase policy. */
export async function prepareKokoroProbeModel(model, mode = 'production') {
  if (mode === 'unmodified-model') return { bytes: model, mode, phaseCorrection: null };
  if (mode !== 'production') throw new Error('Unknown Kokoro probe model mode.');
  const { bytes, ...phaseCorrection } = await applyKokoroPhaseCorrection(model);
  return { bytes, mode, phaseCorrection };
}

export async function requireNewKokoroProbeReport(file) {
  try { await access(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(dirname(file), { recursive: true });
    return;
  }
  throw new Error(`Preserving existing Kokoro report; select a new --output: ${file}`);
}
