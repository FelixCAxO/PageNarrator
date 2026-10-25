// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original unhinted glyf/loca outline reader. No TrueType bytecode is executed.
// Segment layout matches pn_t1_glyph; all point indices survive composite assembly.
using u8 = unsigned char; using u16 = unsigned short; using u32 = unsigned int; using i16 = short; using i32 = int;
struct TtfSegment { u32 op; float points[6]; };
struct TtfPoint { double x, y; u32 flags, reserved; };
struct TtfResult { u32 status, count, points, contours, work, units; };
static_assert(sizeof(TtfSegment) == 28 && sizeof(TtfPoint) == 24 && sizeof(TtfResult) == 24);
static TtfResult ttf_result;
struct TtfOutline {
  const u8* bytes; u32 length, glyf = 0, glyf_length = 0, loca = 0, loca_length = 0, glyphs = 0, format = 0;
  TtfPoint* points; u32* ends; u32 np = 0, nc = 0, path_capacity; TtfSegment* path; u32 ancestors[17];
  bool fail(u32 code = 2) { if (!ttf_result.status) ttf_result.status = code; return false; }
  bool work(u32 n = 1) { if (n > 100000 - ttf_result.work) return fail(3); ttf_result.work += n; return true; }
  bool range(u32 at, u32 n) { return (n <= length && at <= length - n) || fail(); }
  u32 be16(u32 at) const { return static_cast<u32>(bytes[at]) * 256 + bytes[at + 1]; }
  i32 si16(u32 at) const { const u32 x = be16(at); return x < 32768 ? static_cast<i32>(x) : static_cast<i32>(x) - 65536; }
  u32 be32(u32 at) const { return (be16(at) << 16) | be16(at + 2); }
  bool finite(double x) { return (x >= -1e9 && x <= 1e9) || fail(3); }
  bool initialize() {
    if (!range(0, 12)) return false;
    const u32 version = be32(0); if (version != 0x00010000 && version != 0x74727565) return fail(1);
    const u32 count = be16(4); if (!count || count > 256) return fail(count ? 3 : 2);
    if (!range(12, count * 16)) return false;
    u32 head = 0, maxp = 0; bool have_head = false, have_maxp = false, have_glyf = false, have_loca = false;
    for (u32 i = 0; i < count; ++i) {
      const u32 at = 12 + i * 16, tag = be32(at), offset = be32(at + 8), size = be32(at + 12);
      if (!work() || !range(offset, size)) return false;
      if (tag == 0x68656164) { if (have_head || size < 54) return fail(); head = offset; have_head = true; }
      if (tag == 0x6d617870) { if (have_maxp || size < 6) return fail(); maxp = offset; have_maxp = true; }
      if (tag == 0x676c7966) { if (have_glyf) return fail(); glyf = offset; glyf_length = size; have_glyf = true; }
      if (tag == 0x6c6f6361) { if (have_loca) return fail(); loca = offset; loca_length = size; have_loca = true; }
    }
    if (!have_head || !have_maxp || !have_glyf || !have_loca) return fail();
    ttf_result.units = be16(head + 18); glyphs = be16(maxp + 4); format = be16(head + 50);
    if (ttf_result.units < 16 || ttf_result.units > 16384 || !glyphs || format > 1) return fail();
    const u32 stride = format ? 4 : 2; if (loca_length < (glyphs + 1) * stride) return fail();
    u32 previous = 0;
    for (u32 i = 0; i <= glyphs; ++i) { const u32 offset = location(i); if (!work() || offset < previous || offset > glyf_length) return fail(); previous = offset; }
    return true;
  }
  u32 location(u32 gid) const { return format ? be32(loca + gid * 4) : be16(loca + gid * 2) * 2; }
  bool glyph(u32 gid, u32 depth = 0) {
    if (depth > 16) return fail(3); if (gid >= glyphs) return fail();
    for (u32 i = 0; i < depth; ++i) if (ancestors[i] == gid) return fail(); ancestors[depth] = gid;
    const u32 start = location(gid), stop = location(gid + 1);
    if (start == stop) return true;
    u32 at = glyf + start; const u32 end = glyf + stop;
    auto need = [&](u32 n) { return (at <= end && n <= end - at) || fail(); };
    if (!work() || !need(10)) return false;
    const i32 contours = si16(at); if (si16(at + 2) > si16(at + 6) || si16(at + 4) > si16(at + 8)) return fail(); at += 10;
    const u32 first_point = np;
    if (contours >= 0) {
      const u32 ncontours = static_cast<u32>(contours);
      // A zero-contour glyph may end at its ten-byte header (OpenType glyf).
      if (!ncontours && at == end) return true;
      if (ncontours > 65536 - nc || !need(ncontours * 2 + 2)) return fail(3);
      u32 previous = 0;
      for (u32 i = 0; i < ncontours; ++i) { const u32 last = be16(at); at += 2; if (i && last <= previous) return fail(); previous = last; ends[nc++] = first_point + last; }
      const u32 count = ncontours ? previous + 1 : 0;
      if (count > 65536 - np) return fail(3);
      const u32 instructions = be16(at); at += 2; if (!need(instructions)) return false; at += instructions;
      for (u32 i = 0; i < count;) {
        if (!work() || !need(1)) return false; const u32 flags = bytes[at++]; if (flags & 128) return fail();
        u32 repeat = 1; if (flags & 8) { if (!need(1)) return false; repeat += bytes[at++]; }
        if (repeat > count - i || !work(repeat)) return fail();
        for (u32 j = 0; j < repeat; ++j) points[first_point + i++] = { 0, 0, flags, 0 };
      }
      double x = 0, y = 0;
      for (u32 i = 0; i < count; ++i) {
        if (!work()) return false; auto& p = points[first_point + i];
        if (p.flags & 2) { if (!need(1)) return false; const i32 delta = bytes[at++]; x += p.flags & 16 ? delta : -static_cast<i32>(delta); }
        else if (!(p.flags & 16)) { if (!need(2)) return false; x += si16(at); at += 2; }
        if (!finite(x)) return false; p.x = x;
      }
      for (u32 i = 0; i < count; ++i) {
        if (!work()) return false; auto& p = points[first_point + i];
        if (p.flags & 4) { if (!need(1)) return false; const i32 delta = bytes[at++]; y += p.flags & 32 ? delta : -static_cast<i32>(delta); }
        else if (!(p.flags & 32)) { if (!need(2)) return false; y += si16(at); at += 2; }
        if (!finite(y)) return false; p.y = y; p.flags &= 1;
      }
      np += count; return true;
    }
    if (contours != -1) return fail();
    u32 flags = 0; bool instructions = false;
    do {
      if (!work() || !need(4)) return false; flags = be16(at); const u32 child = be16(at + 2); at += 4;
      if (flags & ~0x1fefU || ((flags & 2) && (flags & 0x1800) == 0x1800)) return fail();
      const u32 transform_count = ((flags & 8) ? 1 : 0) + ((flags & 64) ? 1 : 0) + ((flags & 128) ? 1 : 0);
      if (transform_count > 1 || !need(flags & 1 ? 4 : 2)) return fail();
      i32 arg1, arg2;
      if (flags & 1) { arg1 = flags & 2 ? si16(at) : static_cast<i32>(be16(at)); arg2 = flags & 2 ? si16(at + 2) : static_cast<i32>(be16(at + 2)); at += 4; }
      else { arg1 = bytes[at]; arg2 = bytes[at + 1]; if (flags & 2) { if (arg1 >= 128) arg1 -= 256; if (arg2 >= 128) arg2 -= 256; } at += 2; }
      double a = 1, b = 0, c = 0, d = 1;
      if (flags & 8) { if (!need(2)) return false; a = d = si16(at) / 16384.0; at += 2; }
      if (flags & 64) { if (!need(4)) return false; a = si16(at) / 16384.0; d = si16(at + 2) / 16384.0; at += 4; }
      if (flags & 128) { if (!need(8)) return false; a = si16(at) / 16384.0; b = si16(at + 2) / 16384.0; c = si16(at + 4) / 16384.0; d = si16(at + 6) / 16384.0; at += 8; }
      const u32 child_first = np;
      if (!glyph(child, depth + 1)) return false;
      for (u32 i = child_first; i < np; ++i) { if (!work()) return false; auto& p = points[i]; const double x = a * p.x + c * p.y, y = b * p.x + d * p.y; if (!finite(x) || !finite(y)) return false; p.x = x; p.y = y; }
      double dx = arg1, dy = arg2;
      if (flags & 2) {
        // OpenType explicit scaled/unscaled flags honored. Neither flag uses the
        // Microsoft-compatible unscaled offset convention, fixed before tests.
        if (flags & 0x800) { dx = a * arg1 + c * arg2; dy = b * arg1 + d * arg2; }
        // There is no ppem/device grid in this design-coordinate ABI. Refuse a
        // grid-dependent placement rather than rounding arbitrary font units.
        if (flags & 4) return fail(1);
      } else {
        // Offset/grid flags are ignored for point-number attachment.
        if (child_first == first_point) return fail();
        if (static_cast<u32>(arg1) >= child_first - first_point || static_cast<u32>(arg2) >= np - child_first) {
          // Phantom metric points are valid glyf indices, but require a separate
          // metric/hinting contract. No contour or advance-box substitution.
          if (static_cast<u32>(arg1) < child_first - first_point + 4 && static_cast<u32>(arg2) < np - child_first + 4) return fail(1);
          return fail();
        }
        dx = points[first_point + arg1].x - points[child_first + arg2].x; dy = points[first_point + arg1].y - points[child_first + arg2].y;
      }
      for (u32 i = child_first; i < np; ++i) { auto& p = points[i]; p.x += dx; p.y += dy; if (!finite(p.x) || !finite(p.y)) return false; }
      instructions = instructions || (flags & 256);
    } while (flags & 32);
    if (instructions) { if (!need(2)) return false; const u32 n = be16(at); at += 2; if (!need(n)) return false; }
    return true;
  }
  bool emit(u32 op, double a = 0, double b = 0, double c = 0, double d = 0, double e = 0, double f = 0) {
    if (!work() || ttf_result.count >= path_capacity) return fail(3);
    auto& p = path[ttf_result.count++]; p = { op, { static_cast<float>(a), static_cast<float>(b), static_cast<float>(c), static_cast<float>(d), static_cast<float>(e), static_cast<float>(f) } }; return true;
  }
  bool convert() {
    u32 first = 0;
    for (u32 contour = 0; contour < nc; ++contour) {
      const u32 last = ends[contour]; if (last < first || last >= np) return fail();
      const auto& p = points[first]; const auto& q = points[last];
      double x, y; u32 next, remaining;
      if (p.flags & 1) { x = p.x; y = p.y; next = first + 1; remaining = last - first; }
      else if (q.flags & 1) { x = q.x; y = q.y; next = first; remaining = last - first; }
      else { x = (p.x + q.x) / 2; y = (p.y + q.y) / 2; next = first; remaining = last - first + 1; }
      const double start_x = x, start_y = y; if (!emit(1, x, y)) return false;
      while (remaining) {
        const auto& control = points[next];
        if (control.flags & 1) { x = control.x; y = control.y; if (!emit(2, x, y)) return false; ++next; --remaining; continue; }
        double end_x = start_x, end_y = start_y; u32 consumed = 1;
        if (remaining > 1) { const auto& endpoint = points[next + 1]; if (endpoint.flags & 1) { end_x = endpoint.x; end_y = endpoint.y; consumed = 2; } else { end_x = (control.x + endpoint.x) / 2; end_y = (control.y + endpoint.y) / 2; } }
        if (!emit(3, x + (control.x - x) * (2.0 / 3.0), y + (control.y - y) * (2.0 / 3.0), end_x + (control.x - end_x) * (2.0 / 3.0), end_y + (control.y - end_y) * (2.0 / 3.0), end_x, end_y)) return false;
        x = end_x; y = end_y; next += consumed; remaining -= consumed;
      }
      if (!emit(4)) return false; first = last + 1;
    }
    return first == np || fail();
  }
};
extern "C" const TtfResult* pn_ttf_glyph(const u8* bytes, u32 length, u32 gid, TtfSegment* output, u32 capacity, void* scratch, u32 scratch_bytes) {
  ttf_result = {}; constexpr u32 point_bytes = 65536 * sizeof(TtfPoint), required = point_bytes + 65536 * sizeof(u32);
  if (!bytes || length > 32 * 1024 * 1024 || !output || !capacity || capacity > 65536 || !scratch || reinterpret_cast<__UINTPTR_TYPE__>(scratch) % 8 || scratch_bytes < required) { ttf_result.status = 3; return &ttf_result; }
  TtfOutline reader{ bytes, length }; reader.path = output; reader.path_capacity = capacity; reader.points = static_cast<TtfPoint*>(scratch); reader.ends = reinterpret_cast<u32*>(static_cast<u8*>(scratch) + point_bytes);
  if (reader.initialize() && reader.glyph(gid)) reader.convert(); ttf_result.points = reader.np; ttf_result.contours = reader.nc;
  // Partial paths remain diagnostic memory only; the JS boundary refuses any status.
  return &ttf_result;
}
