// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded baseline JPEG execution, ITU-T T.81 Annexes A/B/C/E/F.
// This layer returns coded component samples; PDF colour transforms belong to its caller.
namespace pn_jpeg {
using u8 = unsigned char; using u16 = unsigned short; using u32 = unsigned int; using i32 = int; using u64 = unsigned long long;
constexpr u32 MAX_PIXELS = 32000000, MAX_BYTES = 96u * 1024 * 1024, MAX_INPUT = 32u * 1024 * 1024;
struct Result { u32 status, width, height, components, scratch_bytes, output_bytes, consumed; };
static Result result;
static constexpr u8 zigzag[64] = {0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63};
constexpr double cosine(double x) {
  constexpr double pi = 3.1415926535897932384626433832795;
  while (x > pi) x -= 2 * pi;
  double term = 1, sum = 1;
  for (int i = 1; i < 20; i++) { term *= -x * x / ((2 * i - 1) * (2 * i)); sum += term; }
  return sum;
}
struct Basis {
  double value[8][8]{};
  constexpr Basis() {
    for (int x = 0; x < 8; x++) for (int u = 0; u < 8; u++)
      value[x][u] = (u ? .5 : .35355339059327376220042218105242) * cosine((2 * x + 1) * u * 3.1415926535897932384626433832795 / 16);
  }
};
static constexpr Basis basis;
static u8 rounded(double value) { return value <= 0 ? 0 : value >= 255 ? 255 : static_cast<u8>(value + .5); }
struct Huffman { u16 count[17]{}; u16 offset[17]{}; u32 first[17]{}; u8 values[256]{}; bool present = false; };
struct Component { u32 id = 0, h = 0, v = 0, quant = 0, dc = 0, ac = 0, stride = 0, rows = 0, plane_bytes = 0, offset = 0, columns = 0, lines = 0; i32 previous = 0; };
struct Decoder {
  const u8* input; u32 length, at = 0, status = 0, markers = 0, width = 0, height = 0, max_h = 0, max_v = 0, mcu_columns = 0, mcu_rows = 0, restart = 0, bits = 0, buffer = 0;
  u16 quant[4][64]{}; bool quant_present[4]{}; Huffman dc[4], ac[4]; Component components[4]; u32 order[4]{};
  bool frame = false, scan = false;
  Decoder(const u8* data, u32 size) : input(data), length(size) {}
  bool fail(u32 code = 1) { if (!status) status = code; return false; }
  u32 byte() { if (at >= length) { fail(); return 0; } return input[at++]; }
  u32 word() { const u32 first = byte(); return first * 256 + byte(); }
  bool segment(u32& end) { const u32 size = word(); if (status || size < 2 || size - 2 > length - at) return fail(); end = at + size - 2; return true; }
  u32 marker() {
    if (byte() != 255) { fail(); return 0; }
    u32 code; do { code = byte(); } while (code == 255 && !status);
    if (!code) fail(); return code;
  }
  bool tables(u32 end, bool huffman) {
    while (at < end && !status) {
      const u32 spec = byte(), kind = spec >> 4, index = spec & 15;
      if (index > 3 || kind > (huffman ? 1u : 0u)) return fail(kind && !huffman ? 3 : 1);
      if (!huffman) {
        if (end - at < 64) return fail();
        for (u32 i = 0; i < 64; i++) { const u32 value = byte(); if (!value) return fail(); quant[index][zigzag[i]] = value; }
        quant_present[index] = true;
      } else {
        if (end - at < 16) return fail();
        Huffman& table = kind ? ac[index] : dc[index]; table = {};
        u32 count = 0, code = 0;
        for (u32 n = 1; n <= 16; n++) {
          table.offset[n] = count; table.first[n] = code; table.count[n] = byte();
          if (table.count[n] && code + table.count[n] >= (1u << n)) return fail();
          count += table.count[n]; if (count > 256) return fail(); code = (code + table.count[n]) * 2;
        }
        if (!count || count > end - at) return fail();
        for (u32 i = 0; i < count; i++) {
          const u32 value = byte();
          if (!kind && value > 11 || kind && ((value & 15) > 10 || !(value & 15) && value != 0 && value != 240)) return fail();
          table.values[i] = value;
        }
        table.present = true;
      }
    }
    return !status && at == end;
  }
  bool read_frame(u32 end) {
    if (frame || end - at < 6) return fail();
    const u32 precision = byte(); height = word(); width = word(); const u32 count = byte();
    if (end - at != count * 3) return fail();
    if (precision != 8 || count != 4) return fail(3);
    if (!width || !height) return fail(3);
    if (static_cast<u64>(width) * height > MAX_PIXELS || static_cast<u64>(width) * height * 4 > MAX_BYTES) return fail(2);
    u32 blocks = 0;
    for (u32 i = 0; i < 4; i++) {
      Component& c = components[i]; c.id = byte(); const u32 sampling = byte(); c.h = sampling >> 4; c.v = sampling & 15; c.quant = byte();
      if (!c.h || c.h > 4 || !c.v || c.v > 4 || c.quant > 3) return fail();
      for (u32 j = 0; j < i; j++) if (components[j].id == c.id) return fail();
      if (c.h > max_h) max_h = c.h; if (c.v > max_v) max_v = c.v; blocks += c.h * c.v;
    }
    if (blocks > 10) return fail();
    mcu_columns = (width + max_h * 8 - 1) / (max_h * 8); mcu_rows = (height + max_v * 8 - 1) / (max_v * 8);
    if (static_cast<u64>(mcu_columns) * mcu_rows * blocks > 2000000) return fail(2);
    u32 scratch = 0;
    for (auto& c : components) {
      c.stride = mcu_columns * c.h * 8; c.rows = c.v * 8; c.plane_bytes = c.stride * c.rows; c.offset = scratch;
      c.columns = (width * c.h + max_h - 1) / max_h; c.lines = (height * c.v + max_v - 1) / max_v;
      scratch += 3 * c.plane_bytes;
    }
    if (scratch > 32u * 1024 * 1024) return fail(2);
    result.width = width; result.height = height; result.components = 4; result.scratch_bytes = scratch; result.output_bytes = width * height * 4;
    frame = true; return at == end;
  }
  bool read_scan(u32 end) {
    if (!frame || scan) return fail(3);
    const u32 count = byte(); if (count != 4) return fail(3);
    if (end - at != 11) return fail();
    for (u32 i = 0; i < 4; i++) {
      const u32 id = byte(), tables = byte(); u32 index = 4;
      for (u32 j = 0; j < 4; j++) if (components[j].id == id) index = j;
      if (index == 4 || (tables >> 4) > 3 || (tables & 15) > 3) return fail();
      for (u32 j = 0; j < i; j++) if (order[j] == index) return fail();
      order[i] = index; Component& c = components[index]; c.dc = tables >> 4; c.ac = tables & 15;
      if (!dc[c.dc].present || !ac[c.ac].present || !quant_present[c.quant]) return fail();
    }
    const u32 start = byte(), finish = byte(), approximation = byte();
    if (start != 0 || finish != 63 || approximation != 0) return fail(3);
    scan = true; return !status && at == end;
  }
  bool header() {
    if (length < 4 || byte() != 255 || byte() != 216) return fail();
    while (!status && !scan) {
      if (++markers > 4096) return fail(2);
      const u32 code = marker(); if (status) return false; u32 end = 0;
      if (code == 216 || code == 217 || code >= 208 && code <= 215 || code == 1) return fail();
      if (!segment(end)) return false;
      if (code == 192) { if (!read_frame(end)) return false; }
      else if (code >= 193 && code <= 207 && code != 196 && code != 204) return fail(3);
      else if (code == 196) { if (!tables(end, true)) return false; }
      else if (code == 219) { if (!tables(end, false)) return false; }
      else if (code == 221) { if (end - at != 2) return fail(); restart = word(); }
      else if (code == 218) { if (!read_scan(end)) return false; }
      else if (code == 204 || code == 220) return fail(3);
      else if (!(code >= 224 && code <= 239 || code == 254)) return fail(3);
      at = end;
    }
    return scan && !status;
  }
  u32 read_bits(u32 count) {
    while (bits < count && !status) {
      const u32 value = byte();
      if (value == 255 && byte() != 0) { fail(); return 0; }
      buffer = buffer * 256 + value; bits += 8;
    }
    if (status) return 0;
    bits -= count; const u32 value = (buffer >> bits) & ((1u << count) - 1); buffer &= (1u << bits) - 1; return value;
  }
  u32 symbol(const Huffman& table) {
    u32 code = 0;
    for (u32 n = 1; n <= 16 && !status; n++) {
      code = code * 2 + read_bits(1);
      if (code >= table.first[n] && code - table.first[n] < table.count[n]) return table.values[table.offset[n] + code - table.first[n]];
    }
    fail(); return 0;
  }
  i32 amplitude(u32 size) { if (!size) return 0; const u32 value = read_bits(size); return value < (1u << (size - 1)) ? static_cast<i32>(value) - static_cast<i32>((1u << size) - 1) : static_cast<i32>(value); }
  bool padding() { if (buffer != (1u << bits) - 1) return fail(); bits = buffer = 0; return true; }
  bool block(Component& c, u8* target) {
    i32 coefficients[64]{}; const u32 size = symbol(dc[c.dc]); c.previous += amplitude(size);
    if (status || c.previous < -2048 || c.previous > 2047) return fail();
    coefficients[0] = c.previous; bool constant = true;
    for (u32 k = 1; k < 64 && !status;) {
      const u32 rs = symbol(ac[c.ac]), run = rs >> 4, magnitude = rs & 15;
      if (!magnitude) { if (!run) break; k += 16; if (k > 64) return fail(); continue; }
      k += run; if (k >= 64) return fail(); coefficients[zigzag[k++]] = amplitude(magnitude); constant = false;
    }
    if (status) return false;
    const u16* q = quant[c.quant];
    if (constant) {
      const u8 value = rounded(coefficients[0] * q[0] / 8.0 + 128);
      for (u32 y = 0; y < 8; y++) for (u32 x = 0; x < 8; x++) target[y * c.stride + x] = value;
    } else {
      double temporary[64];
      for (u32 v = 0; v < 8; v++) for (u32 x = 0; x < 8; x++) {
        double sum = 0; for (u32 u = 0; u < 8; u++) sum += coefficients[v * 8 + u] * q[v * 8 + u] * basis.value[x][u]; temporary[v * 8 + x] = sum;
      }
      for (u32 y = 0; y < 8; y++) for (u32 x = 0; x < 8; x++) {
        double sum = 0; for (u32 v = 0; v < 8; v++) sum += temporary[v * 8 + x] * basis.value[y][v]; target[y * c.stride + x] = rounded(sum + 128);
      }
    }
    return true;
  }
  double sample(const Component& c, const u8* scratch, i32 x, i32 y) const {
    if (x < 0) x = 0; else if (static_cast<u32>(x) >= c.columns) x = c.columns - 1;
    if (y < 0) y = 0; else if (static_cast<u32>(y) >= c.lines) y = c.lines - 1;
    const u32 row = static_cast<u32>(y) / c.rows, local = static_cast<u32>(y) % c.rows;
    return scratch[c.offset + row % 3 * c.plane_bytes + local * c.stride + x];
  }
  void render_row(u32 row, const u8* scratch, u8* output) const {
    const u32 start = row * max_v * 8, end = start + max_v * 8 < height ? start + max_v * 8 : height;
    for (u32 y = start; y < end; y++) for (u32 x = 0; x < width; x++) for (u32 channel = 0; channel < 4; channel++) {
      const Component& c = components[channel];
      const double sx = (x + .5) * c.h / max_h - .5, sy = (y + .5) * c.v / max_v - .5;
      const i32 left = static_cast<i32>(sx) - (sx < 0 ? 1 : 0), top = static_cast<i32>(sy) - (sy < 0 ? 1 : 0);
      const double fx = sx - left, fy = sy - top;
      const double value = sample(c, scratch, left, top) * (1 - fx) * (1 - fy) + sample(c, scratch, left + 1, top) * fx * (1 - fy)
        + sample(c, scratch, left, top + 1) * (1 - fx) * fy + sample(c, scratch, left + 1, top + 1) * fx * fy;
      output[(y * width + x) * 4 + channel] = rounded(value);
    }
  }
  bool decode(u8* output, u8* scratch) {
    u32 mcu = 0, restart_index = 0;
    for (u32 row = 0; row < mcu_rows; row++) {
      for (u32 column = 0; column < mcu_columns; column++, mcu++) {
        if (restart && mcu && mcu % restart == 0) {
          if (!padding() || marker() != 208 + restart_index) return fail(); restart_index = (restart_index + 1) & 7;
          for (auto& c : components) c.previous = 0;
        }
        for (const u32 index : order) {
          Component& c = components[index];
          for (u32 v = 0; v < c.v; v++) for (u32 h = 0; h < c.h; h++)
            if (!block(c, scratch + c.offset + row % 3 * c.plane_bytes + v * 8 * c.stride + (column * c.h + h) * 8)) return false;
        }
      }
      if (row) render_row(row - 1, scratch, output);
    }
    render_row(mcu_rows - 1, scratch, output);
    if (!padding()) return false;
    if (marker() != 217 || status) return fail();
    if (at != length) return fail();
    result.consumed = at; return true;
  }
};
static bool in_memory(const void* pointer, u32 size) {
  const u64 start = reinterpret_cast<u32>(pointer), bytes = static_cast<u64>(__builtin_wasm_memory_size(0)) * 65536;
  return start && start <= bytes && size <= bytes - start;
}
}
extern "C" const pn_jpeg::Result* pn_pdf_jpeg(const pn_jpeg::u8* input, pn_jpeg::u32 length, pn_jpeg::u8* output, pn_jpeg::u32 capacity, pn_jpeg::u8* scratch, pn_jpeg::u32 scratch_capacity) {
  using namespace pn_jpeg; result = {};
  if (!length || length > MAX_INPUT) { result.status = length > MAX_INPUT ? 2 : 1; return &result; }
  if (!in_memory(input, length)) { result.status = 1; return &result; }
  Decoder decoder(input, length);
  if (!decoder.header()) { result.status = decoder.status ? decoder.status : 1; return &result; }
  if (!output) return &result;
  if (capacity < result.output_bytes || scratch_capacity < result.scratch_bytes) { result.status = 2; return &result; }
  if (!in_memory(output, result.output_bytes) || !in_memory(scratch, result.scratch_bytes)) { result.status = 1; return &result; }
  if (!decoder.decode(output, scratch)) result.status = decoder.status ? decoder.status : 1;
  return &result;
}
