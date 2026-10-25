// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded JPEG2000 reader, normative format: ITU-T T.800 (11/2015).
import { PdfEngineError } from './native-reader.js';
import { PacketBits, TagTree, codingPassCount } from './jpx-bitstream.js';
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const unsupported = message => { throw new PdfEngineError(message); };
const MAX_PIXELS = 16 * 1024 * 1024, MAX_BYTES = 32 * 1024 * 1024;

export function parseJpxContainer(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.length > 128 * 1024 * 1024) corrupt('Invalid JPEG2000 input.');
  if (bytes[0] === 255 && bytes[1] === 79) return { codestream: bytes, color: null, channels: [], palette: null, mappings: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = { codestream: null, color: null, channels: [], palette: null, mappings: null };
  const text = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  let signature = false;
  function boxes(start, end, depth) {
    if (depth > 4) corrupt('JPEG2000 box nesting exceeds its limit.');
    for (let at = start; at < end;) {
      if (at + 8 > end) corrupt('Truncated JPEG2000 box.');
      let length = view.getUint32(at), header = 8; const type = text(at + 4);
      if (length === 1) {
        if (at + 16 > end || view.getUint32(at + 8)) corrupt('Oversized JPEG2000 box.');
        length = view.getUint32(at + 12); header = 16;
      } else if (length === 0) length = end - at;
      if (length < header || length > end - at) corrupt('JPEG2000 box exceeds its container.');
      const body = at + header, finish = at + length;
      if (type === 'jP  ') { if (signature || length !== 12 || view.getUint32(body) !== 0x0d0a870a) corrupt('Invalid JPEG2000 signature.'); signature = true; }
      else if (type === 'jp2h') boxes(body, finish, depth + 1);
      else if (type === 'jp2c') { if (result.codestream) unsupported('Multiple JPEG2000 codestreams are not implemented yet.'); result.codestream = bytes.subarray(body, finish); }
      else if (type === 'colr') {
        if (finish - body < 3) corrupt('Truncated JPEG2000 color specification.');
        const method = bytes[body], precedence = bytes[body + 1];
        if (method === 1 && finish - body !== 7) corrupt('Invalid enumerated JPEG2000 color specification.');
        if (method === 2 && finish - body < 131) corrupt('Truncated JPEG2000 ICC profile.');
        if (![1, 2].includes(method)) unsupported('This JPEG2000 color specification method is not implemented yet.');
        if (!result.color || precedence < result.color.precedence) result.color = method === 1
          ? { method, precedence, enumeration: view.getUint32(body + 3) } : { method, precedence, profile: bytes.subarray(body + 3, finish).slice() };
      } else if (type === 'cdef') {
        if (finish - body < 2 || finish - body !== 2 + view.getUint16(body) * 6) corrupt('Invalid JPEG2000 channel definition.');
        for (let p = body + 2; p < finish; p += 6) result.channels.push({ channel: view.getUint16(p), type: view.getUint16(p + 2), association: view.getUint16(p + 4) });
      } else if (type === 'pclr') {
        if (result.palette || finish - body < 4) corrupt('Invalid JPEG2000 palette.');
        const entries = view.getUint16(body), columns = bytes[body + 2];
        if (!entries || !columns || columns > 16 || body + 3 + columns > finish) corrupt('Invalid JPEG2000 palette dimensions.');
        const formats = Array.from(bytes.subarray(body + 3, body + 3 + columns), value => ({ bits: (value & 127) + 1, signed: !!(value & 128) }));
        if (formats.some(format => format.bits > 16)) unsupported('JPEG2000 palettes wider than 16 bits are not implemented yet.');
        const rowBytes = formats.reduce((sum, format) => sum + Math.ceil(format.bits / 8), 0);
        if (body + 3 + columns + entries * rowBytes !== finish) corrupt('Truncated JPEG2000 palette values.');
        let p = body + 3 + columns;
        const values = Array.from({ length: columns }, () => new Int32Array(entries));
        for (let row = 0; row < entries; row++) for (let column = 0; column < columns; column++) {
          const { bits, signed } = formats[column], length = Math.ceil(bits / 8); let value = 0;
          for (let i = 0; i < length; i++) value = value * 256 + bytes[p++];
          value &= 2 ** bits - 1;
          values[column][row] = signed && value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
        }
        result.palette = { entries, formats, values };
      } else if (type === 'cmap') {
        if (result.mappings || finish === body || (finish - body) % 4 || finish - body > 64) corrupt('Invalid JPEG2000 component mappings.');
        result.mappings = [];
        for (let p = body; p < finish; p += 4) result.mappings.push({ component: view.getUint16(p), type: bytes[p + 2], column: bytes[p + 3] });
      }
      at = finish;
    }
  }
  boxes(0, bytes.length, 0);
  if (!signature || !result.codestream) corrupt('JPEG2000 signature or codestream is missing.');
  if (result.palette && !result.mappings) corrupt('JPEG2000 palette has no component mapping.');
  return result;
}

