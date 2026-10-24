// Video & audio editor: trim on a waveform timeline, crop to an aspect,
// change speed, mute, pick the output format, save frames.
const { file, name, toast, busy, basename, cleanError } = window.editorKit;
const $ = (s) => document.querySelector(s);
const video = $('#video');
const tl = $('#tl');
const tctx = tl.getContext('2d');
const cropBox = $('#crop-box');

const S = {
  info: null,
  duration: 0,
  start: 0,
  end: 0,
  peaks: [],
  aspect: 'none',
  cropPos: { cx: 0.5, cy: 0.5 }, // crop box center as a fraction of the frame
  speed: 1,
  mute: false,
  format: 'same',
  drag: null,
};

const ASPECTS = [['none', 'Original'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5'], ['4:3', '4:3']];
const SPEEDS = [[0.5, '0.5×'], [1, '1×'], [1.5, '1.5×'], [2, '2×']];

const fmt = (t) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isAudio = () => S.info?.isAudio;
const FRAME = 1 / 30;

// ----- timeline ----------------------------------------------------------------------

function tlLayout() {
  const dpr = window.devicePixelRatio || 1;
  const r = tl.getBoundingClientRect();
  tl.width = Math.round(r.width * dpr);
  tl.height = Math.round(r.height * dpr);
  drawTimeline();
}

const PAD = 14;
const xOf = (t) => PAD + (t / (S.duration || 1)) * (tl.getBoundingClientRect().width - PAD * 2);
const tOf = (x) => clamp(((x - PAD) / (tl.getBoundingClientRect().width - PAD * 2)) * S.duration, 0, S.duration);

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const w = tl.width / dpr;
  const h = tl.height / dpr;
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.clearRect(0, 0, w, h);
  if (!S.duration) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim();
  const muted = css.getPropertyValue('--text-3').trim();
  const mid = h / 2;
  const inner = w - PAD * 2;
  // Waveform bars
  const bars = Math.floor(inner / 3);
  for (let i = 0; i < bars; i++) {
    const t = (i / bars) * S.duration;
    const peak = S.peaks.length ? S.peaks[Math.floor((i / bars) * S.peaks.length)] : 0.15;
    const bh = Math.max(2, peak * (h - 28));
    const inside = t >= S.start && t <= S.end;
    tctx.fillStyle = inside ? accent : muted;
    tctx.globalAlpha = inside ? 0.85 : 0.35;
    tctx.fillRect(PAD + i * 3, mid - bh / 2, 2, bh);
  }
  tctx.globalAlpha = 1;
  // Trim region frame
  const x0 = xOf(S.start);
  const x1 = xOf(S.end);
  tctx.strokeStyle = accent;
  tctx.lineWidth = 2;
  tctx.beginPath();
  tctx.roundRect(x0, 6, x1 - x0, h - 12, 8);
  tctx.stroke();
  // Handles
  for (const x of [x0, x1]) {
    tctx.fillStyle = accent;
    tctx.beginPath();
    tctx.roundRect(x - 6, 6, 12, h - 12, 6);
    tctx.fill();
    tctx.fillStyle = 'rgba(255,255,255,.9)';
    tctx.fillRect(x - 1, mid - 9, 2, 18);
  }
  // Playhead
  const px = xOf(video.currentTime || 0);
  tctx.fillStyle = css.getPropertyValue('--text').trim();
  tctx.fillRect(px - 1, 2, 2, h - 4);
  tctx.beginPath();
  tctx.arc(px, 4, 4, 0, Math.PI * 2);
  tctx.fill();
}

tl.addEventListener('pointerdown', (e) => {
  if (!S.duration) return;
  try { tl.setPointerCapture(e.pointerId); } catch {}
  const x = e.offsetX;
  if (Math.abs(x - xOf(S.start)) < 10) S.drag = 'start';
  else if (Math.abs(x - xOf(S.end)) < 10) S.drag = 'end';
  else {
    S.drag = 'seek';
    video.currentTime = tOf(x);
  }
});
tl.addEventListener('pointermove', (e) => {
  const x = e.offsetX;
  if (!S.drag) {
    tl.style.cursor = Math.abs(x - xOf(S.start)) < 10 || Math.abs(x - xOf(S.end)) < 10 ? 'ew-resize' : 'pointer';
    return;
  }
  const t = tOf(x);
  if (S.drag === 'start') { S.start = clamp(t, 0, S.end - 0.1); video.currentTime = S.start; }
  else if (S.drag === 'end') { S.end = clamp(t, S.start + 0.1, S.duration); video.currentTime = S.end; }
  else video.currentTime = t;
  drawTimeline();
  renderPanel();
});
tl.addEventListener('pointerup', () => (S.drag = null));

// ----- playback ------------------------------------------------------------------------

function togglePlay() {
  if (video.paused) {
    if (video.currentTime < S.start || video.currentTime >= S.end - 0.05) video.currentTime = S.start;
    video.play();
  } else video.pause();
}
function syncTransport() {
  $('#play').innerHTML = icon(video.paused ? 'play' : 'pause', 18);
  $('#time').textContent = `${fmt(video.currentTime)} / ${fmt(S.duration)}`;
}
video.addEventListener('play', syncTransport);
video.addEventListener('pause', syncTransport);
video.addEventListener('timeupdate', () => {
  // Preview loops inside the trimmed range.
  if (!video.paused && video.currentTime >= S.end) {
    video.pause();
    video.currentTime = S.start;
  }
  syncTransport();
  drawTimeline();
});
(function tick() {
  if (!video.paused) drawTimeline();
  requestAnimationFrame(tick);
})();

function setIn() { S.start = clamp(video.currentTime, 0, S.end - 0.1); drawTimeline(); renderPanel(); }
function setOut() { S.end = clamp(video.currentTime, S.start + 0.1, S.duration); drawTimeline(); renderPanel(); }

// ----- crop ---------------------------------------------------------------------------------

// Where the picture actually sits inside the <video> element (object-fit: contain).
function videoRect() {
  const r = video.getBoundingClientRect();
  const pr = $('#player').getBoundingClientRect();
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: r.left - pr.left + (r.width - w) / 2, top: r.top - pr.top + (r.height - h) / 2, w, h };
}

