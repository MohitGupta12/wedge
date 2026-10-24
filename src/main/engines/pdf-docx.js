// PDF -> Word that keeps the look of the document, not just its words.
//
// MuPDF reports every character with its font, size, color and position, and every
// image with its box. From that we rebuild Word paragraphs: runs with the same font,
// size, weight and color; alignment, indents and spacing measured from the page;
// tab stops for text that sits in columns; images where they appear; one Word section
// per PDF page with the same page size; repeated page numbers moved into footers.
const fsp = require('fs/promises');
const { lazy, outPath } = require('../util');
const { open } = require('./pdf');

const D = lazy('docx');
const TWIP = 20; // twentieths of a point
const PX = 96 / 72; // docx images are sized in 96 dpi pixels

// "ABCDEF+GillSansMT-BoldItalic" -> "Gill Sans MT"
const KNOWN = { Helvetica: 'Arial', ArialMT: 'Arial', TimesNewRomanPSMT: 'Times New Roman', TimesNewRoman: 'Times New Roman', Times: 'Times New Roman', CourierNewPSMT: 'Courier New', Courier: 'Courier New', Symbol: 'Symbol', ZapfDingbats: 'Wingdings' };
const KEEP_MT = new Set(['GillSansMT', 'CenturyGothic', 'BookmanOldStyle', 'FranklinGothic']);
function fontFamily(name) {
  let n = String(name || '').replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0].replace(/\s+/g, '');
  if (KNOWN[n]) return KNOWN[n];
  if (!KEEP_MT.has(n)) n = n.replace(/(PSMT|PS|MT)$/, '');
  return n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim() || 'Calibri';
}

const hex = (c) => (Array.isArray(c) && c.length >= 3 ? c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('') : '000000');

// ----- reading a page -----------------------------------------------------------

function readPage(m, page) {
  const bounds = page.getBounds();
  const fonts = new Map();
  const fontInfo = (font) => {
    const name = font.getName();
    if (!fonts.has(name)) {
      fonts.set(name, {
        family: fontFamily(name),
        // The font name is reliable; MuPDF's flags call some regular fonts bold.
        bold: /bold|black|heavy|semibold|demi/i.test(name),
        italic: /italic|oblique|-it$|-ital/i.test(name),
      });
    }
    return fonts.get(name);
  };
  const items = [];
  let block = null;
  let line = null;
  const st = page.toStructuredText('preserve-whitespace,preserve-images');
  st.walk({
    onImageBlock(bbox, _transform, image) {
      if (bbox[2] - bbox[0] < 4 || bbox[3] - bbox[1] < 4) return;
      try {
        let pix = image.toPixmap();
        const cs = pix.getColorSpace();
        if (cs && !cs.isRGB() && !cs.isGray()) pix = pix.convertToColorSpace(m.ColorSpace.DeviceRGB, true);
        items.push({ type: 'image', bbox, png: Buffer.from(pix.asPNG()) });
      } catch {
        // An image MuPDF can't decode is skipped rather than failing the document.
      }
    },
    beginTextBlock(bbox) {
      block = { bbox, lines: [] };
    },
    beginLine(bbox, _wmode, dir) {
      line = { bbox, dir, chars: [], block };
    },
    onChar(c, origin, font, size, quad, color) {
      const right = Math.max(quad[2], quad[6]);
      line.chars.push({ c, x: origin[0], y: origin[1], right, size, color: hex(color), font: fontInfo(font) });
    },
    endLine() {
      // Sideways labels and text printed outside the page (margin notes, hidden
      // page tags) aren't part of the document's flow.
      const sideways = Math.abs(line.dir?.[1] || 0) > 0.2;
      const offPage = line.bbox[0] >= bounds[2] - 1 || line.bbox[2] > bounds[2] + 2 || line.bbox[2] <= bounds[0] + 1;
      if (!sideways && !offPage && line.chars.some((ch) => ch.c.trim())) block.lines.push(line);
      line = null;
    },
    endTextBlock() {
      for (const l of block.lines) items.push({ type: 'line', ...summarize(l) });
      block = null;
    },
  });
  st.destroy?.();
  return { items, fills: readFills(m, page, bounds) };
}

