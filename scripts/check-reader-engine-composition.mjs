import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/reader-engine.js', import.meta.url), 'utf8');
const lines = source.split(/\r?\n/).length;
const lineBudgets = [
  { path: '../src/app/reader-engine/create-reader-engine-app.js', max: 250 },
  { path: '../src/app/reader-engine/reader-engine-runtime.js', max: 100 },
  { path: '../src/app/reader-engine/reader-engine-session.js', max: 1200 },
  { path: '../src/platform/chrome/reader-engine-chrome-adapter.js', max: 900 },
  { path: '../src/lib/reader-engine-reading-state-renderer.js', max: 300 },
  { path: '../src/lib/reader-engine-read-controls-controller.js', max: 300 },
  { path: '../src/lib/reader-engine-session-context-controller.js', max: 300 },
  { path: '../src/lib/reader-engine-voice-runtime-controller.js', max: 300 },
  { path: '../src/lib/page-highlighter.js', max: 1800 },
];
const forbiddenTokens = [
  'document.getElementById',
  '.addEventListener(',
  'chrome.storage.onChanged.addListener',
  'chrome.tabs.onActivated.addListener',
  'createReaderEngineVoiceSettingsController',
  'createReaderEngineTtsProbeController',
  'createReaderEnginePdfNavigationController',
  'createReaderEngineQueueNavigationController',
  'createReaderEnginePanelStateController',
];

if (lines > 150) {
  throw new Error(`src/reader-engine.js should stay a thin bootstrap file; got ${lines} lines.`);
}

for (const token of forbiddenTokens) {
  if (source.includes(token)) {
    throw new Error(`src/reader-engine.js should not contain composition token: ${token}`);
  }
}

for (const budget of lineBudgets) {
  const budgetSource = readFileSync(new URL(budget.path, import.meta.url), 'utf8');
  const budgetLines = budgetSource.split(/\r?\n/).length;
  if (budgetLines > budget.max) {
    throw new Error(`${budget.path.replace('../', '')} should stay at or below ${budget.max} lines; got ${budgetLines}.`);
  }
}
