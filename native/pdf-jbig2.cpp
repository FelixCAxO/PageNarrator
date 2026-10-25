// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
#include "pdf-mq.h"
using u8 = unsigned char; using u32 = unsigned int; using i32 = int;
struct JbigResult { u32 status, length, consumed; };
static JbigResult result;
struct Point { i32 x, y; };
static constexpr Point fixed_templates[4][12] = {
  {{-1,-2},{0,-2},{1,-2},{-2,-1},{-1,-1},{0,-1},{1,-1},{2,-1},{-4,0},{-3,0},{-2,0},{-1,0}},
  {{-1,-2},{0,-2},{1,-2},{2,-2},{-2,-1},{-1,-1},{0,-1},{1,-1},{2,-1},{-3,0},{-2,0},{-1,0}},
  {{-1,-2},{0,-2},{1,-2},{-2,-1},{-1,-1},{0,-1},{1,-1},{-2,0},{-1,0}},
  {{-3,-1},{-2,-1},{-1,-1},{0,-1},{1,-1},{-4,0},{-3,0},{-2,0},{-1,0}}
};
static constexpr u32 fixed_counts[] = {12,12,9,9};
// Figure 8..11 values in fixed-template order followed by A1..A4.
static constexpr u32 sltp_contexts[] = {0b0011100101010011,0b0011110011010,0b0011100011,0b0110001011};
static u32 pixel(const u8* data, u32 width, u32 height, i32 x, i32 y) {
  return x < 0 || y < 0 || x >= static_cast<i32>(width) || y >= static_cast<i32>(height) ? 0 : (data[static_cast<u32>(y) * ((width + 7) / 8) + (static_cast<u32>(x) >> 3)] >> (7 - (x & 7))) & 1;
}
struct GenericBitmap {
  Point points[16]; u32 point_count = 0, template_id = 0;
  bool configure(u32 id, const i32* adaptive) {
    if (id > 3) return false; template_id = id;
    const u32 fixed_count = fixed_counts[id], adaptive_count = id ? 1 : 4; point_count = fixed_count + adaptive_count;
    for (u32 i = 0; i < fixed_count; ++i) points[i] = fixed_templates[id][i];
    for (u32 i = 0; i < adaptive_count; ++i) {
      const i32 x = adaptive[i * 2], y = adaptive[i * 2 + 1];
      if (x < -1000000 || x > 1000000 || y < -1000000 || y > 0 || (!y && x >= 0)) return false;
      points[fixed_count + i] = {x,y};
    }
    return true;
  }
  bool decode(pn_pdf::MqDecoder& decoder, pn_pdf::MqContext* contexts, u8* output, u32 width, u32 height, bool typical = false, const u8* skip = nullptr) const {
    const u32 stride = (width + 7) / 8; for (u32 i = 0; i < stride * height; ++i) output[i] = 0; bool predicted = false;
    for (u32 y = 0; y < height; ++y) {
      if (typical) { const int bit = decoder.read(contexts[sltp_contexts[template_id]]); if (bit < 0) return false; predicted ^= bit; }
      if (predicted) { if (y) for (u32 x = 0; x < stride; ++x) output[y * stride + x] = output[(y - 1) * stride + x]; continue; }
      for (u32 x = 0; x < width; ++x) {
        if (skip && (skip[y * stride + (x >> 3)] & (128 >> (x & 7)))) continue;
        u32 context = 0;
        for (u32 i = 0; i < point_count; ++i) context = context * 2 + pixel(output, width, height, static_cast<i32>(x) + points[i].x, static_cast<i32>(y) + points[i].y);
        const int bit = decoder.read(contexts[context]); if (bit < 0) return false; output[y * stride + (x >> 3)] |= static_cast<u8>(bit << (7 - (x & 7)));
      }
    }
    return true;
  }
};
struct ArithmeticValue { u32 status; i32 value; };
static ArithmeticValue arithmetic_value;
extern "C" u32 pn_jbig2_arith_size() { return sizeof(pn_pdf::MqDecoder); }
extern "C" u32 pn_jbig2_arith_start(pn_pdf::MqDecoder* decoder, const u8* input, u32 length) {
  if (length < 2 || length > 128u * 1024 * 1024 || input[length - 2] != 255 || input[length - 1] != 172) return 1;
  return decoder->start(input, length) ? 0 : 1;
}
extern "C" const ArithmeticValue* pn_jbig2_arith_integer(pn_pdf::MqDecoder* decoder, pn_pdf::MqContext* contexts) {
  arithmetic_value = {}; u32 previous = 1;
  auto next = [&]() { const int bit = decoder->read(contexts[previous]); if (bit >= 0) previous = previous < 256 ? previous * 2 + bit : ((previous * 2 + bit) & 511) | 256; return bit; };
  const int sign = next(); if (sign < 0) { arithmetic_value.status = 1; return &arithmetic_value; }
  u32 category = 0;
  while (category < 5) { const int bit = next(); if (bit < 0) { arithmetic_value.status = 1; return &arithmetic_value; } if (!bit) break; ++category; }
  static constexpr u32 sizes[] = {2,4,6,8,12,32}, offsets[] = {0,4,20,84,340,4436}; unsigned long long value = 0;
  for (u32 i = 0; i < sizes[category]; ++i) { const int bit = next(); if (bit < 0) { arithmetic_value.status = 1; return &arithmetic_value; } value = value * 2 + bit; }
  value += offsets[category];
  if (value > (sign ? 2147483648ull : 2147483647ull)) { arithmetic_value.status = 1; return &arithmetic_value; }
  if (sign && !value) arithmetic_value.status = 4;
  else arithmetic_value.value = static_cast<i32>(sign ? -static_cast<long long>(value) : static_cast<long long>(value));
  if (!decoder->valid || (decoder->marker() >= 0 && decoder->marker() != 172)) arithmetic_value.status = 1;
  return &arithmetic_value;
}
extern "C" const ArithmeticValue* pn_jbig2_arith_id(pn_pdf::MqDecoder* decoder, u32 bits, pn_pdf::MqContext* contexts) {
  arithmetic_value = {}; if (bits > 17) { arithmetic_value.status = 2; return &arithmetic_value; } u32 previous = 1;
  for (u32 i = 0; i < bits; ++i) { const int bit = decoder->read(contexts[previous]); if (bit < 0) { arithmetic_value.status = 1; return &arithmetic_value; } previous = previous * 2 + bit; }
  arithmetic_value.value = static_cast<i32>(previous - (1u << bits)); return &arithmetic_value;
}
extern "C" const JbigResult* pn_jbig2_arith_generic(pn_pdf::MqDecoder* decoder, u32 width, u32 height, u32 template_id, const i32* adaptive, u8* output, u32 capacity, pn_pdf::MqContext* contexts) {
  result = {}; const auto pixels = static_cast<unsigned long long>(width) * height;
  if (!width || !height || width > 1000000 || height > 1000000 || pixels > 16000000) { result.status = 2; return &result; }
  const u32 size = (width + 7) / 8 * height; if (capacity < size) { result.status = 2; return &result; }
  GenericBitmap bitmap;
  if (!bitmap.configure(template_id, adaptive) || !bitmap.decode(*decoder, contexts, output, width, height) || (decoder->marker() >= 0 && decoder->marker() != 172)) { result.status = 1; return &result; }
  result.length = size; return &result;
}
extern "C" const JbigResult* pn_pdf_mq_bits(const u8* input, u32 length, u32 count, u32 initial_state, u8* output, u32 capacity) {
  result = {}; const u32 size = (count + 7) / 8;
  if (count > 16000000 || initial_state > 93 || length > 128u * 1024 * 1024) { result.status = 2; return &result; }
  if (capacity < size) { result.status = 2; return &result; }
  pn_pdf::MqDecoder decoder; pn_pdf::MqContext context{static_cast<u8>(initial_state >> 1), static_cast<u8>(initial_state & 1)};
  if (!decoder.start(input, length)) { result.status = 1; return &result; }
  for (u32 i = 0; i < size; ++i) output[i] = 0;
  for (u32 i = 0; i < count; ++i) { const int value = decoder.read(context); if (value < 0) { result.status = 1; return &result; } output[i >> 3] |= static_cast<u8>(value << (7 - (i & 7))); }
  result.length = size; return &result;
}
extern "C" const JbigResult* pn_jbig2_arith_refine(pn_pdf::MqDecoder* decoder, u32 width, u32 height, u32 template_id, u32 typical, const signed char* adaptive, const u8* reference, u32 reference_width, u32 reference_height, i32 dx, i32 dy, u8* output, u32 capacity, pn_pdf::MqContext* contexts) {
  result = {};
  if (!width || !height || width > 1000000 || height > 1000000 || static_cast<unsigned long long>(width) * height > 16000000 || !reference_width || !reference_height || reference_width > 1000000 || reference_height > 1000000 || static_cast<unsigned long long>(reference_width) * reference_height > 16000000) { result.status = 2; return &result; }
  if (template_id > 1 || typical > 1 || dx < -1000000 || dx > 1000000 || dy < -1000000 || dy > 1000000) { result.status = 1; return &result; }
  const u32 stride = (width + 7) / 8, size = stride * height, out_count = template_id ? 4 : 3;
  if (capacity < size) { result.status = 2; return &result; }
  Point out_points[4] = {{0,-1},{1,-1},{-1,0}}; if (template_id) { out_points[0] = {-1,-1}; out_points[1] = {0,-1}; out_points[2] = {1,-1}; out_points[3] = {-1,0}; }
  Point ref_points[8] = {{0,-1},{1,-1},{-1,0},{0,0},{1,0},{-1,1},{0,1},{1,1}};
  if (template_id) { ref_points[0] = {0,-1}; ref_points[1] = {-1,0}; ref_points[2] = {0,0}; ref_points[3] = {1,0}; ref_points[4] = {0,1}; ref_points[5] = {1,1}; }
  if (!template_id && (adaptive[1] > 0 || (!adaptive[1] && adaptive[0] >= 0))) { result.status = 1; return &result; }
  for (u32 i = 0; i < size; ++i) output[i] = 0;
  bool predicted = false;
  for (u32 y = 0; y < height; ++y) {
    if (typical) { const int value = decoder->read(contexts[template_id ? 8 : 64]); if (value < 0) { result.status = 1; return &result; } predicted ^= value; }
    for (u32 x = 0; x < width; ++x) {
      const i32 rx = static_cast<i32>(x) - dx, ry = static_cast<i32>(y) - dy;
      int value = -1;
      if (predicted) {
        const auto center = pixel(reference, reference_width, reference_height, rx, ry); bool equal = true;
        for (i32 sy = -1; sy <= 1; ++sy) for (i32 sx = -1; sx <= 1; ++sx) if (pixel(reference, reference_width, reference_height, rx + sx, ry + sy) != center) equal = false;
        if (equal) value = static_cast<int>(center);
      }
      if (value < 0) {
        u32 context = 0;
        for (u32 i = 0; i < out_count; ++i) context = context * 2 + pixel(output, width, height, static_cast<i32>(x) + out_points[i].x, static_cast<i32>(y) + out_points[i].y);
        for (u32 i = 0; i < (template_id ? 6u : 8u); ++i) context = context * 2 + pixel(reference, reference_width, reference_height, rx + ref_points[i].x, ry + ref_points[i].y);
        if (!template_id) { context = context * 2 + pixel(output, width, height, static_cast<i32>(x) + adaptive[0], static_cast<i32>(y) + adaptive[1]); context = context * 2 + pixel(reference, reference_width, reference_height, rx + adaptive[2], ry + adaptive[3]); }
        value = decoder->read(contexts[context]); if (value < 0) { result.status = 1; return &result; }
      }
      output[y * stride + (x >> 3)] |= static_cast<u8>(value << (7 - (x & 7)));
    }
  }
  if (decoder->marker() >= 0 && decoder->marker() != 172) { result.status = 1; return &result; } result.length = size; result.consumed = decoder->position + 2; return &result;
}
extern "C" const JbigResult* pn_jbig2_refine(const u8* input, u32 length, u32 width, u32 height, u32 template_id, u32 typical, const signed char* adaptive, const u8* reference, u32 reference_width, u32 reference_height, i32 dx, i32 dy, u8* output, u32 capacity, pn_pdf::MqContext* contexts) {
  result = {};
  if (length > 128u * 1024 * 1024) { result.status = 2; return &result; }
  if (template_id > 1 || length < 2 || input[length - 2] != 255 || input[length - 1] != 172) { result.status = 1; return &result; }
  for (u32 i = 0; i < (template_id ? 1024u : 8192u); ++i) contexts[i] = {};
  pn_pdf::MqDecoder decoder; if (!decoder.start(input, length)) { result.status = 1; return &result; }
  return pn_jbig2_arith_refine(&decoder, width, height, template_id, typical, adaptive, reference, reference_width, reference_height, dx, dy, output, capacity, contexts);
}
extern "C" const JbigResult* pn_jbig2_generic(const u8* input, u32 length, u32 width, u32 height, u32 template_id, u32 typical, const i32* adaptive, u8* output, u32 capacity, pn_pdf::MqContext* contexts) {
  result = {};
  if (!width || !height || width > 1000000 || height > 1000000 || static_cast<unsigned long long>(width) * height > 16000000 || length > 128u * 1024 * 1024) { result.status = 2; return &result; }
  if (template_id > 3 || typical > 1 || length < 2 || input[length - 2] != 255 || input[length - 1] != 0xac) { result.status = 1; return &result; }
  const u32 stride = (width + 7) / 8, size = stride * height;
  if (capacity < size) { result.status = 2; return &result; }
  GenericBitmap bitmap; if (!bitmap.configure(template_id, adaptive)) { result.status = 1; return &result; }
  const u32 context_count = 1u << bitmap.point_count;
  for (u32 i = 0; i < context_count; ++i) contexts[i] = {};
  pn_pdf::MqDecoder decoder; if (!decoder.start(input, length)) { result.status = 1; return &result; }
  if (!bitmap.decode(decoder, contexts, output, width, height, typical)) { result.status = 1; return &result; }
  result.length = size; return &result;
}
extern "C" const JbigResult* pn_jbig2_halftone(const u8* input, u32 length, u32 width, u32 height, u32 template_id, u32 planes, const u8* skip, u8* output, u32 capacity, pn_pdf::MqContext* contexts) {
  result = {};
  const auto pixels = static_cast<unsigned long long>(width) * height;
  if (!width || !height || width > 1000000 || height > 1000000 || pixels > 16000000 || planes > 16 || pixels * planes > 64000000 || length > 128u * 1024 * 1024) { result.status = 2; return &result; }
  if (template_id > 3 || !planes || length < 2 || input[length - 2] != 255 || input[length - 1] != 0xac) { result.status = 1; return &result; }
  const u32 size = (width + 7) / 8 * height;
  if (capacity < size * planes) { result.status = 2; return &result; }
  const i32 adaptive[] = {template_id < 2 ? 3 : 2,-1,-3,-1,2,-2,-2,-2}; GenericBitmap bitmap; bitmap.configure(template_id, adaptive);
  for (u32 i = 0; i < (1u << bitmap.point_count); ++i) contexts[i] = {};
  pn_pdf::MqDecoder decoder; if (!decoder.start(input, length)) { result.status = 1; return &result; }
  for (u32 plane = 0; plane < planes; ++plane) if (!bitmap.decode(decoder, contexts, output + plane * size, width, height, false, skip)) { result.status = 1; return &result; }
  result.length = size * planes; return &result;
}
