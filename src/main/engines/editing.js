// Back end for the visual editors (image, video/audio, PDF): getting a file
// into the editor window and writing the edited copy next to the original.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('../util').lazy('sharp');
const pdfLib = require('../util').lazy('pdf-lib');
const { ext, base, outPath, ffmpeg, probe, FFMPEG } = require('../util');
const image = require('./image');
const media = require('./media');

// ----- image ---------------------------------------------------------------------

// The editor draws on a canvas, so it gets the pixels as a data URL (a file://
// image would taint the canvas). EXIF rotation is applied; HEIC/BMP decode here.
async function loadImage(file) {
  const img = await image.load(file);
  const meta = await img.clone().metadata();
  const lossy = ['jpg', 'jpeg', 'heic', 'heif'].includes(ext(file)) && !meta.hasAlpha;
  const { data, info } = lossy
    ? await img.jpeg({ quality: 95 }).toBuffer({ resolveWithObject: true })
    : await img.png().toBuffer({ resolveWithObject: true });
  return { url: `data:image/${lossy ? 'jpeg' : 'png'};base64,${data.toString('base64')}`, width: info.width, height: info.height };
}

const WRITABLE = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', tiff: 'tiff', tif: 'tiff', gif: 'png', bmp: 'png', heic: 'jpg', heif: 'jpg' };

// format: 'same' keeps the original's format where we can write it.
async function saveImage(file, dataUrl, format = 'same') {
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const target = format === 'same' ? WRITABLE[ext(file)] || 'png' : format;
  const out = outPath(file, target, '-edited');
  let img = sharp(png);
  if (target === 'jpg') img = img.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true });
  else if (target === 'webp') img = img.webp({ quality: 90 });
  else if (target === 'avif') img = img.avif({ quality: 60 });
  else if (target === 'tiff') img = img.tiff({ compression: 'lzw' });
  else img = img.png({ compressionLevel: 9 });
  await img.toFile(out);
  return out;
}

// ----- video & audio -----------------------------------------------------------------

async function mediaInfo(file) {
  const info = await probe(file);
  return { ...info, isAudio: !info.hasVideo, ext: ext(file) };
}

// A small H.264 copy for formats Chromium can't play (AVI, WMV, some MKV/HEVC).
const proxies = new Map();
async function previewProxy(file) {
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  if (proxies.has(key) && fs.existsSync(proxies.get(key))) return proxies.get(key);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wedge-preview-'));
  const out = path.join(dir, 'preview.mp4');
  await ffmpeg(['-i', file, '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', out]);
  proxies.set(key, out);
  return out;
}

// Peak levels for the timeline, decoded to 8 kHz mono by FFmpeg.
function waveform(file, points = 1600) {
  return new Promise((resolve) => {
    const chunks = [];
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true });
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      const samples = Math.floor(buf.length / 2);
      if (!samples) return resolve([]);
      const per = Math.max(1, Math.floor(samples / points));
      const peaks = [];
      for (let i = 0; i < samples; i += per) {
        let max = 0;
        for (let j = i; j < Math.min(samples, i + per); j++) max = Math.max(max, Math.abs(buf.readInt16LE(j * 2)));
        peaks.push(max / 32768);
      }
      resolve(peaks);
    });
  });
}

function atempoChain(speed) {
  const parts = [];
  let r = speed;
  while (r > 2) { parts.push('atempo=2'); r /= 2; }
  while (r < 0.5) { parts.push('atempo=0.5'); r /= 0.5; }
  parts.push(`atempo=${r}`);
  return parts.join(',');
}


