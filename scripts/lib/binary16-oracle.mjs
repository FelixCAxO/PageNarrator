// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Independent mathematical rounding for development oracles; no binary32 intermediate.
export function binary64ToHalf(value) {
  if (Number.isNaN(value)) return 0x7e00;
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0, magnitude = Math.abs(value);
  if (magnitude >= 65520) return sign | 0x7c00;
  if (magnitude === 0) return sign;
  let exponent = Math.max(-14, Math.floor(Math.log2(magnitude)));
  if (exponent > -14 && magnitude < 2 ** exponent) exponent--;
  const scaled = magnitude * 2 ** (10 - exponent), lower = Math.floor(scaled), fraction = scaled - lower;
  const rounded = lower + (fraction > .5 || fraction === .5 && lower % 2 === 1 ? 1 : 0);
  return sign | (exponent + 14) * 1024 + rounded;
}