function mapChannels(container, bytes, geometry) {
  const sourcePrecision = geometry.sourcePrecision || new Array(geometry.components).fill(geometry.bits);
  const sourceSigned = geometry.sourceSigned || new Array(geometry.components).fill(false);
  if (!container.mappings) return { bytes, ...geometry, sourcePrecision, sourceSigned };
  const { mappings, palette } = container, { width, height, components, bits } = geometry;
  const formats = mappings.map(mapping => {
    if (mapping.component >= components || mapping.type > 1 || !mapping.type && mapping.column || mapping.type && (!palette || mapping.column >= palette.formats.length)) corrupt('Invalid JPEG2000 channel mapping target.');
    return mapping.type ? palette.formats[mapping.column] : { bits: sourcePrecision[mapping.component], signed: sourceSigned[mapping.component] };
  });
  const outputBits = formats.some(format => format.bits > 8) ? 16 : 8, maximum = 2 ** outputBits - 1;
  if (width * height * mappings.length * outputBits / 8 > MAX_BYTES) throw new PdfEngineError('JPEG2000 palette output exceeds its byte limit.', 'pdf_limit');
  const output = new Uint8Array(width * height * mappings.length * outputBits / 8);
  for (let pixel = 0; pixel < width * height; pixel++) for (let channel = 0; channel < mappings.length; channel++) {
    const mapping = mappings[channel], format = formats[channel], index = (pixel * components + mapping.component) * bits / 8;
    let value = bits === 16 ? bytes[index] * 256 + bytes[index + 1] : bytes[index];
    if (mapping.type) {
      const precision = sourcePrecision[mapping.component];
      value = Math.round(value * (2 ** precision - 1) / (2 ** bits - 1)) - (sourceSigned[mapping.component] ? 2 ** (precision - 1) : 0);
      if (value < 0 || value >= palette.entries) corrupt('JPEG2000 palette index exceeds its table.');
      value = palette.values[mapping.column][value];
      if (format.signed) value += 2 ** (format.bits - 1);
      value = Math.round(value * maximum / (2 ** format.bits - 1));
    } else {
      value = Math.round(value * maximum / (2 ** bits - 1));
    }
    const at = (pixel * mappings.length + channel) * outputBits / 8;
    if (outputBits === 16) { output[at] = value >> 8; output[at + 1] = value & 255; } else output[at] = value;
  }
  return { bytes: output, width, height, components: mappings.length, bits: outputBits,
    sourcePrecision: formats.map(format => format.bits), sourceSigned: formats.map(format => format.signed) };
}

