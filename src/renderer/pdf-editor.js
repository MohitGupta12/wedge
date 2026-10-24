// PDF editor. Two views:
//   pages - reorder by dragging, rotate, duplicate, delete, extract
//   page  - annotate and sign one page: text, signature, check, date,
//           highlight, white-out. Marks are positioned in points from the
//           displayed page's top-left and burned into the saved copy.
const { file, name, toast, busy, basename, cleanError } = window.editorKit;
const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const layer = $('#layer');

const S = {
  info: null,
  pages: [], // [{ key, src, rotate, annots: [] }]
  selected: new Set(),
  anchor: null,
  history: [],
  future: [],
  thumbs: new Map(),
  nextKey: 1,
  view: 'pages',
  current: null, // key of the page being annotated
  zoom: 1,
  tool: 'select',
  textSize: 12,
  textColor: '#111111',
  highlight: '#ffe14d',
  signature: null, // data URL chosen for the Sign tool
  savedSignatures: [],
  selAnnot: null, // id of the selected mark
  editing: null, // id of the text mark being typed in
  nextAnnot: 1,
};

const TOOLS = [
  { id: 'select', icon: 'cursor', label: 'Select & move', key: 'V' },
  { id: 'text', icon: 'type', label: 'Text', key: 'T' },
  { id: 'sign', icon: 'signature', label: 'Signature', key: 'S' },
  { id: 'check', icon: 'check', label: 'Checkmark', key: 'K' },
  { id: 'date', icon: 'calendar', label: 'Date', key: 'D' },
  { id: 'highlight', icon: 'highlighter', label: 'Highlight', key: 'H' },
  { id: 'whiteout', icon: 'square', label: 'White-out', key: 'W' },
];
const TEXT_SIZES = [[9, 'S'], [12, 'M'], [16, 'L'], [24, 'XL']];
const TEXT_COLORS = ['#111111', '#1f4bd8', '#d92d20', '#0e8a4f'];
const HIGHLIGHTS = ['#ffe14d', '#8ef59b', '#ff9ad5', '#8fd3ff'];

const clone = (pages) => pages.map((p) => ({ ...p, annots: (p.annots || []).map((a) => ({ ...a })) }));
function remember() {
  S.history.push(clone(S.pages));
  if (S.history.length > 80) S.history.shift();
  S.future = [];
  syncUndo();
}
function undo() {
  if (!S.history.length) return;
  S.future.push(clone(S.pages));
  S.pages = S.history.pop();
  S.selAnnot = null;
  refresh();
}
function redo() {
  if (!S.future.length) return;
  S.history.push(clone(S.pages));
  S.pages = S.future.pop();
  S.selAnnot = null;
  refresh();
}
function syncUndo() {
  $('#undo').disabled = !S.history.length;
  $('#redo').disabled = !S.future.length;
}
const refresh = () => (S.view === 'page' ? renderPage() : render());

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
const chips = (options, value, onPick) => h('div', { class: 'chipset' }, options.map(([v, l]) => h('button', { type: 'button', class: v === value ? 'on' : '', 'aria-pressed': String(v === value), onclick: () => onPick(v) }, l)));
const swatchRow = (colors, value, onPick) => h('div', { class: 'swatches' }, colors.map((c) => h('button', { type: 'button', class: `swatch${c === value ? ' on' : ''}`, style: `background:${c}`, 'aria-label': c, onclick: () => onPick(c) })));

// ----- page geometry ------------------------------------------------------------------

const page = () => S.pages.find((p) => p.key === S.current);
// Displayed page size in points, after the editor's extra rotation.
function pageSize(p) {
  const { w, h: ph } = S.info.pages[p.src];
  return p.rotate % 180 ? { w: ph, h: w } : { w, h: ph };
}

// Keeps marks on the same spot of the content when a page is turned.
function rotateAnnots(p, deg) {
  if (!p.annots?.length) return;
  const { w: W, h: H } = pageSize(p); // size before this turn
  for (const a of p.annots) {
    const cx = a.x + (a.w || 0) / 2;
    const cy = a.y + (a.h || 0) / 2;
    const [nx, ny] = deg === 90 ? [H - cy, cx] : deg === -90 || deg === 270 ? [cy, W - cx] : [W - cx, H - cy];
    if (a.type === 'rect' && Math.abs(deg) === 90) [a.w, a.h] = [a.h, a.w];
    a.x = nx - (a.w || 0) / 2;
    a.y = ny - (a.h || 0) / 2;
  }
}

// ----- page grid ---------------------------------------------------------------------------

const targets = () => (S.selected.size ? S.pages.filter((p) => S.selected.has(p.key)) : S.pages);

