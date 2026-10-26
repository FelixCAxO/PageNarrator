// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, readdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { messageKey } from '../src/lib/i18n.js';
import { ERROR_REGISTRY } from '../src/lib/error-registry.js';
import { VOICE_ENGINE_HELP } from '../src/lib/omnivoice-settings.js';

const previous = JSON.parse(await readFile('_locales/en/messages.json', 'utf8'));
const catalog = Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith('ui_')));
const sources = {};
function add(source, location) {
  const key = messageKey(source);
  if (sources[key] && sources[key].source !== source) throw new Error(`Message key collision: ${source}`);
  const placeholders = {};
  const message = source.replace(/\$(\d+)/gu, (_, number) => {
    placeholders[`arg${number}`] = { content: `$${number}` };
    return `$arg${number}$`;
  });
  catalog[key] = { message, ...(Object.keys(placeholders).length ? { placeholders } : {}) };
  (sources[key] ||= { source, locations: [] }).locations.push(location);
  return key;
}

for (const filename of (await readdir('src', { recursive: true })).filter(name => name.endsWith('.js'))) {
  const source = await readFile(`src/${filename}`, 'utf8');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 't' && ts.isStringLiteralLike(node.arguments[0])) {
      add(node.arguments[0].text, `src/${filename}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
for (const file of ['src/popup.html', 'src/reader-engine.html', 'src/pdf-viewer.html']) {
  const { document } = new JSDOM(await readFile(file, 'utf8')).window;
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (!attribute.name.startsWith('data-i18n')) continue;
      const entry = previous[attribute.value];
      if (!entry) throw new Error(`Missing message ${attribute.value} in ${file}`);
      if (attribute.value.startsWith('ui_')) add(entry.message.replace(/\$arg(\d+)\$/gu, '$$$1'), file);
    }
  }
}
for (const value of Object.values(VOICE_ENGINE_HELP)) add(value, 'src/lib/omnivoice-settings.js');
for (const record of Object.values(ERROR_REGISTRY)) {
  for (const [field, value] of Object.entries(record)) if (field !== 'code') add(value, `src/lib/error-registry.js:${record.code}.${field}`);
}
await writeFile('_locales/en/messages.json', `${JSON.stringify(catalog, null, 2)}\n`);
await writeFile('config/ui-message-sources.json', `${JSON.stringify(sources, null, 2)}\n`);
console.log(JSON.stringify({ messages: Object.keys(catalog).length, sources: Object.keys(sources).length }));
