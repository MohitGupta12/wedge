// Document conversion. Every input is read into HTML, then written out to the
// target format, so N inputs x M outputs needs only N readers and M writers.
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { ext, base, outPath, escapeHtml, withTemp } = require('../util');
const office = require('./office');
const pdf = require('./pdf');

let printer = null; // (htmlFile, outPdf) => Promise, provided by the Electron main process
function setPrinter(fn) {
  printer = fn;
}

const PRINT_CSS = `
  body { font: 11pt/1.55 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #1d1d1f; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  h1, h2, h3 { line-height: 1.25; margin: 1.4em 0 .5em; }
  img { max-width: 100%; height: auto; }
  pre, code { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: .92em; }
  pre { background: #f5f5f7; padding: .8rem 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #d2d2d7; padding: .35rem .6rem; text-align: left; vertical-align: top; }
  th { background: #f5f5f7; }
  blockquote { border-left: 3px solid #d2d2d7; margin: 1rem 0; padding: 0 1rem; color: #555; }
  @media print { body { margin: 0; max-width: none; } }
`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}

function textToHtml(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// Crude RTF reader used only when LibreOffice is not installed.
function rtfToText(rtf) {
  return rtf
    .replace(/\\par[d]?/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(n < 0 ? n + 65536 : +n))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function epubToHtml(file) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(file);
  const read = (p) => zip.readAsText(p.replace(/^\//, ''));
  const container = read('META-INF/container.xml');
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error('Not a valid EPUB');
  const opf = read(opfPath);
  const dir = path.posix.dirname(opfPath);
  const manifest = {};
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0])?.[1];
    const href = /href="([^"]+)"/.exec(m[0])?.[1];
    if (id && href) manifest[id] = decodeURIComponent(href);
  }
  const title = /<dc:title[^>]*>([^<]*)</.exec(opf)?.[1] || base(file);
  const chapters = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
    const href = manifest[m[1]];
    if (!href) continue;
    const xhtml = read(dir === '.' ? href : `${dir}/${href}`);
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(xhtml)?.[1] || '';
    chapters.push(body.replace(/<img\b[^>]*>/gi, '').replace(/<image\b[^>]*\/?>/gi, ''));
  }
  return { title, html: chapters.join('\n<hr>\n') };
}

async function readHtml(file) {
  const e = ext(file);
  const title = base(file);
  if (e === 'docx') {
    const mammoth = require('mammoth');
    const { value } = await mammoth.convertToHtml({ path: file });
    return { title, html: value };
  }
  if (e === 'md' || e === 'markdown') {
    const { marked } = require('marked');
    return { title, html: marked.parse(await fsp.readFile(file, 'utf8')), baseDir: path.dirname(file) };
  }
  if (e === 'txt' || e === 'text' || e === 'log') return { title, html: textToHtml(await fsp.readFile(file, 'utf8')) };
  if (e === 'html' || e === 'htm' || e === 'xhtml') {
    const src = await fsp.readFile(file, 'utf8');
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(src)?.[1] ?? src;
    return { title: /<title>([^<]*)</i.exec(src)?.[1] || title, html: body, baseDir: path.dirname(file) };
  }
  if (e === 'epub') return epubToHtml(file);
  if (e === 'pdf') return pdf.toHtml(file);
  if (e === 'rtf' || e === 'odt' || e === 'doc' || e === 'wpd') {
    if (office.available()) {
      return withTemp(async (dir) => {
        const docx = await office.convert(file, 'docx', dir);
        return { ...(await readHtml(docx)), title };
      });
    }
    if (e === 'rtf') return { title, html: textToHtml(rtfToText(await fsp.readFile(file, 'latin1'))) };
    throw new Error(`${e.toUpperCase()} files need LibreOffice installed`);
  }
  throw new Error(`Can't read ${e.toUpperCase()} documents`);
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToMarkdown(html) {
  const TurndownService = require('turndown');
  const { gfm } = require('turndown-plugin-gfm');
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  // GFM tables need a header row and single-line cells; Word tables have
  // neither, so promote the first row and unwrap cell paragraphs.
  const tables = html.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    let t = table.replace(/<\/?p[^>]*>/gi, ' ');
    if (!/<th[\s>]/i.test(t)) {
      t = t.replace(/<tr[^>]*>[\s\S]*?<\/tr>/i, (row) => row.replace(/<td/gi, '<th').replace(/<\/td>/gi, '</th>'));
    }
    return t;
  });
  return td.turndown(tables);
}

