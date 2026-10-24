// Spreadsheets via SheetJS, plus slide decks (LibreOffice, else MuPDF).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const XLSX = require('../util').lazy('xlsx');
const { ext, base, outDir, outPath, uniqueDir, withTemp, escapeHtml } = require('../util');
const office = require('./office');
const pdf = require('./pdf');

XLSX.set_fs(fs);

function read(file) {
  const e = ext(file);
  const opts = e === 'tsv' ? { FS: '\t' } : {};
  return XLSX.readFile(file, { ...opts, cellDates: true });
}

async function writeDelimited(wb, file, target) {
  const FS = target === 'tsv' ? '\t' : ',';
  const names = wb.SheetNames;
  if (names.length === 1) {
    const out = outPath(file, target);
    await fsp.writeFile(out, '﻿' + XLSX.utils.sheet_to_csv(wb.Sheets[names[0]], { FS }));
    return [out];
  }
  const dir = uniqueDir(path.join(outDir(file), `${base(file)} ${target}`));
  await fsp.mkdir(dir, { recursive: true });
  for (const n of names) {
    const safe = n.replace(/[\\/:*?"<>|]/g, '_');
    await fsp.writeFile(path.join(dir, `${safe}.${target}`), '﻿' + XLSX.utils.sheet_to_csv(wb.Sheets[n], { FS }));
  }
  return [dir];
}

function tablesHtml(wb) {
  return wb.SheetNames.map((n) => {
    const table = XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' });
    return `<h2>${escapeHtml(n)}</h2>${table}`;
  }).join('\n');
}

async function convert(file, target) {
  const wb = read(file);
  if (target === 'csv' || target === 'tsv') return writeDelimited(wb, file, target);
  const out = outPath(file, target);
  if (target === 'xlsx' || target === 'ods' || target === 'xls') {
    XLSX.writeFile(wb, out, { bookType: target === 'xls' ? 'biff8' : target, compression: true });
  } else if (target === 'json') {
    const data = {};
    for (const n of wb.SheetNames) data[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null });
    const value = wb.SheetNames.length === 1 ? data[wb.SheetNames[0]] : data;
    await fsp.writeFile(out, JSON.stringify(value, null, 2));
  } else if (target === 'html') {
    const docs = require('./docs');
    await fsp.writeFile(out, docs.page(base(file), tablesHtml(wb)));
  } else if (target === 'pdf') {
    if (office.available() && ext(file) !== 'csv' && ext(file) !== 'tsv') {
      await office.convertTo(file, 'pdf', out);
    } else {
      const docs = require('./docs');
      await docs.printHtml({ title: base(file), html: `<style>body{max-width:none;font-size:9pt}</style>${tablesHtml(wb)}` }, out);
    }
  } else throw new Error(`Can't write ${target.toUpperCase()}`);
  return [out];
}

async function slidesToPdf(file, out) {
  if (office.available()) return office.convertTo(file, 'pdf', out);
  if (ext(file) !== 'pptx') throw new Error(`${ext(file).toUpperCase()} slides need LibreOffice installed`);
  // MuPDF lays out a deck's text but not its pictures or design, so refuse
  // rather than hand back blank pages.
  await pdf.renderToPdf(file, out);
  if (!(await pdf.hasText(out))) {
    await fsp.rm(out, { force: true });
    throw new Error('This deck needs LibreOffice installed to keep its images and layout');
  }
  return out;
}

async function convertSlides(file, target, settings, progress) {
  if (target === 'pdf') {
    const out = outPath(file, 'pdf');
    await slidesToPdf(file, out);
    return [out];
  }
  if (target === 'pptx') {
    if (!office.available()) throw new Error('Converting to PPTX needs LibreOffice installed');
    const out = outPath(file, 'pptx');
    await office.convertTo(file, 'pptx', out);
    return [out];
  }
  // PNG/JPG: lay out as a temporary PDF, then render its pages.
  return withTemp(async (dir) => {
    const tmpPdf = path.join(dir, `${base(file)}.pdf`);
    await slidesToPdf(file, tmpPdf);
    return pdf.toImages(tmpPdf, target, settings, progress, file);
  });
}

module.exports = { convert, convertSlides };
