// The registry of every conversion, tool and action. The wheel, the Formats
// section in Settings and the job runner are all driven from this one list.
const fs = require('fs');
const path = require('path');
const { ext } = require('./util');
const image = require('./engines/image');
const media = require('./engines/media');
const pdf = require('./engines/pdf');
const docs = require('./engines/docs');
const sheets = require('./engines/sheets');
const archive = require('./engines/archive');
const subtitles = require('./engines/subtitles');
const office = require('./engines/office');
const editor = require('./engines/editor');

const CATEGORIES = {
  image: { label: 'Images', exts: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tiff', 'tif', 'avif', 'bmp', 'gif', 'svg', 'ico'] },
  video: { label: 'Video', exts: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'm4v', 'flv', 'mpg', 'mpeg', '3gp', 'mts'] },
  audio: { label: 'Audio', exts: ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'wma', 'aac'] },
  pdf: { label: 'PDF', exts: ['pdf'] },
  document: { label: 'Documents', exts: ['docx', 'doc', 'odt', 'rtf', 'md', 'markdown', 'txt', 'html', 'htm'] },
  slides: { label: 'Slides', exts: ['pptx', 'ppt', 'odp', 'key'] },
  sheet: { label: 'Spreadsheets', exts: ['xlsx', 'xls', 'ods', 'csv', 'tsv', 'numbers'] },
  ebook: { label: 'EPUB', exts: ['epub'] },
  subtitle: { label: 'Subtitles', exts: ['srt', 'vtt'] },
  archive: { label: 'Archives', exts: ['zip', 'tar', 'gz', 'tgz', 'rar'] },
};

const EXT_CAT = {};
for (const [cat, { exts }] of Object.entries(CATEGORIES)) for (const e of exts) EXT_CAT[e] = cat;

// What the browser reports for dragged files, before we know their paths.
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/tiff': 'tiff', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/webm': 'webm', 'video/x-msvideo': 'avi',
  'video/avi': 'avi', 'video/x-ms-wmv': 'wmv', 'video/x-m4v': 'm4v', 'video/mpeg': 'mpg', 'video/3gpp': '3gp', 'video/x-flv': 'flv',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/x-ms-wma': 'wma', 'audio/aac': 'aac', 'audio/x-aac': 'aac',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc',
  'application/vnd.oasis.opendocument.text': 'odt', 'application/rtf': 'rtf', 'text/rtf': 'rtf', 'text/markdown': 'md',
  'text/x-markdown': 'md', 'text/plain': 'txt', 'text/html': 'html', 'application/epub+zip': 'epub',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods', 'text/csv': 'csv', 'text/tab-separated-values': 'tsv',
  'application/x-subrip': 'srt', 'text/vtt': 'vtt',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/x-tar': 'tar', 'application/gzip': 'gz',
  'application/x-gzip': 'gz', 'application/x-compressed-tar': 'tgz', 'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar',
};

function describe(file) {
  let isDir = false;
  try { isDir = fs.statSync(file).isDirectory(); } catch {}
  if (isDir) return { file, ext: '', cat: 'folder' };
  const name = file.toLowerCase();
  const e = name.endsWith('.tar.gz') ? 'tgz' : ext(file);
  return { file, ext: e, cat: EXT_CAT[e] || 'other' };
}

// ----- option presets -------------------------------------------------------

const opt = {
  angle: { key: 'angle', label: 'Rotate', type: 'select', default: '90', options: [['90', '90° clockwise'], ['180', '180°'], ['270', '90° counter-clockwise']] },
  trim: [
    { key: 'start', label: 'Start', type: 'text', default: '0:00', hint: 'seconds or mm:ss' },
    { key: 'end', label: 'End', type: 'text', default: '', hint: 'blank = to the end' },
  ],
  split: { key: 'every', label: 'Segment length', type: 'text', default: '1:00', hint: 'seconds or mm:ss' },
};

// ----- op builders ----------------------------------------------------------

const ops = [];
function add(op) {
  ops.push({ multi: false, min: 1, max: Infinity, options: [], ...op });
}

function convertOp(cat, target, run, extra = {}) {
  add({
    id: `convert:${cat}:${target}`,
    mode: 'convert',
    cats: [cat],
    short: target.toUpperCase(),
    label: `Convert to ${target.toUpperCase()}`,
    target,
    skipSame: true,
    run,
    ...extra,
  });
}

// Visual editors: one "Edit" wedge that opens the matching editor window.
add({ id: 'edit:image', mode: 'convert', cats: ['image'], short: 'Edit', sub: 'Crop · Draw', label: 'Open in the image editor', opens: 'image', excludeExts: ['svg', 'ico'] });
add({ id: 'edit:media', mode: 'convert', cats: ['video', 'audio'], short: 'Edit', sub: 'Trim · Crop', label: 'Open in the video editor', opens: 'media' });
add({ id: 'edit:pdf', mode: 'convert', cats: ['pdf'], short: 'Edit', sub: 'Pages', label: 'Open in the PDF editor', opens: 'pdf' });

// Images
for (const t of ['jpg', 'png', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'pdf']) {
  convertOp('image', t, (f, _o, c) => image.convert(f, t, c.settings));
}
convertOp('image', 'mp4', (f, _o, c) => media.convert(f, 'mp4', c.settings, c.progress), { onlyExts: ['gif'] });

// Video
for (const t of ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'gif', 'mp3', 'm4a', 'wav']) {
  convertOp('video', t, (f, _o, c) => media.convert(f, t, c.settings, c.progress));
}

// Audio
for (const t of ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aiff', 'wma']) {
  convertOp('audio', t, (f, _o, c) => media.convert(f, t, c.settings, c.progress));
}

