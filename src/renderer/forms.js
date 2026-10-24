// Builds an options form from a catalog op's option schema.
window.buildForm = function buildForm(options, saved = {}) {
  const form = document.createElement('form');
  const values = {};
  const rows = [];

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const c of children) n.append(c);
    return n;
  };

  for (const o of options) {
    const initial = saved[o.key] !== undefined ? saved[o.key] : o.default;
    values[o.key] = initial;
    let control;
    if (o.type === 'select') {
      control = el('select', { class: 'input', name: o.key });
      for (const [v, label] of o.options) {
        const opt = el('option', { value: v, text: label });
        if (String(v) === String(initial)) opt.selected = true;
        control.append(opt);
      }
    } else if (o.type === 'range') {
      const input = el('input', { type: 'range', name: o.key, min: o.min, max: o.max, step: o.step || 1 });
      input.value = initial;
      const out = el('output', { text: initial });
      input.addEventListener('input', () => (out.textContent = input.value));
      control = el('div', { class: 'range-row' }, [input, out]);
    } else {
      const type = { number: 'number', color: 'color', password: 'password' }[o.type] || 'text';
      control = el('input', { class: 'input', type, name: o.key, autocomplete: 'off', spellcheck: 'false' });
      if (o.min !== undefined) control.min = o.min;
      if (o.step !== undefined) control.step = o.step;
      if (o.hint && type !== 'color') control.placeholder = o.hint;
      control.value = initial ?? '';
    }
    const label = el('label', { class: 'field' }, [el('span', { text: o.label }), control]);
    if (o.hint && o.type !== 'text' && o.type !== 'number') label.append(el('small', { text: o.hint }));
    rows.push({ o, label });
    form.append(label);
  }

  const read = () => {
    const data = {};
    for (const { o } of rows) {
      const input = form.elements[o.key];
      if (input) data[o.key] = input.value;
    }
    return data;
  };

  const refresh = () => {
    const data = read();
    for (const { o, label } of rows) {
      label.hidden = !!o.showIf && !Object.entries(o.showIf).every(([k, v]) => String(data[k]) === String(v));
    }
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  refresh();

  return { form, read };
};
