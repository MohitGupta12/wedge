// PDF rendering, text extraction and page tools. MuPDF (WASM) renders and
// re-saves; pdf-lib handles page surgery like merge, split and rotate.
const fsp = require('fs/promises');
const path = require('path');
const pdfLib = require('../util').lazy('pdf-lib');
const { ext, base, outDir, outPath, uniqueDir, escapeHtml, parseRanges } = require('../util');

let muPromise;
const mu = () => (muPromise ||= import('mupdf'));

const MIME = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xps: 'application/oxps',
  cbz: 'application/x-cbz',
  fb2: 'application/x-fictionbook',
  mobi: 'application/x-mobipocket-ebook',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  txt: 'text/plain',
};

async function open(file) {
  const m = await mu();
  const doc = m.Document.openDocument(await fsp.readFile(file), MIME[ext(file)] || 'application/pdf');
  if (doc.needsPassword()) throw new Error('This PDF is password protected');
  if (doc.isReflowable()) doc.layout(595, 842, 11);
  return { m, doc };
}

async function pageCount(file) {
  const { doc } = await open(file);
  return doc.countPages();
}

// Renders each page to PNG/JPG. One page -> one file, otherwise a folder.
// `nameFrom` names and places the output when `file` is a temporary PDF.
async function toImages(file, format, settings = {}, progress, nameFrom = file) {
  const { m, doc } = await open(file);
  const dpi = settings.pdfDpi || 200;
  const n = doc.countPages();
  const matrix = m.Matrix.scale(dpi / 72, dpi / 72);
  let dir = null;
  if (n > 1) {
    dir = uniqueDir(path.join(outDir(nameFrom), `${base(nameFrom)} pages`));
    await fsp.mkdir(dir, { recursive: true });
  }
  const outs = [];
  for (let i = 0; i < n; i++) {
    const pix = doc.loadPage(i).toPixmap(matrix, m.ColorSpace.DeviceRGB, false, true);
    const bytes = format === 'png' ? pix.asPNG() : pix.asJPEG(90);
    const out = dir ? path.join(dir, `${base(nameFrom)}-${String(i + 1).padStart(3, '0')}.${format}`) : outPath(nameFrom, format);
    await fsp.writeFile(out, bytes);
    outs.push(out);
    progress?.((i + 1) / n);
  }
  return dir ? [dir] : outs;
}

// Extracts text as simple semantic HTML, guessing headings from font size.
async function toHtml(file) {
  const { doc } = await open(file);
  const n = doc.countPages();
  const lines = [];
  for (let i = 0; i < n; i++) {
    const st = JSON.parse(doc.loadPage(i).toStructuredText('preserve-whitespace').asJSON());
    for (const block of st.blocks || []) {
      if (block.type !== 'text') continue;
      const text = block.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const size = Math.max(...block.lines.map((l) => l.font?.size || 0));
      const bold = block.lines.every((l) => l.font?.weight === 'bold');
      lines.push({ text, size, bold });
    }
  }
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  const html = lines.map(({ text, size, bold }) => {
    if (size >= body * 1.6) return `<h1>${escapeHtml(text)}</h1>`;
    if (size >= body * 1.25 || (bold && text.length < 90)) return `<h2>${escapeHtml(text)}</h2>`;
    return `<p>${escapeHtml(text)}</p>`;
  });
  return { title: base(file), html: html.join('\n') };
}

async function toText(file) {
  const { doc } = await open(file);
  const parts = [];
  for (let i = 0; i < doc.countPages(); i++) parts.push(doc.loadPage(i).toStructuredText().asText().trim());
  const out = outPath(file, 'txt');
  await fsp.writeFile(out, parts.join('\n\n\f\n\n'));
  return [out];
}

// Lays out any MuPDF-readable document (DOCX, PPTX, XLSX, EPUB...) as PDF.
async function renderToPdf(file, out) {
  const { m, doc } = await open(file);
  const buf = new m.Buffer();
  const writer = new m.DocumentWriter(buf, 'pdf', '');
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const dev = writer.beginPage(page.getBounds());
    page.run(dev, m.Matrix.identity);
    writer.endPage();
  }
  writer.close();
  await fsp.writeFile(out, buf.asUint8Array());
  return out;
}

