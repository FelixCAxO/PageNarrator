// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
export interface OnnxTensor {
  name: string;
  dataType: number;
  dims: number[];
  rawData: Uint8Array<ArrayBuffer> | null;
  typedData: Map<number, unknown[]>;
  externalData: Map<string, string>;
  dataLocation: number;
}
export interface OnnxValueInfo { name: string; dataType: number | null; dims: Array<number | string | null> | null }
export interface OnnxAttribute { name: string; type: number; value: any }
export interface OnnxNode { name: string; domain: string; opType: string; inputs: string[]; outputs: string[]; attributes: Map<string, OnnxAttribute> }
export interface OnnxGraph { name: string; nodes: OnnxNode[]; initializers: OnnxTensor[]; inputs: OnnxValueInfo[]; outputs: OnnxValueInfo[]; values: OnnxValueInfo[] }
export interface OnnxOpset { domain: string; version: number | bigint | null }
export interface OnnxFunction { name: string; domain: string; nodes: OnnxNode[]; inputs: string[]; outputs: string[]; opsets: OnnxOpset[]; attributes: OnnxAttribute[] }
export interface OnnxModel { irVersion: number | null; producer: string; opsets: OnnxOpset[]; graph: OnnxGraph; functions: OnnxFunction[] }
export function decodeOnnxModel(_input: ArrayBuffer | ArrayBufferView, _limits?: Record<string, number>): OnnxModel;
export function summarizeOnnxModel(_model: OnnxModel): {
  irVersion: number | null; opsets: OnnxOpset[]; inputs: OnnxValueInfo[]; outputs: OnnxValueInfo[];
  graphs: number; nodes: number; tensors: number; embeddedWeightBytes: number; externalFiles: string[]; functions: number; operators: Record<string, number>;
};
