// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original image-dictionary interpretation, ISO 32000-1 clauses 7.4.9 and 8.9.
import { PdfEngineError } from './native-reader.js';
import { resolvePdfColorSpace } from './color-spaces.js';
import { parseIccProfile } from './icc-color.js';
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const unsupported = message => { throw new PdfEngineError(message); };
const clamp = value => Math.max(0, Math.min(1, value));

export async function interpretJpxImage(reader, id, decoded, { resources, loadAsset, stencil = false } = {}) {
  const { components, bits, channels: definitions = [], embeddedColorSpace: color } = decoded;
  const alpha = [], ignored = new Set(), seen = new Set(), associations = new Map();
  for (const { channel, type, association } of definitions) {
    if (!Number.isInteger(channel) || channel < 0 || channel >= components || seen.has(channel)) corrupt('Invalid or duplicate JPEG2000 channel definition.');
    seen.add(channel);
    if (type === 1 || type === 2) { if (association !== 0) unsupported('JPEG2000 per-color opacity channels are not implemented yet.'); alpha.push({ channel, type }); }
    else if (type === 65535) ignored.add(channel);
    else if (type === 0) { if (association) { if (associations.has(association)) corrupt('Duplicate JPEG2000 color-channel association.'); associations.set(association, channel); } }
    else unsupported(`JPEG2000 channel type ${type} is not implemented yet.`);
  }
  if (alpha.length > 1) corrupt('JPEG2000 image has multiple opacity channels.');
  const excluded = new Set([...ignored, ...alpha.map(item => item.channel)]), channels = Array.from({ length: components }, (_, i) => i).filter(i => !excluded.has(i));
  if (!channels.length) corrupt('JPEG2000 image has no color channels.');
  if (associations.size) {
    if (associations.size !== channels.length || channels.some((_, i) => !associations.has(i + 1))) corrupt('Incomplete JPEG2000 color-channel associations.');
    channels.splice(0, channels.length, ...channels.map((_, i) => associations.get(i + 1)));
  }
  const smask = reader.number(reader.field(id, 'SMaskInData'), 0);
  if (![0, 1, 2].includes(smask)) corrupt('Invalid PDF SMaskInData value.');
  if (smask && alpha.length !== 1) corrupt('PDF SMaskInData requires one JPEG2000 opacity channel.');
  if (stencil && (channels.length !== 1 || (decoded.sourcePrecision?.[channels[0]] ?? bits) !== 1 || smask)) corrupt('JPEG2000 stencil must contain one one-bit color channel.');
  const colorId = reader.field(id, 'ColorSpace'); let space;
  if (stencil) space = await resolvePdfColorSpace(reader, resources, 'DeviceGray', loadAsset);
  else if (colorId) space = await resolvePdfColorSpace(reader, resources, colorId, loadAsset);
  else if (color?.method === 2) {
    const profile = parseIccProfile(color.profile); space = { name: 'ICCBased', components: profile.channels, profileBytes: color.profile, convert: values => profile.convert(values) };
  } else if (color?.method === 1 && color.enumeration === 18) {
    const center = channel => { const precision = decoded.sourcePrecision?.[channels[channel]] ?? bits; return 2 ** (precision - 1) / (2 ** precision - 1); }, cbCenter = center(1), crCenter = center(2);
    space = { name: 'sYCC', components: 3, convert: ([y, cb, cr]) => [y + 1.402 * (cr - crCenter), y - .344136 * (cb - cbCenter) - .714136 * (cr - crCenter), y + 1.772 * (cb - cbCenter)].map(clamp) };
  } else {
    const enumeration = color?.enumeration, name = enumeration === 16 ? 'DeviceRGB' : enumeration === 17 ? 'DeviceGray' : ({ 1: 'DeviceGray', 3: 'DeviceRGB', 4: 'DeviceCMYK' })[channels.length];
    if (!name) unsupported('This JPEG2000 embedded color space is not implemented yet.');
    space = await resolvePdfColorSpace(reader, resources, name, loadAsset);
  }
  if (space.components !== channels.length) corrupt('JPEG2000 and PDF color component counts disagree.');
  return { space, channels, alphaChannel: smask ? alpha[0].channel : null, premultiplied: smask === 2 };
}
