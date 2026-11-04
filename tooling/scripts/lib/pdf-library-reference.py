#!/usr/bin/env python3
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
"""Private, independent PDF text/layout reference. No PageNarrator imports."""
import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import logging
import math
import re
from pathlib import Path
import sys
import warnings

import pdfplumber
import pdfminer
from pdfminer.layout import LTContainer, LTTextContainer
from pdfminer.pdftypes import PDFStream, resolve1
from pdfminer.psparser import PSLiteral, literal_name

VERSIONS = {"pdfplumber": "0.11.9", "pdfminer.six": "20251230"}
MAX_PIXELS, MAX_SAMPLE_BYTES, MAX_JBIG2_PIXELS = 32_000_000, 96 * 1024 * 1024, 16_000_000


def file_pin(path):
    digest = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
            size += len(block)
    return {"path": str(Path(path).resolve()), "bytes": size, "sha256": digest.hexdigest()}


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Nonfinite or nonnumeric reference geometry")
    return value


def positive_integer(value):
    value = resolve1(value)
    return int(value) if not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value > 0 and int(value) == value else None


def name(value):
    value = resolve1(value)
    return literal_name(value) if isinstance(value, PSLiteral) else value if isinstance(value, str) else None


def color_components(value, resources, depth=0):
    if depth > 16:
        return None, "unresolved-depth"
    value = resolve1(value)
    label = name(value)
    counts = {"DeviceGray": 1, "G": 1, "DeviceRGB": 3, "RGB": 3, "DeviceCMYK": 4, "CMYK": 4,
              "CalGray": 1, "CalRGB": 3, "Lab": 3, "Indexed": 1, "I": 1, "Separation": 1}
    if label in counts:
        return counts[label], label
    if label:
        spaces = resolve1(resources.get("ColorSpace", {}))
        if isinstance(spaces, dict) and label in spaces:
            return color_components(spaces[label], resources, depth + 1)
        return None, label
    if isinstance(value, (list, tuple)) and value:
        label = name(value[0])
        if label == "ICCBased" and len(value) == 2:
            profile = resolve1(value[1])
            return positive_integer(profile.attrs.get("N")) if isinstance(profile, PDFStream) else None, label
        if label == "DeviceN" and len(value) >= 2:
            colorants = resolve1(value[1])
            return len(colorants) if isinstance(colorants, (list, tuple)) and colorants else None, label
        return counts.get(label), label or "unresolved-array"
    return None, "unresolved"


