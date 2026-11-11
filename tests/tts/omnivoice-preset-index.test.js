import { expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { getOmniVoiceLanguageOptions } from '../../src/tts/omnivoice/languages.js';

it('registers new voices once, keeps registered voices frozen, lists any number per gender, and detects a stale index', () => {
  const prefix = path.join(os.tmpdir(), 'pn-omnivoice-index-');
  const directory = mkdtempSync(prefix);
  try {
    for (const file of ['tooling/scripts/write-omnivoice-preset-seeds.mjs', 'tooling/scripts/lib/omnivoice-speaker-selection.mjs', 'src/tts/omnivoice/languages.js', 'src/tts/omnivoice/voice-id.js']) {
      const destination = path.join(directory, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(file, destination);
    }
    writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    const config = path.join(directory, 'tooling/config');
    mkdirSync(config, { recursive: true });
    const registryFile = path.join(config, 'omnivoice-voice-registry.json');
    writeFileSync(registryFile, JSON.stringify({ about: 'test', voices: {} }));
    let n = 0;
    const generated = (lang, gender, variation, extra = {}) => ({ id: `${lang}-${gender}-${variation}`, lang, gender, variation, hash: String(++n).padStart(12, '0') + 'ab', ...extra });
    // One voice per language and gender, twelve Swedish female voices, and a dataset recording.
    const speakers = getOmniVoiceLanguageOptions().flatMap(({ code: lang }) => ['female', 'male'].map(gender => generated(lang, gender, 1)));
    for (let variation = 2; variation <= 12; variation++) speakers.push(generated('sv', 'female', variation));
    speakers.push({ id: 'sv-male-2', lang: 'sv', gender: 'male', variation: 2, hash: 'x', source: { kind: 'recording', dataset: 'google/fleurs', originalFile: '123.wav' }, playbackNumStep: 48, playbackGenderCue: false, playbackGuidanceScale: 3, playbackSpeed: .85 });
    const idOf = slot => `${slot.split('-').slice(0, 2).join('-')}-gen-${speakers.find(row => row.id === slot).hash.slice(0, 12)}`;
    const svFirst = idOf('sv-female-5'), enMale = idOf('en-male-1');
    // v1.0.4 saved Swedish female variation 1 as this voice and listed it first.
    writeFileSync(path.join(config, 'omnivoice-v104-voices.json'), JSON.stringify({ about: 'test', slots: { 'sv-female-1': svFirst }, order: { sv: { female: [svFirst] } } }));
    const catalogFile = path.join(directory, 'src/tts/omnivoice/speaker-data.js');
    const writeCatalog = rows => writeFileSync(catalogFile, `export default ${JSON.stringify({ speakers: rows })};\n`);
    writeCatalog(speakers);
    const run = args => execFileSync(process.execPath, args, { cwd: directory, windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
    const index = () => JSON.parse(run(['--input-type=module', '-e', `
      import * as v from './src/tts/omnivoice/preset-seeds.js';
      console.log(JSON.stringify({ svFemale: v.getOmniVoiceVoices('sv', 'female'), rare: v.getOmniVoiceVoices('sol', 'male'), fleurs: v.getOmniVoicePreset('sv-fleurs-123'),
        legacy: [v.getOmniVoiceLegacyVoice('sv', 'female', 1), v.getOmniVoiceLegacyVoice('sv', 'female', 2), v.getOmniVoiceLegacyVoice('sv', 'female', 11)] }));
    `]));

    run(['tooling/scripts/write-omnivoice-preset-seeds.mjs']);
    run(['tooling/scripts/write-omnivoice-preset-seeds.mjs', '--check']);
    const first = index();
    expect(first.svFemale).toHaveLength(12);
    expect(first.svFemale[0]).toBe(svFirst); // v1.0.4 order first
    expect(first.rare).toEqual([enMale]);
    expect(first.fleurs).toEqual({ id: 'sv-fleurs-123', lang: 'sv', gender: 'male', seed: 43, numStep: 48, genderCue: false, guidanceScale: 3, speed: .85, pronunciationVariant: null });
    expect(first.legacy).toEqual([svFirst, null, null]);
    expect(Object.keys(JSON.parse(readFileSync(registryFile, 'utf8')).voices)).toHaveLength(speakers.length);

    // Moving a registered voice to another slot or retuning it in the catalog keeps its frozen settings.
    speakers.at(-1).variation = 9; speakers.at(-1).playbackNumStep = 24;
    writeCatalog(speakers);
    run(['tooling/scripts/write-omnivoice-preset-seeds.mjs', '--check']);
    expect(index().fleurs).toEqual(first.fleurs);

    // A new voice must be registered; removing one keeps its ID registered so it is never reused.
    const added = [...speakers.filter(row => row.id !== 'sv-female-12'), generated('sv', 'female', 13)];
    writeCatalog(added);
    expect(() => run(['tooling/scripts/write-omnivoice-preset-seeds.mjs', '--check'])).toThrow(/not registered/);
    run(['tooling/scripts/write-omnivoice-preset-seeds.mjs']);
    expect(index().svFemale).toHaveLength(12);
    expect(Object.keys(JSON.parse(readFileSync(registryFile, 'utf8')).voices)).toHaveLength(speakers.length + 1);

    // The same person twice in one language is refused.
    writeCatalog([...added, { ...added.at(-2), id: 'sv-male-3', variation: 3 }]);
    expect(() => run(['tooling/scripts/write-omnivoice-preset-seeds.mjs'])).toThrow(/appears twice/);
    writeCatalog(added);
    writeFileSync(path.join(directory, 'src/tts/omnivoice/preset-seeds.js'), '// stale\n');
    expect(() => run(['tooling/scripts/write-omnivoice-preset-seeds.mjs', '--check'])).toThrow();
  } finally {
    if (!path.resolve(directory).startsWith(path.resolve(prefix))) throw new Error('Temporary preset fixture escaped its directory.');
    rmSync(directory, { recursive: true, force: true });
  }
});
