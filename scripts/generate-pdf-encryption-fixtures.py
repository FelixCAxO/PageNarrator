"""Original fixture generator is matching source; upstream encoders are excluded from the extension."""
from pathlib import Path
from io import BytesIO
import fitz
from pypdf import PdfReader, PdfWriter

target = Path(__file__).resolve().parents[1] / "tests" / "pdf-engine" / "fixtures"
target.mkdir(parents=True, exist_ok=True)
for name, method, user, compressed in [
    ("encrypted-r2.pdf", fitz.PDF_ENCRYPT_RC4_40, "", False),
    ("encrypted-r3.pdf", fitz.PDF_ENCRYPT_RC4_128, "", False),
    ("encrypted-r4.pdf", fitz.PDF_ENCRYPT_AES_128, "", False),
    ("encrypted-r4-objects.pdf", fitz.PDF_ENCRYPT_AES_128, "", True),
    ("encrypted-r4-password.pdf", fitz.PDF_ENCRYPT_AES_128, "pn-user", True),
    ("encrypted-r6.pdf", fitz.PDF_ENCRYPT_AES_256, "", True),
]:
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((54, 92), "Original encrypted PDF fixture.", fontsize=12)
    document.set_metadata({"title": "Encrypted source title", "author": "PageNarrator fixture generator"})
    data = document.tobytes(encryption=method, owner_pw="pn-owner", user_pw=user,
                           permissions=fitz.PDF_PERM_ACCESSIBILITY | fitz.PDF_PERM_COPY,
                           deflate=True, use_objstms=1 if compressed else 0)
    (target / name).write_bytes(data)
    document.close()
    print(f"{name}: {len(data)} bytes")

for name, algorithm, user in [
    ("encrypted-r5.pdf", "AES-256-R5", ""),
    ("encrypted-r5-password.pdf", "AES-256-R5", "pn-user"),
    ("encrypted-r6-password.pdf", "AES-256", "pn-user"),
]:
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((54, 92), "Original encrypted PDF fixture.", fontsize=12)
    document.set_metadata({"title": "Encrypted source title"})
    writer = PdfWriter(clone_from=PdfReader(BytesIO(document.tobytes())))
    writer.encrypt(user_password=user, owner_password="pn-owner", algorithm=algorithm)
    writer.write(target / name)
    document.close()
    print(f"{name}: {(target / name).stat().st_size} bytes")
