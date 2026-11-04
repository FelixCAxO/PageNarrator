// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded PDF LZW execution, ISO 32000-1 section 7.4.4.
using u8 = unsigned char; using u16 = unsigned short; using u32 = unsigned int;
struct CodecResult { u32 status, length; };
static CodecResult result;
extern "C" const CodecResult* pn_pdf_lzw(const u8* input, u32 length, u32 early, u8* output, u32 capacity) {
  result = {}; if (early > 1 || capacity > 32u * 1024 * 1024) { result.status = 1; return &result; }
  u16 prefix[4096]; u8 suffix[4096], stack[4096];
  u32 at = 0, buffer = 0, bits = 0, width = 9, next = 258, previous = 4096;
  while (true) {
    while (bits < width) { if (at == length) { result.status = 1; return &result; } buffer = (buffer << 8) | input[at++]; bits += 8; }
    bits -= width; const u32 code = (buffer >> bits) & ((1u << width) - 1); buffer &= (1u << bits) - 1;
    if (code == 256) { width = 9; next = 258; previous = 4096; continue; }
    if (code == 257) return &result;
    bool repeated = code == next && previous < 4096;
    if (code > next || (code == next && !repeated) || code >= 4096) { result.status = 1; return &result; }
    u32 value = repeated ? previous : code, count = 0;
    while (value >= 256) {
      if (value < 258 || value >= next || count >= 4095) { result.status = 1; return &result; }
      stack[count++] = suffix[value]; value = prefix[value];
    }
    const u8 first = static_cast<u8>(value); stack[count++] = first;
    if (count + (repeated ? 1u : 0u) > capacity - result.length) { result.status = 2; return &result; }
    while (count) output[result.length++] = stack[--count]; if (repeated) output[result.length++] = first;
    if (previous < 4096 && next < 4096) {
      prefix[next] = static_cast<u16>(previous); suffix[next++] = first;
      if (width < 12 && next + early == (1u << width)) ++width;
    }
    previous = code;
  }
}
