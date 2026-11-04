// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded legacy-PDF decryption primitives. Algorithm definitions:
// RFC 1321 sections 3.1-3.4 (not its reference implementation), FIPS 197
// and SP 800-38A; RC4 test vectors: RFC 6229. No implementation is incorporated.
#include "pdf-crypto.h"
using u8 = unsigned char; using u32 = unsigned int; using u64 = unsigned long long;
namespace pn_pdf {
static constexpr u32 md5_constants[] = {
  0xd76aa478u,0xe8c7b756u,0x242070dbu,0xc1bdceeeu,0xf57c0fafu,0x4787c62au,0xa8304613u,0xfd469501u,
  0x698098d8u,0x8b44f7afu,0xffff5bb1u,0x895cd7beu,0x6b901122u,0xfd987193u,0xa679438eu,0x49b40821u,
  0xf61e2562u,0xc040b340u,0x265e5a51u,0xe9b6c7aau,0xd62f105du,0x2441453u,0xd8a1e681u,0xe7d3fbc8u,
  0x21e1cde6u,0xc33707d6u,0xf4d50d87u,0x455a14edu,0xa9e3e905u,0xfcefa3f8u,0x676f02d9u,0x8d2a4c8au,
  0xfffa3942u,0x8771f681u,0x6d9d6122u,0xfde5380cu,0xa4beea44u,0x4bdecfa9u,0xf6bb4b60u,0xbebfbc70u,
  0x289b7ec6u,0xeaa127fau,0xd4ef3085u,0x4881d05u,0xd9d4d039u,0xe6db99e5u,0x1fa27cf8u,0xc4ac5665u,
  0xf4292244u,0x432aff97u,0xab9423a7u,0xfc93a039u,0x655b59c3u,0x8f0ccc92u,0xffeff47du,0x85845dd1u,
  0x6fa87e4fu,0xfe2ce6e0u,0xa3014314u,0x4e0811a1u,0xf7537e82u,0xbd3af235u,0x2ad7d2bbu,0xeb86d391u
};
static constexpr u8 md5_shifts[] = {7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21};
static u32 rotate(u32 x, u32 count) { return (x << count) | (x >> (32 - count)); }
bool md5(const u8* input, u32 length, u8* output) {
  if (length > 128u * 1024 * 1024) return false;
  u32 state[4] = {0x67452301,0xefcdab89,0x98badcfe,0x10325476};
  const u32 blocks = (length + 9 + 63) / 64; const u64 bits = static_cast<u64>(length) * 8;
  for (u32 block = 0; block < blocks; ++block) {
    u32 words[16] = {};
    for (u32 i = 0; i < 64; ++i) {
      const u32 offset = block * 64 + i;
      const u8 value = offset < length ? input[offset] : offset == length ? 128 : offset >= blocks * 64 - 8 ? static_cast<u8>(bits >> ((offset - (blocks * 64 - 8)) * 8)) : 0;
      words[i / 4] |= static_cast<u32>(value) << ((i & 3) * 8);
    }
    u32 a = state[0], b = state[1], c = state[2], d = state[3];
    for (u32 i = 0; i < 64; ++i) {
      const u32 round = i / 16, f = !round ? (b & c) | (~b & d) : round == 1 ? (b & d) | (c & ~d) : round == 2 ? b ^ c ^ d : c ^ (b | ~d);
      const u32 word = !round ? i : round == 1 ? (5 * i + 1) & 15 : round == 2 ? (3 * i + 5) & 15 : (7 * i) & 15;
      const u32 value = b + rotate(a + f + words[word] + md5_constants[i], md5_shifts[round * 4 + (i & 3)]);
      a = d; d = c; c = b; b = value;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
  }
  for (u32 i = 0; i < 16; ++i) output[i] = static_cast<u8>(state[i / 4] >> ((i & 3) * 8));
  return true;
}
bool rc4(const u8* key, u32 key_length, const u8* input, u32 length, u8* output) {
  if (!key_length || key_length > 256 || length > 128u * 1024 * 1024) return false;
  u8 permutation[256]; for (u32 i = 0; i < 256; ++i) permutation[i] = static_cast<u8>(i);
  u32 j = 0; for (u32 i = 0; i < 256; ++i) { j = (j + permutation[i] + key[i % key_length]) & 255; const auto value = permutation[i]; permutation[i] = permutation[j]; permutation[j] = value; }
  u32 i = 0; j = 0;
  for (u32 p = 0; p < length; ++p) { i = (i + 1) & 255; j = (j + permutation[i]) & 255; const auto value = permutation[i]; permutation[i] = permutation[j]; permutation[j] = value; output[p] = input[p] ^ permutation[(permutation[i] + permutation[j]) & 255]; }
  for (auto& value : permutation) value = 0; return true;
}
static u8 aes_sbox[256], aes_inverse[256]; static bool aes_initialized;
static u8 multiply(u8 a, u8 b) {
  u8 value = 0; for (u32 i = 0; i < 8; ++i) { if (b & 1) value ^= a; a = static_cast<u8>((a << 1) ^ (a & 128 ? 0x1b : 0)); b >>= 1; } return value;
}
static void init_aes() {
  if (aes_initialized) return;
  for (u32 i = 0; i < 256; ++i) {
    u8 inverse = 1, factor = static_cast<u8>(i); u32 power = 254;
    while (power) { if (power & 1) inverse = multiply(inverse, factor); factor = multiply(factor, factor); power >>= 1; }
    const u32 x = i ? inverse : 0;
    const u8 value = static_cast<u8>(x ^ ((x << 1) | (x >> 7)) ^ ((x << 2) | (x >> 6)) ^ ((x << 3) | (x >> 5)) ^ ((x << 4) | (x >> 4)) ^ 0x63);
    aes_sbox[i] = value; aes_inverse[value] = static_cast<u8>(i);
  }
  aes_initialized = true;
}
bool aes_cbc_decrypt(const u8* key, u32 key_length, const u8* iv, const u8* input, u32 length, u8* output) {
  if ((key_length != 16 && key_length != 24 && key_length != 32) || length % 16 || length > 128u * 1024 * 1024) return false;
  init_aes(); u8 expanded[240], previous[16]; const u32 words = key_length / 4, rounds = words + 6;
  for (u32 i = 0; i < key_length; ++i) expanded[i] = key[i];
  u8 rcon = 1;
  for (u32 i = words; i < 4 * (rounds + 1); ++i) {
    u8 word[4]; for (u32 j = 0; j < 4; ++j) word[j] = expanded[(i - 1) * 4 + j];
    if (i % words == 0) { const auto first = word[0]; for (u32 j = 0; j < 3; ++j) word[j] = aes_sbox[word[j + 1]]; word[3] = aes_sbox[first]; word[0] ^= rcon; rcon = multiply(rcon, 2); }
    else if (words > 6 && i % words == 4) for (auto& value : word) value = aes_sbox[value];
    for (u32 j = 0; j < 4; ++j) expanded[i * 4 + j] = expanded[(i - words) * 4 + j] ^ word[j];
  }
  for (u32 i = 0; i < 16; ++i) previous[i] = iv[i];
  for (u32 offset = 0; offset < length; offset += 16) {
    u8 state[16], encrypted[16]; for (u32 i = 0; i < 16; ++i) { encrypted[i] = input[offset + i]; state[i] = encrypted[i] ^ expanded[rounds * 16 + i]; }
    for (u32 round = rounds; round > 0; --round) {
      u8 shifted[16]; for (u32 column = 0; column < 4; ++column) for (u32 row = 0; row < 4; ++row) shifted[column * 4 + row] = aes_inverse[state[((column + 4 - row) & 3) * 4 + row]];
      for (u32 i = 0; i < 16; ++i) state[i] = shifted[i] ^ expanded[(round - 1) * 16 + i];
      if (round > 1) for (u32 column = 0; column < 4; ++column) {
        const u32 i = column * 4; const u8 a = state[i], b = state[i + 1], c = state[i + 2], d = state[i + 3];
        state[i] = multiply(a,14) ^ multiply(b,11) ^ multiply(c,13) ^ multiply(d,9);
        state[i + 1] = multiply(a,9) ^ multiply(b,14) ^ multiply(c,11) ^ multiply(d,13);
        state[i + 2] = multiply(a,13) ^ multiply(b,9) ^ multiply(c,14) ^ multiply(d,11);
        state[i + 3] = multiply(a,11) ^ multiply(b,13) ^ multiply(c,9) ^ multiply(d,14);
      }
    }
    for (u32 i = 0; i < 16; ++i) { output[offset + i] = state[i] ^ previous[i]; previous[i] = encrypted[i]; }
  }
  for (auto& value : expanded) value = 0; for (auto& value : previous) value = 0; return true;
}
}
extern "C" unsigned int pn_pdf_md5(const u8* input, u32 length, u8* output) { return pn_pdf::md5(input, length, output); }
extern "C" unsigned int pn_pdf_rc4(const u8* key, u32 key_length, const u8* input, u32 length, u8* output) { return pn_pdf::rc4(key, key_length, input, length, output); }
extern "C" unsigned int pn_pdf_aes_decrypt(const u8* key, u32 key_length, const u8* iv, const u8* input, u32 length, u8* output) { return pn_pdf::aes_cbc_decrypt(key, key_length, iv, input, length, output); }
