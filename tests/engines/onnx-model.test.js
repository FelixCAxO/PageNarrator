import { describe, expect, it } from 'vitest';
import { decodeOnnxModel, summarizeOnnxModel } from '../../src/engines/onnx-model.js';

// Independently hand-encoded ONNX ModelProto: IR 8, graph g, Relu(x)->y, opset 17.
const RELU_MODEL = Uint8Array.from([
  0x08, 0x08, 0x3a, 0x11, 0x0a, 0x0c, 0x0a, 0x01, 0x78, 0x12, 0x01, 0x79,
  0x22, 0x04, 0x52, 0x65, 0x6c, 0x75, 0x12, 0x01, 0x67, 0x42, 0x02, 0x10, 0x11,
]);

describe('first-party ONNX wire reader', () => {
  it('decodes a standard graph and its operator version', () => {
    const model = decodeOnnxModel(RELU_MODEL);
    expect(model.irVersion).toBe(8);
    expect(model.graph.name).toBe('g');
    expect(model.opsets).toEqual([{ domain: '', version: 17 }]);
    expect(model.graph.nodes[0]).toMatchObject({ opType: 'Relu', inputs: ['x'], outputs: ['y'] });
    expect(summarizeOnnxModel(model)).toMatchObject({ nodes: 1, graphs: 1, operators: { Relu: 1 } });
  });

  it('respects a view offset instead of reading adjacent bytes', () => {
    const buffer = new Uint8Array(RELU_MODEL.length + 8).fill(0xff);
    buffer.set(RELU_MODEL, 3);
    expect(decodeOnnxModel(buffer.subarray(3, 3 + RELU_MODEL.length)).graph.name).toBe('g');
  });

  it('retains tensor data in the original model buffer', () => {
    // graph.initializer: dims=[1], float32, name=w, raw_data=1.0f.
    const data = Uint8Array.from([0x3a, 0x0f, 0x2a, 0x0d, 0x08, 0x01, 0x10, 0x01, 0x42, 0x01, 0x77, 0x4a, 0x04, 0x00, 0x00, 0x80, 0x3f]);
    const tensor = decodeOnnxModel(data).graph.initializers[0];
    expect(tensor).toMatchObject({ name: 'w', dataType: 1, dims: [1] });
    expect(tensor.rawData.buffer).toBe(data.buffer);
    expect(new DataView(tensor.rawData.buffer).getFloat32(tensor.rawData.byteOffset, true)).toBe(1);
  });

  it.each([
    [[], 'main graph is missing'],
    [[0], 'field zero'],
    [[0x3a, 0x80], 'truncated varint'],
    [[0x3a, 0x7f, 0], 'past its message'],
    [[0x0b], 'wire type'],
    [[0x0d, 0x01], 'truncated fixed-width'],
    [[0x08, ...Array(10).fill(0xff)], 'exceeds 64 bits'],
    [[0x3a, 0x00, 0x3a, 0x00], 'duplicate main graph'],
    [[0x3a, 0x02, 0x0a, 0x00], 'node has no operator'],
  ])('rejects invalid message %j', (data, message) => {
    expect(() => decodeOnnxModel(Uint8Array.from(data))).toThrow(message);
  });

  it('bounds metadata work independently of weight payload size', () => {
    expect(() => decodeOnnxModel(RELU_MODEL, { fields: 2 })).toThrow('field limit');
    expect(() => decodeOnnxModel(RELU_MODEL, { stringBytes: 2 })).toThrow('metadata string');
    expect(() => decodeOnnxModel(RELU_MODEL, { fields: Infinity })).toThrow('Invalid ONNX fields limit');
    expect(() => decodeOnnxModel('model')).toThrow(TypeError);
  });
});