// Filled shapes behind text (shaded paragraphs, highlighted boxes) as colored rectangles.
function readFills(m, page, bounds) {
  const fills = [];
  const pageArea = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
  const toRgb = (cs, c) => {
    if (cs?.isGray?.()) return [c[0], c[0], c[0]];
    if (cs?.isCMYK?.()) return [0, 1, 2].map((i) => (1 - c[i]) * (1 - c[3]));
    return c.slice(0, 3);
  };
  const stroke = new m.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 0, miterLimit: 10 });
  try {
    const device = new m.Device({
      fillPath(path, _evenOdd, ctm, cs, color, alpha) {
        if (alpha < 0.1 || !color?.length) return;
        const rgb = toRgb(cs, color);
        if (rgb.every((v) => v > 0.97)) return; // white
        const b = path.getBounds(stroke, ctm);
        const area = (b[2] - b[0]) * (b[3] - b[1]);
        if (b[2] - b[0] < 20 || b[3] - b[1] < 6 || area > pageArea * 0.9) return;
        fills.push({ bbox: b, color: hex(rgb) });
      },
    });
    page.run(device, m.Matrix.identity);
    device.close();
  } catch {
    // Shading is a nicety; a page MuPDF can't run this way just goes without it.
  }
  // Shading is often drawn one strip per line; stack strips of the same color and width.
  const merged = [];
  for (const fl of fills.sort((a, b) => a.bbox[1] - b.bbox[1])) {
    const overlapX = (p) => Math.min(p.bbox[2], fl.bbox[2]) - Math.max(p.bbox[0], fl.bbox[0]);
    const prev = merged.find((p) => p.color === fl.color && overlapX(p) > 0.6 * Math.min(p.bbox[2] - p.bbox[0], fl.bbox[2] - fl.bbox[0])
      && fl.bbox[1] <= p.bbox[3] + 2 && fl.bbox[3] >= p.bbox[1]);
    if (prev) prev.bbox = [Math.min(prev.bbox[0], fl.bbox[0]), Math.min(prev.bbox[1], fl.bbox[1]), Math.max(prev.bbox[2], fl.bbox[2]), Math.max(prev.bbox[3], fl.bbox[3])];
    else merged.push({ ...fl, bbox: [...fl.bbox] });
  }
  return merged;
}

function summarize(l) {
  const chars = l.chars;
  const visible = chars.filter((c) => c.c.trim());
  const size = median(visible.map((c) => c.size)) || 11;
  return {
    chars,
    block: l.block,
    left: visible[0].x,
    right: Math.max(...visible.map((c) => c.right)),
    baseline: median(visible.map((c) => c.y)),
    top: l.bbox[1],
    bottom: l.bbox[3],
    size,
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Two tall blocks side by side mean columns: keep MuPDF's block order then. Otherwise
// read top to bottom and join pieces of text that share a baseline into one line.
function orderItems(items, pageHeight) {
  const blocks = [...new Set(items.filter((i) => i.type === 'line').map((i) => i.block))];
  const tall = blocks.filter((b) => b.bbox[3] - b.bbox[1] > pageHeight * 0.25);
  const columns = tall.some((a) => tall.some((b) => a !== b && (a.bbox[2] <= b.bbox[0] || b.bbox[2] <= a.bbox[0])));
  if (columns) return items;
  // Group into rows first (table cells sit a little higher or lower than each other),
  // then read each row left to right.
  const lines = items.filter((i) => i.type === 'line').sort((a, b) => a.baseline - b.baseline);
  const rows = [];
  for (const l of lines) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.baseline - l.baseline) < Math.max(2, Math.min(row.size, l.size) * 0.45)) row.lines.push(l);
    else rows.push({ baseline: l.baseline, size: l.size, lines: [l] });
  }
  const merged = [];
  for (const row of rows) {
    let current = null;
    for (const l of row.lines.sort((a, b) => a.left - b.left)) {
      if (current && l.left >= current.right - 1) {
        current.chars = [...current.chars, ...l.chars];
        current.right = Math.max(current.right, l.right);
        current.top = Math.min(current.top, l.top);
        current.bottom = Math.max(current.bottom, l.bottom);
      } else {
        if (current) merged.push(current);
        current = { ...l };
      }
    }
    merged.push(current);
  }
  const images = items.filter((i) => i.type === 'image').map((i) => ({ ...i, baseline: i.bbox[1] }));
  return [...merged, ...images].sort((a, b) => a.baseline - b.baseline);
}

