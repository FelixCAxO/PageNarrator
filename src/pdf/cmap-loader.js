// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodePdfStream } from './streams.js';
import { PREDEFINED_CMAP_NAMES } from './cmap-names.js';
import { parseCmapData, cmapUnicode, cmapByte } from './cmap-data.js';

const allowed = new Set(PREDEFINED_CMAP_NAMES), cachesByLoader = new WeakMap();
function complete(map, parent = null) {
  const unique = new Map([...(parent?.spaces ?? []), ...map.spaces].map(space => [`${space.length}:${space.first}:${space.last}`, space]));
  const spaces = [...unique.values()];
  if (!spaces.length || spaces.length > 256) throw new PdfEngineError('CMap needs bounded character code spaces.', 'pdf_corrupt');
  for (const short of spaces) for (const long of spaces) if (short.length < long.length) {
    const overlap = Array.from({ length: short.length }, (_, i) => i).every(i => cmapByte(long.first, long.length, i) <= cmapByte(short.last, short.length, i)
      && cmapByte(long.last, long.length, i) >= cmapByte(short.first, short.length, i));
    if (overlap) throw new PdfEngineError('Ambiguous CMap character-code prefixes.', 'pdf_corrupt');
  }
  return { ...map, spaces, parent, vertical: map.vertical ?? parent?.vertical ?? false,
    registry: map.registry ?? parent?.registry ?? null, ordering: map.ordering ?? parent?.ordering ?? null };
}
export async function loadPredefinedCmap(name, loadAsset, ancestors = []) {
  if (ancestors.length >= 8 || ancestors.includes(name)) throw new PdfEngineError('Cyclic or excessively nested CMap resources.', 'pdf_corrupt');
  if (name === 'Identity-H' || name === 'Identity-V') return complete({ identity: true, spaces: [{ length: 2, first: 0, last: 65535 }],
    cids: new Map(), unicode: new Map(), invalidUnicode: new Map(), vertical: name === 'Identity-V' });
  if (!allowed.has(name)) throw new PdfEngineError(`Predefined CMap ${name} is not supported.`);
  let cache = cachesByLoader.get(loadAsset); if (!cache) { cache = new Map(); cachesByLoader.set(loadAsset, cache); }
  if (cache.has(name)) return cache.get(name);
  const task = (async () => {
    const map = parseCmapData(await loadAsset(`../pdf-cmaps/${name}`));
    const parent = map.baseName ? await loadPredefinedCmap(map.baseName, loadAsset, [...ancestors, name]) : null;
    return complete(map, parent);
  })();
  cache.set(name, task); while (cache.size > 8) cache.delete(cache.keys().next().value);
  void task.catch(() => { if (cache.get(name) === task) cache.delete(name); });
  return task;
}

export async function readFontCmap(reader, id, loadAsset, ancestors = []) {
  if (!id || ancestors.length >= 8) throw new PdfEngineError('Missing or excessively nested font CMap.', 'pdf_corrupt');
  const name = reader.name(id); if (name) return loadPredefinedCmap(name, loadAsset);
  const resolved = reader.node(id).id;
  if (ancestors.includes(resolved)) throw new PdfEngineError('Cyclic embedded font CMap.', 'pdf_corrupt');
  const map = parseCmapData((await decodePdfStream(reader, id)).bytes), baseId = reader.field(id, 'UseCMap');
  if (baseId && map.baseName && reader.name(baseId) !== map.baseName) throw new PdfEngineError('Conflicting CMap base resources.', 'pdf_corrupt');
  const parent = baseId ? await readFontCmap(reader, baseId, loadAsset, [...ancestors, resolved])
    : map.baseName ? await loadPredefinedCmap(map.baseName, loadAsset) : null;
  const modeId = reader.field(id, 'WMode');
  if (modeId) {
    const mode = reader.number(modeId, -1);
    if (![0, 1].includes(mode) || map.vertical !== undefined && map.vertical !== Boolean(mode)) throw new PdfEngineError('Invalid embedded CMap writing mode.', 'pdf_corrupt');
    map.vertical = Boolean(mode);
  }
  return complete(map, parent);
}

/** Canonical Adobe CID-to-Unicode data, never an assumption that CIDs are Unicode. */
export async function readCidUnicodeMap(reader, descendant, encoding, loadAsset) {
  const info = reader.field(descendant, 'CIDSystemInfo');
  const literal = name => {
    const field = info && reader.field(info, name); if (!field) return null;
    if (reader.node(field).kind !== 'string') throw new PdfEngineError('Invalid CIDSystemInfo string.', 'pdf_corrupt');
    return new TextDecoder('latin1').decode(reader.bytes(field));
  };
  const registry = literal('Registry') ?? encoding.registry, ordering = literal('Ordering') ?? encoding.ordering;
  if (encoding.registry && registry !== encoding.registry || encoding.ordering && ordering !== encoding.ordering) throw new PdfEngineError('Font and encoding CMap CID collections disagree.', 'pdf_corrupt');
  if (registry !== 'Adobe' || !['CNS1', 'GB1', 'Japan1', 'Korea1'].includes(ordering)) return null;
  return loadPredefinedCmap(`Adobe-${ordering}-UCS2`, loadAsset);
}
export const cidUnicodeText = (map, cid) => map ? cmapUnicode(map, cid.toString(16).padStart(4, '0')) : undefined;
