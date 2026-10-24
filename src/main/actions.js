// File actions: clipboard, copy/move, reveal, terminal and sharing.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { clipboard, dialog, shell } = require('electron');
const { uniquePath, run } = require('./util');

function folderOf(p) {
  try {
    return fs.statSync(p).isDirectory() ? p : path.dirname(p);
  } catch {
    return path.dirname(p);
  }
}

function detached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function copyFilesToClipboard(paths) {
  if (process.platform === 'win32') {
    const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath ${list}`]);
  } else if (process.platform === 'darwin') {
    const script = `ObjC.import('AppKit');
      const pb = $.NSPasteboard.generalPasteboard; pb.clearContents;
      const urls = ${JSON.stringify(paths)}.map(p => $.NSURL.fileURLWithPath(p));
      pb.writeObjects($(urls));`;
    await run('osascript', ['-l', 'JavaScript', '-e', script]);
  } else {
    const uris = paths.map((p) => 'file://' + encodeURI(p));
    clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(['copy', ...uris].join('\n')));
    clipboard.writeBuffer('text/uri-list', Buffer.from(uris.join('\r\n')));
  }
}

async function pickFolder(win, title) {
  const res = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
}

async function copyOrMove(paths, dest, move) {
  const outs = [];
  for (const p of paths) {
    const target = uniquePath(path.join(dest, path.basename(p)));
    if (move) {
      try {
        await fsp.rename(p, target);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        // Different drive: copy, then remove the original.
        await fsp.cp(p, target, { recursive: true });
        await fsp.rm(p, { recursive: true });
      }
    } else {
      await fsp.cp(p, target, { recursive: true });
    }
    outs.push(target);
  }
  return outs;
}

async function openTerminal(dir) {
  if (process.platform === 'win32') {
    try {
      await detached('wt.exe', ['-d', dir]);
    } catch {
      await detached('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit'], { cwd: dir });
    }
  } else if (process.platform === 'darwin') {
    const iterm = fs.existsSync('/Applications/iTerm.app');
    await detached('open', ['-a', iterm ? 'iTerm' : 'Terminal', dir]);
  } else {
    const candidates = [
      ['x-terminal-emulator', []],
      ['gnome-terminal', [`--working-directory=${dir}`]],
      ['konsole', ['--workdir', dir]],
      ['xfce4-terminal', [`--working-directory=${dir}`]],
      ['kitty', ['--directory', dir]],
      ['alacritty', ['--working-directory', dir]],
      ['xterm', []],
    ];
    for (const [cmd, args] of candidates) {
      try {
        await detached(cmd, args, { cwd: dir });
        return;
      } catch {}
    }
    throw new Error('No terminal emulator found');
  }
}

// Returns a short message describing what happened, or null if cancelled.
async function perform(id, paths, { win, float } = {}) {
  switch (id) {
    case 'action:float':
      float(paths);
      return `Floating ${paths.length} item${paths.length > 1 ? 's' : ''}`;
    case 'action:copy':
      await copyFilesToClipboard(paths);
      return 'Copied to clipboard';
    case 'action:path':
      clipboard.writeText(paths.join('\n'));
      return paths.length > 1 ? `Copied ${paths.length} paths` : 'Copied path';
    case 'action:copyto':
    case 'action:move': {
      const move = id === 'action:move';
      const dest = await pickFolder(win, move ? 'Move to…' : 'Copy to…');
      if (!dest) return null;
      const outs = await copyOrMove(paths, dest, move);
      shell.showItemInFolder(outs[0]);
      return `${move ? 'Moved' : 'Copied'} to ${path.basename(dest)}`;
    }
    case 'action:terminal':
      await openTerminal(folderOf(paths[0]));
      return 'Opened terminal';
    case 'action:reveal':
      shell.showItemInFolder(paths[0]);
      return null;
    case 'action:share': {
      const { ShareMenu } = require('electron');
      new ShareMenu({ filePaths: paths }).popup({ window: win });
      return null;
    }
    default:
      throw new Error(`Unknown action ${id}`);
  }
}

module.exports = { perform, openTerminal, copyFilesToClipboard };
