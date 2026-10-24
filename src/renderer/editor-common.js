// Helpers shared by the editors: the file being edited, accent, toasts, busy overlay.
window.editorKit = (() => {
  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  const name = file.split(/[\\/]/).pop();

  document.title = `${name} · Wedge`;

  async function applyLook() {
    const s = await wedge.getSettings();
    const root = document.documentElement.style;
    root.setProperty('--accent', s.accent);
    root.setProperty('--accent-strong', `color-mix(in srgb, ${s.accent} 80%, #000)`);
    root.setProperty('--accent-soft', `color-mix(in srgb, ${s.accent} 15%, transparent)`);
    document.body.classList.toggle('mac', (await wedge.info()).platform === 'darwin');
  }

  let toastTimer;
  function toast(message, { error = false, reveal = null } = {}) {
    const el = document.getElementById('toast');
    el.textContent = '';
    el.className = `toast show${error ? ' error' : ''}`;
    el.append(message);
    if (reveal) {
      const b = document.createElement('button');
      b.textContent = 'Show in folder';
      b.onclick = () => wedge.edit.reveal(reveal);
      el.append(b);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), error ? 6000 : 4500);
  }

  function busy(label, progress) {
    const el = document.getElementById('busy');
    if (label === null) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.querySelector('b').textContent = label;
    el.querySelector('.bar i').style.width = `${Math.round((progress || 0) * 100)}%`;
  }

  const basename = (p) => p.split(/[\\/]/).pop();
  const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  return { file, name, applyLook, toast, busy, basename, cleanError };
})();
