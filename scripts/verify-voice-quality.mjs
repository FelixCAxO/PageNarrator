import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateVoiceReceipt } from './voice-listening-reviews.mjs';
import { verifyQualityBuild } from './lib/kokoro-quality-controls.mjs';

export async function verifyVoiceQuality({ root = process.cwd(), receipt = process.env.PN_VOICE_QUALITY_REVIEWS } = {}) {
  if (!receipt) return { status: 'not-qualified', reasons: ['Independent voice reviews are pending. Set PN_VOICE_QUALITY_REVIEWS to the collected original-review receipt.'] };
  const result = await evaluateVoiceReceipt(root, resolve(receipt));
  if (result.status === 'qualified') await verifyQualityBuild(root, result.packagedBuild, resolve(root, 'dist'));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await verifyVoiceQuality(); console.log(JSON.stringify(result, null, 2)); if (result.status !== 'qualified') process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
