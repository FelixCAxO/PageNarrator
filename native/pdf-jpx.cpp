// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original JPEG2000 execution from ITU-T T.800 Annexes C-D, not an upstream codec.
#include "pdf-mq.h"
namespace pn_jpx {
using u8 = unsigned char; using u32 = unsigned int; using i32 = int;
struct RawReader {
  const u8* data; u32 length, position = 0, bits = 0, value = 0, previous = 0; bool valid = true, padding;
  int read() {
    if (!bits) {
      const bool actual = position < length;
      if (!actual && !padding) { valid = false; return 0; }
      value = actual ? data[position++] : 255; bits = previous == 255 ? 7 : 8;
      if (actual && bits == 7 && (value & 128)) { valid = false; return 0; }
      previous = value;
    }
    return (value >> --bits) & 1;
  }
};
struct Block {
  u32 width, height, orientation, style; i32* values; u8* flags;
  pn_pdf::MqDecoder mq; pn_pdf::MqContext contexts[19]; bool valid = true, bypass = false;
  RawReader raw{};
  void reset() { for (auto& context : contexts) context = {}; contexts[0].index = 4; contexts[17].index = 3; contexts[18].index = 46; }
  int read(u32 context) {
    if (bypass) { const int bit = raw.read(); if (!raw.valid) valid = false; return bit; }
    int bit = mq.read(contexts[context]); if (bit < 0) { valid = false; return 0; } return bit;
  }
  u8 at(i32 x, i32 y, u32 current_y) const {
    if (x < 0 || y < 0 || x >= static_cast<i32>(width) || y >= static_cast<i32>(height)) return 0;
    if ((style & 8) && current_y % 4 == 3 && y > static_cast<i32>(current_y)) return 0;
    return flags[y * width + x];
  }
  u32 neighbours(u32 x, u32 y, u32& h, u32& v, u32& d) const {
    h = (at(x - 1, y, y) & 1) + (at(x + 1, y, y) & 1);
    v = (at(x, y - 1, y) & 1) + (at(x, y + 1, y) & 1);
    d = (at(x - 1, y - 1, y) & 1) + (at(x + 1, y - 1, y) & 1)
      + (at(x - 1, y + 1, y) & 1) + (at(x + 1, y + 1, y) & 1);
    return h + v + d;
  }
  u32 significance(u32 x, u32 y) const {
    u32 h, v, d; neighbours(x, y, h, v, d);
    if (orientation == 3) {
      if (d >= 3) return 8;
      if (d == 2) return h + v ? 7 : 6;
      if (d == 1) return h + v >= 2 ? 5 : h + v ? 4 : 3;
      return h + v >= 2 ? 2 : h + v ? 1 : 0;
    }
    if (orientation == 1) { u32 swap = h; h = v; v = swap; }
    if (h == 2) return 8;
    if (h == 1) return v ? 7 : d ? 6 : 5;
    if (v == 2) return 4;
    if (v == 1) return 3;
    return d >= 2 ? 2 : d ? 1 : 0;
  }
  i32 signed_neighbour(i32 x, i32 y, u32 current_y) const {
    u8 state = at(x, y, current_y); return !(state & 1) ? 0 : (state & 8) ? -1 : 1;
  }
  void sign(u32 x, u32 y, u32 bitplane) {
    i32 h = signed_neighbour(x - 1, y, y) + signed_neighbour(x + 1, y, y);
    i32 v = signed_neighbour(x, y - 1, y) + signed_neighbour(x, y + 1, y);
    h = h < 0 ? -1 : h > 0 ? 1 : 0; v = v < 0 ? -1 : v > 0 ? 1 : 0;
    int prediction = h < 0 || (!h && v < 0);
    if (prediction) { h = -h; v = -v; }
    u32 context = !h ? (!v ? 9 : 10) : v < 0 ? 11 : v == 0 ? 12 : 13;
    u32 index = y * width + x;
    const int negative = bypass ? read(0) : read(context) ^ prediction;
    flags[index] |= 1 | (negative ? 8 : 0); values[index] = 1u << bitplane;
  }
  void propagation(u32 plane) {
    for (u32 stripe = 0; stripe < height; stripe += 4) for (u32 x = 0; x < width; ++x) {
      for (u32 y = stripe; y < height && y < stripe + 4; ++y) {
        u32 index = y * width + x; if (flags[index] & 1) continue;
        u32 context = significance(x, y); if (!context) continue;
        if (read(context)) sign(x, y, plane); flags[index] |= 2;
      }
    }
  }
  void refinement(u32 plane) {
    for (u32 stripe = 0; stripe < height; stripe += 4) for (u32 x = 0; x < width; ++x) {
      for (u32 y = stripe; y < height && y < stripe + 4; ++y) {
        u32 index = y * width + x; if (!(flags[index] & 1) || (flags[index] & 2)) continue;
        u32 h, v, d, context = flags[index] & 4 ? 16 : neighbours(x, y, h, v, d) ? 15 : 14;
        values[index] |= read(context) << plane; flags[index] |= 4;
      }
    }
  }
  void cleanup(u32 plane) {
    for (u32 stripe = 0; stripe < height; stripe += 4) for (u32 x = 0; x < width; ++x) {
      u32 start = stripe; bool run = stripe + 4 <= height;
      for (u32 y = stripe; run && y < stripe + 4; ++y) if ((flags[y * width + x] & 3) || significance(x, y)) run = false;
      if (run) {
        if (!read(17)) continue;
        const u32 high = read(18), low = read(18); start += (high << 1) | low; sign(x, start++, plane);
      }
      for (u32 y = start; y < height && y < stripe + 4; ++y) {
        u32 index = y * width + x; if (flags[index] & 3) continue;
        if (read(significance(x, y))) sign(x, y, plane);
      }
    }
    if (style & 32) { u32 symbol = 0; for (u32 i = 0; i < 4; ++i) symbol = (symbol << 1) | read(18); if (symbol != 10) valid = false; }
    for (u32 i = 0; i < width * height; ++i) flags[i] &= ~2;
  }
};
}

