// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { decodePdfStream } from './streams.js';
import { parseIccProfile, xyzD50ToRgb, labToXyz, adaptXyzToD50, rgbToXyzD50 } from './icc-color.js';
import { readPdfFunction, compilePdfFunction } from './pdf-functions.js';
const clamp = n => Math.max(0, Math.min(1, n));
export function deviceRgb() { return { name: 'DeviceRGB', components: 3, convert: values => values.map(clamp), toXyz: rgbToXyzD50 }; }
export function deviceGray() { return { name: 'DeviceGray', components: 1, convert: values => [clamp(values[0]), clamp(values[0]), clamp(values[0])], toXyz: values => rgbToXyzD50([values[0], values[0], values[0]]) }; }
export async function resolvePdfColorSpace(reader, resources, value, loadAsset, depth = 0, blendProfileCache = null, activeDefaults = new Set()) {
  if (depth > 8) throw new PdfEngineError('PDF color-space nesting limit exceeded.', 'pdf_limit');
  const name = typeof value === 'string' ? value : reader.name(value);
  if (['DeviceRGB', 'DeviceGray', 'DeviceCMYK'].includes(name) && !activeDefaults.has(name)) {
    const spaces = resources && reader.field(resources, 'ColorSpace'), replacement = spaces && reader.node(spaces).kind !== 'null' && reader.field(spaces, name.replace('Device', 'Default'));
    if (replacement && reader.node(replacement).kind !== 'null') {
      // A default selects its replacement once; an underlying device space
      // within that definition must not select the same default again.
      const result = await resolvePdfColorSpace(reader, resources, replacement, loadAsset, depth + 1, blendProfileCache, new Set([...activeDefaults, name]));
      if (result.components !== ({ DeviceRGB: 3, DeviceGray: 1, DeviceCMYK: 4 })[name] || result.indexed || result.name === 'Lab') throw new PdfEngineError('Invalid default PDF color space.', 'pdf_corrupt');
      return result;
    }
  }
  if (name === 'DeviceRGB') return deviceRgb(); if (name === 'DeviceGray') return deviceGray();
  if (name === 'DeviceCMYK') { const profile = parseIccProfile(await loadAsset('iccs/CGATS001Compat-v2-micro.icc')); return { name, components: 4, toXyz: values => profile.toXyz(values.map(clamp)), convert: values => profile.convert(values.map(clamp)) }; }
  if (name) {
    if (name === 'Pattern') throw new PdfEngineError('PDF pattern color spaces are not implemented yet.');
    const dictionary = reader.field(resources, 'ColorSpace'), target = dictionary && reader.field(dictionary, name);
    if (!target) throw new PdfEngineError(`Unknown PDF color space /${name}.`, 'pdf_corrupt'); return resolvePdfColorSpace(reader, resources, target, loadAsset, depth + 1, blendProfileCache, activeDefaults);
  }
  const array = reader.array(value), kind = reader.name(array[0]);
  if (kind === 'DeviceN') {
    if (![4, 5].includes(array.length)) throw new PdfEngineError('Invalid PDF DeviceN color space.', 'pdf_corrupt');
    const colorants = reader.array(array[1]).map(id => reader.name(id));
    if (!colorants.length || colorants.some(name => !name || name === 'All')
      || new Set(colorants.filter(name => name !== 'None')).size !== colorants.filter(name => name !== 'None').length) throw new PdfEngineError('Invalid PDF DeviceN colorant names.', 'pdf_corrupt');
    if (colorants.length > 4) throw new PdfEngineError('PDF DeviceN tint dimensional limit exceeded.', 'pdf_limit');
    if (colorants.every(name => name === 'None')) throw new PdfEngineError('PDF DeviceN all-None painting is not implemented yet.');
    if (array.length === 5) {
      if (reader.node(array[4]).kind !== 'dictionary') throw new PdfEngineError('Invalid PDF DeviceN attributes.', 'pdf_corrupt');
      const subtypeId = reader.field(array[4], 'Subtype'), subtype = subtypeId && reader.node(subtypeId).kind !== 'null' ? reader.name(subtypeId) : 'DeviceN';
      if (!['DeviceN', 'NChannel'].includes(subtype) || subtype === 'NChannel' && colorants.includes('None')) throw new PdfEngineError('Invalid PDF DeviceN subtype.', 'pdf_corrupt');
    }
    const alternate = await resolvePdfColorSpace(reader, resources, array[2], loadAsset, depth + 1, blendProfileCache, activeDefaults);
    if (!['DeviceRGB', 'DeviceGray', 'DeviceCMYK', 'ICCBased', 'CalRGB', 'CalGray', 'Lab'].includes(alternate.name)) throw new PdfEngineError('Invalid PDF DeviceN alternate color space.', 'pdf_corrupt');
    const descriptor = await readPdfFunction(reader, array[3]);
    if (descriptor.inputs !== colorants.length || descriptor.outputs !== alternate.components) throw new PdfEngineError('PDF DeviceN tint function dimensions disagree.', 'pdf_corrupt');
    const transform = compilePdfFunction(descriptor), tint = values => {
      if (!values || values.length !== colorants.length || Array.from(values).some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid PDF DeviceN tint.', 'pdf_corrupt');
      return transform(Array.from(values, clamp));
    };
    // Composite display uses the declared alternate, including NChannel's fallback.
    return { name: kind, colorants, components: colorants.length, tintTransform: descriptor, alternate, initialValues: colorants.map(() => 1),
      toXyz: values => alternate.toXyz(tint(values)), convert: values => alternate.convert(tint(values)) };
  }
  if (kind === 'Separation') {
    const colorant = reader.name(array[1]);
    if (array.length !== 4 || !colorant) throw new PdfEngineError('Invalid PDF Separation color space.', 'pdf_corrupt');
    if (colorant === 'None') throw new PdfEngineError('PDF Separation /None colorant is not implemented yet.');
    const inputTint = values => {
      if (!values || values.length !== 1 || !Number.isFinite(values[0])) throw new PdfEngineError('Invalid PDF Separation tint.', 'pdf_corrupt');
      return clamp(values[0]);
    };
    if (colorant === 'All') {
      if (!['name', 'array'].includes(reader.node(array[2]).kind) || !['dictionary', 'stream'].includes(reader.node(array[3]).kind)) throw new PdfEngineError('Invalid PDF Separation parameters.', 'pdf_corrupt');
      // All applies subtractive tint to every display channel, independently of its alternate and transform.
      const gray = deviceGray(), values = source => [1 - inputTint(source)];
      return { name: kind, colorant, components: 1, initialValues: [1], toXyz: source => gray.toXyz(values(source)), convert: source => gray.convert(values(source)) };
    }
    const alternate = await resolvePdfColorSpace(reader, resources, array[2], loadAsset, depth + 1, blendProfileCache, activeDefaults);
    if (!['DeviceRGB', 'DeviceGray', 'DeviceCMYK', 'ICCBased', 'CalRGB', 'CalGray', 'Lab'].includes(alternate.name)) throw new PdfEngineError('Invalid PDF Separation alternate color space.', 'pdf_corrupt');
    const descriptor = await readPdfFunction(reader, array[3]);
    if (descriptor.inputs !== 1 || descriptor.outputs !== alternate.components) throw new PdfEngineError('PDF Separation tint function dimensions disagree.', 'pdf_corrupt');
    const transform = compilePdfFunction(descriptor);
    const tint = values => {
      const result = transform([inputTint(values)]);
      if (result.some(n => !Number.isFinite(n))) throw new PdfEngineError('Non-finite PDF Separation color.', 'pdf_corrupt');
      return result;
    };
    return { name: kind, colorant, components: 1, initialValues: [1], alternate, tintTransform: descriptor,
      toXyz: values => alternate.toXyz(tint(values)), convert: values => alternate.convert(tint(values)) };
  }
  if (kind === 'ICCBased') {
    if (array.length !== 2) throw new PdfEngineError('Invalid PDF ICCBased color space.', 'pdf_corrupt');
    const data = array[1], identity = reader.node(data).id, cached = blendProfileCache?.get(identity); if (cached) return cached.space;
    const budgetError = () => { throw new PdfEngineError('PDF page blend profile budget exceeded.', 'pdf_limit'); };
    if (blendProfileCache?.size >= 256) budgetError();
    const n = reader.number(reader.field(data, 'N')), profileBytes = (await decodePdfStream(reader, data)).bytes;
    const entries = blendProfileCache ? [...blendProfileCache.values()] : [];
    let decodedBytes = profileBytes.byteLength, priorComparisons = 0, comparedBytes = 0;
    for (const entry of entries) { decodedBytes += entry.decodedBytes; priorComparisons += entry.comparisonBytes; }
    if (blendProfileCache && decodedBytes > 32 * 1024 * 1024) budgetError();
    let canonical = null; const seen = new Set();
    for (const { space } of entries) {
      if (seen.has(space)) continue; seen.add(space);
      if (space.profileBytes.byteLength !== profileBytes.byteLength) continue;
      let equal = true;
      for (let at = 0; at < profileBytes.byteLength; at++) {
        if (priorComparisons + ++comparedBytes > 32 * 1024 * 1024) budgetError();
        if (profileBytes[at] !== space.profileBytes[at]) { equal = false; break; }
      }
      if (equal) { canonical = space; break; }
    }
    const profile = canonical?.profile || parseIccProfile(profileBytes); if (n !== profile.channels) throw new PdfEngineError('ICC/PDF component counts disagree.', 'pdf_corrupt');
    const rangeId = reader.field(data, 'Range'); if (rangeId && reader.node(rangeId).kind !== 'null') { const range = reader.array(rangeId).map(id => reader.number(id, NaN)); if (range.length !== n * 2 || range.some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid ICC input range.', 'pdf_corrupt'); if (range.some((v, i) => v !== i % 2)) throw new PdfEngineError('Non-default PDF ICC input ranges are not implemented yet.'); }
    const space = canonical || { name: kind, components: n, profileIdentity: identity, profileBytes, profile, toXyz: profile.toXyz, convert: values => profile.convert(values) };
    // Charge every decoded identity, even if only its canonical owned bytes remain.
    blendProfileCache?.set(identity, { space, decodedBytes: profileBytes.byteLength, comparisonBytes: comparedBytes }); return space;
  }
  if (kind === 'Indexed' || kind === 'I') {
    const base = await resolvePdfColorSpace(reader, resources, array[1], loadAsset, depth + 1, blendProfileCache, activeDefaults), high = reader.number(array[2], -1), table = reader.node(array[3]);
    if (!Number.isInteger(high) || high < 0 || high > 255) throw new PdfEngineError('Invalid indexed color range.', 'pdf_corrupt');
    const source = table.kind === 'stream' ? (await decodePdfStream(reader, table.id)).bytes : reader.bytes(table);
    if (source.length < (high + 1) * base.components) throw new PdfEngineError('Truncated indexed PDF color table.', 'pdf_corrupt');
    const lookup = source.slice(0, (high + 1) * base.components);
    const samples = values => { const index = Math.max(0, Math.min(high, Math.round(values[0]))); return Array.from(lookup.subarray(index * base.components, (index + 1) * base.components), n => n / 255); };
    return { name: kind, components: 1, indexed: true, base, high, lookup,
      toXyz: values => base.toXyz(samples(values)), convert: values => base.convert(samples(values)) };
  }
  if (['CalRGB', 'CalGray', 'Lab'].includes(kind)) {
    const parameters = array[1], get = (key, fallback) => { const id = reader.field(parameters, key); return id ? reader.array(id).map(id => reader.number(id, NaN)) : fallback; };
    const white = get('WhitePoint', null); if (!white || white.length !== 3 || white.some(n => !Number.isFinite(n) || n <= 0) || white[1] !== 1) throw new PdfEngineError('Invalid calibrated PDF white point.', 'pdf_corrupt');
    const black = get('BlackPoint', [0, 0, 0]); if (black.length !== 3 || black.some(n => !Number.isFinite(n) || n < 0)) throw new PdfEngineError('Invalid calibrated PDF black point.', 'pdf_corrupt');
    if (black.some(n => n !== 0)) throw new PdfEngineError('Calibrated PDF black-point compensation is not implemented yet.');
    const toD50 = xyz => adaptXyzToD50(xyz, white);
    if (kind === 'Lab') {
      const range = get('Range', [-100, 100, -100, 100]); if (range.length !== 4 || range.some(n => !Number.isFinite(n)) || range[0] > range[1] || range[2] > range[3]) throw new PdfEngineError('Invalid PDF Lab range.', 'pdf_corrupt');
      const toXyz = values => toD50(labToXyz([clamp(values[0] / 100) * 100, Math.max(range[0], Math.min(range[1], values[1])), Math.max(range[2], Math.min(range[3], values[2]))], white));
      return { name: kind, components: 3, decodeRanges: [0, 100, ...range], toXyz, convert: values => xyzD50ToRgb(toXyz(values)) };
    }
    const matrix = get('Matrix', [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const gamma = kind === 'CalGray' ? [reader.number(reader.field(parameters, 'Gamma'), 1)] : get('Gamma', [1, 1, 1]);
    if (gamma.length !== (kind === 'CalGray' ? 1 : 3) || gamma.some(n => !Number.isFinite(n) || n <= 0) || matrix.length !== 9 || matrix.some(n => !Number.isFinite(n))) throw new PdfEngineError('Invalid calibrated PDF gamma or matrix.', 'pdf_corrupt');
    if (kind === 'CalGray') { const toXyz = values => toD50(white.map(n => n * clamp(values[0]) ** gamma[0])); return { name: kind, components: 1, toXyz, convert: values => xyzD50ToRgb(toXyz(values)) }; }
    const toXyz = values => { const linear = values.map((n, i) => clamp(n) ** gamma[i]); return toD50([0, 1, 2].map(row => linear[0] * matrix[row] + linear[1] * matrix[row + 3] + linear[2] * matrix[row + 6])); };
    return { name: kind, components: 3, toXyz, convert: values => xyzD50ToRgb(toXyz(values)) };
  }
  throw new PdfEngineError(`PDF color space ${kind} is not implemented yet.`);
}
