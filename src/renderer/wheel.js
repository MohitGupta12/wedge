// The radial wheel. Opens around the cursor when a file is pressed with the
// trigger keys held; dragging the file onto a wedge (or clicking one) converts it.
//
// Lifecycle (driven by the main process):
//   wheel:show   -> render invisibly, then report ready
//   wheel:enter  -> the window is visible; animate in
//   hide()       -> animate out, then report hidden so the window can close
const C = 250; // ring center within the 500x500 layout
const R_HUB = 81; // radius of the hub card in the middle
const R_IN = 88; // petals span R_IN..R_OUT (same 7px gap to the hub as between petals)
const R_OUT = 214;
const CORNER = 12; // petal corner radius: half the stroke width in wheel.css
const GAP = 7; // px between neighbouring petals
const POP = 9; // how far the hovered petal slides outward
const MODE_LABEL = { convert: 'Formats', favorites: '★ Favorites', editor: 'Creator', tools: 'Tools', actions: 'Actions' };
const CHOOSE_IDLE_MS = 12000;

const svg = document.getElementById('wheel');
const ringEl = document.getElementById('ring');
const statusEl = document.getElementById('status');
const hubEl = document.getElementById('hub');
const thumbEl = document.getElementById('thumb');
const thumbImg = document.getElementById('thumb-img');
const badgeEl = document.getElementById('badge');
const titleEl = document.getElementById('center-title');
const subEl = document.getElementById('center-sub');
const extraEl = document.getElementById('center-extra');
const card = document.getElementById('card');
const modesEl = document.getElementById('modes');
const body = document.body;

const S = {
  session: null,
  state: 'hidden', // hidden | drag | choose | options | working | done | error
  mode: 'convert',
  modes: ['convert'],
  catalog: null,
  files: null,
  target: null, // the pressed file(s), when the file manager told us
  multiSelect: 'pressed',
  hot: -1,
  keys: {},
  platform: 'win32',
  animations: true,
  closeAfter: 'result',
  mimeTried: false,
  dropped: false,
  jobId: null,
  progress: 0,
  timers: {},
};

// ----- geometry ----------------------------------------------------------------

const rad = (deg) => (deg * Math.PI) / 180;
const pt = (r, deg) => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))];

// A petal shrunk by CORNER on every side; wheel.css strokes it back out with
// round joins, so every corner gets the same radius and the gaps stay even.
function petalPath(a0, a1) {
  const ro = R_OUT - CORNER;
  const ri = R_IN + CORNER;
  const d = GAP / 2 + CORNER;
  const off = (r) => (Math.asin(Math.min(1, d / r)) * 180) / Math.PI;
  const o0 = a0 + off(ro);
  const o1 = a1 - off(ro);
  const i0 = a0 + off(ri);
  const i1 = a1 - off(ri);
  const [x0, y0] = pt(ro, o0);
  const [x1, y1] = pt(ro, o1);
  const [x2, y2] = pt(ri, i1);
  const [x3, y3] = pt(ri, i0);
  const lo = o1 - o0 > 180 ? 1 : 0;
  const li = i1 - i0 > 180 ? 1 : 0;
  return `M${x0},${y0} A${ro},${ro} 0 ${lo} 1 ${x1},${y1} L${x2},${y2} A${ri},${ri} 0 ${li} 0 ${x3},${y3} Z`;
}

function segments() {
  return (S.catalog && S.catalog[S.mode]) || [];
}

// Maps a point (layout px) to a petal index, -2 for the hub, -1 for outside.
// The thin gap between hub and petals belongs to the petals, so aiming is forgiving.
function hitTest(x, y) {
  const dx = x - C;
  const dy = y - C;
  const r = Math.hypot(dx, dy);
  if (r < R_HUB + 4) return -2;
  if (r > R_OUT + 20) return -1;
  const segs = segments();
  if (!segs.length) return -1;
  const step = 360 / segs.length;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90 + step / 2;
  deg = ((deg % 360) + 360) % 360;
  return Math.floor(deg / step);
}

// ----- rendering -----------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
function node(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
}

let lastSegKey = '';

