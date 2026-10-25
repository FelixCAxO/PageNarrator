"""Original raster generator is matching source; upstream renderers are excluded from the extension."""
from pathlib import Path
import hashlib
import json
import fitz

target = Path(__file__).resolve().parents[1] / "tests" / "pdf-engine" / "fixtures"
source = target / "nonisolated-group.pdf"
document = fitz.open(source)
pixels = document[0].get_pixmap(alpha=False)
image = target / "nonisolated-mupdf.png"
pixels.save(image)
metadata = {
    "renderer": "MuPDF", "version": fitz.VersionBind,
    "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "pngSha256": hashlib.sha256(image.read_bytes()).hexdigest(),
    "width": pixels.width, "height": pixels.height,
    "reason": "PDF.js approximates non-isolated groups; use an independent raster.",
}
(target / "nonisolated-mupdf.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
document.close()
print(json.dumps(metadata))
