"""Fetch one frozen DocUNet photo with bounded ZIP ranges, without its 328 MB archive.

Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
Test data only: https://www3.cs.stonybrook.edu/~cvl/docunet.html
The legacy source is HTTP; the frozen SHA-256 verifies the extracted bytes.
"""
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / ".cache/engine-fixtures/docunet-35_1.jpg"
SOURCE = "http://vision.cs.stonybrook.edu/~kema/docwarp/original.zip"
MEMBER = "original/35_1.jpg"
EXPECTED_HASH = "aef29c038a795579cc4024eee0ee3e1f98fd407819c506c658d162fa89e5585f"
EXPECTED_BYTES = 1087225
RANGES = []


def read_range(start, end):
    if start < 0 or end < start or end - start + 1 > 4 * 1024 * 1024:
        raise ValueError("Archive range exceeds its bound")
    request = urllib.request.Request(SOURCE, headers={
        "Range": f"bytes={start}-{end}", "User-Agent": "PageNarrator-Verification/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        content_range = response.headers.get("Content-Range", "")
        if response.status != 206 or not content_range.startswith(f"bytes {start}-{end}/"):
            raise ValueError("Server did not return the requested bounded range")
        data = response.read(end - start + 2)
        if len(data) != end - start + 1:
            raise ValueError("Archive range length mismatch")
        RANGES.append({"start": start, "end": end, "bytes": len(data)})
        return data, int(content_range.split("/")[1])


class RemoteArchive(io.RawIOBase):
    def __init__(self, length):
        super().__init__()
        self.length, self.position = length, 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        if whence not in (0, 1, 2):
            raise ValueError("Invalid archive seek mode")
        position = offset + (0 if whence == 0 else self.position if whence == 1 else self.length)
        if not 0 <= position <= self.length:
            raise ValueError("Archive seek out of range")
        self.position = position
        return position

    def read(self, size=-1):
        count = min(self.length - self.position, size if size >= 0 else self.length)
        if count == 0:
            return b""
        data, length = read_range(self.position, self.position + count - 1)
        if length != self.length:
            raise ValueError("Archive length changed during download")
        self.position += count
        return data


def main():
    if DESTINATION.exists():
        if hashlib.sha256(DESTINATION.read_bytes()).hexdigest() != EXPECTED_HASH:
            raise ValueError("Cached fixture has an unexpected SHA-256")
        print(f"Frozen DocUNet fixture verified: {DESTINATION}")
        return
    _, length = read_range(0, 0)
    with zipfile.ZipFile(RemoteArchive(length)) as archive:
        member = archive.getinfo(MEMBER)
        if member.file_size != EXPECTED_BYTES or member.compress_size > 4 * 1024 * 1024:
            raise ValueError("Unexpected fixture size")
        data = archive.read(member)
    if len(data) != EXPECTED_BYTES or hashlib.sha256(data).hexdigest() != EXPECTED_HASH:
        raise ValueError("Frozen fixture SHA-256 mismatch")
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    with DESTINATION.open("xb") as output:
        output.write(data)
    receipt = {"source": SOURCE, "member": MEMBER, "sha256": EXPECTED_HASH,
               "bytes": len(data), "transferredBytes": sum(item["bytes"] for item in RANGES), "ranges": RANGES}
    DESTINATION.with_suffix(".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Frozen DocUNet fixture downloaded and verified: {DESTINATION}")


if __name__ == "__main__":
    main()
