// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const referenceImport = "const { createBrowserInferenceEngine } = await import('../engines/browser-inference.js');";

export function injectOcrReferenceAdapter(source) {
  if (source.split(referenceImport).length !== 2) throw new Error('OCR reference adapter injection point changed.');
  return source.replace(referenceImport, 'const createBrowserInferenceEngine = () => ({ ...globalThis.__pnOcrReference, dispose: async () => {} });');
}