function rotate(deg, list = targets()) {
  remember();
  for (const p of list) {
    rotateAnnots(p, deg);
    p.rotate = (((p.rotate + deg) % 360) + 360) % 360;
  }
  refresh();
}
function remove() {
  if (!S.selected.size) return;
  if (S.selected.size === S.pages.length) return toast('A PDF needs at least one page', { error: true });
  remember();
  S.pages = S.pages.filter((p) => !S.selected.has(p.key));
  S.selected.clear();
  render();
}
function duplicate() {
  if (!S.selected.size) return;
  remember();
  const out = [];
  for (const p of S.pages) {
    out.push(p);
    if (S.selected.has(p.key)) out.push({ ...p, key: S.nextKey++, annots: (p.annots || []).map((a) => ({ ...a, id: S.nextAnnot++ })) });
  }
  S.pages = out;
  render();
}
function selectAll() {
  const all = S.selected.size !== S.pages.length;
  S.selected = new Set(all ? S.pages.map((p) => p.key) : []);
  render();
}

function renderToolbar() {
  const any = S.selected.size > 0;
  const b = (label, ic, onclick, opts = {}) => h('button', { type: 'button', class: `btn${opts.accent ? ' accent' : ''}`, title: opts.title || label, disabled: opts.disabled || null, onclick, html: `${icon(ic, 15)}<span>${label}</span>` });
  $('#toolbar').replaceChildren(
    b('Annotate & sign', 'pen', () => openPage(any ? [...S.selected][0] : S.pages[0].key), { accent: true, title: 'Add text, signatures, checkmarks… (or double-click a page)' }),
    b(S.selected.size === S.pages.length && S.pages.length ? 'Select none' : 'Select all', 'check', selectAll, { title: 'Ctrl+A' }),
    b('Rotate left', 'rotl', () => rotate(-90)),
    b('Rotate right', 'rotr', () => rotate(90), { title: 'R' }),
    b('Duplicate', 'copy', duplicate, { disabled: !any, title: 'Ctrl+D' }),
    b('Delete', 'trash', remove, { disabled: !any, title: 'Del' }),
    b('Extract', 'extract', () => save(true), { disabled: !any, title: 'Save the selected pages as a new PDF' }),
    h('span', { class: 'count' }, any ? `${S.selected.size} of ${S.pages.length} selected` : `${S.pages.length} pages · drag to reorder · double-click to annotate`),
  );
  syncUndo();
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    observer.unobserve(e.target);
    loadThumb(Number(e.target.dataset.src), e.target);
  }
}, { root: $('#stage'), rootMargin: '400px' });

async function loadThumb(src, img) {
  if (!S.thumbs.has(src)) S.thumbs.set(src, wedge.edit.pdfThumb(file, src, 260));
  try {
    img.src = await S.thumbs.get(src);
  } catch {}
}

let dragKey = null;

