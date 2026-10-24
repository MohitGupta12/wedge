// Image editor: crop, draw, arrows, boxes, text, redact, rotate and flip.
// Annotations stay editable shapes in image coordinates until you save; rotating
// or flipping bakes them into the pixels first.
const { file, name, toast, busy, basename, cleanError } = window.editorKit;
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const view = $('#view');
const ctx = view.getContext('2d');
const textInput = $('#text-input');

const TOOLS = [
  { id: 'crop', icon: 'crop', label: 'Crop', key: 'C' },
  { id: 'pen', icon: 'pen', label: 'Draw', key: 'P' },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlight', key: 'H' },
  { id: 'arrow', icon: 'arrow', label: 'Arrow', key: 'A' },
  { id: 'rect', icon: 'square', label: 'Box', key: 'R' },
  { id: 'text', icon: 'type', label: 'Text', key: 'T' },
  { id: 'redact', icon: 'redact', label: 'Redact', key: 'B' },
];
const COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ffffff', '#111111'];
const HIGHLIGHTS = ['#ffe14d', '#7dff8a', '#ff7ad9', '#6ad8ff'];
const ASPECTS = [['free', 'Free'], ['original', 'Original'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:2', '3:2'], ['16:9', '16:9'], ['9:16', '9:16'], ['4:5', '4:5']];
const SIZES = { s: 1, m: 2, l: 4 };
const TEXT_SIZES = { s: 3, m: 5, l: 8, xl: 12 };

const S = {
  base: null, // full-resolution canvas of the image (after rotations/flips)
  shapes: [],
  crop: null, // {x, y, w, h} in image pixels
  tool: 'crop',
  color: COLORS[0],
  highlight: HIGHLIGHTS[0],
  size: 'm',
  textSize: 'm',
  aspect: 'free',
  draft: null,
  drag: null,
  history: [],
  future: [],
  fit: { scale: 1, ox: 0, oy: 0 },
};

// ----- history ------------------------------------------------------------------------

const snapshot = () => ({ base: S.base, shapes: S.shapes.map((s) => ({ ...s, points: s.points?.map((p) => [...p]) })), crop: S.crop && { ...S.crop } });
function restore(snap) {
  S.base = snap.base;
  S.shapes = snap.shapes;
  S.crop = snap.crop;
  layout();
}
function remember() {
  S.history.push(snapshot());
  if (S.history.length > 60) S.history.shift();
  S.future = [];
  syncButtons();
}
function undo() {
  if (!S.history.length) return;
  S.future.push(snapshot());
  restore(S.history.pop());
  syncButtons();
}
function redo() {
  if (!S.future.length) return;
  S.history.push(snapshot());
  restore(S.future.pop());
  syncButtons();
}
function syncButtons() {
  $('#undo').disabled = !S.history.length;
  $('#redo').disabled = !S.future.length;
}

// ----- geometry -------------------------------------------------------------------------

const W = () => S.base.width;
const H = () => S.base.height;
const unit = () => Math.max(W(), H()) / 420; // stroke widths scale with the image

function layout() {
  const dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  view.width = Math.round(r.width * dpr);
  view.height = Math.round(r.height * dpr);
  if (S.base) {
    const pad = 48;
    const scale = Math.min((r.width - pad) / W(), (r.height - pad) / H(), 4);
    S.fit = { scale, ox: (r.width - W() * scale) / 2, oy: (r.height - H() * scale) / 2 };
    $('#dims').textContent = S.crop ? `${Math.round(S.crop.w)} × ${Math.round(S.crop.h)} crop` : `${W()} × ${H()}`;
  }
  render();
}

function toImage(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left - S.fit.ox) / S.fit.scale, y: (e.clientY - r.top - S.fit.oy) / S.fit.scale };
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function ratio() {
  if (S.aspect === 'free') return null;
  if (S.aspect === 'original') return W() / H();
  const [a, b] = S.aspect.split(':').map(Number);
  return a / b;
}

// The largest centered crop with the chosen aspect.
function fitCrop(r) {
  let w = W();
  let h = w / r;
  if (h > H()) { h = H(); w = h * r; }
  return { x: (W() - w) / 2, y: (H() - h) / 2, w, h };
}

function normRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

// ----- drawing ----------------------------------------------------------------------------

function drawShape(c, s) {
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (s.type === 'pen' || s.type === 'highlighter') {
    c.strokeStyle = s.color;
    c.lineWidth = s.width;
    c.globalAlpha = s.type === 'highlighter' ? 0.38 : 1;
    if (s.type === 'highlighter') c.globalCompositeOperation = 'multiply';
    const pts = s.points;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    c.lineTo(last[0], last[1]);
    c.stroke();
  } else if (s.type === 'arrow') {
    const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = Math.max(s.width * 4.2, 10);
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = s.width;
    c.beginPath();
    c.moveTo(s.x1, s.y1);
    c.lineTo(s.x2 - Math.cos(ang) * head * 0.6, s.y2 - Math.sin(ang) * head * 0.6);
    c.stroke();
    c.beginPath();
    c.moveTo(s.x2, s.y2);
    c.lineTo(s.x2 - Math.cos(ang - 0.42) * head, s.y2 - Math.sin(ang - 0.42) * head);
    c.lineTo(s.x2 - Math.cos(ang + 0.42) * head, s.y2 - Math.sin(ang + 0.42) * head);
    c.closePath();
    c.fill();
  } else if (s.type === 'rect') {
    c.strokeStyle = s.color;
    c.lineWidth = s.width;
    const r = Math.min(s.w, s.h, s.width * 3) / 2;
    c.beginPath();
    c.roundRect(s.x, s.y, s.w, s.h, r);
    c.stroke();
  } else if (s.type === 'text') {
    c.font = `650 ${s.size}px Geist, "Segoe UI", sans-serif`;
    c.textBaseline = 'top';
    c.lineWidth = Math.max(2, s.size / 9);
    c.strokeStyle = s.color === '#111111' ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.55)';
    c.strokeText(s.text, s.x, s.y);
    c.fillStyle = s.color;
    c.fillText(s.text, s.x, s.y);
  } else if (s.type === 'redact') {
    // Pixelate from the underlying image so the original detail can't be recovered.
    const block = Math.max(8, Math.round(Math.max(s.w, s.h) / 10));
    const tw = Math.max(1, Math.round(s.w / block));
    const th = Math.max(1, Math.round(s.h / block));
    const tmp = document.createElement('canvas');
    tmp.width = tw;
    tmp.height = th;
    tmp.getContext('2d').drawImage(S.base, s.x, s.y, s.w, s.h, 0, 0, tw, th);
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, 0, 0, tw, th, s.x, s.y, s.w, s.h);
  }
  c.restore();
}

