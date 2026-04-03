#!/usr/bin/env python3
"""
signature_engine.py — E-Signature Embedding Engine
MCFL Restaurant Holdings LLC — bleeding.cash

Embeds a drawn or typed signature into generated PDF forms.
Adds a legal audit trail page at the end of each signed document.

Usage:
    from signature_engine import embed_signature_in_pdf, render_typed_signature

    sig_data = {
        'image_base64': '<base64 PNG string>',
        'signer_name': 'Erik Peter Osol',
        'date': '04/03/2026',
        'ip_address': '192.168.1.1',
        'timestamp': '2026-04-03T05:00:00Z',
    }
    embed_signature_in_pdf('input.pdf', 'output_signed.pdf', sig_data)
"""

import base64
import io
import os
from datetime import datetime
from typing import Any, Dict, List, Optional


def _decode_sig_image(image_base64: str):
    """Decode base64 signature PNG → PIL Image."""
    try:
        from PIL import Image
        # Strip data URI prefix if present
        if ',' in image_base64:
            image_base64 = image_base64.split(',', 1)[1]
        raw = base64.b64decode(image_base64)
        img = Image.open(io.BytesIO(raw)).convert('RGBA')
        return img
    except Exception as e:
        print(f"[sig] Could not decode signature image: {e}")
        return None


def render_typed_signature(name: str, width: int = 400, height: int = 100) -> str:
    """
    Render a typed name as a cursive-style signature PNG.
    Returns base64-encoded PNG string.
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
        import urllib.request

        img = Image.new('RGBA', (width, height), (255, 255, 255, 0))
        draw = ImageDraw.Draw(img)

        # Try to load a cursive font
        font = None
        font_paths = [
            '/tmp/GreatVibes-Regular.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf',
        ]

        # Download Great Vibes if not cached
        if not os.path.exists('/tmp/GreatVibes-Regular.ttf'):
            try:
                url = 'https://fonts.gstatic.com/s/greatvibes/v19/RWmMoKWR9v4ksMfaWd_JN9XFiaQ.woff2'
                # woff2 won't work with PIL — try a TTF source
                url = 'https://github.com/google/fonts/raw/main/ofl/greatvibes/GreatVibes-Regular.ttf'
                urllib.request.urlretrieve(url, '/tmp/GreatVibes-Regular.ttf')
            except Exception:
                pass

        for path in font_paths:
            if os.path.exists(path):
                try:
                    font = ImageFont.truetype(path, size=48)
                    break
                except Exception:
                    continue

        if font is None:
            font = ImageFont.load_default()

        # Draw name in dark ink with slight slant effect
        draw.text((10, 10), name, fill=(20, 20, 80, 220), font=font)

        # Add underline
        bbox = draw.textbbox((10, 10), name, font=font)
        draw.line([(10, bbox[3] + 4), (bbox[2], bbox[3] + 4)], fill=(20, 20, 80, 180), width=2)

        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return base64.b64encode(buf.getvalue()).decode()

    except Exception as e:
        print(f"[sig] Could not render typed signature: {e}")
        return ""


def _get_sig_field_rects(pdf_path: str) -> List[Dict]:
    """Find all /Sig field bounding boxes in a PDF."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        sig_fields = []
        fields = reader.get_fields() or {}

        # Walk all annotations to find Sig widgets
        for page_num, page in enumerate(reader.pages):
            annots = page.get('/Annots', [])
            for annot_ref in annots:
                try:
                    annot = annot_ref.get_object() if hasattr(annot_ref, 'get_object') else annot_ref
                    ft = annot.get('/FT', '')
                    if str(ft) == '/Sig':
                        rect = annot.get('/Rect', [])
                        if rect and len(rect) == 4:
                            sig_fields.append({
                                'page': page_num,
                                'rect': [float(x) for x in rect],
                                'field_name': str(annot.get('/T', f'sig_p{page_num}')),
                            })
                except Exception:
                    continue

        return sig_fields
    except Exception as e:
        print(f"[sig] Could not extract sig fields: {e}")
        return []


