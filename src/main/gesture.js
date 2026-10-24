// Detects "hold the trigger keys and press on a file" system-wide using a
// global input hook. The trigger is any recorded combination: modifiers
// (shift/ctrl/alt/meta) plus at most one other key. Emits:
//   press()          - mouse pressed while the whole combination is held
//   drag()           - that press started moving (a drag)
//   release()        - that press turned into a drag and was released
//   click()          - that press was released without dragging
//   outside(point)   - any other mouse press while the wheel is open
//   mode(mode)       - a mode key was tapped while the wheel is open
//   escape()         - Esc while the wheel is open
const { EventEmitter } = require('events');

const DRAG_THRESHOLD = 6; // px of movement before a press counts as a drag
const MOUSE_DRAGGED = 10; // libuiohook's EVENT_MOUSE_DRAGGED, only surfaced via 'input'
const MOUSE_MOVED = 9;
const MODIFIERS = ['shift', 'ctrl', 'alt', 'meta'];
const MODIFIER_FLAG = { shift: 'shiftKey', ctrl: 'ctrlKey', alt: 'altKey', meta: 'metaKey' };

class Gesture extends EventEmitter {
  constructor() {
    super();
    this.hook = null;
    this.pressing = false;
    this.dragging = false;
    this.origin = null;
    this.heldMods = new Set();
    this.heldCodes = new Set();
    this.trigger = { mods: ['ctrl', 'alt'], key: null };
    this.modeKeys = {};
    this.wheelOpen = false;
    this.error = null;
  }

  configure({ trigger, modeKeys }) {
    this.trigger = trigger;
    this.modeKeys = modeKeys || {};
  }

  // True when every key of the combination is down right now.
  triggerHeld(e) {
    const { mods = [], key } = this.trigger || {};
    if (!mods.length && !key) return false;
    for (const m of mods) if (!e[MODIFIER_FLAG[m]] && !this.heldMods.has(m)) return false;
    if (key) {
      const code = this.K?.[key];
      if (code === undefined || !this.heldCodes.has(code)) return false;
    }
    return true;
  }

  start() {
    if (this.hook) return true;
    try {
      const { uIOhook, UiohookKey: K } = require('uiohook-napi');
      this.K = K;
      this.modCodes = {
        shift: [K.Shift, K.ShiftRight],
        ctrl: [K.Ctrl, K.CtrlRight],
        alt: [K.Alt, K.AltRight],
        meta: [K.Meta, K.MetaRight],
      };
      uIOhook.on('mousedown', (e) => {
        if (e.button === 1 && this.triggerHeld(e)) {
          this.pressing = true;
          this.dragging = false;
          this.origin = { x: e.x, y: e.y };
          this.emit('press');
        } else if (this.wheelOpen) {
          this.emit('outside', { x: e.x, y: e.y, button: e.button });
        }
      });
      uIOhook.on('mouseup', (e) => {
        if (e.button !== 1 || !this.pressing) return;
        this.pressing = false;
        this.emit(this.dragging ? 'release' : 'click');
        this.dragging = false;
      });
      uIOhook.on('input', (e) => {
        if ((e.type !== MOUSE_DRAGGED && e.type !== MOUSE_MOVED) || !this.pressing || this.dragging) return;
        if (Math.hypot(e.x - this.origin.x, e.y - this.origin.y) > DRAG_THRESHOLD) {
          this.dragging = true;
          this.emit('drag');
        }
      });
      uIOhook.on('keydown', (e) => {
        if (e.keycode === K.Escape && this.wheelOpen) return this.emit('escape');
        const mod = this.modName(e.keycode);
        const repeat = mod ? this.heldMods.has(mod) : this.heldCodes.has(e.keycode);
        if (mod) this.heldMods.add(mod);
        else this.heldCodes.add(e.keycode);
        if (repeat || !mod || !this.wheelOpen || this.pressing) return;
        const mode = Object.keys(this.modeKeys).find((m) => this.modeKeys[m] === mod);
        if (mode) this.emit('mode', mode);
      });
      uIOhook.on('keyup', (e) => {
        const mod = this.modName(e.keycode);
        if (mod) this.heldMods.delete(mod);
        else this.heldCodes.delete(e.keycode);
      });
      uIOhook.start();
      this.hook = uIOhook;
      this.error = null;
      return true;
    } catch (err) {
      this.error = err.message;
      console.error('Global gesture unavailable:', err);
      return false;
    }
  }

  modName(code) {
    return MODIFIERS.find((n) => this.modCodes[n].includes(code));
  }

  stop() {
    if (!this.hook) return;
    try {
      this.hook.stop();
    } catch {}
    this.hook.removeAllListeners();
    this.hook = null;
    this.heldMods.clear();
    this.heldCodes.clear();
  }
}

module.exports = { Gesture, MODIFIERS };