const HANDLE = 9; // screen px

function cropHandles(cr) {
  const { x, y, w, h } = cr;
  return { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2], se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2] };
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  if (!S.base) return;
  const { scale, ox, oy } = S.fit;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.25)';
  ctx.shadowBlur = 24 / scale;
  ctx.drawImage(S.base, 0, 0);
  ctx.restore();
  ctx.imageSmoothingQuality = 'high';
  for (const s of S.shapes) drawShape(ctx, s);
  if (S.draft) drawShape(ctx, S.draft);

  const cr = S.crop;
  if (cr) {
    const lw = 1 / scale;
    ctx.save();
    ctx.fillStyle = 'rgba(8, 8, 14, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, W(), H());
    ctx.rect(cr.x, cr.y, cr.w, cr.h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * lw;
    ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);
    if (S.tool === 'crop') {
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = lw;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(cr.x + (cr.w * i) / 3, cr.y);
        ctx.lineTo(cr.x + (cr.w * i) / 3, cr.y + cr.h);
        ctx.moveTo(cr.x, cr.y + (cr.h * i) / 3);
        ctx.lineTo(cr.x + cr.w, cr.y + (cr.h * i) / 3);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const hs = HANDLE / scale;
      for (const [hx, hy] of Object.values(cropHandles(cr))) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,.35)';
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.roundRect(hx - hs / 2, hy - hs / 2, hs, hs, hs / 3);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// ----- pointer ------------------------------------------------------------------------------

function hitHandle(p) {
  if (!S.crop) return null;
  const tol = (HANDLE + 4) / S.fit.scale;
  for (const [k, [hx, hy]] of Object.entries(cropHandles(S.crop))) if (Math.abs(p.x - hx) <= tol && Math.abs(p.y - hy) <= tol) return k;
  const c = S.crop;
  if (p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) return 'move';
  return null;
}

// Resizes a crop from a handle, keeping the aspect when one is set.
function resizeCrop(start, handle, p) {
  let { x, y, w, h } = start;
  const r = ratio();
  const right = x + w;
  const bottom = y + h;
  if (handle.includes('w')) { x = clamp(p.x, 0, right - 8); w = right - x; }
  if (handle.includes('e')) { w = clamp(p.x, x + 8, W()) - x; }
  if (handle.includes('n')) { y = clamp(p.y, 0, bottom - 8); h = bottom - y; }
  if (handle.includes('s')) { h = clamp(p.y, y + 8, H()) - y; }
  if (r) {
    if (handle === 'n' || handle === 's') w = h * r;
    else h = w / r;
    if (handle.includes('n')) y = bottom - h;
    if (handle.includes('w')) x = right - w;
    if (x < 0 || y < 0 || x + w > W() || y + h > H()) return start;
  }
  return { x, y, w, h };
}

view.addEventListener('pointerdown', (e) => {
  if (!S.base || e.button !== 0) return;
  if (!textInput.hidden) commitText();
  try { view.setPointerCapture(e.pointerId); } catch {} // keeps the drag when the pointer leaves the canvas
  const p = toImage(e);
  const before = snapshot();
  const u = unit();
  if (S.tool === 'crop') {
    const handle = hitHandle(p);
    if (handle === 'move') S.drag = { kind: 'move', from: p, start: { ...S.crop }, before };
    else if (handle) S.drag = { kind: 'resize', handle, start: { ...S.crop }, before };
    else S.drag = { kind: 'new', from: { x: clamp(p.x, 0, W()), y: clamp(p.y, 0, H()) }, before };
  } else if (S.tool === 'pen' || S.tool === 'highlighter') {
    const hl = S.tool === 'highlighter';
    S.draft = { type: S.tool, color: hl ? S.highlight : S.color, width: u * SIZES[S.size] * (hl ? 4 : 1.5), points: [[p.x, p.y]] };
    S.drag = { kind: 'draw', before };
  } else if (S.tool === 'arrow') {
    S.draft = { type: 'arrow', color: S.color, width: u * SIZES[S.size] * 1.5, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    S.drag = { kind: 'draw', before };
  } else if (S.tool === 'rect' || S.tool === 'redact') {
    S.draft = { type: S.tool, color: S.color, width: u * SIZES[S.size] * 1.5, x: p.x, y: p.y, w: 0, h: 0, from: p };
    S.drag = { kind: 'draw', before };
  } else if (S.tool === 'text') {
    openText(e, p);
  }
});

view.addEventListener('pointermove', (e) => {
  const p = toImage(e);
  if (!S.drag) {
    if (S.tool === 'crop') {
      const h = hitHandle(p);
      const cursors = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };
      view.style.cursor = cursors[h] || 'crosshair';
    } else view.style.cursor = S.tool === 'text' ? 'text' : 'crosshair';
    return;
  }
  const d = S.drag;
  if (d.kind === 'new') {
    const q = { x: clamp(p.x, 0, W()), y: clamp(p.y, 0, H()) };
    let rect = normRect(d.from, q);
    const r = ratio();
    if (r) {
      const h = rect.w / r;
      rect = { x: rect.x, y: q.y < d.from.y ? d.from.y - h : d.from.y, w: rect.w, h };
      if (rect.y < 0 || rect.y + rect.h > H()) return;
    }
    S.crop = rect;
  } else if (d.kind === 'move') {
    const c = d.start;
    S.crop = { ...c, x: clamp(c.x + p.x - d.from.x, 0, W() - c.w), y: clamp(c.y + p.y - d.from.y, 0, H() - c.h) };
  } else if (d.kind === 'resize') {
    S.crop = resizeCrop(d.start, d.handle, p);
  } else if (d.kind === 'draw') {
    const s = S.draft;
    if (s.points) s.points.push([p.x, p.y]);
    else if (s.type === 'arrow') { s.x2 = p.x; s.y2 = p.y; }
    else Object.assign(s, normRect(s.from, p));
  }
  layout();
});

view.addEventListener('pointerup', () => {
  const d = S.drag;
  S.drag = null;
  if (!d) return;
  if (d.kind === 'draw') {
    const s = S.draft;
    S.draft = null;
    const big = s.points ? s.points.length > 1 : s.type === 'arrow' ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 4 : s.w > 4 && s.h > 4;
    if (big) {
      delete s.from;
      S.history.push(d.before);
      S.future = [];
      S.shapes.push(s);
    }
  } else {
    if (S.crop && (S.crop.w < 6 || S.crop.h < 6)) S.crop = d.before.crop;
    if (JSON.stringify(S.crop) !== JSON.stringify(d.before.crop)) {
      S.history.push(d.before);
      S.future = [];
    }
  }
  syncButtons();
  layout();
  renderPanel();
});

// ----- text ----------------------------------------------------------------------------------

let textAt = null;
function openText(e, p) {
  textAt = p;
  const r = stage.getBoundingClientRect();
  const size = unit() * TEXT_SIZES[S.textSize] * 4;
  textInput.hidden = false;
  textInput.value = '';
  textInput.style.left = `${e.clientX - r.left}px`;
  textInput.style.top = `${e.clientY - r.top}px`;
  textInput.style.fontSize = `${Math.max(12, size * S.fit.scale)}px`;
  textInput.style.color = S.color;
  setTimeout(() => textInput.focus(), 0);
}
function commitText() {
  const text = textInput.value.trim();
  textInput.hidden = true;
  if (!text || !textAt) return;
  remember();
  S.shapes.push({ type: 'text', text, x: textAt.x, y: textAt.y, color: S.color, size: unit() * TEXT_SIZES[S.textSize] * 4 });
  textAt = null;
  layout();
}
textInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') commitText();
  if (e.key === 'Escape') { textInput.hidden = true; textAt = null; }
});
textInput.addEventListener('blur', () => !textInput.hidden && commitText());