def embed_signature_in_pdf(input_pdf_path: str, output_pdf_path: str,
                            signature_data: Dict[str, Any]) -> str:
    """
    Embed a signature image into all signature fields of a PDF.

    For AcroForm PDFs with /Sig fields: places signature at each field's bounding box.
    For flat PDFs or when no /Sig fields found: places at standard bottom-of-last-page position.
    Appends an audit trail page at the end.

    Args:
        input_pdf_path: Source PDF (filled but unsigned)
        output_pdf_path: Destination PDF (with signature overlaid)
        signature_data: {image_base64, signer_name, date, ip_address, timestamp}

    Returns:
        output_pdf_path on success
    """
    try:
        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas as rl_canvas
        from reportlab.lib.pagesizes import LETTER
        from reportlab.lib.units import inch
    except ImportError as e:
        print(f"[sig] Missing dep: {e}. Copying unsigned PDF.")
        import shutil
        shutil.copy2(input_pdf_path, output_pdf_path)
        return output_pdf_path

    signer_name = signature_data.get('signer_name', '')
    sig_date = signature_data.get('date', datetime.now().strftime('%m/%d/%Y'))
    ip_addr = signature_data.get('ip_address', 'N/A')
    timestamp = signature_data.get('timestamp', datetime.now().isoformat())
    image_b64 = signature_data.get('image_base64', '')

    # Decode signature image
    sig_img = _decode_sig_image(image_b64) if image_b64 else None

    # Find signature field locations
    sig_fields = _get_sig_field_rects(input_pdf_path)

    reader = PdfReader(input_pdf_path)
    total_pages = len(reader.pages)

    # If no sig fields found, use default positions on last 2 pages
    if not sig_fields:
        last = total_pages - 1
        # Primary signer at bottom of last content page
        sig_fields = [
            {'page': max(0, last - 1), 'rect': [72, 72, 300, 100], 'field_name': 'Signature'},
            {'page': last, 'rect': [72, 72, 300, 100], 'field_name': 'Signature_2'},
        ]

    # Group sig fields by page
    by_page = {}
    for sf in sig_fields:
        by_page.setdefault(sf['page'], []).append(sf)

    # Build overlay PDFs for each page that has a sig field
    overlays = {}  # page_num → overlay PDF bytes
    for page_num, fields in by_page.items():
        page = reader.pages[page_num]
        # Get page dimensions (PDF default is bottom-left origin)
        media_box = page.mediabox
        pw = float(media_box.width)
        ph = float(media_box.height)

        buf = io.BytesIO()
        c = rl_canvas.Canvas(buf, pagesize=(pw, ph))

        for sf in fields:
            rect = sf['rect']
            # PDF coordinates: y=0 at bottom
            x0, y0, x1, y1 = rect
            sig_w = x1 - x0
            sig_h = y1 - y0

            if sig_img:
                # Save PIL image to bytes
                from PIL import Image
                img_buf = io.BytesIO()
                # Make background transparent/white for clean overlay
                bg = Image.new('RGBA', sig_img.size, (255, 255, 255, 0))
                bg.paste(sig_img, mask=sig_img.split()[3] if sig_img.mode == 'RGBA' else None)
                bg.convert('RGB').save(img_buf, format='PNG')
                img_buf.seek(0)
                c.drawImage(
                    rl_canvas.ImageReader(img_buf),
                    x0, y0, width=sig_w, height=sig_h,
                    preserveAspectRatio=True, anchor='sw', mask='auto'
                )
            else:
                # Typed signature fallback
                c.setFont('Helvetica-Oblique', min(sig_h * 0.6, 18))
                c.setFillColorRGB(0.08, 0.08, 0.3)
                c.drawString(x0 + 4, y0 + sig_h * 0.2, f'/s/ {signer_name}')

            # "Electronically signed" label below
            c.setFont('Helvetica', 7)
            c.setFillColorRGB(0.4, 0.4, 0.4)
            c.drawString(x0, y0 - 10, f'Electronically signed by {signer_name} on {sig_date}')

        c.save()
        buf.seek(0)
        overlays[page_num] = buf

    # Merge overlays into the original PDF
    writer = PdfWriter()
    writer.append(reader)

    for page_num, overlay_buf in overlays.items():
        overlay_reader = PdfReader(overlay_buf)
        writer.pages[page_num].merge_page(overlay_reader.pages[0])

    # Append audit trail page
    audit_buf = _build_audit_trail_page(signature_data, os.path.basename(input_pdf_path))
    audit_reader = PdfReader(audit_buf)
    writer.append(audit_reader)

    with open(output_pdf_path, 'wb') as f:
        writer.write(f)

    print(f"[sig] Signed PDF written → {output_pdf_path}")
    return output_pdf_path