// PDF
convertOp('pdf', 'png', (f, _o, c) => pdf.toImages(f, 'png', c.settings, c.progress));
convertOp('pdf', 'jpg', (f, _o, c) => pdf.toImages(f, 'jpg', c.settings, c.progress));
convertOp('pdf', 'docx', (f) => docs.convert(f, 'docx'));
convertOp('pdf', 'txt', (f) => pdf.toText(f));
convertOp('pdf', 'md', (f) => docs.convert(f, 'md'));
convertOp('pdf', 'html', (f) => docs.convert(f, 'html'));
convertOp('pdf', 'epub', (f) => docs.convert(f, 'epub'));
convertOp('pdf', 'pptx', (f, _o, c) => pdf.toPptx(f, c.settings, c.progress));
convertOp('pdf', 'xlsx', (f) => pdf.toXlsx(f));

// Documents
for (const t of ['pdf', 'docx', 'md', 'txt', 'html', 'epub']) convertOp('document', t, (f) => docs.convert(f, t));
for (const t of ['png', 'jpg']) convertOp('document', t, (f, _o, c) => docs.toImages(f, t, c.settings, c.progress));
for (const t of ['odt', 'rtf']) convertOp('document', t, (f) => docs.convert(f, t), { needsOffice: true });

// EPUB
for (const t of ['pdf', 'docx', 'md', 'txt', 'html']) convertOp('ebook', t, (f) => docs.convert(f, t));

// Slides
convertOp('slides', 'pdf', (f, _o, c) => sheets.convertSlides(f, 'pdf', c.settings, c.progress), { officeUnless: ['pptx'] });
convertOp('slides', 'png', (f, _o, c) => sheets.convertSlides(f, 'png', c.settings, c.progress), { officeUnless: ['pptx'] });
convertOp('slides', 'jpg', (f, _o, c) => sheets.convertSlides(f, 'jpg', c.settings, c.progress), { officeUnless: ['pptx'] });
convertOp('slides', 'pptx', (f, _o, c) => sheets.convertSlides(f, 'pptx', c.settings, c.progress), { needsOffice: true });

// Spreadsheets
for (const t of ['xlsx', 'ods', 'csv', 'tsv', 'pdf', 'html', 'json']) convertOp('sheet', t, (f) => sheets.convert(f, t));

// Subtitles
for (const t of ['srt', 'vtt', 'txt']) convertOp('subtitle', t, (f) => subtitles.convert(f, t));

// Archives
add({ id: 'convert:archive:extract', mode: 'convert', cats: ['archive'], short: 'Extract', label: 'Extract archive', icon: 'extract', run: (f) => archive.extract(f) });
for (const t of ['zip', 'tar', 'tar.gz']) {
  convertOp('archive', t, (f) => archive.repack(f, t), { sameAs: t === 'tar.gz' ? ['tgz'] : [t], excludeExts: ['gz'] });
}
for (const t of ['zip', 'tar.gz']) {
  add({ id: `convert:folder:${t}`, mode: 'convert', cats: ['folder'], short: t.toUpperCase(), label: `Compress to ${t.toUpperCase()}`, multi: true, run: (files) => archive.compress(files, t) });
}

// ----- tools ----------------------------------------------------------------

const MEDIA_CATS = ['video', 'audio'];

