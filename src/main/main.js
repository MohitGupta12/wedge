// Wedge main process. Runs quietly in the tray: hold the trigger keys and
// press on a file in a file manager, and the wheel opens around it. The only
// window is Settings.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, dialog, globalShortcut,
  nativeImage, nativeTheme, Notification, systemPreferences,
} = require('electron');
const settings = require('./settings');
const catalog = require('./catalog');
const actions = require('./actions');
const util = require('./util');
const docs = require('./engines/docs');
const shellContext = require('./context');
const editing = require('./engines/editing');
const contextMenu = require('./contextmenu');
const shellMenu = require('./shellmenu');
const { pathToFileURL } = require('url');
const { Jobs } = require('./jobs');
const { Gesture } = require('./gesture');

const isMac = process.platform === 'darwin';
const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload.js');
const BASE_SIZE = { width: 500, height: 560 }; // the wheel's layout size at 100%
const SCALES = { small: 0.6, medium: 0.72, large: 0.88 };
const FOCUS_DELAY = 70; // ms for the file manager to move focus to the pressed item
const debug = process.env.WEDGE_DEBUG ? (...a) => console.log('[wedge]', ...a) : () => {};

let settingsWin = null;
let wheel = null;
let shelf = null;
let tray = null;
let quitting = false;
let shelfItems = [];
// The current press, from the trigger press until the wheel closes.
//   { id, info, files, clicked, released, shown, rendererState }
let session = null;
let sessionSeq = 0;
let watchdog = null;
const gesture = new Gesture();
const ctx = shellContext.create();
const jobs = new Jobs(() => settings.load());

// Pass our own arguments along: Chromium reorders the argv the running instance sees.
// The self-test runs alongside an installed Wedge, so it skips the one-instance rule.
if (!process.argv.includes('--self-test') && !app.requestSingleInstanceLock({ argv: process.argv })) {
  app.quit();
  return;
}
// `--edit <file>` opens an editor and `--wheel <file>` the wheel (the Explorer
// right-click menu uses these). A second launch hands its arguments to us.
app.on('second-instance', (_e, argv, _cwd, data) => {
  if (!handleLaunchArgs(data?.argv || argv)) showSettings();
});
if (process.platform === 'win32') app.setAppUserModelId('app.wedge.converter');
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

catalog.setPrefsProvider(() => settings.load());

// ----- output location & PDF printing ---------------------------------------

util.setOutputDirResolver((input) => {
  const s = settings.load();
  if (s.outputMode === 'folder' && s.outputFolder && fs.existsSync(s.outputFolder)) return s.outputFolder;
  return path.dirname(input);
});

docs.setPrinter(async (htmlFile, out) => {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await win.loadFile(htmlFile);
    const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    await fsp.writeFile(out, data);
  } finally {
    win.destroy();
  }
});

// ----- windows ---------------------------------------------------------------

// Icons are unpacked from the asar: Windows can only load .ico files from real files.
function iconPath(name) {
  const unpacked = path.join(ROOT.replace(/app\.asar$/, 'app.asar.unpacked'), 'build', name);
  if (fs.existsSync(unpacked)) return unpacked;
  const p = path.join(ROOT, 'build', name);
  return fs.existsSync(p) ? p : undefined;
}

function webPrefs() {
  return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false };
}