function render() {
  renderToolbar();
  const cards = S.pages.map((p, i) => {
    const { w, h: ph } = S.info.pages[p.src];
    const fit = p.rotate % 180 ? Math.min(w / ph, ph / w) : 1;
    const img = h('img', { alt: `Page ${p.src + 1}`, 'data-src': p.src, style: `transform: rotate(${p.rotate}deg) scale(${fit})`, draggable: 'false' });
    if (S.thumbs.has(p.src)) loadThumb(p.src, img);
    else observer.observe(img);
    const notes = [p.src !== i ? `was ${p.src + 1}` : '', p.rotate ? `${p.rotate}°` : ''].filter(Boolean).join(' · ');
    const card = h('div', { class: `page${S.selected.has(p.key) ? ' sel' : ''}`, draggable: 'true', 'data-key': p.key, tabindex: '0', 'aria-label': `Page ${i + 1}` },
      h('div', { class: 'thumb' }, img),
      h('span', { class: 'check', html: icon('check', 14) }),
      h('div', { class: 'label' }, h('b', {}, String(i + 1)),
        p.annots?.length ? h('span', { class: 'marks', title: 'Annotations on this page', html: `${icon('pen', 12)}${p.annots.length}` }) : null,
        notes ? h('span', {}, notes) : null));
    card.addEventListener('click', (e) => select(p.key, e));
    card.addEventListener('dblclick', () => openPage(p.key));
    card.addEventListener('dragstart', (e) => {
      dragKey = p.key;
      if (!S.selected.has(p.key)) S.selected = new Set([p.key]);
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => { dragKey = null; render(); });
    card.addEventListener('dragover', (e) => {
      if (dragKey == null) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      for (const c of grid.querySelectorAll('.drop-before,.drop-after')) c.classList.remove('drop-before', 'drop-after');
      card.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const r = card.getBoundingClientRect();
      moveSelectionTo(p.key, e.clientX > r.left + r.width / 2);
    });
    return card;
  });
  grid.replaceChildren(...cards);
  $('#dims').textContent = `${S.pages.length} page${S.pages.length === 1 ? '' : 's'}`;
}

function moveSelectionTo(targetKey, after) {
  if (S.selected.has(targetKey)) return render();
  remember();
  const moving = S.pages.filter((p) => S.selected.has(p.key));
  const rest = S.pages.filter((p) => !S.selected.has(p.key));
  const idx = rest.findIndex((p) => p.key === targetKey) + (after ? 1 : 0);
  S.pages = [...rest.slice(0, idx), ...moving, ...rest.slice(idx)];
  render();
}

function select(key, e) {
  const keys = S.pages.map((p) => p.key);
  if (e.shiftKey && S.anchor != null) {
    const [a, b] = [keys.indexOf(S.anchor), keys.indexOf(key)].sort((x, y) => x - y);
    S.selected = new Set(keys.slice(a, b + 1));
  } else if (e.ctrlKey || e.metaKey) {
    if (S.selected.has(key)) S.selected.delete(key);
    else S.selected.add(key);
    S.anchor = key;
  } else {
    S.selected = S.selected.size === 1 && S.selected.has(key) ? new Set() : new Set([key]);
    S.anchor = key;
  }
  render();
}

// ----- page view ------------------------------------------------------------------------------

function setView(view) {
  S.view = view;
  const pageView = view === 'page';
  $('#stage').hidden = pageView;
  $('#page-stage').hidden = !pageView;
  $('#tools').hidden = !pageView;
  $('#panel').hidden = !pageView;
  $('#back').hidden = !pageView;
}

function openPage(key) {
  S.current = key;
  S.selAnnot = null;
  S.editing = null;
  setView('page');
  renderPage(true);
}

function backToPages() {
  finishEditing();
  setView('pages');
  render();
}

function step(d) {
  const i = S.pages.findIndex((p) => p.key === S.current) + d;
  if (i < 0 || i >= S.pages.length) return;
  finishEditing();
  openPage(S.pages[i].key);
}

const renders = new Map();
async function pageImage(p, scale) {
  const key = `${p.src}:${p.rotate}:${scale}`;
  if (!renders.has(key)) renders.set(key, wedge.edit.pdfRender(file, p.src, scale, p.rotate));
  return (await renders.get(key)).url;
}

// Fits the page to the window; marks are laid out in points times this zoom.
function fitZoom(p) {
  const r = $('#scroller').getBoundingClientRect();
  const { w, h: ph } = pageSize(p);
  return Math.max(0.3, Math.min((r.width - 64) / w, (r.height - 64) / ph, 2.2));
}

async function renderPage(reload = false) {
  const p = page();
  if (!p) return backToPages();
  syncUndo();
  renderTools();
  renderPanel();
  const i = S.pages.indexOf(p);
  $('#page-label').textContent = `Page ${i + 1} of ${S.pages.length}`;
  $('#prev').disabled = i === 0;
  $('#next').disabled = i === S.pages.length - 1;
  $('#dims').textContent = `Page ${i + 1}`;
  S.zoom = fitZoom(p);
  const { w, h: ph } = pageSize(p);
  const sheet = $('#sheet');
  sheet.style.width = `${w * S.zoom}px`;
  sheet.style.height = `${ph * S.zoom}px`;
  layer.className = `layer ${S.tool === 'select' ? 'select' : S.tool === 'text' ? 'text' : ''}`;
  const img = $('#page-img');
  const want = Math.min(4, Math.ceil(S.zoom * (window.devicePixelRatio || 1) * 2) / 2);
  const token = `${p.key}:${p.rotate}:${want}`;
  if (reload || img.dataset.token !== token) {
    img.dataset.token = token;
    img.src = await pageImage(p, want);
  }
  renderAnnots();
}

function renderAnnots() {
  const p = page();
  const z = S.zoom;
  const els = (p.annots || []).map((a) => {
    const el = h('div', { class: `annot ${a.type === 'text' ? 'text' : a.type === 'image' ? 'img' : `rect${a.kind === 'highlight' ? ' highlight' : ''}`}${a.id === S.selAnnot ? ' sel' : ''}`, 'data-id': a.id });
    el.style.left = `${a.x * z}px`;
    el.style.top = `${a.y * z}px`;
    if (a.type === 'text') {
      el.textContent = a.text;
      el.style.fontSize = `${a.size * z}px`;
      el.style.color = a.color;
      if (S.editing === a.id) {
        el.contentEditable = 'true';
        el.spellcheck = false;
      }
      el.addEventListener('input', () => { a.text = el.innerText.replace(/\n$/, ''); });
      el.addEventListener('blur', () => S.editing === a.id && finishEditing());
      el.addEventListener('dblclick', (e) => { e.stopPropagation(); startEditing(a.id); });
    } else {
      el.style.width = `${a.w * z}px`;
      el.style.height = `${a.h * z}px`;
      if (a.type === 'image') el.append(h('img', { src: a.url, alt: '', draggable: 'false' }));
      else {
        el.style.background = a.color;
        el.style.opacity = a.opacity;
      }
      el.append(h('span', { class: 'handle', 'data-handle': '1' }));
    }
    el.append(h('button', { type: 'button', class: 'del', title: 'Delete (Del)', 'aria-label': 'Delete', onclick: (e) => { e.stopPropagation(); deleteAnnot(a.id); } }, '×'));
    return el;
  });
  layer.replaceChildren(...els);
  if (S.editing) {
    const el = layer.querySelector(`[data-id="${S.editing}"]`);
    if (el && document.activeElement !== el) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}

function annotById(id) {
  return page()?.annots?.find((a) => a.id === id);
}

function addAnnot(a) {
  remember();
  const p = page();
  p.annots = p.annots || [];
  a.id = S.nextAnnot++;
  p.annots.push(a);
  S.selAnnot = a.id;
  return a;
}

function deleteAnnot(id) {
  remember();
  const p = page();
  p.annots = p.annots.filter((a) => a.id !== id);
  if (S.selAnnot === id) S.selAnnot = null;
  if (S.editing === id) S.editing = null;
  renderPage();
}

function startEditing(id) {
  S.editing = id;
  S.selAnnot = id;
  renderAnnots();
  renderPanel();
}

function finishEditing() {
  if (!S.editing) return;
  const a = annotById(S.editing);
  S.editing = null;
  if (a && !a.text.trim()) page().annots = page().annots.filter((x) => x !== a);
  renderAnnots();
}

// A crisp checkmark picture, made once.
let checkUrl = null;
function checkImage() {
  if (checkUrl) return checkUrl;
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.strokeStyle = '#111';
  g.lineWidth = 11;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(16, 52);
  g.lineTo(38, 74);
  g.lineTo(82, 22);
  g.stroke();
  checkUrl = c.toDataURL('image/png');
  return checkUrl;
}

function toPoints(e) {
  const r = layer.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
}

let drag = null;

layer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const target = e.target.closest('.annot');
  const pt = toPoints(e);
  if (target && S.editing === Number(target.dataset.id)) return; // typing inside a text box
  if (target) {
    // Grab an existing mark (any tool): select it, then move or resize.
    finishEditing();
    const a = annotById(Number(target.dataset.id));
    if (!a) return;
    if (S.tool === 'text' && a.type === 'text') return startEditing(a.id);
    S.selAnnot = a.id;
    drag = { kind: e.target.dataset.handle ? 'resize' : 'move', a, from: pt, start: { ...a }, before: clone(S.pages), moved: false };
    try { layer.setPointerCapture(e.pointerId); } catch {}
    renderAnnots();
    renderPanel();
    return;
  }
  if (S.editing) {
    finishEditing();
    if (S.tool === 'text') return;
  }
  const { w: W, h: H } = pageSize(page());
  if (S.tool === 'select') {
    S.selAnnot = null;
    renderAnnots();
    renderPanel();
  } else if (S.tool === 'text' || S.tool === 'date') {
    const text = S.tool === 'date' ? new Date().toLocaleDateString() : '';
    // Text sits just above the click, so clicking a form line writes on the line.
    const a = addAnnot({ type: 'text', x: pt.x, y: pt.y - S.textSize * 0.93 - 2, size: S.textSize, color: S.textColor, text });
    if (S.tool === 'text') S.editing = a.id;
    renderAnnots();
    renderPanel();
  } else if (S.tool === 'check') {
    const size = Math.max(10, S.textSize * 1.4);
    addAnnot({ type: 'image', x: pt.x - size / 2, y: pt.y - size / 2, w: size, h: size, url: checkImage() });
    renderAnnots();
  } else if (S.tool === 'sign') {
    if (!S.signature) return openSignatureDialog();
    placeSignature(pt, W, H);
  } else if (S.tool === 'highlight' || S.tool === 'whiteout') {
    drag = { kind: 'draw', from: pt, rect: { x: pt.x, y: pt.y, w: 0, h: 0 } };
    try { layer.setPointerCapture(e.pointerId); } catch {}
  }
});

