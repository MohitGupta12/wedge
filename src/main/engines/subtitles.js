// SRT <-> VTT <-> TXT subtitle conversion and timing shifts.
const fsp = require('fs/promises');
const { ext, outPath } = require('../util');

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})|(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function toMs(s) {
  const m = TIME.exec(s);
  if (!m) return 0;
  if (m[1] !== undefined) return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0');
  return (+m[5] * 60 + +m[6]) * 1000 + +m[7].padEnd(3, '0');
}

function fmt(ms, sep) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

function parse(text) {
  const cues = [];
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    cues.push({ start: toMs(a), end: toMs(b), text: lines.slice(i + 1).join('\n') });
  }
  return cues;
}

function write(cues, target) {
  if (target === 'srt') return cues.map((c, i) => `${i + 1}\n${fmt(c.start, ',')} --> ${fmt(c.end, ',')}\n${c.text}\n`).join('\n');
  if (target === 'vtt') return 'WEBVTT\n\n' + cues.map((c) => `${fmt(c.start, '.')} --> ${fmt(c.end, '.')}\n${c.text}\n`).join('\n');
  // Plain transcript: drop styling tags and merge into paragraphs.
  return cues.map((c) => c.text.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '')).join('\n') + '\n';
}

async function convert(file, target) {
  const cues = parse(await fsp.readFile(file, 'utf8'));
  if (!cues.length) throw new Error('No subtitle cues found');
  const out = outPath(file, target);
  await fsp.writeFile(out, write(cues, target));
  return [out];
}

async function shift(file, opts) {
  const ms = (Number(opts.seconds) || 0) * 1000;
  const cues = parse(await fsp.readFile(file, 'utf8')).map((c) => ({ ...c, start: c.start + ms, end: c.end + ms }));
  const out = outPath(file, ext(file), '-shifted');
  await fsp.writeFile(out, write(cues, ext(file)));
  return [out];
}

module.exports = { convert, shift, parse };
