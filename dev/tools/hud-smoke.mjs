// hud-smoke.mjs — construct the real HUD against a tiny DOM stub and walk the
// whole public surface without a browser. Run: node tools/hud-smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HUD } from '../src/hud.js';
import { STAGES } from '../src/track.js';

const TEXT_NODE = 3;

class ClassList {
  constructor() {
    this.set = new Set();
  }
  reset(value) {
    this.set = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }
  add(...names) {
    for (const name of names) if (name) this.set.add(String(name));
  }
  remove(...names) {
    for (const name of names) this.set.delete(String(name));
  }
  contains(name) {
    return this.set.has(String(name));
  }
  toggle(name, force) {
    const key = String(name);
    const on = force === undefined ? !this.set.has(key) : !!force;
    if (on) this.set.add(key);
    else this.set.delete(key);
    return on;
  }
  toString() {
    return [...this.set].join(' ');
  }
}

class Context2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = [];
    this.lineWidth = 1;
    this.strokeStyle = '#000';
    this.fillStyle = '#000';
    this.lineJoin = 'miter';
    this.lineCap = 'butt';
  }
  _record(name, args) {
    this.calls.push([name, ...args]);
  }
  clearRect(...a) { this._record('clearRect', a); }
  beginPath(...a) { this._record('beginPath', a); }
  moveTo(...a) { this._record('moveTo', a); }
  lineTo(...a) { this._record('lineTo', a); }
  stroke(...a) { this._record('stroke', a); }
  fill(...a) { this._record('fill', a); }
  arc(...a) { this._record('arc', a); }
  closePath(...a) { this._record('closePath', a); }
  fillRect(...a) { this._record('fillRect', a); }
  strokeRect(...a) { this._record('strokeRect', a); }
  save(...a) { this._record('save', a); }
  restore(...a) { this._record('restore', a); }
  translate(...a) { this._record('translate', a); }
  rotate(...a) { this._record('rotate', a); }
  setLineDash(...a) { this._record('setLineDash', a); }
}

class ElementStub {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.id = '';
    this.value = '';
    this.width = 0;
    this.height = 0;
    this.parentNode = null;
    this.children = [];
    this.childNodes = [];
    this.attributes = Object.create(null);
    this.dataset = Object.create(null);
    this.style = Object.create(null);
    this.classList = new ClassList();
    this.listeners = Object.create(null);
    this._text = '';
    this._ctx = null;
    if (this.tagName === 'CANVAS') this._ctx = new Context2D(this);
  }

  get className() {
    return this.classList.toString();
  }
  set className(value) {
    this.classList.reset(value);
  }

  setAttribute(name, value) {
    const key = String(name);
    const val = String(value);
    this.attributes[key] = val;
    if (key === 'id') this.id = val;
    else if (key === 'class') this.className = val;
    else if (key === 'width' && this.tagName === 'CANVAS') this.width = Number(val) || 0;
    else if (key === 'height' && this.tagName === 'CANVAS') this.height = Number(val) || 0;
    else if (key === 'value') this.value = val;
    if (key.startsWith('data-')) {
      const camel = key
        .slice(5)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = val;
    }
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  appendChild(child) {
    if (!child) throw new Error('appendChild(null)');
    if (child.nodeType === TEXT_NODE) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    this.childNodes.push(child);
    return child;
  }

  get textContent() {
    if (!this.childNodes.length) return this._text;
    return this.childNodes.map((child) => child.textContent || '').join('');
  }

  set textContent(value) {
    this._text = value === undefined || value === null ? '' : String(value);
    this.childNodes = [];
    this.children = [];
  }

  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners[type];
    if (!list) return;
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type, event = {}) {
    event.target = event.target || this;
    event.preventDefault = event.preventDefault || (() => {});
    for (const fn of this.listeners[type] || []) fn(event);
  }

  getContext(type) {
    if (type === '2d' && this.tagName === 'CANVAS') return this._ctx;
    return null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 320, height: 120, right: 320, bottom: 120 };
  }

  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {}

  matches(selector) {
    return matches(this, selector);
  }

  querySelector(selector) {
    return find(this, selector, true);
  }

  querySelectorAll(selector) {
    const out = [];
    find(this, selector, false, out);
    return out;
  }
}

