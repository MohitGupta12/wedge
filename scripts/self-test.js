// End-to-end check of the conversion engines, run inside Electron:
//   npx electron . --self-test
// Generates fixtures in a temp folder, runs a representative op from every
// category through the real job runner, and verifies each output exists.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const sharp = require('sharp');
const util = require('../src/main/util');
const catalog = require('../src/main/catalog');
const { Jobs } = require('../src/main/jobs');

async function fixtures(dir) {
  const f = (n) => path.join(dir, n);
  await sharp({ create: { width: 640, height: 400, channels: 3, background: '#ff8a3d' } })
    .composite([{ input: Buffer.from('<svg width="640" height="400"><circle cx="320" cy="200" r="120" fill="#2b6cb0"/></svg>') }])
    .jpeg().toFile(f('photo.jpg'));
  await sharp(f('photo.jpg')).png().toFile(f('graphic.png'));
  await util.ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('clip.mp4')]);
  await util.ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '3', f('tone.wav')]);
  await fsp.writeFile(f('notes.md'), '# Notes\n\nSome **bold** text and a list:\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  await fsp.writeFile(f('data.csv'), 'name,qty\napple,3\npear,5\n');
  await fsp.writeFile(f('logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="12" fill="#6d5bf7"/><circle cx="24" cy="24" r="10" fill="#fff"/></svg>');
  for (let i = 1; i <= 12; i++) {
    await sharp({ create: { width: 160, height: 90, channels: 4, background: { r: 20 * i, g: 80, b: 200, alpha: 0.5 } } }).png().toFile(f(`shot_${String(i).padStart(4, '0')}.png`));
  }
  await util.ffmpeg(['-i', f('clip.mp4'), '-c', 'copy', f('recording.mkv')]);
  await fsp.writeFile(f('subs.srt'), '1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral Kenobi\n');
  return f;
}

const CASES = [
  ['convert:image:png', ['photo.jpg']],
  ['convert:image:webp', ['photo.jpg']],
  ['convert:image:avif', ['photo.jpg']],
  ['convert:image:bmp', ['photo.jpg']],
  ['convert:image:pdf', ['photo.jpg']],
  ['tool:image:compress', ['photo.jpg'], { mode: 'size', targetKB: 10 }],
  ['tool:image:crop', ['photo.jpg'], { aspect: '1:1' }],
  ['tool:image:background', ['graphic.png'], { fill: 'gradient', color1: '#ff8a3d', color2: '#ffd166', aspect: '1:1', padding: 10, radius: 4 }],
  ['tool:image:collage', ['photo.jpg', 'graphic.png'], { layout: 'grid', cell: 200, spacing: 10, radius: 3, background: '#ffffff' }],
  ['tool:image:pdf', ['photo.jpg', 'graphic.png']],
  ['convert:video:webm', ['clip.mp4']],
  ['convert:video:gif', ['clip.mp4']],
  ['convert:video:mp3', ['clip.mp4']],
  ['tool:media:trim', ['clip.mp4'], { start: '0:01', end: '0:02', precise: 'yes' }],
  ['tool:video:frame', ['clip.mp4'], { time: '1', format: 'png' }],
  ['convert:audio:flac', ['tone.wav']],
  ['convert:audio:opus', ['tone.wav']],
  ['tool:audio:normalize', ['tone.wav']],
  ['convert:document:docx', ['notes.md']],
  ['convert:document:html', ['notes.md']],
  ['convert:document:pdf', ['notes.md']],
  ['convert:document:epub', ['notes.md']],
  ['convert:sheet:xlsx', ['data.csv']],
  ['convert:sheet:pdf', ['data.csv']],
  ['convert:subtitle:vtt', ['subs.srt']],
  ['tool:any:zip', ['photo.jpg', 'notes.md']],
];

// Second wave: inputs produced by the first wave.
const CHAINED = [
  ['convert:pdf:png', ['notes.pdf']],
  ['convert:pdf:docx', ['notes.pdf']],
  ['convert:pdf:pptx', ['notes.pdf']],
  ['tool:pdf:merge', ['notes.pdf', 'photo.pdf']],
  ['tool:pdf:compress', ['notes.pdf']],
  ['convert:document:md', ['notes.docx']],
  ['convert:slides:pdf', ['notes.pptx']],
  ['convert:sheet:csv', ['data.xlsx']],
  ['convert:image:jpg', ['photo.avif']],
  ['convert:archive:extract', ['Archive.zip']],
  ['convert:archive:tar.gz', ['Archive.zip']],
  ['convert:pdf:xlsx', ['data.pdf']],
  ['tool:pdf:organize', ['notes (merged).pdf'], { order: '2, 1, 1' }],
  ['tool:pdf:metadata', ['notes.pdf'], { action: 'edit', title: 'Notes', author: 'Wedge' }],
  ['convert:document:png', ['notes.md']],
  ['convert:ebook:pdf', ['notes.epub']],
  ['convert:ebook:md', ['notes.epub']],
  ['tool:video:crop', ['clip.mp4'], { aspect: '1:1' }],
  ['tool:media:metadata', ['clip.mp4'], { action: 'strip' }],
  ['tool:media:metadata', ['tone.wav'], { action: 'edit', title: 'Tone', artist: 'Wedge' }],
  ['tool:audio:channels', ['tone.wav'], { to: 'stereo' }],
  ['tool:audio:silence', ['tone.wav'], { threshold: '-50' }],
  ['tool:audio:visualize', ['tone.wav'], { shape: 'square', color: '#ff7a1a' }],
  ['tool:media:bleep', ['tone.wav'], { ranges: '0:01-0:02' }],
  ['tool:media:bleep', ['clip.mp4'], { ranges: '0:01-0:02' }],
  ['editor:video:cfr', ['clip.mp4']],
  ['editor:video:prores', ['clip.mp4']],
  ['editor:video:dnxhr', ['clip.mp4']],
  ['editor:video:proxy', ['clip.mp4']],
  ['editor:video:remux', ['recording.mkv']],
  ['editor:video:reels', ['clip.mp4']],
  ['editor:video:square', ['clip.mp4']],
  ['editor:video:pngseq', ['clip.mp4']],
  ['editor:media:wav48', ['clip.mp4']],
  ['editor:media:wav48', ['tone.wav']],
  ['editor:media:lufs16', ['tone.wav']],
  ['editor:media:lufs14', ['clip.mp4']],
  ['editor:media:lufs23', ['tone.flac']],
  ['editor:audio:mp3', ['tone.wav']],
  ['editor:image:webjpg', ['photo.jpg']],
  ['editor:image:webwebp', ['graphic.png']],
  ['editor:image:scales', ['logo.svg']],
  ['editor:image:seqmp4', ['shot_0001.png']],
  ['editor:image:seq4444', ['shot_0005.png']],
];

async function runCases(jobs, f, cases) {
  let failed = 0;
  for (const [id, inputs, options] of cases) {
    const files = inputs.map(f);
    const t = Date.now();
    const job = await jobs.run(id, files, options || {});
    const ok = job.status === 'done' && job.outputs.length && job.outputs.every((o) => fs.existsSync(o));
    const size = ok ? job.outputs.map((o) => (fs.statSync(o).isDirectory() ? 'dir' : `${Math.round(fs.statSync(o).size / 1024)}KB`)).join(',') : '';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(30)} ${String(Date.now() - t).padStart(5)}ms  ${ok ? `${job.outputs.map((o) => path.basename(o)).join(', ')} (${size})` : JSON.stringify(job.errors)}`);
    if (!ok) failed++;
  }
  return failed;
}

// The visual editors' back end, called the way the editor windows call it.
async function editorChecks(f) {
  const editing = require('../src/main/engines/editing');
  const { PDFDocument } = require('pdf-lib');
  const checks = [
    ['editor: load image', async () => (await editing.loadImage(f('photo.jpg'))).width === 640],
    ['editor: save image', async () => {
      const png = await sharp({ create: { width: 64, height: 36, channels: 4, background: '#6d5bf7' } }).png().toBuffer();
      const out = await editing.saveImage(f('photo.jpg'), `data:image/png;base64,${png.toString('base64')}`, 'same');
      const m = await sharp(out).metadata();
      return out.endsWith('-edited.jpg') && m.width === 64;
    }],
    ['editor: waveform', async () => (await editing.waveform(f('clip.mp4'))).length > 100],
    ['editor: trim + crop video', async () => {
      const out = await editing.exportMedia(f('clip.mp4'), { start: 0.5, end: 2, crop: { fx: 0.25, fy: 0, fw: 0.5, fh: 1 }, speed: 1, mute: false, format: 'same' });
      const i = await util.probe(out);
      return i.width === 160 && i.height === 240 && Math.abs(i.duration - 1.5) < 0.15;
    }],
    ['editor: audio trim to mp3', async () => {
      const out = await editing.exportMedia(f('tone.wav'), { start: 1, end: 2, format: 'mp3' });
      return out.endsWith('.mp3') && Math.abs((await util.probe(out)).duration - 1) < 0.15;
    }],
    ['editor: video snapshot', async () => fs.existsSync(await editing.snapshot(f('clip.mp4'), 1))],
    ['editor: pdf pages', async () => {
      const info = await editing.pdfInfo(f('notes (merged).pdf'));
      const thumb = await editing.pdfThumb(f('notes (merged).pdf'), 0, 120);
      const out = await editing.savePdf(f('notes (merged).pdf'), [{ src: 1, rotate: 90 }, { src: 0, rotate: 0 }]);
      const doc = await PDFDocument.load(fs.readFileSync(out));
      return info.pages.length === 2 && thumb.startsWith('data:image/png') && doc.getPage(0).getRotation().angle === 90;
    }],
    ['editor: pdf annotate & sign', async () => {
      const dot = (await sharp({ create: { width: 40, height: 20, channels: 4, background: '#1f4bd8' } }).png().toBuffer()).toString('base64');
      const hindi = (await sharp({ create: { width: 60, height: 14, channels: 4, background: '#000' } }).png().toBuffer()).toString('base64');
      const annots = [
        { type: 'text', x: 40, y: 40, size: 12, color: '#111111', text: 'Signed by Wedge\nLine two' },
        { type: 'text', x: 40, y: 80, size: 12, color: '#111111', text: 'नमस्ते', png: `data:image/png;base64,${hindi}`, w: 60, h: 14 },
        { type: 'rect', kind: 'highlight', x: 30, y: 30, w: 120, h: 20, color: '#ffe14d' },
        { type: 'rect', kind: 'whiteout', x: 200, y: 200, w: 50, h: 20, color: '#ffffff', opacity: 1 },
        { type: 'image', kind: 'signature', x: 40, y: 120, w: 80, h: 40, url: `data:image/png;base64,${dot}` },
      ];
      const out = await editing.savePdf(f('notes (merged).pdf'), [{ src: 0, rotate: 0, annots }, { src: 1, rotate: 90, annots }], '-signed');
      const m = await import('mupdf');
      const doc = m.Document.openDocument(fs.readFileSync(out), 'application/pdf');
      return doc.countPages() === 2 && doc.loadPage(0).search('Signed by Wedge').length > 0 && doc.loadPage(1).search('Line two').length > 0;
    }],
  ];
  let failed = 0;
  for (const [label, fn] of checks) {
    let ok = false;
    let error = '';
    try {
      ok = await fn();
    } catch (err) {
      error = err.message;
    }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${error ? `  ${error}` : ''}`);
    if (!ok) failed++;
  }
  return failed;
}

async function run() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wedge-selftest-'));
  console.log('Fixtures in', dir);
  let failed = 0;
  try {
    const f = await fixtures(dir);
    const jobs = new Jobs(() => ({ imageQuality: 90, pdfDpi: 100 }));
    failed += await runCases(jobs, f, CASES);
    failed += await runCases(jobs, f, CHAINED.filter(([id]) => id !== 'convert:slides:pdf'));
    // A text deck lays out without LibreOffice.
    const PptxGen = require('pptxgenjs');
    const deck = new PptxGen();
    deck.addSlide().addText('Quarterly update', { x: 1, y: 1, fontSize: 32 });
    deck.addSlide().addText('Revenue is up', { x: 1, y: 1, fontSize: 24 });
    await deck.writeFile({ fileName: f('deck.pptx') });
    failed += await runCases(jobs, f, [['convert:slides:pdf', ['deck.pptx']], ['convert:slides:png', ['deck.pptx']]]);
    failed += await editorChecks(f);
    const c = catalog.counts();
    console.log(`\nCatalog: ${c.conversions} conversion options, ${c.tools} tools, ${c.actions} actions`);
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  } catch (err) {
    console.error(err);
    failed++;
  }
  app.exit(failed ? 1 : 0);
}

module.exports = { run };
