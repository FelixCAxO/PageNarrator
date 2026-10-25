"""Original fixture driver; upstream encoder/headers/DLL stay outside the repo."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import struct
from PIL import Image, features

directory = Path(os.environ["PN_OPENJPEG_ORACLE_DIR"])
dll = Path(os.environ["PN_OPENJPEG_ORACLE_DLL"])
root = Path(__file__).resolve().parent.parent
environment = dict(os.environ)
environment["PATH"] = str(dll.parent) + os.pathsep + environment["PATH"]
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
oracle = {"project": "uclouvain/openjpeg", "version": "2.5.4", "headerRevision": "6c4a29b00211eb0430fa0e5e890f1ce5c80f409f",
          "headerSha256": digest(directory / "openjpeg.h"), "driverSha256": digest(directory / "encode.c"),
          "executableSha256": digest(directory / "encode.exe"), "dllSha256": digest(dll),
          "decoderDriverSha256": digest(directory / "decode.c"), "decoderExecutableSha256": digest(directory / "decode.exe"),
          "decoder": f"Official OpenJPEG2.5.4 sample API; Pillow{Image.__version__}/OpenJPEG{features.version('jpg_2000')} where representable"}
cases = []
width, height = 61, 35
expected = bytes((i * 73 + i // width * 17) % 256 for i in range(width * height))
for mode in range(64):
    for flags in [0, 7]:
        output = directory / f"style-{mode}-packets-{flags}.jp2"
        subprocess.run([str(directory / "encode.exe"), str(mode), str(flags), "0", "0", "8", "0", str(output)], check=True, env=environment)
        encoded = output.read_bytes()
        actual = Image.open(io.BytesIO(encoded)).tobytes()
        if actual != expected:
            raise RuntimeError(f"Independent source round trip failed: mode{mode}/flags{flags}")
        cases.append({"id": f"style-{mode}-packets-{flags}", "width": width, "height": height, "components": 1, "bits": 8,
                      "codeBlockStyle": mode, "packetStyle": flags, "codeBlockSize": 32 if mode & 5 else 4,
                      "encoded": base64.b64encode(encoded).decode(), "encodedSha256": hashlib.sha256(encoded).hexdigest(),
                      "expected": base64.b64encode(expected).decode(), "expectedSha256": hashlib.sha256(expected).hexdigest()})
path = root / "tests/fixtures/jpx-coding-styles.json"
path.write_text(json.dumps({"provenance": "Original deterministic pixels encoded by external official OpenJPEG2.5.4 and independently decoded by Pillow/OpenJPEG; 3 lossless layers, all64 BYPASS/RESET/TERMALL/VSC/PTERM/SEGSYM combinations, optional precincts/SOP/EPH. No upstream code or executable included.",
                            "oracle": oracle, "cases": cases}, indent=2) + "\n", encoding="utf-8")
print(path, len(cases))

cases = []
for origin in [1, 2, 3, 5, 15]:
    for mode in [0, 63]:
        for flags in [0, 7]:
            output = directory / f"origin-{origin}-style-{mode}-packets-{flags}.jp2"
            subprocess.run([str(directory / "encode.exe"), str(mode), str(flags), "0", "0", "8", str(origin), str(output)], check=True, env=environment)
            encoded = output.read_bytes()
            actual = Image.open(io.BytesIO(encoded)).tobytes()
            if actual != expected:
                raise RuntimeError(f"Independent offset source round trip failed: {origin}/{mode}/{flags}")
            cases.append({"id": f"origin-{origin}-style-{mode}-packets-{flags}", "width": width, "height": height, "components": 1, "bits": 8,
                          "imageOrigin": [origin, origin], "encoded": base64.b64encode(encoded).decode(), "encodedSha256": hashlib.sha256(encoded).hexdigest(),
                          "expected": base64.b64encode(expected).decode(), "expectedSha256": hashlib.sha256(expected).hexdigest()})
path = root / "tests/fixtures/jpx-origins.json"
path.write_text(json.dumps({"provenance": "Original pixels independently encoded and decoded by official OpenJPEG/Pillow with even/odd image origins, globally anchored codeblocks/precincts and5/3wavelets, default or all coding-style flags.",
                            "oracle": oracle, "cases": cases}, indent=2) + "\n", encoding="utf-8")
print(path, len(cases))

cases = []
for mode in [0, 5, 16]:
    for order in ["L", "R", "C"]:
        output = directory / f"tileparts-{order}-style-{mode}.jp2"
        subprocess.run([str(directory / "encode.exe"), str(mode), "6", str(ord(order)), "0", "8", "0", str(output)], check=True, env=environment)
        encoded = output.read_bytes()
        actual = Image.open(io.BytesIO(encoded)).tobytes()
        if actual != expected:
            raise RuntimeError(f"Independent tile-part source round trip failed: {order}/{mode}")
        cases.append({"id": f"tileparts-{order}-style-{mode}", "width": width, "height": height, "components": 1, "bits": 8,
                      "encoded": base64.b64encode(encoded).decode(), "encodedSha256": hashlib.sha256(encoded).hexdigest(),
                      "expected": base64.b64encode(expected).decode(), "expectedSha256": hashlib.sha256(expected).hexdigest()})
path = root / "tests/fixtures/jpx-tile-parts.json"
path.write_text(json.dumps({"provenance": "Original pixels independently encoded by official OpenJPEG2.5.4 with tile parts divided at layer, resolution or component boundaries; independent Pillow/OpenJPEG source round trip, SOP/EPH, optional raw/MQ termination.",
                            "oracle": oracle, "cases": cases}, indent=2) + "\n", encoding="utf-8")
print(path, len(cases))

cases = []
for depth in [1, 2, 4, 7, 8, 9, 12, 15, 16]:
    for signed in [False, True]:
        output = directory / f"precision-{depth}-signed-{int(signed)}.jp2"
        subprocess.run([str(directory / "encode.exe"), "0", "0", "0", str(int(signed)), str(depth), "0", str(output)], check=True, env=environment)
        encoded = output.read_bytes()
        decoded_path = output.with_suffix(".samples")
        subprocess.run([str(directory / "decode.exe"), str(output), str(decoded_path)], check=True, env=environment)
        decoded = decoded_path.read_bytes()
        if decoded[:8] != b"PNJ2KREF" or struct.unpack_from("<III", decoded, 8) != (width, height, 1) or struct.unpack_from("<IIII", decoded, 20) != (depth, int(signed), width, height):
            raise RuntimeError("Independent decoder sample metadata differs")
        common = 8 if depth <= 8 else 16
        # Read original integer samples directly; Pillow's9bit JP2 mode loses
        # precision. This API does not impose a display representation.
        samples = [value + (2 ** (depth - 1) if signed else 0) for value in struct.unpack_from("<" + "i" * (width * height), decoded, 36)]
        original = [(i * 73 + i // width * 17) % (2 ** depth) for i in range(width * height)]
        if samples != original:
            raise RuntimeError(f"Independent sample round trip failed: {depth}/signed{signed}")
        normalized = [round(value * (2 ** common - 1) / (2 ** depth - 1)) for value in samples]
        for source, normalized_value in zip(samples, normalized):
            if round(normalized_value * (2 ** depth - 1) / (2 ** common - 1)) != source:
                raise RuntimeError("Normalization loses an original sample")
        raw = bytes(normalized) if common == 8 else b"".join(value.to_bytes(2, "big") for value in normalized)
        cases.append({"id": f"precision-{depth}-signed-{int(signed)}", "width": width, "height": height, "components": 1, "bits": common,
                      "sourcePrecision": [depth], "sourceSigned": [signed], "encoded": base64.b64encode(encoded).decode(), "encodedSha256": hashlib.sha256(encoded).hexdigest(),
                      "expected": base64.b64encode(raw).decode(), "expectedSha256": hashlib.sha256(raw).hexdigest()})
path = root / "tests/fixtures/jpx-precision.json"
path.write_text(json.dumps({"provenance": "Original pixels independently encoded/decoded by the official OpenJPEG2.5.4 integer sample API; original signed/unsigned1..16bit samples normalized reversibly to full-range8/16bit output. Exact original-sample restoration checked. No display scaling or Pillow9bit precision loss in the oracle.",
                            "oracle": oracle, "cases": cases}, indent=2) + "\n", encoding="utf-8")
print(path, len(cases))
