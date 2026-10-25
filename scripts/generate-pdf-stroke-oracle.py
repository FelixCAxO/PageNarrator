"""Independent development raster for the original stroke-adjustment fixture."""
from pathlib import Path
import hashlib
import json
import fitz

target = Path(__file__).resolve().parents[1] / "tests" / "pdf-engine" / "fixtures"
source = target / "stroke-adjustment.pdf"
document = fitz.open(source)
pixels = document[0].get_pixmap(alpha=False)
control = fitz.open(source)
control.xref_set_key(6, "SA", "false")
control_samples = control[0].get_pixmap(alpha=False).samples
image = target / "stroke-mupdf.png"
pixels.save(image)
metadata = {
    "renderer": "MuPDF", "version": fitz.VersionBind,
    "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "pngSha256": hashlib.sha256(image.read_bytes()).hexdigest(),
    "width": pixels.width, "height": pixels.height,
    "saFlagChangesPixels": pixels.samples != control_samples,
    "reason": "MuPDF ignores SA in this control; raster is a visual diagnostic, not SA execution acceptance.",
}
(target / "stroke-mupdf.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
document.close()
control.close()
print(json.dumps(metadata))
