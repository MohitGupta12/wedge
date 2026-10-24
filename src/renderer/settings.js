// The Wedge app window: Home, the wheel settings, formats, extensions and system.
const $ = (s) => document.querySelector(s);
let info = null;
let settings = null;
let formats = null;
let actions = null;
let extensions = null;
let recent = [];
let section = (location.hash || '#home').slice(1);
let category = 'image';

const NAV = [
  { id: 'home', label: 'Home', icon: 'home' },
  { group: 'Customize' },
  { id: 'wheel', label: 'Wheel', icon: 'wheel' },
  { id: 'favorites', label: 'Favorites', icon: 'star' },
  { id: 'formats', label: 'Formats', icon: 'grid' },
  { id: 'extensions', label: 'Extensions', icon: 'puzzle' },
  { group: 'App' },
  { id: 'system', label: 'System', icon: 'power' },
  { id: 'about', label: 'About', icon: 'info' },
];

const ACCENTS = [
  ['#12b76a', 'Green'], ['#2f7cf6', 'Blue'], ['#0fa3a3', 'Teal'], ['#6d5bf7', 'Iris'],
  ['#e59a0b', 'Amber'], ['#e5486d', 'Rose'], ['#ec4899', 'Pink'], ['#5f6472', 'Graphite'],
];
const CAT_ICON = { image: 'image', video: 'video', audio: 'music', pdf: 'file', document: 'doc', slides: 'slides', sheet: 'table', ebook: 'book', subtitle: 'captions', archive: 'archive' };
const EDITOR_FOR = { 'image-editor': 'image', 'video-editor': 'media', 'pdf-editor': 'pdf' };
const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'];
const MOD_LABEL = {
  darwin: { ctrl: '⌃ Control', alt: '⌥ Option', shift: '⇧ Shift', meta: '⌘ Command' },
  other: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' },
};
const isMac = () => info.platform === 'darwin';
const isWin = () => info.platform === 'win32';
const modLabel = (m) => MOD_LABEL[isMac() ? 'darwin' : 'other'][m] || m;
const FILE_MANAGER = { win32: 'File Explorer and the desktop', darwin: 'Finder and the desktop', linux: 'your file manager' };
const fileManager = () => FILE_MANAGER[info.platform] || FILE_MANAGER.linux;
const OS_NAME = () => ({ win32: 'Windows', darwin: 'your Mac', linux: 'your computer' })[info.platform] || 'your computer';

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined && v !== null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
const ic = (name, size = 18, cls = 'ic') => h('span', { class: cls, html: icon(name, size) });

function row(title, sub, control) {
  return h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', {}, title), sub ? h('small', {}, sub) : null), h('div', { class: 'ctl' }, control));
}

function toggle(key, label) {
  const input = h('input', { type: 'checkbox', 'aria-label': label });
  input.checked = !!settings[key];
  input.addEventListener('change', () => save({ [key]: input.checked }));
  return h('label', { class: 'switch' }, input, h('span'));
}

function select(value, options, onChange, label) {
  const s = h('select', { class: 'input', 'aria-label': label }, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function segmented(value, options, onChange, label) {
  return h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label }, options.map(([v, l]) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', onclick: () => onChange(v) }, l)));
}

async function save(patch) {
  settings = await wedge.setSettings(patch);
  await refresh();
}

// Formats and extensions depend on what is installed, so reload them with settings.
async function refresh() {
  [info, formats, actions, extensions] = await Promise.all([wedge.info(), wedge.formats(), wedge.actions(), wedge.extensions()]);
  render();
}

// ----- shortcut recorder -----------------------------------------------------------

const hookKey = (code) => code.replace(/^Key/, '').replace(/^Digit/, '');
const ACCEL_KEYS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};
const accelKey = (code) => ACCEL_KEYS[code] || (code.startsWith('Numpad') && /\d$/.test(code) ? `num${code.slice(-1)}` : hookKey(code));
const ACCEL_MOD = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Super' };
const KEY_NAMES = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };

function comboParts(mods, key) {
  const parts = MOD_ORDER.filter((m) => mods.includes(m)).map(modLabel);
  if (key) parts.push(KEY_NAMES[key] || key);
  return parts;
}

function comboChips(mods, key) {
  const parts = comboParts(mods, key);
  return parts.length ? parts.flatMap((p, i) => (i ? ['+', h('kbd', {}, p)] : [h('kbd', {}, p)])) : ['Not set'];
}

function accelChips(accel) {
  if (!accel) return ['Not set'];
  const mods = [];
  let key = null;
  for (const p of accel.split('+')) {
    const m = Object.keys(ACCEL_MOD).find((k) => ACCEL_MOD[k] === p) || (p === 'Cmd' ? 'meta' : null);
    if (m) mods.push(m);
    else key = p;
  }
  return comboChips(mods, key);
}

