import { expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { getOmniVoiceLanguageOptions } from '../../src/tts/omnivoice/languages.js';

it('generates measured step overrides, preserves reference fallback, and detects a stale index', () => {
  const prefix = path.join(os.tmpdir(), 'pn-omnivoice-index-');
  const directory = mkdtempSync(prefix);
  try {
    for (const file of ['scripts/write-omnivoice-preset-seeds.mjs', 'scripts/lib/omnivoice-speaker-selection.mjs', 'src/tts/omnivoice/languages.js']) {
      const destination = path.join(directory, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(file, destination);
    }
    writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    const speakers = getOmniVoiceLanguageOptions().flatMap(({ code: lang }) => ['female', 'male'].flatMap(gender =>
      Array.from({ length: 10 }, (_, index) => ({ id: `${lang}-${gender}-${index + 1}`, lang, gender, variation: index + 1 }))));
    speakers.find(row => row.id === 'sv-female-8').playbackNumStep = 48;
    speakers.find(row => row.id === 'sv-female-8').playbackGenderCue = false;
    speakers.find(row => row.id === 'sv-female-8').playbackGuidanceScale = 3;
    speakers.find(row => row.id === 'sv-female-8').playbackSpeed = .85;
    speakers.find(row => row.id === 'en-male-2').playbackNumStep = 64;
    speakers.find(row => row.id === 'en-male-2').playbackGenderCue = false;
    speakers.find(row => row.id === 'en-male-2').playbackGuidanceScale = 1;
    speakers.find(row => row.id === 'en-male-2').playbackSpeed = 1.15;
    speakers.find(row => row.id === 'yue-female-4').playbackPronunciationVariant = 'yue-nei5';
    const catalogFile = path.join(directory, 'src/tts/omnivoice/speaker-data.js');
    writeFileSync(catalogFile, `export default ${JSON.stringify({ speakers })};\n`);
    const run = args => execFileSync(process.execPath, args, { cwd: directory, windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
    run(['scripts/write-omnivoice-preset-seeds.mjs']);
    run(['scripts/write-omnivoice-preset-seeds.mjs', '--check']);
    const actual = JSON.parse(run(['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {getOmniVoicePresetSeed as seed,getOmniVoicePresetNumStep as steps,hasOmniVoicePresetGenderCue as cue,getOmniVoicePresetGuidanceScale as guidance,getOmniVoicePresetSpeed as speed,getOmniVoicePresetPronunciationVariant as pronunciation} from './src/tts/omnivoice/preset-seeds.js';
      assert.throws(()=>steps('en','female',0));
      assert.throws(()=>guidance('en','female',11));
      assert.throws(()=>speed('en','female',0));
      assert.throws(()=>pronunciation('yue','female',0));
      console.log(JSON.stringify([steps('sv','female',8),steps('tr','female',1),steps('en','female',1),steps('sol','male',2),seed('sv','female',8),cue('sv','female',8),cue('sol','male',2),cue('en','female',1),guidance('sv','female',8),guidance('en','female',1),guidance('sol','male',2),speed('sv','female',8),speed('en','female',1),speed('sol','male',2),pronunciation('yue','female',4),pronunciation('yue','female',5),pronunciation('sol','male',2)]));
    `]));
    expect(actual).toEqual([48, 32, 24, 64, 49, false, false, true, 3, 2, 1, .85, 1, 1.15, 'yue-nei5', null, null]);
    writeFileSync(catalogFile, readFileSync(catalogFile, 'utf8').replace('"playbackNumStep":48', '"playbackNumStep":32'));
    expect(() => run(['scripts/write-omnivoice-preset-seeds.mjs', '--check'])).toThrow();
  } finally {
    if (!path.resolve(directory).startsWith(path.resolve(prefix))) throw new Error('Temporary preset fixture escaped its directory.');
    rmSync(directory, { recursive: true, force: true });
  }
});
