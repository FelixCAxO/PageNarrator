// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// Original MQ binary arithmetic decoder. Probability state values and byte
// conventions are normative format data from ITU-T T.88 Annex E / T.800 Annex C.
namespace pn_pdf {
using MqByte = unsigned char; using MqWord = unsigned int;
struct MqContext { MqByte index = 0, mps = 0; };
struct MqEstimate { unsigned short qe; MqByte nmps, nlps, change; };
inline constexpr MqEstimate mq_estimates[] = {
  {0x5601,1,1,1},{0x3401,2,6,0},{0x1801,3,9,0},{0x0ac1,4,12,0},{0x0521,5,29,0},{0x0221,38,33,0},
  {0x5601,7,6,1},{0x5401,8,14,0},{0x4801,9,14,0},{0x3801,10,14,0},{0x3001,11,17,0},{0x2401,12,18,0},
  {0x1c01,13,20,0},{0x1601,29,21,0},{0x5601,15,14,1},{0x5401,16,14,0},{0x5101,17,15,0},{0x4801,18,16,0},
  {0x3801,19,17,0},{0x3401,20,18,0},{0x3001,21,19,0},{0x2801,22,19,0},{0x2401,23,20,0},{0x2201,24,21,0},
  {0x1c01,25,22,0},{0x1801,26,23,0},{0x1601,27,24,0},{0x1401,28,25,0},{0x1201,29,26,0},{0x1101,30,27,0},
  {0x0ac1,31,28,0},{0x09c1,32,29,0},{0x08a1,33,30,0},{0x0521,34,31,0},{0x0441,35,32,0},{0x02a1,36,33,0},
  {0x0221,37,34,0},{0x0141,38,35,0},{0x0111,39,36,0},{0x0085,40,37,0},{0x0049,41,38,0},{0x0025,42,39,0},
  {0x0015,43,40,0},{0x0009,44,41,0},{0x0005,45,42,0},{0x0001,45,43,0},{0x5601,46,46,0}
};
struct MqDecoder {
  const MqByte* bytes = nullptr; MqWord length = 0, position = 0, a = 0x8000, c = 0, count = 0;
  bool valid = false, pad_at_end = false, eof_padded = false;
  // Position remains on an actual FF marker prefix. A code-block caller may
  // explicitly request virtual FF termination bytes; no out-of-bounds read occurs.
  bool byte_in() {
    const MqWord current = position < length ? bytes[position] : 255;
    MqWord next = 255;
    if (position + 1 < length) next = bytes[position + 1];
    else { if (!pad_at_end) return valid = false; eof_padded = true; }
    if (current == 255 && next > 0x8f) { c += 0xff00; count = 8; }
    else { ++position; c += next << (current == 255 ? 9 : 8); count = current == 255 ? 7 : 8; }
    return true;
  }
  bool start(const MqByte* input, MqWord size, bool allow_end_padding = false) {
    bytes = input; length = size; position = 0; a = 0x8000; count = 0; pad_at_end = allow_end_padding; eof_padded = false;
    valid = input && size; if (!valid) return false; c = static_cast<MqWord>(bytes[0]) << 16;
    if (!byte_in()) return false; c <<= 7; count -= 7; return true;
  }
  int marker() const { return position + 1 < length && bytes[position] == 255 && bytes[position + 1] > 0x8f ? bytes[position + 1] : -1; }
  int read(MqContext& context) {
    if (!valid || context.index > 46 || context.mps > 1) { valid = false; return -1; }
    const auto estimate = mq_estimates[context.index]; a -= estimate.qe; int value = context.mps;
    if ((c >> 16) < estimate.qe) {
      if (a < estimate.qe) context.index = estimate.nmps;
      else { value ^= 1; context.mps ^= estimate.change; context.index = estimate.nlps; }
      a = estimate.qe;
    } else {
      c -= static_cast<MqWord>(estimate.qe) << 16; if (a & 0x8000) return value;
      if (a < estimate.qe) { value ^= 1; context.mps ^= estimate.change; context.index = estimate.nlps; }
      else context.index = estimate.nmps;
    }
    do { if (!count && !byte_in()) return -1; a <<= 1; c <<= 1; --count; } while (!(a & 0x8000));
    return value;
  }
};
}