export function decodeJpxBlock(reader, data, { width, height, orientation, bitplanes, passes, style, irreversible = false, segments = null }) {
  reader.check(); reader.api.pn_pdf_mark();
  try {
    const input = reader.copy(data), output = reader.checked(reader.api.pn_pdf_alloc(width * height * 4)), scratch = reader.checked(reader.api.pn_pdf_alloc(width * height));
    const args = [input, data.length, width, height, orientation, bitplanes, passes, style, output, scratch, irreversible ? 1 : 0];
    const descriptors = segments && Uint32Array.from(segments.flatMap(segment => [segment.bytes, segment.passes]));
    const status = descriptors ? reader.api.pn_pdf_jpx_block_segments(...args, reader.copy(new Uint8Array(descriptors.buffer)), segments.length)
      : reader.api.pn_pdf_jpx_block(...args);
    if (status === 3) unsupported('This JPEG2000 code-block coding style is not implemented yet.');
    if (status === 2) throw new PdfEngineError('JPEG2000 code-block resource limit exceeded.', 'pdf_limit');
    if (status) corrupt('Invalid JPEG2000 code-block arithmetic data.');
    const ArrayType = irreversible ? Float32Array : Int32Array;
    return new ArrayType(reader.api.memory.buffer, output, width * height).slice();
  } finally { reader.api.pn_pdf_rewind(); }
}

