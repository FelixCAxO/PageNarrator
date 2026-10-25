import { describe, expect, it } from 'vitest';
import { NativePdfReader } from '../../src/pdf/native-reader.js';
import { pdfPayloadBuffers, pdfPayloadByteLength } from '../../src/pdf/payload-buffers.js';
import { compilePdfFunction, readPdfFunction } from '../../src/pdf/pdf-functions.js';
import { options, simplePdf, stream } from './fixtures.js';

const exponential = () => ({ type: 2, domain: [0, 1], range: null, inputs: 1, outputs: 1, c0: [0], c1: [1], exponent: 1 });
const sampled = count => ({ type: 0, domain: [0, 1], range: [0, 1], inputs: 1, outputs: 1, size: [count], bits: 1,
  encode: [0, count - 1], decode: [0, 1], samples: new Uint8Array(Math.ceil(count / 8)) });
const stitching = functions => ({ type: 3, domain: [0, 1], range: null, inputs: 1, outputs: 1, functions,
  bounds: Array.from({ length: functions.length - 1 }, (_, i) => (i + 1) / functions.length), encode: functions.flatMap(() => [0, 1]) });
const wrap = (leaf, depth, fanout = 1) => { for (let i = 0; i < depth; i++) leaf = stitching(Array(fanout).fill(leaf)); return leaf; };

// Original authored object graph: preserve indirect sharing, including deliberate cycles.
function graphPdf(root) {
  const nodes = [root], ids = new Map([[root, 6]]);
  for (let i = 0; i < nodes.length; i++) for (const child of nodes[i].functions ?? []) if (!ids.has(child)) { ids.set(child, nodes.length + 6); nodes.push(child); }
  const array = values => `[${values.join(' ')}]`;
  return simplePdf('', { extra: nodes.map(fn => {
    const common = `/FunctionType ${fn.type} /Domain ${array(fn.domain)}`;
    if (fn.type === 2) return `<< ${common} /N ${fn.exponent} >>`;
    if (fn.type === 3) return `<< ${common} /Functions [${fn.functions.map(child => `${ids.get(child)} 0 R`).join(' ')}] /Bounds ${array(fn.bounds)} /Encode ${array(fn.encode)} >>`;
    if (fn.type === 4) return stream(fn.program, `${common} /Range ${array(fn.range)}`);
    return stream(fn.samples, `${common} /Range ${array(fn.range)} /Size ${array(fn.size)} /BitsPerSample ${fn.bits}`);
  }) });
}
async function withReader(root, action) {
  const reader = await NativePdfReader.create(graphPdf(root), options);
  try { return await action(reader, reader.checked(reader.api.pn_pdf_resolve(6, 0))); }
  finally { reader.destroy(); }
}
const read = root => withReader(root, (reader, value) => readPdfFunction(reader, value));

function visitGraph(over) {
  const leaf = exponential();
  return stitching(Array.from({ length: 64 }, (_, i) => stitching(Array(i === 0 && !over ? 254 : 255).fill(leaf))));
}
function nodeGraph(over) {
  return stitching(Array.from({ length: 16 }, (_, i) => stitching(Array.from({ length: i === 15 && !over ? 254 : 255 }, exponential))));
}