async function printHtml(doc, out) {
  if (!printer) throw new Error('PDF export needs the app window');
  return withTemp(async (dir) => {
    const htmlFile = path.join(dir, 'doc.html');
    let html = page(doc.title, doc.html);
    if (doc.baseDir) html = html.replace('<head>', `<head><base href="${pathToFileURL(doc.baseDir + path.sep).href}">`);
    await fsp.writeFile(htmlFile, html);
    await printer(htmlFile, out);
    return out;
  });
}

async function writeDocx(doc, out) {
  const HTMLtoDOCX = require('html-to-docx');
  const buf = await HTMLtoDOCX(page(doc.title, doc.html), null, { title: doc.title, table: { row: { cantSplit: true } }, footer: false, pageNumber: false });
  await fsp.writeFile(out, buf);
}

async function writeEpub(doc, out) {
  const epub = require('epub-gen-memory').default;
  // One chapter per top-level heading.
  const parts = doc.html.split(/(?=<h1[\s>])/i).filter((s) => s.trim());
  const chapters = parts.map((content, i) => ({
    title: htmlToText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(content)?.[1] || '') || (parts.length > 1 ? `Chapter ${i + 1}` : doc.title),
    content,
  }));
  const buf = await epub({ title: doc.title, author: 'Wedge', verbose: false, ignoreFailedDownloads: true }, chapters.length ? chapters : [{ title: doc.title, content: '<p></p>' }]);
  await fsp.writeFile(out, buf);
}

// Lays a document out as PDF, preferring real layout engines for office files.
async function writePdf(file, out) {
  const e = ext(file);
  if (office.available() && ['docx', 'doc', 'odt', 'rtf'].includes(e)) return office.convertTo(file, 'pdf', out);
  if (e === 'epub') return pdf.renderToPdf(file, out);
  return printHtml(await readHtml(file), out);
}

// Saves each page as an image (one file, or a folder for several pages).
async function toImages(file, format, settings, progress) {
  return withTemp(async (dir) => {
    const tmp = path.join(dir, `${base(file)}.pdf`);
    await writePdf(file, tmp);
    return pdf.toImages(tmp, format, settings, progress, file);
  });
}

async function convert(file, target) {
  const e = ext(file);
  const out = outPath(file, target);
  if (target === 'pdf') {
    await writePdf(file, out);
    return [out];
  }
  const doc = await readHtml(file);
  if (target === 'html') await fsp.writeFile(out, page(doc.title, doc.html));
  else if (target === 'md') await fsp.writeFile(out, htmlToMarkdown(doc.html) + '\n');
  else if (target === 'txt') await fsp.writeFile(out, htmlToText(doc.html) + '\n');
  else if (target === 'docx') await writeDocx(doc, out);
  else if (target === 'epub') await writeEpub(doc, out);
  else if (target === 'odt' || target === 'rtf') {
    if (!office.available()) throw new Error(`${target.toUpperCase()} export needs LibreOffice installed`);
    await withTemp(async (dir) => {
      const docx = path.join(dir, `${base(file)}.docx`);
      if (e === 'docx') await fsp.copyFile(file, docx);
      else await writeDocx(doc, docx);
      await office.convertTo(docx, target, out);
    });
  } else throw new Error(`Can't write ${target.toUpperCase()}`);
  return [out];
}

module.exports = { convert, toImages, readHtml, htmlToText, htmlToMarkdown, printHtml, page, setPrinter, PRINT_CSS };