layer.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const pt = toPoints(e);
  const { w: W, h: H } = pageSize(page());
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  if (drag.kind === 'draw') {
    const x = clamp(Math.min(pt.x, drag.from.x), 0, W);
    const y = clamp(Math.min(pt.y, drag.from.y), 0, H);
    drag.rect = { x, y, w: Math.min(W - x, Math.abs(pt.x - drag.from.x)), h: Math.min(H - y, Math.abs(pt.y - drag.from.y)) };
    let draft = layer.querySelector('.draft');
    if (!draft) layer.append((draft = h('div', { class: 'draft' })));
    Object.assign(draft.style, { left: `${drag.rect.x * S.zoom}px`, top: `${drag.rect.y * S.zoom}px`, width: `${drag.rect.w * S.zoom}px`, height: `${drag.rect.h * S.zoom}px` });
    return;
  }
  const a = drag.a;
  const dx = pt.x - drag.from.x;
  const dy = pt.y - drag.from.y;
  if (Math.abs(dx) + Math.abs(dy) > 0.5) drag.moved = true;
  if (drag.kind === 'move') {
    a.x = clamp(drag.start.x + dx, -((a.w || 10) / 2), W - (a.w || 10) / 2);
    a.y = clamp(drag.start.y + dy, -((a.h || a.size || 10) / 2), H - (a.h || a.size || 10) / 2);
  } else if (a.type === 'image') {
    const ratio = drag.start.h / drag.start.w;
    a.w = Math.max(8, drag.start.w + dx);
    a.h = a.w * ratio;
  } else {
    a.w = Math.max(4, drag.start.w + dx);
    a.h = Math.max(4, drag.start.h + dy);
  }
  renderAnnots();
});