// ----- transforms ------------------------------------------------------------------------------

// Bakes the shapes into the pixels, then rotates/flips the whole image.
function transform(kind) {
  remember();
  const flat = document.createElement('canvas');
  flat.width = W();
  flat.height = H();
  const fc = flat.getContext('2d');
  fc.drawImage(S.base, 0, 0);
  for (const s of S.shapes) drawShape(fc, s);
  const quarter = kind === 'rotl' || kind === 'rotr';
  const out = document.createElement('canvas');
  out.width = quarter ? H() : W();
  out.height = quarter ? W() : H();
  const oc = out.getContext('2d');
  if (kind === 'rotr') { oc.translate(out.width, 0); oc.rotate(Math.PI / 2); }
  if (kind === 'rotl') { oc.translate(0, out.height); oc.rotate(-Math.PI / 2); }
  if (kind === 'fliph') { oc.translate(out.width, 0); oc.scale(-1, 1); }
  if (kind === 'flipv') { oc.translate(0, out.height); oc.scale(1, -1); }
  oc.drawImage(flat, 0, 0);
  S.base = out;
  S.shapes = [];
  S.crop = null;
  layout();
  renderPanel();
}

function setAspect(a) {
  S.aspect = a;
  const r = ratio();
  if (r) {
    remember();
    S.crop = fitCrop(r);
  }
  layout();
  renderPanel();
}