// In development, surface renderer errors in the terminal.
app.on('web-contents-created', (_e, wc) => {
  if (app.isPackaged) return;
  wc.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.log(`[renderer ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  wc.on('preload-error', (_ev, p, err) => console.log(`[preload error] ${p}: ${err.stack || err}`));
});

function showSettings(section) {
  if (settingsWin) {
    if (section) settingsWin.webContents.send('settings:section', section);
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    center: true,
    show: false,
    title: app.getName(),
    icon: iconPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161617' : '#f5f5f7',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay('app'),
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: webPrefs(),
  });
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'), section ? { hash: section } : undefined);
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
    trayHint();
  });
}

// Closing Settings doesn't quit: Wedge keeps listening from the tray. Say so once.
function trayHint() {
  if (settings.load().trayHintShown || quitting || !Notification.isSupported()) return;
  settings.save({ trayHintShown: true });
  const keys = comboLabel(settings.load().trigger);
  new Notification({
    title: 'Wedge is still running',
    body: `${keys} + click any file to convert it. Wedge lives in the tray${isMac ? ' menu bar' : ''}; quit it from there.`,
    icon: iconPath('icon.png'),
    silent: true,
  }).show();
}

function comboLabel(t) {
  const names = isMac ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' } : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };
  return [...['ctrl', 'alt', 'shift', 'meta'].filter((m) => t.mods.includes(m)).map((m) => names[m]), ...(t.key ? [t.key] : [])].join('+');
}

// ----- editors -------------------------------------------------------------

const EDITOR_PAGES = { image: 'image-editor.html', media: 'media-editor.html', pdf: 'pdf-editor.html' };

// Windows draws its caption buttons over our own title bar; match what sits
// under them: the editors' toolbar, or the app window's page background.
function titleBarOverlay(kind = 'editor') {
  if (isMac) return undefined;
  const dark = nativeTheme.shouldUseDarkColors;
  const color = kind === 'app' ? (dark ? '#111115' : '#f4f4f7') : (dark ? '#1b1b21' : '#ffffff');
  return { color, symbolColor: dark ? '#f2f2f6' : '#17171c', height: kind === 'app' ? 44 : 47 };
}

// Explorer entries: "Edit with Wedge" only for editors that are installed.
// The taskbar takes a window's name and icon from the Start menu shortcut carrying the
// same AppUserModelID. Make sure Wedge's shortcut carries it and points at this exe, so
// Windows never shows a stale or generic Electron icon for Wedge.
function stampStartMenuShortcut() {
  if (!app.isPackaged) return;
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Wedge.lnk');
  if (!fs.existsSync(link)) return;
  try {
    shell.writeShortcutLink(link, 'update', {
      target: process.execPath, icon: process.execPath, iconIndex: 0, appUserModelId: 'app.wedge.converter', description: 'Wedge',
    });
  } catch (err) {
    console.error('Start menu shortcut update failed:', err.message);
  }
}

// force: ask for admin approval again even if it was declined before.
function applyContextMenu(force = false) {
  const s = settings.load();
  const editors = Object.entries({ image: 'image-editor', media: 'video-editor', pdf: 'pdf-editor' })
    .filter(([, id]) => catalog.isInstalled(id, s.extensions)).map(([kind]) => kind);
  contextMenu.apply(s.contextMenu, editors);
  // Windows 11's compact menu needs its own registration.
  const editExts = { image: ['image'], media: ['video', 'audio'], pdf: ['pdf'] };
  shellMenu.apply(s.contextMenu, { editExts: editors.flatMap((k) => editExts[k].flatMap((c) => catalog.CATEGORIES[c].exts)), force });
}

function editorKindFor(file) {
  const cat = catalog.describe(file).cat;
  return { image: 'image', video: 'media', audio: 'media', pdf: 'pdf' }[cat] || null;
}

// Returns true when the arguments asked for something (so no window is needed).
function handleLaunchArgs(argv) {
  // Accepts both "--edit <file>" and "--edit=<file>".
  const flag = (name) => {
    const joined = argv.find((a) => a.startsWith(`${name}=`));
    const i = argv.indexOf(name);
    const value = joined ? joined.slice(name.length + 1) : i >= 0 ? argv[i + 1] : null;
    const clean = value?.replace(/^"|"$/g, '');
    return clean && fs.existsSync(clean) ? path.resolve(clean) : null;
  };
  const editFile = flag('--edit');
  if (editFile) {
    const kind = editorKindFor(editFile);
    const ext = { image: 'image-editor', media: 'video-editor', pdf: 'pdf-editor' }[kind];
    if (kind && catalog.isInstalled(ext, settings.load().extensions)) openEditor(kind, editFile);
    else openWheelFor(editFile);
    return true;
  }
  const wheelFile = flag('--wheel');
  if (wheelFile) {
    openWheelFor(wheelFile);
    return true;
  }
  return false;
}

// Opens the wheel at the cursor for a known file, ready for a click.
function openWheelFor(file) {
  if (session) finishHide();
  const cat = catalog.forFiles([file]);
  if (!hasWedges(cat)) return;
  const s = { id: ++sessionSeq, files: [file], clicked: true, info: null };
  session = s;
  openWheel(s, cat);
}

function openEditor(kind, file) {
  if (!EDITOR_PAGES[kind] || !file) return;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 820,
    minHeight: 540,
    title: `${path.basename(file)} · Wedge`,
    icon: iconPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111115' : '#f4f4f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: webPrefs(),
  });
  win.loadFile(path.join(RENDERER, EDITOR_PAGES[kind]), { query: { file } });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => editing.closeFile(file));
}

nativeTheme.on('updated', () => {
  if (isMac) return;
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== wheel && w !== shelf && !w.isDestroyed()) {
      try { w.setTitleBarOverlay(titleBarOverlay(w === settingsWin ? 'app' : 'editor')); } catch {}
    }
  }
});

function createWheel() {
  wheel = new BrowserWindow({
    ...BASE_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    // A hidden window's frames and timers are throttled, which would stall the
    // open handshake (notably while another app runs a drag-and-drop loop).
    webPreferences: { ...webPrefs(), backgroundThrottling: false },
  });
  wheel.setAlwaysOnTop(true, 'screen-saver');
  if (isMac) wheel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  wheel.loadFile(path.join(RENDERER, 'wheel.html'));
  wheel.on('blur', () => wheel.webContents.send('wheel:blur'));
}

function wheelScale() {
  return SCALES[settings.load().wheelSize] || SCALES.medium;
}

// Sizes the wheel window and centers its ring on a point, kept on that display.
function placeWheel(center, scale) {
  const width = Math.round(BASE_SIZE.width * scale);
  const height = Math.round(BASE_SIZE.height * scale);
  const area = screen.getDisplayNearestPoint(center).workArea;
  const x = Math.round(Math.min(Math.max(center.x - width / 2, area.x), area.x + area.width - width));
  const y = Math.round(Math.min(Math.max(center.y - width / 2, area.y), area.y + area.height - height));
  wheel.setBounds({ x, y, width, height });
  wheel.webContents.setZoomFactor(scale);
}

function wheelModes() {
  const s = settings.load();
  return [
    'convert',
    ...(s.favoritesWheel && s.favorites.length ? ['favorites'] : []),
    ...(catalog.isInstalled('creator', s.extensions) ? ['editor'] : []),
    ...(s.showAllModes ? ['tools', 'actions'] : []),
  ];
}

// Which wheel opens first: Favorites when the user chose it and this file has some.
function startMode(cat) {
  const s = settings.load();
  return s.favoritesWheel && s.openOnFavorites && cat?.favorites?.length ? 'favorites' : 'convert';
}

function hasWedges(cat) {
  return wheelModes().some((m) => cat[m]?.length);
}

// Point the wheel should center on, in Electron's screen coordinates.
function cursorPoint(info) {
  return info?.cursor?.physical ? screen.screenToDipPoint(info.cursor) : screen.getCursorScreenPoint();
}

// Step 1 of opening: render invisibly. The window is shown on 'wheel:ready'
// so it never flashes stale content, then the renderer animates in.
function openWheel(s, catalogForFiles) {
  if (!wheel) createWheel();
  const point = cursorPoint(s.info);
  placeWheel(point, wheelScale());
  debug('open wheel at', point, 'files', s.files);
  const st = settings.load();
  s.shown = 'opening';
  wheel.webContents.send('wheel:show', {
    session: s.id,
    state: s.clicked ? 'choose' : 'drag',
    startMode: startMode(catalogForFiles),
    files: s.files || null,
    catalog: catalogForFiles || null,
    multiSelect: st.multiSelect,
    modes: wheelModes(),
    keys: st.modeKeys,
    platform: process.platform,
    accent: st.accent,
    animations: st.animations,
    closeAfter: st.closeAfter,
  });
  gesture.wheelOpen = true;
  startWatchdog();
  sendThumbnail(s);
}

// The center shows the file's own thumbnail when the OS can make one.
async function sendThumbnail(s) {
  if (s.files?.length !== 1 || process.platform === 'linux') return;
  try {
    const img = await nativeImage.createThumbnailFromPath(s.files[0], { width: 144, height: 144 });
    if (!img.isEmpty() && session === s) wheel?.webContents.send('wheel:thumb', { session: s.id, url: img.toDataURL() });
  } catch {
    // No thumbnail for this type; the wheel shows a format badge instead.
  }
}

// Asks the renderer to animate out; it calls back with 'wheel:hidden'.
function dismissWheel(reason) {
  if (!session) return;
  debug('dismiss:', reason);
  const id = session.id;
  if (!session.shown) {
    session = null;
    return;
  }
  wheel?.webContents.send('wheel:dismiss', id);
  // Never leave the wheel stuck if the renderer doesn't answer.
  setTimeout(() => {
    if (session?.id === id) finishHide();
  }, 600);
}

function finishHide() {
  stopWatchdog();
  gesture.wheelOpen = false;
  session = null;
  if (wheel?.isVisible()) wheel.hide();
}

// Catches every way a wheel could be left behind: a mouse-up the hook
// missed, the file manager window closing, or a drag that ended elsewhere.
function startWatchdog() {
  stopWatchdog();
  let idleDrag = 0;
  watchdog = setInterval(async () => {
    const s = session;
    if (!s?.shown) return;
    if (s.rendererState === 'drag' && !gesture.pressing) {
      if (++idleDrag >= 3) dismissWheel('drag ended without a drop');
    } else idleDrag = 0;
    if (s.info && !(await ctx.alive(s.info)) && session === s) dismissWheel('file manager window closed');
  }, 400);
}

function stopWatchdog() {
  clearInterval(watchdog);
  watchdog = null;
}

function createShelf() {
  const area = screen.getPrimaryDisplay().workArea;
  shelf = new BrowserWindow({
    width: 240,
    height: 420,
    x: area.x + area.width - 260,
    y: area.y + Math.round((area.height - 420) / 2),
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 200,
    minHeight: 220,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: webPrefs(),
  });
  shelf.setAlwaysOnTop(true, 'floating');
  if (isMac) shelf.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  shelf.loadFile(path.join(RENDERER, 'shelf.html'));
  shelf.on('closed', () => (shelf = null));
}

function floatFiles(paths) {
  for (const p of paths) if (!shelfItems.includes(p)) shelfItems.push(p);
  if (!shelf) createShelf();
  const send = () => shelf.webContents.send('shelf:items', shelfItems);
  if (shelf.webContents.isLoading()) shelf.webContents.once('did-finish-load', send);
  else send();
  shelf.showInactive();
}

// ----- tray ------------------------------------------------------------------

function buildTrayMenu() {
  if (!tray) return;
  const s = settings.load();
  tray.setToolTip(s.gestureEnabled ? `${app.getName()} is running` : `${app.getName()} is paused`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: s.gestureEnabled ? 'Wedge is on' : 'Wedge is paused', enabled: false },
    { label: s.gestureEnabled ? 'Pause' : 'Resume', accelerator: s.pauseShortcut || undefined, click: () => togglePaused() },
    { type: 'separator' },
    { label: `Open ${app.getName()}`, click: () => showSettings() },
    { label: 'Formats…', click: () => showSettings('formats') },
    { type: 'separator' },
    { label: `Quit ${app.getName()}`, click: () => app.quit() },
  ]));
}

// Green while running, red while paused (a fainter template on macOS).
function trayImage() {
  const paused = !settings.load().gestureEnabled;
  const file = isMac ? 'trayTemplate.png' : `tray${paused ? '-paused' : ''}.${process.platform === 'win32' ? 'ico' : 'png'}`;
  const p = iconPath(file);
  if (!p) return null;
  const img = nativeImage.createFromPath(p);
  if (isMac) img.setTemplateImage(true);
  return img;
}

function createTray() {
  const img = trayImage();
  if (!img) return;
  tray = new Tray(img);
  buildTrayMenu();
  tray.on('click', () => (isMac ? tray.popUpContextMenu() : showSettings()));
}

function togglePaused() {
  const enabled = !settings.load().gestureEnabled;
  updateSettings({ gestureEnabled: enabled });
  if (Notification.isSupported()) new Notification({ title: app.getName(), body: enabled ? 'Wedge is on' : 'Wedge is paused', silent: true }).show();
}

// ----- gesture ----------------------------------------------------------------

function accessibilityOk() {
  return !isMac || systemPreferences.isTrustedAccessibilityClient(false);
}

function applyGesture() {
  const s = settings.load();
  gesture.configure({ trigger: s.trigger, modeKeys: s.modeKeys });
  if (s.gestureEnabled && accessibilityOk()) {
    gesture.start();
    ctx.start();
  } else {
    gesture.stop();
    dismissWheel('paused');
  }
}

function applyShortcuts() {
  globalShortcut.unregisterAll();
  const accel = settings.load().pauseShortcut;
  if (!accel) return;
  try {
    globalShortcut.register(accel, togglePaused);
  } catch (err) {
    console.error('Pause shortcut failed', err);
  }
}

// Files the press should act on, or [] when we can't tell.
// earlySelection: the selection read right at the press. A quick click collapses
// Explorer's selection to the clicked file on release, so read it before that.
async function targetFiles(info, earlySelection = []) {
  const focused = await ctx.focused(info);
  const { trigger, multiSelect } = settings.load();
  // Shift and Ctrl also change Explorer's selection (range / toggle). Undo that,
  // and act on the pressed file alone, since the selection no longer means anything.
  if (focused.length && (trigger.mods.includes('shift') || trigger.mods.includes('ctrl'))) {
    ctx.selectOnly?.(info);
    return focused;
  }
  if (!focused.length || multiSelect !== 'all') return focused;
  let selected = earlySelection.includes(focused[0]) ? earlySelection : await ctx.selected(info);
  if (!selected.includes(focused[0])) return focused;
  // Mixed selections convert the files of the same kind as the one pressed.
  const kind = catalog.describe(focused[0]).cat;
  selected = selected.filter((p) => catalog.describe(p).cat === kind);
  return selected.length ? selected : focused;
}

gesture.on('press', async () => {
  if (session) finishHide(); // a new press replaces any open wheel at once
  const s = { id: ++sessionSeq };
  session = s;
  const st = settings.load();
  const info = await ctx.probe().catch(() => ({ fileManager: null }));
  debug('press; probe', info);
  if (session !== s) return;
  s.info = info;
  // null means "couldn't tell" (e.g. Wayland); don't block the user then.
  if ((st.fileManagerOnly && info.fileManager === false) || info.onItem === false) {
    session = null;
    return;
  }
  let files = [];
  if (info.onItem || isMac) {
    const early = info.onItem && st.multiSelect === 'all' ? ctx.selected(info).catch(() => []) : Promise.resolve([]);
    await new Promise((r) => setTimeout(r, FOCUS_DELAY));
    files = await targetFiles(info, await early);
    if (session !== s) return;
    // On Windows we know a file item was pressed, so failing to resolve it means
    // it isn't a real file (e.g. "This PC"). Elsewhere fall back to the drag's type.
    if (!files.length && info.onItem) {
      session = null;
      return;
    }
  }
  if (s.released && !s.clicked) {
    session = null; // the drag already ended somewhere else
    return;
  }
  // Outside the file manager there's no file to read, only a file being dragged
  // (from a browser, mail or chat). Wait until the press really becomes a drag;
  // a plain click there does nothing.
  if (!files.length && !isMac && !s.dragging) {
    if (s.clicked) session = null;
    else s.waitForDrag = true;
    return;
  }
  let cat = null;
  if (files.length) {
    cat = catalog.forFiles(files);
    if (!hasWedges(cat)) {
      debug('nothing to offer for', files);
      session = null;
      return;
    }
    s.files = files;
  }
  openWheel(s, cat);
});

gesture.on('drag', () => {
  const s = session;
  if (!s) return;
  s.dragging = true;
  if (s.waitForDrag) {
    s.waitForDrag = false;
    openWheel(s, null); // the wheel learns the file type when the drag reaches it
  }
});

gesture.on('release', () => {
  debug('release');
  if (!session) return;
  session.released = true;
  if (session.shown) wheel?.webContents.send('wheel:release', session.id);
});

// A press without a drag: keep the wheel open for a click on a wedge.
gesture.on('click', () => {
  debug('click');
  const s = session;
  if (!s) return;
  s.clicked = true;
  if (s.waitForDrag) {
    session = null; // a click outside the file manager: nothing to convert
    return;
  }
  if (!s.shown) return; // openWheel will open straight into 'choose'
  if (s.files?.length) wheel?.webContents.send('wheel:choose', { session: s.id, files: s.files, catalog: catalog.forFiles(s.files) });
  else dismissWheel('click without a file');
});

// A mouse press anywhere outside the wheel closes it.
gesture.on('outside', (p) => {
  if (!session?.shown || !wheel) return;
  const point = process.platform === 'win32' ? screen.screenToDipPoint(p) : p;
  const b = wheel.getBounds();
  const inside = point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height;
  if (!inside) dismissWheel('click outside');
});

gesture.on('mode', (mode) => {
  if (wheelModes().includes(mode)) wheel?.webContents.send('wheel:mode', mode);
});
gesture.on('escape', () => dismissWheel('escape'));

// ----- jobs ------------------------------------------------------------------

jobs.on('update', (job) => wheel?.webContents.send('jobs:update', job));

// The last few things Wedge saved, for the Home page.
const recent = [];
function addRecent(label, outputs) {
  if (!outputs?.length) return;
  recent.unshift({ label, outputs, at: Date.now() });
  recent.splice(12);
  settingsWin?.webContents.send('recent:changed', recent);
}
// "Ask where to save": a Save As dialog for one file (like a browser download), or
// a folder picker when a conversion makes several files. Returns the final paths,
// or null when the user cancels.
async function moveInto(src, dest) {
  await fsp.rm(dest, { recursive: true, force: true }); // the Save dialog already confirmed replacing it
  try {
    await fsp.rename(src, dest);
  } catch {
    await fsp.cp(src, dest, { recursive: true }); // another drive
    await fsp.rm(src, { recursive: true, force: true });
  }
}

jobs.askWhereToSave = async (job, staged) => {
  const startDir = path.dirname(job.files[0]); // start where the original file is
  app.focus({ steal: true }); // the dialog must come up in front of the file manager
  if (staged.length === 1 && !(await fsp.stat(staged[0])).isDirectory()) {
    const name = path.basename(staged[0]);
    const extension = path.extname(name).slice(1);
    const res = await dialog.showSaveDialog({
      title: `Save ${name}`,
      defaultPath: path.join(startDir, name),
      filters: extension ? [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }] : [],
    });
    if (res.canceled || !res.filePath) return null;
    await moveInto(staged[0], res.filePath);
    return [res.filePath];
  }
  const res = await dialog.showOpenDialog({
    title: `Choose where to save ${staged.length === 1 ? path.basename(staged[0]) : `${staged.length} files`}`,
    defaultPath: startDir,
    buttonLabel: 'Save here',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const saved = [];
  for (const p of staged) {
    const dest = util.uniquePath(path.join(res.filePaths[0], path.basename(p)));
    await moveInto(p, dest);
    saved.push(dest);
  }
  return saved;
};

jobs.on('finished', (job) => {
  addRecent(job.label, job.outputs);
  const s = settings.load();
  if (s.revealAfter && job.outputs[0]) shell.showItemInFolder(job.outputs[0]);
  if (s.notify && Notification.isSupported()) {
    const ok = job.outputs.length;
    const body = job.status === 'failed'
      ? job.errors[0]?.message || 'Something went wrong'
      : `${ok === 1 ? path.basename(job.outputs[0]) : `${ok} files`} saved${job.errors.length ? `, ${job.errors.length} failed` : ''}`;
    const n = new Notification({ title: job.status === 'failed' ? `${job.label} failed` : job.label, body, silent: true });
    n.on('click', () => job.outputs[0] && shell.showItemInFolder(job.outputs[0]));
    n.show();
  }
});

// ----- settings ----------------------------------------------------------------

function applyAppearance() {
  nativeTheme.themeSource = settings.load().theme;
}

function applyLoginItem() {
  if (process.platform === 'linux') return; // left to the desktop environment
  if (!app.isPackaged) return; // a dev run would register electron.exe
  app.setLoginItemSettings({ openAtLogin: !!settings.load().launchAtLogin, args: ['--hidden'] });
}

function updateSettings(patch) {
  const s = settings.save(patch);
  if ('theme' in patch) applyAppearance();
  if ('launchAtLogin' in patch) applyLoginItem();
  if ('trigger' in patch || 'gestureEnabled' in patch || 'modeKeys' in patch) applyGesture();
  if ('pauseShortcut' in patch) applyShortcuts();
  if ('contextMenu' in patch || 'extensions' in patch) applyContextMenu(patch.contextMenu === true);
  if ('gestureEnabled' in patch && tray) tray.setImage(trayImage());
  buildTrayMenu();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', s);
  return s;
}

function rememberOptions(opId, options) {
  const op = catalog.get(opId);
  if (!op?.options?.length) return;
  const keep = {};
  for (const o of op.options) if (o.remember !== false && options[o.key] !== undefined) keep[o.key] = options[o.key];
  const s = settings.load();
  settings.save({ lastOptions: { ...s.lastOptions, [opId]: keep } });
}

// ----- IPC -------------------------------------------------------------------

ipcMain.handle('catalog:forMimes', (_e, mimes) => catalog.forMimes(mimes));
ipcMain.handle('catalog:forFiles', (_e, files) => catalog.forFiles(files));
ipcMain.handle('catalog:formats', () => catalog.formats());
ipcMain.handle('catalog:actions', () => catalog.actionList());
ipcMain.handle('catalog:extensions', () => catalog.extensionList());

ipcMain.handle('run', async (e, { opId, files, options = {} }) => {
  const op = catalog.get(opId);
  if (!op) throw new Error('Unknown operation');
  if (op.opens) {
    openEditor(op.opens, files[0]);
    return { action: true, message: null };
  }
  if (op.action) {
    const message = await actions.perform(opId, files, { win: BrowserWindow.fromWebContents(e.sender), float: floatFiles });
    return { action: true, message };
  }
  debug('run', opId, files);
  rememberOptions(opId, options);
  // Don't block the wheel: it watches progress through jobs:update events.
  const started = new Promise((resolve) => jobs.once('update', resolve));
  jobs.run(opId, files, options).catch((err) => console.error(err));
  return { job: await started };
});

// Step 2 of opening: the renderer has painted the closed state; show the window.
ipcMain.on('wheel:ready', (_e, id) => {
  if (session?.id !== id || !wheel) return;
  session.shown = true;
  if (session.clicked) {
    wheel.show();
    wheel.focus();
  } else wheel.showInactive();
  wheel.webContents.send('wheel:enter', id);
});
ipcMain.on('wheel:state', (_e, { id, state }) => {
  debug('wheel state', id, state);
  if (session?.id === id) session.rendererState = state;
});
ipcMain.on('wheel:hidden', (_e, id) => {
  debug('wheel hidden', id);
  if (!session || session.id === id) finishHide();
});
ipcMain.on('wheel:dismiss', () => dismissWheel('renderer'));
ipcMain.on('wheel:focus', () => {
  wheel?.show();
  wheel?.focus();
});
// Option forms need full-size text, so the wheel grows to 100% around its center.
ipcMain.on('wheel:expand', () => {
  if (!wheel) return;
  const b = wheel.getBounds();
  const scale = wheelScale();
  placeWheel({ x: b.x + (BASE_SIZE.width * scale) / 2, y: b.y + (BASE_SIZE.width * scale) / 2 }, 1);
  wheel.focus();
});

ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

// Editor back end. Each call names the file its window was opened for.
ipcMain.handle('edit:image:load', (_e, file) => editing.loadImage(file));
ipcMain.handle('edit:image:save', async (_e, file, dataUrl, format) => {
  const out = await editing.saveImage(file, dataUrl, format);
  addRecent('Image editor', [out]);
  return out;
});
ipcMain.handle('edit:media:info', async (_e, file) => ({ ...(await editing.mediaInfo(file)), url: pathToFileURL(file).href }));
ipcMain.handle('edit:media:proxy', async (_e, file) => pathToFileURL(await editing.previewProxy(file)).href);
ipcMain.handle('edit:media:waveform', (_e, file) => editing.waveform(file));
ipcMain.handle('edit:media:export', async (e, file, opts) => {
  const out = await editing.exportMedia(file, opts, (p) => !e.sender.isDestroyed() && e.sender.send('edit:progress', p));
  addRecent('Video editor', [out]);
  return out;
});
ipcMain.handle('edit:media:snapshot', (_e, file, time) => editing.snapshot(file, time));
ipcMain.handle('edit:pdf:info', (_e, file) => editing.pdfInfo(file));
ipcMain.handle('edit:pdf:thumb', (_e, file, index, width) => editing.pdfThumb(file, index, width));
ipcMain.handle('edit:pdf:render', (_e, file, index, scale, rotate) => editing.pdfRender(file, index, scale, rotate));
ipcMain.handle('edit:pdf:save', async (_e, file, pages, suffix) => {
  const out = await editing.savePdf(file, pages, suffix);
  addRecent('PDF editor', [out]);
  return out;
});
ipcMain.handle('recent', () => recent);
const PICK_FILTERS = {
  image: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tif', 'tiff', 'avif', 'bmp', 'gif'] }],
  media: [{ name: 'Video and audio', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'm4v', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
};
ipcMain.handle('edit:pick', async (e, kind) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: PICK_FILTERS[kind] });
  if (!res.canceled && res.filePaths[0]) openEditor(kind, res.filePaths[0]);
});
ipcMain.handle('edit:open', (_e, kind, file) => openEditor(kind, file));
ipcMain.handle('openPath', (_e, p) => shell.openPath(p));

ipcMain.handle('settings:get', () => settings.load());
ipcMain.handle('settings:set', (_e, patch) => updateSettings(patch));
ipcMain.handle('settings:defaults', () => settings.DEFAULTS);
ipcMain.handle('pickFolder', async (e) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});
ipcMain.handle('accessibility:prompt', () => {
  if (isMac) systemPreferences.isTrustedAccessibilityClient(true);
  applyGesture();
  return accessibilityOk();
});
// While the Settings window records a shortcut, the trigger must not fire.
ipcMain.on('recording', (_e, on) => {
  if (on) {
    gesture.stop();
    globalShortcut.unregisterAll();
  } else {
    applyGesture();
    applyShortcuts();
  }
});

ipcMain.handle('info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  counts: catalog.counts(),
  office: require('./engines/office').find(),
  gesture: {
    enabled: settings.load().gestureEnabled,
    running: !!gesture.hook,
    error: gesture.error,
    accessibility: accessibilityOk(),
    wayland: process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland',
  },
}));

ipcMain.handle('fileIcon', async (_e, p) => {
  try {
    return (await app.getFileIcon(p, { size: 'normal' })).toDataURL();
  } catch {
    return null;
  }
});

ipcMain.handle('shelf:list', () => shelfItems.filter((p) => fs.existsSync(p)));
ipcMain.handle('shelf:add', (_e, paths) => floatFiles(paths));
ipcMain.handle('shelf:remove', (_e, p) => {
  shelfItems = shelfItems.filter((x) => x !== p);
  return shelfItems;
});
ipcMain.handle('shelf:clear', () => {
  shelfItems = [];
  shelf?.hide();
});
ipcMain.on('shelf:startDrag', async (e, paths) => {
  const icon = await app.getFileIcon(paths[0], { size: 'normal' }).catch(() => null);
  e.sender.startDrag({ file: paths[0], files: paths, icon: icon && !icon.isEmpty() ? icon : nativeImage.createFromPath(iconPath('tray.png')) });
});

// ----- lifecycle -------------------------------------------------------------

app.whenReady().then(async () => {
  if (process.argv.includes('--self-test')) {
    await require(path.join(ROOT, 'scripts', 'self-test.js')).run();
    return;
  }
  if (isMac) {
    app.dock?.hide();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  }
  applyAppearance();
  if (process.platform === 'win32') {
    applyContextMenu(); // keeps the entries pointing at this exe
    stampStartMenuShortcut();
  }
  if (app.isPackaged) applyLoginItem(); // the login entry follows the installed exe
  createWheel();
  createTray();
  applyGesture();
  applyShortcuts();
  if (handleLaunchArgs(process.argv)) return;
  // First launch: register to start at login and show how it works.
  if (!settings.load().welcomed) {
    settings.save({ welcomed: true });
    showSettings(); // the app asks about starting in the background on first open
  } else if (!process.argv.includes('--hidden') && !app.getLoginItemSettings().wasOpenedAtLogin) {
    showSettings();
  }
});

app.on('activate', () => showSettings());
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  gesture.stop();
  ctx.stop();
});
app.on('window-all-closed', (e) => {
  if (!quitting) e.preventDefault();
});