// ----- page furniture: page numbers and repeated headers/footers ---------------------

const normal = (t) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
const lineText = (l) => l.chars.map((c) => c.c).join('').replace(/\s+/g, ' ').trim();

function findFurniture(pages) {
  const seen = new Map();
  pages.forEach((p) => {
    const keys = new Set();
    for (const it of p.items) {
      if (it.type !== 'line') continue;
      const band = it.bottom < p.height * 0.12 ? 'top' : it.top > p.height * 0.88 ? 'bottom' : null;
      if (!band) continue;
      keys.add(`${band}|${normal(lineText(it))}`);
    }
    for (const k of keys) seen.set(k, (seen.get(k) || 0) + 1);
  });
  const repeated = new Set([...seen].filter(([k, n]) => n >= Math.max(2, pages.length / 2) || (k.endsWith('|#') && n >= 2)).map(([k]) => k));
  for (const p of pages) {
    p.header = [];
    p.footer = [];
    p.items = p.items.filter((it) => {
      if (it.type !== 'line') return true;
      const band = it.bottom < p.height * 0.12 ? 'top' : it.top > p.height * 0.88 ? 'bottom' : null;
      if (!band || !repeated.has(`${band}|${normal(lineText(it))}`)) return true;
      (band === 'top' ? p.header : p.footer).push(it);
      return false;
    });
  }
}

// ----- building Word paragraphs --------------------------------------------------------

function runsFor(line, area, indentLeft, tabStops) {
  const runs = [];
  let prev = null;
  let run = null;
  const flush = () => {
    if (run && (run.text || run.tab)) runs.push(run);
    run = null;
  };
  for (const ch of line.chars) {
    let gapTab = false;
    let gapSpace = false;
    if (prev && ch.c.trim()) {
      const gap = ch.x - prev.right;
      if (gap > Math.max(ch.size * 1.2, 6)) gapTab = true;
      else if (gap > ch.size * 0.15 && prev.c.trim()) gapSpace = true;
    }
    const style = `${ch.font.family}|${ch.font.bold}|${ch.font.italic}|${Math.round(ch.size * 2)}|${ch.color}`;
    if (gapTab) {
      flush();
      tabStops.push(Math.round((ch.x - area.left) * TWIP));
      run = { style, ch, text: '', tab: true };
    } else if (!run || run.style !== style) {
      flush();
      run = { style, ch, text: '' };
    }
    if (gapSpace) run.text += ' ';
    run.text += ch.c;
    if (ch.c.trim() || !prev || prev.c.trim()) prev = ch;
  }
  flush();
  return runs;
}

function textRuns(runs, joinSpace) {
  return runs.map((r, i) => {
    const text = (i === 0 && joinSpace ? ' ' : '') + r.text.replace(/\s+/g, ' ');
    const opts = {
      font: r.ch.font.family,
      size: Math.max(2, Math.round(r.ch.size * 2)),
      bold: r.ch.font.bold,
      italics: r.ch.font.italic,
      color: r.ch.color === '000000' ? undefined : r.ch.color,
    };
    return new D.TextRun(r.tab ? { ...opts, children: [new D.Tab(), text] } : { ...opts, text });
  });
}