layer.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'draw') {
    layer.querySelector('.draft')?.remove();
    if (d.rect.w > 3 && d.rect.h > 3) {
      const hl = S.tool === 'highlight';
      addAnnot({ type: 'rect', kind: hl ? 'highlight' : 'whiteout', ...d.rect, color: hl ? S.highlight : '#ffffff', opacity: hl ? 0.75 : 1 });
      renderAnnots();
    }
    return;
  }
  if (d.moved) {
    S.history.push(d.before);
    S.future = [];
    syncUndo();
  }
});

function placeSignature(pt, W, H) {
  const img = new Image();
  img.onload = () => {
    const w = Math.min(170, W * 0.4);
    const hgt = (w * img.naturalHeight) / img.naturalWidth;
    addAnnot({ type: 'image', kind: 'signature', x: Math.max(0, Math.min(W - w, pt.x - w / 2)), y: Math.max(0, Math.min(H - hgt, pt.y - hgt / 2)), w, h: hgt, url: S.signature });
    renderAnnots();
    renderPanel();
  };
  img.src = S.signature;
}

// ----- tools & panel ------------------------------------------------------------------------------

function setTool(id) {
  finishEditing();
  S.tool = id;
  if (id === 'sign' && !S.signature) {
    S.signature = S.savedSignatures[0] || null;
    if (!S.signature) openSignatureDialog();
  }
  renderTools();
  renderPanel();
  layer.className = `layer ${id === 'select' ? 'select' : id === 'text' ? 'text' : ''}`;
}

function renderTools() {
  $('#tools').replaceChildren(...TOOLS.map((t) => {
    const b = h('button', { type: 'button', class: `tool${S.tool === t.id ? ' on' : ''}`, 'aria-label': t.label, html: icon(t.icon, 19), onclick: () => setTool(t.id) });
    b.append(h('span', { class: 'tip' }, t.label, h('kbd', {}, t.key)));
    return b;
  }));
}

