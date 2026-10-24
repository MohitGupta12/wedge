// Persistent settings stored as JSON in the user data folder.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const isMac = process.platform === 'darwin';

// Hold these together and press on a file to open the wheel.
// Alt alone: Shift and Ctrl change what a click selects in Explorer, Alt doesn't.
const DEFAULT_TRIGGER = { mods: ['alt'], key: null };

// Bumped when a default changes in a way existing settings should pick up.
const SETTINGS_VERSION = 6;

const DEFAULTS = {
  gestureEnabled: true,
  trigger: DEFAULT_TRIGGER,
  fileManagerOnly: true, // only react inside Explorer / the desktop / Finder
  multiSelect: 'all', // 'pressed' | 'all': which files a press converts when several are selected
  pauseShortcut: '', // Electron accelerator that toggles Wedge on/off
  // Installed extensions (all bundled; "installing" switches a pack on).
  extensions: { 'image-editor': true, 'video-editor': true, 'pdf-editor': true },
  favorites: [], // op ids in priority order
  favoritesFirst: true, // starred formats lead each wheel, clockwise from the top
  favoritesWheel: false, // add a Favorites wheel to the switcher
  openOnFavorites: false, // open on the Favorites wheel instead of Formats
  showAllModes: false, // also offer the Tools and Actions wheels
  // Tap while the wheel is open to switch to that wheel; tap again to go back.
  modeKeys: { editor: 'shift', tools: isMac ? 'meta' : 'ctrl', actions: isMac ? 'ctrl' : 'alt' },
  opVisibility: {}, // op id -> true/false where the user overrode the recommended wheel
  contextMenu: true, // "Wedge" entries in the Explorer right-click menu (Windows)
  startupAsked: false, // whether we've asked about starting with the computer
  wheelSize: 'medium', // 'small' | 'medium' | 'large'
  animations: true,
  closeAfter: 'result', // 'result' (show a check) | 'instant'
  theme: 'system', // 'system' | 'light' | 'dark'
  accent: '#12b76a', // Wedge green, the logo's color
  outputMode: 'beside', // 'beside' | 'folder' | 'ask' (a Save dialog each time, like a browser download)
  outputFolder: '',
  revealAfter: false,
  notify: true,
  launchAtLogin: false, // asked on first open: "keep Wedge running in the background?"
  imageQuality: 90,
  pdfDpi: 200,
  lastOptions: {},
  signatures: [], // saved signatures (PNG data URLs), kept only on this computer
  welcomed: false,
  trayHintShown: false, // told once that closing Settings keeps Wedge running
  version: SETTINGS_VERSION,
};

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (cache) return cache;
  try {
    // Tolerate a byte-order mark (some editors add one) instead of losing every setting.
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, ''));
    const { convert, ...savedKeys } = saved.modeKeys || {}; // older builds had a "back to formats" key
    cache = { ...DEFAULTS, ...saved, modeKeys: { ...DEFAULTS.modeKeys, ...savedKeys } };
    // Older builds stored a single key name; Shift alone clashed with range selection.
    if (typeof cache.trigger === 'string' || !Array.isArray(cache.trigger?.mods)) cache.trigger = DEFAULT_TRIGGER;
    // The old orange default looked like a copy of another app; move it to Iris.
    if (cache.accent === '#ff7a1a') cache.accent = DEFAULTS.accent;
    if (!(saved.version >= 2)) {
      // v2: the Editor wheel became opt-in, and Shift+Alt replaced Ctrl+Alt.
      cache.editorPresets = false;
      const t = cache.trigger;
      if (t.mods.length === 2 && t.mods.includes('ctrl') && t.mods.includes('alt') && !t.key) cache.trigger = DEFAULT_TRIGGER;
    }
    if (!(saved.version >= 3)) {
      // v3: a short recommended wheel replaces "everything on"; earlier hides carry over.
      cache.opVisibility = { ...cache.opVisibility };
      for (const id of Object.keys(saved.hiddenOps || {})) cache.opVisibility[id] = false;
      delete cache.hiddenOps;
      cache.startupAsked = false; // ask once about running in the background
    }
    if (!(saved.version >= 4)) {
      // v4: optional packs replace the editor-presets and editors switches; green is the default.
      cache.extensions = { ...DEFAULTS.extensions, ...(saved.extensions || {}) };
      if (saved.editorPresets) cache.extensions.creator = true;
      if (saved.editorsEnabled === false) for (const id of ['image-editor', 'video-editor', 'pdf-editor']) cache.extensions[id] = false;
      if (['#6d5bf7', '#1fa35c'].includes(saved.accent)) cache.accent = DEFAULTS.accent;
      delete cache.editorPresets;
      delete cache.editorsEnabled;
    }
    if (!(saved.version >= 5)) {
      // v5: Alt + click replaced Shift+Alt, which also range-selected files.
      const t = cache.trigger;
      if (t.mods.length === 2 && t.mods.includes('alt') && t.mods.includes('shift') && !t.key) cache.trigger = DEFAULT_TRIGGER;
    }
    if (!(saved.version >= 6)) {
      // v6: Alt + click on a file inside a selection converts the whole selection.
      cache.multiSelect = 'all';
    }
    cache.version = SETTINGS_VERSION;
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}

module.exports = { load, save, DEFAULTS };
