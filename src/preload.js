// The only bridge between the renderer pages and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('wedge', {
  pathFor: (file) => webUtils.getPathForFile(file),
  forMimes: (mimes) => ipcRenderer.invoke('catalog:forMimes', mimes),
  forFiles: (files) => ipcRenderer.invoke('catalog:forFiles', files),
  formats: () => ipcRenderer.invoke('catalog:formats'),
  actions: () => ipcRenderer.invoke('catalog:actions'),
  extensions: () => ipcRenderer.invoke('catalog:extensions'),
  run: (opId, files, options) => ipcRenderer.invoke('run', { opId, files, options }),
  wheel: {
    ready: (id) => ipcRenderer.send('wheel:ready', id),
    state: (id, state) => ipcRenderer.send('wheel:state', { id, state }),
    hidden: (id) => ipcRenderer.send('wheel:hidden', id),
    dismiss: () => ipcRenderer.send('wheel:dismiss'),
    focus: () => ipcRenderer.send('wheel:focus'),
    expand: () => ipcRenderer.send('wheel:expand'),
  },
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  defaults: () => ipcRenderer.invoke('settings:defaults'),
  recording: (on) => ipcRenderer.send('recording', on),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  promptAccessibility: () => ipcRenderer.invoke('accessibility:prompt'),
  info: () => ipcRenderer.invoke('info'),
  recent: () => ipcRenderer.invoke('recent'),
  fileIcon: (p) => ipcRenderer.invoke('fileIcon', p),
  edit: {
    open: (kind, file) => ipcRenderer.invoke('edit:open', kind, file),
    pick: (kind) => ipcRenderer.invoke('edit:pick', kind),
    reveal: (p) => ipcRenderer.invoke('reveal', p),
    loadImage: (file) => ipcRenderer.invoke('edit:image:load', file),
    saveImage: (file, dataUrl, format) => ipcRenderer.invoke('edit:image:save', file, dataUrl, format),
    mediaInfo: (file) => ipcRenderer.invoke('edit:media:info', file),
    previewProxy: (file) => ipcRenderer.invoke('edit:media:proxy', file),
    waveform: (file) => ipcRenderer.invoke('edit:media:waveform', file),
    exportMedia: (file, opts) => ipcRenderer.invoke('edit:media:export', file, opts),
    snapshot: (file, time) => ipcRenderer.invoke('edit:media:snapshot', file, time),
    pdfInfo: (file) => ipcRenderer.invoke('edit:pdf:info', file),
    pdfThumb: (file, index, width) => ipcRenderer.invoke('edit:pdf:thumb', file, index, width),
    pdfRender: (file, index, scale, rotate) => ipcRenderer.invoke('edit:pdf:render', file, index, scale, rotate),
    savePdf: (file, pages, suffix) => ipcRenderer.invoke('edit:pdf:save', file, pages, suffix),
  },
  shelf: {
    list: () => ipcRenderer.invoke('shelf:list'),
    add: (paths) => ipcRenderer.invoke('shelf:add', paths),
    remove: (p) => ipcRenderer.invoke('shelf:remove', p),
    clear: () => ipcRenderer.invoke('shelf:clear'),
    startDrag: (paths) => ipcRenderer.send('shelf:startDrag', paths),
  },
  on: {
    wheelShow: on('wheel:show'),
    wheelEnter: on('wheel:enter'),
    wheelThumb: on('wheel:thumb'),
    wheelChoose: on('wheel:choose'),
    wheelDismiss: on('wheel:dismiss'),
    wheelMode: on('wheel:mode'),
    wheelRelease: on('wheel:release'),
    wheelBlur: on('wheel:blur'),
    jobUpdate: on('jobs:update'),
    settingsChanged: on('settings:changed'),
    settingsSection: on('settings:section'),
    shelfItems: on('shelf:items'),
    editProgress: on('edit:progress'),
    recentChanged: on('recent:changed'),
  },
});