function renderPanel() {
  const sel = annotById(S.selAnnot);
  const parts = [];
  const textOptions = (a) => {
    const size = a ? a.size : S.textSize;
    const color = a ? a.color : S.textColor;
    const apply = (patch) => {
      if (a) { remember(); Object.assign(a, patch); renderAnnots(); }
      if (patch.size) S.textSize = patch.size;
      if (patch.color) S.textColor = patch.color;
      renderPanel();
    };
    return [h('h3', {}, 'Size'), chips(TEXT_SIZES, size, (v) => apply({ size: v })), h('h3', {}, 'Color'), swatchRow(TEXT_COLORS, color, (c) => apply({ color: c }))];
  };
  if (sel && sel.type === 'text') {
    parts.push(h('h3', {}, 'Text'), h('p', {}, 'Double-click to edit. Drag to move.'), ...textOptions(sel));
  } else if (S.tool === 'text') {
    parts.push(h('h3', {}, 'Text'), h('p', {}, 'Click on the page and type. Enter adds a line; click outside to finish.'), ...textOptions(null));
  } else if (S.tool === 'date') {
    parts.push(h('h3', {}, 'Date'), h('p', {}, `Click to stamp today's date (${new Date().toLocaleDateString()}).`), ...textOptions(null));
  } else if (S.tool === 'check') {
    parts.push(h('h3', {}, 'Checkmark'), h('p', {}, 'Click a box on the form to tick it. Drag the corner to resize.'));
  } else if (S.tool === 'sign') {
    parts.push(h('h3', {}, 'Signature'), h('p', {}, S.signature ? 'Click where the signature goes, then drag the corner to size it.' : 'Create a signature to start.'),
      S.savedSignatures.length ? h('div', { class: 'sig-list' }, S.savedSignatures.map((url) => h('div', { class: `sig-item${url === S.signature ? ' on' : ''}`, onclick: () => { S.signature = url; renderPanel(); } },
        h('img', { src: url, alt: 'Saved signature' }),
        h('button', { type: 'button', class: 'x', title: 'Forget this signature', 'aria-label': 'Forget this signature', onclick: (e) => { e.stopPropagation(); forgetSignature(url); } }, '×')))) : null,
      h('button', { type: 'button', class: 'btn block', html: `${icon('pen', 15)}<span>New signature</span>`, onclick: openSignatureDialog }));
  } else if (S.tool === 'highlight') {
    parts.push(h('h3', {}, 'Highlight'), h('p', {}, 'Drag over text to highlight it.'), swatchRow(HIGHLIGHTS, S.highlight, (c) => { S.highlight = c; renderPanel(); }));
  } else if (S.tool === 'whiteout') {
    parts.push(h('h3', {}, 'White-out'), h('p', {}, 'Drag over anything to cover it with white, then add new text on top. The covered content stays in the file underneath, so use it to tidy up, not to hide private information.'));
  } else {
    parts.push(h('h3', {}, 'Select'), h('p', {}, sel ? 'Drag to move, drag the corner to resize, Delete to remove.' : 'Click a mark to select it. Pick a tool on the left to add text, a signature, a checkmark, the date, a highlight or white-out.'));
  }
  const p = page();
  parts.push(h('h3', {}, 'Page'),
    h('div', { class: 'chipset wide' },
      h('button', { type: 'button', title: 'Rotate page left', html: icon('rotl', 16), onclick: () => rotate(-90, [p]) }),
      h('button', { type: 'button', title: 'Rotate page right', html: icon('rotr', 16), onclick: () => rotate(90, [p]) })),
    p?.annots?.length ? h('button', { type: 'button', class: 'btn block', onclick: () => { remember(); p.annots = []; S.selAnnot = null; renderPage(); } }, 'Clear marks on this page') : null);
  $('#panel').replaceChildren(...parts.filter(Boolean));
}

// ----- signatures ------------------------------------------------------------------------------------

async function loadSignatures() {
  S.savedSignatures = (await wedge.getSettings()).signatures || [];
}

async function rememberSignature(url) {
  const list = [url, ...S.savedSignatures.filter((u) => u !== url)].slice(0, 5);
  S.savedSignatures = list;
  await wedge.setSettings({ signatures: list });
}

async function forgetSignature(url) {
  S.savedSignatures = S.savedSignatures.filter((u) => u !== url);
  if (S.signature === url) S.signature = S.savedSignatures[0] || null;
  await wedge.setSettings({ signatures: S.savedSignatures });
  renderPanel();
}

