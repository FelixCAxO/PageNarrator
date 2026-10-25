"""Generate original JPEG2000 test images with the independent Pillow/OpenJPEG oracle."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import base64
import hashlib
import io
import json
from pathlib import Path
import struct
from PIL import Image, features

root = Path(__file__).resolve().parent.parent
cases = []
for name, mode, width, height, value, mct, container, levels, *packet_options in [
    ("neutral", "L", 8, 8, lambda i: 128, 0, False, 0),
    ("black", "L", 8, 8, lambda i: 0, 0, False, 0),
    ("white", "L", 8, 8, lambda i: 255, 0, False, 0),
    ("gray-edges", "L", 9, 7, lambda i: i * 73 % 256, 0, False, 0),
    ("gray-many-blocks", "L", 61, 35, lambda i: (i * 73 + i // 61 * 17) % 256, 0, True, 0),
    ("rgb", "RGB", 9, 7, lambda i: (i * 29 + i // 3 * 7) % 256, 0, True, 0),
    ("rgb-rct", "RGB", 9, 7, lambda i: (i * 29 + i // 3 * 7) % 256, 1, True, 0),
    ("gray16", "I;16", 9, 7, lambda i: (i * 3127) % 65536, 0, True, 0),
    ("gray-wavelet1", "L", 17, 13, lambda i: (i * 73 + i // 17 * 17) % 256, 0, True, 1),
    ("gray-wavelet2", "L", 17, 13, lambda i: (i * 73 + i // 17 * 17) % 256, 0, True, 2),
    ("gray-wavelet3", "L", 17, 13, lambda i: (i * 73 + i // 17 * 17) % 256, 0, True, 3),
    ("rgb-wavelet3", "RGB", 35, 19, lambda i: (i * 29 + i // 3 * 7) % 256, 1, True, 3),
    ("gray16-wavelet2", "I;16", 17, 13, lambda i: (i * 3127) % 65536, 0, True, 2),
    ("gray-layers", "L", 35, 19, lambda i: (i * 73 + i // 35 * 17) % 256, 0, True, 2, "LRCP", [8, 4, 1]),
    ("rgb-layers", "RGB", 35, 19, lambda i: (i * 29 + i // 3 * 7) % 256, 1, True, 3, "LRCP", [8, 4, 1]),
    ("rgb-resolution-layers", "RGB", 35, 19, lambda i: (i * 29 + i // 3 * 7) % 256, 1, True, 3, "RLCP", [8, 4, 1]),
    ("gray-tiled", "L", 61, 35, lambda i: (i * 73 + i // 61 * 17) % 256, 0, True, 2, "LRCP", [8, 4, 1], (16, 16)),
    ("rgb-tiled", "RGB", 49, 35, lambda i: (i * 29 + i // 3 * 7) % 256, 1, True, 3, "RLCP", [8, 4, 1], (16, 16)),
    # Pillow's 16-bit encoder misaddresses horizontally offset tile inputs;
    # this vertical grid retains the required exact source/oracle round trip.
    ("gray16-tiled", "I;16", 8, 19, lambda i: (i * 3127) % 65536, 0, True, 2, "LRCP", [0], (8, 8)),
] + [(f"rgb-precinct-{progression.lower()}", "RGB", 61, 35, lambda i: (i * 29 + i // 3 * 7) % 256, 1, True, 2,
      progression, [8, 4, 1], None, (16, 16)) for progression in ["LRCP", "RLCP", "RPCL", "PCRL", "CPRL"]] + [
    ("rgb-tiled-precinct", "RGB", 49, 35, lambda i: (i * 29 + i // 3 * 7) % 256, 1, True, 2, "PCRL", [8, 4, 1], (16, 16), (8, 8)),
]:
    channels = 3 if mode == "RGB" else 1
    values = [value(i) for i in range(width * height * channels)]
    source = bytes(values) if mode != "I;16" else struct.pack("<" + "H" * len(values), *values)
    image = Image.frombytes(mode, (width, height), source)
    output = io.BytesIO()
    progression, layers, *tiles = packet_options if packet_options else ("LRCP", [1])
    extra = {"tile_size": tiles[0]} if tiles and tiles[0] else {}
    if len(tiles) > 1:
        extra["precinct_size"] = tiles[1]
    image.save(output, format="JPEG2000", no_jp2=not container, num_resolutions=levels + 1,
               irreversible=False, codeblock_size=(4, 4), mct=mct, progression=progression, quality_layers=layers, **extra)
    encoded = output.getvalue()
    decoded = Image.open(io.BytesIO(encoded))
    actual = list(decoded.get_flattened_data())
    expected = values if channels == 1 else [tuple(values[i:i + 3]) for i in range(0, len(values), 3)]
    if actual != expected:
        raise RuntimeError(f"Independent lossless fixture did not round trip: {name}")
    raw = bytes(values) if mode != "I;16" else struct.pack(">" + "H" * len(values), *values)
    cases.append({"id": name, "width": width, "height": height, "components": channels, "waveletLevels": levels, "progression": progression, "layers": layers,
                  "tileSize": tiles[0] if tiles else None, "precinctSize": tiles[1] if len(tiles) > 1 else None, "bits": 16 if mode == "I;16" else 8, "encoded": base64.b64encode(encoded).decode(),
                  "encodedSha256": hashlib.sha256(encoded).hexdigest(),
                  "expected": base64.b64encode(raw).decode(), "expectedSha256": hashlib.sha256(raw).hexdigest()})
path = root / "tests/fixtures/jpx-lossless.json"
path.write_text(json.dumps({"provenance": "Original deterministic pixels encoded and independently decoded by Pillow/OpenJPEG; reversible wavelets, all5 progressions, optional multiple tiles/precincts/layers. No upstream executable included.",
                            "pillowVersion": Image.__version__, "openJpegVersion": features.version("jpg_2000"), "cases": cases}, indent=2) + "\n", encoding="utf-8")
print(path, len(cases))

# JP2 boxes are original format fixtures; independent OpenJPEG executes the
# palette/channel definitions and verifies the expected RGB/RGBA pixels.
def box(kind, payload):
    return struct.pack(">I", len(payload) + 8) + kind.encode("ascii") + payload


cases = []
for alpha in [False, True]:
    width, height = 9, 7
    indices = bytes(i % 4 for i in range(width * height))
    palette = [(12, 56, 244, 255), (255, 0, 19, 128), (0, 185, 37, 0), (255, 255, 255, 64)]
    channels = 4 if alpha else 3
    encoded = io.BytesIO()
    Image.frombytes("L", (width, height), indices).save(encoded, format="JPEG2000", no_jp2=True, num_resolutions=1, irreversible=False, codeblock_size=(4, 4))
    ihdr = struct.pack(">IIHBBBB", height, width, 1, 7, 7, 0, 0)
    pclr = struct.pack(">HB", len(palette), channels) + bytes([7] * channels) + bytes(value for color in palette for value in color[:channels])
    cmap = b"".join(struct.pack(">HBB", 0, 1, channel) for channel in range(channels))
    cdef = struct.pack(">H", channels) + b"".join(struct.pack(">HHH", channel, 0 if channel < 3 else 1, channel + 1 if channel < 3 else 0) for channel in range(channels))
    header = box("ihdr", ihdr) + box("colr", bytes([1, 0, 0]) + struct.pack(">I", 16)) + box("pclr", pclr) + box("cmap", cmap) + box("cdef", cdef)
    data = box("jP  ", b"\r\n\x87\n") + box("ftyp", b"jp2 \0\0\0\0jp2 ") + box("jp2h", header) + box("jp2c", encoded.getvalue())
    decoded = Image.open(io.BytesIO(data)).convert("RGBA" if alpha else "RGB")
    raw = bytes(value for color in decoded.get_flattened_data() for value in color)
    expected = bytes(value for index in indices for value in palette[index][:channels])
    if raw != expected:
        raise RuntimeError(f"Independent palette fixture mismatch: {alpha}, {decoded.mode}")
    cases.append({"id": "palette-alpha" if alpha else "palette-rgb", "width": width, "height": height, "components": channels, "bits": 8,
                  "encoded": base64.b64encode(data).decode(), "encodedSha256": hashlib.sha256(data).hexdigest(),
                  "expected": base64.b64encode(raw).decode(), "expectedSha256": hashlib.sha256(raw).hexdigest()})

for mode, premultiplied in [("LA", False), ("RGBA", False), ("RGBA", True)]:
    width, height, channels = 9, 7, len(mode)
    pixels = []
    for i in range(width * height):
        alpha = [0, 64, 128, 255][i % 4]
        color = [(i * 73 + channel * 61) % 256 for channel in range(channels - 1)]
        if premultiplied:
            color = [round(value * alpha / 255) for value in color]
        pixels.extend(color + [alpha])
    encoded = io.BytesIO()
    Image.frombytes(mode, (width, height), bytes(pixels)).save(encoded, format="JPEG2000", num_resolutions=2, irreversible=False, codeblock_size=(4, 4))
    data = bytearray(encoded.getvalue())
    at = data.index(b"cdef") + 4
    for entry in range(struct.unpack_from(">H", data, at)[0]):
        offset = at + 2 + entry * 6
        channel, kind, association = struct.unpack_from(">HHH", data, offset)
        if channel == channels - 1 and premultiplied:
            struct.pack_into(">HHH", data, offset, channel, 2, association)
    raw = Image.open(io.BytesIO(data)).tobytes()
    if raw != bytes(pixels):
        raise RuntimeError(f"Independent direct-alpha fixture mismatch: {mode}, {premultiplied}")
    cases.append({"id": f"direct-{mode.lower()}" + ("-premultiplied" if premultiplied else ""), "width": width, "height": height, "components": channels, "bits": 8,
                  "encoded": base64.b64encode(data).decode(), "encodedSha256": hashlib.sha256(data).hexdigest(),
                  "expected": base64.b64encode(raw).decode(), "expectedSha256": hashlib.sha256(raw).hexdigest()})
path = root / "tests/fixtures/jpx-channel-mapping.json"
path.write_text(json.dumps({"provenance": "Original JP2 palette/channel/alpha boxes enclosing independently OpenJPEG-encoded grayscale indices; expected RGB/RGBA independently decoded by Pillow/OpenJPEG.",
                            "pillowVersion": Image.__version__, "openJpegVersion": features.version("jpg_2000"), "cases": cases}, indent=2) + "\n", encoding="utf-8")
print(path, len(cases))

cases = []
for name, mode, width, height, mct, levels, layers, *tiles in [
    ("gray-neutral", "L", 17, 13, 0, 2, [1]),
    ("gray-no-wavelet", "L", 17, 13, 0, 0, [1]),
    ("gray-wavelet3", "L", 35, 19, 0, 3, [1]),
    ("gray-layers", "L", 35, 19, 0, 3, [16, 8, 2]),
    ("rgb-wavelet3", "RGB", 35, 19, 0, 3, [1]),
    ("rgb-ict", "RGB", 35, 19, 1, 3, [1]),
    ("rgb-ict-layers", "RGB", 35, 19, 1, 3, [16, 8, 2]),
    ("gray16-wavelet2", "I;16", 17, 13, 0, 2, [1]),
    ("rgb-ict-tiled", "RGB", 49, 35, 1, 3, [8, 4, 1], (16, 16)),
]:
    channels = 3 if mode == "RGB" else 1
    maximum = 65536 if mode == "I;16" else 256
    values = [128 if name == "gray-neutral" else (i * 73 + i // width * 17) % maximum for i in range(width * height * channels)]
    source = bytes(values) if mode != "I;16" else struct.pack("<" + "H" * len(values), *values)
    image = Image.frombytes(mode, (width, height), source)
    output = io.BytesIO()
    extra = {"tile_size": tiles[0]} if tiles else {}
    image.save(output, format="JPEG2000", num_resolutions=levels + 1, irreversible=True, codeblock_size=(4, 4), mct=mct, quality_layers=layers, **extra)
    encoded = output.getvalue()
    decoded = Image.open(io.BytesIO(encoded))
    expected = list(decoded.get_flattened_data())
    if channels == 3:
        expected = [value for pixel in expected for value in pixel]
    raw = bytes(expected) if mode != "I;16" else struct.pack(">" + "H" * len(expected), *expected)
    cases.append({"id": name, "width": width, "height": height, "components": channels, "bits": 16 if mode == "I;16" else 8,
                  "encoded": base64.b64encode(encoded).decode(), "encodedSha256": hashlib.sha256(encoded).hexdigest(),
                  "expected": base64.b64encode(raw).decode(), "expectedSha256": hashlib.sha256(raw).hexdigest(), "maxSampleError": 1})
path = root / "tests/fixtures/jpx-irreversible.json"
path.write_text(json.dumps({"provenance": "Original deterministic pixels independently encoded and decoded by Pillow/OpenJPEG; irreversible 9/7, scalar quantization, optional ICT, one or multiple layers. Fixed one-sample-level reconstruction tolerance.",
                            "pillowVersion": Image.__version__, "openJpegVersion": features.version("jpg_2000"), "cases": cases}, indent=2) + "\n", encoding="utf-8")
print(path, len(cases))