// Lines become paragraphs: a line that wraps continues the paragraph; a short line,
// a bigger gap, a change of indent or size, or a tabbed line starts a new one.
function paragraphs(page, area) {
  const width = area.right - area.left;
  const out = [];
  let para = null;
  const finish = () => {
    if (para) out.push(para);
    para = null;
  };
  for (const it of page.items) {
    if (it.type === 'image') {
      finish();
      out.push({ type: 'image', item: it });
      continue;
    }
    const hasTab = it.chars.some((c, i) => i && c.c.trim() && c.x - it.chars[i - 1].right > Math.max(c.size * 1.2, 6));
    const last = para?.lines[para.lines.length - 1];
    // A line only wraps into the next one if the next line's first word wouldn't have
    // fitted in the room left at the end of this line.
    const firstWord = (l) => {
      const visible = l.chars.filter((c) => c.c.trim());
      const end = l.chars.findIndex((c, i) => i > 0 && !c.c.trim() && l.chars[i - 1].c.trim());
      const word = end > 0 ? l.chars.slice(0, end).filter((c) => c.c.trim()) : visible;
      return word.length ? word[word.length - 1].right - word[0].x : 0;
    };
    const continues = para && !hasTab && !para.tabbed && last
      && it.baseline - last.baseline < last.size * 1.9
      && Math.abs(it.size - last.size) < last.size * 0.15
      && area.right - last.right < firstWord(it) + last.size * 0.6
      && Math.abs(it.left - (para.lines[1] || it).left) < last.size * 1.5
      && it.left < last.left + width * 0.3;
    if (!continues) {
      finish();
      para = { type: 'text', lines: [], tabbed: hasTab };
    }
    para.lines.push(it);
  }
  finish();
  return out;
}

function alignment(lines, area) {
  const width = area.right - area.left;
  const centered = (l) => Math.abs((l.left - area.left) - (area.right - l.right)) < Math.max(width * 0.04, 8) && l.left - area.left > width * 0.06;
  if (lines.every(centered)) return D.AlignmentType.CENTER;
  if (lines.length === 1 && area.right - lines[0].right < width * 0.03 && lines[0].left - area.left > width * 0.35) return D.AlignmentType.RIGHT;
  if (lines.length > 1) {
    const maxRight = Math.max(...lines.map((l) => l.right));
    if (lines.slice(0, -1).every((l) => maxRight - l.right < width * 0.02) && maxRight > area.right - width * 0.05) return D.AlignmentType.JUSTIFIED;
  }
  return D.AlignmentType.LEFT;
}

function buildParagraph(p, prevBottom, area, fills = []) {
  const first = p.lines[0];
  const rest = p.lines[1] || first;
  // Tabbed rows (contents, tables) need a fixed left edge for their tab stops to line up.
  const align = p.tabbed ? D.AlignmentType.LEFT : alignment(p.lines, area);
  const plain = align === D.AlignmentType.LEFT || align === D.AlignmentType.JUSTIFIED;
  const indentLeft = plain ? Math.max(0, rest.left - area.left) : 0;
  const firstLine = plain ? first.left - area.left - indentLeft : 0;
  const tabStops = [];
  const children = [];
  p.lines.forEach((l, i) => {
    const runs = runsFor(l, area, indentLeft, tabStops);
    const prevText = i ? p.lines[i - 1].chars.map((c) => c.c).join('') : '';
    children.push(...textRuns(runs, i > 0 && !/\s$/.test(prevText)));
  });
  // Exact line height from the PDF (baseline to baseline), so Word can't drift.
  // With exact spacing Word puts the baseline about 80% down each line box.
  const gaps = p.lines.slice(1).map((l, i) => l.baseline - p.lines[i].baseline);
  const lineHeight = gaps.length ? Math.max(first.size * 0.8, median(gaps)) : first.size * 1.15;
  const before = Math.max(0, first.baseline - lineHeight * 0.8 - prevBottom);
  // A tab whose text ends at the right margin (page numbers in a contents page) is a right tab.
  const rightEdge = p.tabbed && Math.abs(Math.max(...p.lines.map((l) => l.right)) - area.right) < (area.right - area.left) * 0.04;
  const stops = [...new Set(tabStops)].filter((t) => t > 0).sort((a, b) => a - b);
  const box = { left: Math.min(...p.lines.map((l) => l.left)), right: Math.max(...p.lines.map((l) => l.right)), top: Math.min(...p.lines.map((l) => l.top)), bottom: Math.max(...p.lines.map((l) => l.bottom)) };
  const fill = fills.find((fl) => fl.bbox[1] <= box.top + 4 && fl.bbox[3] >= box.bottom - 4
    && Math.min(fl.bbox[2], box.right) - Math.max(fl.bbox[0], box.left) > (box.right - box.left) * 0.8);
  const paragraph = new D.Paragraph({
    children,
    alignment: align,
    shading: fill ? { type: D.ShadingType.CLEAR, color: 'auto', fill: fill.color } : undefined,
    indent: { left: Math.round(indentLeft * TWIP), ...(firstLine >= 0 ? { firstLine: Math.round(firstLine * TWIP) } : { hanging: Math.round(-firstLine * TWIP) }) },
    spacing: { before: Math.min(1440, Math.round(before * TWIP)), after: 0, line: Math.round(lineHeight * TWIP), lineRule: D.LineRuleType.EXACT },
    tabStops: stops.map((pos, i) => ({
      type: rightEdge && i === stops.length - 1 ? D.TabStopType.RIGHT : D.TabStopType.LEFT,
      position: rightEdge && i === stops.length - 1 ? Math.round((area.right - area.left) * TWIP) : pos,
    })),
  });
  // Where this paragraph ends in Word: just under its last baseline.
  return { paragraph, end: p.lines[p.lines.length - 1].baseline + lineHeight * 0.2 };
}

