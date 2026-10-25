// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { PdfEngineError } from './native-reader.js';
import { preparePdfPassword } from './saslprep.js';
const PADDING = Uint8Array.of(0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0, 0x4e, 0x56, 0xff, 0xfa, 1, 8, 0x2e, 0x2e, 0, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a);
function corrupt(message) { throw new PdfEngineError(message, 'pdf_corrupt'); }
const join = (...pieces) => { const output = new Uint8Array(pieces.reduce((n, piece) => n + piece.length, 0)); let offset = 0; for (const piece of pieces) { output.set(piece, offset); offset += piece.length; } return output; };
function paddedPassword(value) {
  if (typeof value === 'string') { if ([...value].some(c => c.charCodeAt(0) > 255)) throw new PdfEngineError('This legacy PDF password encoding is not implemented yet.'); value = Uint8Array.from(value, c => c.charCodeAt(0)); }
  if (!(value instanceof Uint8Array)) corrupt('PDF password must be a string or bytes.');
  const result = PADDING.slice(), length = Math.min(32, value.length); result.set(value.subarray(0, length)); if (length < 32) result.set(PADDING.subarray(0, 32 - length), length); return result;
}
export function pdfMd5(reader, bytes) {
  reader.check(); reader.api.pn_pdf_mark();
  try {
    const input = reader.copy(bytes), output = reader.checked(reader.api.pn_pdf_alloc(16));
    if (!reader.api.pn_pdf_md5(input, bytes.length, output)) throw new PdfEngineError('Invalid PDF digest input.', 'pdf_limit');
    return new Uint8Array(reader.api.memory.buffer, output, 16).slice();
  } finally { reader.api.pn_pdf_rewind(); }
}
export function pdfRc4(reader, key, bytes) {
  reader.check(); reader.api.pn_pdf_mark();
  try {
    const input = reader.copy(bytes), keyPointer = reader.copy(key), output = reader.checked(reader.api.pn_pdf_alloc(bytes.length));
    if (!reader.api.pn_pdf_rc4(keyPointer, key.length, input, bytes.length, output)) throw new PdfEngineError('Invalid PDF RC4 input.', 'pdf_corrupt');
    return new Uint8Array(reader.api.memory.buffer, output, bytes.length).slice();
  } finally { reader.api.pn_pdf_rewind(); }
}
export function pdfAesDecrypt(reader, key, iv, bytes) {
  if (iv.length !== 16) throw new PdfEngineError('Invalid PDF AES IV.', 'pdf_corrupt');
  reader.check(); reader.api.pn_pdf_mark();
  try {
    const input = reader.copy(bytes), keyPointer = reader.copy(key), ivPointer = reader.copy(iv), output = reader.checked(reader.api.pn_pdf_alloc(bytes.length));
    if (!reader.api.pn_pdf_aes_decrypt(keyPointer, key.length, ivPointer, input, bytes.length, output)) throw new PdfEngineError('Invalid PDF AES block input.', 'pdf_corrupt');
    return new Uint8Array(reader.api.memory.buffer, output, bytes.length).slice();
  } finally { reader.api.pn_pdf_rewind(); }
}
function passwordFailure() { const error = new PdfEngineError('This PDF requires a valid password.', 'pdf_password'); error.name = 'PasswordException'; throw error; }
function installKey(reader, encryption, dictionary, key, { revision, permissions, ownerAuthenticated, metadataEncrypted }) {
  const filter = name => {
    if (!name || name === 'Identity') return 0;
    const filters = reader.field(dictionary, 'CF'), selected = filters && reader.field(filters, name); if (!selected) throw new PdfEngineError(`PDF crypt filter /${name} is not implemented.`);
    const method = reader.name(reader.field(selected, 'CFM')) || 'None', declaredLength = reader.number(reader.field(selected, 'Length'), key.length);
    if (declaredLength !== key.length) throw new PdfEngineError('Per-filter PDF encryption key lengths are not implemented yet.');
    const code = { None: 0, V2: 1, AESV2: 2, AESV3: 3 }[method]; if (code === undefined) throw new PdfEngineError(`PDF crypt method /${method} is not implemented.`); return code;
  };
  const streamsName = reader.name(reader.field(dictionary, 'StmF')), streams = revision >= 4 ? filter(streamsName) : 1, strings = revision >= 4 ? filter(reader.name(reader.field(dictionary, 'StrF'))) : 1;
  const embedded = revision >= 4 ? filter(reader.name(reader.field(dictionary, 'EFF')) || streamsName) : streams, unresolved = reader.node(encryption, { resolve: false });
  reader.api.pn_pdf_mark();
  try { const pointer = reader.copy(key); reader.checked(reader.api.pn_pdf_set_crypt(pointer, key.length, strings, streams, embedded, unresolved.kind === 'reference' ? unresolved.aux : 0, dictionary, metadataEncrypted ? 1 : 0)); new Uint8Array(reader.api.memory.buffer, pointer, key.length).fill(0); }
  finally { reader.api.pn_pdf_rewind(); }
  reader.security = { revision, permissions, ownerAuthenticated };
}
async function aes256Hash(reader, password, salt, user, revision) {
  const digest = async (name, bytes) => new Uint8Array(await crypto.subtle.digest(name, bytes));
  let key = await digest('SHA-256', join(password, salt, user)); if (revision === 5) return key;
  let round = 0, last = 0;
  do {
    reader.check(); const piece = join(password, key, user), block = new Uint8Array(piece.length * 64);
    for (let i = 0; i < 64; i++) block.set(piece, i * piece.length);
    const cipherKey = await crypto.subtle.importKey('raw', key.subarray(0, 16), 'AES-CBC', false, ['encrypt']);
    // WebCrypto adds PKCS#7; preceding blocks are the required unpadded CBC data.
    const padded = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: key.subarray(16, 32) }, cipherKey, block)), encrypted = padded.subarray(0, block.length);
    let selector = 0; for (const byte of encrypted.subarray(0, 16)) selector = (selector * 256 + byte) % 3;
    key = await digest(['SHA-256', 'SHA-384', 'SHA-512'][selector], encrypted); last = encrypted.at(-1); round++;
  } while (round < 64 || last > round - 32);
  return key.slice(0, 32);
}
async function initializeAes256(reader, encryption, dictionary, password, revision) {
  const get = (name, length) => { const id = reader.field(dictionary, name); if (!id || reader.node(id).kind !== 'string') corrupt(`Missing AES-256 PDF ${name} entry.`); const value = reader.bytes(id); if (value.length !== length) corrupt(`Invalid AES-256 PDF ${name} length.`); return value; };
  const owner = get('O', 48), user = get('U', 48), ownerEncrypted = get('OE', 32), userEncrypted = get('UE', 32), permissionCipher = get('Perms', 16), permissions = reader.number(reader.field(dictionary, 'P'));
  if (!Number.isInteger(permissions) || permissions < -0x80000000 || permissions > 0xffffffff || reader.number(reader.field(dictionary, 'Length'), 256) !== 256) corrupt('Invalid AES-256 PDF encryption parameters.');
  const metadataId = reader.field(dictionary, 'EncryptMetadata'); if (metadataId && reader.node(metadataId).kind !== 'boolean') corrupt('Invalid PDF EncryptMetadata flag.'); const metadataEncrypted = !metadataId || !!reader.node(metadataId).aux;
  let ownedPassword = null;
  if (typeof password === 'string') password = ownedPassword = new TextEncoder().encode(revision === 6 ? preparePdfPassword(password) : password);
  if (!(password instanceof Uint8Array)) corrupt('PDF password must contain UTF-8 bytes.'); const encoded = password.slice(0, 127); ownedPassword?.fill(0);
  const equals = (actual, expected) => { let difference = 0; for (let i = 0; i < 32; i++) difference |= actual[i] ^ expected[i]; return !difference; };
  let ownerAuthenticated = false, key = null;
  try {
    if (equals(await aes256Hash(reader, encoded, user.subarray(32, 40), new Uint8Array(), revision), user)) {
      const cipherKey = await aes256Hash(reader, encoded, user.subarray(40, 48), new Uint8Array(), revision); key = pdfAesDecrypt(reader, cipherKey, new Uint8Array(16), userEncrypted); cipherKey.fill(0);
    } else if (equals(await aes256Hash(reader, encoded, owner.subarray(32, 40), user, revision), owner)) {
      ownerAuthenticated = true; const cipherKey = await aes256Hash(reader, encoded, owner.subarray(40, 48), user, revision); key = pdfAesDecrypt(reader, cipherKey, new Uint8Array(16), ownerEncrypted); cipherKey.fill(0);
    } else passwordFailure();
    const decoded = pdfAesDecrypt(reader, key, new Uint8Array(16), permissionCipher), value = new DataView(decoded.buffer).getInt32(0, true);
    if ((value | 0) !== (permissions | 0) || decoded.subarray(4, 8).some(byte => byte !== 255) || decoded[8] !== (metadataEncrypted ? 84 : 70) || decoded[9] !== 97 || decoded[10] !== 100 || decoded[11] !== 98) corrupt('AES-256 PDF permissions validation failed.');
    installKey(reader, encryption, dictionary, key, { revision, permissions, ownerAuthenticated, metadataEncrypted });
  } finally { encoded.fill(0); key?.fill(0); }
}
// ISO 32000-1 7.6.3 algorithms 2..7 and ISO 32000-2 algorithms2.A/2.B.
// Algorithm2.B repetition follows PDF Association ISO-approved erratum #325.
export async function initializePdfEncryption(reader, password = '') {
  const encryption = reader.field(reader.trailer, 'Encrypt'); if (!encryption || reader.node(encryption).kind === 'null') return;
  const dictionary = reader.node(encryption).id;
  if (reader.name(reader.field(dictionary, 'Filter')) !== 'Standard') throw new PdfEngineError('This PDF security handler is not implemented yet.');
  const revision = reader.number(reader.field(dictionary, 'R')), version = reader.number(reader.field(dictionary, 'V'), 0);
  if ([5, 6].includes(revision) && version === 5) return initializeAes256(reader, encryption, dictionary, password, revision);
  if (![2, 3, 4].includes(revision) || !([1, 2, 4].includes(version)) || revision === 2 && version !== 1 || revision === 4 && version !== 4) throw new PdfEngineError('This PDF encryption revision is not implemented yet.');
  const bits = revision === 2 ? 40 : reader.number(reader.field(dictionary, 'Length'), 40), length = bits / 8;
  if (!Number.isInteger(length) || length < 5 || length > 16) corrupt('Invalid PDF encryption key length.');
  const string = key => { const id = reader.field(dictionary, key); if (!id || reader.node(id).kind !== 'string') corrupt(`Missing PDF encryption ${key} string.`); return reader.bytes(id); };
  const owner = string('O'), user = string('U'), permissions = reader.number(reader.field(dictionary, 'P'));
  if (owner.length !== 32 || user.length < 32 || !Number.isInteger(permissions) || permissions < -0x80000000 || permissions > 0xffffffff) corrupt('Invalid PDF standard encryption parameters.');
  const ids = reader.field(reader.trailer, 'ID'); if (!ids || reader.node(ids).kind !== 'array') corrupt('Missing encrypted PDF file identifier.'); const firstId = reader.array(ids)[0];
  if (!firstId || reader.node(firstId).kind !== 'string') corrupt('Invalid encrypted PDF file identifier.'); const identifier = reader.bytes(firstId);
  const metadataId = reader.field(dictionary, 'EncryptMetadata'); if (metadataId && reader.node(metadataId).kind !== 'boolean') corrupt('Invalid PDF EncryptMetadata flag.');
  const metadataEncrypted = !metadataId || !!reader.node(metadataId).aux, permissionsBytes = new Uint8Array(4); new DataView(permissionsBytes.buffer).setInt32(0, permissions, true);
  const padded = paddedPassword(password);
  const authenticate = candidate => {
    let digest = pdfMd5(reader, join(candidate, owner, permissionsBytes, identifier, revision >= 4 && !metadataEncrypted ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array()));
    if (revision >= 3) for (let i = 0; i < 50; i++) digest = pdfMd5(reader, digest.subarray(0, length));
    const key = digest.slice(0, length); let expected;
    if (revision === 2) expected = pdfRc4(reader, key, PADDING);
    else { expected = pdfRc4(reader, key, pdfMd5(reader, join(PADDING, identifier))); for (let i = 1; i < 20; i++) expected = pdfRc4(reader, key.map(byte => byte ^ i), expected); }
    const compared = revision === 2 ? 32 : 16; let difference = 0; for (let i = 0; i < compared; i++) difference |= expected[i] ^ user[i];
    if (difference) { key.fill(0); return null; } return key;
  };
  let key = authenticate(padded), ownerAuthenticated = false;
  if (!key) {
    let digest = pdfMd5(reader, padded); if (revision >= 3) for (let i = 0; i < 50; i++) digest = pdfMd5(reader, digest);
    const ownerKey = digest.slice(0, length); let candidate = owner.slice();
    if (revision === 2) candidate = pdfRc4(reader, ownerKey, candidate);
    else for (let i = 19; i >= 0; i--) candidate = pdfRc4(reader, ownerKey.map(byte => byte ^ i), candidate);
    key = authenticate(candidate); ownerAuthenticated = !!key; ownerKey.fill(0); candidate.fill(0);
  }
  padded.fill(0);
  if (!key) passwordFailure();
  try {
    installKey(reader, encryption, dictionary, key, { revision, permissions, ownerAuthenticated, metadataEncrypted });
  } finally { key.fill(0); }
}
