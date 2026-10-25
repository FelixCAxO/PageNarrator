// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Packaged assets have one location; development callers supply their own URLs or bytes.
export const PDF_WASM_ASSET_PATH = 'assets/pdf-engine/pdf.wasm';
export const PDF_DATA_ASSET_PATH = 'assets/pdf-data/';
export function pdfExtensionAssetUrl(relative, runtime = globalThis.chrome?.runtime) {
  return typeof runtime?.getURL === 'function' ? runtime.getURL(relative) : null;
}