function inverseWavelet(reader, samples, width, height, irreversible, xOrigin, yOrigin) {
  reader.check(); reader.api.pn_pdf_mark();
  try {
    const pointer = reader.copy(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    const status = irreversible ? reader.api.pn_pdf_jpx_inverse97(pointer, width, height, xOrigin, yOrigin) : reader.api.pn_pdf_jpx_inverse53(pointer, width, height, xOrigin, yOrigin);
    if (status) corrupt('JPEG2000 wavelet reconstruction exceeds its numeric range.');
    const ArrayType = irreversible ? Float32Array : Int32Array;
    return new ArrayType(reader.api.memory.buffer, pointer, width * height).slice();
  } finally { reader.api.pn_pdf_rewind(); }
}

function resolutionBands(width, height, levels, coding, tileX, tileY) {
  return Array.from({ length: levels + 1 }, (_, resolution) => {
    const scale = 2 ** (levels - resolution), originX = Math.ceil(tileX / scale), originY = Math.ceil(tileY / scale);
    const right = Math.ceil((tileX + width) / scale), bottom = Math.ceil((tileY + height) / scale), w = right - originX, h = bottom - originY;
    const [precinctWidth, precinctHeight] = coding.precincts[resolution];
    const precincts = [];
    for (let py = Math.floor(originY / precinctHeight); py < Math.ceil((originY + h) / precinctHeight); py++) for (let px = Math.floor(originX / precinctWidth); px < Math.ceil((originX + w) / precinctWidth); px++) {
      precincts.push({ px, py, x: Math.max(originX, px * precinctWidth) * scale, y: Math.max(originY, py * precinctHeight) * scale });
    }
    const shapes = (resolution ? [1, 2, 3] : [0]).map(orientation => {
      if (!resolution) return [w, h, originX, originY];
      const xRound = orientation & 1 ? Math.floor : Math.ceil, yRound = orientation & 2 ? Math.floor : Math.ceil;
      const x = xRound(originX / 2), y = yRound(originY / 2);
      return [xRound(right / 2) - x, yRound(bottom / 2) - y, x, y];
    });
    return { width: w, height: h, originX, originY, precincts, bands: shapes.map(([width, height, bandX, bandY], index) => {
      const divisor = resolution ? 2 : 1;
      const groupWidth = precinctWidth / divisor, groupHeight = precinctHeight / divisor;
      const blockWidth = Math.min(coding.blockWidth, groupWidth), blockHeight = Math.min(coding.blockHeight, groupHeight);
      const firstColumn = Math.floor(bandX / blockWidth), firstRow = Math.floor(bandY / blockHeight);
      const columns = width ? Math.ceil((bandX + width) / blockWidth) - firstColumn : 0, rows = height ? Math.ceil((bandY + height) / blockHeight) - firstRow : 0;
      const blocks = Array.from({ length: columns * rows }, (_, block) => {
        const left = Math.max(bandX, (firstColumn + block % columns) * blockWidth), top = Math.max(bandY, (firstRow + Math.floor(block / columns)) * blockHeight);
        return { passes: 0, lengthBits: 3, segments: [], bytes: 0, x: left - bandX, y: top - bandY,
          width: Math.min(bandX + width, (firstColumn + block % columns + 1) * blockWidth) - left,
          height: Math.min(bandY + height, (firstRow + Math.floor(block / columns) + 1) * blockHeight) - top };
      });
      const groups = precincts.map(({ px, py }) => {
        const left = Math.max(bandX, px * groupWidth), top = Math.max(bandY, py * groupHeight), right = Math.min(bandX + width, (px + 1) * groupWidth), bottom = Math.min(bandY + height, (py + 1) * groupHeight);
        if (right <= left || bottom <= top) return null;
        const startColumn = Math.floor(left / blockWidth), startRow = Math.floor(top / blockHeight);
        const columns = Math.ceil(right / blockWidth) - startColumn, rows = Math.ceil(bottom / blockHeight) - startRow;
        return { startColumn: startColumn - firstColumn, startRow: startRow - firstRow, columns, rows,
          inclusion: new TagTree(columns, rows), zeros: new TagTree(columns, rows) };
      });
      return { width, height, originX: bandX, originY: bandY, orientation: resolution ? index + 1 : 0,
        quantizationIndex: resolution ? (resolution - 1) * 3 + index + 1 : 0, columns, rows, groups, blocks,
        samples: coding.irreversible ? new Float32Array(width * height) : new Int32Array(width * height) };
    }) };
  });
}

function reconstruct(reader, resolutions, irreversible) {
  let previous = resolutions[0].bands[0].samples;
  for (let resolution = 1; resolution < resolutions.length; resolution++) {
    const current = resolutions[resolution], low = resolutions[resolution - 1], samples = irreversible ? new Float32Array(current.width * current.height) : new Int32Array(current.width * current.height);
    const bands = [{ samples: previous, width: low.width, height: low.height, originX: low.originX, originY: low.originY, orientation: 0 }, ...current.bands];
    for (const band of bands) for (let y = 0; y < band.height; y++) for (let x = 0; x < band.width; x++) {
      samples[((band.originY + y) * 2 + (band.orientation >> 1) - current.originY) * current.width + (band.originX + x) * 2 + (band.orientation & 1) - current.originX] = band.samples[y * band.width + x];
    }
    previous = current.width && current.height ? inverseWavelet(reader, samples, current.width, current.height, irreversible, current.originX, current.originY) : samples;
  }
  return previous;
}

function parseCodestream(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2, geometry, mainCoding, mainQuantization, active = null, ended = false;
  const ids = new Map();
  if (view.getUint16(0) !== 0xff4f) corrupt('JPEG2000 SOC marker is missing.');
  for (let markers = 0; at < bytes.length; markers++) {
    if (markers > 65536 || at + 2 > bytes.length) corrupt('JPEG2000 marker limit exceeded.');
    const start = at, marker = view.getUint16(at); at += 2;
    if (marker === 0xffd9) { if (active || at !== bytes.length) corrupt('Invalid JPEG2000 end marker.'); ended = true; break; }
    if (marker === 0xff93) {
      if (!active || !active.coding || !active.quantization || at > active.tileEnd) corrupt('Incomplete JPEG2000 tile header.');
      active.packetStart = at; ids.get(active.id).parts.push(active); at = active.tileEnd; active = null; continue;
    }
    if (at + 2 > bytes.length) corrupt('Truncated JPEG2000 marker length.');
    const length = view.getUint16(at), body = at + 2, end = at + length;
    if (length < 2 || end > bytes.length) corrupt('JPEG2000 marker exceeds input.');
    if (marker === 0xff51) {
      if (geometry || length < 41) corrupt('Invalid JPEG2000 SIZ marker.');
      const components = view.getUint16(body + 34), x0 = view.getUint32(body + 10), y0 = view.getUint32(body + 14);
      const x1 = view.getUint32(body + 2), y1 = view.getUint32(body + 6), width = x1 - x0, height = y1 - y0;
      if (length !== 38 + components * 3 || !components || components > 16 || width < 1 || height < 1 || width * height > MAX_PIXELS) corrupt('Invalid JPEG2000 image dimensions.');
      const tileWidth = view.getUint32(body + 18), tileHeight = view.getUint32(body + 22), tileX0 = view.getUint32(body + 26), tileY0 = view.getUint32(body + 30);
      if (!tileWidth || !tileHeight || tileX0 > x0 || tileY0 > y0 || tileX0 + tileWidth <= x0 || tileY0 + tileHeight <= y0) corrupt('Invalid JPEG2000 tile grid origin.');
      const tileColumns = Math.ceil((x1 - tileX0) / tileWidth), tileRows = Math.ceil((y1 - tileY0) / tileHeight);
      if (tileColumns * tileRows > 4096) corrupt('JPEG2000 tile count exceeds its limit.');
      const precision = [], signed = [];
      for (let i = 0; i < components; i++) {
        const p = body + 36 + i * 3, bits = (bytes[p] & 127) + 1;
        if (bits > 16 || bytes[p + 1] !== 1 || bytes[p + 2] !== 1) unsupported('JPEG2000 wide/subsampled components are not implemented yet.');
        precision.push(bits); signed.push(!!(bytes[p] & 128));
      }
      const bits = precision.some(bits => bits > 8) ? 16 : 8;
      if (width * height * components * bits / 8 > MAX_BYTES) throw new PdfEngineError('JPEG2000 decoded byte limit exceeded.', 'pdf_limit');
      geometry = { width, height, x0, y0, x1, y1, tileX0, tileY0, tileWidth, tileHeight, tileColumns, tileRows, components, bits, sourcePrecision: precision, sourceSigned: signed };
    } else if (marker === 0xff52) {
      if (active?.partNumber) corrupt('JPEG2000 COD is only valid in a first tile-part header.');
      if (length < 12) corrupt('Truncated JPEG2000 COD marker.');
      const levels = bytes[body + 5], blockWidth = 2 ** (bytes[body + 6] + 2), blockHeight = 2 ** (bytes[body + 7] + 2);
      const flags = bytes[body], progression = bytes[body + 1], layers = view.getUint16(body + 2);
      if (levels > 30 || flags & ~7 || progression > 4 || !layers || layers > 256 || bytes[body + 9] > 1) unsupported('JPEG2000 nondefault packets are not implemented yet.');
      if (blockWidth > 1024 || blockHeight > 1024 || blockWidth * blockHeight > 4096 || length !== 12 + (flags & 1 ? levels + 1 : 0)) corrupt('Invalid JPEG2000 code-block size.');
      if (bytes[body + 4] > 1) corrupt('Invalid JPEG2000 component transform.');
      const precincts = Array.from({ length: levels + 1 }, (_, resolution) => {
        const value = flags & 1 ? bytes[body + 10 + resolution] : 255, px = value & 15, py = value >> 4;
        if (resolution && (!px || !py)) corrupt('Invalid JPEG2000 precinct exponent.');
        return [2 ** px, 2 ** py];
      });
      const coding = { blockWidth, blockHeight, levels, layers, progression, precincts, flags, irreversible: bytes[body + 9] === 0, style: bytes[body + 8], mct: bytes[body + 4] };
      if (active) active.coding = coding; else mainCoding = coding;
    } else if (marker === 0xff5c) {
      if (active?.partNumber) corrupt('JPEG2000 QCD is only valid in a first tile-part header.');
      const style = bytes[body] & 31;
      if (length < 4 || style > 2 || style && (length - 3) % 2 || style === 1 && length !== 5) corrupt('Invalid JPEG2000 quantization marker.');
      const steps = [];
      for (let p = body + 1; p < end; p += style ? 2 : 1) {
        const value = style ? view.getUint16(p) : bytes[p] << 8;
        steps.push({ exponent: value >> 11, mantissa: style ? value & 2047 : 0 });
      }
      const quantization = { guard: bytes[body] >> 5, style, steps };
      if (active) active.quantization = quantization; else mainQuantization = quantization;
    } else if (marker === 0xff90) {
      if (active || length !== 10 || !geometry || !mainCoding || !mainQuantization) corrupt('Invalid JPEG2000 tile header.');
      const id = view.getUint16(body), columns = geometry.tileColumns, rows = geometry.tileRows;
      const partNumber = bytes[body + 6], declared = bytes[body + 7];
      if (id >= columns * rows) corrupt('Invalid JPEG2000 tile index.');
      let state = ids.get(id);
      if (!state) { state = { next: 0, declared, first: null, parts: [] }; ids.set(id, state); }
      if (partNumber !== state.next || declared && state.declared && declared !== state.declared || declared && partNumber >= declared) corrupt('Invalid JPEG2000 tile-part sequence.');
      if (state.next >= 256) corrupt('JPEG2000 tile-part count exceeds its limit.');
      state.next++; state.declared ||= declared;
      let tileEnd = view.getUint32(body + 2); tileEnd = tileEnd ? tileEnd + start : bytes.length - 2;
      if (tileEnd > bytes.length - 2 || tileEnd <= end) corrupt('Invalid JPEG2000 tile-part length.');
      const gridX = geometry.tileX0 + id % columns * geometry.tileWidth, gridY = geometry.tileY0 + Math.floor(id / columns) * geometry.tileHeight;
      const x = Math.max(geometry.x0, gridX), y = Math.max(geometry.y0, gridY);
      active = { id, x, y, tileEnd, partNumber, coding: state.first?.coding || mainCoding, quantization: state.first?.quantization || mainQuantization,
        geometry: { width: Math.min(geometry.x1, gridX + geometry.tileWidth) - x, height: Math.min(geometry.y1, gridY + geometry.tileHeight) - y,
          components: geometry.components, bits: geometry.bits, sourcePrecision: geometry.sourcePrecision, sourceSigned: geometry.sourceSigned } };
      if (!partNumber) state.first = active;
    } else if (![0xff64, 0xff50].includes(marker)) unsupported(`JPEG2000 marker ${marker.toString(16)} is not implemented yet.`);
    at = end;
  }
  if (!ended || !geometry || !ids.size || ids.size !== geometry.tileColumns * geometry.tileRows) corrupt('Incomplete JPEG2000 codestream.');
  const tiles = [...ids.values()].map(state => {
    if (state.declared && state.declared !== state.next) corrupt('Missing JPEG2000 tile part.');
    return { ...state.first, parts: state.parts };
  });
  return { geometry, tiles };
}

function decodeTile(reader, bytes, tile) {
  const { geometry, coding, x, y, tileEnd } = tile;
  let { packetStart } = tile;
  let quantization = tile.quantization;
  const { width, height, components, bits } = geometry;
  if (quantization.style === 1) {
    const base = quantization.steps[0];
    quantization = { ...quantization, steps: Array.from({ length: 1 + coding.levels * 3 }, (_, index) => ({ exponent: base.exponent - (index ? Math.floor((index - 1) / 3) : 0), mantissa: base.mantissa })) };
  }
  if (quantization.steps.length !== 1 + coding.levels * 3 || quantization.steps.some(step => step.exponent < 0) || !coding.irreversible && quantization.style) corrupt('JPEG2000 quantization band count or transform disagrees with decomposition.');
  const channels = Array.from({ length: components }, () => resolutionBands(width, height, coding.levels, coding, x, y));
  const terminated = pass => !!(coding.style & 4) || !!(coding.style & 1) && pass >= 9 && (pass - 9) % 3 !== 1;
  let packetNumber = 0, partIndex = 0;
  const partEnds = tile.partEnds || [tileEnd];
  function readPacket(layer, resolution, component, precinct) {
    // T.800 A.8.1 Nsop counts packets throughout the coded tile, across parts.
    while (partIndex < partEnds.length - 1 && packetStart === partEnds[partIndex]) partIndex++;
    const packetLimit = partEnds[partIndex];
    if (packetStart >= packetLimit) corrupt('JPEG2000 packet exceeds its tile part.');
    if (coding.flags & 2 && bytes[packetStart] === 255 && bytes[packetStart + 1] === 145) {
      if (packetLimit - packetStart < 6 || bytes[packetStart + 2] !== 0 || bytes[packetStart + 3] !== 4
        || bytes[packetStart + 4] * 256 + bytes[packetStart + 5] !== (packetNumber & 65535)) corrupt('Invalid JPEG2000 SOP marker.');
      packetStart += 6;
    }
    packetNumber++;
    const packet = new PacketBits(bytes, packetStart, packetLimit), blocks = [], bands = channels[component][resolution].bands;
    if (packet.read()) for (const band of bands) {
      const group = band.groups[precinct]; if (!group) continue;
      const { columns, rows } = group;
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        const index = row * columns + column, state = band.blocks[(group.startRow + row) * band.columns + group.startColumn + column];
        if (!(state.passes ? packet.read() : group.inclusion.decode(index, layer + 1, packet))) continue;
        if (!state.passes) {
          let zeroPlanes = 0;
          while (!group.zeros.decode(index, zeroPlanes + 1, packet)) if (++zeroPlanes > 30) corrupt('Invalid JPEG2000 leading zero planes.');
          state.bitplanes = quantization.guard + quantization.steps[band.quantizationIndex].exponent - 1 - zeroPlanes;
        }
        const passes = codingPassCount(packet);
        while (packet.read()) if (++state.lengthBits > 31) corrupt('Invalid JPEG2000 code-block length.');
        if (state.passes + passes > state.bitplanes * 3 - 2) corrupt('Invalid JPEG2000 code-block pass count.');
        for (let added = 0; added < passes;) {
          let count = 1;
          while (added + count < passes && !terminated(state.passes + count - 1)) count++;
          let segment = state.segments.at(-1);
          if (!segment || terminated(segment.startPass + segment.passes - 1)) {
            segment = { startPass: state.passes, passes: 0, bytes: 0, chunks: [] }; state.segments.push(segment);
          }
          const length = packet.read(state.lengthBits + Math.floor(Math.log2(count)));
          segment.passes += count; state.passes += count; added += count;
          blocks.push({ state, segment, length });
        }
        Object.assign(state, { band, orientation: band.orientation, style: coding.style, irreversible: coding.irreversible });
      }
    }
    let payload = packet.align();
    if (coding.flags & 4) {
      if (packetLimit - payload < 2 || bytes[payload] !== 255 || bytes[payload + 1] !== 146) corrupt('Missing JPEG2000 EPH marker.');
      payload += 2;
    }
    for (const { state, segment, length } of blocks) {
      if (length > packetLimit - payload) corrupt('Truncated JPEG2000 code-block payload.');
      segment.chunks.push(bytes.subarray(payload, payload + length)); segment.bytes += length; state.bytes += length; payload += length;
    }
    packetStart = payload;
  }
  const packets = [];
  for (let component = 0; component < components; component++) for (let resolution = 0; resolution <= coding.levels; resolution++) {
    const precincts = channels[component][resolution].precincts;
    if (packets.length + precincts.length * coding.layers > 1_000_000) throw new PdfEngineError('JPEG2000 packet count exceeds its limit.', 'pdf_limit');
    for (let precinct = 0; precinct < precincts.length; precinct++) for (let layer = 0; layer < coding.layers; layer++) packets.push({ layer, resolution, component, precinct, x: precincts[precinct].x, y: precincts[precinct].y });
  }
  const keys = [['layer', 'resolution', 'component', 'precinct'], ['resolution', 'layer', 'component', 'precinct'], ['resolution', 'y', 'x', 'component', 'layer'], ['y', 'x', 'component', 'resolution', 'layer'], ['component', 'y', 'x', 'resolution', 'layer']][coding.progression];
  packets.sort((a, b) => { for (const key of keys) if (a[key] !== b[key]) return a[key] - b[key]; return 0; });
  for (const packet of packets) readPacket(packet.layer, packet.resolution, packet.component, packet.precinct);
  for (const [component, resolutions] of channels.entries()) for (const resolution of resolutions) for (const band of resolution.bands) for (const block of band.blocks) {
    if (!block.passes) continue;
    const data = new Uint8Array(block.bytes); let at = 0;
    for (const segment of block.segments) for (const chunk of segment.chunks) { data.set(chunk, at); at += chunk.length; }
    const values = decodeJpxBlock(reader, data, block), step = quantization.steps[band.quantizationIndex];
    const gain = band.orientation === 3 ? 2 : band.orientation ? 1 : 0;
    const scale = coding.irreversible ? 2 ** (geometry.sourcePrecision[component] + gain - step.exponent) * (1 + step.mantissa / 2048) : 1;
    for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) band.samples[(block.y + y) * band.width + block.x + x] = values[y * block.width + x] * scale;
  }
  if (packetStart !== tileEnd) corrupt('Unconsumed JPEG2000 tile data.');
  const result = new Uint8Array(width * height * components * bits / 8), maximum = 2 ** bits - 1;
  const planes = channels.map(resolutions => reconstruct(reader, resolutions, coding.irreversible));
  if (coding.mct && (components < 3 || geometry.sourcePrecision.slice(0, 3).some(precision => precision !== geometry.sourcePrecision[0]))) corrupt('Invalid JPEG2000 color transform components.');
  for (let pixel = 0; pixel < width * height; pixel++) {
    if (coding.mct) {
      const luminance = planes[0][pixel], blueDifference = planes[1][pixel], redDifference = planes[2][pixel];
      const green = coding.irreversible ? luminance - 0.34413 * blueDifference - 0.71414 * redDifference : luminance - Math.floor((blueDifference + redDifference) / 4);
      const red = coding.irreversible ? luminance + 1.402 * redDifference : green + redDifference;
      const blue = coding.irreversible ? luminance + 1.772 * blueDifference : green + blueDifference;
      planes[0][pixel] = red; planes[1][pixel] = green; planes[2][pixel] = blue;
    }
    for (let channel = 0; channel < components; channel++) {
      const precision = geometry.sourcePrecision[channel], sourceMaximum = 2 ** precision - 1;
      const source = Math.max(0, Math.min(sourceMaximum, Math.floor(planes[channel][pixel] + 2 ** (precision - 1) + 0.5)));
      const value = Math.round(source * maximum / sourceMaximum), index = (pixel * components + channel) * bits / 8;
      if (bits === 16) { result[index] = value >> 8; result[index + 1] = value & 255; } else result[index] = value;
    }
  }
  reader.check();
  return result;
}

