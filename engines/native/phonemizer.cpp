// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded lexical lookup and English spelling rules. No eSpeak code or rule data.
using u8 = unsigned char;
using u32 = unsigned int;
static const u8* dictionary;
static u32 dictionary_size, counts[2];
// Allowed character IDs from the pinned Apache-2.0 Kokoro vocabulary; ID zero is a boundary only.
static constexpr u32 valid_phones[] = {0x83fffe7eu, 0xfffdfe9au, 0x14ef79ffu, 0x69dfc0e8u, 0x7018ddbfu, 0x23a14u};
static u32 read32(const u8* p) { return p[0] | (u32(p[1]) << 8) | (u32(p[2]) << 16) | (u32(p[3]) << 24); }
static u32 read16(const u8* p) { return p[0] | (u32(p[1]) << 8); }
static bool range(u32 offset, u32 count, u32 size) { return offset <= size && count <= size - offset; }
static u32 length(const char* text) { u32 size = 0; while (text[size]) ++size; return size; }
static int compare(const u8* a, u32 an, const u8* b, u32 bn) {
  for (u32 i = 0; i < an && i < bn; ++i) if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
  return an < bn ? -1 : an > bn ? 1 : 0;
}
extern "C" u32 pn_abi_version() { return 1; }
extern "C" int pn_initialize(const u8* data, u32 size) {
  dictionary = nullptr; dictionary_size = counts[0] = counts[1] = 0;
  if (size < 32 || compare(data, 8, reinterpret_cast<const u8*>("PNPRON01"), 8)
    || read32(data + 8) != size || read32(data + 20) != 32) return -1;
  u32 us = read32(data + 12), uk = read32(data + 16);
  if (us > 250000 || uk > 250000 || !range(32, (us + uk) * 16, size)) return -2;
  u32 words = read32(data + 24), phones = read32(data + 28);
  if (words != 32 + (us + uk) * 16 || phones < words || phones > size) return -3;
  for (u32 i = 0; i < us + uk; ++i) {
    const u8* entry = data + 32 + i * 16;
    u32 word = read32(entry), word_size = read16(entry + 4), variants = read16(entry + 6);
    u32 pronunciation = read32(entry + 8), pronunciation_size = read32(entry + 12);
    if (!word_size || word_size > 255 || !variants || variants > 64 || word < words || !range(word, word_size, phones)
      || pronunciation < phones || !range(pronunciation, pronunciation_size, size)) return -4;
    for (u32 j = 0; j < word_size; ++j) if (!((data[word + j] >= 'a' && data[word + j] <= 'z') || data[word + j] == '\'' || data[word + j] == '-')) return -5;
    if (i && i != us) {
      const u8* previous = entry - 16;
      if (compare(data + read32(previous), read16(previous + 4), data + word, word_size) >= 0) return -6;
    }
    u32 offset = pronunciation;
    for (u32 j = 0; j < variants; ++j) {
      if (!range(offset - pronunciation, 2, pronunciation_size)) return -7;
      u32 n = read16(data + offset); offset += 2;
      if (!n || n > 512 || !range(offset - pronunciation, n, pronunciation_size)) return -8;
      for (u32 k = 0; k < n; ++k) {
        u32 phone = data[offset + k];
        if (phone > 177 || !(valid_phones[phone / 32] & (1u << (phone % 32)))) return -9;
      }
      offset += n;
    }
    if (offset != pronunciation + pronunciation_size) return -10;
  }
  dictionary = data; dictionary_size = size; counts[0] = us; counts[1] = uk;
  return 1;
}

extern "C" int pn_lookup(const u8* word, u32 size, u32 dialect, u32 variant, u8* output, u32 capacity) {
  if (!dictionary || !dictionary_size || dialect > 1 || !size || size > 255) return -1;
  u32 low = dialect ? counts[0] : 0, high = low + counts[dialect];
  while (low < high) {
    u32 middle = low + (high - low) / 2;
    const u8* entry = dictionary + 32 + middle * 16;
    int order = compare(word, size, dictionary + read32(entry), read16(entry + 4));
    if (order < 0) high = middle;
    else if (order > 0) low = middle + 1;
    else {
      u32 offset = read32(entry + 8), variants = read16(entry + 6);
      if (variant >= variants) return 0;
      for (u32 i = 0; i < variant; ++i) offset += 2 + read16(dictionary + offset);
      u32 n = read16(dictionary + offset);
      if (n > capacity) return -2;
      for (u32 i = 0; i < n; ++i) output[i] = dictionary[offset + 2 + i];
      return int(n);
    }
  }
  return 0;
}