// kind 'trigger': modifiers plus at most one key, held while pressing a file.
// kind 'accelerator': a classic shortcut (needs a modifier and a key).
function recorder({ kind, chips, onDone, allowClear }) {
  const btn = h('button', { type: 'button', class: 'keys-btn', title: 'Click, then press the keys' }, ...chips);
  btn.addEventListener('click', () => {
    if (btn.classList.contains('recording')) return;
    btn.classList.add('recording');
    btn.replaceChildren(allowClear ? 'Press keys (Backspace clears)' : 'Press keys (Esc cancels)');
    wedge.recording(true);
    let peak = [];
    const modsOf = (e) => MOD_ORDER.filter((m) => e[{ ctrl: 'ctrlKey', alt: 'altKey', shift: 'shiftKey', meta: 'metaKey' }[m]]);
    const isMod = (e) => ['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph'].includes(e.key);
    const finish = (result) => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', cancel);
      wedge.recording(false);
      btn.classList.remove('recording');
      if (result !== undefined) onDone(result);
      else render();
    };
    const cancel = () => finish(undefined);
    const down = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mods = modsOf(e);
      if (e.key === 'Escape' && !mods.length) return cancel();
      if (allowClear && (e.key === 'Backspace' || e.key === 'Delete') && !mods.length) return finish(null);
      if (isMod(e)) {
        if (mods.length >= peak.length) peak = mods;
        btn.replaceChildren(...comboChips(mods, null), ' …');
        return;
      }
      if (kind === 'accelerator') {
        if (!mods.length) {
          btn.replaceChildren('Add Ctrl, Alt, Shift or ', isMac() ? 'Cmd' : 'Win');
          return;
        }
        return finish([...mods.map((m) => (m === 'meta' && isMac() ? 'Cmd' : ACCEL_MOD[m])), accelKey(e.code)].join('+'));
      }
      finish({ mods, key: hookKey(e.code) });
    };
    const up = (e) => {
      if (kind === 'trigger' && !modsOf(e).length && peak.length) finish({ mods: peak, key: null });
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', cancel);
  });
  return btn;
}

function triggerWarning(t) {
  if (!t.mods.length && t.key) return 'A plain key types into the file manager. Add a modifier.';
  if (t.mods.includes('meta') && isWin()) return 'The Start menu opens when you let go of Win.';
  if (t.mods.includes('shift') || t.mods.includes('ctrl')) return 'Shift and Ctrl also change the selection; Wedge resets it to the pressed file. Alt alone avoids this.';
  return null;
}

// ----- visibility, favorites, extensions ------------------------------------------------

const visible = (o) => o.available && (o.id in settings.opVisibility ? !!settings.opVisibility[o.id] : true);
function setVisible(o, on) {
  const next = { ...settings.opVisibility };
  if (on) delete next[o.id];
  else next[o.id] = false;
  save({ opVisibility: next });
}
const isFav = (id) => settings.favorites.includes(id);
function toggleFav(id) {
  const favs = settings.favorites.filter((f) => f !== id);
  if (!isFav(id)) favs.push(id);
  save({ favorites: favs });
}
const extById = (id) => (extensions || []).find((e) => e.id === id);
const installed = (id) => !!settings.extensions[id];
function setInstalled(ids, on) {
  const next = { ...settings.extensions };
  for (const id of [].concat(ids)) next[id] = on;
  save({ extensions: next });
}

// A small rectangle for one format or tool: click to show or hide it on the wheel.
function formatTile(o, { label, sub, wide } = {}) {
  const text = label || o.label;
  if (!o.available) {
    return h('div', { class: `ftile locked${wide ? ' wide' : ''}`, title: `Comes with ${extById(o.ext)?.name || 'an extension'}` },
      h('span', { class: 'lock', html: icon('lock', 11) }), h('b', {}, text), sub ? h('small', {}, sub) : null);
  }
  const on = visible(o);
  const fav = isFav(o.id);
  const needs = o.needsOffice && !info.office && !o.officeOk;
  const tile = h('div', {
    class: `ftile ${on ? 'on' : 'off'}${wide ? ' wide' : ''}`, role: 'button', tabindex: '0', 'aria-pressed': String(on),
    title: needs ? 'Best with LibreOffice installed' : on ? 'On the wheel. Click to hide.' : 'Hidden. Click to show.',
    onclick: () => setVisible(o, !on),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setVisible(o, !on); } },
  }, h('b', {}, text), sub ? h('small', {}, sub) : null,
  h('button', {
    type: 'button', class: `star${fav ? ' on' : ''}`, 'aria-pressed': String(fav), 'aria-label': `${fav ? 'Unstar' : 'Star'} ${text}`, title: fav ? 'Favorite' : 'Add to favorites',
    onclick: (e) => { e.stopPropagation(); toggleFav(o.id); },
  }, fav ? '★' : '☆'));
  return tile;
}

