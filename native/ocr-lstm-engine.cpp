// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original fixed English int8 neural operators over PageNarrator's existing arena.
#include "ocr-engine.cpp"
#include <wasm_simd128.h>
using i8 = signed char;
using u64 = unsigned long long;
static const float* tess_tanh;
static const float* tess_logistic;
static u64 tess_random = 1;

extern "C" void pn_tess_tables(const float* tanh_data, const float* logistic_data) {
  tess_tanh = tanh_data; tess_logistic = logistic_data;
}
extern "C" void pn_tess_seed(u32 low, u32 high) { tess_random = static_cast<u64>(high) << 32 | low; }
static int tess_round(float value) { return value < 0 ? -static_cast<int>(-value + .5f) : static_cast<int>(value + .5f); }
static i8 tess_quantize(float value) {
  int result = tess_round(value * 127.0f); return static_cast<i8>(result < -127 ? -127 : result > 127 ? 127 : result);
}
static float tess_activation(float value, bool logistic = false) {
  bool negative = value < 0;
  float position = (negative ? -value : value) * 256.0f;
  u32 index = static_cast<u32>(position);
  const float* table = logistic ? tess_logistic : tess_tanh;
  float result = index >= 4095 ? 1.0f : table[index] + (table[index + 1] - table[index]) * (position - index);
  return negative ? logistic ? 1.0f - result : -result : result;
}
static int tess_dot(const i8* a, const i8* b, u32 count) {
  v128_t sum = wasm_i32x4_splat(0); u32 offset = 0;
  for (; offset + 16 <= count; offset += 16) {
    v128_t x = wasm_v128_load(a + offset), y = wasm_v128_load(b + offset);
    sum = wasm_i32x4_add(sum, wasm_i32x4_dot_i16x8(wasm_i16x8_extend_low_i8x16(x), wasm_i16x8_extend_low_i8x16(y)));
    sum = wasm_i32x4_add(sum, wasm_i32x4_dot_i16x8(wasm_i16x8_extend_high_i8x16(x), wasm_i16x8_extend_high_i8x16(y)));
  }
  int result = wasm_i32x4_extract_lane(sum, 0) + wasm_i32x4_extract_lane(sum, 1)
    + wasm_i32x4_extract_lane(sum, 2) + wasm_i32x4_extract_lane(sum, 3);
  for (; offset < count; offset++) result += static_cast<int>(a[offset]) * b[offset];
  return result;
}
static float tess_row(const i8* input, const i8* row, float scale, u32 count) {
  return (tess_dot(input, row, count) + static_cast<int>(row[count]) * 127) * scale;
}
static i8 tess_noise() {
  tess_random = tess_random * 6364136223846793005ULL + 1442695040888963407ULL;
  double value = 254.0 * static_cast<double>(tess_random >> 33) / 2147483647.0 - 127.0;
  return static_cast<i8>(value < 0 ? -static_cast<int>(-value + .5) : static_cast<int>(value + .5));
}

extern "C" int pn_tess_conv(const i8* input, const i8* weights, const float* scales, i8* output, const u32* p) {
  const u32 height = p[0], width = p[1];
  if (!tess_tanh || !height || height > 48 || !width || width > 8192) return 1;
  i8 neighborhood[9];
  for (u32 y = 0; y < height; y++) for (u32 x = 0; x < width; x++) {
    u32 position = 0;
    for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) {
      int sx = static_cast<int>(x) + dx, sy = static_cast<int>(y) + dy;
      neighborhood[position++] = sx < 0 || sx >= static_cast<int>(width) || sy < 0 || sy >= static_cast<int>(height)
        ? tess_noise() : input[sy * width + sx];
    }
    for (u32 channel = 0; channel < 16; channel++) output[(y * width + x) * 16 + channel]
      = tess_quantize(tess_activation(tess_row(neighborhood, weights + channel * 10, scales[channel], 9)));
  }
  return 0;
}

extern "C" int pn_tess_pool(const i8* input, i8* output, const u32* p) {
  const u32 height = p[0], width = p[1], channels = p[2], out_height = height / 3, out_width = width / 3;
  if (!out_height || !out_width || channels > 512) return 1;
  for (u32 y = 0; y < out_height; y++) for (u32 x = 0; x < out_width; x++) for (u32 channel = 0; channel < channels; channel++) {
    i8 maximum = -127;
    for (u32 dy = 0; dy < 3; dy++) for (u32 dx = 0; dx < 3; dx++) {
      i8 value = input[((y * 3 + dy) * width + x * 3 + dx) * channels + channel];
      if (value > maximum) maximum = value;
    }
    output[(y * out_width + x) * channels + channel] = maximum;
  }
  return 0;
}

extern "C" int pn_tess_lstm(const i8* input, const i8* weights, const float* scales, i8* output, float* scratch, const u32* p) {
  const u32 height = p[0], width = p[1], channels = p[2], hidden = p[3];
  const bool vertical = p[4], reverse = p[5], summary = p[6];
  if (!tess_tanh || !tess_logistic || !height || height > 48 || !width || width > 8192 || !channels || channels > 512
    || !hidden || hidden > 512 || (summary && !vertical)) return 1;
  float* cell = scratch; float* recurrent = cell + hidden; float* gates = recurrent + hidden;
  i8* source = reinterpret_cast<i8*>(gates + hidden * 4);
  const u32 extent = channels + hidden, matrix = hidden * (extent + 1), steps = vertical ? height : width, lines = vertical ? width : height;
  for (u32 line = 0; line < lines; line++) {
    for (u32 channel = 0; channel < hidden; channel++) cell[channel] = recurrent[channel] = 0;
    for (u32 step = 0; step < steps; step++) {
      u32 time = reverse ? steps - 1 - step : step;
      u32 position = vertical ? time * width + line : line * width + time;
      for (u32 channel = 0; channel < channels; channel++) source[channel] = input[position * channels + channel];
      for (u32 channel = 0; channel < hidden; channel++) source[channels + channel] = tess_quantize(recurrent[channel]);
      for (u32 gate = 0; gate < 4; gate++) for (u32 channel = 0; channel < hidden; channel++) {
        float value = tess_row(source, weights + gate * matrix + channel * (extent + 1), scales[gate * hidden + channel], extent);
        gates[gate * hidden + channel] = tess_activation(value, gate != 0);
      }
      for (u32 channel = 0; channel < hidden; channel++) {
        float value = cell[channel] * gates[hidden * 2 + channel] + gates[channel] * gates[hidden + channel];
        cell[channel] = value < -100 ? -100 : value > 100 ? 100 : value;
        recurrent[channel] = tess_activation(cell[channel]) * gates[hidden * 3 + channel];
        if (!summary || step + 1 == steps) output[(summary ? line : position) * hidden + channel] = tess_quantize(recurrent[channel]);
      }
    }
  }
  return 0;
}

extern "C" int pn_tess_affine(const i8* input, const i8* weights, const float* scales, float* output, const u32* p) {
  const u32 steps = p[0], channels = p[1], classes = p[2];
  if (!steps || steps > 8192 || !channels || channels > 512 || !classes || classes > 256) return 1;
  for (u32 step = 0; step < steps; step++) for (u32 label = 0; label < classes; label++)
    output[step * classes + label] = tess_row(input + step * channels, weights + label * (channels + 1), scales[label], channels);
  return 0;
}
