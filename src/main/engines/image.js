// Image conversion and tools, built on sharp (libvips) with FFmpeg and
// heic-convert covering the formats libvips can't read or write.
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('../util').lazy('sharp');
const pdfLib = require('../util').lazy('pdf-lib');
const { ext, outPath, withTemp, ffmpeg } = require('../util');

const SHARP_WRITE = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', avif: 'avif', tiff: 'tiff', tif: 'tiff', gif: 'gif' };

async function load(file) {
  const e = ext(file);
  if (e === 'heic' || e === 'heif') {
    try {
      const img = sharp(file);
      await img.metadata();
      await img.clone().toBuffer();
      return img.rotate();
    } catch {
      const convert = require('heic-convert');
      const png = await convert({ buffer: await fsp.readFile(file), format: 'PNG' });
      return sharp(Buffer.from(png));
    }
  }
  if (e === 'bmp' || e === 'ico') {
    return withTemp(async (dir) => {
      const tmp = path.join(dir, 'in.png');
      await ffmpeg(['-i', file, tmp]);
      return sharp(await fsp.readFile(tmp));
    });
  }
  const opts = e === 'svg' ? { density: 192 } : e === 'gif' ? { animated: false } : {};
  // .rotate() with no args applies the EXIF orientation.
  return sharp(file, opts).rotate();
}

// The format a tool writes back for a given input.
function sameFormat(file) {
  const e = ext(file);
  if (e === 'heic' || e === 'heif' || e === 'ico') return 'jpg';
  if (e === 'svg') return 'png';
  if (e === 'jpeg') return 'jpg';
  if (e === 'tif') return 'tiff';
  return e;
}

async function save(img, format, out, { quality = 90, keepMeta = false } = {}) {
  format = format === 'jpeg' ? 'jpg' : format;
  if (keepMeta) img = img.keepMetadata();
  if (format === 'bmp') {
    return withTemp(async (dir) => {
      const tmp = path.join(dir, 'out.png');
      await img.png().toFile(tmp);
      await ffmpeg(['-i', tmp, '-pix_fmt', 'bgra', out]);
      return out;
    });
  }
  if (format === 'pdf') {
    await fsp.writeFile(out, await imagesToPdfBytes([img]));
    return out;
  }
  const kind = SHARP_WRITE[format];
  if (!kind) throw new Error(`Can't write ${format.toUpperCase()} images`);
  if (kind === 'jpeg') img = img.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
  else if (kind === 'png') img = img.png({ compressionLevel: 9 });
  else if (kind === 'webp') img = img.webp({ quality });
  else if (kind === 'avif') img = img.avif({ quality: Math.round(quality * 0.7) });
  else if (kind === 'tiff') img = img.tiff({ compression: 'lzw' });
  else if (kind === 'gif') img = img.gif();
  await img.toFile(out);
  return out;
}

async function convert(file, target, settings = {}) {
  const out = outPath(file, target);
  await save(await load(file), target, out, { quality: settings.imageQuality || 90 });
  return [out];
}

async function imagesToPdfBytes(images) {
  const pdf = await pdfLib.PDFDocument.create();
  for (const img of images) {
    const meta = await img.clone().metadata();
    const { data, info } = await img.clone().flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
    const embedded = meta.hasAlpha
      ? await pdf.embedPng(await img.clone().png().toBuffer())
      : await pdf.embedJpg(data);
    const w = info.width * 0.75;
    const h = info.height * 0.75;
    const page = pdf.addPage([w, h]);
    page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
  }
  return pdf.save();
}

async function imagesToPdf(files) {
  const images = [];
  for (const f of files) images.push(await load(f));
  const out = outPath(files[0], 'pdf', files.length > 1 ? ' (combined)' : '');
  await require('fs/promises').writeFile(out, await imagesToPdfBytes(images));
  return [out];
}