def _build_audit_trail_page(signature_data: Dict[str, Any], doc_name: str) -> io.BytesIO:
    """Generate a legal audit trail page as a PDF buffer."""
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    TEAL = colors.HexColor("#1B474D")
    GRAY = colors.HexColor("#D4D1CA")
    BG = colors.HexColor("#F7F6F2")
    WHITE = colors.white

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        title="Electronic Signature Audit Trail",
        author="Perplexity Computer",
        leftMargin=inch, rightMargin=inch,
        topMargin=inch, bottomMargin=inch,
    )
    styles = getSampleStyleSheet()
    body = ParagraphStyle('body', fontName='Helvetica', fontSize=10, leading=14,
                           textColor=colors.HexColor('#28251D'))
    label = ParagraphStyle('label', fontName='Helvetica-Bold', fontSize=8, leading=12,
                            textColor=colors.HexColor('#7A7974'))
    title_s = ParagraphStyle('title', fontName='Helvetica-Bold', fontSize=16, leading=20,
                              textColor=WHITE)

    story = []

    # Header
    hdr = Table([[Paragraph('ELECTRONIC SIGNATURE AUDIT TRAIL', title_s)]],
                colWidths=[6.5 * inch])
    hdr.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), TEAL),
        ('LEFTPADDING', (0, 0), (-1, -1), 16),
        ('TOPPADDING', (0, 0), (-1, -1), 12),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
    ]))
    story.append(hdr)
    story.append(Spacer(1, 0.2 * inch))

    story.append(Paragraph(
        'This audit trail certifies that the document was electronically signed. '
        'This record is maintained by MCFL Restaurant Holdings LLC (bleeding.cash) '
        'and constitutes a legally binding electronic signature under the E-SIGN Act (15 U.S.C. § 7001).',
        body
    ))
    story.append(Spacer(1, 0.2 * inch))

    # Audit data table
    ts = datetime.now().strftime('%B %d, %Y at %I:%M %p UTC')
    rows = [
        [Paragraph('FIELD', label), Paragraph('VALUE', label)],
        ['Document', doc_name],
        ['Signer Name', signature_data.get('signer_name', 'N/A')],
        ['Signature Date', signature_data.get('date', 'N/A')],
        ['Timestamp (UTC)', signature_data.get('timestamp', ts)],
        ['IP Address', signature_data.get('ip_address', 'N/A')],
        ['Signature Method', 'Electronic — drawn or typed via bleeding.cash'],
        ['Platform', 'MCFL Restaurant Holdings LLC / bleeding.cash'],
        ['Legal Basis', 'E-SIGN Act, 15 U.S.C. § 7001; UETA'],
    ]

    t = Table(rows, colWidths=[2.5 * inch, 4 * inch])
    ts_style = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), TEAL),
        ('TEXTCOLOR', (0, 0), (-1, 0), WHITE),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('GRID', (0, 0), (-1, -1), 0.5, GRAY),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ])
    for i in range(1, len(rows)):
        if i % 2 == 0:
            ts_style.add('BACKGROUND', (0, i), (-1, i), BG)
    t.setStyle(ts_style)
    story.append(t)
    story.append(Spacer(1, 0.3 * inch))

    story.append(Paragraph(
        '<b>DISCLAIMER:</b> This document was auto-populated and electronically signed via the '
        'bleeding.cash financial triage service operated by MCFL Restaurant Holdings LLC. '
        'This is not legal or financial advice. Verify all figures with a licensed professional '
        'before submitting to any lender or government agency. By signing, the signer certifies '
        'that all information is true and complete to the best of their knowledge.',
        ParagraphStyle('disc', fontName='Helvetica', fontSize=8, leading=11,
                        textColor=colors.HexColor('#7A7974'))
    ))

    doc.build(story)
    buf.seek(0)
    return buf


def generate_audit_trail_page(signature_data_list: List[Dict], output_path: str) -> str:
    """
    Generate a standalone audit trail PDF for a batch of signed documents.
    """
    buf = _build_audit_trail_page(
        signature_data_list[0] if signature_data_list else {},
        'Document Package'
    )
    with open(output_path, 'wb') as f:
        f.write(buf.read())
    return output_path


if __name__ == '__main__':
    # Test typed signature rendering
    print("Testing typed signature render...")
    b64 = render_typed_signature("Erik Peter Osol")
    if b64:
        raw = base64.b64decode(b64)
        with open('/tmp/test_typed_sig.png', 'wb') as f:
            f.write(raw)
        print(f"Typed sig PNG: {len(raw)} bytes → /tmp/test_typed_sig.png")

    # Test audit trail
    print("\nTesting audit trail...")
    sig_data = {
        'image_base64': b64,
        'signer_name': 'Erik Peter Osol',
        'date': '04/03/2026',
        'ip_address': '192.168.1.1',
        'timestamp': '2026-04-03T05:00:00Z',
    }
    generate_audit_trail_page([sig_data], '/tmp/test_audit_trail.pdf')
    print("Audit trail → /tmp/test_audit_trail.pdf")

    # Test embed on SBA 413 if it exists
    sba_blank = '/tmp/sba_413_blank.pdf'
    if os.path.exists(sba_blank):
        print("\nTesting sig embed on SBA 413...")
        embed_signature_in_pdf(sba_blank, '/tmp/test_sba_signed.pdf', sig_data)
        print("Signed SBA 413 → /tmp/test_sba_signed.pdf")