// ----- panel -------------------------------------------------------------------------------------

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

function swatchRow(colors, value, onPick) {
  return h('div', { class: 'swatches' }, colors.map((c) => h('button', { type: 'button', class: `swatch${c === value ? ' on' : ''}`, style: `background:${c}`, 'aria-label': c, onclick: () => onPick(c) })));
}

function renderPanel() {
  const panel = $('#panel');
  const t = S.tool;
  const parts = [];
  if (t === 'crop') {
    parts.push(h('h3', {}, 'Crop'), h('p', {}, 'Drag on the image to draw a crop, then drag the corners to adjust.'),
      chips(ASPECTS, S.aspect, setAspect),
      S.crop ? h('div', { class: 'readout' }, `${Math.round(S.crop.w)} × ${Math.round(S.crop.h)} px`) : null,
      S.crop ? h('button', { type: 'button', class: 'btn block', onclick: () => { remember(); S.crop = null; layout(); renderPanel(); } }, 'Remove crop') : null);
  } else if (t === 'pen' || t === 'arrow' || t === 'rect') {
    parts.push(h('h3', {}, 'Color'), swatchRow(COLORS, S.color, (c) => { S.color = c; renderPanel(); }),
      h('h3', {}, 'Thickness'), chips([['s', 'Thin'], ['m', 'Medium'], ['l', 'Bold']], S.size, (v) => { S.size = v; renderPanel(); }));
  } else if (t === 'highlighter') {
    parts.push(h('h3', {}, 'Color'), swatchRow(HIGHLIGHTS, S.highlight, (c) => { S.highlight = c; renderPanel(); }),
      h('h3', {}, 'Width'), chips([['s', 'Narrow'], ['m', 'Medium'], ['l', 'Wide']], S.size, (v) => { S.size = v; renderPanel(); }));
  } else if (t === 'text') {
    parts.push(h('p', {}, 'Click where the text should go, type, then press Enter.'),
      h('h3', {}, 'Color'), swatchRow(COLORS, S.color, (c) => { S.color = c; renderPanel(); }),
      h('h3', {}, 'Size'), chips([['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']], S.textSize, (v) => { S.textSize = v; renderPanel(); }));
  } else if (t === 'redact') {
    parts.push(h('h3', {}, 'Redact'), h('p', {}, 'Drag over faces, names, numbers or addresses. The area is pixelated in the saved copy, so the detail can’t be recovered.'));
  }
  parts.push(h('h3', {}, 'Rotate & flip'),
    h('div', { class: 'chipset wide' },
      h('button', { type: 'button', title: 'Rotate left', html: icon('rotl', 16), onclick: () => transform('rotl') }),
      h('button', { type: 'button', title: 'Rotate right', html: icon('rotr', 16), onclick: () => transform('rotr') }),
      h('button', { type: 'button', title: 'Flip horizontal', html: icon('fliph', 16), onclick: () => transform('fliph') }),
      h('button', { type: 'button', title: 'Flip vertical', html: icon('flipv', 16), onclick: () => transform('flipv') })),
    S.shapes.length ? h('button', { type: 'button', class: 'btn block', onclick: () => { remember(); S.shapes.pop(); layout(); } }, 'Remove last mark') : null);
  panel.replaceChildren(...parts.filter(Boolean));
}

