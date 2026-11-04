// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded T.4/T.6 decoder. Codeword values are normative format data
// from ITU-T T.4 tables 2, 3a, 3b and 4; no implementation is incorporated.
using u8 = unsigned char; using u16 = unsigned short; using u32 = unsigned int; using i32 = int;
struct FaxResult { u32 status, length, damaged, consumed_bits; };
static FaxResult result;
static const char* white_codes[] = {
  "00110101","000111","0111","1000","1011","1100","1110","1111","10011","10100","00111","01000","001000","000011","110100","110101",
  "101010","101011","0100111","0001100","0001000","0010111","0000011","0000100","0101000","0101011","0010011","0100100","0011000","00000010","00000011","00011010",
  "00011011","00010010","00010011","00010100","00010101","00010110","00010111","00101000","00101001","00101010","00101011","00101100","00101101","00000100","00000101","00001010",
  "00001011","01010010","01010011","01010100","01010101","00100100","00100101","01011000","01011001","01011010","01011011","01001010","01001011","00110010","00110011","00110100",
  "11011","10010","010111","0110111","00110110","00110111","01100100","01100101","01101000","01100111","011001100","011001101","011010010","011010011","011010100","011010101","011010110","011010111","011011000","011011001","011011010","011011011","010011000","010011001","010011010","011000","010011011",
  "00000001000","00000001100","00000001101","000000010010","000000010011","000000010100","000000010101","000000010110","000000010111","000000011100","000000011101","000000011110","000000011111"
};
static const char* black_codes[] = {
  "0000110111","010","11","10","011","0011","0010","00011","000101","000100","0000100","0000101","0000111","00000100","00000111","000011000",
  "0000010111","0000011000","0000001000","00001100111","00001101000","00001101100","00000110111","00000101000","00000010111","00000011000","000011001010","000011001011","000011001100","000011001101","000001101000","000001101001",
  "000001101010","000001101011","000011010010","000011010011","000011010100","000011010101","000011010110","000011010111","000001101100","000001101101","000011011010","000011011011","000001010100","000001010101","000001010110","000001010111",
  "000001100100","000001100101","000001010010","000001010011","000000100100","000000110111","000000111000","000000100111","000000101000","000001011000","000001011001","000000101011","000000101100","000001011010","000001100110","000001100111",
  "0000001111","000011001000","000011001001","000001011011","000000110011","000000110100","000000110101","0000001101100","0000001101101","0000001001010","0000001001011","0000001001100","0000001001101","0000001110010","0000001110011","0000001110100","0000001110101","0000001110110","0000001110111","0000001010010","0000001010011","0000001010100","0000001010101","0000001011010","0000001011011","0000001100100","0000001100101",
  "00000001000","00000001100","00000001101","000000010010","000000010011","000000010100","000000010101","000000010110","000000010111","000000011100","000000011101","000000011110","000000011111"
};
static_assert(sizeof(white_codes) / sizeof(*white_codes) == 104 && sizeof(black_codes) / sizeof(*black_codes) == 104);
struct TrieNode { u16 child[2], value; };
static TrieNode tries[2][512]; static bool initialized;
static void init() {
  if (initialized) return;
  for (u32 black = 0; black < 2; ++black) {
    u32 size = 1; const auto codes = black ? black_codes : white_codes;
    for (u32 i = 0; i < 104; ++i) {
      u32 node = 1; for (const char* c = codes[i]; *c; ++c) { const u32 bit = *c - '0'; if (!tries[black][node].child[bit]) tries[black][node].child[bit] = static_cast<u16>(++size); node = tries[black][node].child[bit]; }
      tries[black][node].value = static_cast<u16>((i < 64 ? i : i < 91 ? (i - 63) * 64 : 1792 + (i - 91) * 64) + 1);
    }
  }
  initialized = true;
}
struct Bits {
  const u8* bytes; u32 length, at = 0;
  bool peek(u32 n, u32& value) { if (n > length * 8 - at) return false; value = 0; for (u32 i = 0; i < n; ++i) value = value * 2 + ((bytes[(at + i) >> 3] >> (7 - ((at + i) & 7))) & 1); return true; }
  bool bit(u32& value) { if (!peek(1, value)) return false; ++at; return true; }
  bool align() { u32 n = (8 - (at & 7)) & 7, value; if (!peek(n, value) || value) return false; at += n; return true; }
  bool eol() { const u32 start = at; u32 zeros = 0, value; while (bit(value)) { if (value) { if (zeros >= 11) return true; break; } if (++zeros > 65536) break; } at = start; return false; }
  bool tail() { u32 value; return length * 8 - at < 8 && peek(length * 8 - at, value) && !value; }
};
struct Fax {
  Bits bits; u8* output; u32 capacity, columns, stride, flags, damaged_limit, rows;
  i32 k; u32 *reference, *current, reference_count = 2, current_count = 0, steps = 0; bool previous_damaged = false;
  bool fail(u32 status = 1) { if (!result.status) result.status = status; return false; }
  bool change(u32 position) { if (current_count >= columns + 4) return fail(4); current[current_count++] = position; return true; }
  bool paint(u32 first, u32 last, bool black) {
    if (last < first || last > columns) return fail();
    if (black) for (u32 x = first; x < last; ++x) { auto& byte = output[result.length + (x >> 3)]; const u8 mask = static_cast<u8>(128 >> (x & 7)); if (flags & 8) byte |= mask; else byte &= static_cast<u8>(~mask); }
    return true;
  }
  bool run(bool black, u32& length) {
    length = 0;
    for (;;) {
      if (++steps > columns * 4 + 128) return fail(4); u32 node = 1, bit;
      for (u32 count = 0; count < 13; ++count) {
        if (!bits.bit(bit) || !(node = tries[black][node].child[bit])) return fail();
        const u32 value = tries[black][node].value; if (!value) continue;
        const u32 part = value - 1; if (part > columns - length) return fail(); length += part; if (part < 64) return true; break;
      }
      if (!tries[black][node].value) return fail();
    }
  }
  bool uncompressed(u32& x, bool& black) {
    if (flags & 16) return fail(); // T.88 forbids the T.6 extension codes.
    auto emit = [&](u32 count, bool color) {
      if (count > columns - x) return fail(); if (!count) return true;
      if (black != color) { if (!change(x)) return false; black = color; }
      if (!paint(x, x + count, color)) return false; x += count; return true;
    };
    for (;;) {
      if (++steps > columns * 4 + 128) return fail(4); u32 zeros = 0, value;
      for (;;) { if (!bits.bit(value)) return fail(); if (value) break; if (++zeros > 10) return fail(); }
      if (zeros < 5) { if (!emit(zeros, false) || !emit(1, true)) return false; }
      else if (zeros == 5) { if (!emit(5, false)) return false; }
      else {
        if (!emit(zeros - 6, false) || !bits.bit(value)) return fail();
        if (black != (value != 0)) { if (!change(x)) return false; black = value != 0; } return true;
      }
    }
  }
  bool one() {
    u32 x = 0; bool black = false;
    while (x < columns) {
      u32 marker; if (bits.peek(12, marker) && marker == 15) { bits.at += 12; if (!uncompressed(x, black)) return false; continue; }
      u32 length; if (!run(black, length) || !paint(x, x + length, black) || !change(x + length)) return false; x += length; black = !black;
    }
    return true;
  }
  bool two() {
    u32 x = 0; bool black = false, initial = true;
    while (x < columns) {
      if (++steps > columns * 4 + 128) return fail(4);
      u32 b1 = 0, right = reference_count;
      while (b1 < right) { const u32 middle = b1 + (right - b1) / 2; if (initial ? reference[middle] < x : reference[middle] <= x) b1 = middle + 1; else right = middle; }
      if ((b1 & 1) != static_cast<u32>(black)) ++b1;
      const u32 first = b1 < reference_count ? reference[b1] : columns, second = b1 + 1 < reference_count ? reference[b1 + 1] : columns;
      u32 code = 0, bit, mode = 0; i32 delta = 0;
      for (u32 count = 1; count <= 7; ++count) {
        if (!bits.bit(bit)) return fail(); code = code * 2 + bit;
        if (count == 1 && code == 1) { mode = 1; break; }
        if (count == 3 && code >= 1 && code <= 3) { mode = code == 1 ? 2 : 1; delta = code == 2 ? -1 : code == 3 ? 1 : 0; break; }
        if (count == 4 && code == 1) { mode = 3; break; }
        if (count == 6 && (code == 2 || code == 3)) { mode = 1; delta = code == 2 ? -2 : 2; break; }
        if (count == 7 && (code == 2 || code == 3)) { mode = 1; delta = code == 2 ? -3 : 3; break; }
        if (count == 7 && code == 1) {
          if (flags & 16) return fail();
          u32 extension; if (!bits.peek(3, extension)) return fail(); if (extension != 7) return fail(3); bits.at += 3; mode = 4; break;
        }
      }
      if (!mode) return fail();
      if (mode == 1) {
        const i32 end = static_cast<i32>(first) + delta; if (end < static_cast<i32>(x) || end > static_cast<i32>(columns) || !paint(x, static_cast<u32>(end), black) || !change(static_cast<u32>(end))) return fail();
        x = static_cast<u32>(end); black = !black;
      } else if (mode == 2) {
        u32 a, b; if (!run(black, a)) return false; if (a > columns - x) return fail(); if (!run(!black, b)) return false; if (b > columns - x - a) return fail();
        if (!paint(x, x + a, black) || !paint(x + a, x + a + b, !black) || !change(x + a) || !change(x + a + b)) return false;
        x += a + b;
      } else if (mode == 3) { if (second <= x || !paint(x, second, black)) return fail(); x = second; }
      else if (!uncompressed(x, black)) return false;
      initial = false;
    }
    return true;
  }
  bool decode() {
    reference[0] = reference[1] = columns; u32 row = 0;
    while (true) {
      if (!(flags & 4) && rows && row == rows) return true;
      if (!(flags & 4) && bits.tail()) return true;
      u32 value;
      if (k < 0 && bits.peek(24, value) && value == 0x001001) { bits.at += 24; return true; }
      bool one_dimensional = k == 0;
      if (k >= 0) {
        const bool eol = bits.eol();
        if (eol) {
          if (k > 0 && !bits.bit(value)) return fail(); if (k > 0) one_dimensional = value != 0;
          const u32 after = bits.at; u32 count = 1;
          while (count < 6 && bits.eol()) { if (k > 0 && (!bits.bit(value) || value != 1)) return fail(); ++count; }
          if (count == 6) return true; if (count > 1) return fail(); bits.at = after;
        } else if ((flags & 1) || k > 0) return fail();
      } else if ((flags & 1) && !bits.eol()) return fail();
      if (stride > capacity - result.length) return fail(2);
      for (u32 i = 0; i < stride; ++i) output[result.length + i] = flags & 8 ? 0 : 255;
      current_count = 0; steps = 0;
      if (!(one_dimensional ? one() : two())) {
        if (result.status != 1 || k < 0 || !(flags & 1) || result.damaged >= damaged_limit) return false;
        bool found = false; while (bits.at < bits.length * 8) { const u32 start = bits.at; if (bits.eol()) { bits.at = start; found = true; break; } ++bits.at; }
        if (!found) return false; result.status = 0; ++result.damaged;
        for (u32 i = 0; i < stride; ++i) output[result.length + i] = row && !previous_damaged ? output[result.length - stride + i] : flags & 8 ? 0 : 255;
        current_count = 0; bool previous = false;
        for (u32 x = 0; x < columns; ++x) { const bool black = !!(output[result.length + (x >> 3)] & (128 >> (x & 7))) == !!(flags & 8); if (black != previous) { if (!change(x)) return false; previous = black; } }
        previous_damaged = true;
      } else previous_damaged = false;
      if (!change(columns) || !change(columns)) return false;
      auto old = reference; reference = current; current = old; reference_count = current_count;
      result.length += stride; ++row;
      if ((flags & 2) && !bits.align()) return fail();
    }
  }
};
extern "C" const FaxResult* pn_pdf_fax(const u8* input, u32 length, i32 k, u32 columns, u32 rows, u32 flags, u32 damaged, u8* output, u32 capacity, u32* scratch) {
  result = {}; if (!columns || columns > 1000000 || rows > 1000000 || length > 128u * 1024 * 1024 || capacity > 32u * 1024 * 1024 || damaged > 1024) { result.status = 4; return &result; }
  init(); Fax fax{{input, length}, output, capacity, columns, (columns + 7) / 8, flags, damaged, rows, k, scratch, scratch + columns + 4}; fax.decode(); result.consumed_bits = fax.bits.at; return &result;
}
