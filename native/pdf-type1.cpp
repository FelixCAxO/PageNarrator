// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original Type 1 charstring path interpreter: Adobe Type 1 Font Format, chapters 6-8.
using u8 = unsigned char; using u32 = unsigned int; using i32 = int;
struct Subroutine { const u8* bytes; u32 length; };
struct Segment { u32 op; float points[6]; };
struct Result { u32 status, count; double width_x, width_y; u32 base, accent; double dx, dy; };
static Result result;
struct Interpreter {
  const Subroutine* subrs; u32 subr_count, capacity, steps = 0, size = 0, returned_size = 0, returned_at = 0, flex_size = 0;
  Segment* output; double stack[24], returned[24], flex[14], x = 0, y = 0, side_x = 0; bool ended = false, flexing = false;
  bool bad(u32 status = 2) { if (!result.status) result.status = status; return false; }
  bool exact(u32 count) { return size == count || bad(); }
  bool push(double n) { if (size == 24 || !(n >= -1e9 && n <= 1e9)) return bad(3); stack[size++] = n; return true; }
  bool path(u32 op, double a = 0, double b = 0, double c = 0, double d = 0, double e = 0, double f = 0) {
    if (result.count >= capacity || !(x >= -1e9 && x <= 1e9 && y >= -1e9 && y <= 1e9)) return bad(3);
    auto p = &output[result.count++]; p->op = op; p->points[0] = a; p->points[1] = b; p->points[2] = c; p->points[3] = d; p->points[4] = e; p->points[5] = f; return true;
  }
  bool run(const u8* bytes, u32 length, u32 depth = 0) {
    if (depth > 10 || length > 1024 * 1024) return bad(3);
    for (u32 at = 0; at < length && !ended && !result.status;) {
      if (++steps > 100000) return bad(3); u32 op = bytes[at++];
      if (op >= 32) {
        double value;
        if (op <= 246) value = static_cast<i32>(op) - 139;
        else if (op <= 254) { if (at >= length) return bad(); value = op <= 250 ? static_cast<i32>((op - 247) * 256 + bytes[at++] + 108) : -static_cast<i32>((op - 251) * 256 + bytes[at++] + 108); }
        else { if (at + 4 > length) return bad(); u32 n = 0; for (u32 i = 0; i < 4; ++i) n = n * 256 + bytes[at++]; value = static_cast<i32>(n); }
        if (!push(value)) return false; continue;
      }
      if (op == 12) { if (at >= length) return bad(); op = 256 + bytes[at++]; }
      if (op == 10) {
        if (!size) return bad(); double index = stack[--size]; if (index < 0 || index >= subr_count || index != static_cast<u32>(index)) return bad();
        auto s = subrs[static_cast<u32>(index)]; if (!s.bytes || !run(s.bytes, s.length, depth + 1)) return false; continue;
      }
      if (op == 11) { if (!depth) return bad(); return true; }
      if (op == 268) { if (size < 2 || stack[size - 1] == 0) return bad(); double divisor = stack[--size]; stack[size - 1] /= divisor; continue; }
      if (op == 272) {
        if (size < 2) return bad(); double which = stack[--size], nargs = stack[--size];
        if (nargs < 0 || nargs > size || nargs != static_cast<u32>(nargs) || which < 0 || which != static_cast<u32>(which)) return bad();
        u32 n = static_cast<u32>(nargs), first = size - n; returned_size = 0; returned_at = 0;
        if (which == 1) { if (n || flexing) return bad(); flexing = true; flex_size = 0; }
        else if (which == 2) { if (n || !flexing || flex_size >= 7) return bad(); flex[flex_size * 2] = x; flex[flex_size * 2 + 1] = y; ++flex_size; }
        else if (which == 0) {
          if (n != 3 || !flexing || flex_size != 7) return bad();
          // Preserve the design curves; device hinting is delegated to raster acceptance.
          if (!path(3, flex[2], flex[3], flex[4], flex[5], flex[6], flex[7]) || !path(3, flex[8], flex[9], flex[10], flex[11], flex[12], flex[13])) return false;
          returned[0] = stack[first + 1]; returned[1] = stack[first + 2]; returned_size = 2; flexing = false;
        } else if (which == 3 && n == 1) returned[returned_size++] = stack[first];
        else return bad(1);
        size = first; continue;
      }
      if (op == 273) { if (returned_at >= returned_size || !push(returned[returned_at++])) return bad(); continue; }
      if (op == 1 || op == 3 || op == 257 || op == 258) { if (size != (op >= 256 ? 6u : 2u)) return bad(); size = 0; continue; }
      if (op == 256) { if (!exact(0)) return false; continue; }
      if (op == 13) { if (!exact(2)) return false; side_x = x = stack[0]; y = 0; result.width_x = stack[1]; size = 0; continue; }
      if (op == 263) { if (!exact(4)) return false; side_x = x = stack[0]; y = stack[1]; result.width_x = stack[2]; result.width_y = stack[3]; size = 0; continue; }
      if (op == 289) { if (!exact(2)) return false; x = stack[0]; y = stack[1]; size = 0; continue; }
      if (op == 262) {
        if (!exact(5) || stack[3] < 0 || stack[3] > 255 || stack[4] < 0 || stack[4] > 255) return bad();
        result.base = static_cast<u32>(stack[3]); result.accent = static_cast<u32>(stack[4]); result.dx = stack[1] - stack[0] + side_x; result.dy = stack[2]; result.status = 4; ended = true; return true;
      }
      if (op == 4 || op == 21 || op == 22) {
        if (!exact(op == 21 ? 2 : 1)) return false;
        if (op != 4) x += stack[0]; if (op != 22) y += stack[op == 21 ? 1 : 0];
        if (!flexing && !path(1, x, y)) return false; size = 0;
      } else if (op == 5 || op == 6 || op == 7) {
        if (!exact(op == 5 ? 2 : 1)) return false; if (op != 7) x += stack[0]; if (op != 6) y += stack[op == 5 ? 1 : 0];
        if (!path(2, x, y)) return false; size = 0;
      } else if (op == 8 || op == 30 || op == 31) {
        if (!exact(op == 8 ? 6 : 4)) return false;
        double x1 = x + (op == 30 ? 0 : stack[0]), y1 = y + (op == 31 ? 0 : stack[op == 8 ? 1 : 0]);
        double x2 = x1 + stack[op == 8 ? 2 : 1], y2 = y1 + stack[op == 8 ? 3 : 2];
        x = x2 + (op == 31 ? 0 : stack[op == 8 ? 4 : 3]); y = y2 + (op == 30 ? 0 : stack[op == 8 ? 5 : 3]);
        if (!path(3, x1, y1, x2, y2, x, y)) return false; size = 0;
      } else if (op == 9) { if (!exact(0) || !path(4)) return false; }
      else if (op == 14) { if (!exact(0) || flexing) return bad(); ended = true; return true; }
      else return bad(1);
    }
    return ended ? !result.status : bad();
  }
};
extern "C" const Result* pn_t1_glyph(const u8* bytes, u32 length, const Subroutine* subrs, u32 subr_count, Segment* output, u32 capacity) {
  result = {}; if (subr_count > 65535 || capacity > 65536) { result.status = 3; return &result; }
  Interpreter interpreter{subrs, subr_count, capacity}; interpreter.output = output;
  interpreter.run(bytes, length); return &result;
}
// Type 2 outlines are consumed by the browser's OpenType renderer. Only their
// advance widths are decoded here to construct original checked sfnt metrics.
struct WidthReader {
  const Subroutine* local; u32 local_count; const Subroutine* global; u32 global_count;
  double stack[48], nominal, value; u32 size = 0, steps = 0, status = 0; bool found = false;
  bool push(double n) { if (size == 48 || !(n >= -1e9 && n <= 1e9)) { status = 3; return false; } stack[size++] = n; return true; }
  bool width(bool explicit_width) { value = explicit_width ? nominal + stack[0] : value; found = true; return true; }
  bool run(const u8* data, u32 length, u32 depth = 0) {
    if (depth > 10 || length > 1024 * 1024) { status = 3; return false; }
    for (u32 at = 0; at < length && !found;) {
      if (++steps > 100000) { status = 3; return false; } u32 op = data[at++];
      if (op >= 32 || op == 28) {
        double n;
        if (op == 28) { if (at + 2 > length) break; n = static_cast<short>(data[at] * 256 + data[at + 1]); at += 2; }
        else if (op <= 246) n = static_cast<i32>(op) - 139;
        else if (op <= 254) { if (at >= length) break; n = op <= 250 ? static_cast<i32>((op - 247) * 256 + data[at++] + 108) : -static_cast<i32>((op - 251) * 256 + data[at++] + 108); }
        else { if (at + 4 > length) break; u32 v = 0; for (u32 i = 0; i < 4; ++i) v = v * 256 + data[at++]; n = static_cast<i32>(v) / 65536.0; }
        if (!push(n)) return false; continue;
      }
      if (op == 10 || op == 29) {
        if (!size) break; const auto routines = op == 10 ? local : global; u32 count = op == 10 ? local_count : global_count;
        double index = stack[--size] + (count < 1240 ? 107 : count < 33900 ? 1131 : 32768);
        if (index < 0 || index >= count || index != static_cast<u32>(index)) break;
        auto s = routines[static_cast<u32>(index)]; if (!s.bytes || !run(s.bytes, s.length, depth + 1)) return false; continue;
      }
      if (op == 11) return depth ? true : false;
      if (op == 1 || op == 3 || op == 18 || op == 23 || op == 19 || op == 20) return width(size % 2 != 0);
      if (op == 21) { if (size != 2 && size != 3) break; return width(size == 3); }
      if (op == 4 || op == 22) { if (size != 1 && size != 2) break; return width(size == 2); }
      if (op == 14) { if (size != 0 && size != 1 && size != 4 && size != 5) break; return width(size == 1 || size == 5); }
      status = 1; return false;
    }
    if (found) return true; status = 2; return false;
  }
};
extern "C" const Result* pn_cff_width(const u8* bytes, u32 length, const Subroutine* local, u32 local_count, const Subroutine* global, u32 global_count, double nominal, double fallback) {
  result = {}; WidthReader reader{local, local_count, global, global_count}; reader.nominal = nominal; reader.value = fallback;
  if (!reader.run(bytes, length)) result.status = reader.status ? reader.status : 2; else result.width_x = reader.value;
  return &result;
}
