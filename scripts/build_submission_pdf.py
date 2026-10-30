"""Build the Chinese submission PDF from the versioned technical proposal."""
from pathlib import Path
import html
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Preformatted, Image, PageBreak, KeepTogether

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/submission/技术方案.md"
OUTPUT = ROOT / "output/pdf/技术文档.pdf"


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # Embed a font where available so reviewers do not need local CJK fonts.
    font_path = Path("C:/Windows/Fonts/simsun.ttc")
    font_name = "SubmissionCN" if font_path.exists() else "STSong-Light"
    if font_path.exists():
        pdfmetrics.registerFont(TTFont(font_name, str(font_path), subfontIndex=0))
    else:
        pdfmetrics.registerFont(UnicodeCIDFont(font_name))
    styles = getSampleStyleSheet()
    body = ParagraphStyle("Chinese", fontName=font_name, fontSize=10, leading=16,
                          spaceAfter=7, wordWrap="CJK", alignment=TA_LEFT, textColor=colors.HexColor("#243247"))
    h1 = ParagraphStyle("TitleCN", parent=body, fontSize=25, leading=35, spaceAfter=20)
    h2 = ParagraphStyle("HeadingCN", parent=body, fontSize=15, leading=23, spaceBefore=17, spaceAfter=10,
                        textColor=colors.HexColor("#17537a"), keepWithNext=True)
    small = ParagraphStyle("SmallCN", parent=body, fontSize=8, leading=12, spaceAfter=3)
    code = ParagraphStyle("CodeCN", parent=body, fontSize=9, leading=13, leftIndent=7,
                         backColor=colors.HexColor("#f0f4f8"), borderPadding=8)
    story = []
    def para(text, style=body):
        clean = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
        clean = re.sub(r"`([^`]+)`", r"\1", clean)
        return Paragraph(html.escape(clean), style)
    lines = SOURCE.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith("```"):
            content = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                content.append(lines[i])
                i += 1
            story.append(KeepTogether([Preformatted("\n".join(content), code)]))
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r"[-: ]+", c) for c in cells):
                    rows.append([para(c, small) for c in cells])
                i += 1
            widths = [49*mm, 61*mm, 60*mm] if len(rows[0]) == 3 else [170*mm/len(rows[0])]*len(rows[0])
            table = Table(rows, colWidths=widths, repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2edf5")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("GRID", (0, 0), (-1, -1), .35, colors.HexColor("#c7d3df")),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.extend([table, Spacer(1, 10)])
            continue
        elif line.startswith("# "):
            story.extend([Spacer(1, 25*mm), para(line[2:], h1)])
        elif line.startswith("## "):
            story.append(para(line[3:], h2))
        else:
            story.append(para(line))
        i += 1
    story.extend([PageBreak(), para("附录：工作台界面", h2),
        para("以下界面展示创作入口、Markdown 编辑预览、模板库和素材库，截图使用平台公共示例数据。")])
    from PIL import Image as PILImage
    for name, caption in [("01-create", "创作入口：目标、资料和生成要求"),
                          ("03-workbench", "工作台：Markdown、预览和配图入口"),
                          ("04-templates", "模板：公共示例与可编辑骨架"),
                          ("05-media", "素材库：原创公共示例")]:
        path = ROOT / "docs/submission/screenshots" / (name + ".png")
        with PILImage.open(path) as image:
            w, h = image.size
        story.extend([para(caption, h2), Image(str(path), width=166*mm, height=166*mm*h/w)])
    def footer(canvas, doc):
        canvas.setFont(font_name, 8)
        canvas.setFillColor(colors.HexColor("#63758a"))
        canvas.drawString(20*mm, 12*mm, "Open Publisher Web | 2026-10-30 | 推文创作与发布工作台")
        canvas.drawRightString(190*mm, 12*mm, str(doc.page))
    SimpleDocTemplate(str(OUTPUT), pagesize=(210*mm, 297*mm), rightMargin=20*mm,
        leftMargin=20*mm, topMargin=18*mm, bottomMargin=21*mm, title="Open Publisher Web 技术方案",
        author="Open Publisher Web").build(story, onFirstPage=footer, onLaterPages=footer)
    print(OUTPUT)


if __name__ == "__main__":
    build()