function opIndex() {
  const index = new Map();
  for (const f of formats || []) {
    for (const o of f.convert) if (o.available) index.set(o.id, { cat: f.label, label: o.label, kind: 'Format' });
    for (const o of f.editor) if (o.available) index.set(o.id, { cat: f.label, label: o.title || o.label, kind: 'Creator' });
    for (const o of f.tools) if (o.available && !index.has(o.id)) index.set(o.id, { cat: f.label, label: o.label, kind: 'Tool' });
  }
  return index;
}

// ----- home --------------------------------------------------------------------------------

// A looping picture of the gesture, drawn like the real wheel at half size:
// the file is pressed, the wheel fans out, the cursor picks a wedge.
function scene() {
  const C = 120;
  const [rIn, rOut, gap, corner] = [46, 112, 4, 7];
  const pt = (r, deg) => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)];
  const f = (n) => n.toFixed(1);
  // Inset by the corner radius; a stroke of twice that with round joins rounds every corner.
  const petal = (a0, a1) => {
    const ro = rOut - corner;
    const ri = rIn + corner;
    const off = (r) => (Math.asin((gap / 2 + corner) / r) * 180) / Math.PI;
    const [x0, y0] = pt(ro, a0 + off(ro));
    const [x1, y1] = pt(ro, a1 - off(ro));
    const [x2, y2] = pt(ri, a1 - off(ri));
    const [x3, y3] = pt(ri, a0 + off(ri));
    return `M${f(x0)},${f(y0)} A${ro},${ro} 0 0 1 ${f(x1)},${f(y1)} L${f(x2)},${f(y2)} A${ri},${ri} 0 0 0 ${f(x3)},${f(y3)} Z`;
  };
  const items = [['JPG', 'Photo'], ['WEBP', 'Web'], ['PDF', 'Document'], ['GIF', 'Animation'], ['AVIF', 'Small']];
  const step = 360 / items.length;
  const petals = items.map(([t, sub], i) => {
    const mid = -90 + i * step;
    const [tx, ty] = pt((rIn + rOut) / 2, mid);
    const [dx, dy] = pt(5, mid).map((v) => v - C);
    return `<g class="petal${i === 0 ? ' hot' : ''}" style="--i:${i};--dx:${f(dx)}px;--dy:${f(dy)}px"><g class="pop"><path class="edge" d="${petal(mid - step / 2, mid + step / 2)}"/><path class="shape" d="${petal(mid - step / 2, mid + step / 2)}"/><text class="t" x="${f(tx)}" y="${f(ty - 5)}">${t}</text><text class="s" x="${f(tx)}" y="${f(ty + 8)}">${sub}</text></g></g>`;
  }).join('');
  const hub = `<g class="hub"><circle cx="${C}" cy="${C}" r="40"/><rect x="${C - 13}" y="${C - 26}" width="26" height="26" rx="7" class="thumb"/><text class="badge" x="${C}" y="${C - 13}">PNG</text><text class="name" x="${C}" y="${C + 12}">photo.png</text><text class="kind" x="${C}" y="${C + 24}">PNG · Image</text></g>`;
  return h('div', { class: 'scene', 'aria-hidden': 'true' },
    h('div', { html: `<svg viewBox="0 0 240 240" width="240" height="240"><g class="ring">${petals}</g>${hub}</svg>` }).firstChild,
    h('span', { class: 'cursor', html: icon('cursor', 22) }));
}