add({
  id: 'tool:image:compress', mode: 'tools', cats: ['image'], short: 'Compress', label: 'Compress images', icon: 'compress',
  options: [
    { key: 'mode', label: 'Method', type: 'select', default: 'quality', options: [['quality', 'Quality'], ['size', 'Target file size']] },
    { key: 'quality', label: 'Quality', type: 'range', min: 10, max: 95, default: 70, showIf: { mode: 'quality' } },
    { key: 'targetKB', label: 'Max size (KB)', type: 'number', default: 300, min: 5, showIf: { mode: 'size' } },
    { key: 'maxWidth', label: 'Max width (px)', type: 'number', default: '', hint: 'blank = keep' },
  ],
  run: (f, o) => image.compress(f, o),
});
add({
  id: 'tool:image:resize', mode: 'tools', cats: ['image'], short: 'Resize', label: 'Resize images', icon: 'resize',
  options: [
    { key: 'mode', label: 'By', type: 'select', default: 'percent', options: [['percent', 'Percentage'], ['width', 'Width in pixels']] },
    { key: 'value', label: 'Value', type: 'number', default: 50, min: 1 },
  ],
  run: (f, o) => image.resize(f, o),
});
add({
  id: 'tool:image:crop', mode: 'tools', cats: ['image'], short: 'Crop', label: 'Crop images', icon: 'crop',
  options: [
    { key: 'aspect', label: 'Aspect', type: 'select', default: '1:1', options: [['1:1', 'Square 1:1'], ['4:3', '4:3'], ['3:2', '3:2'], ['16:9', '16:9'], ['21:9', '21:9'], ['4:5', 'Portrait 4:5'], ['3:4', 'Portrait 3:4'], ['9:16', 'Story 9:16'], ['exact', 'Exact size…']] },
    { key: 'width', label: 'Width', type: 'number', default: 1080, showIf: { aspect: 'exact' } },
    { key: 'height', label: 'Height', type: 'number', default: 1080, showIf: { aspect: 'exact' } },
  ],
  hint: 'Smart crop keeps the most interesting area.',
  run: (f, o) => image.crop(f, o),
});
add({
  id: 'tool:image:rotate', mode: 'tools', cats: ['image'], short: 'Rotate', label: 'Rotate or flip', icon: 'rotate',
  options: [{ ...opt.angle, options: [['0', 'None'], ...opt.angle.options] }, { key: 'flip', label: 'Flip', type: 'select', default: 'none', options: [['none', 'None'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']] }],
  run: (f, o) => image.rotate(f, o),
});
add({
  id: 'tool:image:adjust', mode: 'tools', cats: ['image'], short: 'Edit', label: 'Adjust photos', icon: 'adjust',
  options: [
    { key: 'brightness', label: 'Brightness', type: 'range', min: -100, max: 100, default: 0 },
    { key: 'contrast', label: 'Contrast', type: 'range', min: -100, max: 100, default: 0 },
    { key: 'saturation', label: 'Saturation', type: 'range', min: -100, max: 100, default: 0 },
    { key: 'hue', label: 'Hue', type: 'range', min: -180, max: 180, default: 0 },
    { key: 'sharpen', label: 'Sharpen', type: 'range', min: 0, max: 100, default: 0 },
    { key: 'blur', label: 'Blur', type: 'range', min: 0, max: 100, default: 0 },
  ],
  run: (f, o) => image.adjust(f, o),
});
add({ id: 'tool:image:bw', mode: 'tools', cats: ['image'], short: 'B&W', label: 'Black & white', icon: 'bw', run: (f) => image.grayscale(f) });
add({
  id: 'tool:image:metadata', mode: 'tools', cats: ['image'], short: 'Metadata', label: 'Edit metadata', icon: 'metadata',
  options: [
    { key: 'action', label: 'Action', type: 'select', default: 'strip', options: [['strip', 'Remove all metadata (incl. location)'], ['edit', 'Set author & copyright']] },
    { key: 'artist', label: 'Author', type: 'text', default: '', showIf: { action: 'edit' } },
    { key: 'copyright', label: 'Copyright', type: 'text', default: '', showIf: { action: 'edit' } },
    { key: 'description', label: 'Description', type: 'text', default: '', showIf: { action: 'edit' } },
  ],
  run: (f, o) => image.metadata(f, o),
});
add({
  id: 'tool:image:background', mode: 'tools', cats: ['image'], short: 'Add BG', label: 'Add a background', icon: 'background',
  options: [
    { key: 'fill', label: 'Fill', type: 'select', default: 'gradient', options: [['solid', 'Solid'], ['gradient', 'Gradient']] },
    { key: 'color1', label: 'Color', type: 'color', default: '#6d5bf7' },
    { key: 'color2', label: 'Second color', type: 'color', default: '#c4b8ff', showIf: { fill: 'gradient' } },
    { key: 'aspect', label: 'Aspect', type: 'select', default: 'none', options: [['none', 'Fit image'], ['1:1', '1:1'], ['4:3', '4:3'], ['16:9', '16:9'], ['4:5', '4:5'], ['9:16', '9:16']] },
    { key: 'padding', label: 'Spacing %', type: 'range', min: 0, max: 40, default: 10 },
    { key: 'radius', label: 'Corner radius %', type: 'range', min: 0, max: 25, default: 4 },
  ],
  run: (f, o) => image.background(f, o),
});
add({ id: 'tool:image:pdf', mode: 'tools', cats: ['image'], short: 'Make PDF', label: 'Combine into one PDF', icon: 'pdf', multi: true, min: 2, run: (files) => image.imagesToPdf(files) });
add({
  id: 'tool:image:collage', mode: 'tools', cats: ['image'], short: 'Collage', label: 'Make a collage', icon: 'collage', multi: true, min: 2,
  options: [
    { key: 'layout', label: 'Layout', type: 'select', default: 'grid', options: [['grid', 'Grid'], ['row', 'Row'], ['column', 'Column'], ['featured', 'Featured']] },
    { key: 'cell', label: 'Tile size (px)', type: 'number', default: 800 },
    { key: 'spacing', label: 'Spacing (px)', type: 'number', default: 24 },
    { key: 'radius', label: 'Corner radius %', type: 'range', min: 0, max: 25, default: 3 },
    { key: 'background', label: 'Background', type: 'color', default: '#ffffff' },
  ],
  run: (files, o) => image.collage(files, o),
});

add({
  id: 'tool:video:compress', mode: 'tools', cats: ['video'], short: 'Compress', label: 'Compress video', icon: 'compress',
  options: [
    { key: 'quality', label: 'Quality', type: 'select', default: 'balanced', options: [['high', 'High'], ['balanced', 'Balanced'], ['small', 'Smallest']] },
    { key: 'height', label: 'Max resolution', type: 'select', default: '', options: [['', 'Keep'], ['2160', '4K'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']] },
  ],
  run: (f, o, c) => media.compressVideo(f, o, c.progress),
});
add({ id: 'tool:media:trim', mode: 'tools', cats: MEDIA_CATS, short: 'Trim', label: 'Trim', icon: 'trim', options: [...opt.trim, { key: 'precise', label: 'Cut', type: 'select', default: 'yes', options: [['yes', 'Frame-accurate (re-encode)'], ['no', 'Fast (keyframes)']] }], run: (f, o, c) => media.trim(f, o, c.progress) });
add({
  id: 'tool:video:resize', mode: 'tools', cats: ['video'], short: 'Resize', label: 'Resize video', icon: 'resize',
  options: [{ key: 'height', label: 'Resolution', type: 'select', default: '720', options: [['2160', '4K'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']] }],
  run: (f, o, c) => media.resizeVideo(f, o, c.progress),
});
add({
  id: 'tool:video:crop', mode: 'tools', cats: ['video'], short: 'Crop', label: 'Crop video', icon: 'crop',
  options: [{ key: 'aspect', label: 'Aspect', type: 'select', default: '1:1', options: [['1:1', 'Square 1:1'], ['16:9', '16:9'], ['9:16', 'Vertical 9:16'], ['4:3', '4:3'], ['3:4', '3:4'], ['4:5', 'Portrait 4:5'], ['21:9', '21:9']] }],
  hint: 'Crops from the center and keeps the original audio.',
  run: (f, o, c) => media.cropVideo(f, o, c.progress),
});
add({ id: 'tool:video:mute', mode: 'tools', cats: ['video'], short: 'Mute', label: 'Remove audio', icon: 'mute', run: (f, o, c) => media.mute(f, o, c.progress) });
add({
  id: 'tool:video:frame', mode: 'tools', cats: ['video'], short: 'Frame', label: 'Save a frame', icon: 'frame',
  options: [{ key: 'time', label: 'At', type: 'text', default: '0:01', hint: 'seconds or mm:ss' }, { key: 'format', label: 'Format', type: 'select', default: 'png', options: [['png', 'PNG'], ['jpg', 'JPG']] }],
  run: (f, o) => media.frame(f, o),
});
add({
  id: 'tool:video:rotate', mode: 'tools', cats: ['video'], short: 'Rotate', label: 'Rotate video', icon: 'rotate',
  options: [{ ...opt.angle, options: [...opt.angle.options, ['hflip', 'Flip horizontal'], ['vflip', 'Flip vertical']] }],
  run: (f, o, c) => media.rotateVideo(f, o, c.progress),
});
add({
  id: 'tool:media:speed', mode: 'tools', cats: MEDIA_CATS, short: 'Speed', label: 'Change speed', icon: 'speed',
  options: [{ key: 'factor', label: 'Speed', type: 'select', default: '2', options: [['0.5', '0.5×'], ['0.75', '0.75×'], ['1.25', '1.25×'], ['1.5', '1.5×'], ['2', '2×'], ['4', '4×']] }],
  run: (f, o, c) => media.speed(f, o, c.progress),
});
add({ id: 'tool:media:split', mode: 'tools', cats: MEDIA_CATS, short: 'Split', label: 'Split into parts', icon: 'split', options: [opt.split], run: (f, o, c) => media.split(f, o, c.progress) });
add({ id: 'tool:media:merge', mode: 'tools', cats: MEDIA_CATS, short: 'Merge', label: 'Merge in order', icon: 'merge', multi: true, min: 2, run: (files, o, c) => media.merge(files, o, c.progress) });
add({
  id: 'tool:audio:compress', mode: 'tools', cats: ['audio'], short: 'Compress', label: 'Compress audio', icon: 'compress',
  options: [
    { key: 'format', label: 'Format', type: 'select', default: 'mp3', options: [['mp3', 'MP3'], ['m4a', 'M4A (AAC)'], ['opus', 'Opus'], ['ogg', 'OGG']] },
    { key: 'bitrate', label: 'Bitrate', type: 'select', default: '128', options: [['64', '64 kbps'], ['96', '96 kbps'], ['128', '128 kbps'], ['192', '192 kbps'], ['256', '256 kbps']] },
  ],
  run: (f, o, c) => media.audioCompress(f, o, c.progress),
});
add({ id: 'tool:audio:normalize', mode: 'tools', cats: ['audio'], short: 'Normalize', label: 'Normalize loudness', icon: 'normalize', run: (f, o, c) => media.normalize(f, o, c.progress) });
add({ id: 'tool:audio:volume', mode: 'tools', cats: ['audio'], short: 'Volume', label: 'Change volume', icon: 'volume', options: [{ key: 'db', label: 'Gain (dB)', type: 'range', min: -20, max: 20, default: 6 }], run: (f, o, c) => media.volume(f, o, c.progress) });
add({ id: 'tool:audio:fade', mode: 'tools', cats: ['audio'], short: 'Fade', label: 'Fade in / out', icon: 'fade', options: [{ key: 'fadeIn', label: 'Fade in (s)', type: 'number', default: 2 }, { key: 'fadeOut', label: 'Fade out (s)', type: 'number', default: 3 }], run: (f, o, c) => media.fade(f, o, c.progress) });
add({
  id: 'tool:audio:channels', mode: 'tools', cats: ['audio'], short: 'Channels', label: 'Mono / stereo', icon: 'mono',
  options: [{ key: 'to', label: 'Convert to', type: 'select', default: 'mono', options: [['mono', 'Mono'], ['stereo', 'Stereo']] }],
  run: (f, o, c) => media.channels(f, o, c.progress),
});
add({
  id: 'tool:audio:silence', mode: 'tools', cats: ['audio'], short: 'Silence', label: 'Remove silence at the ends', icon: 'trim',
  options: [{ key: 'threshold', label: 'Silence below', type: 'select', default: '-50', options: [['-60', '-60 dB (very quiet)'], ['-50', '-50 dB'], ['-40', '-40 dB'], ['-30', '-30 dB (noisy room)']] }],
  run: (f, o, c) => media.trimSilence(f, o, c.progress),
});
add({
  id: 'tool:audio:visualize', mode: 'tools', cats: ['audio'], short: 'Visualize', label: 'Waveform video', icon: 'visualize',
  options: [
    { key: 'shape', label: 'Shape', type: 'select', default: 'landscape', options: [['landscape', 'Landscape 16:9'], ['portrait', 'Portrait 9:16'], ['square', 'Square']] },
    { key: 'color', label: 'Wave color', type: 'color', default: '#6d5bf7' },
  ],
  run: (f, o, c) => media.visualize(f, o, c.progress),
});
add({
  id: 'tool:media:bleep', mode: 'tools', cats: MEDIA_CATS, short: 'Bleep', label: 'Bleep ranges', icon: 'bleep',
  options: [{ key: 'ranges', label: 'Ranges', type: 'text', default: '', hint: 'e.g. 0:05-0:07, 1:10-1:12', remember: false }],
  run: (f, o, c) => media.bleep(f, o, c.progress),
});
add({
  id: 'tool:media:metadata', mode: 'tools', cats: MEDIA_CATS, short: 'Metadata', label: 'Edit metadata', icon: 'metadata',
  options: [
    { key: 'action', label: 'Action', type: 'select', default: 'strip', options: [['strip', 'Remove all metadata'], ['edit', 'Set tags']] },
    { key: 'title', label: 'Title', type: 'text', default: '', showIf: { action: 'edit' }, remember: false },
    { key: 'artist', label: 'Artist / author', type: 'text', default: '', showIf: { action: 'edit' } },
    { key: 'album', label: 'Album', type: 'text', default: '', showIf: { action: 'edit' } },
    { key: 'comment', label: 'Comment', type: 'text', default: '', showIf: { action: 'edit' }, remember: false },
  ],
  run: (f, o, c) => media.metadata(f, o, c.progress),
});

add({ id: 'tool:pdf:compress', mode: 'tools', cats: ['pdf'], short: 'Compress', label: 'Compress PDF', icon: 'compress', run: (f) => pdf.compress(f) });
add({ id: 'tool:pdf:merge', mode: 'tools', cats: ['pdf'], short: 'Merge', label: 'Merge PDFs', icon: 'merge', multi: true, min: 2, run: (files) => pdf.merge(files) });
add({ id: 'tool:pdf:split', mode: 'tools', cats: ['pdf'], short: 'Split', label: 'Split PDF', icon: 'split', options: [{ key: 'every', label: 'Pages per file', type: 'number', default: 1, min: 1 }], run: (f, o) => pdf.split(f, o) });
add({ id: 'tool:pdf:extract', mode: 'tools', cats: ['pdf'], short: 'Extract', label: 'Extract pages', icon: 'extract', options: [{ key: 'pages', label: 'Pages', type: 'text', default: '1', hint: 'e.g. 1-3, 5, 8-' }], run: (f, o) => pdf.extract(f, o) });
add({ id: 'tool:pdf:remove', mode: 'tools', cats: ['pdf'], short: 'Remove', label: 'Remove pages', icon: 'remove', options: [{ key: 'pages', label: 'Pages to remove', type: 'text', default: '1', hint: 'e.g. 2, 4-6' }], run: (f, o) => pdf.removePages(f, o) });
add({ id: 'tool:pdf:rotate', mode: 'tools', cats: ['pdf'], short: 'Rotate', label: 'Rotate pages', icon: 'rotate', options: [opt.angle, { key: 'pages', label: 'Pages', type: 'text', default: '', hint: 'blank = all' }], run: (f, o) => pdf.rotate(f, o) });
add({ id: 'tool:pdf:organize', mode: 'tools', cats: ['pdf'], short: 'Organize', label: 'Reorder pages', icon: 'organize', options: [{ key: 'order', label: 'New page order', type: 'text', default: '', hint: 'e.g. 3, 1, 2, 2, 5-  (repeat to duplicate)', remember: false }], run: (f, o) => pdf.organize(f, o) });
add({
  id: 'tool:pdf:metadata', mode: 'tools', cats: ['pdf'], short: 'Metadata', label: 'Edit metadata', icon: 'metadata',
  options: [
    { key: 'action', label: 'Action', type: 'select', default: 'strip', options: [['strip', 'Remove all metadata'], ['edit', 'Set fields']] },
    { key: 'title', label: 'Title', type: 'text', default: '', showIf: { action: 'edit' }, remember: false },
    { key: 'author', label: 'Author', type: 'text', default: '', showIf: { action: 'edit' } },
    { key: 'subject', label: 'Subject', type: 'text', default: '', showIf: { action: 'edit' }, remember: false },
    { key: 'keywords', label: 'Keywords', type: 'text', default: '', hint: 'comma separated', showIf: { action: 'edit' }, remember: false },
  ],
  run: (f, o) => pdf.metadata(f, o),
});
add({ id: 'tool:pdf:protect', mode: 'tools', cats: ['pdf'], short: 'Protect', label: 'Add a password', icon: 'lock', options: [{ key: 'password', label: 'Password', type: 'password', default: '', remember: false }], run: (f, o) => pdf.protect(f, o) });

add({ id: 'tool:subtitle:shift', mode: 'tools', cats: ['subtitle'], short: 'Shift', label: 'Shift timing', icon: 'speed', options: [{ key: 'seconds', label: 'Shift by (s)', type: 'number', default: 1, step: 0.1, hint: 'negative = earlier' }], run: (f, o) => subtitles.shift(f, o) });

const ANY = ['image', 'video', 'audio', 'pdf', 'document', 'ebook', 'slides', 'sheet', 'subtitle', 'archive', 'folder', 'other'];
add({ id: 'tool:any:zip', mode: 'tools', cats: ANY, short: 'ZIP', label: 'Compress to ZIP', icon: 'zip', multi: true, run: (files) => archive.compress(files, 'zip') });
add({ id: 'tool:any:targz', mode: 'tools', cats: ANY, short: 'TAR.GZ', label: 'Compress to TAR.GZ', icon: 'zip', multi: true, run: (files) => archive.compress(files, 'tar.gz') });

// ----- editor presets -------------------------------------------------------
// A second wheel of everyday conversions for video, audio and design work.
// `short` is the petal label, `sub` the small line under it.

function editorOp(op) {
  add({ mode: 'editor', ...op });
}

editorOp({ id: 'editor:video:cfr', cats: ['video'], short: 'CFR', sub: 'Fix VFR', label: 'Fix variable frame rate', run: (f, _o, c) => editor.fixVfr(f, _o, c.progress) });
editorOp({ id: 'editor:video:prores', cats: ['video'], short: 'ProRes', sub: '422', label: 'ProRes 422 (editing)', run: (f, _o, c) => editor.prores(f, _o, c.progress) });
editorOp({ id: 'editor:video:dnxhr', cats: ['video'], short: 'DNxHR', sub: 'HQ', label: 'DNxHR HQ (editing)', run: (f, _o, c) => editor.dnxhr(f, _o, c.progress) });
editorOp({ id: 'editor:video:proxy', cats: ['video'], short: 'Proxy', sub: 'Half res', label: 'ProRes Proxy in /Proxies', run: (f, _o, c) => editor.proxy(f, _o, c.progress) });
editorOp({ id: 'editor:video:remux', cats: ['video'], short: 'Remux', sub: 'MP4', label: 'Remux to MP4 (no re-encode)', run: (f, _o, c) => editor.remux(f, _o, c.progress) });
editorOp({ id: 'editor:video:reels', cats: ['video'], short: '9:16', sub: 'Reels', label: 'Reels / TikTok 1080×1920', run: (f, _o, c) => editor.reels(f, _o, c.progress) });
editorOp({ id: 'editor:video:square', cats: ['video'], short: '1:1', sub: 'Square', label: 'Square post 1080×1080', run: (f, _o, c) => editor.square(f, _o, c.progress) });
editorOp({ id: 'editor:video:pngseq', cats: ['video'], short: 'PNG', sub: 'Sequence', label: 'PNG image sequence', run: (f, _o, c) => editor.pngSequence(f, _o, c.progress) });
editorOp({ id: 'editor:media:wav48', cats: ['video', 'audio'], short: 'WAV', sub: '48k 24-bit', label: 'WAV 48 kHz / 24-bit', run: (f, _o, c) => editor.wav48(f, _o, c.progress) });

for (const [target, sub] of [[-14, 'Spotify · YT'], [-16, 'Podcast'], [-23, 'Broadcast']]) {
  editorOp({
    id: `editor:media:lufs${-target}`, cats: ['audio', 'video'], short: `${String(target).replace('-', '−')}`, sub,
    label: `Loudness ${String(target).replace('-', '−')} LUFS`, run: (f, _o, c) => editor.loudness(f, target, c.progress),
  });
}
editorOp({ id: 'editor:audio:mp3', cats: ['audio'], short: 'MP3', sub: '320k', label: 'MP3 320 kbps', excludeExts: ['mp3'], run: (f, _o, c) => editor.mp3320(f, _o, c.progress) });

editorOp({ id: 'editor:image:webjpg', cats: ['image'], short: 'WEB', sub: 'JPG', label: 'Web export (JPG, 2048px, sRGB)', excludeExts: ['svg'], run: (f) => editor.webExport(f, 'jpg') });
editorOp({ id: 'editor:image:webwebp', cats: ['image'], short: 'WEB', sub: 'WebP', label: 'Web export (WebP, 2048px, sRGB)', excludeExts: ['svg'], run: (f) => editor.webExport(f, 'webp') });
editorOp({ id: 'editor:image:scales', cats: ['image'], short: '@1–3x', sub: 'PNG set', label: 'PNG @1x, @2x, @3x', onlyExts: ['svg'], run: (f) => editor.svgScales(f) });
// Numbered frames (shot_0001.png) turn into a clip: MP4 to review, ProRes 4444 to composite.
const isFrame = (items) => items.every((i) => /\d{2,}\.[^.]+$/.test(i.file || 'x00.png'));
editorOp({ id: 'editor:image:seqmp4', cats: ['image'], short: 'MP4', sub: 'Sequence', label: 'Image sequence → MP4 (30 fps)', onlyExts: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'bmp'], when: isFrame, run: (f, _o, c) => editor.sequenceToVideo(f, 'mp4', c.progress) });
editorOp({ id: 'editor:image:seq4444', cats: ['image'], short: '4444', sub: 'Seq · alpha', label: 'Image sequence → ProRes 4444', onlyExts: ['png', 'tif', 'tiff'], when: isFrame, run: (f, _o, c) => editor.sequenceToVideo(f, 'prores', c.progress) });

// ----- file actions (handled by actions.js) --------------------------------

const ACTIONS = [
  { id: 'action:float', short: 'Float', label: 'Float on the shelf', icon: 'float' },
  { id: 'action:copy', short: 'Copy', label: 'Copy files to clipboard', icon: 'copy' },
  { id: 'action:copyto', short: 'Copy to…', label: 'Copy to a folder', icon: 'copyto' },
  { id: 'action:move', short: 'Move', label: 'Move to a folder', icon: 'move' },
  { id: 'action:path', short: 'Copy Path', label: 'Copy full paths', icon: 'path' },
  { id: 'action:terminal', short: 'Terminal', label: 'Open in terminal', icon: 'terminal' },
  { id: 'action:reveal', short: 'Reveal', label: process.platform === 'darwin' ? 'Show in Finder' : 'Show in folder', icon: 'reveal' },
  ...(process.platform === 'darwin' ? [{ id: 'action:share', short: 'Share', label: 'Share (AirDrop, Mail…)', icon: 'share' }] : []),
];
for (const a of ACTIONS) add({ ...a, mode: 'actions', cats: ANY, multi: true, action: true });

// ----- queries --------------------------------------------------------------

function officeOk(op, items) {
  if (op.needsOffice) return office.available();
  if (op.officeUnless) return office.available() || items.every((i) => op.officeUnless.includes(i.ext));
  return true;
}

function applies(op, items) {
  if (items.length < op.min || items.length > op.max) return false;
  if (!items.every((i) => op.cats.includes(i.cat))) return false;
  if (op.onlyExts && !items.every((i) => op.onlyExts.includes(i.ext))) return false;
  if (op.excludeExts && items.some((i) => op.excludeExts.includes(i.ext))) return false;
  if (op.when && !op.when(items)) return false;
  if (op.skipSame && items.every((i) => i.ext === op.target || (op.sameAs || []).includes(i.ext) || (op.target === 'jpg' && i.ext === 'jpeg') || (op.target === 'tiff' && i.ext === 'tif'))) return false;
  return officeOk(op, items);
}

function publicOp(op) {
  const { run, cats, when, ...rest } = op;
  // `sub` is the small line under a petal's label; `hint` stays the option card's note.
  const sub = op.sub || (op.mode === 'convert' ? HINTS[op.target] || '' : '');
  return { ...rest, sub, max: Number.isFinite(op.max) ? op.max : null };
}

// What's on the wheel out of the box: the handful of choices most people need.
// Everything else is one click away in Settings → Formats.
const RECOMMENDED = new Set([
  'edit:image', 'edit:media', 'edit:pdf',
  'convert:image:jpg', 'convert:image:png', 'convert:image:webp', 'convert:image:pdf', 'convert:image:mp4',
  'convert:video:mp4', 'convert:video:mov', 'convert:video:gif', 'convert:video:mp3',
  'convert:audio:mp3', 'convert:audio:wav', 'convert:audio:m4a',
  'convert:pdf:docx', 'convert:pdf:jpg', 'convert:pdf:png', 'convert:pdf:txt',
  'convert:document:pdf', 'convert:document:docx', 'convert:document:txt',
  'convert:ebook:pdf', 'convert:ebook:docx', 'convert:ebook:txt',
  'convert:slides:pdf', 'convert:slides:png',
  'convert:sheet:xlsx', 'convert:sheet:csv', 'convert:sheet:pdf',
  'convert:subtitle:srt', 'convert:subtitle:vtt', 'convert:subtitle:txt',
  'convert:archive:extract', 'convert:archive:zip', 'convert:folder:zip',
  'editor:video:prores', 'editor:video:proxy', 'editor:video:cfr', 'editor:video:reels',
  'editor:media:wav48', 'editor:media:lufs14', 'editor:media:lufs16', 'editor:image:webjpg', 'editor:image:scales', 'editor:image:seqmp4',
  'tool:image:compress', 'tool:image:resize', 'tool:image:pdf',
  'tool:video:compress', 'tool:video:mute', 'tool:video:frame',
  'tool:audio:compress', 'tool:audio:normalize',
  'tool:pdf:merge', 'tool:pdf:split', 'tool:pdf:compress', 'tool:any:zip',
  'action:copy', 'action:move', 'action:path', 'action:reveal',
]);

// Extensions: optional packs, all bundled (nothing is downloaded). Out of the
// box Wedge offers only RECOMMENDED; each pack adds the rest of its area.
const EXTENSIONS = [
  { id: 'images-plus', name: 'Images Plus', icon: 'image', cats: ['image'], tagline: 'Every image format' },
  { id: 'video-plus', name: 'Video Plus', icon: 'video', cats: ['video'], tagline: 'Every video format' },
  { id: 'audio-plus', name: 'Audio Plus', icon: 'music', cats: ['audio'], tagline: 'Every audio format' },
  { id: 'docs-plus', name: 'Docs Plus', icon: 'doc', cats: ['pdf', 'document', 'ebook', 'slides', 'sheet', 'subtitle', 'archive', 'folder', 'other'], tagline: 'Office, eBooks, archives' },
  { id: 'creator', name: 'Creator Pack', icon: 'sparkle', tagline: 'ProRes, proxies, loudness' },
  { id: 'file-actions', name: 'File Actions', icon: 'folder', tagline: 'Shelf, terminal, share' },
  { id: 'image-editor', name: 'Image Editor', icon: 'crop', opens: 'image', tagline: 'Crop, draw, redact' },
  { id: 'video-editor', name: 'Video Editor', icon: 'scissors', opens: 'media', tagline: 'Trim, crop, speed' },
  { id: 'pdf-editor', name: 'PDF Editor', icon: 'signature', opens: 'pdf', tagline: 'Pages, text, sign' },
];
const EDITOR_EXTENSION = { image: 'image-editor', media: 'video-editor', pdf: 'pdf-editor' };

// The pack an op comes from, or null when it's part of the core set.
function extensionOf(op) {
  if (op.opens) return EDITOR_EXTENSION[op.opens];
  if (op.mode === 'editor') return 'creator';
  if (RECOMMENDED.has(op.id)) return null;
  if (op.mode === 'actions') return 'file-actions';
  const pack = EXTENSIONS.find((e) => e.cats && e.cats.includes(op.cats[0]));
  return pack ? pack.id : 'docs-plus';
}

function isInstalled(id, installed = prefs().extensions || {}) {
  return !!installed[id];
}

function isAvailable(op, installed) {
  const ext = extensionOf(op);
  return !ext || isInstalled(ext, installed);
}

// Whether an op is on the wheel: it must be available, then the user's choice
// if they made one; otherwise yes.
function isVisible(id, visibility = prefs().opVisibility || {}, installed = prefs().extensions || {}) {
  const op = get(id);
  if (!op || !isAvailable(op, installed)) return false;
  return id in visibility ? !!visibility[id] : true;
}

// The user's wheel preferences from Settings: which ops show, and favorites in
// priority order.
let prefs = () => ({});
function setPrefsProvider(fn) {
  prefs = fn;
}

// What the wheel's center calls a file: "PNG · Image".
const KIND = {
  image: 'Image', video: 'Video', audio: 'Audio', pdf: 'Document', document: 'Document', ebook: 'eBook',
  slides: 'Presentation', sheet: 'Spreadsheet', subtitle: 'Subtitles', archive: 'Archive', folder: 'Folder', other: 'File',
};
const KIND_PLURAL = { image: 'Images', video: 'Videos', audio: 'Audio files', pdf: 'PDFs', document: 'Documents', ebook: 'eBooks', slides: 'Presentations', sheet: 'Spreadsheets', subtitle: 'Subtitles', archive: 'Archives', folder: 'Folders' };

// A one-word hint under each format on the wheel.
const HINTS = {
  jpg: 'Photo', png: 'Lossless', webp: 'Web', avif: 'Smallest', tiff: 'Print', bmp: 'Bitmap', gif: 'Animated', pdf: 'Document',
  mp4: 'Universal', mov: 'Apple', mkv: 'Flexible', webm: 'Web', avi: 'Legacy', wmv: 'Windows', mp3: 'Audio', m4a: 'AAC',
  wav: 'Lossless', flac: 'Lossless', ogg: 'Open', opus: 'Voice', aiff: 'Lossless', wma: 'Windows', docx: 'Word', txt: 'Plain text',
  md: 'Markdown', html: 'Web page', epub: 'eBook', pptx: 'Slides', xlsx: 'Excel', ods: 'OpenOffice', odt: 'OpenOffice', rtf: 'Rich text',
  csv: 'Data', tsv: 'Data', json: 'Data', srt: 'Subtitles', vtt: 'Web subs', zip: 'Archive', tar: 'Archive', 'tar.gz': 'Compressed',
};

function subject(items) {
  const cats = [...new Set(items.map((i) => i.cat))];
  if (items.length === 1) {
    const { file, ext, cat } = items[0];
    const name = file ? (cat === 'folder' ? path.basename(file) : path.basename(file, path.extname(file))) : '';
    const shownExt = ext === 'tgz' ? 'TAR.GZ' : ext.toUpperCase();
    return { name, ext: shownExt, kind: KIND[cat] || 'File', count: 1 };
  }
  const exts = [...new Set(items.map((i) => i.ext.toUpperCase()))];
  return {
    name: `${items.length} ${cats.length === 1 ? (KIND_PLURAL[cats[0]] || 'files').toLowerCase() : 'files'}`,
    ext: exts.length === 1 ? exts[0] : '',
    kind: cats.length === 1 ? KIND_PLURAL[cats[0]] || 'Files' : 'Mixed',
    count: items.length,
  };
}

function forItems(items) {
  const result = { convert: [], editor: [], tools: [], actions: [] };
  const { opVisibility = {}, favorites = [], favoritesFirst = true, extensions = {} } = prefs();
  const rank = new Map(favorites.map((id, i) => [id, i]));
  for (const op of ops) {
    if (isVisible(op.id, opVisibility, extensions) && applies(op, items)) result[op.mode].push({ ...publicOp(op), fav: rank.has(op.id) });
  }
  const byRank = (a, b) => rank.get(a.id) - rank.get(b.id);
  // Favorites lead each wheel, clockwise from the top (the sort keeps the rest in order).
  if (favoritesFirst) {
    for (const mode of Object.keys(result)) {
      result[mode] = [...result[mode].filter((o) => o.fav).sort(byRank), ...result[mode].filter((o) => !o.fav)];
    }
  }
  result.favorites = Object.values(result).flat().filter((o) => o.fav).sort(byRank);
  const cats = [...new Set(items.map((i) => i.cat))];
  const sub = subject(items);
  return { ...result, count: items.length, cats, subject: sub, summary: sub.name || `${sub.ext} ${sub.kind}`.trim() };
}

function forFiles(files) {
  return forItems(files.map(describe));
}

// Used mid-drag, when only MIME types are known. Returns null if any is unknown.
function forMimes(mimes) {
  const items = [];
  for (const m of mimes) {
    const e = MIME_EXT[m];
    if (!e) return null;
    items.push({ file: '', ext: e, cat: EXT_CAT[e] });
  }
  if (!items.length) return null;
  const res = forItems(items);
  // Only the type is known mid-drag; the name stays blank until the drop.
  res.summary = items.length === 1 ? `${items[0].ext.toUpperCase()} file` : res.summary;
  return res;
}

function get(id) {
  return ops.find((o) => o.id === id);
}

function counts() {
  let conversions = 0;
  for (const [key, c] of Object.entries(CATEGORIES)) {
    for (const e of c.exts) {
      conversions += ops.filter((o) => o.mode === 'convert' && !o.opens && applies({ ...o, needsOffice: false, officeUnless: null }, [{ ext: e, cat: key }])).length;
    }
  }
  return {
    conversions,
    editor: ops.filter((o) => o.mode === 'editor').length,
    tools: ops.filter((o) => o.mode === 'tools').length,
    actions: ops.filter((o) => o.mode === 'actions').length,
  };
}

// Everything Wedge can do, grouped by category, for the Formats section.
function formats() {
  const installed = prefs().extensions || {};
  const meta = (o) => ({ ext: extensionOf(o), available: isAvailable(o, installed) });
  return Object.entries(CATEGORIES).map(([key, c]) => ({
    key,
    label: c.label,
    inputs: c.exts.map((e) => e.toUpperCase()),
    convert: ops.filter((o) => o.mode === 'convert' && o.cats.includes(key) && !o.opens)
      .map((o) => ({ ...meta(o), id: o.id, recommended: RECOMMENDED.has(o.id), label: o.short, sub: o.sub || HINTS[o.target] || '', onlyFor: o.onlyExts?.map((e) => e.toUpperCase()), needsOffice: !!o.needsOffice || !!o.officeUnless, officeOk: officeOk(o, [{ ext: '' }]) })),
    editor: ops.filter((o) => o.mode === 'editor' && o.cats.includes(key))
      .map((o) => ({ ...meta(o), id: o.id, recommended: RECOMMENDED.has(o.id), sub: o.sub || '', label: o.short === 'WEB' || o.short.length < 3 ? `${o.short} ${o.sub}` : o.short, title: o.label, onlyFor: o.onlyExts?.map((e) => e.toUpperCase()) })),
    tools: ops.filter((o) => o.mode === 'tools' && o.cats.includes(key) && !o.cats.includes('other'))
      .map((o) => ({ ...meta(o), id: o.id, recommended: RECOMMENDED.has(o.id), label: o.label, short: o.short, multi: o.min > 1 })),
  }));
}

// Each pack with what it adds, for the Extensions page.
function extensionList() {
  const installed = prefs().extensions || {};
  return EXTENSIONS.map((e) => {
    const mine = ops.filter((o) => extensionOf(o) === e.id);
    const count = (mode) => mine.filter((o) => o.mode === mode && !o.opens).length;
    const conversions = mine.filter((o) => o.mode === 'convert' && !o.opens);
    return {
      id: e.id, name: e.name, icon: e.icon, tagline: e.tagline, editor: e.opens || null,
      installed: !!installed[e.id],
      adds: { formats: count('convert'), tools: count('tools'), presets: count('editor'), actions: count('actions') },
      samples: [...new Set(conversions.map((o) => o.short))],
    };
  });
}

// The file actions, for Settings.
function actionList() {
  const installed = prefs().extensions || {};
  return ops.filter((o) => o.mode === 'actions').map((o) => ({ id: o.id, label: o.label, recommended: RECOMMENDED.has(o.id), ext: extensionOf(o), available: isAvailable(o, installed) }));
}

module.exports = { forFiles, forMimes, get, counts, describe, formats, actionList, extensionList, isVisible, isInstalled, setPrefsProvider, RECOMMENDED, CATEGORIES, EXTENSIONS };
