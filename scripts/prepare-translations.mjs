// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const userProperties = new Set(['textContent', 'title', 'placeholder', 'label', 'message', 'description', 'body', 'cta', 'helpText']);
const normalize = value => String(value).replace(/\s+/gu, ' ').trim();

export function extractTranslationStrings(filename, source) {
  const found = [];
  if (filename.endsWith('.html')) {
    const { document } = new JSDOM(source).window;
    for (const element of document.querySelectorAll('body *, head title')) {
      if (element.closest('script, style, noscript')) continue;
      for (const node of element.childNodes) {
        if (node.nodeType === 3 && normalize(node.textContent)) found.push({ message: normalize(node.textContent),
          context: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`, kind: 'html-text' });
      }
      for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = element.getAttribute(attribute);
        if (value) found.push({ message: value, context: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}[${attribute}]`, kind: 'html-attribute' });
      }
    }
    return found;
  }
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const parent = node.parent;
      const property = ts.isPropertyAssignment(parent) ? parent.name.getText(tree).replace(/^['"]|['"]$/gu, '')
        : ts.isBinaryExpression(parent) && parent.right === node && ts.isPropertyAccessExpression(parent.left) ? parent.left.name.text : '';
      const isError = ts.isNewExpression(parent) && /Error$/u.test(parent.expression.getText(tree));
      const isMessageCall = ts.isCallExpression(parent) && (
        /(?:setPending|showError)$/u.test(parent.expression.getText(tree)) && parent.arguments.indexOf(node) > 0
        || /setAttribute$/u.test(parent.expression.getText(tree)) && parent.arguments[1] === node
          && /^(?:aria-label|title|placeholder|alt)$/u.test(parent.arguments[0]?.text || '')
      );
      if (userProperties.has(property) || isError || isMessageCall) {
        const placeholders = {};
        let message;
        if (ts.isTemplateExpression(node)) {
          message = node.head.text;
          node.templateSpans.forEach((span, index) => {
            const key = `value${index + 1}`;
            message += `$${key}$${span.literal.text}`;
            placeholders[key] = { content: `$${index + 1}`, example: span.expression.getText(tree) };
          });
        } else message = node.text;
        if (/[\p{L}]/u.test(message) && message.length > 2 && !/^(?:aria-|data-)/u.test(message)) {
          found.push({ message, ...(Object.keys(placeholders).length ? { placeholders } : {}),
            context: `line ${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${property || parent.expression.getText(tree)}`,
            kind: isError ? 'error-review' : 'javascript-review' });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

export function validateTranslatedCatalog(source, translated) {
  const errors = [];
  for (const [key, original] of Object.entries(source)) {
    const value = translated[key];
    if (!value?.message?.trim()) { errors.push(`${key}: missing translation`); continue; }
    const tokens = text => [...String(text).matchAll(/\$[a-z][a-z0-9_]*\$/giu)].map(match => match[0].toLowerCase()).sort();
    if (JSON.stringify(tokens(original.message)) !== JSON.stringify(tokens(value.message))) errors.push(`${key}: changed placeholders`);
    if (JSON.stringify(original.placeholders || {}) !== JSON.stringify(value.placeholders || {})) errors.push(`${key}: changed placeholder definitions`);
  }
  for (const key of Object.keys(translated)) if (!source[key]) errors.push(`${key}: unknown key`);
  return errors;
}

export function mergeTranslationCatalog(source, translated, locale) {
  return {
    messages: Object.fromEntries(Object.entries(source).map(([key, value]) => [key,
      { ...value, message: locale === 'en' ? value.message : translated[key]?.message ?? '' }])),
    obsolete: Object.fromEntries(Object.entries(translated).filter(([key]) => !source[key])),
  };
}

async function main() {
  if (process.argv[2] === '--check') {
    const directory = path.resolve(process.argv[3] || 'artifacts/translation-kit');
    const source = JSON.parse(await readFile(path.join(directory, 'source.en.json'), 'utf8'));
    const targets = JSON.parse(await readFile(path.join(directory, 'targets.json'), 'utf8')).targets;
    const results = [];
    for (const target of targets) {
      const translated = JSON.parse(await readFile(path.join(directory, '_locales', target.locale, 'messages.json'), 'utf8'));
      const errors = validateTranslatedCatalog(source, translated);
      results.push({ locale: target.locale, errors: errors.length, examples: errors.slice(0, 3) });
    }
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.some(result => result.errors) ? 1 : 0;
    return;
  }
  const root = path.resolve(process.argv[2] || 'artifacts/translation-kit');
  const rollout = JSON.parse(await readFile('config/language-rollout.json', 'utf8'));
  const existing = JSON.parse(await readFile('_locales/en/messages.json', 'utf8'));
  const catalog = { ...existing }, inventory = {};
  const byMessage = new Map(Object.entries(existing).map(([key, value]) => [value.message, key]));
  const files = (await readdir('src', { recursive: true })).filter(filename => /\.(?:js|html)$/u.test(filename)).sort();
  for (const filename of files) {
    const sourcePath = path.join('src', filename);
    const source = await readFile(sourcePath, 'utf8');
    for (const entry of extractTranslationStrings(filename, source)) {
      const signature = JSON.stringify([entry.message, entry.placeholders || {}]);
      const key = !entry.placeholders && byMessage.get(entry.message) || `ui_${createHash('sha256').update(signature).digest('hex').slice(0, 12)}`;
      catalog[key] ||= { message: entry.message, description: 'Translation preparation candidate; verify wording and connect the source call before enabling a locale.',
        ...(entry.placeholders ? { placeholders: entry.placeholders } : {}) };
      (inventory[key] ||= { runtimeCatalogEntry: Boolean(existing[key]), sources: [] }).sources.push({ file: sourcePath.replaceAll('\\', '/'), context: entry.context, kind: entry.kind });
    }
  }
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'source.en.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(path.join(root, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  const targets = [];
  for (const language of rollout.languages) {
    for (const locale of language.locales) {
      const target = path.join(root, '_locales', locale);
      await mkdir(target, { recursive: true });
      let previous = {};
      try { previous = JSON.parse(await readFile(path.join(target, 'messages.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const { messages, obsolete } = mergeTranslationCatalog(catalog, previous, locale);
      // Preserve translated messages; retain removed candidates separately for the translator.
      if (Object.keys(obsolete).length) await writeFile(path.join(target, 'obsolete.json'), `${JSON.stringify(obsolete, null, 2)}\n`);
      await writeFile(path.join(target, 'messages.json'), `${JSON.stringify(messages, null, 2)}\n`);
      targets.push({ code: language.code, locale, name: language.name, status: locale === 'en' ? 'source' : 'awaiting-translation-and-runtime-wiring' });
    }
  }
  await writeFile(path.join(root, 'targets.json'), `${JSON.stringify({ scope: 'Preparation kit only. Empty catalogs are deliberately outside the extension package. Website copy is a separate translation surface.',
    languages: rollout.languages.length, messages: Object.keys(catalog).length, targets }, null, 2)}\n`);
  console.log(JSON.stringify({ directory: root, languages: rollout.languages.length, locales: targets.length, messages: Object.keys(catalog).length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