function home() {
  const t = settings.trigger;
  const keys = comboParts(t.mods, t.key);
  const editors = (extensions || []).filter((e) => e.editor);
  const missing = editors.filter((e) => !e.installed);
  return [
    h('div', { class: 'card hero' },
      h('div', {},
        h('h2', {}, settings.gestureEnabled ? 'Hold, press, pick' : 'Wedge is paused'),
        h('p', {}, `Works in ${fileManager()}.`),
        h('div', { class: 'combo', title: 'Change in Wheel' }, keys.flatMap((k, i) => [i ? h('span', { class: 'plus' }, '+') : null, h('span', { class: 'keycap' }, k)]),
          h('span', { class: 'plus' }, '+'), h('span', { class: 'click', title: 'Press a file', html: icon('mouse', 20) }))),
      scene()),
    h('div', { class: 'steps' },
      h('div', { class: 'step' }, ic('wheel'), h('b', {}, 'Pick a format')),
      h('div', { class: 'step' }, ic('folder'), h('b', {}, 'Saved beside it')),
      h('div', { class: 'step' }, ic('shield'), h('b', {}, 'Never leaves your PC'))),
    editors.some((e) => e.installed) ? h('div', { class: 'tiles' },
      editors.filter((e) => e.installed).map((e) => h('button', { type: 'button', class: 'tile', onclick: () => wedge.edit.pick(e.editor) }, ic(e.icon), h('b', {}, e.name)))) : null,
    h('div', { class: 'card' },
      h('h2', {}, 'Recent'),
      recent.length
        ? h('ul', { class: 'recent' }, recent.slice(0, 6).map((r) => h('li', {},
          ic('check', 16),
          h('span', { class: 'what' }, h('b', {}, r.outputs[0].split(/[\\/]/).pop()), h('small', {}, `${r.label}${r.outputs.length > 1 ? ` · ${r.outputs.length} files` : ''} · ${new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)),
          h('button', { type: 'button', class: 'btn small', onclick: () => wedge.reveal(r.outputs[0]) }, 'Show'))))
        : h('p', { class: 'empty' }, 'Nothing yet.')),
    missing.length ? h('button', { type: 'button', class: 'cta', html: `${icon('plus', 16)}<span>Add editors</span>`, onclick: () => go('extensions') }) : null,
  ];
}

// ----- wheel ---------------------------------------------------------------------------------

function wheel() {
  const warning = triggerWarning(settings.trigger);
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Accent color' }, ACCENTS.map(([c, name]) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(settings.accent === c), 'aria-label': name, title: name, class: `swatch${settings.accent === c ? ' on' : ''}`, style: `background:${c}`, onclick: () => save({ accent: c }) })));
  const keyOptions = ['shift', 'ctrl', 'alt', 'meta'].map((k) => [k, modLabel(k)]);
  const modeKey = (mode, label) => select(settings.modeKeys[mode], keyOptions, (v) => save({ modeKeys: { ...settings.modeKeys, [mode]: v } }), label);
  const creator = installed('creator');
  return [
    h('h1', { class: 'page' }, 'Wheel'),
    h('div', { class: 'group' },
      h('h2', {}, 'Shortcut'),
      row('Open the wheel', warning ? h('span', { class: 'warn' }, warning) : 'Hold, then press a file.',
        recorder({ kind: 'trigger', chips: comboChips(settings.trigger.mods, settings.trigger.key), onDone: (t) => save({ trigger: t }) })),
      row('Pause or resume', 'Optional.',
        recorder({ kind: 'accelerator', allowClear: true, chips: accelChips(settings.pauseShortcut), onDone: (a) => save({ pauseShortcut: a || '' }) }))),
    h('div', { class: 'group' },
      h('h2', {}, 'Look'),
      row('Size', null, segmented(settings.wheelSize, [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], (v) => save({ wheelSize: v }), 'Size')),
      row('Theme', null, segmented(settings.theme, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], (v) => save({ theme: v }), 'Theme')),
      row('Accent', null, swatches),
      row('Animations', null, toggle('animations', 'Animations')),
      row('After converting', null, select(settings.closeAfter, [['result', 'Show a check, then close'], ['instant', 'Close right away']], (v) => save({ closeAfter: v }), 'After converting'))),
    h('div', { class: 'group' },
      h('h2', {}, 'More wheels'),
      creator
        ? row('Creator wheel key', 'Tap while the wheel is open.', modeKey('editor', 'Creator wheel key'))
        : row('Creator wheel', 'ProRes, proxies, 9:16, loudness.', h('button', { type: 'button', class: 'btn small', onclick: () => go('extensions') }, 'Get Creator Pack')),
      row('Tools and actions', 'Compress, resize, split, copy path.', toggle('showAllModes', 'Tools and actions')),
      settings.showAllModes ? row('Tools wheel key', null, modeKey('tools', 'Tools wheel key')) : null,
      settings.showAllModes ? row('Actions wheel key', null, modeKey('actions', 'Actions wheel key')) : null,
      settings.showAllModes ? h('div', { class: 'set-row', style: 'display:block' }, h('div', { class: 'txt', style: 'margin-bottom:10px' }, h('b', {}, 'Actions')),
        h('div', { class: 'ftiles wide' }, (actions || []).map((a) => formatTile(a, { wide: true })))) : null),
  ];
}

// ----- favorites -----------------------------------------------------------------------------

function favoritesPage() {
  const index = opIndex();
  const favs = settings.favorites.filter((id) => index.has(id));
  const move = (i, d) => {
    const next = [...favs];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    save({ favorites: next });
  };
  return [
    h('h1', { class: 'page' }, 'Favorites'),
    h('p', { class: 'lead' }, 'Starred items lead the wheel, in this order.'),
    h('div', { class: 'group' },
      row('Favorites first', 'Starred items at the top of every wheel.', toggle('favoritesFirst', 'Favorites first')),
      row('Favorites wheel', 'A ★ tab with only your starred items.', toggle('favoritesWheel', 'Favorites wheel')),
      settings.favoritesWheel ? row('Open on Favorites', 'Start on the ★ tab.', toggle('openOnFavorites', 'Open on Favorites')) : null,
      settings.favoritesWheel && settings.openOnFavorites ? h('div', { class: 'warnbox', role: 'note' }, h('b', {}, 'Heads up: '),
        'files with a favorite open on the ★ tab. Everything else is one hover away under the wheel.') : null),
    h('div', { class: 'group' },
      h('h2', {}, `Priority (${favs.length})`),
      favs.length
        ? h('ol', { class: 'favlist' }, favs.map((id, i) => {
          const m = index.get(id);
          return h('li', {}, h('span', { class: 'rank' }, String(i + 1)), h('span', { class: 'fav-name' }, h('b', {}, m.label), h('small', {}, `${m.cat} · ${m.kind}`)),
            h('span', { class: 'fav-actions' },
              h('button', { type: 'button', class: 'sq-btn', 'aria-label': `Move ${m.label} up`, disabled: i === 0 || null, onclick: () => move(i, -1) }, '↑'),
              h('button', { type: 'button', class: 'sq-btn', 'aria-label': `Move ${m.label} down`, disabled: i === favs.length - 1 || null, onclick: () => move(i, 1) }, '↓'),
              h('button', { type: 'button', class: 'sq-btn', 'aria-label': `Remove ${m.label}`, onclick: () => toggleFav(id) }, '✕')));
        }))
        : h('p', { class: 'empty' }, 'Star a format in ', h('a', { class: 'link', onclick: () => go('formats') }, 'Formats'), '.')),
  ];
}

// ----- formats -------------------------------------------------------------------------------

function formatsPage() {
  const cats = (formats || []).filter((f) => CAT_ICON[f.key]);
  const f = cats.find((c) => c.key === category) || cats[0];
  const all = (c) => [...c.convert, ...c.editor, ...(settings.showAllModes ? c.tools : [])];
  const byAvail = (list) => [...list.filter((o) => o.available), ...list.filter((o) => !o.available)];
  const section = (title, list, opts, wide) => (list.length ? [h('div', { class: 'sect' }, title), h('div', { class: `ftiles${wide ? ' wide' : ''}` }, byAvail(list).map((o) => formatTile(o, opts(o))))] : []);
  const locked = all(f).filter((o) => !o.available);
  const packs = [...new Set(locked.map((o) => o.ext))].map(extById).filter(Boolean);
  const customized = Object.keys(settings.opVisibility).length > 0;
  return [
    h('div', { class: 'page-head' },
      h('h1', { class: 'page' }, 'Formats'),
      customized ? h('button', { type: 'button', class: 'btn small', onclick: () => save({ opVisibility: {} }) }, 'Reset') : null),
    h('p', { class: 'lead' }, 'Click to show or hide. ☆ to favorite.'),
    h('div', { class: 'cats', role: 'tablist' }, cats.map((c) => {
      const avail = all(c).filter((o) => o.available);
      return h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(c === f), class: `cat${c === f ? ' on' : ''}`,
        onclick: () => { category = c.key; render(); },
        title: `${avail.filter(visible).length} on the wheel`,
      }, ic(CAT_ICON[c.key], 15), h('b', {}, c.label), h('span', { class: 'n' }, String(avail.filter(visible).length)));
    })),
    h('div', { class: 'detail' },
      h('div', { class: 'detail-head' },
        h('div', {}, h('h2', {}, f.label), h('div', { class: 'opens' }, f.inputs.slice(0, 14).map((t) => h('span', {}, t)), f.inputs.length > 14 ? h('span', {}, `+${f.inputs.length - 14}`) : null))),
      ...section('Convert to', f.convert, (o) => ({ sub: o.onlyFor ? o.onlyFor.join(' ') : null })),
      ...section('Creator', f.editor, (o) => ({ label: o.title || o.label, sub: o.onlyFor ? o.onlyFor.slice(0, 3).join(' ') : null, wide: true }), true),
      ...(settings.showAllModes ? section('Tools', f.tools, (o) => ({ wide: true, sub: o.multi ? '2+ files' : null }), true) : []),
      packs.map((p) => h('div', { class: 'unlock' }, ic(p.icon, 16), h('span', {}, `${locked.filter((o) => o.ext === p.id).length} more with `, h('b', {}, p.name)),
        h('button', { type: 'button', class: 'btn small primary', onclick: () => setInstalled(p.id, true) }, 'Add')))),
  ];
}

// ----- extensions ----------------------------------------------------------------------------

// What each editor or feature pack does, as a row of icons.
const FEATURES = {
  'image-editor': [['crop', 'Crop'], ['pen', 'Draw'], ['arrow', 'Arrows'], ['type', 'Text'], ['redact', 'Redact']],
  'video-editor': [['scissors', 'Trim'], ['crop', 'Crop'], ['zap', 'Speed'], ['mute', 'Mute'], ['camera', 'Save frame']],
  'pdf-editor': [['grid', 'Reorder pages'], ['rotr', 'Rotate'], ['type', 'Text'], ['highlighter', 'Highlight'], ['signature', 'Sign']],
  creator: [['video', 'ProRes and DNxHR'], ['copy', 'Proxies'], ['zap', 'Fix frame rate'], ['slides', '9:16 and 1:1'], ['volume', 'Loudness']],
  'file-actions': [['folder', 'Float on the shelf'], ['keyboard', 'Open in terminal'], ['copy', 'Copy to a folder'], ['output', 'Share']],
};

function extCard(e) {
  const a = e.adds;
  const features = FEATURES[e.id];
  const more = a.tools ? `+${a.tools} tools` : null;
  const toggleBtn = h('button', {
    type: 'button', class: `round ${e.installed ? 'on' : 'add'}`,
    'aria-label': `${e.installed ? 'Remove' : 'Add'} ${e.name}`, title: e.installed ? 'Added. Click to remove.' : `Add ${e.name}`,
    html: icon(e.installed ? 'check' : 'plus', 17), onclick: () => setInstalled(e.id, !e.installed),
  });
  return h('div', { class: `ext${e.installed ? ' installed' : ''}` },
    h('div', { class: 'top' },
      ic(e.icon, 20),
      h('div', { class: 'name' }, h('b', {}, e.name), h('small', {}, e.tagline)),
      h('div', { class: 'corner' },
        e.editor && e.installed ? h('button', { type: 'button', class: 'round ghost', 'aria-label': `Open ${e.name}`, title: 'Open a file', html: icon('arrow', 15), onclick: () => wedge.edit.pick(e.editor) }) : null,
        toggleBtn)),
    features
      ? h('div', { class: 'feats' }, features.map(([name, label], i) => h('span', { class: 'feat', title: label, style: `--i:${i}`, html: icon(name, 16) })))
      : h('div', { class: 'pills' },
        e.samples.slice(0, 11).map((s) => h('span', { class: 'pill' }, s)),
        e.samples.length > 11 ? h('span', { class: 'pill more' }, `+${e.samples.length - 11}`) : null,
        more ? h('span', { class: 'pill count' }, more) : null));
}

function extensionsPage() {
  const list = extensions || [];
  const left = list.filter((e) => !e.installed);
  return [
    h('div', { class: 'page-head' },
      h('h1', { class: 'page' }, 'Extensions'),
      left.length
        ? h('button', { type: 'button', class: 'btn small primary icon-text', html: `${icon('download', 14)}Add all`, onclick: () => setInstalled(list.map((e) => e.id), true) })
        : h('span', { class: 'muted' }, 'Everything added')),
    h('p', { class: 'lead' }, 'Wedge starts with the essentials. Add more anytime, all offline.'),
    h('div', { class: 'sect' }, 'Packs'),
    h('div', { class: 'exts' }, list.filter((e) => !e.editor).map(extCard)),
    h('div', { class: 'sect' }, 'Editors'),
    h('div', { class: 'exts' }, list.filter((e) => e.editor).map(extCard)),
  ];
}

// ----- system & about ------------------------------------------------------------------------

function system() {
  const folderLabel = h('span', { class: 'muted', title: settings.outputFolder }, settings.outputFolder || 'No folder');
  const chooseFolder = h('button', { type: 'button', class: 'btn small', onclick: async () => { const f = await wedge.pickFolder(); if (f) save({ outputFolder: f, outputMode: 'folder' }); } }, 'Choose');
  const anyEditor = Object.keys(EDITOR_FOR).some(installed);
  return [
    h('h1', { class: 'page' }, 'System'),
    h('div', { class: 'group' },
      h('h2', {}, 'Background'),
      info.platform !== 'linux' ? row(`Start with ${OS_NAME()}`, 'Waits in the tray. No window.', toggle('launchAtLogin', 'Start with the computer')) : null,
      isWin() ? row('Right-click menu', anyEditor ? 'Convert with Wedge, Edit with Wedge.' : 'Convert with Wedge.', toggle('contextMenu', 'Right-click menu')) : null,
      row('Shortcut works in', settings.fileManagerOnly ? `Files in ${fileManager()}.` : `Files in ${fileManager()}, plus files you drag out of any app (browser, mail, chat).`,
        segmented(settings.fileManagerOnly ? 'fm' : 'any', [['fm', isWin() ? 'Explorer & desktop' : 'File manager'], ['any', 'Any app']], (v) => save({ fileManagerOnly: v === 'fm' }), 'Shortcut works in')),
      row('Several files selected', null,
        select(settings.multiSelect, [['pressed', 'Just the pressed file'], ['all', 'All selected files']], (v) => save({ multiSelect: v }), 'Several files selected'))),
    h('div', { class: 'group' },
      h('h2', {}, 'Saving'),
      row('Save new files', 'Never overwrites: photo (1).jpg', select(settings.outputMode, [['beside', 'Next to the original'], ['folder', 'In one folder']], (v) => save({ outputMode: v }), 'Save new files')),
      settings.outputMode === 'folder' ? row('Folder', null, [folderLabel, chooseFolder]) : null,
      row('Image quality', 'JPG, WebP, AVIF.', select(String(settings.imageQuality), [['75', '75'], ['85', '85'], ['90', '90'], ['95', '95'], ['100', '100']], (v) => save({ imageQuality: Number(v) }), 'Image quality')),
      row('Show in folder when done', null, toggle('revealAfter', 'Show in folder when done')),
      row('Notifications', null, toggle('notify', 'Notifications'))),
  ];
}

function about() {
  const c = info.counts;
  const added = (extensions || []).filter((e) => e.installed).length;
  const stat = (n, l) => h('div', { class: 'stat' }, h('b', {}, String(n)), h('small', {}, l));
  const engines = ['libvips', 'FFmpeg', 'MuPDF', 'pdf-lib', 'SheetJS', 'mammoth', 'heic-convert'];
  return [
    h('div', { class: 'card about-hero' },
      h('img', { src: '../../build/icon.png', alt: '', width: 72, height: 72 }),
      h('div', {}, h('h2', {}, info.name), h('p', {}, `Version ${info.version}`)),
      h('span', { class: `state ${settings.gestureEnabled ? 'on' : 'off'}` }, h('span', { class: 'dot' }), settings.gestureEnabled ? 'Running' : 'Paused')),
    h('div', { class: 'stats' },
      stat(c.conversions, 'conversions'), stat(c.tools, 'tools'), stat(c.editor, 'creator presets'), stat(`${added}/${(extensions || []).length}`, 'extensions')),
    h('div', { class: 'card' },
      h('h2', {}, 'Private by design'),
      h('div', { class: 'pills', style: 'margin-bottom:12px' }, ic('shield', 16, 'ic inline'), h('span', { class: 'muted', style: 'max-width:none' }, 'Every file is converted on this computer. Nothing is uploaded.')),
      h('div', { class: 'pills' }, engines.map((e) => h('span', { class: 'pill' }, e)))),
    h('div', { class: 'group' },
      row('LibreOffice', info.office ? 'Found. Used for Office files.' : 'Optional. For DOC, ODT, PPT.', info.office ? ic('check', 16, 'ic ok') : null),
      row('Reset', 'All settings back to default.', h('button', {
        type: 'button', class: 'btn small', onclick: async () => {
          const { welcomed, lastOptions, startupAsked, signatures, ...rest } = await wedge.defaults();
          save(rest);
        },
      }, 'Reset'))),
  ];
}

const PAGES = { home, wheel, favorites: favoritesPage, formats: formatsPage, extensions: extensionsPage, system, about };

// ----- first run -------------------------------------------------------------------------

function startupPrompt() {
  const modal = $('#modal');
  if (settings.startupAsked || info.platform === 'linux') {
    modal.hidden = true;
    return;
  }
  const menu = h('input', { type: 'checkbox' });
  menu.checked = true;
  const card = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'startup-title' },
    h('div', { class: 'badge', html: icon('power', 22) }),
    h('h2', { id: 'startup-title' }, `Start with ${OS_NAME()}?`),
    h('p', {}, 'Wedge waits quietly in the tray so the shortcut always works. No window opens.'),
    isWin() ? h('label', { class: 'check' }, menu, h('span', {}, 'Add to the right-click menu')) : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => answer(false) }, 'Not now'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => answer(true) }, 'Start with login')));
  async function answer(yes) {
    modal.hidden = true;
    await save({ startupAsked: true, launchAtLogin: yes, ...(isWin() ? { contextMenu: menu.checked } : {}) });
  }
  modal.replaceChildren(card);
  modal.hidden = false;
  card.querySelector('.btn.primary').focus();
}

// ----- sidebar: drag to resize, double-click to collapse ------------------------------------

const SIDE = { min: 180, max: 340, collapseBelow: 130, store: 'wedge.sidebar' };
const sideState = (() => {
  try {
    return { width: 232, collapsed: false, ...JSON.parse(localStorage.getItem(SIDE.store) || '{}') };
  } catch {
    return { width: 232, collapsed: false };
  }
})();
function applySide() {
  document.body.classList.toggle('collapsed', sideState.collapsed);
  document.documentElement.style.setProperty('--side-w', sideState.collapsed ? '64px' : `${sideState.width}px`);
  for (const a of document.querySelectorAll('nav a')) a.title = sideState.collapsed ? a.textContent : '';
  try {
    localStorage.setItem(SIDE.store, JSON.stringify(sideState));
  } catch {
    // Storage can be unavailable; the sidebar still works for this session.
  }
}
function initResizer() {
  const handle = $('#resizer');
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = ev.clientX;
      if (w < SIDE.collapseBelow) sideState.collapsed = true;
      else {
        sideState.collapsed = false;
        sideState.width = Math.max(SIDE.min, Math.min(SIDE.max, w));
      }
      applySide();
    };
    const up = () => {
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => {
    sideState.collapsed = !sideState.collapsed;
    applySide();
  });
  handle.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (e.key === 'Enter') sideState.collapsed = !sideState.collapsed;
    else if (step) {
      if (sideState.collapsed && step > 0) sideState.collapsed = false;
      else if (!sideState.collapsed && sideState.width + step < SIDE.min) sideState.collapsed = true;
      else sideState.width = Math.max(SIDE.min, Math.min(SIDE.max, sideState.width + step));
    } else return;
    e.preventDefault();
    applySide();
  });
  applySide();
}

// ----- chrome -----------------------------------------------------------------------------

function renderNav() {
  $('#nav').replaceChildren(...NAV.map((n) => (n.group
    ? h('div', { class: 'nav-group' }, n.group)
    : h('a', { href: `#${n.id}`, class: n.id === section ? 'on' : '', 'aria-current': n.id === section ? 'page' : null, title: sideState.collapsed ? n.label : null, html: `${icon(n.icon, 17)}<span>${n.label}</span>`, onclick: (e) => { e.preventDefault(); go(n.id); } }))));
  const run = $('#run-toggle');
  const on = info.gesture.enabled && info.gesture.running;
  run.classList.toggle('off', !settings.gestureEnabled);
  run.setAttribute('aria-pressed', String(settings.gestureEnabled));
  $('#run-label').textContent = settings.gestureEnabled ? (on ? 'Running' : 'Starting') : 'Paused';
  run.title = settings.gestureEnabled ? 'Running. Click to pause.' : 'Paused. Click to resume.';
}

function renderBanner() {
  const g = info.gesture;
  const banner = $('#banner');
  banner.textContent = '';
  let msg = null;
  let action = null;
  if (isMac() && !g.accessibility) {
    msg = 'Allow Accessibility access so Wedge can notice the shortcut.';
    action = h('button', { type: 'button', class: 'btn small primary', onclick: async () => { await wedge.promptAccessibility(); init(); } }, 'Allow access');
  } else if (g.wayland) msg = 'On Wayland, Wedge only sees apps running under XWayland.';
  else if (g.enabled && g.error) msg = `Wedge can't watch the keyboard and mouse: ${g.error}`;
  banner.hidden = !msg;
  if (msg) banner.append(h('span', {}, msg), action);
}

function applyAccent() {
  const root = document.documentElement.style;
  root.setProperty('--accent', settings.accent);
  root.setProperty('--accent-strong', `color-mix(in srgb, ${settings.accent} 80%, #000)`);
  root.setProperty('--accent-soft', `color-mix(in srgb, ${settings.accent} 14%, transparent)`);
}

let lastSection = null;
function render() {
  applyAccent();
  renderNav();
  renderBanner();
  const content = $('#content');
  const scroll = $('#main').scrollTop;
  content.replaceChildren(...(PAGES[section] || home)().filter((n) => n !== null && n !== undefined && n !== false));
  // Only animate the page in when switching pages, not on every setting change.
  content.style.animation = section === lastSection ? 'none' : '';
  lastSection = section;
  $('#main').scrollTop = scroll;
}

function go(name) {
  if (!PAGES[name]) return;
  section = name;
  history.replaceState(null, '', `#${name}`);
  $('#main').scrollTop = 0;
  const content = $('#content');
  content.style.animation = 'none';
  void content.offsetWidth;
  render();
}

$('#run-toggle').addEventListener('click', () => save({ gestureEnabled: !settings.gestureEnabled }));

async function init() {
  [info, settings, formats, actions, extensions, recent] = await Promise.all([wedge.info(), wedge.getSettings(), wedge.formats(), wedge.actions(), wedge.extensions(), wedge.recent()]);
  document.body.classList.toggle('mac', isMac());
  $('#app-name').textContent = info.name;
  render();
  initResizer();
  startupPrompt();
}

wedge.on.settingsChanged(async (s) => {
  settings = s;
  await refresh();
});
wedge.on.settingsSection((name) => go(name === 'editors' ? 'extensions' : name));
wedge.on.recentChanged((r) => {
  recent = r;
  if (section === 'home') render();
});
init();
