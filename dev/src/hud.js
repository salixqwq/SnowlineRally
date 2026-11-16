// hud.js — rally interface: start board, timing tower, roadbook, touch deck.
// Rebuilt from scratch against the runtime contract in main.js / input.js.
import { clamp, fmtClock, fmtTime } from './math.js';
import { noteLabel, STAGES, THEMES } from './track.js';

const MAP_SIDE = 296;
const RAD = Math.PI * 2;

const SURFACE_NAME = {
  snow: '压实雪',
  dusk: '砂石',
  mist: '湿滑柏油',
};

const QUALITY_LIST = ['low', 'medium', 'high'];
const CAMERA_LIST = [0, 1, 2];

// Tiny DOM builder. Keeping this local means the module has no template-string
// parsing step and every node receives its attributes in one place.
function node(tag, cls, attrs, content) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  // Allow the convenient three-argument form node(tag, class, children).
  if (content === undefined && attrs !== null && attrs !== undefined
    && (Array.isArray(attrs) || typeof attrs === 'string' || typeof attrs === 'number')) {
    content = attrs;
    attrs = null;
  }
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === undefined || value === null) continue;
      el.setAttribute(key, String(value));
    }
  }
  if (content !== undefined && content !== null) {
    const list = Array.isArray(content) ? content : [content];
    for (const item of list) {
      if (item === undefined || item === null || item === false) continue;
      el.appendChild(typeof item === 'string' || typeof item === 'number'
        ? document.createTextNode(String(item))
        : item);
    }
  }
  return el;
}

function fmtKm(metres) {
  return Number.isFinite(metres) ? `${(metres / 1000).toFixed(2)} KM` : '—';
}

export class HUD {
  constructor() {
    this.el = Object.create(null);
    this.screens = Object.create(null);
    this.screen = null;
    this.stage = null;
    this.best = null;
    this.quality = 'medium';
    this.camera = 0;
    this.tilt = false;

    this.onAction = null;
    this.onStage = null;
    this.onQuality = null;
    this.onCamera = null;
    this.onTilt = null;

    this._qButtons = [];
    this._cButtons = [];
    this._tButtons = [];
    this._stageCards = [];
    this._selectedStage = 0;
    this._toastTimer = 0;

    this._samples = [];
    this._map = null;
    this._lastMapPaint = -Infinity;
    this._totalLength = 0;
    this._mapMeta = null;

    this._timerMain = null;
    this._timerMs = null;
    this._finMain = null;
    this._finMs = null;

    this._build();
  }

  // ------------------------------------------------------------------ build

  _build() {
    const app = document.getElementById('app');
    if (!app) throw new Error('HUD: missing #app mount point');

    const root = node('div', 'rally-hud', { id: 'hud' });
    this.el.hud = root;

    root.appendChild(this._buildRace());
    root.appendChild(this._buildCountdown());
    root.appendChild(this._buildToast());
    root.appendChild(this._buildTitle());
    root.appendChild(this._buildPause());
    root.appendChild(this._buildFinish());
    root.appendChild(this._buildControls());
    root.appendChild(this._buildTiltCal());
    root.appendChild(this._buildRotateHint());
    root.appendChild(this._buildTouch());
    root.appendChild(this._buildDebug());
    root.appendChild(this._buildBoot());

    app.appendChild(root);

    this.touchRoot = this.el.touch;
    const canvas = this.el.map;
    this.mapCtx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;

    this.setQualityUI('medium');
    this.setCameraUI(0);
    this.setTiltUI(false);
  }

  _screen(key, cls, label) {
    const screen = node('section', `rkScreen ${cls}`, {
      'data-screen': key,
      'aria-label': label,
      'aria-hidden': 'true',
      role: 'dialog',
      'aria-modal': 'true',
    });
    this.screens[key] = screen;
    return screen;
  }