async function toPptx(file, _settings, progress) {
  const PptxGen = require('pptxgenjs');
  const { m, doc } = await open(file);
  const n = doc.countPages();
  const [x0, y0, x1, y1] = doc.loadPage(0).getBounds();
  const w = (x1 - x0) / 72;
  const h = (y1 - y0) / 72;
  const pptx = new PptxGen();
  pptx.defineLayout({ name: 'PDF', width: w, height: h });
  pptx.layout = 'PDF';
  for (let i = 0; i < n; i++) {
    const png = doc.loadPage(i).toPixmap(m.Matrix.scale(2, 2), m.ColorSpace.DeviceRGB, false, true).asPNG();
    pptx.addSlide().addImage({ data: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, x: 0, y: 0, w, h });
    progress?.((i + 1) / n);
  }
  const out = outPath(file, 'pptx');
  await fsp.writeFile(out, await pptx.write({ outputType: 'nodebuffer' }));
  return [out];
}

async function loadLib(file) {
  return pdfLib.PDFDocument.load(await fsp.readFile(file), { ignoreEncryption: true });
}

async function merge(files) {
  const out = await pdfLib.PDFDocument.create();
  for (const f of files) {
    const src = await loadLib(f);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  const target = outPath(files[0], 'pdf', ' (merged)');
  await fsp.writeFile(target, await out.save());
  return [target];
}

async function pick(file, indices, suffix) {
  const src = await loadLib(file);
  const out = await pdfLib.PDFDocument.create();
  for (const p of await out.copyPages(src, indices)) out.addPage(p);
  const target = outPath(file, 'pdf', suffix);
  await fsp.writeFile(target, await out.save());
  return target;
}

async function split(file, opts) {
  const src = await loadLib(file);
  const n = src.getPageCount();
  const every = Math.max(1, Number(opts.every) || 1);
  const dir = uniqueDir(path.join(outDir(file), `${base(file)} split`));
  await fsp.mkdir(dir, { recursive: true });
  for (let start = 0; start < n; start += every) {
    const out = await pdfLib.PDFDocument.create();
    const idx = [];
    for (let i = start; i < Math.min(n, start + every); i++) idx.push(i);
    for (const p of await out.copyPages(src, idx)) out.addPage(p);
    const label = idx.length > 1 ? `${start + 1}-${idx[idx.length - 1] + 1}` : `${start + 1}`;
    await fsp.writeFile(path.join(dir, `${base(file)} p${label}.pdf`), await out.save());
  }
  return [dir];
}

async function extract(file, opts) {
  const n = (await loadLib(file)).getPageCount();
  return [await pick(file, parseRanges(opts.pages, n), ` (pages ${String(opts.pages).replace(/\s/g, '')})`)];
}

async function removePages(file, opts) {
  const n = (await loadLib(file)).getPageCount();
  const drop = new Set(parseRanges(opts.pages, n));
  const keep = [...Array(n).keys()].filter((i) => !drop.has(i));
  if (!keep.length) throw new Error('That would remove every page');
  return [await pick(file, keep, '-edited')];
}

async function rotate(file, opts) {
  const doc = await loadLib(file);
  const angle = Number(opts.angle) || 90;
  const n = doc.getPageCount();
  const which = opts.pages ? new Set(parseRanges(opts.pages, n)) : null;
  doc.getPages().forEach((p, i) => {
    if (!which || which.has(i)) p.setRotation(pdfLib.degrees((p.getRotation().angle + angle) % 360));
  });
  const out = outPath(file, 'pdf', '-rotated');
  await fsp.writeFile(out, await doc.save());
  return [out];
}

async function compress(file) {
  const { doc } = await open(file);
  const pdf = doc.asPDF();
  const bytes = pdf.saveToBuffer('garbage=deduplicate,compress=yes,compress-fonts=yes,compress-images=yes').asUint8Array();
  const out = outPath(file, 'pdf', '-compressed');
  await fsp.writeFile(out, bytes);
  return [out];
}

async function protect(file, opts) {
  if (!opts.password) throw new Error('Enter a password');
  if (/[,=]/.test(opts.password)) throw new Error('Passwords cannot contain commas or equals signs');
  const { doc } = await open(file);
  const bytes = doc.asPDF().saveToBuffer(`encrypt=aes-256,user-password=${opts.password},owner-password=${opts.password},garbage=yes`).asUint8Array();
  const out = outPath(file, 'pdf', '-protected');
  await fsp.writeFile(out, bytes);
  return [out];
}

// Reorders pages; repeating a number duplicates that page ("3, 1, 2, 2, 5-").
async function organize(file, opts) {
  const n = (await loadLib(file)).getPageCount();
  return [await pick(file, parseRanges(opts.order, n), '-organized')];
}

async function metadata(file, opts) {
  const doc = await pdfLib.PDFDocument.load(await fsp.readFile(file), { ignoreEncryption: true, updateMetadata: false });
  const strip = opts.action === 'strip';
  if (strip) {
    doc.setTitle('');
    doc.setAuthor('');
    doc.setSubject('');
    doc.setKeywords([]);
    doc.setCreator('');
    doc.setProducer('');
    doc.catalog.delete(pdfLib.PDFName.of('Metadata')); // XMP packet
  } else {
    if (opts.title) doc.setTitle(opts.title);
    if (opts.author) doc.setAuthor(opts.author);
    if (opts.subject) doc.setSubject(opts.subject);
    if (opts.keywords) doc.setKeywords(opts.keywords.split(',').map((k) => k.trim()).filter(Boolean));
  }
  const out = outPath(file, 'pdf', strip ? '-clean' : '-tagged');
  await fsp.writeFile(out, await doc.save());
  return [out];
}

// Rebuilds tables from text positions: lines on the same baseline become a
// row, and x positions shared across rows become columns. One sheet per page.
async function toXlsx(file) {
  const XLSX = require('xlsx');
  const { doc } = await open(file);
  const wb = XLSX.utils.book_new();
  const box = (b) => (Array.isArray(b) ? { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] } : b);
  for (let i = 0; i < doc.countPages(); i++) {
    const st = JSON.parse(doc.loadPage(i).toStructuredText().asJSON());
    const cells = [];
    for (const block of st.blocks || []) {
      if (block.type !== 'text') continue;
      for (const line of block.lines) {
        const text = (line.text || '').trim();
        if (!text) continue;
        const b = box(line.bbox);
        cells.push({ text, x: b.x, y: b.y + b.h / 2, h: b.h });
      }
    }
    cells.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const c of cells) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row.y - c.y) <= Math.max(2, c.h * 0.4)) row.cells.push(c);
      else rows.push({ y: c.y, cells: [c] });
    }
    const starts = [];
    for (const c of cells) if (!starts.some((s) => Math.abs(s - c.x) < 8)) starts.push(c.x);
    starts.sort((a, b) => a - b);
    const column = (x) => starts.reduce((best, s, idx) => (Math.abs(s - x) < Math.abs(starts[best] - x) ? idx : best), 0);
    const aoa = rows.map((r) => {
      const out = [];
      for (const c of r.cells.sort((a, b) => a.x - b.x)) {
        let col = column(c.x);
        while (out[col] !== undefined) col++;
        const num = /^-?[\d,]*\.?\d+%?$/.test(c.text) && !/^0\d/.test(c.text) ? Number(c.text.replace(/[,%]/g, '')) : NaN;
        out[col] = Number.isFinite(num) ? num : c.text;
      }
      return Array.from(out, (v) => v ?? '');
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [['']]), `Page ${i + 1}`);
  }
  const out = outPath(file, 'xlsx');
  XLSX.writeFile(wb, out, { compression: true });
  return [out];
}

async function hasText(file) {
  const { doc } = await open(file);
  for (let i = 0; i < doc.countPages(); i++) {
    if (doc.loadPage(i).toStructuredText().asText().trim()) return true;
  }
  return false;
}

module.exports = { open, toImages, toHtml, toText, toPptx, toXlsx, renderToPdf, hasText, merge, split, extract, removePages, rotate, compress, protect, organize, metadata, pageCount };
