"""Independent development raster for the original axial/function fixture."""
from pathlib import Path
import hashlib
import json
import fitz
import subprocess
import pypdfium2 as pdfium
from PIL import Image

target = Path(__file__).resolve().parents[1] / "tests" / "pdf-engine" / "fixtures"
source = target / "axial-shading.pdf"
document = fitz.open(source)
pixels = document[0].get_pixmap(alpha=False)
image = target / "axial-mupdf.png"
generated = pixels.tobytes("png")
if image.exists() and image.read_bytes() != generated:
    raise RuntimeError("The original failing MuPDF gold changed; preserve and review it.")
if not image.exists():
    image.write_bytes(generated)
metadata = {"renderer": "MuPDF", "version": fitz.VersionBind,
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "pngSha256": hashlib.sha256(image.read_bytes()).hexdigest(),
            "width": pixels.width, "height": pixels.height}
original_metadata = target / "axial-mupdf.json"
if original_metadata.exists():
    if json.loads(original_metadata.read_text()) != metadata:
        raise RuntimeError("Original MuPDF gold metadata changed; explicit review required.")
else:
    original_metadata.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
document.close()
control_source = target / "axial-explicitclip.pdf"
control = fitz.open(control_source)
control[0].get_pixmap(alpha=False).save(target / "axial-explicitclip-mupdf.png")
control.close()
version = subprocess.run(["pdftoppm", "-v"], capture_output=True, text=True, check=True).stderr.splitlines()[0]
subprocess.run(["pdftoppm", "-f", "1", "-singlefile", "-r", "72", "-png", str(source), str(target / "axial-poppler")], check=True)
doc = pdfium.PdfDocument(source)
bitmap = doc[0].render(scale=1)
bitmap.to_pil().convert("RGB").save(target / "axial-pdfium.png")
doc.close()

root = target.parents[2]
first_report = root / "artifacts/engines/pdf-raster-first-axial-mupdf-failure.json"
first_image = root / "artifacts/engines/pdf-raster-first-axial-mupdf-failure.png"
record = next(item for item in json.loads(first_report.read_text())["records"] if item["name"] == "axial-shading")
if record["sourceSha256"] != metadata["sourceSha256"] or record["passed"]:
    raise RuntimeError("The retained original failure/source evidence changed.")
own = Image.open(first_image).convert("RGB").crop((1, 1, 401, 321))
images = {name: Image.open(target / filename).convert("RGB") for name, filename in {
    "originalMuPDF": "axial-mupdf.png", "originalPDFium": "axial-pdfium.png",
    "originalPoppler": "axial-poppler.png", "explicitClipMuPDF": "axial-explicitclip-mupdf.png"}.items()}

def compare(a, b):
    error = changed = maximum = 0
    for pa, pb in zip(a.get_flattened_data(), b.get_flattened_data()):
        delta = [abs(x - y) for x, y in zip(pa, pb)]
        error += sum(delta)
        maximum = max(maximum, *delta)
        changed += max(delta) > 20
    return {"meanError": error / (a.width * a.height * 3 * 255),
            "changedFraction": changed / (a.width * a.height), "maximumChannelError": maximum}

metrics = {name: {"fullPage": compare(own, other), "transformedRegion": compare(own.crop((210, 0, 400, 320)), other.crop((210, 0, 400, 320)))} for name, other in images.items()}
points = [[220, 100], [220, 250], [250, 200], [350, 90], [350, 250]]
point_evidence = [{"point": point, "own": own.getpixel(tuple(point)), **{name: img.getpixel(tuple(point)) for name, img in images.items()}} for point in points]
verified = all(metrics[name]["fullPage"]["meanError"] < .025 and metrics[name]["fullPage"]["changedFraction"] < .06 for name in ["originalPoppler", "explicitClipMuPDF"])
report = {
    "classification": "oracle_discrepancy_verified" if verified else "unresolved",
    "originalMuPDFPass": False, "originalPDFiumPass": False, "tolerancesChanged": False,
    "primarySpecification": "https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf",
    "section": "8.7.4.3 Table 78: BBox is a temporary clip in shading target coordinates.",
    "reason": "Under a nonuniform CTM the target BBox maps to a parallelogram. Original MuPDF/PDFium use its device bounding rectangle; Poppler agrees with the original path and MuPDF agrees after an equivalent explicit path clip.",
    "originalSourceSha256": metadata["sourceSha256"],
    "equivalentExplicitClipSourceSha256": hashlib.sha256(control_source.read_bytes()).hexdigest(),
    "retainedFirstFailureScreenshotSha256": hashlib.sha256(first_image.read_bytes()).hexdigest(),
    "retainedFirstFailureReportSha256": hashlib.sha256(first_report.read_bytes()).hexdigest(),
    "versions": {"MuPDF": fitz.VersionBind, "Poppler": version, "PDFium": str(pdfium.PDFIUM_INFO)},
    "oracles": {name: {"path": str(path.relative_to(target)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for name, path in {
        "originalMuPDF": image, "originalPDFium": target / "axial-pdfium.png",
        "originalPoppler": target / "axial-poppler.png", "explicitClipMuPDF": target / "axial-explicitclip-mupdf.png"}.items()},
    "metrics": metrics, "points": point_evidence,
}
(target / "axial-oracle-comparison.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"classification": report["classification"], "metrics": metrics}))
