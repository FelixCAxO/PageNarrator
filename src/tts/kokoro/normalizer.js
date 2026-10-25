// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** @type {Array<[number, string]>} */
const SCALES = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
/** @type {Record<string, string>} */
const LETTERS = { a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'ef', g: 'gee', h: 'aitch', i: 'eye', j: 'jay',
  k: 'kay', l: 'el', m: 'em', n: 'en', o: 'oh', p: 'pee', q: 'cue', r: 'are', s: 'ess', t: 'tee', u: 'you',
  v: 'vee', w: 'double you', x: 'ex', y: 'why', z: 'zee' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** @type {Record<string, string>} */
const ABBREVIATIONS = { mr: 'mister', mrs: 'missus', ms: 'miz', dr: 'doctor', prof: 'professor', sr: 'senior', jr: 'junior',
  st: 'saint', vs: 'versus', etc: 'et cetera', 'e.g': 'for example', 'i.e': 'that is', fig: 'figure', figs: 'figures', p: 'page', pp: 'pages' };
/** @type {Record<string, string>} */
const SYMBOLS = { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', θ: 'theta', λ: 'lambda', μ: 'mu', π: 'pie',
  σ: 'sigma', φ: 'phi', ω: 'omega', '&': 'and', '%': 'percent', '+': 'plus', '=': 'equals', '@': 'at', '#': 'number', '°': 'degrees' };
/** @type {Record<string, string>} */
const ORDINALS = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
/** @type {Record<string, string>} */
const COLLOQUIAL = { bout: 'about', cause: 'because', em: 'them', til: 'until' };
const INITIALISMS = new Set(['PDF', 'HTML', 'OCR', 'CPU', 'GPU', 'API', 'JSON', 'USB', 'HTTP', 'HTTPS', 'URL', 'UK', 'USA', 'US', 'BBC', 'NHS', 'UN', 'EU', 'XML', 'CSS', 'SQL', 'ID', 'IP', 'DNS', 'UI', 'UX', 'TV']);

/** @param {number|string} value @param {string} [dialect] @returns {string} */
export function englishInteger(value, dialect = 'en-us') {
  if (!/^-?\d{1,15}$/.test(String(value))) throw new RangeError('English integer exceeds supported bounds.');
  const number = Number(value);
  if (number < 0) return `minus ${englishInteger(-number, dialect)}`;
  if (number < 20) return SMALL[number];
  if (number < 100) return `${TENS[Math.floor(number / 10)]}${number % 10 ? ` ${SMALL[number % 10]}` : ''}`;
  if (number < 1000) return `${SMALL[Math.floor(number / 100)]} hundred${number % 100 ? `${dialect === 'en-us' ? ' ' : ' and '}${englishInteger(number % 100, dialect)}` : ''}`;
  for (const [scale, name] of SCALES) {
    if (number >= scale) return `${englishInteger(Math.floor(number / scale), dialect)} ${name}${number % scale ? ` ${englishInteger(number % scale, dialect)}` : ''}`;
  }
  throw new RangeError('Invalid English integer.');
}

/** @param {number|string} value @param {string} dialect @returns {string} */
function ordinal(value, dialect) {
  return englishInteger(value, dialect).replace(/[a-z]+$/, word => ORDINALS[word] || (word.endsWith('y') ? `${word.slice(0, -1)}ieth` : `${word}th`));
}

/** @param {string} word @param {string} [dialect] */
export function spellEnglishLetters(word, dialect = 'en-us') {
  return [...word].map(char => char === 'z' && dialect !== 'en-us' ? 'zed' : LETTERS[char] || char).join(' ');
}

/** Original bounded text normalization; no downloaded regex/rule program is evaluated.
 * @param {string} input @param {string} [dialect] @returns {Array<{words: string[], punctuation: string}>} */
export function normalizeEnglishText(input, dialect = 'en-us') {
  if (!['en-us', 'en-gb', 'en'].includes(dialect)) throw new Error(`Invalid language identifier: "${dialect}".`);
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Phonemizer requires text without null characters.');
  if (input.length > 16_384) throw new RangeError('English phonemizer text exceeds 16384 characters.');
  let text = input.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'")
    .replace(/æ/gi, 'ae').replace(/œ/gi, 'oe').replaceAll('−', '-').replaceAll('_', ' ');
  text = text.replace(/[A-Za-z]+(?:'s)?/g, word => {
    const base = word.replace(/(?:'s|s)$/, '');
    return INITIALISMS.has(word) || INITIALISMS.has(base) ? word
      : word.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  });
  text = text.replace(/\b(figs?|pp?)\.(?=\s*\d)/gi, value => ABBREVIATIONS[value.slice(0, -1).toLowerCase()]);
  text = text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, year, month, day) => {
    const m = Number(month), d = Number(day);
    if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(Number(year), m, 0)).getUTCDate()) throw new Error('Invalid calendar date.');
    return `${MONTHS[m - 1]} ${ordinal(day, dialect)} ${englishInteger(year, dialect)}`;
  });
  text = text.replace(/\b(?:\d{1,3}(?:,\d{3})+)\b/g, number => number.replaceAll(',', ''));
  // Preserve typographic intervals before minus-sign normalization and signed-number expansion.
  text = text.replace(/(-?\d+(?:\.\d+)?)\s*–\s*(-?\d+(?:\.\d+)?)/g, '$1 to $2').replaceAll('–', '-');
  text = text.replace(/(-?)([$£€])(-?\d+)(?:\.(\d{1,2}))?/g, (_, sign, currency, major, minor) => {
    const unit = currency === '$' ? 'dollar' : currency === '£' ? 'pound' : 'euro';
    const negative = sign === '-' || major.startsWith('-');
    const whole = major.replace(/^-/, '');
    const main = `${englishInteger(whole, dialect)} ${unit}${Number(whole) === 1 ? '' : 's'}`;
    const cents = minor ? Number(minor.padEnd(2, '0')) : 0;
    return ` ${negative ? 'minus ' : ''}${main}${cents ? ` and ${englishInteger(cents, dialect)} ${currency === '£' ? cents === 1 ? 'penny' : 'pence' : cents === 1 ? 'cent' : 'cents'}` : ''} `;
  });
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, hour, minute) => {
    if (Number(hour) > 23 || Number(minute) > 59) throw new Error('Invalid clock time.');
    return `${englishInteger(hour, dialect)} ${minute === '00' ? "o'clock" : `${Number(minute) < 10 ? 'oh ' : ''}${englishInteger(minute, dialect)}`}`;
  });
  text = text.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (_, number) => ordinal(number, dialect));
  text = text.replace(/-?\d+(?:\.\d+)?/g, number => {
    const [integer, fraction] = number.split('.');
    // Keep the sign when a negative decimal has a zero integer part.
    const decimalSign = fraction && /^-0+$/.test(integer) ? 'minus ' : '';
    return ` ${decimalSign}${englishInteger(integer, dialect)}${fraction ? ` point ${[...fraction].map(digit => SMALL[Number(digit)]).join(' ')}` : ''} `;
  });
  text = text.replace(/\b(?:e\.g|i\.e|mr|mrs|ms|dr|prof|sr|jr|st|vs|etc)\./gi, value => ABBREVIATIONS[value.slice(0, -1).toLowerCase()]);
  text = text.replace(/\bI'm\b/gi, 'I am').replace(/\bwon't\b/gi, 'will not').replace(/\bcan't\b/gi, 'cannot')
    .replace(/\b([a-z]+)n't\b/gi, '$1 not').replace(/\b([a-z]+)'re\b/gi, '$1 are')
    .replace(/\b([a-z]+)'ve\b/gi, '$1 have').replace(/\b([a-z]+)'ll\b/gi, '$1 will');
  text = text.replace(/(^|\s)'(bout|cause|em|til)\b/gi, (_, space, word) => `${space}${COLLOQUIAL[word.toLowerCase()]}`);
  text = text.replace(/\b([A-Z]{2,8})(s|'s)?\b/g, (word, base, suffix) => INITIALISMS.has(base) ? `${spellEnglishLetters(base.toLowerCase(), dialect)}${suffix ?? ''}` : word);
  text = text.replace(/[αβγδεθλμπσφω&%+=@#°]/g, char => ` ${SYMBOLS[char]} `);
  if (/[^a-z\s\p{P}\p{S}]/iu.test(text)) throw new Error('Text contains characters outside the English phonemizer alphabet.');
  const clauses = [];
  let words = [];
  for (const match of text.matchAll(/[a-z]+(?:['-][a-z]+)*|[,;:.!?—…]+/gi)) {
    const value = match[0];
    if (/^[a-z]/i.test(value)) words.push(value.toLowerCase());
    else if (words.length) { clauses.push({ words, punctuation: value }); words = []; }
  }
  if (words.length) clauses.push({ words, punctuation: '' });
  return clauses;
}
