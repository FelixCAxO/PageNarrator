// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = new URL('../native/pdf.cpp', import.meta.url);
const fontSource = new URL('../native/pdf-type1.cpp', import.meta.url);
const codecSource = new URL('../native/pdf-codecs.cpp', import.meta.url);
const jpegSource = new URL('../native/pdf-jpeg.cpp', import.meta.url);
const faxSource = new URL('../native/pdf-fax.cpp', import.meta.url);
const jbigSource = new URL('../native/pdf-jbig2.cpp', import.meta.url);
const mqSource = new URL('../native/pdf-mq.h', import.meta.url);
const cryptoSource = new URL('../native/pdf-crypto.cpp', import.meta.url);
const cryptoHeader = new URL('../native/pdf-crypto.h', import.meta.url);
const jpxSource = new URL('../native/pdf-jpx.cpp', import.meta.url);
const inlineSource = new URL('../native/pdf-inline.cpp', import.meta.url);
const cffPathSource = new URL('../native/pdf-cff-path.cpp', import.meta.url);
const ttfPathSource = new URL('../native/pdf-ttf-path.cpp', import.meta.url);
const output = new URL('../native/pdf.wasm', import.meta.url);
const metadata = new URL('../native/pdf.json', import.meta.url);
const hash = url => createHash('sha256').update(readFileSync(url)).digest('hex');
const sourceHashes = () => Object.fromEntries(Object.entries({ sourceSha256: source, fontSourceSha256: fontSource, codecSourceSha256: codecSource, jpegSourceSha256: jpegSource, faxSourceSha256: faxSource, jbigSourceSha256: jbigSource, mqSourceSha256: mqSource, cryptoSourceSha256: cryptoSource, cryptoHeaderSha256: cryptoHeader, jpxSourceSha256: jpxSource, inlineSourceSha256: inlineSource, cffPathSourceSha256: cffPathSource, ttfPathSourceSha256: ttfPathSource }).map(([key, file]) => [key, hash(file)]));
const exports = ['pn_pdf_alloc', 'pn_pdf_init', 'pn_pdf_repair_flags', 'pn_pdf_resolve', 'pn_pdf_parse_content', 'pn_pdf_node', 'pn_pdf_error', 'pn_pdf_abi_version', 'pn_pdf_mark', 'pn_pdf_rewind',
  'pn_pdf_pending_xref', 'pn_pdf_supply_xref', 'pn_pdf_object_stream', 'pn_pdf_supply_objects', 'pn_t1_glyph', 'pn_cff_width', 'pn_pdf_lzw', 'pn_pdf_jpeg', 'pn_pdf_fax', 'pn_pdf_mq_bits', 'pn_jbig2_generic', 'pn_jbig2_refine', 'pn_jbig2_halftone', 'pn_jbig2_arith_size', 'pn_jbig2_arith_start', 'pn_jbig2_arith_integer', 'pn_jbig2_arith_id', 'pn_jbig2_arith_generic', 'pn_jbig2_arith_refine', 'pn_pdf_md5', 'pn_pdf_rc4', 'pn_pdf_aes_decrypt', 'pn_pdf_set_crypt', 'pn_pdf_clear_crypt', 'pn_pdf_jpx_block', 'pn_pdf_jpx_block_segments', 'pn_pdf_jpx_inverse53', 'pn_pdf_jpx_inverse97', 'pn_pdf_inline_length', 'pn_cff_glyph', 'pn_ttf_glyph'];
const flags = ['c++', '-target', 'wasm32-freestanding', '-std=c++20', '-O3', '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
  `-Wl,-z,stack-size=131072,--no-entry,${exports.map(name => `--export=${name}`).join(',')},--export-memory,--initial-memory=8388608,--max-memory=268435456,--strip-all`];
if (process.argv.includes('--check')) {
  const recorded = JSON.parse(readFileSync(metadata, 'utf8'));
  if (Object.entries(sourceHashes()).some(([key, value]) => recorded[key] !== value) || recorded.wasmSha256 !== hash(output)
    || JSON.stringify(recorded.flags) !== JSON.stringify(flags)) throw new Error('Original PDF source/binary mismatch. Rebuild using Zig 0.15.2.');
  console.log('Original PDF source and binary hashes match.');
} else {
  const compiler = process.env.PN_ZIG || 'zig';
  const version = spawnSync(compiler, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== '0.15.2') throw new Error('Set PN_ZIG to Zig 0.15.2.');
  const inputs = sourceHashes(), result = spawnSync(compiler, [...flags, fileURLToPath(source), fileURLToPath(fontSource), fileURLToPath(codecSource), fileURLToPath(jpegSource), fileURLToPath(faxSource), fileURLToPath(jbigSource), fileURLToPath(cryptoSource), fileURLToPath(jpxSource), fileURLToPath(inlineSource), fileURLToPath(cffPathSource), fileURLToPath(ttfPathSource), '-o', fileURLToPath(output)], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Original PDF compilation failed.');
  if (JSON.stringify(inputs) !== JSON.stringify(sourceHashes())) throw new Error('PDF sources changed during compilation. Rebuild before recording a source/binary match.');
  const module = await WebAssembly.compile(readFileSync(output));
  if (WebAssembly.Module.imports(module).length) throw new Error('PDF parser unexpectedly imports a runtime.');
  writeFileSync(metadata, `${JSON.stringify({ abi: 1, compiler: 'Zig 0.15.2 (Clang C++)', flags,
    ...inputs, wasmSha256: hash(output), imports: [] }, null, 2)}\n`);
  console.log(`Built original PDF parser: ${readFileSync(output).length} bytes, no imports.`);
}