function imageParagraph(it, prevBottom, area) {
  const [x0, y0, x1, y1] = it.bbox;
  const w = Math.min(x1 - x0, area.right - area.left);
  const h = (y1 - y0) * (w / (x1 - x0));
  const centered = Math.abs((x0 - area.left) - (area.right - x1)) < (area.right - area.left) * 0.05;
  return new D.Paragraph({
    alignment: centered ? D.AlignmentType.CENTER : D.AlignmentType.LEFT,
    indent: centered ? undefined : { left: Math.round(Math.max(0, x0 - area.left) * TWIP) },
    spacing: { before: Math.min(1440, Math.round(Math.max(0, y0 - prevBottom) * TWIP)), after: 0 },
    children: [new D.ImageRun({ type: 'png', data: it.png, transformation: { width: Math.round(w * PX), height: Math.round(h * PX) } })],
  });
}

// Pinned to the page at the PDF's position, behind the text, taking no room in the flow.
const EMU = 12700; // per point
function floatingImage(it) {
  const [x0, y0, x1, y1] = it.bbox;
  return new D.ImageRun({
    type: 'png',
    data: it.png,
    transformation: { width: Math.round((x1 - x0) * PX), height: Math.round((y1 - y0) * PX) },
    floating: {
      horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.PAGE, offset: Math.round(x0 * EMU) },
      verticalPosition: { relative: D.VerticalPositionRelativeFrom.PAGE, offset: Math.round(y0 * EMU) },
      behindDocument: true,
      allowOverlap: true,
      wrap: { type: D.TextWrappingType.NONE },
    },
  });
}

// Header/footer lines: digits that look like the page number become a live PAGE field.
function furniture(lines, pageNo, area) {
  return lines.map((l) => {
    const text = lineText(l);
    const ch = l.chars.find((c) => c.c.trim());
    const opts = { font: ch.font.family, size: Math.round(ch.size * 2), bold: ch.font.bold, italics: ch.font.italic };
    const parts = text.split(/(\d+)/).filter(Boolean).map((part) => (/^\d+$/.test(part) && +part === pageNo
      ? new D.TextRun({ ...opts, children: [D.PageNumber.CURRENT] })
      : new D.TextRun({ ...opts, text: part })));
    const align = alignment([l], area);
    return new D.Paragraph({
      alignment: align,
      indent: align === D.AlignmentType.LEFT ? { left: Math.round(Math.max(0, l.left - area.left) * TWIP) } : undefined,
      children: parts,
    });
  });
}

// ----- the document ---------------------------------------------------------------------

