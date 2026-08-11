#!/usr/bin/env python3
"""
PDF Redactor using PyMuPDF
Finds PII patterns and applies true redactions while preserving layout
"""

import sys
import json
import re
import fitz  # PyMuPDF

# PII patterns to detect and redact
PII_PATTERNS = [
    # SSN
    ('SSN', r'\b\d{3}[-.]?\d{2}[-.]?\d{4}\b', '[REDACTED]'),
    
    # Email
    ('Email', r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b', '[REDACTED]'),
    
    # Phone (US format)
    ('Phone', r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b', '[REDACTED]'),
    
    # IP Address
    ('IP', r'\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b', '[REDACTED]'),
    
    # DOB with context - more specific patterns
    ('DOB', r'\b(?:DOB|D\.O\.B\.?|Date of Birth|Birth\s*Date)[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b', '[DOB REDACTED]'),
    ('DOB', r'\bborn\s+(?:on\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}\b', '[DOB REDACTED]'),
    ('DOB', r'\bborn\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b', '[DOB REDACTED]'),
    
    # MRN with context
    ('MRN', r'\b(?:MRN|MR#|Medical Record(?:\s*(?:Number|No|#))?)[:\s#]*\d{5,10}\b', '[REDACTED]'),
    
    # Account/Patient IDs
    ('Account', r'\b(?:account|acct|patient id|member id)[:\s#]*\d{4,12}\b', '[REDACTED]'),
    
    # Credit Card (basic pattern)
    ('CC', r'\b(?:\d{4}[-\s]?){3}\d{4}\b', '[REDACTED]'),
]

def redact_pdf(input_path, output_path):
    """
    Redact PII from PDF while preserving original layout
    """
    doc = fitz.open(input_path)
    detections = []
    page_count = len(doc)
    
    for page_num in range(page_count):
        page = doc[page_num]
        text = page.get_text()
        
        for pii_type, pattern, replacement in PII_PATTERNS:
            # Find all matches in the text
            for match in re.finditer(pattern, text, re.IGNORECASE):
                matched_text = match.group()
                
                # Search for this text on the page and get rectangles
                rects = page.search_for(matched_text)
                
                for rect in rects:
                    # Add redaction annotation
                    page.add_redact_annot(rect, text=replacement, fontsize=8, fill=(1, 1, 1))
                
                # Track detection (avoid duplicates)
                if matched_text not in [d['original'] for d in detections]:
                    detections.append({
                        'type': pii_type,
                        'original': matched_text,
                        'redacted': replacement,
                        'page': page_num + 1
                    })
        
        # Apply all redactions on this page
        page.apply_redactions()
    
    # Save the redacted PDF
    doc.save(output_path, garbage=4, deflate=True)
    doc.close()
    
    return {
        'success': True,
        'detections': detections,
        'pageCount': page_count
    }

def main():
    if len(sys.argv) != 3:
        print(json.dumps({'error': 'Usage: redact.py <input.pdf> <output.pdf>'}))
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    
    try:
        result = redact_pdf(input_path, output_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