function render() {
  const busy = ['working', 'done', 'error'].includes(S.state);
  const showRing = S.state !== 'options';
  card.hidden = S.state !== 'options';
  svg.style.display = showRing ? '' : 'none';
  hubEl.style.display = showRing ? '' : 'none';
  modesEl.style.display = showRing && !busy ? '' : 'none';
  if (!showRing) return;

  const segs = segments();
  // Only rebuild the petals when they change, so hovering doesn't restart the fan-out.
  const segKey = busy ? 'busy' : `${S.mode}|${segs.map((s) => s.id).join(',')}`;
  if (segKey !== lastSegKey) {
    lastSegKey = segKey;
    ringEl.textContent = '';
    if (!busy && segs.length) {
      const step = 360 / segs.length;
      const showHints = segs.length <= 12 && segs.some((s) => s.sub);
      segs.forEach((op, i) => {
        const mid = -90 + i * step;
        const dx = (POP * Math.cos(rad(mid))).toFixed(1);
        const dy = (POP * Math.sin(rad(mid))).toFixed(1);
        const g = node('g', { class: 'petal', 'data-i': i, style: `--i:${i};--dx:${dx}px;--dy:${dy}px` }, ringEl);
        const pop = node('g', { class: 'pop' }, node('g', { class: 'petal-in' }, g));
        const d = petalPath(mid - step / 2, mid + step / 2);
        node('path', { d, class: 'edge' }, pop);
        node('path', { d, class: 'shape' }, pop);
        const hint = showHints && op.sub;
        const [tx, ty] = pt((R_IN + R_OUT) / 2 + 2, mid);
        const small = op.short.length > 6 || segs.length > 10;
        node('text', { x: tx, y: hint ? ty - 11 : ty, class: `type${small ? ' small' : ''}` }, pop).textContent = op.short;
        if (hint) node('text', { x: tx, y: ty + 15, class: 'hint' }, pop).textContent = op.sub;
      });
    } else if (!busy) {
      // Type unknown until the drag arrives: a slowly turning dotted ring invites the drop.
      node('circle', { cx: C, cy: C, r: (R_IN + R_OUT) / 2, class: 'drop-ring' }, ringEl);
    }
  }
  for (const g of ringEl.querySelectorAll('.petal')) g.classList.toggle('hot', Number(g.dataset.i) === S.hot);
  // Dropping on the hub opens the chooser, so it only lights up during a drag.
  hubEl.classList.toggle('drop', S.hot === -2 && S.state === 'drag');
  hubEl.classList.toggle('done', S.state === 'done');

  statusEl.textContent = '';
  if (S.state === 'working') {
    const r = R_HUB + 6;
    node('circle', { cx: C, cy: C, r, class: 'progress-track' }, statusEl);
    const len = 2 * Math.PI * r;
    const bar = node('circle', {
      cx: C, cy: C, r, class: 'progress-bar',
      'stroke-dasharray': len, 'stroke-dashoffset': len * (1 - Math.max(0.04, S.progress || 0)),
      transform: `rotate(-90 ${C} ${C})`,
    }, statusEl);
    if (!S.progress) bar.classList.add('spin');
  }

  renderCenter();
  renderModes();
}

function basename(p) {
  return p.split(/[\\/]/).pop();
}

