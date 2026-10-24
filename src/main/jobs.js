// Runs catalog operations, tracking progress and history for the UI.
const { EventEmitter } = require('events');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const catalog = require('./catalog');
const { withOutputDir } = require('./util');

class Jobs extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.history = [];
    this.nextId = 1;
    this.askWhereToSave = null; // (job, stagedOutputs) => final paths, or null if cancelled
  }

  async run(opId, files, options = {}) {
    const op = catalog.get(opId);
    if (!op || op.action) throw new Error(`Unknown operation ${opId}`);
    const job = {
      id: this.nextId++,
      opId,
      label: op.label,
      files,
      names: files.map((f) => path.basename(f)),
      status: 'running',
      progress: 0,
      outputs: [],
      errors: [],
      started: Date.now(),
    };
    this.history.unshift(job);
    this.history = this.history.slice(0, 200);
    const update = () => this.emit('update', snapshot(job));
    update();

    let lastEmit = 0;
    const ctxFor = (i, n) => ({
      settings: this.getSettings(),
      progress: (p) => {
        job.progress = (i + Math.max(0, Math.min(1, p))) / n;
        if (Date.now() - lastEmit > 150) { lastEmit = Date.now(); update(); }
      },
    });

    // "Ask where to save": write into a private folder first, then let the user pick.
    const ask = this.getSettings().outputMode === 'ask' && this.askWhereToSave;
    const stage = ask ? await fsp.mkdtemp(path.join(os.tmpdir(), 'wedge-save-')) : null;
    const inStage = (fn) => (stage ? withOutputDir(stage, fn) : fn());

    if (op.multi) {
      try {
        job.outputs = await inStage(() => op.run(files, options, ctxFor(0, 1)));
      } catch (err) {
        job.errors.push({ file: '', message: err.message });
      }
    } else {
      for (let i = 0; i < files.length; i++) {
        try {
          job.outputs.push(...(await inStage(() => op.run(files[i], options, ctxFor(i, files.length)))));
        } catch (err) {
          console.error(err);
          job.errors.push({ file: path.basename(files[i]), message: err.message });
        }
        job.progress = (i + 1) / files.length;
        update();
      }
    }
    if (stage) {
      if (job.outputs.length) {
        const saved = await this.askWhereToSave(snapshot(job), job.outputs).catch((err) => {
          job.errors.push({ file: '', message: err.message });
          return null;
        });
        if (saved) job.outputs = saved;
        else {
          job.outputs = [];
          if (!job.errors.length) job.errors.push({ file: '', message: 'Not saved' });
        }
      }
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
    job.progress = 1;
    job.finished = Date.now();
    job.status = job.errors.length ? (job.outputs.length ? 'partial' : 'failed') : 'done';
    update();
    this.emit('finished', snapshot(job));
    return snapshot(job);
  }
}

function snapshot(job) {
  return { ...job, files: [...job.files], outputs: [...job.outputs], errors: [...job.errors] };
}

module.exports = { Jobs };