function cropFraction() {
  if (S.aspect === 'none' || isAudio()) return null;
  const [a, b] = S.aspect.split(':').map(Number);
  const frameRatio = (video.videoWidth || 16) / (video.videoHeight || 9);
  const target = a / b;
  let fw = 1;
  let fh = 1;
  if (target < frameRatio) fw = target / frameRatio;
  else fh = frameRatio / target;
  const fx = clamp(S.cropPos.cx - fw / 2, 0, 1 - fw);
  const fy = clamp(S.cropPos.cy - fh / 2, 0, 1 - fh);
  return { fx, fy, fw, fh };
}

function layoutCrop() {
  const c = cropFraction();
  const clip = $('#clip');
  const dims = clip.querySelectorAll('.dim');
  if (!c) {
    cropBox.style.display = 'none';
    for (const d of dims) d.style.display = 'none';
    return;
  }
  const vr = videoRect();
  Object.assign(clip.style, { left: `${vr.left}px`, top: `${vr.top}px`, width: `${vr.w}px`, height: `${vr.h}px` });
  const x = c.fx * vr.w;
  const y = c.fy * vr.h;
  const w = c.fw * vr.w;
  const hh = c.fh * vr.h;
  Object.assign(cropBox.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
  // Four panels darken everything outside the crop.
  const rects = [[0, 0, vr.w, y], [0, y + hh, vr.w, vr.h - y - hh], [0, y, x, hh], [x + w, y, vr.w - x - w, hh]];
  dims.forEach((d, i) => {
    const [l, t, rw, rh] = rects[i];
    Object.assign(d.style, { display: 'block', left: `${l}px`, top: `${t}px`, width: `${Math.max(0, rw)}px`, height: `${Math.max(0, rh)}px` });
  });
}

cropBox.addEventListener('pointerdown', (e) => {
  try { cropBox.setPointerCapture(e.pointerId); } catch {}
  S.cropDrag = { x: e.clientX, y: e.clientY, start: { ...S.cropPos } };
});
cropBox.addEventListener('pointermove', (e) => {
  if (!S.cropDrag) return;
  const vr = videoRect();
  const c = cropFraction();
  S.cropPos = {
    cx: clamp(S.cropDrag.start.cx + (e.clientX - S.cropDrag.x) / vr.w, c.fw / 2, 1 - c.fw / 2),
    cy: clamp(S.cropDrag.start.cy + (e.clientY - S.cropDrag.y) / vr.h, c.fh / 2, 1 - c.fh / 2),
  };
  layoutCrop();
});
cropBox.addEventListener('pointerup', () => (S.cropDrag = null));

// ----- panel ---------------------------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
function chips(options, value, onPick) {
  return h('div', { class: 'chipset' }, options.map(([v, l]) => h('button', { type: 'button', class: v === value ? 'on' : '', 'aria-pressed': String(v === value), onclick: () => onPick(v) }, l)));
}

function formats() {
  if (isAudio()) return [['same', S.info.ext.toUpperCase()], ['mp3', 'MP3'], ['wav', 'WAV'], ['m4a', 'M4A']];
  return [['same', ['mp4', 'mov', 'webm', 'mkv'].includes(S.info?.ext) ? S.info.ext.toUpperCase() : 'MP4'], ['gif', 'GIF'], ['mp3', 'Audio only']];
}

function renderPanel() {
  if (!S.info) return;
  const length = (S.end - S.start) / S.speed;
  const parts = [
    h('h3', {}, 'Trim'),
    h('p', {}, 'Drag the handles on the timeline, or play and press I / O.'),
    h('div', { class: 'readout' }, `${fmt(S.start)} → ${fmt(S.end)}`),
    h('div', { class: 'readout' }, `Length ${fmt(length)}`),
    (S.start > 0 || S.end < S.duration) ? h('button', { type: 'button', class: 'btn block', onclick: () => { S.start = 0; S.end = S.duration; drawTimeline(); renderPanel(); } }, 'Reset trim') : null,
  ];
  if (!isAudio()) {
    parts.push(h('h3', {}, 'Crop'), chips(ASPECTS, S.aspect, (v) => { S.aspect = v; S.cropPos = { cx: 0.5, cy: 0.5 }; renderPanel(); layoutCrop(); }),
      S.aspect !== 'none' ? h('p', { style: 'margin-top:8px' }, 'Drag the box on the video to frame it.') : null);
  }
  parts.push(h('h3', {}, 'Speed'), chips(SPEEDS, S.speed, (v) => { S.speed = v; video.playbackRate = v; renderPanel(); }));
  if (!isAudio() && S.info.hasAudio) {
    parts.push(h('h3', {}, 'Sound'), h('div', { class: 'chipset wide' },
      h('button', { type: 'button', class: S.mute ? '' : 'on', html: `${icon('volume', 15)}<span>Keep</span>`, onclick: () => { S.mute = false; video.muted = false; renderPanel(); } }),
      h('button', { type: 'button', class: S.mute ? 'on' : '', html: `${icon('mute', 15)}<span>Mute</span>`, onclick: () => { S.mute = true; video.muted = true; renderPanel(); } })));
  }
  parts.push(h('h3', {}, 'Save as'), chips(formats(), S.format, (v) => { S.format = v; renderPanel(); }));
  $('#panel').replaceChildren(...parts.filter(Boolean));
}

// ----- export ----------------------------------------------------------------------------------

async function exportClip() {
  if (!S.info) return;
  video.pause();
  busy('Exporting…', 0);
  const off = wedge.on.editProgress((p) => busy('Exporting…', p));
  try {
    const out = await wedge.edit.exportMedia(file, {
      start: S.start, end: S.end, speed: S.speed, mute: S.mute, format: S.format, crop: cropFraction(),
    });
    toast(`Saved ${basename(out)}`, { reveal: out });
  } catch (err) {
    toast(cleanError(err), { error: true });
  } finally {
    off();
    busy(null);
  }
}

async function snapshot() {
  try {
    const out = await wedge.edit.snapshot(file, video.currentTime);
    toast(`Saved ${basename(out)}`, { reveal: out });
  } catch (err) {
    toast(cleanError(err), { error: true });
  }
}

// ----- keyboard & setup ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return exportClip(); }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key.toLowerCase() === 'i') setIn();
  if (e.key.toLowerCase() === 'o') setOut();
  if (e.key === 'ArrowLeft') { video.currentTime = clamp(video.currentTime - (e.shiftKey ? 1 : FRAME), 0, S.duration); }
  if (e.key === 'ArrowRight') { video.currentTime = clamp(video.currentTime + (e.shiftKey ? 1 : FRAME), 0, S.duration); }
});