// Shortens text to fit a width, ending in "..".
const measure = document.createElement('canvas').getContext('2d');
function fit(text, maxWidth, font) {
  measure.font = font;
  if (measure.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && measure.measureText(`${s}..`).width > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}..`;
}
const TITLE_FONT = '650 17px Geist';
const SUB_FONT = '500 13.5px Geist';
const TEXT_WIDTH = 132;

function subject() {
  const sub = S.catalog?.subject;
  if (sub) return sub;
  const n = S.files?.length || 0;
  return { name: n > 1 ? `${n} files` : n ? basename(S.files[0]) : '', ext: '', kind: 'File', count: n };
}

function setSub(...parts) {
  subEl.replaceChildren(...parts);
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

// Center card: thumbnail or format badge, then the file name, then its type.
function renderCenter() {
  extraEl.textContent = '';
  titleEl.classList.remove('error-text');
  thumbEl.classList.toggle('hidden', !S.catalog && !['working', 'done'].includes(S.state));
  const sub = subject();
  const segs = segments();
  badgeEl.textContent = (sub.count > 1 && !sub.ext ? String(sub.count) : sub.ext.replace('TAR.GZ', 'TGZ')).slice(0, 4) || '?';
  const typeLine = [sub.ext, sub.kind].filter(Boolean).join(' · ');
  const name = sub.name || (sub.ext ? `${sub.ext} file` : 'File');

  if (S.state === 'working') {
    titleEl.textContent = fit(S.workingLabel || 'Working', TEXT_WIDTH, TITLE_FONT);
    setSub(S.progress ? `${Math.round(S.progress * 100)}%` : 'Working…');
    return;
  }
  if (S.state === 'done') {
    titleEl.textContent = S.doneTitle || 'Saved';
    setSub(fit(S.doneSub || '', TEXT_WIDTH, SUB_FONT));
    return;
  }
  if (S.state === 'error') {
    thumbEl.classList.add('hidden');
    titleEl.textContent = 'Failed';
    titleEl.classList.add('error-text');
    setSub('');
    extraEl.append(span('error-msg', S.error || ''));
    return;
  }
  if (!S.catalog) {
    titleEl.textContent = 'Drop on a wedge';
    setSub('Esc to cancel');
    return;
  }
  titleEl.textContent = fit(name, TEXT_WIDTH, TITLE_FONT);
  const hot = S.hot >= 0 ? segs[S.hot] : null;
  if (hot && hot.mode === 'convert') {
    setSub(span('mono', sub.ext || '…'), ' → ', span('to mono', hot.short));
  } else if (hot) {
    setSub(span('to', fit(hot.label, TEXT_WIDTH, SUB_FONT)));
  } else if (!segs.length) {
    setSub(S.mode === 'convert' ? 'No conversions for this' : S.mode === 'favorites' ? 'No favorites for this' : `No ${MODE_LABEL[S.mode].toLowerCase()} presets`);
  } else {
    setSub(fit(typeLine, TEXT_WIDTH, SUB_FONT));
  }
}

function setThumb(url) {
  thumbImg.src = url || '';
  thumbEl.classList.toggle('has-img', !!url);
}

const KEY_GLYPH = {
  darwin: { shift: '⇧', ctrl: '⌃', alt: '⌥', meta: '⌘' },
  other: { shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt', meta: 'Win' },
};

function renderModes() {
  modesEl.textContent = '';
  if (S.modes.length < 2) return;
  const glyphs = KEY_GLYPH[S.platform === 'darwin' ? 'darwin' : 'other'];
  for (const m of S.modes) {
    const b = document.createElement('button');
    b.dataset.mode = m;
    const count = S.catalog?.[m]?.length;
    b.className = `${m === S.mode ? 'on' : ''}${S.catalog && !count ? ' dim' : ''}`;
    const k = document.createElement('kbd');
    if (S.keys[m]) {
      k.textContent = glyphs[S.keys[m]] || '';
      b.append(k);
    }
    b.append(MODE_LABEL[m]);
    b.onclick = () => setMode(m);
    modesEl.append(b);
  }
}

// ----- state ------------------------------------------------------------------------

function setState(state) {
  S.state = state;
  if (S.session !== null) window.wedge.wheel.state(S.session, state);
  clearTimeout(S.timers.idle);
  if (state === 'choose') armIdle();
}

// A wheel left open in "choose" without attention closes itself.
function armIdle() {
  clearTimeout(S.timers.idle);
  S.timers.idle = setTimeout(() => S.state === 'choose' && hide(), CHOOSE_IDLE_MS);
}

function setMode(m) {
  if (!S.modes.includes(m) || S.mode === m) return;
  S.mode = m;
  S.hot = -1;
  render();
}

function pickMode(catalog) {
  if (!catalog[S.mode]?.length) S.mode = S.modes.find((m) => catalog[m]?.length) || S.mode;
}

function applyAccent(color) {
  if (!color) return;
  const root = document.documentElement.style;
  root.setProperty('--accent', color);
  root.setProperty('--accent-strong', `color-mix(in srgb, ${color} 78%, #000)`);
  root.setProperty('--accent-soft', `color-mix(in srgb, ${color} 15%, transparent)`);
}

// requestAnimationFrame stalls while the window is hidden, so never rely on it alone.
function nextFrame(fn) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(run);
  setTimeout(run, 34);
}

function clearTimers() {
  for (const t of Object.values(S.timers)) clearTimeout(t);
  S.timers = {};
}

function show(p) {
  clearTimers();
  applyAccent(p.accent);
  Object.assign(S, {
    session: p.session,
    mode: p.startMode || 'convert',
    modes: p.modes || ['convert'],
    keys: p.keys || {},
    platform: p.platform,
    animations: p.animations !== false,
    closeAfter: p.closeAfter || 'result',
    multiSelect: p.multiSelect || 'pressed',
    catalog: p.catalog || null,
    files: p.files || null,
    target: p.files || null,
    hot: -1,
    mimeTried: false,
    dropped: false,
    jobId: null,
    progress: 0,
  });
  if (S.catalog) pickMode(S.catalog);
  setThumb(null);
  body.classList.toggle('no-motion', !S.animations);
  body.classList.add('closed');
  body.classList.remove('entered');
  lastSegKey = '';
  setState(p.state === 'choose' ? 'choose' : 'drag');
  render();
  // The closed state is laid out and painted before the window shows.
  const id = S.session;
  nextFrame(() => S.session === id && window.wedge.wheel.ready(id));
}

