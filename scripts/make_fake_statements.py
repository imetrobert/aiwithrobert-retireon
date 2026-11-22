#!/usr/bin/env python3
"""Makes the FAKE CPP statement PDFs used by scripts/test_statements.py (tests/fixtures/*.pdf).
There is no public sample of the real layout, so these only imitate the legend on the Service Canada
page (columns Year / Your Contributions / Your Pensionable Earnings, codes M P Q, "Not yet available").
All numbers are invented. Needs: pip install reportlab. Run: python3 scripts/make_fake_statements.py"""
import os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

OUT = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures')
os.makedirs(OUT, exist_ok=True)
ROWS = [(1998, '$0.00', '$0.00'), (1999, '$450.20', '$11,250.00'), (2005, '$0.00', 'Q'),
        (2019, '$2,748.90', 'M'), (2023, '$3,754.45', 'M'), (2024, '$3,867.50', 'M'),
        (2025, '$1,200.00', '$26,500.00'), (2026, 'Not yet available', 'Not yet available')]

def build(name, estimates):
    c = canvas.Canvas(os.path.join(OUT, name), pagesize=letter)
    W, H = letter
    c.setFont('Helvetica-Bold', 15); c.drawString(60, H - 60, 'Canada Pension Plan Statement of Contributions')
    c.setFont('Helvetica', 9); c.drawString(60, H - 76, 'FAKE EXAMPLE - NOT A REAL PERSON')
    c.drawString(60, H - 100, 'Statement date: November 4, 2026')
    if estimates:
        c.drawString(60, H - 120, 'Estimated monthly CPP retirement pension at age 60: $410.25')
        c.drawString(60, H - 132, 'Estimated monthly CPP retirement pension at age 65: $640.10')
        c.drawString(60, H - 144, 'Estimated monthly CPP retirement pension at age 70: $909.00')
    y = H - 190
    c.setFont('Helvetica-Bold', 10)
    c.drawString(60, y, 'Year'); c.drawString(160, y, 'Your Contributions'); c.drawString(330, y, 'Your Pensionable Earnings')
    c.setFont('Helvetica', 10)
    for yr, a, b in ROWS:
        y -= 18
        c.drawString(60, y, str(yr)); c.drawString(160, y, a); c.drawString(330, y, b)
    c.setFont('Helvetica', 8); c.drawString(60, y - 30, 'M Maximum pensionable earnings   P Post-retirement benefit   Q Quebec Pension Plan')
    c.save()

build('fake-cpp-with-estimate.pdf', True)
build('fake-cpp-history-only.pdf', False)
print('wrote fixtures to', os.path.abspath(OUT))
