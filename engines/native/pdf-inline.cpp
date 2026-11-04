// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original no-output inline-image framing, RFC1950/1951 and ISO32000-1 7.4.4.
using u8 = unsigned char; using u16 = unsigned short; using u32 = unsigned int;
namespace {
constexpr u32 MAX_INPUT = 32u * 1024 * 1024, MAX_OUTPUT = 96u * 1024 * 1024 + 1000000;
struct Result { u32 status, length, decoded; };
Result result;
struct Work {
  u32 remaining = 512u * 1024 * 1024;
  bool consume(u32 count) { if (count > remaining) { result.status = 2; return false; } remaining -= count; return true; }
};
struct Bits {
  const u8* bytes; u32 length, bit = 0; bool valid = true; Work& work;
  Bits(const u8* input, u32 size, Work& budget) : bytes(input), length(size), work(budget) {}
  u32 take(u32 count) {
    if (!valid || count > 16 || bit > length * 8 || count > length * 8 - bit) { valid = false; return 0; }
    if (!work.consume(count)) { valid = false; return 0; }
    u32 value = 0; for (u32 i = 0; i < count; ++i, ++bit) value |= ((bytes[bit >> 3] >> (bit & 7)) & 1u) << i;
    return value;
  }
};
struct Huffman {
  u16 counts[16] = {}, symbols[288] = {};
  bool build(const u8* lengths, u32 count, Work& work) {
    if (count > 288 || !work.consume(count * 2 + 31)) return false;
    for (auto& count : counts) count = 0;
    for (u32 i = 0; i < count; ++i) { if (lengths[i] > 15) return false; if (lengths[i]) ++counts[lengths[i]]; }
    int available = 1; u16 offsets[16] = {};
    for (u32 i = 1; i <= 15; ++i) { available = available * 2 - counts[i]; if (available < 0) return false; if (i < 15) offsets[i + 1] = offsets[i] + counts[i]; }
    for (u32 i = 0; i < count; ++i) if (lengths[i]) symbols[offsets[lengths[i]]++] = static_cast<u16>(i);
    return true;
  }
  u32 read(Bits& bits) const {
    u32 code = 0, first = 0, offset = 0;
    for (u32 length = 1; length <= 15 && bits.valid; ++length) {
      code = (code << 1) | bits.take(1);
      if (code >= first && code - first < counts[length]) return symbols[offset + code - first];
      offset += counts[length]; first = (first + counts[length]) << 1;
    }
    bits.valid = false; return 0;
  }
};
bool add(u32 count) {
  if (count > MAX_OUTPUT - result.decoded) { result.status = 2; return false; }
  result.decoded += count; return true;
}
bool flate(const u8* input, u32 length) {
  if (length < 6 || (input[0] & 15) != 8 || input[0] >> 4 > 7 || (input[0] * 256u + input[1]) % 31 || (input[1] & 32)) return false;
  Work work; Bits bits{input + 2, length - 2, work}; bool final, fixedReady = false;
  Huffman fixedLiterals, fixedDistances, dynamicLiterals, dynamicDistances, code;
  u8 lengths[320] = {};
  do {
    if (!work.consume(1)) return false;
    final = bits.take(1); const u32 type = bits.take(2); if (!bits.valid || type == 3) return false;
    if (type == 0) {
      bits.bit = (bits.bit + 7) & ~7u;
      const u32 count = bits.take(16), complement = bits.take(16);
      if (!bits.valid || (count ^ complement) != 65535 || count > bits.length - bits.bit / 8 || !add(count)) return false;
      bits.bit += count * 8; continue;
    }
    Huffman* literals; Huffman* distances;
    if (type == 1) {
      if (!fixedReady) {
        if (!work.consume(320)) return false;
        for (u32 i = 0; i < 288; ++i) lengths[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
        if (!fixedLiterals.build(lengths, 288, work)) return false;
        for (u32 i = 0; i < 32; ++i) lengths[i] = 5;
        if (!fixedDistances.build(lengths, 32, work)) return false;
        fixedReady = true;
      }
      literals = &fixedLiterals; distances = &fixedDistances;
    } else {
      const u32 nl = bits.take(5) + 257, nd = bits.take(5) + 1, nc = bits.take(4) + 4;
      if (!bits.valid || nl > 286) return false;
      constexpr u8 order[19] = {16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15};
      if (!work.consume(19)) return false;
      u8 codeLengths[19] = {}; for (u32 i = 0; i < nc; ++i) codeLengths[order[i]] = static_cast<u8>(bits.take(3));
      if (!bits.valid || !code.build(codeLengths, 19, work)) return false;
      for (u32 at = 0; at < nl + nd;) {
        if (!work.consume(1)) return false;
        const u32 value = code.read(bits); if (!bits.valid) return false;
        if (value < 16) { lengths[at++] = static_cast<u8>(value); continue; }
        if (value > 18 || (value == 16 && !at)) return false;
        const u32 repeated = value == 16 ? lengths[at - 1] : 0;
        const u32 count = bits.take(value == 16 ? 2 : value == 17 ? 3 : 7) + (value == 18 ? 11 : 3);
        if (!bits.valid || count > nl + nd - at || !work.consume(count)) return false;
        for (u32 i = 0; i < count; ++i) lengths[at++] = static_cast<u8>(repeated);
      }
      if (!lengths[256] || !dynamicLiterals.build(lengths, nl, work) || !dynamicDistances.build(lengths + nl, nd, work)) return false;
      literals = &dynamicLiterals; distances = &dynamicDistances;
    }
    constexpr u16 bases[29] = {3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258};
    constexpr u8 extra[29] = {0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0};
    constexpr u16 dbases[30] = {1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577};
    for (;;) {
      if (!work.consume(1)) return false;
      const u32 symbol = literals->read(bits); if (!bits.valid) return false;
      if (symbol < 256) { if (!add(1)) return false; continue; }
      if (symbol == 256) break;
      if (symbol > 285) return false;
      const u32 count = bases[symbol - 257] + bits.take(extra[symbol - 257]), distanceSymbol = distances->read(bits);
      if (!bits.valid || distanceSymbol >= 30) return false;
      const u32 distance = dbases[distanceSymbol] + bits.take(distanceSymbol < 4 ? 0 : (distanceSymbol - 2) / 2);
      if (!bits.valid || distance > result.decoded || !add(count)) return false;
    }
  } while (!final);
  const u32 end = 2 + (bits.bit + 7) / 8;
  if (end > length || length - end < 4) return false;
  // Framing includes Adler32; the normal image decoder verifies its checksum.
  result.length = end + 4; return true;
}
bool lzw(const u8* input, u32 length, u32 early) {
  if (early > 1) return false;
  u16 lengths[4096] = {}; u32 bit = 0, width = 9, next = 258, previous = 0;
  for (;;) {
    if (bit > length * 8 || width > length * 8 - bit) return false;
    u32 code = 0; for (u32 i = 0; i < width; ++i, ++bit) code = (code << 1) | ((input[bit >> 3] >> (7 - (bit & 7))) & 1u);
    if (code == 256) { width = 9; next = 258; previous = 0; continue; }
    if (code == 257) { result.length = (bit + 7) / 8; return true; }
    if (code > next || code >= 4096 || (code == next && !previous)) return false;
    const u32 count = code < 256 ? 1 : code == next ? previous + 1 : lengths[code];
    if (!count || !add(count)) return false;
    if (previous && next < 4096) { lengths[next++] = static_cast<u16>(previous + 1); if (width < 12 && next + early == (1u << width)) ++width; }
    previous = count;
  }
}
}
extern "C" const Result* pn_pdf_inline_length(const u8* input, u32 length, u32 filter, u32 early) {
  result = {};
  if (length > MAX_INPUT) result.status = 2;
  else if (!(filter == 1 ? flate(input, length) : filter == 2 ? lzw(input, length, early) : false) && !result.status) result.status = 1;
  return &result;
}
