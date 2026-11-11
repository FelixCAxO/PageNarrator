// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { localizeDocument, localizeLanguageOptions, t } from './lib/i18n.js';
import { installTrustedUiEventBoundary } from './lib/trusted-ui-events.js';
import { getPlaybackSettings, savePlaybackSettings } from './lib/playback-settings.js';
import { STORAGE_KEYS } from './lib/storage-keys.js';
import { canUseOmniVoice } from './lib/omnivoice-settings.js';
import { pcmToWavBlob, synthesizeSpeechChunk } from './lib/speech-audio.js';
import { listPersonalVoiceReferences, savePersonalVoiceReference, deletePersonalVoiceReference } from './platform/storage/personal-voice-store.js';
import { getOmniVoiceLanguageOptions } from './tts/omnivoice/languages.js';
import { REFERENCE_SAMPLE_RATE } from './tts/omnivoice/reference-encoder.js';
import { decodeOmniVoiceFile, decodeOmniVoiceSample, encodeOmniVoiceSample, importOmniVoiceSample, MIN_SAMPLE_SECONDS } from './tts/omnivoice/reference-import.js';
import { cleanOmniVoiceSample } from './tts/omnivoice/reference-cleanup.js';
import { recordOmniVoiceSample } from './tts/omnivoice/reference-recording.js';
import { RECORDING_PROMPTS } from './tts/omnivoice/recording-prompts.js';

installTrustedUiEventBoundary(document);
localizeDocument();
const byId = id => document.getElementById(id);
const form = byId('create-voice');
const importControls = byId('import-controls');
const presetControls = byId('preset-controls');
const picker = byId('saved-voice');
const language = byId('voice-language');
const transcript = byId('voice-text');
const recordingPrompt = byId('recording-prompt');
const cancel = byId('cancel-voice-action');
const fileInput = byId('voice-file');
const recordedClip = byId('recorded-clip');
const cleanClip = byId('clean-clip');
const useOriginalClip = byId('use-original-clip');
const stopRecording = byId('stop-recording');
const preview = byId('preview-audio');
const status = byId('voice-status');
const buttons = ['use-voice', 'preview-voice', 'delete-voice'].map(byId);
let profiles = [];
let action = null;
let previewUrl = '';
let previewKey = '';
let recordedUrl = '';
let originalPcm = null;
let cleanedPcm = null;
let stopCapture = null;
let guidedTranscript = '';
let languageTouched = false;

language.replaceChildren(...localizeLanguageOptions(getOmniVoiceLanguageOptions()).map(option => new Option(option.label, option.code)));
language.value = 'en';
showRecordingPrompt();

function showRecordingPrompt() {
  recordingPrompt.lang = language.value;
  recordingPrompt.textContent = RECORDING_PROMPTS[language.value];
}

async function refreshProfiles(selected) {
  profiles = await listPersonalVoiceReferences();
  const profile = profiles.find(profile => profile.id === (selected ?? picker.value)) || profiles[0];
  if (previewKey && previewKey !== getPreviewKey(profile)) clearPreview();
  picker.replaceChildren(...profiles.map(profile => new Option(profile.name, profile.id)));
  picker.value = profile?.id || '';
  picker.disabled = !profiles.length;
  for (const button of buttons) button.disabled = !profiles.length;
}

function getPreviewKey(profile) {
  return profile ? JSON.stringify([profile.id, profile.hash, profile.lang, profile.text]) : '';
}

function clearPreview() {
  preview.pause();
  preview.removeAttribute('src');
  preview.hidden = true;
  if (previewUrl) {
    preview.load();
    URL.revokeObjectURL(previewUrl);
  }
  previewUrl = '';
  previewKey = '';
}

function showClip(pcm) {
  recordedClip.pause();
  recordedClip.removeAttribute('src');
  recordedClip.load();
  if (recordedUrl) URL.revokeObjectURL(recordedUrl);
  recordedUrl = pcm ? URL.createObjectURL(pcmToWavBlob(pcm, REFERENCE_SAMPLE_RATE)) : '';
  if (recordedUrl) recordedClip.src = recordedUrl;
  recordedClip.hidden = !recordedUrl;
}