// Status: 0 success, 1 malformed, 2 resource limit, 3 not-yet-supported coding style.
static unsigned int decode_block(unsigned int input, unsigned int length, unsigned int width, unsigned int height,
  unsigned int orientation, unsigned int bitplanes, unsigned int passes, unsigned int style, unsigned int output, unsigned int scratch, unsigned int irreversible,
  const unsigned int* segments, unsigned int segment_count) {
  using namespace pn_jpx;
  if (!width || !height || width > 1024 || height > 1024 || width * height > 4096 || orientation > 3 || !bitplanes || bitplanes > 30
    || !passes || passes > bitplanes * 3 - 2 || length > 32u * 1024 * 1024) return 2;
  if (style & ~63u) return 3;
  if (!segments || !segment_count || segment_count > 90) return 1;
  Block block{width, height, orientation, style, reinterpret_cast<i32*>(output), reinterpret_cast<u8*>(scratch)};
  for (u32 i = 0; i < width * height; ++i) { block.values[i] = 0; block.flags[i] = 0; }
  block.reset();
  u32 pass = 0, offset = 0; const u8 empty_termination = 255;
  for (u32 segment = 0; segment < segment_count && block.valid; ++segment) {
    const u32 size = segments[segment * 2], count = segments[segment * 2 + 1];
    if (!count || count > passes - pass || size > length - offset) return 1;
    const auto data = reinterpret_cast<const u8*>(input) + offset;
    block.bypass = (style & 1) && pass >= 10 && pass % 3;
    if (block.bypass) block.raw = RawReader{data, size, 0, 0, 0, 0, true, !(style & 16)};
    else if (!block.mq.start(size ? data : &empty_termination, size ? size : 1, true)) return 1;
    for (u32 local = 0; local < count && block.valid; ++local, ++pass) {
      if (block.bypass != static_cast<bool>((style & 1) && pass >= 10 && pass % 3)) return 1;
      u32 plane = pass ? bitplanes - 2 - (pass - 1) / 3 : bitplanes - 1;
      u32 mode = pass ? (pass - 1) % 3 : 2;
      if (mode == 0) block.propagation(plane); else if (mode == 1) block.refinement(plane); else block.cleanup(plane);
      if (style & 2) block.reset();
      const bool terminated = (style & 4) || ((style & 1) && pass >= 9 && (pass - 9) % 3 != 1);
      if (terminated && local + 1 < count) return 1;
      if (local + 1 == count && segment + 1 < segment_count && !terminated) return 1;
    }
    if (!block.bypass && (!block.mq.valid || block.mq.marker() >= 0)) return 1;
    offset += size;
  }
  if (!block.valid || pass != passes || offset != length) return 1;
  const u32 last = passes - 1, plane = last ? bitplanes - 2 - (last - 1) / 3 : bitplanes - 1;
  const u32 mode = last ? (last - 1) % 3 : 2;
  for (u32 i = 0; i < width * height; ++i) {
    const u32 lowest = plane + (mode == 0 && !(block.flags[i] & 2) ? 1 : 0);
    const double midpoint = (irreversible || lowest) && (block.flags[i] & 1) ? (1u << lowest) * 0.5 : 0;
    const double magnitude = block.values[i] + midpoint, value = block.flags[i] & 8 ? -magnitude : magnitude;
    if (irreversible) reinterpret_cast<float*>(output)[i] = static_cast<float>(value);
    else block.values[i] = static_cast<i32>(value);
  }
  return 0;
}