async function init() {
  await window.editorKit.applyLook();
  $('#name').textContent = name;
  $('#save').innerHTML = `${icon('check', 15)}<span>Export</span>`;
  $('#snap').innerHTML = `${icon('camera', 15)}<span>Frame</span>`;
  $('#set-in').onclick = setIn;
  $('#set-out').onclick = setOut;
  $('#play').onclick = togglePlay;
  $('#save').onclick = exportClip;
  $('#snap').onclick = snapshot;
  syncTransport();
  new ResizeObserver(() => { tlLayout(); layoutCrop(); }).observe($('#stage'));
  try {
    S.info = await wedge.edit.mediaInfo(file);
    document.body.classList.toggle('audio', S.info.isAudio);
    $('#kind-icon').innerHTML = icon(S.info.isAudio ? 'volume' : 'video', 15);
    $('#disc').innerHTML = icon('volume', 54);
    $('#audio-name').textContent = name;
    $('#snap').hidden = S.info.isAudio;
    document.title = `${name} · Wedge`;
    S.duration = S.info.duration;
    S.end = S.duration;
    $('#dims').textContent = S.info.isAudio ? fmt(S.duration) : `${S.info.width}×${S.info.height} · ${fmt(S.duration)}`;
    renderPanel();
    // Chromium can't play every container/codec; fall back to a quick preview copy.
    video.src = S.info.url;
    video.addEventListener('error', async () => {
      if (video.dataset.proxy) return;
      video.dataset.proxy = '1';
      $('#loading').textContent = 'Preparing a preview…';
      $('#loading').hidden = false;
      try {
        video.src = await wedge.edit.previewProxy(file);
      } catch (err) {
        $('#loading').textContent = `Can't preview this file: ${cleanError(err)}`;
      }
    });
    video.addEventListener('loadedmetadata', () => {
      $('#loading').hidden = true;
      if (!S.duration && video.duration) { S.duration = video.duration; S.end = S.duration; renderPanel(); }
      tlLayout();
      layoutCrop();
    });
    S.peaks = await wedge.edit.waveform(file);
    drawTimeline();
  } catch (err) {
    $('#loading').textContent = `Couldn't open this file: ${cleanError(err)}`;
  }
}
init();