function setTool(id) {
  if (!textInput.hidden) commitText();
  S.tool = id;
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('on', b.dataset.tool === id);
  renderPanel();
  render();
}

// ----- save --------------------------------------------------------------------------------------

async function save() {
  if (!S.base) return;
  if (!textInput.hidden) commitText();
  const c = S.crop || { x: 0, y: 0, w: W(), h: H() };
  const out = document.createElement('canvas');
  out.width = Math.round(c.w);
  out.height = Math.round(c.h);
  const oc = out.getContext('2d');
  oc.translate(-Math.round(c.x), -Math.round(c.y));
  oc.drawImage(S.base, 0, 0);
  for (const s of S.shapes) drawShape(oc, s);
  busy('Saving…', 0.6);
  try {
    const saved = await wedge.edit.saveImage(file, out.toDataURL('image/png'), $('#format').value);
    toast(`Saved ${basename(saved)}`, { reveal: saved });
  } catch (err) {
    toast(cleanError(err), { error: true });
  } finally {
    busy(null);
  }
}

// ----- keyboard & setup ----------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return save(); }
  if (mod || e.altKey) return;
  const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
  if (t) setTool(t.id);
  if (e.key === 'Escape' && S.drag) { restore(S.drag.before); S.drag = null; S.draft = null; }
});

async function init() {
  await window.editorKit.applyLook();
  $('#name').textContent = name;
  $('#kind-icon').innerHTML = icon('image', 15);
  $('#undo').innerHTML = icon('undo');
  $('#redo').innerHTML = icon('redo');
  $('#save').innerHTML = `${icon('check', 15)}<span>Save copy</span>`;
  $('#tools').replaceChildren(...TOOLS.map((t) => {
    const b = h('button', { type: 'button', class: 'tool', 'data-tool': t.id, 'aria-label': t.label, html: icon(t.icon, 19), onclick: () => setTool(t.id) });
    b.append(h('span', { class: 'tip' }, t.label, h('kbd', {}, t.key)));
    return b;
  }));
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#save').onclick = save;
  new ResizeObserver(layout).observe(stage);
  setTool('crop');
  syncButtons();
  try {
    const { url } = await wedge.edit.loadImage(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    S.base = c;
    $('#loading').remove();
    layout();
  } catch (err) {
    $('#loading').textContent = `Couldn't open this image: ${cleanError(err)}`;
  }
}
init();
