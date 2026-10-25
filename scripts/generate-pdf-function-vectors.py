"""Development oracle: exact Fraction tensor interpolation, then IEEE Decode/Range.

Inputs/encoding knots are binary rationals, so all corner sums are exact in
binary64 before the independently rounded Decode. No product code is imported.
"""
import base64
from fractions import Fraction as F
import json
from pathlib import Path
import struct


def case(dimensions, size, channels, bits, identifier):
    domain = [-2, 2] * dimensions
    if identifier % 11 == 0:
        domain[:2] = [1, 1]
    encode = []
    for count in size:
        encode += [count, -1] if identifier % 2 else [0, count - 1]
    decode = [number for channel in range(channels) for number in ([2, -1] if (identifier + channel) % 3 == 0 else [-1, 2])]
    bounds = [-0.75, 1.25] * channels
    total = channels
    for count in size:
        total *= count
    maximum = (1 << bits) - 1
    values, state = [], 0xA17E + identifier
    for _ in range(total):
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        values.append(state & maximum)
    binary = ''.join(format(value, f'0{bits}b') for value in values)
    binary += '0' * (-len(binary) % 8)
    packed = bytes(int(binary[at:at + 8], 2) for at in range(0, len(binary), 8))
    descriptor = dict(type=0, inputs=dimensions, outputs=channels, domain=domain,
                      range=bounds, size=size, bits=bits, encode=encode, decode=decode,
                      samplesBase64=base64.b64encode(packed).decode('ascii'))
    vectors = []
    for step in range(-4, 21):
        source = [F(-2) + 4 * F(((step + axis * 7 + 4) % 25) - 4, 16) for axis in range(dimensions)]
        coordinates, strides, stride = [], [], channels
        for axis, count in enumerate(size):
            low, high = map(F, domain[2 * axis:2 * axis + 2])
            value = min(high, max(low, source[axis]))
            position = F(encode[2 * axis]) + (F(0) if high == low else (value - low) / (high - low)) * (encode[2 * axis + 1] - encode[2 * axis])
            position = min(F(count - 1), max(F(0), position))
            coordinates.append(position); strides.append(stride); stride *= count
        exact = [F(0)] * channels
        for corner in range(1 << dimensions):
            address, weight = 0, F(1)
            for axis, position in enumerate(coordinates):
                lower = position.numerator // position.denominator
                upper = bool(corner & (1 << axis))
                weight *= position - lower if upper else 1 - (position - lower)
                address += min(size[axis] - 1, lower + upper) * strides[axis]
            for channel in range(channels):
                exact[channel] += values[address + channel] * weight
        decoded = []
        for channel, value in enumerate(exact):
            # Separate binary64 operations match the normative arithmetic order;
            # interpolation itself above uses independent exact rational sums.
            result = decode[2 * channel] + float(value) / maximum * (decode[2 * channel + 1] - decode[2 * channel])
            decoded.append(min(bounds[2 * channel + 1], max(bounds[2 * channel], result)))
        vectors.append(dict(input=list(map(float, source)), expected=decoded,
                            binary64=[struct.pack('<d', value).hex() for value in decoded]))
    return dict(id=identifier, descriptor=descriptor, vectors=vectors)


cases = []
for bits in [1, 2, 4, 8, 12, 16, 24, 32]:
    for size in [1, 2, 3, 17]:
        for channels in [1, 3, 4]:
            cases.append(case(1, [size], channels, bits, len(cases)))
for dimensions in [2, 3, 4]:
    for bits in [1, 8, 16, 32]:
        for channels in [1, 3]:
            cases.append(case(dimensions, [2] * dimensions, channels, bits, len(cases)))
cases.append(case(1, [1365], 3, 8, len(cases)))
result = dict(source='Original Python Fraction/IEEE oracle; ISO32000-1 sampled linear tensor interpolation.',
              cases=cases, caseCount=len(cases), vectorCount=sum(len(item['vectors']) for item in cases))
destination = Path(__file__).resolve().parents[1] / 'tests/fixtures/pdf-functions-independent.json'
destination.write_text(json.dumps(result, separators=(',', ':')) + '\n', encoding='utf-8')
print(json.dumps(dict(path=str(destination), cases=result['caseCount'], vectors=result['vectorCount'], bytes=destination.stat().st_size)))