def image_metadata(image, resources, source_index, depth=0):
    stream = image.get("stream")
    attrs = stream.attrs if isinstance(stream, PDFStream) else {}
    src = image.get("srcsize", ())
    width = positive_integer(attrs.get("Width", src[0] if len(src) == 2 else None))
    height = positive_integer(attrs.get("Height", src[1] if len(src) == 2 else None))
    image_mask = resolve1(attrs.get("ImageMask", False))
    if not isinstance(image_mask, bool):
        image_mask = None
    bits = positive_integer(attrs.get("BitsPerComponent", 1 if image_mask else image.get("bits")))
    components, space = (1, "ImageMask") if image_mask else color_components(attrs.get("ColorSpace", image.get("colorspace")), resources)
    filters = resolve1(attrs.get("Filter", [])) or []
    filters = filters if isinstance(filters, (list, tuple)) else [filters]
    filter_names = [name(value) or "unresolved" for value in filters]
    pixels = width * height if width and height else None
    sample_bytes = ((width * components * bits + 7) // 8) * height if width and height and components and bits else None
    findings, unknowns = [], []
    if pixels is None:
        unknowns.append("source-dimensions")
    elif pixels > MAX_PIXELS or width > 1_000_000 or height > 1_000_000:
        findings.append("image-pixel-limit")
    if sample_bytes is None:
        unknowns.append("sample-layout")
    elif sample_bytes > MAX_SAMPLE_BYTES:
        findings.append("sample-byte-limit")
    if "JBIG2Decode" in filter_names and pixels and pixels > MAX_JBIG2_PIXELS:
        findings.append("jbig2-bitmap-pixel-limit")
    if "unresolved" in filter_names:
        unknowns.append("filter")
    if image_mask is None:
        unknowns.append("image-mask-flag")
    masks = {}
    for key in ("Mask", "SMask"):
        value = resolve1(attrs.get(key))
        if value is None:
            continue
        if isinstance(value, PDFStream) and depth == 0:
            child = image_metadata({"stream": value}, resources, source_index, depth + 1)
            masks[key] = child
            findings.extend(f"{key}:{code}" for code in child["resourceFindings"])
            unknowns.extend(f"{key}:{field}" for field in child["unknownMetadata"])
        elif key == "Mask" and isinstance(value, (list, tuple)):
            masks[key] = {"kind": "color-key", "entries": len(value)}
        else:
            unknowns.append(f"{key}:nested-or-unresolved-mask")
    return {"sourceIndex": source_index, "sourceObjectId": getattr(stream, "objid", None),
            "srcsize": [width, height], "width": width, "height": height, "bits": bits,
            "components": components, "colorSpace": space, "filters": filter_names,
            "imageMask": image_mask, "sampleBytes": sample_bytes, "masks": masks,
            "resourceFindings": findings, "unknownMetadata": unknowns}


def layout_containers(container):
    for child in container:
        if isinstance(child, LTTextContainer):
            yield child
        elif isinstance(child, LTContainer):
            yield from layout_containers(child)


def read_page(page, row):
    row.update(width=number(page.width), height=number(page.height), bbox=list(page.bbox), cropBox=list(page.cropbox))
    row["rawWords"] = [{key: word[key] if key == "text" else number(word[key])
                       for key in ("text", "x0", "x1", "top", "bottom")}
                      for word in page.extract_words(expand_ligatures=False)]
    row["charCount"] = len(page.chars)
    # PDFMiner emits an entire synthetic '(cid:N)' string for ONE undefined
    # source character. Literal printed prose has separate character records.
    row["undefinedGlyphs"] = [{"text": char["text"], "fontname": char.get("fontname"),
                               "bbox": [number(char.get(key)) for key in ("x0", "top", "x1", "bottom")]}
                              for char in page.chars
                              if re.fullmatch(r"\(cid:\d+\)", char.get("text", ""))]
    containers = list(layout_containers(page.layout))
    row["layoutText"] = "".join(container.get_text() for container in containers)
    row["layoutContainerCount"] = len(containers)
    resources = resolve1(page.page_obj.resources)
    if not isinstance(resources, dict):
        raise ValueError("Invalid PDF page resource dictionary")
    fonts = resolve1(resources.get("Font", {}))
    row["fontResources"] = []
    if isinstance(fonts, dict):
        for resource_name, font_reference in fonts.items():
            font = resolve1(font_reference)
            if isinstance(font, dict):
                row["fontResources"].append({"resource": str(resource_name), "subtype": name(font.get("Subtype")),
                                             "hasToUnicode": font.get("ToUnicode") is not None})
    sources, pixels, unknowns, violations = {}, 0, [], []
    for image in page.images:
        stream = image.get("stream")
        identity = id(stream) if stream is not None else id(image)
        first = identity not in sources
        if first:
            sources[identity] = len(sources) + 1
        metadata = image_metadata(image, resources, sources[identity])
        row["images"].append(metadata)
        if first and all(metadata["srcsize"]):
            pixels += metadata["width"] * metadata["height"]
        unknowns.extend({"sourceIndex": metadata["sourceIndex"], "field": field} for field in metadata["unknownMetadata"])
        violations.extend({"sourceIndex": metadata["sourceIndex"], "code": code} for code in metadata["resourceFindings"])
    if pixels > MAX_PIXELS:
        violations.append({"code": "distinct-page-image-source-pixel-limit"})
    row["resourceChecks"] = {"status": "violated" if violations else "unknown" if unknowns else "within-known-limits",
        "imageOccurrences": len(row["images"]), "distinctImageSources": len(sources),
        "distinctSourcePixelsKnown": pixels, "unknowns": unknowns, "violations": violations,
        "scope": "Declared source-image layouts on this requested page; not a decoder peak or complete rendering-budget proof. Image-internal masks and JBIG2 region/reference dimensions can require additional resource checks."}
    if unknowns:
        row["warnings"].append({"code": "unknown-image-resource-metadata", "count": len(unknowns)})
    if violations:
        row["errors"].append({"code": "resource_limit", "message": "Known image-source resource limit exceeded"})
    row["status"] = "error" if row["errors"] else "ok"


def tool_pins():
    modules = []
    for key, module in sorted(sys.modules.items()):
        path = getattr(module, "__file__", None)
        if key.split(".")[0] in ("pdfplumber", "pdfminer") and path and Path(path).is_file():
            modules.append({"module": key, **file_pin(path)})
    packages = {}
    for label, module in [("pdfplumber", pdfplumber), ("pdfminer", pdfminer)]:
        root = Path(module.__file__).parent
        entries = []
        for path in sorted(root.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                entry = file_pin(path)
                entries.append(f"{path.relative_to(root).as_posix()}\0{entry['sha256']}\0{entry['bytes']}\n")
        packages[label] = {"files": len(entries), "sha256": hashlib.sha256("".join(entries).encode()).hexdigest(),
                           "algorithm": "sha256 of sorted relative-path NUL file-sha256 NUL byte-count newline records"}
    return {"python": sys.version, "versions": {key: importlib.metadata.version(key) for key in VERSIONS},
            "moduleHashes": modules, "packageDigests": packages, "helper": file_pin(__file__)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--pages", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        requested = [int(value) for value in args.pages.split(",")]
        if not requested or len(requested) > 48 or len(set(requested)) != len(requested) or any(page < 1 for page in requested):
            raise ValueError("Use 1 to 48 unique positive page numbers")
    except ValueError as error:
        parser.error(str(error))
    if args.output.exists():
        parser.error("Output already exists; choose a fresh JSON path")
    args.input = args.input.resolve()
    before = None
    rows = [{"pageNumber": page, "status": "error", "rawWords": [], "charCount": 0, "layoutText": "",
             "images": [], "warnings": [], "errors": []} for page in requested]
    report = {"schemaVersion": 1, "referenceKind": "pdfplumber-pdfminer-raw-v1", "status": "error",
        "privateReferenceData": True, "input": {"path": str(args.input), "bytes": None, "sha256Before": None},
        "request": {"pages": requested, "laparams": {"boxes_flow": 0.5}, "expandLigatures": False,
                    "layoutTextSource": "Actual PDFMiner LTTextContainer tree order; nested figures traversed without duplicate child text"},
        "document": {"pageCount": None, "requestedPageCount": len(rows)}, "pages": rows, "warnings": [], "errors": []}
    by_page = {row["pageNumber"]: row for row in rows}
    messages = []
    class Capture(logging.Handler):
        def emit(self, record):
            messages.append({"logger": record.name, "level": record.levelname, "message": record.getMessage()})
    handler = Capture()
    log = logging.getLogger("pdfminer")
    log.addHandler(handler)
    try:
        before = file_pin(args.input)
        report["input"].update(bytes=before["bytes"], sha256Before=before["sha256"])
        for key, version in VERSIONS.items():
            if importlib.metadata.version(key) != version:
                raise ValueError(f"Required {key} version is {version}")
        with warnings.catch_warnings(record=True) as captured, contextlib.redirect_stdout(sys.stderr):
            warnings.simplefilter("always")
            with pdfplumber.open(args.input, pages=requested, laparams={"boxes_flow": 0.5}, strict_metadata=True) as pdf:
                count = positive_integer(resolve1(pdf.doc.catalog["Pages"]).get("Count"))
                if count is None:
                    raise ValueError("Invalid declared PDF page count")
                report["document"].update(pageCount=count, pageCountSource="PDF catalog Pages.Count", extractable=pdf.doc.is_extractable)
                if not pdf.doc.is_extractable:
                    raise ValueError("PDF text extraction is disallowed")
                for page in pdf.pages:
                    row = by_page[page.page_number]
                    try:
                        read_page(page, row)
                    except Exception as error:
                        row["errors"].append({"code": "page_reference_error", "type": type(error).__name__, "message": str(error)})
                    finally:
                        page.close()
            report["warnings"].extend({"code": "python-warning", "message": str(w.message)} for w in captured)
    except Exception as error:
        report["errors"].append({"code": "document_reference_error", "type": type(error).__name__, "message": str(error)})
    finally:
        log.removeHandler(handler)
    for row in rows:
        if row["status"] != "ok" and not row["errors"]:
            row["errors"].append({"code": "page_unavailable", "message": "Requested page was not successfully extracted"})
    report["warnings"].extend(messages)
    try:
        after = file_pin(args.input)
        unchanged = before == after
        report["input"].update(sha256After=after["sha256"], unchanged=unchanged)
        if not unchanged:
            report["errors"].append({"code": "input_changed", "message": "Original PDF changed during reference extraction"})
    except OSError as error:
        report["input"].update(sha256After=None, unchanged=False)
        report["errors"].append({"code": "input_recheck_error", "message": str(error)})
    report["tools"] = tool_pins()
    ok = sum(row["status"] == "ok" for row in rows)
    report["status"] = "ok" if ok == len(rows) and not report["errors"] else "partial" if ok else "error"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(report, output, ensure_ascii=False, allow_nan=False)
        output.write("\n")
    print(json.dumps({"status": report["status"], "pages": len(rows), "ok": ok, "output": str(args.output.resolve())}))
    return 0 if report["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
