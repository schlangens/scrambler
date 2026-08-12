#!/usr/bin/env python3
"""
PDF Redactor using PyMuPDF.

Protocol:
  Node streams the PDF on the redactor's stdin using 8-byte, big-endian,
  length-prefixed framing, followed by the requested style as argv[1]:

      [ 8 bytes: PDF length N ] [ N bytes: PDF data ]   (style string)

  The redactor writes the response on stdout using the same framing:

      [ 8 bytes: redacted PDF length M ] [ M bytes: redacted PDF data ]
      [ 8 bytes: JSON metadata length K ] [ K bytes: JSON metadata ]

  The metadata is a JSON object with keys: success, detections,
  pageCount, originalPageCount, newPageCount, charCount,
  redactedCharCount, and error.  The binary PDF and the metadata are
  length-prefixed so the Node side can read them robustly even when the
  OS delivers them in partial chunks.

Security invariants:
  * No temporary files are created.
  * Nothing is ever logged to stderr or any other persistent store.
  * No detected PII is included in error messages.
  * If any detected PII cannot be located and removed, the request fails
    closed and no redacted PDF is returned.
"""

import json
import os
import re
import sys

# ---------------------------------------------------------------------------
# Protocol stdout isolation
#
# The Node side expects a clean binary length-prefixed stream on the child's
# stdout. PyMuPDF's legacy `import fitz` and other libraries or future
# dependencies may write warnings or debug text to stdout, which would corrupt
# the first 8-byte length prefix and produce an "invalid redactor response"
# error. To make stdout purity a guarantee rather than an assumption, we:
#
#   1. Duplicate the real stdout file descriptor (the pipe back to Node).
#   2. Redirect the C-level stdout fd (1) to stderr, so C library writes go
#      to stderr instead of the protocol stream.
#   3. Repoint sys.stdout at sys.stderr, so Python-level prints do the same.
#
# The framed response is then written exclusively through the saved fd.
# This block runs before any imports that might write to stdout.
# ---------------------------------------------------------------------------
_PROTOCOL_OUT = os.dup(sys.stdout.fileno())
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr

try:
    import pymupdf as fitz  # type: ignore
except ImportError:  # pragma: no cover
    import fitz  # type: ignore

MAX_FILE_SIZE = int(os.environ.get("SCRAMBLER_MAX_FILE_SIZE", 10 * 1024 * 1024))


class RedactionError(Exception):
    """Known, safe error raised by this redactor; its message may be returned to the caller."""


# PII patterns to detect and redact.  Tuple is (label, regex, replacement).
PII_PATTERNS = [
    ("SSN", r"\b\d{3}[-.]?\d{2}[-.]?\d{4}\b", "[REDACTED]"),
    (
        "Email",
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
        "[REDACTED]",
    ),
    (
        "Phone",
        r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b",
        "[REDACTED]",
    ),
    (
        "IP",
        r"(?<![0-9]\.)\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b(?!\.[0-9])",
        "[REDACTED]",
    ),
    (
        "DOB",
        r"\b(?:DOB|D\.O\.B\.?|Date of Birth|Birth\s*Date)[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b",
        "[DOB REDACTED]",
    ),
    (
        "DOB",
        r"\bborn\s+(?:on\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}\b",
        "[DOB REDACTED]",
    ),
    ("DOB", r"\bborn\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", "[DOB REDACTED]"),
    (
        "MRN",
        r"\b(?:MRN|MR#|Medical Record(?:\s*(?:Number|No|#))?)[:\s#]*\d{5,10}\b",
        "[REDACTED]",
    ),
    (
        "Account",
        r"\b(?:account|acct|policy|patient id|member id)[:\s#]*\d{4,12}\b",
        "[REDACTED]",
    ),
    ("CC", r"\b(?:\d{4}[-\s]?){3}\d{4}\b", "[REDACTED]"),
]