function updateClipControls() {
  cleanClip.disabled = Boolean(cleanedPcm) || (!originalPcm && !fileInput.files.length);
  useOriginalClip.hidden = !cleanedPcm;
}

function clearClip() {
  originalPcm = cleanedPcm = null;
  if (transcript.value === guidedTranscript) transcript.value = '';
  guidedTranscript = '';
  showClip(null);
  updateClipControls();
}

function showStatus(message) { status.textContent = message; }

async function run(task) {
  if (action) return;
  const controller = new AbortController();
  action = controller;
  importControls.disabled = presetControls.disabled = true;
  cancel.hidden = false;
  showStatus('');
  try { await task(controller.signal); }
  catch (error) { showStatus(controller.signal.aborted ? t('Cancelled.') : error.message || t('The personal voice action failed.')); }
  finally {
    action = null;
    cancel.hidden = true;
    importControls.disabled = presetControls.disabled = false;
  }
}

async function requireOmniVoiceHardware() {
  if (!(await canUseOmniVoice())) throw new Error(t('OmniVoice requires WebGPU with fp16 support.'));
}

cancel.addEventListener('click', () => action?.abort());
fileInput.addEventListener('change', () => { clearClip(); showStatus(''); });
language.addEventListener('change', () => {
  languageTouched = true;
  showRecordingPrompt();
});
picker.addEventListener('change', clearPreview);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEYS.OMNIVOICE_PERSONAL_REFERENCES]) {
    void refreshProfiles().catch(error => showStatus(error.message));
  }
});
window.addEventListener('pagehide', () => { action?.abort(); clearPreview(); clearClip(); });

cleanClip.addEventListener('click', () => void run(async signal => {
  recordedClip.pause();
  const file = fileInput.files[0];
  if (!originalPcm && !file) return;
  if (!originalPcm) {
    const pcm = await decodeOmniVoiceFile(file, signal);
    signal.throwIfAborted();
    originalPcm = pcm;
    showClip(pcm);
  }
  await requireOmniVoiceHardware();
  try {
    const processing = () => showStatus(t('Cleaning up background noise…'));
    processing();
    const cleaned = await cleanOmniVoiceSample(originalPcm, {
      signal,
      onProgress: ({ loaded, total }) => showStatus(t('Downloading noise cleanup model… $1%', [Math.floor(100 * loaded / total)])),
      onProcessing: processing,
    });
    signal.throwIfAborted();
    cleanedPcm = cleaned;
    showClip(cleanedPcm);
    showStatus(t('Cleaned clip ready to play or save.'));
  } catch {
    signal.throwIfAborted();
    showStatus(t('Noise cleanup unavailable. Your original clip is ready to save.'));
  } finally { updateClipControls(); }
}));

useOriginalClip.addEventListener('click', () => {
  cleanedPcm = null;
  showClip(originalPcm);
  updateClipControls();
  showStatus(t('Clip ready to play or save.'));
});

stopRecording.addEventListener('click', () => {
  stopCapture?.();
  stopRecording.hidden = true;
});

byId('record-voice').addEventListener('click', () => void run(async signal => {
  const prompt = RECORDING_PROMPTS[language.value];
  recordedClip.pause();
  preview.pause();
  let enableStop;
  try {
    const blob = await recordOmniVoiceSample({
      signal,
      onStart(stop) {
        stopCapture = stop;
        stopRecording.hidden = false;
        stopRecording.disabled = true;
        showStatus(t('Recording…'));
        // Give the browser time to collect three full seconds of encoded audio.
        enableStop = setTimeout(() => { stopRecording.disabled = false; }, MIN_SAMPLE_SECONDS * 1000 + 200);
      },
    });
    stopRecording.hidden = true;
    const pcm = await decodeOmniVoiceSample(blob, { signal, recorded: true });
    signal.throwIfAborted();
    fileInput.value = '';
    guidedTranscript = prompt;
    transcript.value = prompt;
    cleanedPcm = null;
    originalPcm = pcm;
    showClip(originalPcm);
    updateClipControls();
    showStatus(t('Clip ready to play or save.'));
  } catch (error) {
    if (error.name === 'NotSupportedError') throw new Error(t('Microphone recording is unavailable.'));
    if (error.name === 'NotAllowedError') throw new Error(t('Allow microphone access to record a clip.'));
    if (error.name === 'NotFoundError') throw new Error(t('No microphone was found.'));
    throw error;
  } finally {
    clearTimeout(enableStop);
    stopRecording.hidden = true;
    stopCapture = null;
  }
}));

