"""Original fixtures, independently evaluated by external LittleCMS and MuPDF."""
# Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
from pathlib import Path
import hashlib
import itertools
import json
import fitz
from PIL import Image, ImageCms, features

directory = Path(__file__).resolve().parent.parent / "tests/pdf-engine/fixtures"
digest = lambda data: hashlib.sha256(data).hexdigest()
profile_bytes = (directory / "synthetic-rgb.icc").read_bytes()
profile = ImageCms.getOpenProfile(str(directory / "synthetic-rgb.icc"))
srgb = ImageCms.createProfile("sRGB")
colors = list(itertools.product([0, 8, 32, 64, 128, 192, 224, 248, 255], repeat=3))
image = Image.frombytes("RGB", (len(colors), 1), bytes(value for color in colors for value in color))
def transform(source, target):
    result = ImageCms.profileToProfile(image, source, target, renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
                                     outputMode="RGB", flags=ImageCms.Flags.NOOPTIMIZE)
    return [list(pixel) for pixel in result.getdata()]

source_bytes = (directory / "icc-blending.pdf").read_bytes()
fitz.TOOLS.set_icc(True)
document = fitz.open(stream=source_bytes, filetype="pdf")
pixmap = document[0].get_pixmap(alpha=False)
png = pixmap.tobytes("png")
(directory / "icc-blending-mupdf.png").write_bytes(png)
report = {
    "provenance": "Original synthetic matrix/TRC profile, colors and PDF. External oracle code/executables are not included.",
    "profileSha256": digest(profile_bytes), "sourceSha256": digest(source_bytes), "pngSha256": digest(png),
    "littleCmsVersion": features.version("littlecms2"), "muPdfVersion": fitz.VersionBind,
    "renderingIntent": "relative colorimetric, no black-point compensation, no LUT optimization",
    "maximumColorChannelError": 2,
    "width": pixmap.width, "height": pixmap.height,
    "colors": colors, "toSrgb": transform(profile, srgb), "fromSrgb": transform(srgb, profile),
}
(directory / "icc-blending-oracle.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(f"ICC oracle: {len(colors)} colors each direction, LittleCMS {features.version('littlecms2')}, MuPDF {fitz.VersionBind}.")
document.close()