async function convert(file) {
  const { m, doc } = await open(file);
  const pages = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    const width = x1 - x0;
    const height = y1 - y0;
    const read = readPage(m, page);
    const fills = read.fills.map((fl) => ({ ...fl, bbox: [fl.bbox[0] - x0, fl.bbox[1] - y0, fl.bbox[2] - x0, fl.bbox[3] - y0] }));
    const items = read.items.map((it) => (it.type === 'line'
      ? { ...it, left: it.left - x0, right: it.right - x0, baseline: it.baseline - y0, top: it.top - y0, bottom: it.bottom - y0, chars: it.chars.map((c) => ({ ...c, x: c.x - x0, right: c.right - x0, y: c.y - y0 })) }
      : { ...it, bbox: [it.bbox[0] - x0, it.bbox[1] - y0, it.bbox[2] - x0, it.bbox[3] - y0] }));
    pages.push({ width, height, fills, items: orderItems(items, height) });
    page.destroy?.();
  }
  findFurniture(pages);

  const sections = pages.map((p, index) => {
    // Page borders, backgrounds and anything text is printed over float behind the
    // text at their exact position; only standalone pictures take space in the flow.
    const lines = p.items.filter((it) => it.type === 'line');
    const overlapsText = (b) => lines.some((l) => l.left < b[2] && l.right > b[0] && l.top < b[3] && l.bottom > b[1]);
    const isFloat = (it) => it.type === 'image'
      && ((it.bbox[2] - it.bbox[0]) * (it.bbox[3] - it.bbox[1]) > p.width * p.height * 0.3 || overlapsText(it.bbox));
    const floats = p.items.filter(isFloat);
    p.items = p.items.filter((it) => !isFloat(it));
    // The content area becomes the page margins.
    const boxes = p.items.map((it) => (it.type === 'line' ? [it.left, it.top, it.right, it.bottom] : it.bbox));
    const area = boxes.length
      ? { left: Math.min(...boxes.map((b) => b[0])), top: Math.min(...boxes.map((b) => b[1])), right: Math.max(...boxes.map((b) => b[2])), bottom: Math.max(...boxes.map((b) => b[3])) }
      : { left: 72, top: 72, right: p.width - 72, bottom: p.height - 72 };
    const clampMargin = (v) => Math.round(Math.min(144, Math.max(18, v)) * TWIP);
    const margin = { left: clampMargin(area.left), right: clampMargin(p.width - area.right), top: clampMargin(area.top), bottom: clampMargin(p.height - area.bottom) };
    area.left = margin.left / TWIP;
    area.right = p.width - margin.right / TWIP;
    let prevBottom = margin.top / TWIP;
    const children = [];
    for (const block of paragraphs(p, area)) {
      if (block.type === 'image') {
        children.push(imageParagraph(block.item, prevBottom, area));
        prevBottom = block.item.bbox[3];
      } else {
        const { paragraph, end } = buildParagraph(block, prevBottom, area, p.fills);
        children.push(paragraph);
        prevBottom = end;
      }
    }
    if (!children.length) children.push(new D.Paragraph({ children: [] }));
    // Backgrounds live in the header, like Word's watermarks: that layer is drawn
    // first, so body text and footers stay on top of them.
    const headerChildren = [
      ...(floats.length ? [new D.Paragraph({ spacing: { before: 0, after: 0 }, children: floats.map((it) => floatingImage(it)) })] : []),
      ...furniture(p.header, index + 1, area),
    ];
    return {
      properties: {
        page: {
          size: { width: Math.round(p.width * TWIP), height: Math.round(p.height * TWIP) },
          margin: {
            ...margin,
            header: Math.round(Math.min(144, Math.max(9, p.header.length ? Math.min(...p.header.map((l) => l.top)) : 18)) * TWIP),
            footer: Math.round(Math.min(144, Math.max(9, p.footer.length ? p.height - Math.max(...p.footer.map((l) => l.bottom)) : 18)) * TWIP),
          },
        },
      },
      headers: headerChildren.length ? { default: new D.Header({ children: headerChildren }) } : undefined,
      footers: p.footer.length ? { default: new D.Footer({ children: furniture(p.footer, index + 1, area) }) } : undefined,
      children,
    };
  });

  const document = new D.Document({
    creator: 'Wedge',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections,
  });
  const out = outPath(file, 'docx');
  await fsp.writeFile(out, await D.Packer.toBuffer(document));
  return [out];
}

module.exports = { convert, fontFamily };