// Crops a canvas to its inked pixels (plus a little margin) as a transparent PNG.
function trimmed(canvas) {
  const g = canvas.getContext('2d');
  const { width: w, height: hh } = canvas;
  const data = g.getImageData(0, 0, w, hh).data;
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 12) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 8;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(hh - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

const SCRIPT_FONTS = [
  ['Segoe Script', '"Segoe Script", "Snell Roundhand", "Brush Script MT", cursive'],
  ['Ink Free', '"Ink Free", "Bradley Hand", "Comic Sans MS", cursive'],
  ['Lucida Handwriting', '"Lucida Handwriting", "Apple Chancery", "Segoe Script", cursive'],
];

function openSignatureDialog() {
  const modal = $('#sig-modal');
  let mode = 'draw';
  let ink = '#111111';
  let typedFont = 0;
  let uploaded = null;
  const saveBox = h('input', { type: 'checkbox' });
  saveBox.checked = true;

  // Draw pad
  const canvas = h('canvas', { 'aria-label': 'Draw your signature' });
  const pad = h('div', { class: 'pad' }, canvas, h('div', { class: 'baseline' }), h('div', { class: 'hint' }, 'Sign above the line with your mouse, pen or finger'));
  let drawing = null;
  let inked = false;
  const sizeCanvas = () => {
    const r = pad.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr * 1.5);
    canvas.height = Math.round(r.height * dpr * 1.5);
  };
  const ctxFor = () => {
    const g = canvas.getContext('2d');
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = ink;
    g.lineWidth = canvas.width / 180;
    return g;
  };
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    drawing = { last: at(e), mid: at(e) };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const g = ctxFor();
    const p = at(e);
    // Smooth the stroke through midpoints.
    const mid = [(drawing.last[0] + p[0]) / 2, (drawing.last[1] + p[1]) / 2];
    g.beginPath();
    g.moveTo(drawing.mid[0], drawing.mid[1]);
    g.quadraticCurveTo(drawing.last[0], drawing.last[1], mid[0], mid[1]);
    g.stroke();
    drawing = { last: p, mid };
    inked = true;
  });
  canvas.addEventListener('pointerup', () => (drawing = null));

  // Typed
  const nameInput = h('input', { class: 'input type-input', placeholder: 'Type your name', spellcheck: 'false', 'aria-label': 'Your name' });
  const styles = h('div', { class: 'styles' });
  const renderStyles = () => {
    const text = nameInput.value || 'Your name';
    // Shrink long names so the whole name fits in each preview.
    const size = Math.max(13, Math.min(26, Math.round(290 / Math.max(8, text.length))));
    styles.replaceChildren(...SCRIPT_FONTS.map(([label, family], i) => h('button', { type: 'button', class: i === typedFont ? 'on' : '', title: label, style: `font-family:${family};color:${ink};font-size:${size}px`, onclick: () => { typedFont = i; renderStyles(); } }, text)));
  };
  nameInput.addEventListener('input', renderStyles);

  // Upload
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const uploadBox = h('div', { class: 'upload', tabindex: '0', role: 'button', onclick: () => fileInput.click() }, h('span', { html: icon('image', 26) }), h('b', {}, 'Choose a photo or scan of your signature'), h('small', {}, 'A white background is removed automatically.'));
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        const scale = Math.min(1, 1600 / img.naturalWidth);
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, c.width, c.height);
        const d = g.getImageData(0, 0, c.width, c.height);
        // Paper becomes transparent; ink keeps its color with soft edges.
        for (let i = 0; i < d.data.length; i += 4) {
          const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
          d.data[i + 3] = lum > 215 ? 0 : lum > 160 ? Math.round(((215 - lum) / 55) * 255) : 255;
        }
        g.putImageData(d, 0, 0);
        uploaded = trimmed(c);
        uploadBox.replaceChildren(uploaded ? h('img', { src: uploaded, alt: 'Your signature' }) : h('b', {}, 'No signature found in that image'), h('small', {}, 'Click to choose another'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  });

  const body = h('div', {});
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const inks = h('div', { class: 'inks' });
  const renderInks = () => inks.replaceChildren(...[['#111111', 'Black'], ['#1f4bd8', 'Blue']].map(([c, label]) => h('button', { type: 'button', class: `swatch${c === ink ? ' on' : ''}`, style: `background:${c}`, title: label, 'aria-label': `${label} ink`, onclick: () => { ink = c; renderInks(); renderStyles(); } })));
  const renderTabs = () => {
    tabs.replaceChildren(...[['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']].map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === id), class: mode === id ? 'on' : '', onclick: () => { mode = id; renderTabs(); } }, label)));
    body.replaceChildren(mode === 'draw' ? pad : mode === 'type' ? h('div', {}, nameInput, styles) : uploadBox);
    inks.hidden = mode === 'upload';
    clearBtn.hidden = mode !== 'draw';
    if (mode === 'draw') requestAnimationFrame(() => { if (!inked) sizeCanvas(); });
    if (mode === 'type') { renderStyles(); setTimeout(() => nameInput.focus(), 0); }
  };

  const close = () => { modal.hidden = true; modal.textContent = ''; };
  const clearBtn = h('button', { type: 'button', class: 'btn', onclick: () => { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); inked = false; } }, 'Clear');
  const use = async () => {
    let url = null;
    if (mode === 'draw') url = inked ? trimmed(canvas) : null;
    else if (mode === 'type') {
      const text = nameInput.value.trim();
      if (text) {
        const c = document.createElement('canvas');
        c.width = 1400;
        c.height = 360;
        const g = c.getContext('2d');
        g.font = `150px ${SCRIPT_FONTS[typedFont][1]}`;
        g.fillStyle = ink;
        g.textBaseline = 'middle';
        g.fillText(text, 40, 190, 1320);
        url = trimmed(c);
      }
    } else url = uploaded;
    if (!url) return toast(mode === 'type' ? 'Type your name first' : mode === 'draw' ? 'Draw your signature first' : 'Choose an image first', { error: true });
    if (saveBox.checked) await rememberSignature(url);
    S.signature = url;
    close();
    setTool('sign');
    toast('Click where the signature goes');
  };

  modal.replaceChildren(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Create a signature' },
    h('h2', {}, 'Create your signature'), tabs, body, inks,
    h('div', { class: 'foot' },
      h('label', {}, saveBox, 'Save for next time (only on this computer)'),
      clearBtn,
      h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: use }, 'Use signature')),
    fileInput));
  renderTabs();
  renderInks();
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) close(); };
}