struct Phone { const char* text; u8 id; };
static constexpr Phone phones[] = {
  {"a",43},{"b",44},{"d",46},{"e",47},{"f",48},{"h",50},{"i",51},{"j",52},{"k",53},{"l",54},{"m",55},
  {"n",56},{"o",57},{"p",58},{"s",61},{"t",62},{"u",63},{"v",64},{"w",65},{"z",68},{"ɑ",69},{"æ",72},
  {"ɔ",76},{"ð",81},{"ə",83},{"ɚ",85},{"ɛ",86},{"ɜ",87},{"ɡ",92},{"ɪ",102},{"ŋ",112},{"θ",119},{"ɹ",123},
  {"ʃ",131},{"ʊ",135},{"ʌ",138},{"ʒ",147},{"ˈ",156},{"ː",158}
};
static bool same(const char* a, const char* b, u32 size) { for (u32 i = 0; i < size; ++i) if (a[i] != b[i]) return false; return true; }
static bool vowel(char c) { return c == 'a' || c == 'e' || c == 'i' || c == 'o' || c == 'u' || c == 'y'; }
static bool voiced_ending(char c) { return vowel(c)||c=='b'||c=='d'||c=='g'||c=='l'||c=='m'||c=='n'||c=='r'||c=='v'||c=='w'||c=='z'; }
static int emit(const char* text, u8* out, u32& count, u32 capacity) {
  while (*text) {
    bool found = false;
    for (const Phone& phone : phones) {
      u32 n = length(phone.text);
      if (!same(text, phone.text, n)) continue;
      if (count == capacity) return -1;
      out[count++] = phone.id; text += n; found = true; break;
    }
    if (!found) return -2;
  }
  return 1;
}
struct Rule { const char* letters; const char* pronunciation; };
// These are newly authored English spelling correspondences, never loaded as a rule program.
static constexpr Rule rules[] = {
  {"tion","ʃən"},{"sion","ʒən"},{"tch","tʃ"},{"dge","dʒ"},{"igh","aɪ"},{"sch","sk"},
  {"ch","tʃ"},{"sh","ʃ"},{"th","θ"},{"ph","f"},{"ng","ŋ"},{"ck","k"},{"qu","kw"},
  {"ee","iː"},{"ea","iː"},{"ai","eɪ"},{"ay","eɪ"},{"oa","oʊ"},{"oi","ɔɪ"},{"oy","ɔɪ"},
  {"oo","uː"},{"ou","aʊ"},{"ow","aʊ"},{"au","ɔː"},{"aw","ɔː"},{"ew","juː"},{"ue","uː"}
};

extern "C" int pn_g2p(const char* word, u32 size, u32 dialect, u8* out, u32 capacity) {
  if (!size || size > 255 || dialect > 1) return -1;
  for (u32 i = 0; i < size; ++i) if (word[i] < 'a' || word[i] > 'z') return -2;
  u32 count = 0, position = 0, vowels = 0;
  // shortcut: OOV stress uses its first vowel; refine independent rules only with development data before held-out acceptance.
  while (position < size) {
    char c = word[position];
    if (vowel(c) && !vowels++) { if (emit("ˈ", out, count, capacity) < 0) return -3; }
    if (position == 0 && size > 2 && ((c == 'k' && word[1] == 'n') || (c == 'w' && word[1] == 'r') || (c == 'g' && word[1] == 'n'))) { ++position; continue; }
    if (c=='l'&&position+2==size&&word[position+1]=='e'&&position&&!vowel(word[position-1])) {
      if(emit("əl",out,count,capacity)<0)return -3;position+=2;continue;
    }
    if (position == size - 1 && c == 'e' && size > 3 && !vowel(word[position - 1])) { ++position; continue; }
    if (position + 1 < size && c == word[position + 1] && !vowel(c)) { ++position; continue; }
    if(c=='e'&&vowels>1&&position+1<size&&word[position+1]=='r'&&(position+2==size||(position+3==size&&word[position+2]=='s'))) {
      if(emit(dialect?"ə":"ɚ",out,count,capacity)<0)return -3;position+=2;continue;
    }
    if (position + 1 < size && word[position + 1] == 'r' && vowel(c)) {
      const char* sound = c == 'a' ? "ɑː" : c == 'o' ? "ɔː" : "ɜː";
      if (emit(sound, out, count, capacity) < 0 || (!dialect && emit("ɹ", out, count, capacity) < 0)) return -3;
      position += 2; continue;
    }
    bool matched = false;
    for (const Rule& rule : rules) {
      u32 n = length(rule.letters);
      if (n > size - position || !same(word + position, rule.letters, n)) continue;
      const char* sound = rule.pronunciation;
      if (dialect && same(rule.letters, "oa", 2)) sound = "əʊ";
      if (emit(sound, out, count, capacity) < 0) return -3;
      position += n; matched = true; break;
    }
    if (matched) continue;
    bool long_vowel = vowel(c) && position + 2 < size && !vowel(word[position + 1]) && word[position + 2] == 'e' && position + 3 == size;
    const char* sound = "";
    switch (c) {
      case 'a': sound = long_vowel ? "eɪ" : "æ"; break;
      case 'e': sound = "ɛ"; break;
      case 'i': sound = long_vowel ? "aɪ" : "ɪ"; break;
      case 'o': sound = long_vowel ? (dialect ? "əʊ" : "oʊ") : dialect ? "ɔ" : "ɑ"; break;
      case 'u': sound = long_vowel ? "juː" : "ʌ"; break;
      case 'y': sound = position == 0 ? "j" : position == size - 1 ? "i" : "ɪ"; break;
      case 'c': sound = position + 1 < size && (word[position + 1] == 'e' || word[position + 1] == 'i' || word[position + 1] == 'y') ? "s" : "k"; break;
      case 'g': sound = position + 1 < size && (word[position + 1] == 'e' || word[position + 1] == 'i') ? "dʒ" : "ɡ"; break;
      case 'j': sound = "dʒ"; break;
      case 'q': sound = "k"; break;
      case 'r': sound = dialect && (position + 1 == size || !vowel(word[position + 1])) ? "" : "ɹ"; break;
      case 's': sound = position+1==size&&position>1&&voiced_ending(word[position-1]) ? "z" : "s"; break;
      case 'x': sound = "ks"; break;
      default: { char literal[2] = {c,0}; if (emit(literal, out, count, capacity) < 0) return -3; ++position; continue; }
    }
    if (emit(sound, out, count, capacity) < 0) return -3;
    ++position;
  }
  return int(count);
}