extern "C" unsigned int pn_pdf_jpx_block(unsigned int input, unsigned int length, unsigned int width, unsigned int height,
  unsigned int orientation, unsigned int bitplanes, unsigned int passes, unsigned int style, unsigned int output, unsigned int scratch, unsigned int irreversible) {
  if (style & 5) return 3;
  const unsigned int segment[] = {length, passes};
  return decode_block(input, length, width, height, orientation, bitplanes, passes, style, output, scratch, irreversible, segment, 1);
}

extern "C" unsigned int pn_pdf_jpx_block_segments(unsigned int input, unsigned int length, unsigned int width, unsigned int height,
  unsigned int orientation, unsigned int bitplanes, unsigned int passes, unsigned int style, unsigned int output, unsigned int scratch, unsigned int irreversible,
  unsigned int segments, unsigned int segment_count) {
  return decode_block(input, length, width, height, orientation, bitplanes, passes, style, output, scratch, irreversible, reinterpret_cast<const unsigned int*>(segments), segment_count);
}

namespace pn_jpx {
static long long floor_divide(long long value, int divisor) {
  return value < 0 ? -((-value + divisor - 1) / divisor) : value / divisor;
}
static bool write_integer(i32& destination, long long value) {
  if (value < -2147483648ll || value > 2147483647ll) return false;
  destination = static_cast<i32>(value); return true;
}
static bool inverse53(i32* values, u32 length, u32 stride, u32 origin) {
  origin &= 1;
  if (length == 1) { if (origin) values[0] = static_cast<i32>(floor_divide(values[0], 2)); return true; }
  for (u32 i = origin; i < length; i += 2) {
    const u32 left = i ? i - 1 : 1, right = i + 1 < length ? i + 1 : i - 1;
    const long long update = static_cast<long long>(values[left * stride]) + values[right * stride] + 2;
    if (!write_integer(values[i * stride], static_cast<long long>(values[i * stride]) - floor_divide(update, 4))) return false;
  }
  for (u32 i = 1 - origin; i < length; i += 2) {
    const u32 left = i ? i - 1 : 1, right = i + 1 < length ? i + 1 : i - 1;
    const long long update = static_cast<long long>(values[left * stride]) + values[right * stride];
    if (!write_integer(values[i * stride], static_cast<long long>(values[i * stride]) + floor_divide(update, 2))) return false;
  }
  return true;
}
}

// Interleaved 5/3 subbands, zero tile origin. T.800 F.3 reconstructs rows then columns.
extern "C" unsigned int pn_pdf_jpx_inverse53(unsigned int output, unsigned int width, unsigned int height, unsigned int x_origin, unsigned int y_origin) {
  using namespace pn_jpx;
  if (!width || !height || width > 16u * 1024 * 1024 || height > 16u * 1024 * 1024 || static_cast<unsigned long long>(width) * height > 16u * 1024 * 1024) return 2;
  auto data = reinterpret_cast<i32*>(output);
  for (u32 y = 0; y < height; ++y) if (!inverse53(data + y * width, width, 1, x_origin)) return 1;
  for (u32 x = 0; x < width; ++x) if (!inverse53(data + x, height, width, y_origin)) return 1;
  return 0;
}

namespace pn_jpx {
static bool inverse97(float* values, u32 length, u32 stride, u32 origin) {
  origin &= 1;
  if (length == 1) { if (origin) values[0] /= 2; return true; }
  constexpr double k = 1.230174104914001;
  for (u32 i = 0; i < length; ++i) values[i * stride] = static_cast<float>(values[i * stride] * ((i + origin) & 1 ? 1 / k : k));
  // T.800 F.7: reverse the four analysis lifting steps, symmetric extension.
  constexpr double coefficients[] = {0.443506852043971, 0.882911075530934, -0.052980118572961, -1.586134342059924};
  for (u32 step = 0; step < 4; ++step) for (u32 i = (step + origin) & 1; i < length; i += 2) {
    const u32 left = i ? i - 1 : 1, right = i + 1 < length ? i + 1 : i - 1;
    const double value = values[i * stride] - coefficients[step] * (static_cast<double>(values[left * stride]) + values[right * stride]);
    if (!__builtin_isfinite(value) || value < -1e30 || value > 1e30) return false;
    values[i * stride] = static_cast<float>(value);
  }
  return true;
}
}

extern "C" unsigned int pn_pdf_jpx_inverse97(unsigned int output, unsigned int width, unsigned int height, unsigned int x_origin, unsigned int y_origin) {
  using namespace pn_jpx;
  if (!width || !height || static_cast<unsigned long long>(width) * height > 16u * 1024 * 1024) return 2;
  auto data = reinterpret_cast<float*>(output);
  for (u32 y = 0; y < height; ++y) if (!inverse97(data + y * width, width, 1, x_origin)) return 1;
  for (u32 x = 0; x < width; ++x) if (!inverse97(data + x, height, width, y_origin)) return 1;
  return 0;
}
