// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Freestanding C++20 CPU kernels. No inference, math, or allocator library is linked.
using u32 = unsigned int;
using f32x4 = float __attribute__((vector_size(16)));
static_assert(sizeof(float) == 4 && sizeof(u32) == 4);

static float from_bits(u32 bits) {
  float value;
  __builtin_memcpy(&value, &bits, 4);
  return value;
}

static float exponential(float x) {
  if (x != x) return x;
  if (x > 88.722839f) return from_bits(0x7f800000u);
  if (x < -103.97208f) return 0.0f;
  int exponent = static_cast<int>(__builtin_floorf(x * 1.4426950408889634f + 0.5f));
  float r = (x - exponent * 0.693145751953125f) - exponent * 0.000001428606765330187f;
  float p = 1.0f + r * (1.0f + r * (0.5f + r * (0.16666666666666667f
    + r * (0.041666666666666664f + r * (0.008333333333333333f
    + r * (0.001388888888888889f + r * (0.0001984126984126984f
    + r * 0.0000248015873015873f)))))));
  if (exponent > 127) return (p * from_bits(254u << 23)) * 2.0f;
  if (exponent < -150) return 0.0f;
  if (exponent == -150) return (p * 0.5f) * from_bits(1u);
  if (exponent < -126) return p * from_bits(1u << (exponent + 149));
  return p * from_bits(static_cast<u32>(exponent + 127) << 23);
}

static float error_function(float x) {
  if (x == 0.0f) return x;
  float a = __builtin_fabsf(x);
  float t = 1.0f / (1.0f + 0.3275911f * a);
  float p = (((((1.061405429f * t - 1.453152027f) * t) + 1.421413741f) * t
    - 0.284496736f) * t + 0.254829592f) * t;
  float result = 1.0f - p * exponential(-a * a);
  return x < 0.0f ? -result : result;
}

extern "C" u32 pn_abi_version() { return 1; }

extern "C" void pn_matmul(const float* a, const float* b, float* out, u32 m, u32 n, u32 k) {
  for (u32 row = 0; row < m; ++row) {
    u32 col = 0;
    for (; col + 4 <= n; col += 4) {
      f32x4 sum = {0, 0, 0, 0};
      for (u32 j = 0; j < k; ++j) {
        f32x4 values;
        __builtin_memcpy(&values, b + j * n + col, 16);
        float scalar = a[row * k + j];
        sum += f32x4{scalar, scalar, scalar, scalar} * values;
      }
      __builtin_memcpy(out + row * n + col, &sum, 16);
    }
    for (; col < n; ++col) {
      float sum = 0.0f;
      for (u32 j = 0; j < k; ++j) sum += a[row * k + j] * b[j * n + col];
      out[row * n + col] = sum;
    }
  }
}

extern "C" void pn_binary(const float* a, const float* b, float* out, u32 count, u32 op) {
  for (u32 i = 0; i < count; ++i) {
    out[i] = op == 0 ? a[i] + b[i] : op == 1 ? a[i] * b[i] : op == 2 ? a[i] / b[i] : a[i] - b[i];
  }
}

extern "C" void pn_unary(const float* a, float* out, u32 count, u32 op, float alpha, float beta) {
  for (u32 i = 0; i < count; ++i) {
    float x = a[i];
    switch (op) {
      case 1: out[i] = x < 0.0f ? 0.0f : x; break;
      case 2: { float e = exponential(x < 0.0f ? x : -x); out[i] = x < 0.0f ? e / (1.0f + e) : 1.0f / (1.0f + e); break; }
      case 3: { float e = exponential(-2.0f * __builtin_fabsf(x)); float t = (1.0f - e) / (1.0f + e); out[i] = x < 0.0f ? -t : t; break; }
      case 4: out[i] = error_function(x); break;
      case 5: out[i] = __builtin_sqrtf(x); break;
      case 6: out[i] = exponential(x); break;
      case 7: out[i] = -x; break;
      case 8: out[i] = 1.0f / x; break;
      case 9: { float v = alpha * x + beta; out[i] = v < 0.0f ? 0.0f : v > 1.0f ? 1.0f : v; break; }
      default: out[i] = x;
    }
  }
}