function enter(id) {
  if (id !== S.session) return;
  nextFrame(() => {
    body.classList.remove('closed');
    body.classList.add('entered');
  });
}

function hide() {
  if (S.state === 'hidden') return;
  const id = S.session;
  clearTimers();
  setState('hidden');
  body.classList.add('closed');
  body.classList.remove('entered');
  // Let the close animation finish (and paint) before the window goes away.
  const wait = S.animations ? 170 : 16;
  setTimeout(() => nextFrame(() => window.wedge.wheel.hidden(id)), wait);
}

function hideSoon(ms) {
  clearTimeout(S.timers.hide);
  S.timers.hide = setTimeout(hide, ms);
}

async function choose(files, catalog) {
  S.files = files;
  S.catalog = catalog || (await window.wedge.forFiles(files));
  S.hot = -1;
  pickMode(S.catalog);
  setState('choose');
  render();
  window.wedge.wheel.focus();
}

async function execute(op, files) {
  if (op.options?.length) return showOptions(op, files);
  return runOp(op, files, {});
}

async function runOp(op, files, options) {
  setState('working');
  S.workingLabel = op.label;
  S.progress = 0;
  render();
  try {
    const res = await window.wedge.run(op.id, files, options);
    if (res.action) {
      if (res.message) finish(res.message, '');
      else hide();
      return;
    }
    S.jobId = res.job.id;
    if (res.job.status !== 'running') onJob(res.job);
  } catch (err) {
    fail(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}

function finish(title, sub) {
  if (S.closeAfter === 'instant') return hide();
  setState('done');
  S.doneTitle = title;
  S.doneSub = sub;
  render();
  hideSoon(900);
}

function fail(message) {
  setState('error');
  S.error = message;
  render();
  hideSoon(5000);
}

function onJob(job) {
  if (job.id !== S.jobId || S.state !== 'working') return;
  if (job.status === 'running') {
    S.progress = job.progress;
    render();
    return;
  }
  if (job.status === 'failed') return fail(job.errors[0]?.message || 'Something went wrong');
  const n = job.outputs.length;
  const sub = n === 1 ? basename(job.outputs[0]) : `${n} files${job.errors.length ? `, ${job.errors.length} failed` : ''}`;
  finish(job.status === 'partial' ? 'Partly saved' : 'Saved', sub);
}

async function showOptions(op, files) {
  setState('options');
  render();
  window.wedge.wheel.expand();
  const settings = await window.wedge.getSettings();
  const saved = settings.lastOptions?.[op.id] || {};
  card.textContent = '';
  const h = document.createElement('h2');
  h.textContent = op.label;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = files.length === 1 ? basename(files[0]) : `${files.length} files`;
  card.append(h, sub);
  if (op.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = op.hint;
    card.append(hint);
  }
  const { form, read } = window.buildForm(op.options, saved);
  const row = document.createElement('div');
  row.className = 'row';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.onclick = hide;
  const go = document.createElement('button');
  go.type = 'submit';
  go.className = 'btn primary';
  go.textContent = 'Run';
  row.append(cancel, go);
  form.append(row);
  form.onsubmit = (e) => {
    e.preventDefault();
    runOp(op, files, read());
  };
  card.append(form);
  card.hidden = false;
  (form.querySelector('input:not([type=range]):not([type=color]), select') || go).focus();
}

// ----- drag & drop ---------------------------------------------------------------------

function filesFrom(dt) {
  return [...dt.files].map((f) => window.wedge.pathFor(f)).filter(Boolean);
}

document.addEventListener('dragenter', async (e) => {
  e.preventDefault();
  if (S.state !== 'drag' || S.catalog || S.mimeTried) return;
  // No target from the file manager: guess the wedges from the drag's MIME types.
  S.mimeTried = true;
  const mimes = [...e.dataTransfer.items].filter((i) => i.kind === 'file').map((i) => i.type);
  if (!mimes.length) return;
  const res = await window.wedge.forMimes(mimes);
  if (res && !S.catalog) {
    S.catalog = res;
    pickMode(res);
    render();
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  if (!['drag', 'choose'].includes(S.state)) return;
  // Hovering a mode pill for a moment switches to it.
  const pill = e.target.closest?.('#modes button');
  if (pill) {
    if (!S.timers.pill) S.timers.pill = setTimeout(() => { setMode(pill.dataset.mode); S.timers.pill = null; }, 350);
  } else if (S.timers.pill) {
    clearTimeout(S.timers.pill);
    S.timers.pill = null;
  }
  const hot = hitTest(e.clientX, e.clientY);
  if (hot !== S.hot) {
    S.hot = hot;
    render();
  }
});

document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget || S.hot === -1) return;
  S.hot = -1;
  render();
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!['drag', 'choose'].includes(S.state)) return;
  S.dropped = true;
  let files = filesFrom(e.dataTransfer);
  if (!files.length) return hide();
  // A press in a file manager can also select a range; by default convert
  // only the file that was actually pressed.
  if (S.multiSelect !== 'all' && S.target && files.includes(S.target[0])) files = S.target;
  const hot = hitTest(e.clientX, e.clientY);
  const guessed = hot >= 0 ? segments()[hot] : null;
  if (!guessed) return choose(files);
  // Confirm the wedge applies to the real files (the guess may come from MIME types).
  const real = await window.wedge.forFiles(files);
  const op = real[S.mode].find((o) => o.id === guessed.id);
  S.files = files;
  S.catalog = real;
  if (op) execute(op, files);
  else choose(files, real);
});