describe('bounded shared PDF function graphs', () => {
  it('reads and compiles an eight-way six-level DAG once per distinct function', async () => {
    const source = wrap(exponential(), 6, 8);
    const descriptor = await withReader(source, async (reader, value) => {
      let nodeCalls = 0, functionReads = 0;
      const node = reader.node.bind(reader), field = reader.field.bind(reader);
      reader.node = (...args) => { if (++nodeCalls > 5000) throw Error('bounded test observer'); return node(...args); };
      reader.field = (id, key) => { if (key === 'FunctionType') functionReads++; return field(id, key); };
      const result = await readPdfFunction(reader, value);
      expect(functionReads).toBe(7); expect(nodeCalls).toBeLessThan(5000);
      return result;
    });
    let node = descriptor, compiledNodes = 0;
    for (let i = 0; i <= 6; i++) {
      const type = node.type;
      Object.defineProperty(node, 'type', { get: () => { compiledNodes++; return type; } });
      if (i < 6) { expect(node.functions).toHaveLength(8); for (const child of node.functions) expect(child).toBe(node.functions[0]); node = node.functions[0]; }
    }
    const run = compilePdfFunction(descriptor); expect(compiledNodes).toBe(7);
    for (const input of [-1, 0, 1 / 8 ** 7, 1, 2]) {
      let expected = Math.max(0, Math.min(1, input));
      for (let i = 0; i < 6; i++) expected = expected === 1 ? 1 : expected * 8 % 1;
      expect(run([input])[0]).toBeCloseTo(expected, 12);
    }
  });

  it('keeps parsing and public compilation caches private to one top-level call', async () => {
    const source = wrap(exponential(), 2, 2);
    await withReader(source, async (reader, value) => {
      const first = await readPdfFunction(reader, value), second = await readPdfFunction(reader, value);
      expect(first).not.toBe(second); expect(first.functions[0]).not.toBe(second.functions[0]);
    });
    const functions = [source, source].map(compilePdfFunction);
    expect(compilePdfFunction).toHaveLength(1); expect(functions[0]).not.toBe(functions[1]);
    expect(functions.map(fn => fn([.3125]))).toEqual([[.25], [.25]]);
  });

  it('rejects cycles after an earlier sibling has populated the completed-node cache', async () => {
    const root = stitching([exponential()]); root.functions.push(root); root.bounds = [.5]; root.encode = [0, 1, 0, 1];
    await expect(read(root)).rejects.toMatchObject({ code: 'pdf_corrupt', message: 'Cyclic PDF function.' });
    expect(() => compilePdfFunction(root)).toThrow(/Cyclic PDF function/);
  });

  it('retains the depth16 boundary when a completed subtree is reached by a deeper path', async () => {
    const shared = wrap(exponential(), 7);
    const allowed = stitching([shared, wrap(shared, 8)]), rejected = stitching([shared, wrap(shared, 9)]);
    expect(compilePdfFunction(await read(allowed))([.25])).toEqual([.5]);
    await expect(read(rejected)).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF function nesting limit exceeded.' });
    expect(() => compilePdfFunction(rejected)).toThrow(/nesting limit/);
  });

  it('bounds total visits including repeated references at16384, independently of distinct nodes', async () => {
    const allowed = visitGraph(false), rejected = visitGraph(true);
    expect(compilePdfFunction(await read(allowed))([0])).toEqual([0]);
    await expect(read(rejected)).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF function visit budget limit exceeded.' });
    expect(() => compilePdfFunction(rejected)).toThrow(/visit budget/);
  });

  it('bounds distinct nodes at4096 even when total visits and depth are below their limits', async () => {
    const allowed = nodeGraph(false), rejected = nodeGraph(true);
    expect(compilePdfFunction(await read(allowed))([0])).toEqual([0]);
    await expect(read(rejected)).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF function node budget limit exceeded.' });
    expect(() => compilePdfFunction(rejected)).toThrow(/node budget/);
  });

  it('counts shared sampled data once and expands its Uint32 values once', async () => {
    const leaf = sampled(1_000_000), descriptor = await read(wrap(leaf, 2, 8));
    const shared = descriptor.functions[0].functions[0]; let reads = 0;
    Object.defineProperty(shared, 'size', { get: () => { if (++reads > 1) throw Error('duplicate sample expansion'); return leaf.size; } });
    expect(compilePdfFunction(descriptor)([.25])).toEqual([0]); expect(reads).toBe(1);
  });

  it('retains the four-million-value individual and aggregate sample limits before allocation', async () => {
    const allowed = stitching([sampled(2_000_000), sampled(2_000_000)]);
    expect(compilePdfFunction(await read(allowed))([.25])).toEqual([0]);
    for (const rejected of [sampled(4_000_001), stitching([sampled(2_000_000), sampled(2_000_001)])]) {
      await expect(read(rejected)).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF function sample budget limit exceeded.' });
      expect(() => compilePdfFunction(rejected)).toThrow(/sample budget/);
    }
  });

  it('bounds aggregate calculator source at1MiB before parsing or compiling an additional program', async () => {
    const program = `{%${'x'.repeat(65536 - 4)}\n}`;
    const calculator = source => ({ type: 4, domain: [0, 1], range: [0, 1], inputs: 1, outputs: 1, program: source });
    const allowed = stitching(Array.from({ length: 16 }, () => calculator(program)));
    expect(compilePdfFunction(await read(allowed))([0])).toEqual([0]);
    // Distinct functions consume separate retained code even when their source strings are equal.
    const rejected = stitching([...allowed.functions, calculator('xx')]);
    await expect(read(rejected)).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF function calculator byte budget limit exceeded.' });
    expect(() => compilePdfFunction(rejected)).toThrow(/calculator byte budget/);
    // The existing individual64KiB limit still applies below the aggregate cap.
    const oversized = calculator(`{%${'x'.repeat(65537 - 4)}\n}`);
    await expect(read(oversized)).rejects.toMatchObject({ code: 'pdf_limit', message: 'PDF calculator program byte limit exceeded.' });
    expect(() => compilePdfFunction(oversized)).toThrow(/calculator program byte limit/);
    const shared = calculator(program), aliases = await read(stitching(Array(32).fill(shared)));
    let compiled = 0;
    Object.defineProperty(aliases.functions[0], 'program', { get: () => { compiled++; return program; } });
    expect(compilePdfFunction(aliases)([0])).toEqual([0]); expect(compiled).toBe(1);
  });

  it('collects shared sampled buffers once across commands, DeviceN tints and nested groups without expanding DAGs or cycles', () => {
    const leaf = sampled(16), root = wrap(leaf, 6, 8), other = sampled(24), cycle = stitching([other]);
    cycle.functions.push(cycle); // Transfer traversal is defensive; the parser still rejects this cycle.
    let visits = 0;
    const nodes = new Set([other, cycle]); let node = root;
    for (let i = 0; i <= 6; i++) { nodes.add(node); node = node.functions?.[0]; }
    for (const fn of nodes) {
      const samples = fn.samples;
      Object.defineProperty(fn, 'samples', { get: () => { if (++visits > 1000) throw Error('bounded transfer observer'); return samples; } });
    }
    const profile = new Uint8Array(3), alternate = new Uint8Array(5), pixels = new Uint8Array(4);
    const payload = { fonts: [{ bytes: leaf.samples.subarray(0, 1) }], commands: [
      { functions: [root, root], colorSpace: { tintTransform: root, profileBytes: profile, alternate: { profileBytes: alternate } } },
      { functions: [other], commands: [{ pixels, functions: [cycle, root], outputProfile: profile }] },
    ] };
    const expected = new Set([leaf.samples.buffer, other.samples.buffer, profile.buffer, alternate.buffer, pixels.buffer]);
    visits = 0;
    expect(new Set(pdfPayloadBuffers(payload))).toEqual(expected); expect(visits).toBe(9);
    visits = 0;
    expect(pdfPayloadByteLength(payload)).toBe(17); expect(visits).toBe(9);
  });

  it('shares the existing calculator cumulative execution budget across stitching aliases', () => {
    const program = `{pop ${'0 '.repeat(254)}${'254 0 roll '.repeat(385)}${'pop '.repeat(253)}}`;
    const leaf = { type: 4, domain: [0, 1], range: [0, 1], inputs: 1, outputs: 1, program };
    const run = compilePdfFunction(stitching([leaf, leaf]));
    // Each call costs99453 existing calculator steps; aliases share its100M lifetime budget.
    for (let i = 0; i < 1005; i++) expect(run([i % 2])).toEqual([0]);
    expect(() => run([1])).toThrow(/execution step.*limit/);
    expect(compilePdfFunction(leaf)([1])).toEqual([0]);
  });
});