async function encodeToBuffer(img, format, quality, palette) {
  const kind = SHARP_WRITE[format] || 'jpeg';
  if (kind === 'png') return img.clone().png({ palette, quality, compressionLevel: 9, effort: 8 }).toBuffer();
  if (kind === 'webp') return img.clone().webp({ quality }).toBuffer();
  if (kind === 'avif') return img.clone().avif({ quality: Math.round(quality * 0.7) }).toBuffer();
  if (kind === 'tiff') return img.clone().tiff({ compression: 'jpeg', quality }).toBuffer();
  if (kind === 'gif') return img.clone().gif({ colours: Math.max(16, Math.round(quality * 2.56)) }).toBuffer();
  return img.clone().flatten({ background: '#fff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
}

async function compress(file, opts) {
  let format = sameFormat(file);
  if (format === 'bmp') format = 'png';
  let img = await load(file);
  const maxWidth = Number(opts.maxWidth) || 0;
  if (maxWidth) img = img.resize({ width: maxWidth, withoutEnlargement: true });
  let buf;
  if (opts.mode === 'size') {
    const target = Math.max(5, Number(opts.targetKB) || 200) * 1024;
    let scale = 1;
    const meta = await img.clone().metadata();
    for (let attempt = 0; attempt < 8; attempt++) {
      const sized = scale < 1 ? img.clone().resize({ width: Math.round((meta.width || 1000) * scale) }) : img;
      let lo = 5, hi = 95, best = null;
      while (lo <= hi) {
        const q = Math.floor((lo + hi) / 2);
        const b = await encodeToBuffer(sized, format, q, true);
        if (b.length <= target) { best = b; lo = q + 1; } else hi = q - 1;
      }
      if (best) { buf = best; break; }
      scale *= 0.8;
    }
    if (!buf) throw new Error('Could not reach the target size');
  } else {
    buf = await encodeToBuffer(img, format, Number(opts.quality) || 70, format === 'png');
  }
  const out = outPath(file, format, '-compressed');
  await fsp.writeFile(out, buf);
  return [out];
}

async function resize(file, opts) {
  let img = await load(file);
  const meta = await img.clone().metadata();
  const v = Number(opts.value) || 50;
  const width = opts.mode === 'percent' ? Math.max(1, Math.round((meta.width * v) / 100)) : v;
  img = img.resize({ width });
  const out = outPath(file, sameFormat(file), `-${width}w`);
  return [await save(img, sameFormat(file), out)];
}

const ASPECTS = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16, '3:2': 3 / 2, '2:3': 2 / 3, '4:5': 4 / 5, '21:9': 21 / 9 };

async function crop(file, opts) {
  let img = await load(file);
  const meta = await img.clone().png().toBuffer({ resolveWithObject: true }).then((r) => r.info);
  let w, h;
  if (opts.aspect === 'exact') {
    w = Number(opts.width);
    h = Number(opts.height);
    if (!w || !h) throw new Error('Enter a width and height');
    img = img.resize({ width: w, height: h, fit: 'cover', position: sharp.strategy.attention });
  } else {
    const r = ASPECTS[opts.aspect] || 1;
    w = meta.width;
    h = Math.round(w / r);
    if (h > meta.height) { h = meta.height; w = Math.round(h * r); }
    img = img.resize({ width: w, height: h, fit: 'cover', position: sharp.strategy.attention });
  }
  const out = outPath(file, sameFormat(file), '-cropped');
  return [await save(img, sameFormat(file), out)];
}

async function rotate(file, opts) {
  let img = sharp(await (await load(file)).toBuffer());
  const angle = Number(opts.angle) || 0;
  if (angle) img = img.rotate(angle);
  if (opts.flip === 'horizontal') img = img.flop();
  if (opts.flip === 'vertical') img = img.flip();
  const out = outPath(file, sameFormat(file), '-rotated');
  return [await save(img, sameFormat(file), out)];
}

async function adjust(file, opts) {
  let img = await load(file);
  const brightness = 1 + (Number(opts.brightness) || 0) / 100;
  const saturation = 1 + (Number(opts.saturation) || 0) / 100;
  const hue = Number(opts.hue) || 0;
  img = img.modulate({ brightness, saturation, hue });
  const contrast = 1 + (Number(opts.contrast) || 0) / 100;
  if (contrast !== 1) img = img.linear(contrast, -(128 * contrast) + 128);
  if (Number(opts.sharpen) > 0) img = img.sharpen({ sigma: 0.5 + Number(opts.sharpen) / 40 });
  if (Number(opts.blur) > 0) img = img.blur(0.3 + Number(opts.blur) / 10);
  if (opts.grayscale === 'yes') img = img.grayscale();
  const out = outPath(file, sameFormat(file), '-edited');
  return [await save(img, sameFormat(file), out)];
}

async function grayscale(file) {
  const out = outPath(file, sameFormat(file), '-bw');
  return [await save((await load(file)).grayscale(), sameFormat(file), out)];
}

async function metadata(file, opts) {
  const fmt = sameFormat(file);
  const out = outPath(file, fmt, opts.action === 'strip' ? '-clean' : '');
  let img = await load(file);
  if (opts.action === 'strip') {
    // sharp drops all metadata unless asked to keep it.
    return [await save(img, fmt, out, { quality: 95 })];
  }
  const IFD0 = {};
  if (opts.artist) IFD0.Artist = opts.artist;
  if (opts.copyright) IFD0.Copyright = opts.copyright;
  if (opts.description) IFD0.ImageDescription = opts.description;
  img = img.keepIccProfile().withExifMerge({ IFD0 });
  return [await save(img, fmt, out, { quality: 95 })];
}

function roundedMask(w, h, r) {
  return Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></svg>`);
}

async function rounded(img, radius) {
  const { data, info } = await img.clone().ensureAlpha().png().toBuffer({ resolveWithObject: true });
  if (!radius) return { buf: data, info };
  const r = Math.round((Math.min(info.width, info.height) * radius) / 100);
  const buf = await sharp(data).composite([{ input: roundedMask(info.width, info.height, r), blend: 'dest-in' }]).png().toBuffer();
  return { buf, info };
}

function backgroundSvg(w, h, opts) {
  const c1 = opts.color1 || '#6d5bf7';
  const c2 = opts.color2 || '#c4b8ff';
  const fill = opts.fill === 'gradient' ? 'url(#g)' : c1;
  return Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="${fill}"/></svg>`);
}

