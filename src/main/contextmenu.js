// Explorer right-click entries on Windows, registered per user (no admin):
//   "Convert with Wedge" on every file and folder -> opens the wheel there
//   "Edit with Wedge" on images, video, audio and PDFs -> opens the editor
// On Windows 11 these appear under "Show more options" (Shift+F10); the compact
// menu only lists apps installed from an MSIX package.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { run } = require('./util');

const ROOT = 'HKCU\\Software\\Classes';
const CONVERT_KEYS = [`${ROOT}\\*\\shell\\Wedge`, `${ROOT}\\Directory\\shell\\Wedge`];
// Explorer groups file types; each editor covers some of them.
const EDIT_TYPES = { image: ['image'], media: ['video', 'audio'], pdf: ['.pdf'] };
const editKey = (t) => `${ROOT}\\SystemFileAssociations\\${t}\\shell\\WedgeEdit`;
const EDIT_KEYS = Object.values(EDIT_TYPES).flat().map(editKey);

function launchCommand(flag) {
  const appArg = app.isPackaged ? '' : ` "${app.getAppPath()}"`;
  return `"${process.execPath}"${appArg} ${flag} "%1"`;
}

// The packaged exe carries the icon; in development point at the .ico file.
function iconRef() {
  if (app.isPackaged) return `"${process.execPath}",0`;
  const ico = path.join(__dirname, '..', '..', 'build', 'icon.ico');
  return fs.existsSync(ico) ? ico : `"${process.execPath}",0`;
}

const reg = (...args) => run('reg.exe', args);

async function addEntry(key, label, command) {
  await reg('add', key, '/ve', '/d', label, '/f');
  await reg('add', key, '/v', 'Icon', '/d', iconRef(), '/f');
  await reg('add', `${key}\\command`, '/ve', '/d', command, '/f');
}

// editors: which editors are installed ('image', 'media', 'pdf').
async function install(editors = Object.keys(EDIT_TYPES)) {
  if (process.platform !== 'win32') return false;
  for (const key of CONVERT_KEYS) await addEntry(key, 'Convert with Wedge', launchCommand('--wheel'));
  for (const [kind, types] of Object.entries(EDIT_TYPES)) {
    for (const t of types) {
      if (editors.includes(kind)) await addEntry(editKey(t), 'Edit with Wedge', launchCommand('--edit'));
      else await reg('delete', editKey(t), '/f').catch(() => {});
    }
  }
  return true;
}

async function uninstall() {
  if (process.platform !== 'win32') return false;
  for (const key of [...CONVERT_KEYS, ...EDIT_KEYS]) {
    try {
      await reg('delete', key, '/f');
    } catch {
      // Already gone.
    }
  }
  return true;
}

async function apply(enabled, editors) {
  try {
    return enabled ? await install(editors) : await uninstall();
  } catch (err) {
    console.error('Context menu update failed:', err.message);
    return false;
  }
}

module.exports = { apply, install, uninstall, CONVERT_KEYS, EDIT_KEYS };