// opts: { start, end, crop: {fx, fy, fw, fh} as fractions of the frame | null, speed, mute, format }
// The crop is relative so it holds for rotated phone videos and low-res previews:
// FFmpeg applies it after auto-rotation, using the frame's real size.
async function exportMedia(file, opts, progress) {
  const info = await probe(file);
  const start = Math.max(0, Number(opts.start) || 0);
  const end = Math.min(info.duration || Infinity, Number(opts.end) || info.duration);
  const speed = Number(opts.speed) || 1;
  const length = Math.max(0.05, end - start);
  const sourceExt = media.sameExt(file);
  let format = opts.format || 'same';
  if (format === 'same') format = info.hasVideo ? (['mp4', 'mov', 'webm', 'mkv'].includes(sourceExt) ? sourceExt : 'mp4') : sourceExt;
  const out = outPath(file, format, '-edited');
  const args = ['-ss', String(start), '-i', file, '-t', String(length)];
  const vf = [];
  if (info.hasVideo && opts.crop) {
    const f = (v) => Math.min(1, Math.max(0, Number(v) || 0)).toFixed(5);
    const { fx, fy, fw, fh } = opts.crop;
    vf.push(`crop=trunc(iw*${f(fw)}/2)*2:trunc(ih*${f(fh)}/2)*2:trunc(iw*${f(fx)}):trunc(ih*${f(fy)})`);
  }
  if (speed !== 1) vf.push(`setpts=PTS/${speed}`);
  if (format === 'gif') {
    vf.push('fps=12', 'scale=480:-1:flags=lanczos');
    args.push('-filter_complex', `[0:v]${vf.join(',')},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', out);
  } else if (['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus', 'aiff', 'wma'].includes(format)) {
    if (speed !== 1) args.push('-af', atempoChain(speed));
    args.push('-vn', ...media.codecFor(`x.${format}`), out);
  } else {
    if (info.hasVideo) {
      vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
      args.push('-vf', vf.join(','));
    }
    if (opts.mute || !info.hasAudio) args.push('-an');
    else if (speed !== 1) args.push('-af', atempoChain(speed));
    args.push(...media.codecFor(`x.${format}`), out);
  }
  await ffmpeg(args, { onProgress: progress, duration: length / speed });
  return out;
}

async function snapshot(file, time) {
  const out = outPath(file, 'png', `-frame-${Number(time).toFixed(2).replace('.', '_')}s`);
  await ffmpeg(['-ss', String(time), '-i', file, '-frames:v', '1', out]);
  return out;
}

// ----- PDF ---------------------------------------------------------------------------

let muPromise;
const mu = () => (muPromise ||= import('mupdf'));
const openDocs = new Map();

async function muDoc(file) {
  if (!openDocs.has(file)) {
    const m = await mu();
    openDocs.set(file, m.Document.openDocument(await fsp.readFile(file), 'application/pdf'));
  }
  return openDocs.get(file);
}

async function pdfInfo(file) {
  const doc = await muDoc(file);
  if (doc.needsPassword()) throw new Error('This PDF is password protected');
  const pages = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
    pages.push({ w: x1 - x0, h: y1 - y0 });
  }
  return { pages };
}

async function pdfThumb(file, index, width = 240) {
  const m = await mu();
  const doc = await muDoc(file);
  const page = doc.loadPage(index);
  const [x0, , x1] = page.getBounds();
  const scale = width / (x1 - x0);
  const png = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true).asPNG();
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

// A full-size page for the annotate view, drawn with any extra rotation.
async function pdfRender(file, index, scale = 2, rotate = 0) {
  const m = await mu();
  const doc = await muDoc(file);
  const matrix = m.Matrix.concat(m.Matrix.scale(scale, scale), m.Matrix.rotate(rotate));
  const pix = doc.loadPage(index).toPixmap(matrix, m.ColorSpace.DeviceRGB, false, true);
  return { url: `data:image/png;base64,${Buffer.from(pix.asPNG()).toString('base64')}`, width: pix.getWidth(), height: pix.getHeight() };
}

const hexColor = (hex) => {
  const n = parseInt(String(hex || '#000000').replace('#', ''), 16);
  return pdfLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

// Text baselines sit this far below the top of a line, in font sizes; matches
// the editor's text boxes (Helvetica/Arial, line-height 1.2).
const BASELINE = 0.93;
const LINE_HEIGHT = 1.2;

// Annotations are placed in screen space: points from the top-left of the page
// as displayed (after its rotation). PDF space starts bottom-left of the
// unrotated page, so map through the page's final rotation.
async function drawAnnotations(outDoc, page, annots, cache) {
  const R = ((page.getRotation().angle % 360) + 360) % 360;
  const box = page.getCropBox();
  const W = box.width;
  const H = box.height;
  const toPdf = (dx, dy) => {
    const [x, y] = R === 90 ? [dy, dx] : R === 180 ? [W - dx, dy] : R === 270 ? [W - dy, H - dx] : [dx, H - dy];
    return { x: x + box.x, y: y + box.y };
  };
  const rotate = pdfLib.degrees(R);
  const image = async (url) => {
    if (!cache.has(url)) {
      const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
      cache.set(url, url.startsWith('data:image/jpeg') ? await outDoc.embedJpg(bytes) : await outDoc.embedPng(bytes));
    }
    return cache.get(url);
  };
  for (const a of annots || []) {
    if (a.type === 'rect') {
      const p1 = toPdf(a.x, a.y);
      const p2 = toPdf(a.x + a.w, a.y + a.h);
      // Highlights multiply like a marker, so the text underneath stays dark.
      const highlight = a.kind === 'highlight';
      page.drawRectangle({
        x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y),
        color: hexColor(a.color), opacity: highlight ? 0.75 : a.opacity ?? 1, blendMode: highlight ? pdfLib.BlendMode.Multiply : pdfLib.BlendMode.Normal,
      });
    } else if (a.type === 'text') {
      if (!cache.font) cache.font = await outDoc.embedFont(pdfLib.StandardFonts.Helvetica);
      const lines = String(a.text || '').split(/\r?\n/);
      try {
        lines.forEach((line, i) => {
          if (!line) return;
          const at = toPdf(a.x, a.y + a.size * (BASELINE + i * LINE_HEIGHT));
          page.drawText(line, { ...at, size: a.size, font: cache.font, color: hexColor(a.color), rotate });
        });
      } catch {
        // Characters the standard font can't encode (other scripts, emoji):
        // fall back to the picture of the text the editor rendered.
        if (a.png) {
          const at = toPdf(a.x, a.y + a.h);
          page.drawImage(await image(a.png), { ...at, width: a.w, height: a.h, rotate });
        }
      }
    } else if (a.type === 'image') {
      const at = toPdf(a.x, a.y + a.h);
      page.drawImage(await image(a.url), { ...at, width: a.w, height: a.h, rotate });
    }
  }
}

// pages: [{ src: original page index, rotate: extra degrees, annots: [...] }] in the new order.
async function savePdf(file, pages, suffix = '-edited') {
  if (!pages.length) throw new Error('There are no pages to save');
  const src = await pdfLib.PDFDocument.load(await fsp.readFile(file), { ignoreEncryption: true });
  const outDoc = await pdfLib.PDFDocument.create();
  const copies = await outDoc.copyPages(src, pages.map((p) => p.src));
  const cache = new Map();
  for (let i = 0; i < copies.length; i++) {
    const page = copies[i];
    const extra = ((Number(pages[i].rotate) || 0) % 360 + 360) % 360;
    if (extra) page.setRotation(pdfLib.degrees((page.getRotation().angle + extra) % 360));
    outDoc.addPage(page);
    if (pages[i].annots?.length) await drawAnnotations(outDoc, page, pages[i].annots, cache);
  }
  const out = outPath(file, 'pdf', suffix);
  await fsp.writeFile(out, await outDoc.save());
  return out;
}

function closeFile(file) {
  openDocs.delete(file);
}

module.exports = {
  loadImage, saveImage, mediaInfo, previewProxy, waveform, exportMedia, snapshot,
  pdfInfo, pdfThumb, pdfRender, savePdf, closeFile, base,
};