async function background(file, opts) {
  const { buf, info } = await rounded(await load(file), Number(opts.radius) || 0);
  const pad = Math.round((Math.max(info.width, info.height) * (Number(opts.padding) || 0)) / 100);
  let W = info.width + pad * 2;
  let H = info.height + pad * 2;
  const r = ASPECTS[opts.aspect];
  if (r) {
    if (W / H < r) W = Math.round(H * r);
    else H = Math.round(W / r);
  }
  const out = outPath(file, 'png', '-bg');
  await sharp(backgroundSvg(W, H, opts))
    .composite([{ input: buf, left: Math.round((W - info.width) / 2), top: Math.round((H - info.height) / 2) }])
    .png()
    .toFile(out);
  return [out];
}

async function collage(files, opts) {
  const n = files.length;
  const cell = Math.max(100, Number(opts.cell) || 800);
  const gap = Math.max(0, Number(opts.spacing) || 0);
  const radius = Number(opts.radius) || 0;
  const layout = opts.layout || 'grid';
  let boxes = [];
  if (layout === 'row') boxes = files.map((_, i) => ({ x: i * (cell + gap), y: 0, w: cell, h: cell }));
  else if (layout === 'column') boxes = files.map((_, i) => ({ x: 0, y: i * (cell + gap), w: cell, h: cell }));
  else if (layout === 'featured' && n > 1) {
    const rest = n - 1;
    const small = Math.round((cell * 2 + gap - gap * (rest - 1)) / rest);
    boxes.push({ x: 0, y: 0, w: cell * 2 + gap, h: cell * 2 + gap });
    for (let i = 0; i < rest; i++) boxes.push({ x: cell * 2 + gap * 2, y: i * (small + gap), w: small, h: small });
  } else {
    const cols = Math.ceil(Math.sqrt(n));
    boxes = files.map((_, i) => ({ x: (i % cols) * (cell + gap), y: Math.floor(i / cols) * (cell + gap), w: cell, h: cell }));
  }
  const W = Math.max(...boxes.map((b) => b.x + b.w)) + gap * 2;
  const H = Math.max(...boxes.map((b) => b.y + b.h)) + gap * 2;
  const layers = [];
  for (let i = 0; i < n; i++) {
    const b = boxes[i];
    const img = (await load(files[i])).resize({ width: b.w, height: b.h, fit: 'cover', position: sharp.strategy.attention });
    const { buf } = await rounded(img, radius);
    layers.push({ input: buf, left: b.x + gap, top: b.y + gap });
  }
  const out = outPath(files[0], 'png', ' collage');
  await sharp(backgroundSvg(W, H, { fill: 'solid', color1: opts.background || '#ffffff' }))
    .composite(layers)
    .png()
    .toFile(out);
  return [out];
}

module.exports = { load, save, convert, compress, resize, crop, rotate, adjust, grayscale, metadata, background, collage, imagesToPdf, sameFormat };
