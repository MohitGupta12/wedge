// Answers two questions about whatever is under the cursor:
//   probe()        - is it a file manager (Explorer, desktop, Finder, Nautilus…)?
//   focused(info)  - which file did the user just click there?
// Windows uses a long-lived native helper (Win32 + Shell COM + UI Automation), macOS uses
// lsappinfo/AppleScript, and Linux uses xdotool/xprop when they're installed.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, unpacked } = require('./util');

const WIN_FILE_MANAGERS = new Set(['CabinetWClass', 'ExploreWClass', 'Progman', 'WorkerW']);
const MAC_FILE_MANAGERS = ['com.apple.finder', 'com.binarynights.ForkLift', 'com.cocoatech.PathFinder'];
const LINUX_FILE_MANAGERS = ['nautilus', 'org.gnome.nautilus', 'dolphin', 'thunar', 'nemo', 'nemo-desktop', 'pcmanfm', 'pcmanfm-qt', 'caja', 'xfdesktop', 'gjs', 'spacefm', 'konqueror'];

class WindowsShell {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.ready = null;
  }

  start() {
    if (this.proc) return this.ready;
    // The native helper needs a few MB; the PowerShell version (same protocol) ~100 MB.
    const exe = unpacked(path.join(__dirname, 'native', 'wedge-helper.exe'));
    if (fs.existsSync(exe)) {
      this.proc = spawn(exe, [], { windowsHide: true });
    } else {
      const script = unpacked(path.join(__dirname, 'native', 'win-shell.ps1'));
      this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    }
    this.proc.stdout.setEncoding('utf8');
    this.ready = new Promise((resolve) => {
      this.proc.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).replace(/\r$/, '');
          this.buffer = this.buffer.slice(nl + 1);
          if (line === 'ready') {
            resolve(true);
            this.request('probe'); // warm up UI Automation so the first real press is fast
            continue;
          }
          const tab = line.indexOf('\t');
          const id = Number(line.slice(0, tab));
          const done = this.pending.get(id);
          if (done) { this.pending.delete(id); done(line.slice(tab + 1)); }
        }
      });
    });
    this.proc.on('exit', () => {
      this.proc = null;
      for (const done of this.pending.values()) done('');
      this.pending.clear();
    });
    this.proc.on('error', () => (this.proc = null));
    return this.ready;
  }

  request(...args) {
    if (!this.proc) this.start();
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); resolve(''); }, 1500);
      this.pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
      this.proc.stdin.write(`${[id, ...args].map((a) => String(a).replace(/[\t\n]/g, ' ')).join('\t')}\n`);
    });
  }

  async probe() {
    const [hwnd, cls, proc, title, x, y, item] = (await this.request('probe')).split('\t');
    // The physical cursor position stays exact on mixed-DPI multi-monitor setups.
    const cursor = x ? { x: Number(x), y: Number(y), physical: true } : null;
    const fileManager = WIN_FILE_MANAGERS.has(cls) && /^explorer$/i.test(proc || '');
    return { fileManager, onItem: fileManager ? !!item : null, item: item || '', hwnd, cls, title, cursor };
  }

  // The focused item only counts once it matches the item under the cursor;
  // Explorer can take a moment to move focus to the item that was pressed.
  async focused(info) {
    if (!info?.hwnd) return [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const [name, p] = (await this.request('focused', info.hwnd, info.cls, info.title || '')).split('\t');
      if (p && (!info.item || name === info.item)) return [p];
      await new Promise((r) => setTimeout(r, 60));
    }
    return [];
  }

  async selected(info) {
    if (!info?.hwnd) return [];
    return (await this.request('selected', info.hwnd, info.cls, info.title || '')).split('\t').filter(Boolean);
  }

  // Leaves only the focused item selected.
  async selectOnly(info) {
    if (info?.hwnd) await this.request('only', info.hwnd, info.cls, info.title || '');
  }

  async alive(info) {
    if (!info?.hwnd) return true;
    return (await this.request('alive', info.hwnd)) !== 'False';
  }

  stop() {
    this.proc?.kill();
  }
}

const mac = {
  start() {},
  async probe() {
    try {
      const out = await run('/bin/sh', ['-c', 'lsappinfo info -only bundleid "$(lsappinfo front)"']);
      return { fileManager: MAC_FILE_MANAGERS.some((id) => out.includes(id)) };
    } catch {
      return { fileManager: null };
    }
  },
  // Finder doesn't expose a focused item; the last selected one is the pressed file.
  async focused() {
    return (await mac.selected()).slice(-1);
  },
  async selected() {
    const script = 'tell application "Finder" to set s to selection\nset out to ""\nrepeat with f in s\nset out to out & POSIX path of (f as alias) & linefeed\nend repeat\nreturn out';
    try {
      return (await run('osascript', ['-e', script])).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  },
  async alive() {
    return true;
  },
  stop() {},
};

const linux = {
  start() {},
  async probe() {
    try {
      const loc = await run('xdotool', ['getmouselocation', '--shell']);
      const win = /WINDOW=(\d+)/.exec(loc)?.[1];
      if (!win) return { fileManager: null };
      const cls = (await run('xprop', ['-id', win, 'WM_CLASS'])).toLowerCase();
      return { fileManager: LINUX_FILE_MANAGERS.some((n) => cls.includes(`"${n}"`)) };
    } catch {
      return { fileManager: null }; // xdotool/xprop missing or Wayland: can't tell
    }
  },
  async focused() {
    return []; // Linux file managers don't expose their selection; dragging still works
  },
  async selected() {
    return [];
  },
  async alive() {
    return true;
  },
  stop() {},
};

function create() {
  if (process.platform === 'win32') return new WindowsShell();
  if (process.platform === 'darwin') return mac;
  return linux;
}

module.exports = { create };