form.addEventListener('submit', event => {
  event.preventDefault();
  void run(async signal => {
    const file = fileInput.files[0];
    const pcm = cleanedPcm || originalPcm;
    const name = byId('voice-name').value.trim();
    const text = transcript.value.trim();
    if (!file && !pcm) throw new Error(t('Choose an audio file or record a clip.'));
    if (!name || !text || /<\||\|>/u.test(text)) throw new Error(t('Enter a preset name and the words spoken in the recording.'));
    await requireOmniVoiceHardware();
    showStatus(t('Encoding the voice sample…'));
    const options = { signal, onProgress: ({ loaded, total }) => showStatus(
      loaded < total ? t('Downloading voice encoder… $1%', [Math.floor(100 * loaded / total)]) : t('Encoding the voice sample…')) };
    const encoded = pcm ? await encodeOmniVoiceSample(pcm.slice(), options) : await importOmniVoiceSample(file, options);
    signal.throwIfAborted();
    const profile = await savePersonalVoiceReference({ name, lang: language.value, text, ...encoded });
    clearPreview();
    await refreshProfiles(profile.id);
    form.reset();
    clearClip();
    language.value = profile.lang;
    showRecordingPrompt();
    showStatus(t('Voice preset saved.'));
  });
});

byId('use-voice').addEventListener('click', () => void run(async () => {
  const profile = profiles.find(item => item.id === picker.value);
  if (!profile) return;
  await requireOmniVoiceHardware();
  await savePlaybackSettings({ ttsEngine: 'omnivoice-clone', language: profile.lang, personalVoiceId: profile.id, ttsEngineAuto: false });
  showStatus(t('Selected for reading.'));
}));

byId('preview-voice').addEventListener('click', () => void run(async signal => {
  const personalReference = profiles.find(item => item.id === picker.value);
  if (!personalReference) return;
  const key = getPreviewKey(personalReference);
  if (previewUrl && previewKey === key) {
    preview.pause();
    preview.currentTime = 0;
    showStatus(t('Voice preview ready.'));
    return;
  }
  await requireOmniVoiceHardware();
  clearPreview();
  showStatus(t('Preparing voice preview…'));
  const { createOmniVoiceTts } = await import('./tts/omnivoice/tts.js');
  const tts = createOmniVoiceTts();
  try {
    await tts.init({ signal });
    const { blob } = await synthesizeSpeechChunk(tts, personalReference.text, {
      voice: { engine: 'omnivoice', detectCode: personalReference.lang, personalReference },
      languageCode: personalReference.lang,
      signal,
    });
    signal.throwIfAborted();
    if (key !== getPreviewKey(profiles.find(item => item.id === picker.value))) {
      showStatus('');
      return;
    }
    previewUrl = URL.createObjectURL(blob);
    previewKey = key;
    preview.src = previewUrl;
    preview.hidden = false;
    showStatus(t('Voice preview ready.'));
  } finally { await tts.dispose(); }
}));

byId('delete-voice').addEventListener('click', () => void run(async () => {
  const id = picker.value;
  if (!id) return;
  await deletePersonalVoiceReference(id);
  await refreshProfiles();
  showStatus(t('Voice preset deleted.'));
}));

void getPlaybackSettings().then(settings => {
  if (!languageTouched && !action && !originalPcm && !fileInput.files.length) {
    language.value = getOmniVoiceLanguageOptions().some(option => option.code === settings.language) ? settings.language : 'en';
    showRecordingPrompt();
  }
  return refreshProfiles(settings.personalVoiceId);
}).catch(error => showStatus(error.message));
