// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original unhinted Type 2 outline interpreter, Adobe Technical Note 5177.
// Hint masks are validated/consumed; device hinting is not applied to design paths.
namespace {
using u8 = unsigned char; using u32 = unsigned int; using i32 = int;
struct CffSubroutine { const u8* bytes; u32 length; };
struct CffSegment { u32 op; float points[6]; };
struct CffResult { u32 status, count; double width_x, width_y; u32 base, accent; double dx, dy; u32 work, hints; };
static_assert(sizeof(CffSegment) == 28 && sizeof(CffResult) == 56);
static CffResult result;
double absolute(double n) { return n == 0 ? 0 : n < 0 ? -n : n; }
bool finite(double n) { return n >= -1e9 && n <= 1e9; }
bool integer(double n) { return finite(n) && n == static_cast<i32>(n); }

struct Type2 {
  const CffSubroutine* local; u32 local_count; const CffSubroutine* global; u32 global_count;
  CffSegment* output; u32 capacity;
  double stack[48]{}, transient[32]{}, x = 0, y = 0, nominal = 0;
  u32 size = 0, stored = 0, random_state = 1;
  bool width_seen = false, contour = false, drawing = false, mask_seen = false, vertical_hints = false, ended = false;

  bool bad(u32 status = 2) { if (!result.status) result.status = status; return false; }
  bool charge(u32 n = 1) { if (n > 100000 - result.work) return bad(3); result.work += n; return true; }
  bool push(double n) { if (size == 48 || !finite(n)) return bad(3); stack[size++] = n; return true; }
  bool need(u32 n) { return size >= n || bad(); }
  bool exact(u32 n) { return size == n || bad(); }
  bool emit(u32 op, double a = 0, double b = 0, double c = 0, double d = 0, double e = 0, double f = 0) {
    if (!charge() || result.count >= capacity) return bad(3);
    if (!finite(a) || !finite(b) || !finite(c) || !finite(d) || !finite(e) || !finite(f)) return bad(3);
    auto& s = output[result.count++]; s.op = op;
    s.points[0] = a; s.points[1] = b; s.points[2] = c; s.points[3] = d; s.points[4] = e; s.points[5] = f;
    return true;
  }
  // Implicit closure leaves the relative-coordinate current point unchanged.
  bool close() { if (contour && !emit(4)) return false; contour = false; return true; }
  bool move(double dx, double dy) {
    if (!close()) return false; x += dx; y += dy;
    if (!emit(1, x, y)) return false; contour = drawing = true; return true;
  }
  bool line(double dx, double dy) {
    if (!contour) return bad(); x += dx; y += dy; return emit(2, x, y);
  }
  bool curve(double dx1, double dy1, double dx2, double dy2, double dx3, double dy3) {
    if (!contour) return bad();
    double a = x + dx1, b = y + dy1, c = a + dx2, d = b + dy2;
    x = c + dx3; y = d + dy3; return emit(3, a, b, c, d, x, y);
  }
  bool width(bool present) {
    if (width_seen) return true;
    width_seen = true;
    if (present) {
      if (!need(1) || !finite(nominal + stack[0])) return bad(3);
      result.width_x = nominal + stack[0];
      for (u32 i = 1; i < size; ++i) stack[i - 1] = stack[i]; --size;
    }
    return true;
  }
  bool stems(bool vertical) {
    if (drawing || mask_seen || (!vertical && vertical_hints)) return bad();
    if (!width(size % 2 != 0) || size < 2 || size % 2) return bad();
    if (result.hints + size / 2 > 96) return bad(3);
    for (u32 i = 1; i < size; i += 2) if (stack[i] < 0 && stack[i] != -20 && stack[i] != -21) return bad();
    result.hints += size / 2; vertical_hints |= vertical; size = 0; return true;
  }
  bool mask(const u8* bytes, u32 length, u32& at, bool counter) {
    if (counter && drawing) return bad();
    if (!width(size % 2 != 0) || size % 2 || ((drawing || mask_seen) && size)) return bad();
    if (result.hints + size / 2 > 96) return bad(3);
    for (u32 i = 1; i < size; i += 2) if (stack[i] < 0 && stack[i] != -20 && stack[i] != -21) return bad();
    result.hints += size / 2; size = 0;
    if (!result.hints) return bad();
    u32 count = (result.hints + 7) / 8;
    if (count > length - at || !charge(count)) return bad();
    u32 unused = (8 - result.hints % 8) % 8;
    if (unused && (bytes[at + count - 1] & ((1u << unused) - 1))) return bad();
    at += count; mask_seen = true; return true;
  }
  bool arithmetic(u32 op) {
    if (op == 0) return exact(0); // Deprecated dotsection, no effect on the outline.
    if (op == 23) {
      random_state ^= random_state << 13; random_state ^= random_state >> 17; random_state ^= random_state << 5;
      return push((static_cast<double>(random_state) + 1) / 4294967296.0);
    }
    if (op == 27) { if (!need(1)) return false; return push(stack[size - 1]); }
    if (op == 18) { if (!need(1)) return false; --size; return true; }
    if (op == 28) { if (!need(2)) return false; double n = stack[size - 1]; stack[size - 1] = stack[size - 2]; stack[size - 2] = n; return true; }
    if (op == 20 || op == 21) {
      if (!need(op == 20 ? 2 : 1)) return false;
      double index = stack[--size]; if (!integer(index) || index < 0 || index >= 32) return bad();
      u32 i = static_cast<u32>(index);
      if (op == 20) { transient[i] = stack[--size]; stored |= 1u << i; return true; }
      if (!(stored & (1u << i))) return bad(); return push(transient[i]);
    }
    if (op == 29) {
      if (!need(1)) return false; double index = stack[--size]; if (!integer(index) || !size) return bad();
      if (index < 0) index = 0; if (index >= size) return bad(); return push(stack[size - 1 - static_cast<u32>(index)]);
    }
    if (op == 30) {
      if (!need(2)) return false; double shift = stack[--size], count = stack[--size];
      if (!integer(count) || count < 0 || count > size || !integer(shift)) return bad();
      u32 n = static_cast<u32>(count); if (!n) return true; if (!charge(n)) return false;
      i32 j = static_cast<i32>(shift) % static_cast<i32>(n); if (j < 0) j += n;
      double copy[48]; for (u32 i = 0; i < n; ++i) copy[(i + j) % n] = stack[size - n + i];
      for (u32 i = 0; i < n; ++i) stack[size - n + i] = copy[i]; return true;
    }
    if (op == 22) {
      if (!need(4)) return false; double v2 = stack[--size], v1 = stack[--size], s2 = stack[--size], s1 = stack[--size];
      return push(v1 <= v2 ? s1 : s2);
    }
    if (op == 5 || op == 9 || op == 14 || op == 26) {
      if (!need(1)) return false; double n = stack[--size];
      if (op == 5) return push(n == 0 ? 1 : 0);
      if (op == 9) return push(absolute(n)); if (op == 14) return push(-n);
      if (n < 0) return bad(); return push(__builtin_sqrt(n));
    }
    if (op == 3 || op == 4 || op == 10 || op == 11 || op == 12 || op == 15 || op == 24) {
      if (!need(2)) return false; double b = stack[--size], a = stack[--size];
      if (op == 3) return push(a != 0 && b != 0 ? 1 : 0);
      if (op == 4) return push(a != 0 || b != 0 ? 1 : 0);
      if (op == 10) return push(a + b); if (op == 11) return push(a - b);
      if (op == 12) { if (b == 0) return bad(); return push(a / b); }
      if (op == 15) return push(a == b ? 1 : 0); return push(a * b);
    }
    if (op == 34 || op == 35 || op == 36 || op == 37) {
      u32 n = op == 34 ? 7 : op == 35 ? 13 : op == 36 ? 9 : 11;
      if (!exact(n) || !contour) return bad(); bool ok;
      if (op == 34) ok = curve(stack[0], 0, stack[1], stack[2], stack[3], 0)
        && curve(stack[4], 0, stack[5], -stack[2], stack[6], 0);
      else if (op == 35) {
        if (stack[12] < 0) return bad();
        ok = curve(stack[0], stack[1], stack[2], stack[3], stack[4], stack[5])
          && curve(stack[6], stack[7], stack[8], stack[9], stack[10], stack[11]);
      } else if (op == 36) ok = curve(stack[0], stack[1], stack[2], stack[3], stack[4], 0)
        && curve(stack[5], 0, stack[6], stack[7], stack[8], -stack[1] - stack[3] - stack[7]);
      else {
        double dx = stack[0] + stack[2] + stack[4] + stack[6] + stack[8], dy = stack[1] + stack[3] + stack[5] + stack[7] + stack[9];
        ok = curve(stack[0], stack[1], stack[2], stack[3], stack[4], stack[5])
          && curve(stack[6], stack[7], stack[8], stack[9], absolute(dx) > absolute(dy) ? stack[10] : -dx, absolute(dx) > absolute(dy) ? -dy : stack[10]);
      }
      size = 0; return ok;
    }
    return bad(1);
  }
  bool run(const u8* bytes, u32 length, u32 depth = 0) {
    if (depth > 10 || length > 65535) return bad(3); if (!bytes || !length) return bad();
    for (u32 at = 0; at < length;) {
      if (!charge()) return false; u32 op = bytes[at++];
      if (op >= 32 || op == 28) {
        double n;
        if (op == 28) {
          if (length - at < 2) return bad(); u32 raw = bytes[at] * 256u + bytes[at + 1]; at += 2;
          n = raw < 32768 ? static_cast<double>(raw) : static_cast<double>(raw) - 65536;
        } else if (op <= 246) n = static_cast<i32>(op) - 139;
        else if (op <= 254) {
          if (at == length) return bad(); n = op <= 250 ? static_cast<i32>((op - 247) * 256 + bytes[at++] + 108) : -static_cast<i32>((op - 251) * 256 + bytes[at++] + 108);
        } else {
          if (length - at < 4) return bad(); u32 raw = 0; for (u32 i = 0; i < 4; ++i) raw = raw * 256 + bytes[at++];
          n = (raw < 0x80000000u ? static_cast<double>(raw) : static_cast<double>(raw) - 4294967296.0) / 65536.0;
        }
        if (!push(n)) return false; continue;
      }
      if (op == 12) { if (at == length) return bad(); if (!arithmetic(bytes[at++])) return false; continue; }
      if (op == 10 || op == 29) {
        if (!need(1)) return false; auto table = op == 10 ? local : global; u32 count = op == 10 ? local_count : global_count;
        double index = stack[--size] + (count < 1240 ? 107 : count < 33900 ? 1131 : 32768);
        if (!integer(index) || index < 0 || index >= count || !table) return bad();
        const auto& routine = table[static_cast<u32>(index)]; if (!run(routine.bytes, routine.length, depth + 1)) return false;
        if (ended) return at == length || bad(); continue;
      }
      if (op == 11) return depth && at == length ? true : bad();
      if (op == 1 || op == 3 || op == 18 || op == 23) { if (!stems(op == 3 || op == 23)) return false; continue; }
      if (op == 19 || op == 20) { if (!mask(bytes, length, at, op == 20)) return false; continue; }
      if (op == 14) {
        if (!width(size == 1 || size == 5) || (size != 0 && size != 4) || at != length) return bad();
        if (size == 4) {
          if (drawing || !integer(stack[2]) || !integer(stack[3]) || stack[2] < 0 || stack[2] > 255 || stack[3] < 0 || stack[3] > 255) return bad();
          result.base = static_cast<u32>(stack[2]); result.accent = static_cast<u32>(stack[3]); result.dx = stack[0]; result.dy = stack[1]; result.status = 4;
        } else if (!close()) return false;
        size = 0; ended = true; return true;
      }
      if (op == 4 || op == 21 || op == 22) {
        u32 n = op == 21 ? 2 : 1; if (!width(size == n + 1) || !exact(n)) return false;
        if (!move(op == 4 ? 0 : stack[0], op == 22 ? 0 : stack[n - 1])) return false;
      } else if (op == 5) {
        if (!size || size % 2) return bad(); for (u32 i = 0; i < size; i += 2) if (!line(stack[i], stack[i + 1])) return false;
      } else if (op == 6 || op == 7) {
        if (!size) return bad(); bool horizontal = op == 6;
        for (u32 i = 0; i < size; ++i) { if (!line(horizontal ? stack[i] : 0, horizontal ? 0 : stack[i])) return false; horizontal = !horizontal; }
      } else if (op == 8 || op == 24 || op == 25) {
        u32 last = op == 24 ? 2 : 0;
        if (op == 25) {
          if (size < 8 || (size - 6) % 2) return bad();
          for (u32 i = 0; i < size - 6; i += 2) if (!line(stack[i], stack[i + 1])) return false;
          if (!curve(stack[size - 6], stack[size - 5], stack[size - 4], stack[size - 3], stack[size - 2], stack[size - 1])) return false;
        } else {
          if (size < 6 + last || (size - last) % 6) return bad();
          for (u32 i = 0; i < size - last; i += 6) if (!curve(stack[i], stack[i + 1], stack[i + 2], stack[i + 3], stack[i + 4], stack[i + 5])) return false;
          if (last && !line(stack[size - 2], stack[size - 1])) return false;
        }
      } else if (op == 26 || op == 27) {
        if (size < 4 || (size % 4 != 0 && size % 4 != 1)) return bad();
        u32 i = size % 4; double extra = i ? stack[0] : 0;
        for (; i < size; i += 4) {
          bool ok = op == 26 ? curve(extra, stack[i], stack[i + 1], stack[i + 2], 0, stack[i + 3])
            : curve(stack[i], extra, stack[i + 1], stack[i + 2], stack[i + 3], 0);
          if (!ok) return false; extra = 0;
        }
      } else if (op == 30 || op == 31) {
        if (size < 4 || (size % 4 != 0 && size % 4 != 1)) return bad();
        bool horizontal = op == 31;
        for (u32 i = 0; i < size;) {
          double extra = size - i == 5 ? stack[i + 4] : 0;
          bool ok = horizontal ? curve(stack[i], 0, stack[i + 1], stack[i + 2], extra, stack[i + 3])
            : curve(0, stack[i], stack[i + 1], stack[i + 2], stack[i + 3], extra);
          if (!ok) return false; i += size - i == 5 ? 5 : 4; horizontal = !horizontal;
        }
      } else return bad(1);
      size = 0;
    }
    return bad(); // Every subroutine returns, or finishes the glyph with endchar.
  }
};
}

extern "C" const CffResult* pn_cff_glyph(const u8* bytes, u32 length,
  const CffSubroutine* local, u32 local_count, const CffSubroutine* global, u32 global_count,
  double nominal, double fallback, u32 seed, CffSegment* output, u32 capacity) {
  result = {};
  if (local_count > 65536 || global_count > 65536 || capacity > 65536 || !finite(nominal) || !finite(fallback)) { result.status = 3; return &result; }
  if ((!local && local_count) || (!global && global_count) || (!output && capacity)) { result.status = 2; return &result; }
  result.width_x = fallback;
  Type2 interpreter{local, local_count, global, global_count, output, capacity};
  interpreter.nominal = nominal; interpreter.random_state = seed ? seed : 0x6d2b79f5u;
  interpreter.run(bytes, length); return &result;
}
