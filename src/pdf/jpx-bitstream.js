// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };

/** T.800 B.10: packet-header bytes reserve one bit after FF. */
export class PacketBits {
  constructor(bytes, start, end) { this.bytes = bytes; this.position = start; this.end = end; this.left = 0; this.value = 0; this.previous = 0; }
  read(count = 1) {
    if (!Number.isInteger(count) || count < 0 || count > 31) corrupt('Invalid JPEG2000 bit count.');
    let result = 0;
    for (let bit = 0; bit < count; bit++) {
      if (!this.left) {
        if (this.position >= this.end) corrupt('Truncated JPEG2000 packet header.');
        this.value = this.bytes[this.position++]; this.left = this.previous === 255 ? 7 : 8;
        if (this.left === 7 && this.value & 128) corrupt('Invalid JPEG2000 packet-header stuffing.');
        this.previous = this.value;
      }
      result = result * 2 + (this.value >> --this.left & 1);
    }
    return result;
  }
  align() {
    this.left = 0;
    if (this.previous === 255) {
      if (this.position >= this.end || this.bytes[this.position] & 128) corrupt('Truncated JPEG2000 packet-header alignment.');
      this.position++;
    }
    return this.position;
  }
}

/** T.800 B.10.2: minimum-value tag trees retain state across quality layers. */
export class TagTree {
  constructor(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1_000_000) corrupt('Invalid JPEG2000 tag-tree dimensions.');
    this.levels = [];
    for (;;) {
      this.levels.push({ width, height, values: new Uint16Array(width * height).fill(65535), lows: new Uint16Array(width * height) });
      if (width === 1 && height === 1) break;
      width = Math.ceil(width / 2); height = Math.ceil(height / 2);
    }
  }
  decode(index, threshold, bits) {
    const base = this.levels[0];
    if (!Number.isInteger(index) || index < 0 || index >= base.values.length || !Number.isInteger(threshold) || threshold < 0 || threshold > 65534) corrupt('Invalid JPEG2000 tag-tree query.');
    const path = []; let x = index % base.width, y = Math.floor(index / base.width), low = 0;
    for (const level of this.levels) { path.push([level, y * level.width + x]); x = Math.floor(x / 2); y = Math.floor(y / 2); }
    for (const [level, at] of path.toReversed()) {
      low = Math.max(low, level.lows[at]);
      while (low < threshold && low < level.values[at]) {
        if (bits.read()) level.values[at] = low;
        else low++;
      }
      level.lows[at] = low; low = Math.min(low, level.values[at]);
    }
    return base.values[index] < threshold;
  }
}

export function codingPassCount(bits) {
  if (!bits.read()) return 1;
  if (!bits.read()) return 2;
  let value = bits.read(2); if (value < 3) return value + 3;
  value = bits.read(5); return value < 31 ? value + 6 : bits.read(7) + 37;
}