/** Bounded original T.800 execution. Unsupported packet styles remain explicit deletion gates. */
export function decodeJpx(reader, input) {
  const container = parseJpxContainer(input), { geometry, tiles } = parseCodestream(container.codestream);
  const { width, height, components, bits } = geometry, bytesPerPixel = components * bits / 8;
  const result = new Uint8Array(width * height * bytesPerPixel);
  for (const tile of tiles) {
    let data = container.codestream, prepared = tile;
    if (tile.parts.length > 1) {
      const size = tile.parts.reduce((sum, part) => sum + part.tileEnd - part.packetStart, 0), combined = new Uint8Array(size), partEnds = [];
      let offset = 0;
      for (const part of tile.parts) { const bytes = data.subarray(part.packetStart, part.tileEnd); combined.set(bytes, offset); offset += bytes.length; partEnds.push(offset); }
      data = combined; prepared = { ...tile, packetStart: 0, tileEnd: size, partEnds };
    }
    const pixels = decodeTile(reader, data, prepared), rowBytes = tile.geometry.width * bytesPerPixel;
    for (let row = 0; row < tile.geometry.height; row++) result.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), ((tile.y - geometry.y0 + row) * width + tile.x - geometry.x0) * bytesPerPixel);
  }
  const mapped = mapChannels(container, result, { width, height, components, bits, sourcePrecision: geometry.sourcePrecision, sourceSigned: geometry.sourceSigned });
  if (container.channels.some(channel => channel.channel >= mapped.components || channel.type > 2 || channel.association > mapped.components)) corrupt('Invalid JPEG2000 channel definition target.');
  return { ...mapped, format: 'raw', embeddedColorSpace: container.color, channels: container.channels };
}
