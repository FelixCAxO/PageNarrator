// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { validateTranslatedCatalog } from './prepare-translations.mjs';

const read = async name => JSON.parse(await readFile(name, 'utf8'));
const source = await read('_locales/en/messages.json');
const rollout = await read('config/language-rollout.json');
const reviewed = await read('config/ui-translations-reviewed.json');
const critical = await read('config/ui-translations-critical.json');
Object.assign(reviewed.messages, critical.messages);
const errors = [], catalogs = [];
for (const [english, row] of Object.entries(reviewed.messages)) {
  if (row.split('|').length !== reviewed.locales.length) throw new Error(`Invalid reviewed row: ${english}`);
}
function reviewedMessage(english, index) {
  return reviewed.messages[english]?.split('|')[index]
    || critical.composed[english]?.map(part => reviewedMessage(part, index)).join(' ');
}
for (const language of rollout.languages.filter(item => item.code !== 'en')) {
  let draft = {};
  try { draft = await read(`artifacts/ui-translations/drafts/${language.code}.json`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const locale of language.locales) {
    const localeIndex = reviewed.locales.indexOf(locale);
    if (localeIndex < 0) throw new Error(`Missing reviewed locale: ${locale}`);
    const catalog = {};
    for (const [key, original] of Object.entries(source)) {
      const manual = reviewedMessage(original.message, localeIndex);
      let message = manual || draft[key]?.message;
      if (!manual && draft[key]?.errors?.length) errors.push({ locale, key, source: original.message, draft: message, errors: draft[key].errors });
      // Keep references to buttons consistent with their reviewed captions.
      if (message) for (const caption of ['Read selected', 'Read page', 'Prepare voice']) {
        message = message.replaceAll(caption, reviewed.messages[caption].split('|')[localeIndex]);
      }
      if (/9876\d{4}/u.test(message || '')) errors.push({ locale, key, error: 'Unrestored drafting token' });
      for (const brand of ['PageNarrator', 'Kokoro', 'OmniVoice', 'Hugging Face', 'WebGPU', 'WebAssembly']) {
        if (original.message.includes(brand) && !message?.includes(brand)) errors.push({ locale, key, error: `Changed brand: ${brand}` });
      }
      catalog[key] = { ...original, message: message || '' };
    }
    for (const error of validateTranslatedCatalog(source, catalog)) errors.push({ locale, error });
    catalogs.push({ locale, catalog });
  }
}
await mkdir('artifacts/ui-translations', { recursive: true });
await writeFile('artifacts/ui-translations/catalog-errors.json', `${JSON.stringify(errors, null, 2)}\n`);
if (errors.length) {
  console.log(JSON.stringify({ errors: errors.length, examples: errors.slice(0, 12) }, null, 2));
  process.exitCode = 1;
} else {
  for (const { locale, catalog } of catalogs) {
    await mkdir(`_locales/${locale}`, { recursive: true });
    await writeFile(`_locales/${locale}/messages.json`, `${JSON.stringify(catalog, null, 2)}\n`);
  }
  console.log(JSON.stringify({ installedLocales: catalogs.length + 1, messagesPerLocale: Object.keys(source).length }));
}