  _bindAction(button, act) {
    button.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof this.onAction === 'function') this.onAction(act);
      // a focused HUD button would otherwise be re-activated by Space (handbrake)
      if (typeof button.blur === 'function') button.blur();
    });
    return button;
  }

  _actionButton(act, cls, label, glyph, extra) {
    const attrs = { type: 'button', 'data-act': act, 'aria-label': label, title: label };
    if (extra) Object.assign(attrs, extra);
    const content = glyph
      ? [
        node('span', 'rkGlyph', { 'aria-hidden': 'true' }, glyph),
        node('span', 'rkLabel', null, label),
      ]
      : label;
    return this._bindAction(node('button', cls, attrs, content), act);
  }

  _bindChoice(button, kind, value) {
    const record = { node: button, value: String(value) };
    if (kind === 'q') this._qButtons.push(record);
    else if (kind === 'c') this._cButtons.push(record);
    else this._tButtons.push(record);

    button.addEventListener('click', () => {
      if (kind === 'q') {
        this.setQualityUI(value);
        if (typeof this.onQuality === 'function') this.onQuality(value);
      } else if (kind === 'c') {
        const mode = Number(value);
        this.setCameraUI(mode);
        if (typeof this.onCamera === 'function') this.onCamera(mode);
      } else {
        const enabled = String(value) === '1';
        this.setTiltUI(enabled);
        if (typeof this.onTilt === 'function') this.onTilt(enabled);
      }
    });
    return button;
  }

  _segmented(kind, field, label, entries) {
    const group = node('div', 'segmented', {
      'data-f': field,
      role: 'group',
      'aria-label': label,
    });
    for (const entry of entries) {
      const attr = {};
      attr[`data-${kind}`] = String(entry.value);
      const button = node('button', 'seg-btn', {
        type: 'button',
        'aria-pressed': 'false',
        'aria-label': entry.aria || entry.label,
        ...attr,
      }, entry.label);
      this._bindChoice(button, kind, entry.value);
      group.appendChild(button);
    }
    return group;
  }

  _setting(label, note, control) {
    return node('div', 'setupLine', null, [
      node('div', 'setting-copy', null, [
        node('b', 'setting-name', null, label),
        node('small', 'setting-note', null, note),
      ]),
      node('div', 'setting-control', null, control),
    ]);
  }

  _buildRace() {
    const layer = node('div', 'race-layer');

    const raceStage = node('strong', 'stage-chip-name', { 'data-f': 'race-stage' }, '—');
    const raceSub = node('span', 'stage-chip-sub', { 'data-f': 'race-sub' }, '—');
    const stageChip = node('div', 'stage-chip', null, [
      node('span', 'stage-chip-flag', { 'aria-hidden': 'true' }, 'SS'),
      node('div', 'stage-chip-copy', null, [raceStage, raceSub]),
    ]);
    this.el.raceStage = raceStage;
    this.el.raceSub = raceSub;

    this._timerMain = node('span', null, null, '00:00');
    this._timerMs = node('span', 'ms', null, '.00');
    const timer = node('div', 'clock', { 'data-f': 'timer', 'aria-label': '赛段用时' }, [
      this._timerMain,
      this._timerMs,
    ]);
    const delta = node('div', 'delta idle', { 'data-f': 'delta' }, '等待发车');
    const penalty = node('span', 'penalty-chip', { 'data-f': 'penalty', 'aria-live': 'polite' }, '');
    const chrono = node('div', 'chrono', null, [
      node('span', 'field-label', null, '赛段用时'),
      timer,
      delta,
      penalty,
    ]);
    this.el.timer = timer;
    this.el.delta = delta;
    this.el.penalty = penalty;

    const actions = node('div', 'race-actions');
    actions.appendChild(this._actionButton('camera', 'hudBtn', '切换视角', '◉'));
    actions.appendChild(this._actionButton('reset', 'hudBtn', '回到赛道', '↺'));
    actions.appendChild(this._actionButton('pause', 'hudBtn', '暂停', 'Ⅱ'));

    const raceBar = node('div', 'race-bar', null, [stageChip, chrono, actions]);

    const progressFill = node('div', 'progress-fill', { 'data-f': 'bar' });
    const progressPin = node('span', 'progress-pin', { 'data-f': 'dot', 'aria-hidden': 'true' });
    const progressRail = node('div', 'progress-rail', null, [progressFill, progressPin]);
    const progress = node('div', 'stage-progress', {
      role: 'progressbar',
      'aria-label': '赛段进度',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    }, [
      node('span', 'progress-cap', null, 'START'),
      progressRail,
      node('span', 'progress-cap', null, 'FINISH'),
    ]);
    this.el.bar = progressFill;
    this.el.dot = progressPin;
    this.el.progress = progress;

    const top = node('div', 'race-top', null, [raceBar, progress]);

    const mapMeta = node('span', 'map-meta', null, '—');
    const canvas = node('canvas', 'map-canvas', {
      id: 'map',
      'data-f': 'map',
      width: MAP_SIDE,
      height: MAP_SIDE,
      'aria-label': '赛段小地图',
    });
    const minimap = node('aside', 'minimap', null, [
      node('div', 'map-head', null, [
        node('span', null, null, 'ROUTE'),
        mapMeta,
      ]),
      canvas,
    ]);
    this.el.map = canvas;
    this._mapMeta = mapMeta;

    const arrow = node('div', 'note-arrow', { 'data-f': 'arrow', 'aria-hidden': 'true' }, [
      node('span', 'arrow-glyph'),
    ]);
    const note = node('div', 'note-label', { 'data-f': 'note' }, '—');
    const notedist = node('span', null, { 'data-f': 'notedist' }, '—');
    const roadbook = node('div', 'roadbook', { 'data-f': 'notewrap' }, [
      node('div', 'roadbook-head', null, [
        node('span', 'roadbook-kicker', null, 'PACE NOTE'),
        node('span', 'roadbook-line', { 'aria-hidden': 'true' }),
      ]),
      node('div', 'roadbook-main', null, [
        arrow,
        node('div', 'note-copy', null, [
          note,
          node('div', 'note-range', null, [
            notedist,
            node('span', 'note-unit', null, 'm'),
          ]),
        ]),
      ]),
    ]);
    this.el.notewrap = roadbook;
    this.el.arrow = arrow;
    this.el.note = note;
    this.el.notedist = notedist;

    const speed = node('span', 'speed-value', { 'data-f': 'speed' }, '0');
    const gear = node('strong', 'gear-value', { 'data-f': 'gear' }, 'N');
    const rpmFill = node('div', 'rpm-fill', { 'data-f': 'rpm' });
    const rpmRail = node('div', 'rpm-rail', {
      role: 'meter',
      'aria-label': '发动机转速',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    }, [rpmFill]);
    const surface = node('strong', 'surface-value', { 'data-f': 'surface' }, '压实雪');

    const dash = node('div', 'dash', null, [
      node('div', 'speedometer', null, [
        speed,
        node('span', 'speed-unit', null, 'km/h'),
      ]),
      node('div', 'gear', null, [
        node('span', 'gear-label', null, '挡位'),
        gear,
      ]),
      node('div', 'rpm', null, [rpmRail]),
      node('div', 'surface', null, [
        node('span', 'surface-kicker', null, '路面'),
        surface,
      ]),
    ]);
    this.el.speed = speed;
    this.el.gear = gear;
    this.el.rpm = rpmFill;
    this._rpmRail = rpmRail;
    this.el.surface = surface;

    layer.appendChild(top);
    layer.appendChild(minimap);
    layer.appendChild(roadbook);
    layer.appendChild(dash);
    return layer;
  }

  _buildCountdown() {
    const countdown = node('div', 'countdown', {
      id: 'countdown',
      'aria-live': 'assertive',
      'aria-atomic': 'true',
    });
    this.el.countdown = countdown;
    return countdown;
  }

  _buildToast() {
    const toast = node('div', 'toast', {
      id: 'toast',
      role: 'status',
      'aria-live': 'polite',
    });
    this.el.toast = toast;
    return toast;
  }

  _buildStageCards() {
    const wrap = node('div', 'stage-list', {
      'data-f': 'stages',
      role: 'group',
      'aria-label': '赛段列表',
    });
    this.el.stages = wrap;

    for (let slot = 0; slot < 3; slot += 1) {
      const meta = STAGES[slot] || { seed: slot, theme: 'snow', length: 0 };
      const theme = THEMES[meta.theme] || { name: `赛段 ${slot + 1}`, sub: '', key: 'snow' };
      const place = String(theme.sub || '').split('·').pop().trim();
      const index = node('span', 'card-index', null, String(slot + 1).padStart(2, '0'));
      const name = node('span', 'card-name', null, theme.name || `赛段 ${slot + 1}`);
      const desc = node('span', 'card-meta', null, [
        fmtKm(meta.length),
        place ? ` · ${place}` : '',
      ]);
      const best = node('span', 'card-best', null, '尚无成绩');
      const go = node('span', 'card-go', { 'aria-hidden': 'true' }, '→');
      const card = node('button', 'stage-card', {
        type: 'button',
        'data-stage': String(slot),
        'aria-pressed': 'false',
        'aria-label': `赛段 ${slot + 1}：${theme.name || ''}`,
      }, [
        index,
        node('span', 'card-copy', null, [name, desc]),
        node('span', 'card-score', null, [best, go]),
      ]);
      card.addEventListener('click', () => {
        if (typeof this.onStage === 'function') this.onStage(slot);
      });
      this._stageCards.push({ node: card, index: slot, best });
      wrap.appendChild(card);
    }
    return wrap;
  }

  _buildTitle() {
    const screen = this._screen('title', 'screen-title', '赛段选择');

    const hero = node('header', 'title-hero', null, [
      node('p', 'eyebrow', null, 'THREE.JS · 单文件拉力赛'),
      node('h1', 'game-title', null, [
        node('span', 'title-word', null, 'SNOWLINE'),
        node('span', 'title-word title-outline', null, 'RALLY'),
      ]),
      node('p', 'title-lede', null,
        '三条雪线赛段，一台车，一次计时。把刹车点找回来，剩下的交给油门。'),
      node('div', 'title-specs', null, [
        node('div', 'spec', null, [node('b', 'spec-num', null, '03'), node('span', 'spec-label', null, '赛段')]),
        node('div', 'spec', null, [node('b', 'spec-num', null, '3.4'), node('span', 'spec-label', null, '公里 / 段')]),
        node('div', 'spec', null, [node('b', 'spec-num', null, '120'), node('span', 'spec-label', null, 'Hz 物理')]),
      ]),
    ]);

    const stageName = node('h3', 'current-name', { 'data-f': 'stage' }, '雪线');
    const stageSub = node('p', 'current-sub', { 'data-f': 'stage-sub' }, '—');
    const stageLength = node('strong', 'fact-value', { 'data-f': 'stage-length' }, '—');
    const stageBest = node('strong', 'fact-value', { 'data-f': 'stage-best' }, '—');
    const stageSurface = node('strong', 'fact-value', { 'data-f': 'stage-surface' }, '—');
    const current = node('div', 'current-stage', null, [
      node('div', 'current-top', null, [
        node('span', 'ss-badge', { 'aria-hidden': 'true' }, 'SS'),
        node('div', 'current-copy', null, [stageName, stageSub]),
      ]),
      node('div', 'current-facts', null, [
        node('div', 'fact', null, [node('span', 'fact-label', null, '长度'), stageLength]),
        node('div', 'fact', null, [node('span', 'fact-label', null, '最佳'), stageBest]),
        node('div', 'fact', null, [node('span', 'fact-label', null, '路面'), stageSurface]),
      ]),
    ]);
    this.el.stage = stageName;
    this.el.stageSub = stageSub;
    this.el.stageLength = stageLength;
    this.el.stageBest = stageBest;
    this.el.stageSurface = stageSurface;

    const start = this._actionButton('start', 'rkBtn rkPrimary startBtn', '开始比赛', '▶');
    start.appendChild(node('span', 'rkHint', null, 'ENTER'));
    const controls = this._actionButton('controls', 'rkBtn rkQuiet', '操作与设置');
    const actions = node('div', 'titleActions', null, [start, controls]);

    const board = node('div', 'stage-board', null, [
      node('div', 'board-head', null, [
        node('div', null, [
          node('p', 'eyebrow', null, '赛段清单'),
          node('h2', 'board-title', null, '选择路线'),
        ]),
        node('span', 'board-tag', null, '3 STAGES'),
      ]),
      current,
      this._buildStageCards(),
      actions,
      node('p', 'title-hint', null,
        'WASD / 方向键驾驶 · 空格手刹 · R 回到赛道 · C 换视角 · Esc 暂停'),
    ]);

    screen.appendChild(node('div', 'title-layout', null, [hero, board]));
    return screen;
  }

  _buildPause() {
    const screen = this._screen('pause', 'screen-pause', '暂停');
    const pauseStage = node('p', 'pause-stage', { 'data-f': 'pause-stage' }, '—');
    this.el.pauseStage = pauseStage;

    const card = node('div', 'modal-card pause-card', null, [
      node('p', 'eyebrow', null, 'STAGE PAUSED'),
      node('h2', 'modal-title', null, '比赛暂停'),
      pauseStage,
      node('p', 'modal-note', null,
        '计时已经冻结。可以继续、重跑本段，或者翻一下操作说明再回来。'),
      node('div', 'modalActions', null, [
        this._actionButton('resume', 'rkBtn rkPrimary', '继续比赛', '▶'),
        this._actionButton('restart', 'rkBtn rkQuiet', '重跑本段'),
        this._actionButton('controls', 'rkBtn rkQuiet', '操作与设置'),
        this._actionButton('menu', 'rkBtn rkGhost', '返回选段'),
      ]),
      node('p', 'modal-foot', null, 'Esc 继续 · R 回到赛道 · C 切换视角'),
    ]);
    screen.appendChild(card);
    return screen;
  }

  _buildFinish() {
    const screen = this._screen('finish', 'screen-finish', '赛段结果');
    const finK = node('p', 'eyebrow result-kicker', { 'data-f': 'fin-k' }, 'STAGE RESULT');
    const finH = node('h2', 'result-title', { 'data-f': 'fin-h' }, '赛段完成');
    const finSub = node('p', 'result-sub', { 'data-f': 'fin-sub' }, '—');
    this._finMain = node('span', null, null, '00:00');
    this._finMs = node('span', 'ms', null, '.00');
    const finTime = node('div', 'result-clock', { 'data-f': 'fin-time' }, [
      this._finMain,
      this._finMs,
    ]);
    const finDelta = node('div', 'result-delta flat', { 'data-f': 'fin-delta' }, '—');
    const finPen = node('p', 'result-pen', { 'data-f': 'fin-pen' }, '');
    const finTop = node('strong', 'stat-value', { 'data-f': 'fin-top' }, '—');
    const finAvg = node('strong', 'stat-value', { 'data-f': 'fin-avg' }, '—');

    this.el.finK = finK;
    this.el.finH = finH;
    this.el.finSub = finSub;
    this.el.finTime = finTime;
    this.el.finDelta = finDelta;
    this.el.finPen = finPen;
    this.el.finTop = finTop;
    this.el.finAvg = finAvg;
    this.el.finish = screen;

    const card = node('div', 'result-card', null, [
      node('div', 'result-head', null, [finK, finH, finSub]),
      node('div', 'resultTime', null, [finTime, finDelta, finPen]),
      node('div', 'result-grid', null, [
        node('div', 'stat', null, [
          node('span', 'stat-label', null, '最高时速'),
          finTop,
        ]),
        node('div', 'stat', null, [
          node('span', 'stat-label', null, '平均时速'),
          finAvg,
        ]),
      ]),
      node('div', 'resultActions', null, [
        this._actionButton('next', 'rkBtn rkPrimary', '下一赛段', '→'),
        this._actionButton('retry', 'rkBtn rkQuiet', '重跑本段', '↻'),
        this._actionButton('menu', 'rkBtn rkGhost', '返回选段'),
      ]),
      node('p', 'modal-foot', null, 'Enter 直接进入下一赛段'),
    ]);
    screen.appendChild(card);
    return screen;
  }

  _keyRow(keys, text) {
    return node('div', 'keyLine', null, [
      node('dt', null, null, keys.map((key) => node('kbd', null, null, key))),
      node('dd', null, null, text),
    ]);
  }

  _buildControls() {
    const screen = this._screen('controls', 'screen-controls', '操作与设置');

    const close = this._actionButton('close-controls', 'controls-close', '关闭', '×');
    const head = node('header', 'controls-head', null, [
      node('div', null, [
        node('p', 'eyebrow', null, 'CONTROLS / SETUP'),
        node('h2', 'controls-title', null, '操作与设置'),
      ]),
      close,
    ]);

    const keymap = node('dl', 'keymap', null, [
      this._keyRow(['W', '↑'], '加速'),
      this._keyRow(['S', '↓'], '刹车'),
      this._keyRow(['A', 'D', '←', '→'], '转向'),
      this._keyRow(['空格', 'Shift'], '手刹'),
      this._keyRow(['R'], '回到赛道'),
      this._keyRow(['C'], '切换视角'),
      this._keyRow(['Esc', 'P'], '暂停 / 继续'),
      this._keyRow(['M'], '静音'),
    ]);

    const driving = node('section', 'controls-col', null, [
      node('h3', 'column-title', null, '驾驶输入'),
      keymap,
      node('p', 'column-note', null,
        '触屏：左侧区域按住左右滑动转向；右侧油门、刹车与手刹可以同时按。手机横屏开赛时会自动请求全屏。'),
      node('p', 'column-note', null,
        '手柄：左摇杆转向，RT 油门，LT 刹车，A 键手刹，Start 暂停。'),
    ]);

    const quality = this._segmented('q', 'quality', '画质', [
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
    ]);
    this.el.quality = quality;

    const vol = node('input', 'volume-range', {
      'data-f': 'vol',
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      value: '70',
      'aria-label': '音量',
    });
    this.el.vol = vol;

    const cam = this._segmented('c', 'cam', '镜头', [
      { value: 0, label: '车外' },
      { value: 1, label: '引擎盖' },
      { value: 2, label: '驾驶舱' },
    ]);
    this.el.cam = cam;

    const tilt = this._segmented('t', 'tilt', '倾斜转向', [
      { value: 0, label: '关闭' },
      { value: 1, label: '开启' },
    ]);
    this.el.tilt = tilt;

    const tiltActions = node('div', 'setupActions', null, [
      this._actionButton('calibrate', 'rkBtn rkMini', '校准中位'),
      this._actionButton('invert', 'rkBtn rkMini', '反转方向'),
      this._actionButton('tiltcal-open', 'rkBtn rkMini', '方向自检'),
    ]);

    const fullscreen = this._actionButton('fullscreen', 'rkBtn rkMini fsBtn', '全屏', null, {
      'data-f': 'fs',
    });
    this.el.fs = fullscreen;

    const settings = node('section', 'controls-col', null, [
      node('h3', 'column-title', null, '画面与手感'),
      this._setting('画质', '低画质适合较旧的手机；高画质会增加阴影与雪量。', quality),
      this._setting('音量', '主音量，也会保存到本机。', node('div', 'volume-wrap', null, [vol])),
      this._setting('镜头', '车外追尾、引擎盖与驾驶舱三种机位。', cam),
      this._setting('倾斜转向', '开启后左右倾斜手机即可转向。', tilt),
      this._setting('倾斜辅助', '校准中位、反转方向，或重新做一次左右方向自检。', tiltActions),
      this._setting('全屏', '进入或退出浏览器全屏，横屏时视野更完整。', fullscreen),
    ]);

    const body = node('div', 'controls-body', null, [driving, settings]);
    screen.appendChild(node('div', 'controls-card', null, [head, body]));
    return screen;
  }

  _buildTiltCal() {
    const overlay = node('div', 'tiltcal', {
      id: 'tiltcal',
      'aria-label': '倾斜方向自检',
    });
    this.el.tiltcal = overlay;

    const live = node('div', 'tilt-live', { 'data-f': 'tiltlive' }, '等待开始…');
    this.el.tiltlive = live;

    const card = node('div', 'tiltcal-card', null, [
      node('p', 'eyebrow', null, 'SENSOR CHECK'),
      node('h2', 'modal-title', null, '方向自检'),
      node('p', 'modal-note', null,
        '先向右压住手机，再向左压住手机。系统会用这两个动作判断传感器方向，下一次开赛就能按你的握姿转向。'),
      live,
      node('div', 'modalActions', null, [
        this._actionButton('tiltcal', 'rkBtn rkPrimary', '开始检测', '▶'),
        this._actionButton('tiltcal-skip', 'rkBtn rkQuiet', '跳过'),
      ]),
      node('p', 'modal-foot', null, '检测期间请保持横屏，手臂放松。'),
    ]);
    overlay.appendChild(card);
    return overlay;
  }

  _buildRotateHint() {
    const hint = node('div', 'rotate-hint', { id: 'rotate' }, [
      node('div', 'rotate-card', null, [
        node('div', 'rotate-phone', { 'aria-hidden': 'true' }, [
          node('span', 'rotate-screen'),
        ]),
        node('h2', 'rotate-title', null, '请横屏游玩'),
        node('p', 'rotate-note', null, '横向握持能看到完整赛道与触控按键。'),
        this._actionButton('rotate-anyway', 'rkBtn rkQuiet', '仍然竖屏继续'),
      ]),
    ]);
    this.el.rotate = hint;
    return hint;
  }

  _buildTouch() {
    const touch = node('div', 'touchDeck', {
      id: 'touch',
      'aria-label': '触屏驾驶',
    });

    const steer = node('div', 'steer-pad', {
      'data-touch': 'steer',
      role: 'group',
      'aria-label': '转向：按住并左右滑动',
    }, [
      node('span', 'steer-side', { 'aria-hidden': 'true' }, '‹'),
      node('span', 'steer-guide', null, '按住滑动'),
      node('span', 'steer-side', { 'aria-hidden': 'true' }, '›'),
    ]);

    const pedal = (hold, label, short, cls) => node('button', `padButton ${cls}`, {
      type: 'button',
      'data-hold': hold,
      'aria-label': label,
    }, [
      node('span', 'pedal-letter', { 'aria-hidden': 'true' }, short),
      node('span', 'pedal-name', null, label),
    ]);

    const pedals = node('div', 'pedal-deck', null, [
      pedal('brake', '刹车', 'BRK', 'pedal-brake'),
      pedal('gas', '油门', 'GAS', 'pedal-gas'),
    ]);
    // handbrake sits at the bottom centre: both thumbs can reach it, and it no longer
    // competes with the throttle for the right thumb
    const handbrake = pedal('hand', '手刹', 'HB', 'pedal-hand pedal-hand-center');

    touch.appendChild(steer);
    touch.appendChild(pedals);
    touch.appendChild(handbrake);
    this.el.touch = touch;
    return touch;
  }

  _buildDebug() {
    const debug = node('pre', 'debug-panel', {
      'data-f': 'dbg',
      'aria-hidden': 'true',
    });
    this.el.dbg = debug;
    return debug;
  }

  _buildBoot() {
    const fill = node('div', 'boot-fill', { 'data-f': 'bootbar' });
    const msg = node('p', 'boot-msg', { 'data-f': 'bootmsg' }, '正在启动…');
    const pct = node('span', 'boot-pct', null, '0%');
    const boot = node('div', 'rkBoot on', {
      id: 'boot',
      role: 'status',
      'aria-live': 'polite',
      'aria-hidden': 'false',
    }, [
      node('div', 'boot-inner', null, [
        node('div', 'boot-top', null, [
          node('span', 'boot-brand', null, 'SNOWLINE / RALLY'),
          node('span', 'boot-tag', null, '单文件拉力赛'),
        ]),
        node('div', 'boot-title', null, '赛道准备中'),
        msg,
        node('div', 'boot-track', null, [fill]),
        node('div', 'boot-foot', null, [
          node('span', 'boot-foot-label', null, '构建地形 · 铺设雪面 · 预热镜头'),
          pct,
        ]),
      ]),
    ]);
    this.el.boot = boot;
    this.el.bootbar = fill;
    this.el.bootmsg = msg;
    this._bootPct = pct;
    return boot;
  }

  // ---------------------------------------------------------------- stage

  setStage(stage, best) {
    this.stage = stage || null;
    this.best = best || null;

    const theme = (stage && stage.theme) || {};
    const name = (stage && stage.name) || '未选择赛段';
    const sub = theme.sub || '—';
    const surface = SURFACE_NAME[theme.key] || '未知路面';
    const total = stage && Number.isFinite(stage.totalLength) ? stage.totalLength : 0;
    const bestTime = best && Number.isFinite(best.time) ? best.time : null;

    if (this.el.stage) this.el.stage.textContent = name;
    if (this.el.stageSub) this.el.stageSub.textContent = sub;
    if (this.el.stageLength) this.el.stageLength.textContent = total ? fmtKm(total) : '—';
    if (this.el.stageBest) this.el.stageBest.textContent = bestTime !== null ? fmtClock(bestTime) : '—';
    if (this.el.stageSurface) this.el.stageSurface.textContent = surface;
    if (this.el.raceStage) this.el.raceStage.textContent = name;
    if (this.el.raceSub) this.el.raceSub.textContent = sub;
    if (this.el.surface) this.el.surface.textContent = surface;
    if (this.el.pauseStage) this.el.pauseStage.textContent = `${name} · ${sub}`;

    this._totalLength = total;
    this._paceIndex = 0;
    this._clearNote();
    this._buildMap(stage);
    this._paintMap({ progress: 0, car: null }, true);
    if (this._mapMeta) this._mapMeta.textContent = total ? `0.00 / ${(total / 1000).toFixed(2)} KM` : '—';
  }

  renderStageList(selected, bests) {
    const pick = Number.isFinite(Number(selected)) ? Number(selected) : 0;
    this._selectedStage = pick;
    const records = bests && typeof bests === 'object' ? bests : {};

    for (const card of this._stageCards) {
      const meta = STAGES[card.index];
      const on = card.index === pick;
      card.node.classList.toggle('picked', on);
      card.node.setAttribute('aria-pressed', on ? 'true' : 'false');
      const record = meta ? records[meta.seed] : null;
      const time = record && Number.isFinite(record.time) ? record.time : null;
      const cleanPB = record && Number.isFinite(record.cleanBest) ? record.cleanBest : null;
      card.best.textContent = time !== null
        ? (cleanPB !== null && cleanPB < time ? `PB ${fmtClock(time)} · 干净 ${fmtClock(cleanPB)}` : `PB ${fmtClock(time)}`)
        : '尚无成绩';
      card.best.classList.toggle('has-time', time !== null);
    }
  }

  _clearNote() {
    const wrap = this.el.notewrap;
    const note = this.el.note;
    if (wrap) {
      wrap.classList.remove('on', 'note-hairpin', 'sev-warn', 'sev-mid', 'sev-calm');
    }
    if (note) {
      note.classList.remove('note-hairpin', 'sev-warn', 'sev-mid', 'sev-calm');
      note.textContent = '—';
    }
    if (this.el.arrow) this.el.arrow.classList.remove('flip');
    if (this.el.notedist) this.el.notedist.textContent = '—';
  }

  // ------------------------------------------------------------------ map

  _buildMap(stage) {
    const samples = stage && Array.isArray(stage.samples) ? stage.samples : [];
    this._samples = samples;
    this._map = null;
    this._lastMapPaint = -Infinity;

    if (this.mapCtx) {
      try {
        this.mapCtx.clearRect(0, 0, MAP_SIDE, MAP_SIDE);
      } catch (err) { /* canvas unavailable */ }
    }
    if (samples.length < 2) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const sample of samples) {
      if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.z)) continue;
      if (sample.x < minX) minX = sample.x;
      if (sample.x > maxX) maxX = sample.x;
      if (sample.z < minZ) minZ = sample.z;
      if (sample.z > maxZ) maxZ = sample.z;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return;

    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const pad = 24;
    const scale = Math.min((MAP_SIDE - pad * 2) / spanX, (MAP_SIDE - pad * 2) / spanZ);
    const offX = MAP_SIDE / 2 - ((minX + maxX) / 2) * scale;
    const offZ = MAP_SIDE / 2 - ((minZ + maxZ) / 2) * scale;

    const points = [];
    for (const sample of samples) {
      if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.z)) continue;
      points.push({
        x: sample.x * scale + offX,
        y: sample.z * scale + offZ,
      });
    }
    if (points.length < 2) return;

    this._map = { points, scale, offX, offZ };
  }

  _paintMap(state, force) {
    const ctx = this.mapCtx;
    const map = this._map;
    if (!ctx || !map) return;

    const progress = clamp(Number(state.progress) || 0, 0, 1);
    if (this._mapMeta && this._totalLength > 0) {
      const travelled = (this._totalLength * progress) / 1000;
      this._mapMeta.textContent = `${travelled.toFixed(2)} / ${(this._totalLength / 1000).toFixed(2)} KM`;
    }

    const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (!force && now - this._lastMapPaint < 80) return;
    this._lastMapPaint = now;

    const points = map.points;
    const last = points.length - 1;

    try {
      ctx.clearRect(0, 0, MAP_SIDE, MAP_SIDE);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      const trace = (count) => {
        const origin = points[0];
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        for (let step = 1; step <= count && step <= last; step++) {
          ctx.lineTo(points[step].x, points[step].y);
        }
        ctx.stroke();
      };

      ctx.strokeStyle = 'rgba(47, 127, 184, 0.22)';
      ctx.lineWidth = 7;
      trace(last);
      ctx.strokeStyle = 'rgba(31, 127, 191, 0.8)';
      ctx.lineWidth = 2.4;
      trace(last);

      const cut = clamp(Math.ceil(progress * last), 1, last);
      if (progress > 0.002) {
        ctx.strokeStyle = '#e2662f';
        ctx.lineWidth = 3.2;
        trace(cut);
      }

      const start = points[0];
      ctx.beginPath();
      ctx.arc(start.x, start.y, 4, 0, RAD);
      ctx.fillStyle = '#2f8fd0';
      ctx.fill();

      const finish = points[last];
      ctx.fillStyle = '#f7fbff';
      ctx.fillRect(finish.x - 3.5, finish.y - 3.5, 7, 7);
      ctx.strokeStyle = '#1f7fbf';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(finish.x - 3.5, finish.y - 3.5, 7, 7);

      const car = state.car;
      let wx = null;
      let wz = null;
      let yaw = 0;
      if (car && car.pos && Number.isFinite(car.pos.x) && Number.isFinite(car.pos.z)) {
        wx = car.pos.x;
        wz = car.pos.z;
      } else {
        const fallback = samplesFor(this, progress);
        if (fallback) {
          wx = fallback.x;
          wz = fallback.z;
          yaw = Number.isFinite(fallback.yaw) ? fallback.yaw : 0;
        }
      }
      if (Number.isFinite(wx) && Number.isFinite(wz)) {
        if (car && Number.isFinite(car.yaw)) yaw = car.yaw;
        else if (car && Math.hypot(car.vx || 0, car.vz || 0) > 0.4) yaw = Math.atan2(car.vx, car.vz);
        const mx = wx * map.scale + map.offX;
        const my = wz * map.scale + map.offZ;
        const fx = Math.sin(yaw);
        const fy = Math.cos(yaw);
        const rx = Math.cos(yaw);
        const ry = -Math.sin(yaw);

        ctx.beginPath();
        ctx.arc(mx, my, 10, 0, RAD);
        ctx.strokeStyle = 'rgba(226, 102, 47, 0.3)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(mx + fx * 8, my + fy * 8);
        ctx.lineTo(mx - fx * 4 + rx * 4, my - fy * 4 + ry * 4);
        ctx.lineTo(mx - fx * 4 - rx * 4, my - fy * 4 - ry * 4);
        ctx.closePath();
        ctx.fillStyle = '#e2662f';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    } catch (err) { /* ignore a broken canvas context */ }
  }

  // --------------------------------------------------------------- update

  _writeClock(mainEl, fracEl, value) {
    if (!mainEl) return;
    const text = fmtClock(Math.max(0, Number(value) || 0));
    const cut = text.lastIndexOf('.');
    if (cut < 0) {
      mainEl.textContent = text;
      if (fracEl) fracEl.textContent = '.00';
    } else {
      mainEl.textContent = text.slice(0, cut);
      if (fracEl) fracEl.textContent = text.slice(cut);
    }
  }

  update(state) {
    const s = state && typeof state === 'object' ? state : {};
    const timeMs = Number.isFinite(s.time) ? s.time : (Number.isFinite(s.t) ? s.t * 1000 : 0);
    this._writeClock(this._timerMain, this._timerMs, timeMs);

    const running = !!s.running;
    const delta = Number.isFinite(s.delta) ? s.delta : null;
    if (this.el.delta) {
      const el = this.el.delta;
      el.classList.remove('fast', 'slow', 'even', 'idle');
      if (delta === null) {
        el.textContent = running ? '无参考圈' : '等待发车';
        el.classList.add('idle');
      } else {
        el.textContent = fmtTime(delta, true);
        el.classList.add(delta < 0 ? 'fast' : delta > 0 ? 'slow' : 'even');
      }
    }

    const speed = Number.isFinite(s.speed) ? s.speed : 0;
    if (this.el.speed) this.el.speed.textContent = String(Math.round(speed * 3.6));

    if (this.el.gear) {
      const gear = Number(s.gear);
      this.el.gear.textContent = !Number.isFinite(gear) ? '—' : gear > 0 ? String(gear) : gear < 0 ? 'R' : 'N';
    }

    const rpm = Number.isFinite(s.rpm) ? s.rpm : 0;
    const load = clamp((rpm - 800) / 6900, 0, 1);
    if (this.el.rpm) this.el.rpm.style.width = `${(load * 100).toFixed(2)}%`;
    if (this._rpmRail) this._rpmRail.setAttribute('aria-valuenow', String(Math.round(load * 100)));

    const progress = clamp(Number(s.progress) || 0, 0, 1);
    if (this.el.bar) this.el.bar.style.width = `${(progress * 100).toFixed(2)}%`;
    if (this.el.dot) this.el.dot.style.left = `${(progress * 100).toFixed(2)}%`;
    if (this.el.progress) this.el.progress.setAttribute('aria-valuenow', String(Math.round(progress * 100)));

    if (this.el.surface && typeof s.surface === 'string' && s.surface.trim()) {
      this.el.surface.textContent = s.surface;
    }

    const pace = s.note && typeof s.note === 'object' ? s.note : null;
    if (pace) {
      const sev = Number.isFinite(pace.sev) ? pace.sev : 3;
      const label = noteLabel(pace);
      const tone = sev === 0 ? 'sev-warn' : sev <= 2 ? 'sev-mid' : 'sev-calm';
      const hairpin = sev === 0;
      const hosts = [this.el.notewrap, this.el.note];
      for (const host of hosts) {
        if (!host) continue;
        host.classList.toggle('note-hairpin', hairpin);
        host.classList.toggle('sev-warn', tone === 'sev-warn');
        host.classList.toggle('sev-mid', tone === 'sev-mid');
        host.classList.toggle('sev-calm', tone === 'sev-calm');
      }
      if (this.el.notewrap) {
        this.el.notewrap.classList.add('on');
        this.el.notewrap.setAttribute('data-sev', String(sev));
      }
      if (this.el.arrow) this.el.arrow.classList.toggle('flip', pace.dir < 0);
      if (this.el.note) this.el.note.textContent = label;
      if (this.el.notedist) this.el.notedist.textContent = String(Math.max(0, Math.round(Number(s.noteDist) || 0)));
    } else {
      if (this.el.notewrap) this.el.notewrap.classList.remove('on');
      if (this.el.arrow) this.el.arrow.classList.remove('flip');
    }

    this._paintMap({ progress, car: s.car }, false);
  }

  // -------------------------------------------------------------- screens

  setScreen(name) {
    const names = ['title', 'pause', 'finish', 'controls'];
    const pick = names.includes(name) ? name : null;

    for (const key of names) {
      const screen = this.screens[key];
      if (!screen) continue;
      const on = key === pick;
      screen.classList.toggle('on', on);
      screen.setAttribute('aria-hidden', on ? 'false' : 'true');
    }

    if (document.body && document.body.classList) {
      document.body.classList.toggle('racing', pick === null);
    }
    if (this.el.hud) {
      this.el.hud.classList.toggle('screen-open', pick !== null);
    }
    this.screen = pick;
  }

  countdown(text, go = false) {
    const el = this.el.countdown;
    if (!el) return;
    const value = text === undefined || text === null ? '' : String(text);
    if (!value) {
      el.classList.remove('on', 'go');
      el.textContent = '';
      return;
    }
    el.textContent = value;
    el.classList.toggle('go', !!go);
    el.classList.add('on');
  }

  toast(msg, ms = 1800) {
    const el = this.el.toast;
    if (!el) return;
    const text = msg === undefined || msg === null ? '' : String(msg);
    if (!text) {
      el.classList.remove('on');
      el.textContent = '';
      return;
    }
    el.textContent = text;
    el.classList.add('on');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    const wait = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 1800;
    this._toastTimer = setTimeout(() => {
      el.classList.remove('on');
      this._toastTimer = 0;
    }, wait);
    if (this._toastTimer && typeof this._toastTimer.unref === 'function') this._toastTimer.unref();
  }

  setPenalty(ms) {
    const el = this.el.penalty;
    if (!el) return;
    const v = Math.max(0, Number(ms) || 0);
    el.classList.toggle('on', v > 0);
    el.textContent = v > 0 ? `+${Math.round(v / 1000)}s` : '';
  }

  showFinish(stats) {
    const s = stats && typeof stats === 'object' ? stats : {};
    const stage = s.stage || this.stage;
    const time = Number.isFinite(s.time) ? s.time : 0;
    const prev = Number.isFinite(s.prevBest) ? s.prevBest : null;
    const top = Number.isFinite(s.topSpeed) ? s.topSpeed : 0;
    const newBest = !!s.newBest;

    this._writeClock(this._finMain, this._finMs, time);

    if (this.el.finK) this.el.finK.textContent = newBest ? 'NEW BEST' : 'STAGE RESULT';
    if (this.el.finH) this.el.finH.textContent = newBest ? '刷新赛段纪录' : '赛段完成';
    if (this.el.finSub) {
      const parts = [];
      if (stage && stage.name) parts.push(stage.name);
      if (stage && stage.theme && stage.theme.sub) parts.push(stage.theme.sub);
      this.el.finSub.textContent = parts.join(' · ') || '—';
    }

    if (this.el.finDelta) {
      const el = this.el.finDelta;
      el.classList.remove('fast', 'slow', 'flat');
      if (prev === null) {
        el.textContent = newBest ? '首次完赛 · 基准已记录' : '首次完赛';
        el.classList.add('flat');
      } else {
        const diff = time - prev;
        el.textContent = fmtTime(diff, true);
        el.classList.add(diff < 0 ? 'fast' : diff > 0 ? 'slow' : 'flat');
      }
    }

    if (this.el.finPen) {
      const raw = Number.isFinite(s.raw) ? s.raw : time;
      const pen = Number.isFinite(s.penalty) ? s.penalty : 0;
      const clean = !!s.clean;
      this.el.finPen.style.color = clean && pen === 0 ? '#1f7a52' : '#8a5a12';
      this.el.finPen.textContent = pen > 0
        ? `原始 ${fmtClock(raw)} · 罚时 +${(pen / 1000).toFixed(0)}s`
        : (clean ? '干净成绩 · 无罚时' : '');
    }
    if (this.el.finTop) this.el.finTop.textContent = `${Math.round(top * 3.6)} km/h`;
    if (this.el.finAvg) {
      const total = stage && Number.isFinite(stage.totalLength) ? stage.totalLength : 0;
      const avg = time > 0 && total > 0 ? (total / (time / 1000)) * 3.6 : 0;
      this.el.finAvg.textContent = avg > 0 ? `${Math.round(avg)} km/h` : '—';
    }
    if (this.el.finish) this.el.finish.classList.toggle('new-best', newBest);

    this.setScreen('finish');
  }

  // ------------------------------------------------------------------ boot

  setBoot(pct, msg) {
    const value = clamp(Number(pct) || 0, 0, 100);
    if (this.el.bootbar) this.el.bootbar.style.width = `${value.toFixed(1)}%`;
    if (this.el.bootmsg) this.el.bootmsg.textContent = msg === undefined || msg === null ? '' : String(msg);
    if (this._bootPct) this._bootPct.textContent = `${Math.round(value)}%`;
  }

  showBoot() {
    if (!this.el.boot) return;
    this.el.boot.classList.add('on');
    this.el.boot.setAttribute('aria-hidden', 'false');
  }

  hideBoot() {
    if (!this.el.boot) return;
    this.el.boot.classList.remove('on');
    this.el.boot.setAttribute('aria-hidden', String(true));
  }

  // -------------------------------------------------------------- settings

  setQualityUI(q) {
    const value = QUALITY_LIST.includes(q) ? q : 'medium';
    this.quality = value;
    for (const record of this._qButtons) {
      const on = record.value === value;
      record.node.classList.toggle('picked', on);
      record.node.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (this.el.quality) this.el.quality.setAttribute('data-value', value);
  }

  setCameraUI(c) {
    const value = CAMERA_LIST.includes(Number(c)) ? Number(c) : 0;
    this.camera = value;
    for (const record of this._cButtons) {
      const on = record.value === String(value);
      record.node.classList.toggle('picked', on);
      record.node.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (this.el.cam) this.el.cam.setAttribute('data-value', String(value));
  }

  setTiltUI(on) {
    const enabled = !!on;
    this.tilt = enabled;
    for (const record of this._tButtons) {
      const picked = record.value === (enabled ? '1' : '0');
      record.node.classList.toggle('picked', picked);
      record.node.setAttribute('aria-pressed', picked ? 'true' : 'false');
    }
    if (this.el.tilt) {
      this.el.tilt.setAttribute('data-value', enabled ? '1' : '0');
      this.el.tilt.classList.toggle('is-on', enabled);
    }
  }
}

// Pull a world position from the sample list when the caller has no car object.
function samplesFor(hud, progress) {
  const samples = hud._samples;
  if (!samples || !samples.length) return null;
  const index = clamp(Math.round(progress * (samples.length - 1)), 0, samples.length - 1);
  return samples[index] || null;
}
