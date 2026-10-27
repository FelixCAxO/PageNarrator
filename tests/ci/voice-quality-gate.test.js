import { expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { verifyVoiceQuality } from '../../scripts/verify-voice-quality.mjs';
import { evaluateVoiceReceipt } from '../../scripts/voice-listening-reviews.mjs';
import { verifyQualityBuild } from '../../scripts/lib/kokoro-quality-controls.mjs';

vi.mock('../../scripts/voice-listening-reviews.mjs', () => ({ evaluateVoiceReceipt: vi.fn() }));
vi.mock('../../scripts/lib/kokoro-quality-controls.mjs', () => ({ verifyQualityBuild: vi.fn() }));

it('keeps missing independent reviews unqualified', async () => {
  expect(await verifyVoiceQuality({ receipt: '' })).toMatchObject({ status: 'not-qualified' });
});

it('rejects a different release package even when its supplied receipt qualifies', async () => {
  const packagedBuild = { sha256: 'frozen-unit-build' };
  vi.mocked(evaluateVoiceReceipt).mockResolvedValue({ status: 'qualified', packagedBuild });
  vi.mocked(verifyQualityBuild).mockRejectedValueOnce(new Error('Packaged quality worker differs from its frozen build.'));
  await expect(verifyVoiceQuality({ root: process.cwd(), receipt: 'unit-only.json' })).rejects.toThrow('frozen build');
  expect(verifyQualityBuild).toHaveBeenCalledWith(process.cwd(), packagedBuild, resolve('dist'));
});
