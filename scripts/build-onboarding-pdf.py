#!/usr/bin/env python3
"""Render docs/new-user-onboarding.md → docs/new-user-onboarding.pdf."""
import os, re
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle)
from reportlab.lib.enums import TA_LEFT

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO_ROOT, 'docs', 'new-user-onboarding.md')
OUT = os.path.join(REPO_ROOT, 'docs', 'new-user-onboarding.pdf')

styles = getSampleStyleSheet()
BRAND = colors.HexColor('#0a84ff')
DARK = colors.HexColor('#1c1c1e')
MUTED = colors.HexColor('#6b7280')

styles.add(ParagraphStyle('AceTitle', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=26, leading=30, textColor=BRAND, spaceAfter=4, alignment=TA_LEFT))
styles.add(ParagraphStyle('AceSubtitle', parent=styles['Normal'], fontName='Helvetica', fontSize=12, leading=16, textColor=MUTED, spaceAfter=18))
styles.add(ParagraphStyle('AceH2', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=15, leading=20, textColor=DARK, spaceBefore=14, spaceAfter=6))
styles.add(ParagraphStyle('AceH3', parent=styles['Heading3'], fontName='Helvetica-Bold', fontSize=12, leading=16, textColor=DARK, spaceBefore=8, spaceAfter=4))
styles.add(ParagraphStyle('AceBody', parent=styles['BodyText'], fontName='Helvetica', fontSize=10.5, leading=15, textColor=DARK, spaceAfter=6))
styles.add(ParagraphStyle('AceQuote', parent=styles['Normal'], fontName='Helvetica-Oblique', fontSize=10.5, leading=15, textColor=BRAND, leftIndent=14, borderPadding=(8,10,8,10), backColor=colors.HexColor('#e6f1ff'), spaceAfter=8))
styles.add(ParagraphStyle('AceList', parent=styles['BodyText'], fontName='Helvetica', fontSize=10.5, leading=15, textColor=DARK, leftIndent=18, spaceAfter=3))

def md_inline(s):
    s = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'(?<!\*)\*([^*\s][^*]*[^*\s]|[^*\s])\*(?!\*)', r'<i>\1</i>', s)
    s = re.sub(r'`([^`]+)`', r'<font face="Courier" color="#444444">\1</font>', s)
    return s

def parse_table(rows):
    out = []
    for r in rows:
        cells = [c.strip() for c in r.strip().strip('|').split('|')]
        if all(re.match(r'^:?-+:?$', c) for c in cells if c):
            continue
        out.append(cells)
    return out

def parse_md(md):
    lines = md.split('\n'); i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip(): i += 1; continue
        if line.startswith('# '): yield ('title', line[2:].strip()); i += 1; continue
        if line.startswith('## '): yield ('h2', line[3:].strip()); i += 1; continue
        if line.startswith('### '): yield ('h3', line[4:].strip()); i += 1; continue
        if line.startswith('---'): yield ('hr', None); i += 1; continue
        if line.startswith('> '): yield ('quote', line[2:].strip()); i += 1; continue
        if line.startswith('| '):
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith('|'):
                rows.append(lines[i]); i += 1
            yield ('table', rows); continue
        if re.match(r'^\d+\.\s', line):
            items = []
            while i < len(lines) and re.match(r'^\d+\.\s', lines[i].rstrip()):
                items.append(re.sub(r'^\d+\.\s', '', lines[i]).strip()); i += 1
            yield ('ol', items); continue
        if line.startswith('- '):
            items = []
            while i < len(lines) and lines[i].rstrip().startswith('- '):
                items.append(lines[i].rstrip()[2:].strip()); i += 1
            yield ('ul', items); continue
        para = [line]; i += 1
        while i < len(lines) and lines[i].strip() and not (lines[i].startswith('#') or lines[i].startswith('>') or lines[i].startswith('|') or lines[i].startswith('- ') or re.match(r'^\d+\.\s', lines[i]) or lines[i].startswith('---')):
            para.append(lines[i].rstrip()); i += 1
        yield ('p', ' '.join(para))

def build():
    with open(SRC, 'r', encoding='utf-8') as f: md = f.read()
    doc = SimpleDocTemplate(OUT, pagesize=letter, leftMargin=0.7*inch, rightMargin=0.7*inch, topMargin=0.7*inch, bottomMargin=0.7*inch, title='ACE Dialer — New User Onboarding', author='ApTask')
    story = []
    first_para_after_title = True
    for kind, payload in parse_md(md):
        if kind == 'title': story.append(Paragraph(md_inline(payload), styles['AceTitle']))
        elif kind == 'h2': story.append(Paragraph(md_inline(re.sub(r'^\d+\.\s*', '', payload)), styles['AceH2']))
        elif kind == 'h3': story.append(Paragraph(md_inline(payload), styles['AceH3']))
        elif kind == 'p':
            style = styles['AceSubtitle'] if first_para_after_title else styles['AceBody']
            first_para_after_title = False
            story.append(Paragraph(md_inline(payload), style))
        elif kind == 'quote': story.append(Paragraph(md_inline(payload), styles['AceQuote']))
        elif kind == 'hr': story.append(Spacer(1, 6))
        elif kind == 'ol':
            for idx, item in enumerate(payload, 1):
                story.append(Paragraph(f'<b>{idx}.</b>  {md_inline(item)}', styles['AceList']))
            story.append(Spacer(1, 4))
        elif kind == 'ul':
            for item in payload:
                story.append(Paragraph(f'•  {md_inline(item)}', styles['AceList']))
            story.append(Spacer(1, 4))
        elif kind == 'table':
            rows = parse_table(payload)
            if not rows: continue
            table_data = [[Paragraph(md_inline(c), styles['AceBody']) for c in r] for r in rows]
            t = Table(table_data, colWidths=[1.4*inch, 4.6*inch], hAlign='LEFT')
            t.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#f0f6ff')),
                ('TEXTCOLOR', (0,0), (-1,0), BRAND),
                ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
                ('FONTSIZE', (0,0), (-1,-1), 9.5),
                ('VALIGN', (0,0), (-1,-1), 'TOP'),
                ('LEFTPADDING', (0,0), (-1,-1), 8),
                ('RIGHTPADDING', (0,0), (-1,-1), 8),
                ('TOPPADDING', (0,0), (-1,-1), 6),
                ('BOTTOMPADDING', (0,0), (-1,-1), 6),
                ('LINEBELOW', (0,0), (-1,-1), 0.4, colors.HexColor('#dbe5ee')),
            ]))
            story.append(t); story.append(Spacer(1, 6))
    doc.build(story)
    print(f'Generated {OUT}  ({os.path.getsize(OUT)} bytes)')

if __name__ == '__main__':
    build()
