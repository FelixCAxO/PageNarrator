import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WasmKokoroCompute } from '../../src/engines/kokoro-cpu-compute.js';
import { kokoroRecurrentFixture } from '../helpers/kokoro-recurrent-fixture.js';

const controls = JSON.parse(readFileSync('tests/fixtures/kokoro-recurrent-exact.json', 'utf8'));
const hash = values => createHash('sha256').update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)).digest('hex');

describe.each(['serial', 'shared'])('%s recurrent engine', mode => {
  async function createEngine() {
    if (mode === 'serial') return WasmKokoroCompute.create(readFileSync('extension/public/native/kokoro-engine.wasm'));
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
    const { instance } = await WebAssembly.instantiate(readFileSync('extension/public/native/kokoro-parallel.wasm'), { env: { memory } });
    return new WasmKokoroCompute(instance.exports, 536870912);
  }

  it('preserves initial states for an empty sequence', async () => {
    const engine = await createEngine();
    try {
      const fixture = kokoroRecurrentFixture({ steps: 0, hidden: 13 });
      const inputs = fixture.specs.map(([data, shape, type]) => engine.upload(data, shape, type));
      const batch = engine.batch(), outputs = engine.kokoro.dynamicQuantizeLstm(batch, ...inputs, fixture.options);
      batch.submit();
      expect(await engine.read(outputs[0])).toHaveLength(0);
      expect(await engine.read(outputs[1])).toEqual(fixture.specs[4][0]);
      expect(await engine.read(outputs[2])).toEqual(fixture.specs[5][0]);
    } finally { await engine.dispose(); }
  });

  it('refuses a projection beyond the int32 accumulation bound', async () => {
    const engine = await createEngine();
    try {
      const fixture = kokoroRecurrentFixture({ hidden: 1, features: 33026, steps: 1, batch: 1, direction: 'forward' });
      const inputs = fixture.specs.map(([data, shape, type]) => engine.upload(data, shape, type)), batch = engine.batch();
      expect(() => engine.kokoro.dynamicQuantizeLstm(batch, ...inputs, fixture.options)).toThrow(/overflow/);
      batch.cancel();
    } finally { await engine.dispose(); }
  });

  it.each([false, true])('cancels extreme weight zero points at the int32 feature bound (signed=%s)', async signed => {
    const engine = await createEngine();
    try {
      const fixture = kokoroRecurrentFixture({ hidden: 1, features: 33025, steps: 1, batch: 1, direction: 'forward', channels: false, wSigned: signed });
      fixture.specs[0][0].fill(1);
      fixture.specs[1][0].fill(signed ? -128 : 255);
      fixture.specs[7][0].fill(signed ? -128 : 255);
      for (const i of [3, 4, 5]) fixture.specs[i][0].fill(0);
      const inputs = fixture.specs.map(([data, shape, type]) => engine.upload(data, shape, type));
      const batch = engine.batch(), outputs = engine.kokoro.dynamicQuantizeLstm(batch, ...inputs, fixture.options);
      batch.submit();
      for (const output of outputs) expect([...await engine.read(output)]).toEqual([0]);
    } finally { await engine.dispose(); }
  });

  it.each([0, 4, 6, 8])('rejects non-finite recurrent data or scales in operand %i', async index => {
    const engine = await createEngine();
    try {
      const fixture = kokoroRecurrentFixture({ hidden: 13 });
      fixture.specs[index][0][fixture.specs[index][0].length - 1] = NaN;
      const inputs = fixture.specs.map(([data, shape, type]) => engine.upload(data, shape, type));
      const batch = engine.batch(); engine.kokoro.dynamicQuantizeLstm(batch, ...inputs, fixture.options);
      expect(() => batch.submit()).toThrow(/nonfinite|invalid/);
    } finally { await engine.dispose(); }
  });

  it.each(controls.cases)('retains exact recurrent output/state and replay for $config', async ({ config, sha256 }) => {
    const engine = await createEngine();
    try {
      const fixture = kokoroRecurrentFixture(config), inputs = fixture.specs.map(([data, shape, type]) => engine.upload(data, shape, type));
      const batch = engine.batch({ capture: true });
      const outputs = engine.kokoro.dynamicQuantizeLstm(batch, ...inputs, fixture.options);
      batch.submit();
      for (let repeat = 0; repeat < 2; repeat++) {
        if (repeat) batch.replay();
        for (let i = 0; i < outputs.length; i++) expect(hash(await engine.read(outputs[i]))).toBe(sha256[i]);
        expect(await engine.read(inputs[4])).toEqual(fixture.specs[4][0]);
        expect(await engine.read(inputs[5])).toEqual(fixture.specs[5][0]);
      }
    } finally { await engine.dispose(); expect(engine.buffers.size).toBe(0); expect(engine.tensors.size).toBe(0); }
  });
});
