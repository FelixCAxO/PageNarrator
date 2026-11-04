// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded PDF syntax reader, based on ISO 32000-1 clauses 7.2-7.5.
// Freestanding: no parser, allocator, PDF library or C++ runtime is linked.
#include "pdf-crypto.h"
using u8 = unsigned char;
using u32 = unsigned int;
using i32 = int;
extern unsigned char __heap_base;
extern "C" void* memcpy(void* dst, const void* src, unsigned long n) {
  auto d = static_cast<u8*>(dst); auto s = static_cast<const u8*>(src);
  for (unsigned long i = 0; i < n; ++i) d[i] = s[i]; return dst;
}
extern "C" void* memset(void* dst, int value, unsigned long n) {
  auto d = static_cast<u8*>(dst); for (unsigned long i = 0; i < n; ++i) d[i] = static_cast<u8>(value); return dst;
}
static constexpr u32 MAX_MEMORY = 256u * 1024 * 1024, MAX_INPUT = 128u * 1024 * 1024;
static constexpr u32 MAX_NODES = 1000000, MAX_OBJECTS = 500000, BLOCK = 4096, HASH_SIZE = 262144;
enum { NIL = 0, BOOLEAN = 1, NUMBER = 2, NAME = 3, STRING = 4, ARRAY = 5, DICT = 6, REF = 7, STREAM = 8, WORD = 9 };
enum { OK = 0, SYNTAX = 1, LIMIT = 2, XREF_STREAM = 3, ENCRYPTED = 4, MISSING = 5, CYCLE = 6, DECRYPT = 7 };
struct Node { u32 kind, offset, length, first, next, aux; double number; };
static_assert(sizeof(Node) == 32);
struct Object { u32 number, generation, offset, value, state, container, index; Object* next; };
static_assert(sizeof(Object) == 32);
static Object* objects[HASH_SIZE];
static Node* blocks[(MAX_NODES + BLOCK - 1) / BLOCK];
static u32 cursor, count, error, source, source_length, trailer, object_count;
static u32 marked_cursor, marked_count, resolve_depth;
static u32 repair_flags, repair_work;
static u32 pending_xref, xref_seen[32], xref_links;
static u32 hybrid_revision, hybrid_previous, hybrid_has_previous;
static u8 file_key[32]; static u32 file_key_length, crypt_strings, crypt_streams, crypt_embedded, encryption_object, encryption_dictionary; static bool metadata_encrypted = true;
static u32 fail(u32 code) { if (!error) error = code; return 0; }
extern "C" u32 pn_pdf_alloc(u32 bytes) {
  if (!cursor) cursor = (reinterpret_cast<u32>(&__heap_base) + 15) & ~15u;
  if (bytes > MAX_MEMORY - 15 || cursor > MAX_MEMORY - bytes - 15) return fail(LIMIT);
  u32 result = cursor; cursor = (cursor + bytes + 15) & ~15u;
  u32 pages = __builtin_wasm_memory_size(0), needed = (cursor + 65535) / 65536;
  if (needed > pages && __builtin_wasm_memory_grow(0, needed - pages) == static_cast<u32>(-1)) return fail(LIMIT);
  return result;
}
static Node* node(u32 index) { return index && index <= count ? blocks[(index - 1) / BLOCK] + (index - 1) % BLOCK : nullptr; }
static u32 make(u32 kind) {
  if (error || count >= MAX_NODES) return fail(LIMIT);
  u32 block = count / BLOCK;
  if (!blocks[block]) { u32 ptr = pn_pdf_alloc(sizeof(Node) * BLOCK); if (!ptr) return 0; blocks[block] = reinterpret_cast<Node*>(ptr); }
  u32 index = ++count; auto n = node(index); *n = {}; n->kind = kind; return index;
}
static bool white(u8 c) { return c == 0 || c == 9 || c == 10 || c == 12 || c == 13 || c == 32; }
static bool delimiter(u8 c) { return white(c) || c == '(' || c == ')' || c == '<' || c == '>' || c == '[' || c == ']' || c == '{' || c == '}' || c == '/' || c == '%'; }
static int hex(u8 c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'A' && c <= 'F' ? c - 'A' + 10 : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; }
static bool same(u32 ptr, u32 len, const char* word) {
  u32 i = 0; for (; word[i]; ++i) if (i >= len || reinterpret_cast<u8*>(ptr)[i] != word[i]) return false;
  return i == len;
}
struct Reader {
  u32 p, end;
  u8 at(u32 i = 0) const { return p + i < end ? reinterpret_cast<u8*>(p)[i] : 0; }
  void skip() {
    while (p < end) { if (white(at())) ++p; else if (at() == '%') { while (p < end && at() != 10 && at() != 13) ++p; } else break; }
  }
  bool word(const char* text) {
    skip(); u32 start = p; for (u32 i = 0; text[i]; ++i) if (p >= end || at() != static_cast<u8>(text[i])) { p = start; return false; } else ++p;
    if (p < end && !delimiter(at())) { p = start; return false; } return true;
  }
  bool integer(u32& value) {
    skip(); value = 0; u32 begin = p;
    while (p < end && at() >= '0' && at() <= '9') { if (value > 429496729u || (value == 429496729u && at() > '5')) { fail(LIMIT); return false; } value = value * 10 + at() - '0'; ++p; }
    return p > begin && (p == end || delimiter(at()));
  }
  u32 value(u32 depth = 0, bool content = false) {
    if (error || depth > 64) return fail(LIMIT); skip(); if (p >= end) return fail(SYNTAX);
    if (at() == '[' || (at() == '<' && at(1) == '<')) {
      bool dict = at() == '<'; p += dict ? 2 : 1; u32 index = make(dict ? DICT : ARRAY), last = 0, entries = 0;
      while (!error) {
        skip(); if ((!dict && at() == ']') || (dict && at() == '>' && at(1) == '>')) { p += dict ? 2 : 1; return index; }
        if (p >= end || ++entries > 100000) return fail(LIMIT);
        u32 child = value(depth + 1, content); if (!child) return 0;
        if (dict && (entries & 1) && node(child)->kind != NAME) return fail(SYNTAX);
        if (last) node(last)->next = child; else node(index)->first = child; last = child;
        if (dict) { skip(); if (at() == '>' && at(1) == '>' && (entries & 1)) return fail(SYNTAX); }
      }
      return 0;
    }
    if (at() == '(' || at() == '<' || at() == '/') {
      u8 type = at(); ++p; u32 scan = p, nested = 1;
      while (scan < end) {
        u8 c = *reinterpret_cast<u8*>(scan++);
        if (type == '/' && delimiter(c)) { --scan; break; }
        if (type == '<' && c == '>') break;
        if (type == '(') { if (c == '\\') { if (scan < end) ++scan; } else if (c == '(') { if (++nested > 64) return fail(LIMIT); } else if (c == ')' && !--nested) break; }
        if (scan - p > 16u * 1024 * 1024) return fail(LIMIT);
      }
      u32 output = pn_pdf_alloc(scan - p + 1); if (!output) return 0; auto bytes = reinterpret_cast<u8*>(output); u32 length = 0;
      if (type == '(') {
        u32 nesting = 1;
        while (p < end && nesting) {
          u8 c = at(); ++p;
          if (c == '\\') {
            if (p >= end) return fail(SYNTAX); c = at(); ++p;
            if (c == 10 || c == 13) { if (c == 13 && at() == 10) ++p; continue; }
            if (c >= '0' && c <= '7') { u32 n = c - '0'; for (u32 i = 0; i < 2 && at() >= '0' && at() <= '7' && p < end; ++i) { n = n * 8 + at() - '0'; ++p; } c = static_cast<u8>(n); }
            else c = c == 'n' ? 10 : c == 'r' ? 13 : c == 't' ? 9 : c == 'b' ? 8 : c == 'f' ? 12 : c;
          } else if (c == '(') { if (++nesting > 64) return fail(LIMIT); }
          else if (c == ')') { if (!--nesting) break; }
          else if (c == 13) { if (at() == 10) ++p; c = 10; }
          bytes[length++] = c;
        }
        if (nesting) return fail(SYNTAX);
      } else if (type == '<') {
        int high = -1; bool closed = false;
        while (p < end) { u8 c = at(); ++p; if (c == '>') { closed = true; break; } if (white(c)) continue; int v = hex(c); if (v < 0) return fail(SYNTAX); if (high < 0) high = v; else { bytes[length++] = static_cast<u8>(high * 16 + v); high = -1; } }
        if (!closed) return fail(SYNTAX); if (high >= 0) bytes[length++] = static_cast<u8>(high * 16);
      } else {
        while (p < end && !delimiter(at())) { u8 c = at(); ++p; if (c == '#') { if (p + 1 >= end || hex(at()) < 0 || hex(at(1)) < 0) return fail(SYNTAX); c = static_cast<u8>(hex(at()) * 16 + hex(at(1))); p += 2; } bytes[length++] = c; }
      }
      // String scratch is the last allocation; retain only bytes actually decoded.
      cursor = (output + length + 15) & ~15u;
      u32 index = make(type == '/' ? NAME : STRING); if (!index) return 0; node(index)->offset = output; node(index)->length = length; return index;
    }
    u32 start = p;
    if (at() == '+' || at() == '-' || at() == '.' || (at() >= '0' && at() <= '9')) {
      bool negative = at() == '-'; if (at() == '+' || at() == '-') ++p;
      double n = 0, fraction = 0.1; bool decimal = false, digits = false;
      while (p < end) { u8 c = at(); if (c == '.' && !decimal) { decimal = true; ++p; continue; } if (c < '0' || c > '9') break; digits = true; if (decimal) { n += (c - '0') * fraction; fraction *= 0.1; } else n = n * 10 + c - '0'; if (n > 1e15) return fail(LIMIT); ++p; }
      if (!digits || (p < end && !delimiter(at()))) return fail(SYNTAX); if (negative) n = -n;
      u32 after = p, generation = 0;
      if (!content && !decimal && !negative && n <= 10000000 && integer(generation) && word("R")) {
        u32 index = make(REF); if (!index) return 0; node(index)->aux = static_cast<u32>(n); node(index)->length = generation; return index;
      }
      p = after; u32 index = make(NUMBER); if (index) node(index)->number = n; return index;
    }
    while (p < end && !delimiter(at())) ++p;
    if (p == start) return fail(SYNTAX);
    if (same(start, p - start, "true") || same(start, p - start, "false")) { u32 index = make(BOOLEAN); if (index) node(index)->aux = same(start, p - start, "true"); return index; }
    if (same(start, p - start, "null")) return make(NIL);
    if (!content) return fail(SYNTAX);
    u32 index = make(WORD); if (index) { node(index)->offset = start; node(index)->length = p - start; } return index;
  }
};
static u32 field(u32 dictionary, const char* key) {
  Node* d = node(dictionary); if (!d || d->kind != DICT) return 0;
  u32 result = 0; for (u32 k = d->first; k;) { auto name = node(k); u32 v = name->next; if (!v) return fail(SYNTAX); if (same(name->offset, name->length, key)) result = v; k = node(v)->next; } return result;
}
extern "C" u32 pn_pdf_resolve(u32 number, u32 generation);
static u32 resolved(u32 id) { if (!id) return 0; for (u32 depth = 0; depth <= 64; ++depth) { auto n = node(id); if (!n) return fail(SYNTAX); if (n->kind != REF) return id; id = pn_pdf_resolve(n->aux, n->length); if (!id) return 0; } return fail(CYCLE); }
static bool named(u32 id, const char* name) { auto n = node(resolved(id)); return n && n->kind == NAME && same(n->offset, n->length, name); }
static u32 crypt_filter(u32 name_id) {
  if (!name_id || named(name_id, "Identity")) return 0;
  auto name = node(resolved(name_id)), cf = node(resolved(field(encryption_dictionary, "CF"))); if (!name || name->kind != NAME || !cf || cf->kind != DICT) return fail(ENCRYPTED);
  u32 selected = 0;
  for (u32 key = cf->first; key;) { auto n = node(key); const u32 value = n->next; if (!value) return fail(SYNTAX); if (n->length == name->length) { bool equal = true; for (u32 i = 0; i < n->length; ++i) if (*reinterpret_cast<u8*>(n->offset + i) != *reinterpret_cast<u8*>(name->offset + i)) equal = false; if (equal) selected = resolved(value); } key = node(value)->next; }
  if (!selected) return fail(ENCRYPTED); const auto method = field(selected, "CFM"); const auto length = node(resolved(field(selected, "Length")));
  if (length && (length->kind != NUMBER || length->number != file_key_length)) return fail(ENCRYPTED);
  if (!method || named(method, "None")) return 0; if (named(method, "V2")) return 1; if (named(method, "AESV2")) return 2; if (named(method, "AESV3")) return 3; return fail(ENCRYPTED);
}
static u32 decrypt_bytes(u32 pointer, u32 length, u32 number, u32 generation, u32 method, u32& decoded_length) {
  decoded_length = length; if (!method || !length) return pointer;
  u8 key[32]; u32 key_length = file_key_length;
  for (u32 i = 0; i < file_key_length; ++i) key[i] = file_key[i];
  if (method < 3) {
    u8 input[41], digest[16]; for (u32 i = 0; i < file_key_length; ++i) input[i] = file_key[i];
    input[key_length++] = static_cast<u8>(number); input[key_length++] = static_cast<u8>(number >> 8); input[key_length++] = static_cast<u8>(number >> 16); input[key_length++] = static_cast<u8>(generation); input[key_length++] = static_cast<u8>(generation >> 8);
    if (method == 2) { input[key_length++] = 's'; input[key_length++] = 'A'; input[key_length++] = 'l'; input[key_length++] = 'T'; }
    pn_pdf::md5(input, key_length, digest); key_length = file_key_length + 5 > 16 ? 16 : file_key_length + 5; for (u32 i = 0; i < key_length; ++i) key[i] = digest[i];
  }
  if (method > 1 && (length < 32 || length % 16)) return fail(DECRYPT);
  u32 allocation = pn_pdf_alloc(length); if (!allocation) return 0; auto input = reinterpret_cast<const u8*>(pointer); auto output = reinterpret_cast<u8*>(allocation);
  bool success = method == 1 ? pn_pdf::rc4(key, key_length, input, length, output) : pn_pdf::aes_cbc_decrypt(key, key_length, input, input + 16, length - 16, output);
  for (auto& byte : key) byte = 0;
  if (!success) return fail(DECRYPT);
  if (method > 1) { decoded_length = length - 16; const u32 padding = output[decoded_length - 1]; if (!padding || padding > 16) return fail(DECRYPT); for (u32 i = 0; i < padding; ++i) if (output[decoded_length - 1 - i] != padding) return fail(DECRYPT); decoded_length -= padding; }
  return allocation;
}
static bool decrypt_value(u32 id, u32 number, u32 generation, u32 depth = 0) {
  auto value = node(id); if (!value || depth > 64) return fail(LIMIT);
  if (value->kind == STRING) { u32 length; const u32 pointer = decrypt_bytes(value->offset, value->length, number, generation, crypt_strings, length); if (!pointer) return false; value->offset = pointer; value->length = length; }
  else if (value->kind == ARRAY) { for (u32 child = value->first; child; child = node(child)->next) if (!decrypt_value(child, number, generation, depth + 1)) return false; }
  else if (value->kind == DICT) {
    const bool signature = named(field(id, "Type"), "Sig");
    for (u32 key = value->first; key;) { auto name = node(key); const u32 child = name->next; if (!child) return fail(SYNTAX); if (!(signature && same(name->offset, name->length, "Contents")) && !decrypt_value(child, number, generation, depth + 1)) return false; key = node(child)->next; }
  } else if (value->kind == STREAM) {
    if (named(field(value->first, "Type"), "XRef")) return true;
    if (!decrypt_value(value->first, number, generation, depth + 1)) return false;
    u32 method = named(field(value->first, "Type"), "EmbeddedFile") ? crypt_embedded : crypt_streams;
    if (!metadata_encrypted && named(field(value->first, "Type"), "Metadata")) method = 0;
    else {
      u32 filters = resolved(field(value->first, "Filter")), parameters = resolved(field(value->first, "DecodeParms")); auto f = node(filters), p = node(parameters);
      if (f && f->kind == ARRAY) { u32 position = 0; for (u32 item = f->first; item; item = node(item)->next, ++position) if (named(item, "Crypt")) { if (position) return fail(SYNTAX); filters = item; break; } }
      if (named(filters, "Crypt")) { if (p && p->kind == ARRAY) parameters = resolved(p->first); method = crypt_filter(field(parameters, "Name")); if (error) return false; }
    }
    u32 length; const u32 pointer = decrypt_bytes(value->offset, value->length, number, generation, method, length); if (!pointer) return false; value->offset = pointer; value->length = length;
  }
  return !error;
}
extern "C" u32 pn_pdf_set_crypt(u32 pointer, u32 length, u32 strings, u32 streams, u32 embedded, u32 encryption_number, u32 dictionary, u32 encrypt_metadata) {
  if (file_key_length || length < 5 || length > 32 || pointer > cursor || length > cursor - pointer || strings > 3 || streams > 3 || embedded > 3) return fail(SYNTAX);
  if (((strings == 2 || streams == 2 || embedded == 2) && length != 16) || ((strings == 3 || streams == 3 || embedded == 3) && length != 32)) return fail(SYNTAX);
  for (u32 i = 0; i < length; ++i) file_key[i] = *reinterpret_cast<u8*>(pointer + i); file_key_length = length; crypt_strings = strings; crypt_streams = streams; crypt_embedded = embedded; encryption_object = encryption_number; encryption_dictionary = dictionary; metadata_encrypted = encrypt_metadata != 0; return 1;
}
extern "C" void pn_pdf_clear_crypt() { volatile u8* key = file_key; for (u32 i = 0; i < 32; ++i) key[i] = 0; file_key_length = crypt_strings = crypt_streams = crypt_embedded = encryption_object = encryption_dictionary = 0; }
static Object* slot(u32 number, bool create) {
  if (!number || number > 10000000) { fail(LIMIT); return nullptr; }
  const u32 hash = number * 2654435761u & (HASH_SIZE - 1);
  // Odd multiplication permutes bucket residues. At most39 permitted object
  // numbers share one bucket, including deliberately chosen hostile inputs.
  for (Object* o = objects[hash]; o; o = o->next) if (o->number == number) return o;
  if (!create) return nullptr; if (object_count >= MAX_OBJECTS) { fail(LIMIT); return nullptr; }
  const u32 pointer = pn_pdf_alloc(sizeof(Object)); if (!pointer) return nullptr;
  auto o = reinterpret_cast<Object*>(pointer); *o = {}; o->number = number; o->next = objects[hash]; objects[hash] = o; ++object_count; return o;
}
static bool recover_stream_end(u32 object_offset, u32 begin, u32 declared, u32& marker, u32& length) {
  u32 boundary = source + source_length;
  // Stay inside this indexed object, so neighboring streams are not ambiguous candidates.
  for (u32 bucket = 0; bucket < HASH_SIZE; ++bucket) {
    if (++repair_work > 16u * 1024 * 1024) { fail(LIMIT); return false; }
    for (Object* object = objects[bucket]; object; object = object->next) {
      if (++repair_work > 16u * 1024 * 1024) { fail(LIMIT); return false; }
      if (!object->container && object->offset > object_offset && object->offset < source_length && source + object->offset < boundary) boundary = source + object->offset;
    }
  }
  if (boundary <= begin) return false;
  const u32 desired = declared > boundary - begin ? boundary : begin + declared;
  const u32 first = desired - begin > 65536 ? desired - 65536 : begin;
  const u32 last = boundary - desired > 65536 ? desired + 65536 : boundary;
  u32 found = 0;
  for (u32 at = first; at + 9 <= last; ++at) {
    if (++repair_work > 16u * 1024 * 1024) { fail(LIMIT); return false; }
    if ((at > begin && !white(*reinterpret_cast<u8*>(at - 1))) || !same(at, 9, "endstream")) continue;
    Reader candidate{at, boundary};
    if (!candidate.word("endstream") || !candidate.word("endobj")) continue;
    if (found) { fail(SYNTAX); return false; } found = at;
  }
  if (!found) return false;
  marker = found; length = found - begin;
  // The structural EOL preceding endstream is not recovered stream data.
  if (length && *reinterpret_cast<u8*>(begin + length - 1) == 10) { --length; if (length && *reinterpret_cast<u8*>(begin + length - 1) == 13) --length; }
  else if (length && *reinterpret_cast<u8*>(begin + length - 1) == 13) --length;
  repair_flags |= 2; return true;
}
extern "C" u32 pn_pdf_resolve(u32 number, u32 generation) {
  if (error) return 0; auto o = slot(number, false);
  if (o && o->state == 4) return o->value;
  if (!o || o->generation != generation) return fail(MISSING);
  if (o->state == 2) return o->value; if (!o->offset || o->container) return fail(MISSING); if (o->state == 1) return fail(CYCLE);
  if (resolve_depth >= 64) return fail(LIMIT);
  // Indirect stream lengths and decryption can recurse outside Reader::value.
  struct ResolveScope { ResolveScope() { ++resolve_depth; } ~ResolveScope() { --resolve_depth; } } scope;
  o->state = 1;
  Reader r{source + o->offset, source + source_length}; u32 actual = 0, gen = 0;
  if (!r.integer(actual) || !r.integer(gen) || !r.word("obj") || actual != number || gen != generation) return fail(SYNTAX);
  u32 value = r.value(); if (!value) return 0; r.skip();
  if (node(value)->kind == DICT && r.word("stream")) {
    if (r.at() == 13) { ++r.p; if (r.at() == 10) ++r.p; } else if (r.at() == 10) ++r.p; else return fail(SYNTAX);
    u32 len = field(value, "Length"); auto l = node(len); if (l && l->kind == REF) l = node(pn_pdf_resolve(l->aux, l->length));
    if (!l || l->kind != NUMBER || l->number < 0 || l->number > source_length || l->number != static_cast<u32>(l->number)) return fail(SYNTAX);
    u32 length = static_cast<u32>(l->number), marker = r.p + (length <= r.end - r.p ? length : 0);
    Reader expected{marker, r.end};
    if (length > r.end - r.p || !expected.word("endstream")) { if (!recover_stream_end(o->offset, r.p, length, marker, length)) return fail(SYNTAX); }
    u32 stream = make(STREAM); if (!stream) return 0; auto s = node(stream); s->first = value; s->offset = r.p; s->length = length;
    r.p = marker; if (!r.word("endstream")) return fail(SYNTAX); value = stream;
  }
  if (!r.word("endobj")) return fail(SYNTAX); if (file_key_length && number != encryption_object && !decrypt_value(value, number, generation)) return 0; o->value = value; o->state = 2; return value;
}
static u32 xref_chain(u32 offset) {
  u32 length = source_length;
  while (!error) {
    if (offset >= length || xref_links == 32) return fail(LIMIT); for (u32 i = 0; i < xref_links; ++i) if (xref_seen[i] == offset) return fail(CYCLE); xref_seen[xref_links++] = offset;
    Reader r{source + offset, source + length};
    if (!r.word("xref")) {
      u32 object_number = 0, gen = 0;
      if (!r.integer(object_number) || !r.integer(gen) || !r.word("obj")) return fail(SYNTAX);
      u32 dictionary = r.value(); if (!dictionary || node(dictionary)->kind != DICT || !r.word("stream")) return fail(SYNTAX);
      auto type = node(field(dictionary, "Type")), size = node(field(dictionary, "Length"));
      if (!type || type->kind != NAME || !same(type->offset, type->length, "XRef") || !size || size->kind != NUMBER || size->number < 0 || size->number > length || size->number != static_cast<u32>(size->number)) return fail(SYNTAX);
      if (r.at() == 13) { ++r.p; if (r.at() == 10) ++r.p; } else if (r.at() == 10) ++r.p; else return fail(SYNTAX);
      u32 n = static_cast<u32>(size->number); if (n > r.end - r.p) return fail(SYNTAX);
      u32 stream = make(STREAM); if (!stream) return 0; auto s = node(stream); s->first = dictionary; s->offset = r.p; s->length = n;
      r.p += n; if (!r.word("endstream") || !r.word("endobj")) return fail(SYNTAX);
      if (!trailer) trailer = dictionary; pending_xref = stream; return trailer;
    }
    while (!error) {
      r.skip(); if (r.word("trailer")) break; u32 first = 0, entries = 0;
      if (!r.integer(first) || !r.integer(entries) || entries > MAX_OBJECTS || first > 10000000 - entries) return fail(LIMIT);
      for (u32 i = 0; i < entries; ++i) {
        u32 position = 0, gen = 0; if (!r.integer(position) || !r.integer(gen)) return fail(SYNTAX); r.skip(); u8 flag = r.at(); ++r.p;
        if (flag != 'n' && flag != 'f') return fail(SYNTAX); if (first + i == 0) continue;
        auto o = slot(first + i, true); if (!o) return 0;
        // Newest xref entry wins, including tombstones for freed objects.
        if (!o->state) { o->offset = flag == 'n' ? position : 0; o->generation = gen; o->state = 3; o->value = xref_links; }
      }
    }
    u32 t = r.value(); if (!t || node(t)->kind != DICT) return fail(SYNTAX); if (!trailer) trailer = t;
    u32 prev = field(t, "Prev"), previous_offset = 0;
    if (prev) { auto n = node(prev); if (n->kind != NUMBER || n->number < 0 || n->number >= length || n->number != static_cast<u32>(n->number)) return fail(SYNTAX); previous_offset = static_cast<u32>(n->number); }
    u32 hybrid = field(t, "XRefStm");
    if (hybrid) {
      if (hybrid_revision) return fail(SYNTAX); auto n = node(hybrid); if (n->kind != NUMBER || n->number < 0 || n->number >= length || n->number != static_cast<u32>(n->number)) return fail(SYNTAX);
      hybrid_revision = xref_links; hybrid_previous = previous_offset; hybrid_has_previous = prev != 0; return xref_chain(static_cast<u32>(n->number));
    }
    if (!prev) break; offset = previous_offset;
  }
  return error ? 0 : trailer;
}
extern "C" u32 pn_pdf_init(u32 pointer, u32 length) {
  if (source || length > MAX_INPUT || length < 8 || pointer > cursor || length > cursor - pointer) return fail(LIMIT);
  source = pointer; source_length = length;
  bool header = false; for (u32 i = 0; i + 5 <= length && i < 1024; ++i) if (same(source + i, 5, "%PDF-")) { header = true; break; }
  if (!header) return fail(SYNTAX);
  u32 start = 0; for (u32 i = length > 65536 ? length - 65536 : 0; i + 9 <= length; ++i) if (same(source + i, 9, "startxref")) start = source + i + 9;
  if (!start) return fail(SYNTAX); Reader tail{start, source + length}; u32 offset = 0; if (!tail.integer(offset)) return fail(SYNTAX);
  if (offset >= length) offset = length;
  Reader probe{source + offset, source + length}; u32 object_number = 0, generation = 0;
  const bool valid_target = probe.word("xref") || (probe.integer(object_number) && probe.integer(generation) && probe.word("obj"));
  if (error) return 0;
  if (!valid_target) {
    u32 candidate = 0;
    for (u32 at = length > 65536 ? length - 65536 : 0; at + 4 <= length; ++at) {
      if ((at && !white(*reinterpret_cast<u8*>(source + at - 1))) || !same(source + at, 4, "xref")) continue;
      Reader check{source + at, source + length}; if (check.word("xref")) candidate = at;
    }
    if (!candidate) return fail(SYNTAX); offset = candidate; repair_flags |= 1;
  }
  return xref_chain(offset);
}
extern "C" u32 pn_pdf_repair_flags() { return repair_flags; }
extern "C" u32 pn_pdf_pending_xref() { return pending_xref; }
static bool integer_node(u32 id, u32& value) {
  auto n = node(id); if (!n || n->kind != NUMBER || n->number < 0 || n->number > 4294967295.0 || n->number != static_cast<u32>(n->number)) { fail(SYNTAX); return false; }
  value = static_cast<u32>(n->number); return true;
}
extern "C" u32 pn_pdf_supply_xref(u32 pointer, u32 length) {
  if (!pending_xref || pointer > cursor || length > cursor - pointer) return fail(SYNTAX);
  u32 dictionary = node(pending_xref)->first; pending_xref = 0;
  auto w = node(field(dictionary, "W")); if (!w || w->kind != ARRAY) return fail(SYNTAX);
  u32 widths[3] = {}, at = w->first, row = 0;
  for (u32 i = 0; i < 3; ++i) { if (!integer_node(at, widths[i]) || widths[i] > 4) return fail(LIMIT); row += widths[i]; at = node(at)->next; }
  if (at || !row) return fail(SYNTAX);
  auto index = node(field(dictionary, "Index")); u32 defaults = 0, first = 0, entries = 0;
  if (!index) { if (!integer_node(field(dictionary, "Size"), defaults)) return 0; entries = defaults; }
  else if (index->kind != ARRAY) return fail(SYNTAX);
  u32 next = index ? index->first : 0, p = pointer;
  do {
    if (index) { if (!integer_node(next, first)) return 0; next = node(next)->next; if (!integer_node(next, entries)) return 0; next = node(next)->next; }
    if (entries > MAX_OBJECTS || first > 10000000 - entries || entries > (length - (p - pointer)) / row) return fail(LIMIT);
    for (u32 i = 0; i < entries; ++i) {
      u32 values[3] = {widths[0] ? 0u : 1u, 0, 0};
      for (u32 j = 0; j < 3; ++j) for (u32 k = 0; k < widths[j]; ++k) values[j] = values[j] * 256 + *reinterpret_cast<u8*>(p++);
      if (first + i == 0) continue;
      auto o = slot(first + i, true); if (!o) return 0;
      if (!o->state || (hybrid_revision && o->state == 3 && o->value == hybrid_revision)) {
        // ISO 32000-1 table 18: unknown types reference null. They still
        // replace earlier revisions; skipping them could revive stale objects.
        if (values[0] > 2) { o->state = 4; o->value = make(NIL); o->container = o->offset = 0; if (!o->value) return 0; continue; }
        if (values[0] != 2 && values[2] > 65535) return fail(SYNTAX);
        o->state = 3; o->value = xref_links; o->container = 0; o->index = 0;
        o->generation = values[0] == 2 ? 0 : values[2]; o->offset = values[0] == 1 ? values[1] : 0;
        if (values[0] == 2) { if (!values[1] || values[2] > 100000) return fail(SYNTAX); o->container = values[1]; o->index = values[2]; }
      }
    }
    if (!index) break;
  } while (next && !error);
  if (p - pointer != length) return fail(SYNTAX);
  if (hybrid_revision) {
    bool has_previous = hybrid_has_previous; u32 offset = hybrid_previous;
    hybrid_revision = 0; hybrid_has_previous = 0; hybrid_previous = 0; return has_previous ? xref_chain(offset) : trailer;
  }
  u32 prev = field(dictionary, "Prev"), offset = 0;
  if (prev) { if (!integer_node(prev, offset)) return 0; return xref_chain(offset); }
  return trailer;
}
extern "C" u32 pn_pdf_object_stream(u32 after) {
  u32 found = 0;
  for (u32 i = 0; i < HASH_SIZE; ++i) for (auto o = objects[i]; o; o = o->next) if (o->container > after && (!found || o->container < found)) found = o->container;
  return found;
}
extern "C" u32 pn_pdf_supply_objects(u32 container, u32 pointer, u32 length) {
  if (pointer > cursor || length > cursor - pointer) return fail(SYNTAX);
  u32 stream_id = pn_pdf_resolve(container, 0); auto s = node(stream_id);
  if (!s || s->kind != STREAM) return fail(SYNTAX);
  u32 n = 0, first = 0;
  if (!integer_node(field(s->first, "N"), n) || !integer_node(field(s->first, "First"), first) || n > 100000 || first > length) return fail(LIMIT);
  struct Entry { u32 number, offset; };
  u32 allocation = pn_pdf_alloc(n * sizeof(Entry)); if (!allocation) return 0; auto entries = reinterpret_cast<Entry*>(allocation);
  Reader header{pointer, pointer + first}; u32 previous = 0;
  for (u32 i = 0; i < n; ++i) {
    u32 number = 0, offset = 0; if (!header.integer(number) || !header.integer(offset) || offset >= length - first || (i && offset <= previous)) return fail(SYNTAX); previous = offset; entries[i] = {number, offset};
  }
  header.skip(); if (header.p != header.end) return fail(SYNTAX);
  for (u32 i = 0; i < n; ++i) {
    u32 number = entries[i].number, offset = entries[i].offset;
    auto o = slot(number, false); if (!o || o->container != container) continue; if (o->index != i || o->state == 2) return fail(SYNTAX);
    Reader value{pointer + first + offset, i + 1 < n ? pointer + first + entries[i + 1].offset : pointer + length};
    o->value = value.value(); if (!o->value) return 0; value.skip(); if (value.p != value.end) return fail(SYNTAX); o->state = 2;
  }
  return 1;
}
static bool inline_direct(u32 id, u32 depth = 0) {
  const auto value = node(id); if (!value || depth > 64) return fail(LIMIT);
  if (value->kind > DICT) return fail(SYNTAX);
  if (value->kind == ARRAY || value->kind == DICT)
    for (u32 child = value->first; child; child = node(child)->next) if (!inline_direct(child, depth + 1)) return false;
  return true;
}
extern "C" u32 pn_pdf_parse_content(u32 pointer, u32 length) {
  if (pointer > cursor || length > cursor - pointer || length > 32u * 1024 * 1024) return fail(LIMIT);
  Reader r{pointer, pointer + length}; u32 result = make(ARRAY), last = 0;
  while (!error) {
    r.skip(); if (r.p == r.end) return result;
    u32 value = r.value(0, true); if (!value) return 0;
    if (node(value)->kind == WORD && same(node(value)->offset, node(value)->length, "BI")) {
      const u32 dictionary = make(DICT); u32 previous = 0, entries = 0;
      while (!error && !r.word("ID")) {
        if (++entries > 100000) return fail(LIMIT);
        const u32 key = r.value(0, true); if (!key || node(key)->kind != NAME) return fail(SYNTAX);
        const u32 item = r.value(); if (!item || !inline_direct(item)) return fail(SYNTAX);
        if (previous) node(previous)->next = key; else node(dictionary)->first = key;
        node(key)->next = item; previous = item;
      }
      if (error || r.p == r.end) return fail(SYNTAX);
      // ID consumes one whitespace byte; binary-leading whitespace is image data.
      const bool separated = white(r.at()); if (separated) ++r.p;
      const u32 stream = make(STREAM); if (!stream) return 0;
      node(stream)->first = dictionary; node(stream)->offset = r.p; node(stream)->length = r.end - r.p;
      node(stream)->aux = separated ? 3 : 1; node(stream)->next = value;
      if (last) node(last)->next = stream; else node(result)->first = stream;
      // The caller frames the filter's binary EOD before parsing the continuation.
      return result;
    }
    if (last) node(last)->next = value; else node(result)->first = value; last = value;
  }
  return 0;
}
extern "C" u32 pn_pdf_node(u32 index) { return reinterpret_cast<u32>(node(index)); }
extern "C" void pn_pdf_mark() { marked_cursor = cursor; marked_count = count; }
extern "C" void pn_pdf_rewind() {
  for (u32 i = (marked_count + BLOCK - 1) / BLOCK; i < (count + BLOCK - 1) / BLOCK; ++i) blocks[i] = nullptr;
  cursor = marked_cursor; count = marked_count;
}
extern "C" u32 pn_pdf_error() { return error; }
extern "C" u32 pn_pdf_abi_version() { return 1; }