// ----- save ----------------------------------------------------------------------------------------------

// Text that the standard PDF font can't encode is also sent as a picture.
function withTextPictures(p) {
  return (p.annots || []).map((a) => {
    if (a.type !== 'text' || !/[^\x00-\xFF]/.test(a.text)) return a;
    const lines = a.text.split('\n');
    const scale = 4;
    const g0 = document.createElement('canvas').getContext('2d');
    g0.font = `${a.size * scale}px Helvetica, Arial, sans-serif`;
    const w = Math.max(...lines.map((l) => g0.measureText(l).width)) / scale + 2;
    const hgt = lines.length * a.size * 1.2;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * scale);
    c.height = Math.ceil(hgt * scale);
    const g = c.getContext('2d');
    g.font = `${a.size * scale}px Helvetica, Arial, sans-serif`;
    g.fillStyle = a.color;
    g.textBaseline = 'alphabetic';
    lines.forEach((l, i) => g.fillText(l, 0, (i * 1.2 + 0.93) * a.size * scale));
    return { ...a, png: c.toDataURL('image/png'), w, h: hgt };
  });
}

async function save(subset) {
  finishEditing();
  const pages = subset ? S.pages.filter((p) => S.selected.has(p.key)) : S.pages;
  busy(subset ? 'Extracting…' : 'Saving…', 0.6);
  try {
    const out = await wedge.edit.savePdf(file, pages.map((p) => ({ src: p.src, rotate: p.rotate, annots: withTextPictures(p) })), subset ? '-pages' : '-edited');
    toast(`Saved ${basename(out)}`, { reveal: out });
  } catch (err) {
    toast(cleanError(err), { error: true });
  } finally {
    busy(null);
  }
}

// ----- keyboard & setup ------------------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (!$('#sig-modal').hidden) {
    if (e.key === 'Escape') { $('#sig-modal').hidden = true; }
    return;
  }
  const typing = S.editing || e.target.tagName === 'INPUT';
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return save(false); }
  if (typing) {
    if (e.key === 'Escape') finishEditing();
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
  if (S.view === 'page') {
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selAnnot) return deleteAnnot(S.selAnnot);
    if (e.key === 'Escape') { if (S.selAnnot) { S.selAnnot = null; renderAnnots(); renderPanel(); } else backToPages(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') return step(-1);
    if (e.key === 'ArrowRight' || e.key === 'PageDown') return step(1);
    if (!mod && !e.altKey) {
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) setTool(t.id);
    }
    return;
  }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); return selectAll(); }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); return duplicate(); }
  if (e.key === 'Delete' || e.key === 'Backspace') return remove();
  if (e.key.toLowerCase() === 'r' && !mod) return rotate(e.shiftKey ? -90 : 90);
  if (e.key === 'Enter' && S.selected.size === 1) return openPage([...S.selected][0]);
  if (e.key === 'Escape') { S.selected.clear(); render(); }
});

async function init() {
  await window.editorKit.applyLook();
  $('#name').textContent = name;
  $('#kind-icon').innerHTML = icon('file', 15);
  $('#undo').innerHTML = icon('undo');
  $('#redo').innerHTML = icon('redo');
  $('#back').innerHTML = `${icon('grid', 15)}<span>All pages</span>`;
  $('#prev').innerHTML = icon('chevl', 16);
  $('#next').innerHTML = icon('chevr', 16);
  $('#save').innerHTML = `${icon('check', 15)}<span>Save copy</span>`;
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#save').onclick = () => save(false);
  $('#back').onclick = backToPages;
  $('#prev').onclick = () => step(-1);
  $('#next').onclick = () => step(1);
  new ResizeObserver(() => S.view === 'page' && renderPage()).observe($('#page-stage'));
  await loadSignatures();
  try {
    S.info = await wedge.edit.pdfInfo(file);
    S.pages = S.info.pages.map((_, i) => ({ key: S.nextKey++, src: i, rotate: 0, annots: [] }));
    render();
  } catch (err) {
    grid.innerHTML = '';
    grid.append(h('div', { class: 'loading' }, `Couldn't open this PDF: ${cleanError(err)}`));
  }
}
init();
