// Shared helpers: paths, output naming, temp dirs and the FFmpeg runner.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Native binaries live outside the asar archive once packaged.
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

const FFMPEG = unpacked(require('ffmpeg-static'));

function ext(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function base(file) {
  return path.basename(file, path.extname(file));
}

let outputDirResolver = (input) => path.dirname(input);
function setOutputDirResolver(fn) {
  outputDirResolver = fn;
}

function outDir(input) {
  return outputDirResolver(input);
}

// Returns a free path next to the input (or in the configured output folder).
function outPath(input, newExt, suffix = '') {
  const dir = outputDirResolver(input);
  return uniquePath(path.join(dir, `${base(input)}${suffix}.${newExt}`));
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const e = path.extname(p);
  const b = path.basename(p, e);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${b} (${i})${e}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function uniqueDir(p) {
  if (!fs.existsSync(p)) return p;
  for (let i = 1; ; i++) {
    const candidate = `${p} (${i})`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wedge-'));
}

async function withTemp(fn) {
  const dir = await tempDir();
  try {
    return await fn(dir);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function parseTime(s) {
  if (s === undefined || s === null || s === '') return null;
  if (typeof s === 'number') return s;
  const parts = String(s).trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Invalid time "${s}". Use seconds or hh:mm:ss.`);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

// Runs FFmpeg, reporting progress (0..1) from its stderr timestamps.
function ffmpeg(args, { onProgress, duration } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-y', ...args], { windowsHide: true });
    let stderr = '';
    let total = duration || 0;
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-20000);
      if (!total) {
        const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
        if (d) total = +d[1] * 3600 + +d[2] * 60 + +d[3];
      }
      const t = /time=(\d+):(\d+):([\d.]+)/g;
      let m, last;
      while ((m = t.exec(text))) last = m;
      if (last && total && onProgress) {
        onProgress(Math.min(1, (+last[1] * 3600 + +last[2] * 60 + +last[3]) / total));
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else {
        const lines = stderr.trim().split('\n').filter((l) => !/^\s*(frame|size)=/.test(l));
        // Lines like "[Parsed_loudnorm_0 @ ...] Value out of range" name the real cause;
        // the last lines are often just "Conversion failed!".
        const cause = lines.filter((l) => /^\[[^\]]+ @ /.test(l)).slice(-1);
        reject(new Error(`FFmpeg failed: ${[...cause, ...lines.slice(-3)].join(' ').trim()}`));
      }
    });
  });
}

// Reads stream info from `ffmpeg -i` (ffprobe is not bundled).
async function probe(file) {
  let stderr = '';
  await new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', file], { windowsHide: true });
    proc.stderr.on('data', (c) => (stderr += c));
    proc.on('close', resolve);
    proc.on('error', resolve);
  });
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  const videoLine = /Stream #[^\n]*Video: [^\n]*/.exec(stderr)?.[0] || '';
  const audioLine = /Stream #[^\n]*Audio: [^\n]*/.exec(stderr)?.[0] || '';
  const v = /(\d{2,5})x(\d{2,5})/.exec(videoLine);
  const fps = /([\d.]+) fps/.exec(videoLine) || /([\d.]+) tbr/.exec(videoLine);
  return {
    duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0,
    hasVideo: !!videoLine && !/attached pic/.test(videoLine),
    hasAudio: !!audioLine,
    width: v ? +v[1] : 0,
    height: v ? +v[2] : 0,
    fps: fps ? Number(fps[1]) : 0,
    videoCodec: /Video: (\w+)/.exec(videoLine)?.[1] || '',
    audioCodec: /Audio: (\w+)/.exec(audioLine)?.[1] || '',
  };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (c) => (out += c));
    proc.stderr?.on('data', (c) => (err += c));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited with ${code}`))));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Parses page ranges like "1-3, 5, 8-" into zero-based indices.
function parseRanges(spec, count) {
  const pages = [];
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? +m[2] : count;
      for (let i = a; i <= b; i++) if (i >= 1 && i <= count) pages.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      const i = +part;
      if (i >= 1 && i <= count) pages.push(i - 1);
    } else {
      throw new Error(`Invalid page range "${part}"`);
    }
  }
  if (!pages.length) throw new Error('No pages selected');
  return pages;
}

// A module that loads on first use. Wedge idles in the background most of the time,
// so heavy libraries (sharp, pdf-lib, SheetJS...) stay out of memory until a
// conversion needs them. Works for objects, functions (sharp) and classes (AdmZip).
function lazy(name) {
  let mod;
  const load = () => (mod ??= require(name));
  return new Proxy(function () {}, {
    get: (_t, key) => load()[key],
    apply: (_t, self, args) => load().apply(self, args),
    construct: (_t, args) => new (load())(...args),
  });
}

module.exports = {
  lazy, FFMPEG, unpacked, ext, base, outDir, outPath, uniquePath, uniqueDir, tempDir, withTemp,
  parseTime, ffmpeg, probe, run, escapeHtml, parseRanges, setOutputDirResolver,
};
