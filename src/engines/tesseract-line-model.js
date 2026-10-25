// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { WasmTesseractCompute } from './tesseract-line-compute.js';

const SOURCE_HASH = 'daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047';
const SPEC = '[1,36,0,1Ct3,3,16Mp3,3Lfys64Lfx96Lrx96Lfx512O1c1]';

/** A fixed retained English line network, using the common native arena and command batch. */
export class TesseractLineModel {
  static async create(manifest, bytes, wasm, { engine: sharedEngine = null, maxBytes } = {}) {
    if (manifest?.schema !== 'pagenarrator-english-lstm-v1' || manifest.source?.sha256 !== SOURCE_HASH
      || manifest.spec !== SPEC || manifest.blank !== 110 || manifest.alphabet?.length !== 111
      || !(bytes instanceof Uint8Array) || bytes.byteLength !== manifest.weights?.bytes) throw new Error('Invalid retained English LSTM data manifest.');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== manifest.weights.sha256) throw new Error('Retained English learned weights are corrupt.');
    const engine = sharedEngine || await WasmTesseractCompute.create(wasm, maxBytes === undefined ? {} : { maxBytes });
    if (!(engine instanceof WasmTesseractCompute)) throw new Error('English LSTM requires the original compatible arena.');
    const retained = new Set(engine.tensors);
    try { const model = new TesseractLineModel(engine, manifest, bytes); model.ownsEngine = !sharedEngine; return model; }
    catch (error) {
      if (!sharedEngine) await engine.dispose();
      else await engine.releaseMany([...engine.tensors].filter(tensor => !retained.has(tensor)));
      throw error;
    }
  }

  constructor(engine, manifest, bytes) {
    this.engine = engine; this.manifest = manifest; this.weights = []; this.closed = false; this.plan = null;
    if (!Number.isInteger(manifest.sampleIteration) || manifest.sampleIteration < 0 || manifest.sampleIteration > 0x7fffffff) throw new Error('Invalid English LSTM noise metadata.');
    // The trained network specifies the repeatable boundary-noise sequence.
    this.defaultSeed = BigInt.asUintN(64, BigInt(manifest.sampleIteration) * 0x10000001n * 6364136223846793005n + 1442695040888963407n);
    const children = manifest.network?.children;
    if (!children || children.length !== 8 || children.map(node => node.type).join(',') !== 'Input,Series,Maxpool,XYTranspose,LSTM,RTLReversed,LSTM,Softmax') throw new Error('English LSTM topology differs from the retained model.');
    const read = (descriptor, type, count) => {
      if (descriptor?.type !== type || !Number.isInteger(descriptor.offset) || descriptor.offset < 0 || descriptor.offset % 16
        || descriptor.bytes !== count * (type === 'float32' ? 4 : 1) || descriptor.offset + descriptor.bytes > bytes.length) throw new Error('Invalid retained English weight range.');
      const view = new DataView(bytes.buffer, bytes.byteOffset + descriptor.offset, descriptor.bytes);
      if (type === 'int8') return new Int8Array(bytes.buffer, bytes.byteOffset + descriptor.offset, descriptor.bytes);
      const result = Float32Array.from({ length: count }, (_, i) => view.getFloat32(i * 4, true));
      if (result.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid retained English quantization scale.');
      return result;
    };
    const upload = (matrices, rows, columns) => {
      if (matrices.some(matrix => matrix?.rows !== rows || matrix.columns !== columns)) throw new Error('Retained English matrix dimensions differ.');
      const weights = new Int8Array(rows * columns * matrices.length), scales = new Float32Array(rows * matrices.length);
      matrices.forEach((matrix, i) => { weights.set(read(matrix.weights, 'int8', rows * columns), i * rows * columns); scales.set(read(matrix.scales, 'float32', rows), i * rows); });
      const result = { weights: engine.upload(weights, [matrices.length, rows, columns], 'int8'), scales: engine.upload(scales, [matrices.length, rows]) };
      this.weights.push(result.weights, result.scales); return result;
    };
    this.conv = upload([children[1].children?.[1]?.matrix], 16, 10);
    this.vertical = upload(children[3].children?.[0]?.gates || [], 64, 81);
    this.forward = upload(children[4].gates || [], 96, 161);
    this.reverse = upload(children[5].children?.[0]?.gates || [], 96, 193);
    this.final = upload(children[6].gates || [], 512, 609);
    this.output = upload([children[7].matrix], 111, 513);
    for (const layer of [this.vertical, this.forward, this.reverse, this.final]) if (layer.scales.shape[0] !== 4) throw new Error('English LSTM requires exactly four gates.');
  }

  async clearPlan() {
    if (!this.plan) return;
    const plan = this.plan; this.plan = null;
    await this.engine.releaseMany([plan.input, ...plan.batch.outputs], plan.batch.scratchBuffers());
  }

  async runPixels(data, width, { seed = this.defaultSeed } = {}) {
    if (this.closed || this.running) throw new Error('English LSTM is closed or already recognizing.');
    if (!(data instanceof Int8Array) || data.length !== 36 * width || !Number.isInteger(width) || width < 3 || width > 8192
      || data.some(value => value === -128)
      || (typeof seed !== 'bigint' && !Number.isSafeInteger(seed)) || seed < 0 || seed > 0xffffffffffffffffn) throw new RangeError('Invalid normalized English LSTM input.');
    this.running = this.infer(data, width, BigInt(seed));
    try { return await this.running; }
    catch (error) { await this.clearPlan(); throw error; }
    finally { this.running = null; }
  }

  async infer(data, width, seed) {
    if (this.plan?.width !== width) {
      await this.clearPlan();
      const input = this.engine.upload(data, [36, width, 1], 'int8'), batch = this.engine.batch({ capture: true });
      try {
        const apply = (previous, next) => { batch.recycle(previous); return next; };
        let value = batch.convTanh(input, this.conv.weights, this.conv.scales);
        value = apply(value, batch.bytePool(value));
        value = apply(value, batch.recurrent(value, this.vertical.weights, this.vertical.scales, 64, { vertical: true, summary: true }));
        value = apply(value, batch.recurrent(value, this.forward.weights, this.forward.scales, 96));
        value = apply(value, batch.recurrent(value, this.reverse.weights, this.reverse.scales, 96, { reverse: true }));
        value = apply(value, batch.recurrent(value, this.final.weights, this.final.scales, 512));
        value = apply(value, batch.affine(value, this.output.weights, this.output.scales, 111));
        const output = batch.softmax(value); batch.recycle(value);
        this.plan = { width, input, batch, output };
      } catch (error) {
        batch.cancel(); await this.engine.releaseMany([input, ...batch.outputs], batch.scratchBuffers()); throw error;
      }
    } else this.engine.write(this.plan.input, data);
    this.engine.exports.pn_tess_seed(Number(seed & 0xffffffffn), Number(seed >> 32n));
    if (this.plan.batch.submitted) this.plan.batch.replay(); else this.plan.batch.submit();
    return { data: await this.engine.read(this.plan.output), dims: this.plan.output.shape };
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    try { await this.running?.catch(() => null); await this.clearPlan(); await this.engine.releaseMany(this.weights); }
    finally { if (this.ownsEngine !== false) await this.engine.dispose(); }
  }
}