function matches(el, selector) {
  const sel = String(selector).trim();
  let rest = sel;
  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest) {
    let m;
    if ((m = rest.match(/^#([\w-]+)/))) {
      if (el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if ((m = rest.match(/^\.([\w-]+)/))) {
      if (!el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if ((m = rest.match(/^\[\s*([\w-]+)\s*(?:=\s*["']?([^"'\]]*)["']?)?\s*\]/))) {
      if (!el.hasAttribute(m[1])) return false;
      if (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]) return false;
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function find(root, selector, first, out = []) {
  for (const child of root.children) {
    if (matches(child, selector)) {
      if (first) return child;
      out.push(child);
    }
    const nested = find(child, selector, first, out);
    if (first && nested) return nested;
  }
  return first ? null : out;
}

const body = new ElementStub('body');
const app = new ElementStub('div');
app.id = 'app';

const documentStub = {
  body,
  documentElement: new ElementStub('html'),
  getElementById(id) {
    if (id === 'app') return app;
    return find(app, `#${id}`, true);
  },
  createElement(tag) {
    return new ElementStub(tag);
  },
  createTextNode(text) {
    return {
      nodeType: TEXT_NODE,
      textContent: String(text),
      parentNode: null,
    };
  },
  querySelector(selector) {
    return matches(app, selector) ? app : find(app, selector, true);
  },
  querySelectorAll(selector) {
    const out = [];
    if (matches(app, selector)) out.push(app);
    find(app, selector, false, out);
    return out;
  },
  addEventListener() {},
  removeEventListener() {},
};

globalThis.document = documentStub;

function allElements(root, out = []) {
  for (const child of root.children) {
    out.push(child);
    allElements(child, out);
  }
  return out;
}

function assertContract(hud) {
  const requiredF = [
    'timer', 'delta', 'bar', 'dot', 'notewrap', 'note', 'notedist', 'arrow', 'speed',
    'gear', 'rpm', 'surface', 'map', 'stages', 'stage', 'stage-sub', 'dbg', 'fs',
    'bootbar', 'bootmsg', 'quality', 'vol', 'cam', 'tilt', 'tiltlive', 'fin-k', 'fin-h',
    'fin-sub', 'fin-time', 'fin-delta', 'fin-top', 'fin-avg',
  ];
  const nodeByAttr = (attr, value) => documentStub.querySelectorAll(`[${attr}${value === undefined ? '' : `="${value}"`}]`);
  for (const key of requiredF) {
    assert.ok(nodeByAttr('data-f', key).length >= 1, `missing data-f=${key}`);
  }

  const requiredActs = [
    'start', 'controls', 'close-controls', 'pause', 'reset', 'camera', 'fullscreen',
    'calibrate', 'invert', 'tiltcal-open', 'tiltcal', 'tiltcal-skip', 'rotate-anyway',
    'resume', 'restart', 'menu', 'retry', 'next',
  ];
  for (const act of requiredActs) {
    assert.ok(nodeByAttr('data-act', act).length >= 1, `missing data-act=${act}`);
  }
  for (const value of ['low', 'medium', 'high']) {
    assert.ok(nodeByAttr('data-q', value).length >= 1, `missing data-q=${value}`);
  }
  for (const value of ['0', '1', '2']) {
    assert.ok(nodeByAttr('data-c', value).length >= 1, `missing data-c=${value}`);
  }
  for (const value of ['0', '1']) {
    assert.ok(nodeByAttr('data-t', value).length >= 1, `missing data-t=${value}`);
  }
  for (const value of ['0', '1', '2']) {
    assert.ok(nodeByAttr('data-stage', value).length >= 1, `missing data-stage=${value}`);
  }

  assert.equal(documentStub.getElementById('hud'), hud.el.hud);
  assert.equal(hud.el.hud.id, 'hud');
  assert.equal(hud.touchRoot.id, 'touch');
  assert.ok(hud.touchRoot.querySelector('[data-touch="steer"]'), 'missing steering zone');
  for (const hold of ['gas', 'brake', 'hand']) {
    assert.ok(hud.touchRoot.querySelector(`[data-hold="${hold}"]`), `missing hold=${hold}`);
  }
  assert.ok(hud.el.map, 'missing minimap canvas');
  assert.equal(hud.el.map.width, 296);
  assert.equal(hud.el.map.height, 296);
  assert.ok(hud.mapCtx, 'missing 2d context');
  for (const key of ['hud', 'dbg', 'vol', 'fs', 'tiltcal', 'tiltlive']) {
    assert.ok(hud.el[key], `missing el.${key}`);
  }
  assert.equal(hud.screen, null);
  assert.equal(allElements(hud.el.hud).length > 80, true, 'HUD tree is unexpectedly small');
}

function run() {
  const hud = new HUD();
  assertContract(hud);

  // boot flow
  hud.setBoot(42.4, '正在加载测试…');
  assert.equal(hud.el.bootbar.style.width, '42.4%');
  assert.equal(hud.el.bootmsg.textContent, '正在加载测试…');
  hud.showBoot();
  assert.ok(hud.el.boot.classList.contains('on'));
  hud.hideBoot();
  assert.ok(!hud.el.boot.classList.contains('on'));

  // screen flow + body.racing
  hud.setScreen('title');
  assert.equal(hud.screen, 'title');
  assert.equal(documentStub.body.classList.contains('racing'), false);
  assert.ok(hud.screens.title.classList.contains('on'));
  assert.ok(!hud.screens.pause.classList.contains('on'));
  hud.setScreen(null);
  assert.equal(hud.screen, null);
  assert.equal(documentStub.body.classList.contains('racing'), true);
  assert.ok(!hud.screens.title.classList.contains('on'));
  assert.ok(hud.el.hud.classList.contains('screen-open') === false);

  // stage
  const stage = {
    name: '测试雪线',
    seed: 424242,
    theme: { key: 'snow', sub: 'TEST RALLY · 测试路面' },
    totalLength: 1000,
    samples: Array.from({ length: 16 }, (_, i) => ({
      x: Math.cos((i / 15) * Math.PI * 1.8) * 180,
      z: Math.sin((i / 15) * Math.PI * 1.8) * 120,
      yaw: (i / 15) * Math.PI * 1.8,
    })),
  };
  hud.setStage(stage, { time: 83450 });
  assert.equal(hud.el.stage.textContent, '测试雪线');
  assert.equal(hud.el.stageSub.textContent, 'TEST RALLY · 测试路面');
  assert.equal(hud.el.stageLength.textContent, '1.00 KM');
  assert.equal(hud.el.stageBest.textContent, '01:23.45');
  assert.equal(hud.el.surface.textContent, '压实雪');
  assert.equal(hud.el.raceStage.textContent, '测试雪线');
  assert.equal(hud.best.time, 83450);
  assert.ok(hud._map && hud._map.points.length === 16, 'minimap geometry not built');
  assert.ok(hud.el.map._ctx.calls.some((call) => call[0] === 'moveTo'), 'minimap never painted');

  // stage list selection + bests
  hud.renderStageList(1, { [STAGES[1].seed]: { time: 99000 } });
  const cards = documentStub.querySelectorAll('[data-stage]');
  assert.equal(cards.length, 3);
  assert.ok(cards[1].classList.contains('picked'));
  assert.ok(!cards[0].classList.contains('picked'));
  assert.equal(cards[1].querySelector('.card-best').textContent, 'PB 01:39.00');

  // race update, pace note, map car marker
  hud._lastMapPaint = -Infinity;
  hud.update({
    time: 75432,
    delta: -1200,
    speed: 16.7,
    rpm: 5400,
    gear: 3,
    surface: '压实雪',
    note: { dir: -1, sev: 0, s0: 500, s1: 540, radius: 9 },
    noteDist: 87.2,
    progress: 0.42,
    running: true,
    car: { pos: { x: 10, y: 30, z: -20 }, yaw: 0.7, vx: 12, vz: 4 },
  });
  assert.equal(hud.el.timer.textContent, '01:15.43');
  assert.equal(hud._timerMain.textContent, '01:15');
  assert.equal(hud._timerMs.textContent, '.43');
  assert.equal(hud.el.delta.textContent, '-0:01.200');
  assert.ok(hud.el.delta.classList.contains('fast'));
  assert.equal(hud.el.speed.textContent, '60');
  assert.equal(hud.el.gear.textContent, '3');
  assert.equal(hud.el.bar.style.width, '42.00%');
  assert.equal(hud.el.dot.style.left, '42.00%');
  assert.equal(hud.el.rpm.style.width, '66.67%');
  assert.equal(hud.el.surface.textContent, '压实雪');
  assert.ok(hud.el.notewrap.classList.contains('on'));
  assert.ok(hud.el.notewrap.classList.contains('note-hairpin'));
  assert.ok(hud.el.notewrap.classList.contains('sev-warn'));
  assert.ok(hud.el.note.classList.contains('note-hairpin'));
  assert.equal(hud.el.note.textContent, 'R 发卡弯');
  assert.equal(hud.el.notedist.textContent, '87');
  assert.ok(hud.el.arrow.classList.contains('flip'));
  assert.ok(hud.el.map._ctx.calls.some((call) => call[0] === 'arc'), 'car marker not drawn');

  // no-reference idle delta + no note
  hud.update({
    time: 76000,
    delta: null,
    speed: 0,
    rpm: 800,
    gear: 0,
    surface: null,
    note: null,
    noteDist: 0,
    progress: 0,
    running: true,
  });
  assert.equal(hud.el.delta.textContent, '无参考圈');
  assert.ok(hud.el.delta.classList.contains('idle'));
  assert.ok(!hud.el.notewrap.classList.contains('on'));
  assert.equal(hud.el.gear.textContent, 'N');
  assert.equal(hud.el.rpm.style.width, '0.00%');

  // countdown
  hud.countdown('3');
  assert.ok(hud.el.countdown.classList.contains('on'));
  assert.equal(hud.el.countdown.textContent, '3');
  hud.countdown('GO', true);
  assert.ok(hud.el.countdown.classList.contains('go'));
  hud.countdown('');
  assert.ok(!hud.el.countdown.classList.contains('on'));

  // toast
  hud.toast('测试提示', 20);
  assert.ok(hud.el.toast.classList.contains('on'));
  assert.equal(hud.el.toast.textContent, '测试提示');

  // finish
  hud.showFinish({
    stage,
    time: 81234,
    prevBest: 83450,
    topSpeed: 44.4,
    newBest: true,
  });
  assert.equal(hud.screen, 'finish');
  assert.ok(hud.screens.finish.classList.contains('on'));
  assert.equal(documentStub.body.classList.contains('racing'), false);
  assert.equal(hud.el.finK.textContent, 'NEW BEST');
  assert.equal(hud.el.finH.textContent, '刷新赛段纪录');
  assert.equal(hud.el.finTime.textContent, '01:21.23');
  assert.ok(hud.el.finDelta.classList.contains('fast'));
  assert.equal(hud.el.finDelta.textContent, '-0:02.216');
  assert.equal(hud.el.finTop.textContent, '160 km/h');
  assert.equal(hud.el.finAvg.textContent, '44 km/h');
  assert.ok(hud.el.finish.classList.contains('new-best'));

  // settings sync
  hud.setQualityUI('high');
  assert.ok(hud._qButtons.find((r) => r.value === 'high').node.classList.contains('picked'));
  assert.equal(hud._qButtons.find((r) => r.value === 'high').node.getAttribute('aria-pressed'), 'true');
  assert.equal(hud._qButtons.find((r) => r.value === 'low').node.getAttribute('aria-pressed'), 'false');
  hud.setCameraUI(2);
  assert.equal(hud._cButtons.find((r) => r.value === '2').node.getAttribute('aria-pressed'), 'true');
  hud.setTiltUI(true);
  assert.equal(hud._tButtons.find((r) => r.value === '1').node.getAttribute('aria-pressed'), 'true');
  hud.setTiltUI(false);
  assert.equal(hud._tButtons.find((r) => r.value === '0').node.getAttribute('aria-pressed'), 'true');

  // actions and choices route through the public callbacks
  const fired = [];
  hud.onAction = (act) => fired.push(act);
  hud.onStage = (i) => fired.push(`stage:${i}`);
  hud.onQuality = (q) => fired.push(`q:${q}`);
  hud.onCamera = (c) => fired.push(`c:${c}`);
  hud.onTilt = (v) => fired.push(`t:${v}`);
  documentStub.querySelector('[data-act="start"]').dispatch('click');
  documentStub.querySelector('[data-act="close-controls"]').dispatch('click');
  documentStub.querySelector('[data-stage="2"]').dispatch('click');
  documentStub.querySelector('[data-q="low"]').dispatch('click');
  documentStub.querySelector('[data-c="1"]').dispatch('click');
  documentStub.querySelector('[data-t="1"]').dispatch('click');
  assert.deepEqual(fired, [
    'start', 'close-controls', 'stage:2', 'q:low', 'c:1', 't:true',
  ]);

  // input.js expectations on the touch layer
  const steer = hud.touchRoot.querySelector('[data-touch="steer"]');
  assert.ok(steer, 'steer zone gone');
  assert.equal(hud.touchRoot.querySelectorAll('[data-hold]').length, 3);

  // Every class emitted by the module should have a stylesheet rule (state
  // classes are toggled at runtime and live in the second set).
  const runtimeStates = new Set([
    'on', 'go', 'fast', 'slow', 'flat', 'even', 'idle', 'picked', 'has-time', 'new-best',
    'is-on', 'flip', 'bad', 'screen-open', 'note-hairpin', 'sev-warn', 'sev-mid',
    'sev-calm', 'racing', 'touch', 'no-rotate-hint',
  ]);
  const used = new Set();
  for (const el of allElements(hud.el.hud)) {
    for (const cls of el.classList.set) used.add(cls);
  }
  const cssText = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const styled = new Set([...cssText.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
  const uncovered = [...used].filter((cls) => !styled.has(cls) && !runtimeStates.has(cls));
  assert.deepEqual(uncovered, [], 'classes without CSS rules: ' + uncovered.join(', '));

  // Reverse check: every authored selector class should still exist in the
  // live tree or be a runtime state. Catches stale class names after renames.
  const stale = [...styled].filter((cls) => !used.has(cls) && !runtimeStates.has(cls));
  assert.deepEqual(stale, [], 'CSS selectors with no matching class: ' + stale.join(', '));

  console.log('HUD smoke OK');
  console.log(`  DOM nodes: ${allElements(hud.el.hud).length}`);
  console.log(`  map draw calls: ${hud.el.map._ctx.calls.length}`);
  console.log(`  required data-f: 31, data-act: 18, stage cards: 3`);
}

run();