TEXT_FLAGS = fitz.TEXTFLAGS_TEXT & ~fitz.TEXT_PRESERVE_LIGATURES


def _read_exact(stream, n):
    """Read exactly n bytes from a binary stream, raising EOFError on short read."""
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            raise RedactionError(f"Expected {n} bytes, received {len(buf)}")
        buf += chunk
    return buf


def _read_length_prefixed(stream):
    """Read a length-prefixed byte payload from the stream."""
    length_bytes = _read_exact(stream, 8)
    length = int.from_bytes(length_bytes, "big")
    if length > MAX_FILE_SIZE:
        raise RedactionError(f"Input size {length} exceeds maximum {MAX_FILE_SIZE}")
    if length == 0:
        raise RedactionError("Empty PDF payload")
    return _read_exact(stream, length)


def _write_all(fd, data):
    """Write all bytes to a file descriptor, handling partial writes."""
    while data:
        n = os.write(fd, data)
        if n == 0:
            raise RedactionError("Unable to write complete response")
        data = data[n:]


def _write_response(pdf_bytes, meta):
    """Write a length-prefixed PDF + JSON metadata response to the real stdout."""
    meta_bytes = json.dumps(meta, separators=(",", ":")).encode("utf-8")
    _write_all(_PROTOCOL_OUT, len(pdf_bytes).to_bytes(8, "big"))
    _write_all(_PROTOCOL_OUT, pdf_bytes)
    _write_all(_PROTOCOL_OUT, len(meta_bytes).to_bytes(8, "big"))
    _write_all(_PROTOCOL_OUT, meta_bytes)


def _validate_pdf(data):
    """Reject files that are not PDFs by checking the magic bytes."""
    if len(data) < 4 or data[:4] != b"%PDF":
        raise RedactionError("File does not appear to be a valid PDF")


def _normalize_token(text):
    """Strip non-word characters and lower-case a token for fuzzy matching."""
    return re.sub(r"[^\w]", "", text).lower()


def _rects_from_words(words, target):
    """
    Locate a sequence of words whose normalized tokens match the target.
    This is a fallback when page.search_for() cannot find the exact string,
    e.g. because of whitespace differences, ligatures, or span boundaries.
    """
    target_tokens = [
        t for t in re.split(r"\s+", target.strip()) if t and _normalize_token(t)
    ]
    if not target_tokens or not words:
        return []

    needle = [_normalize_token(t) for t in target_tokens]
    rects = []
    i = 0
    n_words = len(words)
    n_needle = len(needle)

    while i < n_words:
        if _normalize_token(words[i][4]) == needle[0]:
            matched = [words[i]]
            j = 1
            k = i + 1
            while k < n_words and j < n_needle:
                word_norm = _normalize_token(words[k][4])
                if word_norm == "":
                    k += 1
                    continue
                if word_norm == needle[j]:
                    matched.append(words[k])
                    j += 1
                    k += 1
                else:
                    break
            if j == n_needle:
                # Build a single rectangle covering the matched word sequence.
                rect = fitz.Rect(matched[0][:4])
                for word in matched[1:]:
                    rect |= fitz.Rect(word[:4])
                rects.append(rect)
                i = k
                continue
        i += 1

    return rects


def _find_rects(page, target, words):
    """
    Find the bounding rectangles for an exact text match.
    First try PyMuPDF's native search_for, then fall back to word geometry.
    """
    rects = page.search_for(target)
    if rects:
        return rects

    # Try a whitespace-collapsed version in case the regex matched extra
    # spaces that the PDF does not materialise in the text spans.
    collapsed = re.sub(r"\s+", " ", target).strip()
    if collapsed != target:
        rects = page.search_for(collapsed)
        if rects:
            return rects

    return _rects_from_words(words, target)


def _redaction_appearance(style, default_replacement):
    """Return (fill, replacement text) for the requested redaction style."""
    if style in ("blackout", "blackbox"):
        return (0, 0, 0), ""
    return (1, 1, 1), default_replacement


