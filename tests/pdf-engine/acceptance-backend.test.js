// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { loadPdfAcceptanceBackend } from '../../scripts/lib/pdf-acceptance-backend.mjs';

function authoredDependencies(original = true) {
  const task = { promise: Promise.resolve({ authored: true }), destroy: vi.fn() };
  const getDocument = vi.fn(() => task);
  const module = original ? { isPageNarratorPdfEngine: true, getDocument } : { version: 'authored-oracle', getDocument };
  const loadModule = vi.fn(async () => module);
  const bytes = new Uint8Array([12, 34, 56]);
  const read = vi.fn(async () => bytes);
  return { task, module, bytes, getDocument, loadModule, read };
}

it('defaults to the original facade and preserves the actual task and input bytes', async () => {
  const dependencies = authoredDependencies(), input = new Uint8Array([3, 1, 4]);
  const { engine, identity } = await loadPdfAcceptanceBackend(undefined, dependencies);
  expect(dependencies.loadModule).toHaveBeenCalledExactlyOnceWith('../../src/pdf/pdf-engine.js');
  const task = engine.getDocument({ data: input, password: 'authored', disableWorker: false, wasm: 'override', loadAsset: 'override' });
  expect(task).toBe(dependencies.task);
  const settings = dependencies.getDocument.mock.calls[0][0];
  expect(settings.data).toBe(input); expect(settings.password).toBe('authored');
  expect(settings.wasm).toBe(dependencies.bytes); expect(settings.disableWorker).toBe(true);
  expect(await settings.loadAsset('standard_fonts/Author.ttf')).toEqual(dependencies.bytes);
  expect(dependencies.read.mock.calls.at(-1)[0].pathname).toMatch(/\/vendor\/pdf-data\/standard_fonts\/Author\.ttf$/);
  expect(identity).toMatchObject({ backend: 'original', version: null });
  expect(identity.sourcePins).toHaveLength(2);
  expect(identity.sourcePins.every(pin => pin.bytes === 3 && /^[a-f0-9]{64}$/u.test(pin.sha256))).toBe(true);
});

it('keeps explicit oracle selection isolated and returns its unchanged engine', async () => {
  const dependencies = authoredDependencies(false);
  const { engine, identity } = await loadPdfAcceptanceBackend('pdfjs-oracle', dependencies);
  expect(dependencies.loadModule).toHaveBeenCalledExactlyOnceWith('pdfjs-dist/legacy/build/pdf.mjs');
  expect(engine).toBe(dependencies.module);
  expect(identity).toMatchObject({ backend: 'pdfjs-oracle', version: 'authored-oracle' });
  expect(identity.sourcePins.every(pin => !pin.path.endsWith('pdf.wasm'))).toBe(true);
  expect(identity.sourcePins[1].path).toMatch(/pdf\.worker\.mjs$/);
  expect(dependencies.getDocument).not.toHaveBeenCalled();
});

it('loads the real browser factory only when that backend is explicitly selected', async () => {
  const session = { engine: { isPageNarratorPdfEngine: true }, identity: { backend: 'original-browser' }, dispose: vi.fn() };
  const createPdfAcceptanceBrowser = vi.fn(async () => session), loadModule = vi.fn(async () => ({ createPdfAcceptanceBrowser }));
  expect(await loadPdfAcceptanceBackend('original-browser', { loadModule })).toBe(session);
  expect(loadModule).toHaveBeenCalledExactlyOnceWith('./pdf-acceptance-browser.mjs');
  expect(createPdfAcceptanceBrowser).toHaveBeenCalledOnce();
});

it.each(['', 'automatic', null])('rejects invalid explicit backend %s before loading any executable or asset', async backend => {
  const dependencies = authoredDependencies();
  await expect(loadPdfAcceptanceBackend(backend, dependencies)).rejects.toThrow(/Unknown PDF acceptance backend/);
  expect(dependencies.loadModule).not.toHaveBeenCalled(); expect(dependencies.read).not.toHaveBeenCalled();
});

it('refuses an oracle accidentally returned for the original lane', async () => {
  const dependencies = authoredDependencies(false);
  await expect(loadPdfAcceptanceBackend('original', dependencies)).rejects.toThrow(/identity/);
  expect(dependencies.read).not.toHaveBeenCalled();
});