// ----- mouse and keyboard (after a click, the wheel stays open) ------------------------

svg.addEventListener('mousemove', (e) => {
  if (S.state !== 'choose') return;
  armIdle();
  const hot = hitTest(e.offsetX, e.offsetY);
  if (hot !== S.hot) {
    S.hot = hot;
    render();
  }
});

svg.addEventListener('mouseleave', () => {
  if (S.state === 'choose' && S.hot !== -1) {
    S.hot = -1;
    render();
  }
});

document.addEventListener('mousedown', (e) => {
  if (S.state === 'options' || e.target.closest('#modes') || e.target.closest('#center-extra')) return;
  if (S.state === 'error' || S.state === 'done') return hide();
  const rect = svg.getBoundingClientRect();
  const hot = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (hot === -1) return hide(); // the transparent corners of the window count as outside
  if (S.state === 'choose' && hot >= 0) {
    const op = segments()[hot];
    if (op) execute(op, S.files);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return hide();
  if (S.state !== 'choose') return;
  armIdle();
  const segs = segments();
  if (e.key === 'Tab') {
    e.preventDefault();
    const n = S.modes.length;
    setMode(S.modes[(S.modes.indexOf(S.mode) + (e.shiftKey ? n - 1 : 1)) % n]);
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { S.hot = (Math.max(-1, S.hot) + 1) % segs.length; render(); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { S.hot = (S.hot <= 0 ? segs.length : S.hot) - 1; render(); }
  if (e.key === 'Enter' && segs[S.hot]) execute(segs[S.hot], S.files);
  // Number keys pick a wedge directly: 1 is the top one, clockwise from there.
  const n = Number(e.key);
  if (n >= 1 && n <= 9 && segs[n - 1]) execute(segs[n - 1], S.files);
});

// ----- main process events ---------------------------------------------------------------

const ours = (id) => id === S.session && S.state !== 'hidden';

window.wedge.on.wheelShow(show);
window.wedge.on.wheelEnter(enter);
window.wedge.on.wheelThumb(({ session, url }) => {
  if (session === S.session) setThumb(url);
});
window.wedge.on.wheelDismiss((id) => {
  if (id !== S.session) return;
  if (S.state === 'hidden') window.wedge.wheel.hidden(id);
  else hide();
});
window.wedge.on.wheelChoose(({ session, files, catalog }) => {
  if (!ours(session) || S.state !== 'drag' || S.dropped) return;
  S.target = files;
  choose(files, catalog);
});
window.wedge.on.wheelRelease((id) => {
  // The OS drop and the global mouse-up race; give the drop a moment to land.
  if (!ours(id) || S.state !== 'drag') return;
  S.timers.release = setTimeout(() => {
    if (S.state === 'drag' && !S.dropped) hide();
  }, 400);
});
// A mode key toggles: tap Shift for Editor, tap it again to go back to Formats.
window.wedge.on.wheelMode((m) => {
  if (['drag', 'choose'].includes(S.state)) setMode(S.mode === m ? 'convert' : m);
});
window.wedge.on.wheelBlur(() => {
  if (S.state === 'choose') hide();
});
window.wedge.on.settingsChanged((s) => applyAccent(s.accent));
window.wedge.on.jobUpdate(onJob);

body.classList.add('closed');
// Text is measured for truncation, so load the bundled font up front.
document.fonts.load(TITLE_FONT);
document.fonts.load(SUB_FONT);