def redact_pdf(pdf_bytes, style):
    """
    Redact PII from a PDF held entirely in memory.
    Returns (output_pdf_bytes, metadata_dict).
    Raises an exception if anything cannot be safely redacted (fail-closed).
    """
    _validate_pdf(pdf_bytes)

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    if doc.needs_pass:
        raise RedactionError("Encrypted or password-protected PDFs are not supported")

    page_count = len(doc)
    detections = []
    unchecked_pages = []
    original_char_count = 0

    for page_num in range(page_count):
        page = doc[page_num]
        page_text = page.get_text(flags=TEXT_FLAGS)
        original_char_count += len(page_text)

        # Pages with no extractable text but containing images or vector
        # drawings cannot be checked by this regex-based redactor. We warn
        # the caller in the metadata but do NOT refuse the document, because
        # image-only pages may legitimately contain no PII. This is a
        # warn-and-inform case, distinct from the fail-closed stance for
        # unlocatable detected PII.
        if not page_text.strip() and (page.get_images() or page.get_drawings()):
            unchecked_pages.append(page_num + 1)

        words = page.get_text("words", flags=TEXT_FLAGS)

        for pii_type, pattern, default_replacement in PII_PATTERNS:
            for match in re.finditer(pattern, page_text, re.IGNORECASE):
                matched_text = match.group()

                rects = _find_rects(page, matched_text, words)
                if not rects:
                    raise RedactionError(
                        f"Could not locate a detected {pii_type} on page {page_num + 1}; "
                        "redaction aborted"
                    )

                fill, replacement = _redaction_appearance(style, default_replacement)
                for rect in rects:
                    page.add_redact_annot(
                        rect, text=replacement, fontsize=8, fill=fill
                    )

                # Deduplicate on exact matched text.
                if matched_text not in [d["original"] for d in detections]:
                    detections.append(
                        {
                            "type": pii_type,
                            "original": matched_text,
                            "redacted": replacement,
                            "page": page_num + 1,
                        }
                    )

        page.apply_redactions()

    output_bytes = doc.tobytes(garbage=4, deflate=True)
    doc.close()

    # Re-open the output bytes to verify the redacted text is actually gone.
    verify_doc = fitz.open(stream=output_bytes, filetype="pdf")
    try:
        redacted_text_total = ""
        for page in verify_doc:
            redacted_text_total += page.get_text(flags=TEXT_FLAGS)

        redacted_lower = redacted_text_total.lower()
        for detection in detections:
            if detection["original"].lower() in redacted_lower:
                raise RedactionError(
                    f"Verification failed for {detection['type']} on page "
                    f"{detection['page']}; redacted text is still present"
                )
    finally:
        verify_doc.close()

    meta = {
        "success": True,
        "detections": detections,
        "pageCount": page_count,
        "originalPageCount": page_count,
        "newPageCount": page_count,
        "pagesWithoutText": unchecked_pages,
        "hasUncheckedPages": bool(unchecked_pages),
        "charCount": original_char_count,
        "redactedCharCount": len(redacted_text_total),
    }
    return output_bytes, meta


def main():
    style = sys.argv[1] if len(sys.argv) > 1 else "text"
    if style not in ("text", "blackout", "blackbox"):
        style = "text"

    try:
        pdf_bytes = _read_length_prefixed(sys.stdin.buffer)
        output_bytes, meta = redact_pdf(pdf_bytes, style)
        _write_response(output_bytes, meta)
    except RedactionError as exc:
        # These are our own safe messages (type/page only, never matched text).
        error_meta = {"success": False, "error": str(exc), "detections": []}
        _write_response(b"", error_meta)
    except Exception:
        # Unexpected PyMuPDF / system exceptions may contain document content.
        # Do not forward their raw text to the caller.
        error_meta = {"success": False, "error": "Internal redaction error", "detections": []}
        _write_response(b"", error_meta)


if __name__ == "__main__":
    main()
