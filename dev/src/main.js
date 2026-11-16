// main.js — boot, game state machine, camera, timing, pace notes, settings.
const THREE = window.THREE;
import { World } from './render.js';
import { HUD } from './hud.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { buildStage, STAGES } from './track.js';
import { createCar } from './physics.js';
import { clamp, damp, fmtClock } from './math.js';

const QUALITY = {
  low: { dpr: 1, shadow: 0, snow: 500, trees: 0.55, terrain: 12 },
  medium: { dpr: 1.35, shadow: 1024, snow: 1100, trees: 0.8, terrain: 9 },
  high: { dpr: 2, shadow: 2048, snow: 1700, trees: 1, terrain: 7 },
};
const SKEY = 'rally.settings.v1';
const BKEY = 'rally.best.v1';
const FIXED = 1 / 120;

const LOG = [];
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    try {
      LOG.push(level.toUpperCase() + ' ' + args.map((a) => (a && a.message) || String(a)).join(' '));
      if (LOG.length > 10) LOG.shift();
    } catch {}
    orig(...args);
  };
}
window.addEventListener('error', (e) => LOG.push('WIN ' + (e.message || 'error')));
window.addEventListener('unhandledrejection', (e) => LOG.push('REJ ' + ((e.reason && e.reason.message) || e.reason)));

const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const isTouch = () => matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v || fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

class Game {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight, true);

    this.settings = readJSON(SKEY, {});
    if (!this.settings.quality) this.settings.quality = isTouch() ? 'medium' : 'high';
    // diagnostic override: ?q=low disables post-processing, handy for GPU-specific issues
    try {
      const q = new URLSearchParams(location.search).get('q');
      if (q === 'low' || q === 'medium' || q === 'high') this.settings.quality = q;
    } catch (e) { /* ignore */ }
    if (this.settings.volume === undefined) this.settings.volume = 0.7;
    if (this.settings.camera === undefined) this.settings.camera = 0;
    if (this.settings.tilt === undefined) this.settings.tilt = isTouch();

    this.bests = readJSON(BKEY, {});
    this.state = 'boot';
    this.time = 0;
    this.acc = 0;
    this.last = performance.now();
    this.titleT = 0;
    this.countdownT = 0;
    this.countStage = 0;
    this.splitIdx = 0;
    this.notes = [];
    this.noteIdx = 0;
    this.cameraMode = this.settings.camera;
    this.pausedFrom = null;
    this.debugOn = /[?&]debug/.test(location.search);
    this.offTrackT = 0;
    this.offTrackAt = -99;

    this.hud = new HUD();
    this.input = new Input();
    this.input.tiltSign = this.settings.tiltSign === -1 ? -1 : 1;
    this.sfx = new Sound();
    window.__rally = this;

    if (isTouch()) document.body.classList.add('touch');
    this.input.bindTouch(this.hud.touchRoot);

    this.wireUI();
    window.addEventListener('resize', () => this.onResize());
    // a lost GL context on some desktop browsers paints a blank (white) frame: keep the
    // default from being cancelled so the browser can restore, and tell the player
    if (this.canvas && this.canvas.addEventListener) {
      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.hud.toast('图形上下文丢失 · 正在恢复');
      }, false);
    }
    window.addEventListener('orientationchange', () => this.onResize());
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => this.onResize());
    const reTilt = () => setTimeout(() => this.input.calibrateTilt(), 350);
    window.addEventListener('orientationchange', reTilt);
    if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
      window.screen.orientation.addEventListener('change', reTilt);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'race') this.pause();
    });

    this.hud.setQualityUI(this.settings.quality);
    this.hud.setCameraUI(this.cameraMode);
    this.hud.setTiltUI(this.settings.tilt);
    if (isTouch() && this.settings.tilt && (this.settings.tiltSignV !== 2 || this.settings.tiltSign === undefined)) {
      this.hud.el.tiltcal.classList.add('on');
    }
    this.hud.el.vol.value = Math.round(this.settings.volume * 100);
    this.sfx.setVolume(this.settings.volume);

    const hash = (location.hash.match(/s(\d)/) || [])[1];
    const stageFromHash = hash ? clamp(+hash - 1, 0, STAGES.length - 1) : 0;
    this.stageIdx = stageFromHash;
    // boot is started once, from the guard at the bottom of the file
  }

  wireUI() {
    this.hud.onAction = (act) => {
      this.sfx.ensure();
      switch (act) {
        case 'reset':
          this.resetToTrack();
          break;
        case 'camera':
          this.cameraMode = (this.cameraMode + 1) % 3;
          this.settings.camera = this.cameraMode;
          writeJSON(SKEY, this.settings);
          if (this.world) this.world._camInit = false;
          this.hud.setCameraUI(this.cameraMode);
          break;
        case 'fullscreen':
          this.toggleFullscreen();
          break;
        case 'rotate-anyway':
          document.body.classList.add('no-rotate-hint');
          break;
        case 'tiltcal':
          this.startTiltCal();
          break;
        case 'tiltcal-open':
          if (this.hud.el.tiltcal) this.hud.el.tiltcal.classList.add('on');
          break;
        case 'tiltcal-skip':
          this.tiltCal = null;
          this.settings.tiltSign = 1;
          writeJSON(SKEY, this.settings);
          this.hud.el.tiltcal.classList.remove('on');
          break;
        case 'calibrate':
          this.input.calibrateTilt();
          this.hud.toast('已校准中位 · 保持当前握姿');
          break;
        case 'invert':
          this.input.tiltInvert = !this.input.tiltInvert;
          this.input.calibrateTilt();
          this.hud.toast(this.input.tiltInvert ? '倾斜方向已反转' : '倾斜方向已恢复');
          break;
        case 'pause':
          if (this.state === 'race' || this.state === 'countdown') this.pause();
          else if (this.state === 'paused') this.resume();
          break;
        case 'start': this.startRace(); break;
        case 'controls': this.hud.setScreen('controls'); break;
        case 'close-controls': this.hud.setScreen(this.state === 'race' ? null : this.state === 'paused' ? 'pause' : 'title'); break;
        case 'resume': this.resume(); break;
        case 'restart': this.startRace(); break;
        case 'retry': this.startRace(); break;
        case 'next': this.loadStage((this.stageIdx + 1) % STAGES.length, true); break;
        case 'menu': this.toMenu(); break;
      }
    };
    this.hud.onStage = (i) => {
      if (i === this.stageIdx) {
        this.sfx.ensure();
        this.startRace();
      } else this.loadStage(i);
    };
    this.hud.onQuality = (q) => {
      this.settings.quality = q;
      writeJSON(SKEY, this.settings);
      this.hud.setQualityUI(q);
      if (this.world) this.world.setQuality(QUALITY[q]);
      this.hud.toast(`画质：${q === 'low' ? '低' : q === 'medium' ? '中' : '高'}`);
    };
    this.hud.onTilt = (v) => {
      this.settings.tilt = !!v;
      writeJSON(SKEY, this.settings);
      this.hud.setTiltUI(!!v);
      if (v) this.enableTilt();
      else this.input.disableTilt();
    };
    this.hud.onCamera = (c) => {
      this.cameraMode = c;
      if (this.world) this.world._camInit = false;
      this.settings.camera = c;
      writeJSON(SKEY, this.settings);
      this.hud.setCameraUI(c);
    };
    this.hud.el.vol.addEventListener('input', () => {
      this.settings.volume = +this.hud.el.vol.value / 100;
      this.applyVolume();
      writeJSON(SKEY, this.settings);
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === '`' || e.key === 'F2') {
        this.debugOn = !this.debugOn;
        if (this.hud.el.dbg) this.hud.el.dbg.classList.toggle('on', this.debugOn);
      }
      if (e.key === 'Enter' && this.state === 'title' && this.hud.screen === 'title') this.startRace();
      if (e.key === 'Enter' && this.state === 'finished') this.loadStage((this.stageIdx + 1) % STAGES.length, true);
    });
  }

  async startTiltCal() {
    if (!window.isSecureContext) {
      this.hud.el.tiltcal.classList.remove('on');
      this.hud.toast('倾斜转向需要 HTTPS 页面 · 当前是 HTTP');
      return;
    }
    this.ensureFullscreen();
    if (!this.input.tiltOn) {
      const ok = await this.input.requestTiltPermission();
      if (!ok) {
        this.settings.tiltSign = 1;
        writeJSON(SKEY, this.settings);
        this.hud.el.tiltcal.classList.remove('on');
        this.hud.toast('传感器不可用 · 已保持默认方向');
        return;
      }
      this.input.enableTilt();
    }
    // give the neutral calibration a moment, then sample the deliberate right tilt
    this.tiltCal = { phase: 0, t: -0.7, sum: 0, n: 0, right: 0, left: 0 };
    if (this.hud.el.tiltlive) this.hud.el.tiltlive.textContent = '准备… 先向右压住手机';
    this.hud.toast('先向右压住手机，保持 1 秒');
  }

  finishTiltCal() {
    const c = this.tiltCal;
    this.tiltCal = null;
    const live = this.hud.el.tiltlive;
    const ok = c && Math.abs(c.right) > 5 && Math.abs(c.left) > 5 && Math.sign(c.right) !== Math.sign(c.left);
    if (ok) {
      // whatever the sensor convention is, "right" is now defined by the player's own motion
      this.settings.tiltSign = c.right > 0 ? 1 : -1;
      this.settings.tiltSignV = 2;
      this.input.tiltInvert = false;
      this.input.tiltSign = this.settings.tiltSign;
    } else {
      this.settings.tiltSign = 1;
      this.settings.tiltSignV = 2;
      this.input.tiltSign = 1;
    }
    writeJSON(SKEY, this.settings);
    this.hud.el.tiltcal.classList.remove('on');
    if (live) live.textContent = ok ? '方向已确定 ✓' : '检测失败，请重试';
    this.hud.toast(ok ? (this.settings.tiltSign > 0 ? '方向已设定：向右压 = 右转' : '方向已设定：已自动纠正反向')
                      : '检测失败 · 可重试或直接开始');
  }

  lockLandscape() {
    try {
      if (window.screen && screen.orientation && screen.orientation.lock) {
        const p = screen.orientation.lock('landscape');
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) { /* iOS Safari has no orientation lock */ }
  }

  // phones: go fullscreen and try to lock landscape (Chrome requires fullscreen for it)
  enterImmersive() {
    if (!isTouch()) return;
    try {
      if (!(document.fullscreenElement || document.webkitFullscreenElement)) {
        const req = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
        if (req) {
          const p = req.call(document.documentElement);
          if (p && p.then) p.then(() => this.lockLandscape()).catch(() => this.lockLandscape());
          else this.lockLandscape();
          return;
        }
      }
    } catch (e) { /* fall through to the rotate hint */ }
    this.lockLandscape();
  }

  toggleFullscreen() {
    const el = document.documentElement;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFs) {
      try { if (window.screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
      setTimeout(() => this.updateFsLabel(), 250);
      return;
    }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) {
      this.hud.toast('当前环境不支持全屏');
      return;
    }
    try {
      const p = req.call(el);
      if (p && p.then) p.then(() => this.lockLandscape()).catch(() => this.hud.toast('当前环境不支持全屏'));
      setTimeout(() => this.updateFsLabel(), 400);
    } catch (e) {
      this.hud.toast('当前环境不支持全屏');
    }
  }

  updateFsLabel() {
    const b = this.hud.el.fs;
    if (!b) return;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    b.textContent = isFs ? '退出全屏' : '全屏';
  }

  applyVolume() {
    this.sfx.setVolume(this.settings.muted ? 0 : this.settings.volume);
  }

  get quality() {
    return QUALITY[this.settings.quality] || QUALITY.medium;
  }

  async enableTilt() {
    if (!isTouch() || this.input.tiltOn) return;
    if (!window.isSecureContext) {
      this.hud.toast('倾斜转向需要 HTTPS 页面 · 请用 https:// 打开');
      return;
    }
    const ok = await this.input.requestTiltPermission();
    if (!ok) {
      this.hud.toast('没有传感器权限 · 可用触屏转向');
      return;
    }
    this.input.enableTilt();
    this.input.calibrateTilt();
    this.ensureFullscreen();
    this.hud.toast('倾斜转向已开启 · 左右倾斜手机转向');
    // if the browser never delivers sensor data, fall back to touch steering
    setTimeout(() => {
      if (this.input.tiltOn && !this.input.tiltGotData) {
        this.settings.tilt = false;
        writeJSON(SKEY, this.settings);
        this.hud.setTiltUI(false);
        this.input.disableTilt();
        this.hud.toast('未检测到重力传感器 · 已切回触屏转向');
      }
      else if (this.input.tiltOn && this.input.tiltGotData) this.hud.toast('重力传感器已就绪');
    }, 1800);
  }

  async boot() {
    if (this._booted) return;
    this._booted = true;
    this.hud.setBoot(6, '正在生成赛道…');
    await tick();
    this.stage = buildStage(STAGES[this.stageIdx]);
    this.hud.setBoot(30, '正在架设地形与雪坡…');
    await tick();
    this.world = new World(this.renderer, this.stage, this.stage.theme, this.quality);
    this.hud.setBoot(72, '正在种下杉树…');
    await tick();
    this.carRig = createCar(this.stage, this.stage.theme.key);
    this.car = this.carRig.car;
    this.onResize();
    this.hud.setStage(this.stage, this.bests[this.stage.seed]);
    this.hud.setBoot(92, '正在预热镜头…');
    await tick();
    this.world.update(0.016, this.car, this.cameraMode);
    this.world.render();
    this.world.update(0.016, this.car, this.cameraMode);
    this.onResize(true);
    this.world.render(); // paint once before the boot layer fades, so no white frame
    this.hud.setBoot(100, '准备发车');
    await tick();
    this.hud.hideBoot();
    this.toMenu();
    requestAnimationFrame(this.frame);
  }

  async loadStage(i, autoStart = false) {
    if (this.state === 'boot') return;
    this.state = 'boot';
    try {
      await this._loadStage(i, autoStart);
    } catch (e) {
      console.error('[rally] stage load failed', e);
      if (this.world) {
        try { this.world.dispose(); } catch (_) {}
        this.world = null;
      }
      this.state = 'title';
      this.hud.hideBoot();
      this.hud.setScreen('title');
      this.hud.toast('赛道加载失败，请重试');
    }
  }

  async _loadStage(i, autoStart = false) {
    this.hud.setScreen('title');
    this.hud.showBoot();
    this.hud.setBoot(4, '正在生成赛道…');
    this.stageIdx = i;
    location.hash = `s${i + 1}`;
    await tick();
    if (this.world) {
      this.world.dispose();
      this.world = null;
    }
    this.stage = buildStage(STAGES[i]);
    STAGES[i].length = this.stage.totalLength; // keep the title-screen card honest
    this.hud.setBoot(34, '正在架设地形与雪坡…');
    await tick();
    this.world = new World(this.renderer, this.stage, this.stage.theme, this.quality);
    this.hud.setBoot(76, '正在种下杉树…');
    await tick();
    this.carRig = createCar(this.stage, this.stage.theme.key);
    this.car = this.carRig.car;
    this.hud.setStage(this.stage, this.bests[this.stage.seed]);
    this.world.update(0.016, this.car, this.cameraMode);
    this.onResize(true);
    this.world.render(); // paint once before the boot layer fades, so no white frame
    this.hud.setBoot(100, '准备发车');
    await tick();
    this.hud.hideBoot();
    this.toMenu();
    if (autoStart) this.startRace();
  }

  toMenu() {
    this.state = 'title';
    this.sfx.silence();
    this.hud.countdown('');
    this.countdownT = 0;
    this.goTimer = 0;
    // the title camera orbits the start line, so the car belongs there too
    this.carRig.reset(true);
    this.titleT = 0;
    this.hud.setStage(this.stage, this.bests[this.stage.seed]);
    this.hud.renderStageList(this.stageIdx, this.bests);
    this.hud.setScreen('title');
  }

  // races default to immersive: fullscreen + landscape (best for tilt and touch alike)
  ensureFullscreen() {
    if (this.state === 'finished') return;
    const el = document.documentElement;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFs) { this.lockLandscape(); return; }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      const p = req.call(el, { navigationUI: 'hide' });
      if (p && p.then) p.then(() => this.lockLandscape()).catch(() => {});
      else this.lockLandscape();
    } catch (e) { /* not a user gesture: ignore */ }
  }

  startRace() {
    this.sfx.ensure();
    this.sfx.resume();
    this.applyVolume();
    this.enterImmersive();
    if (isTouch() && this.settings.tilt) this.enableTilt();
    this.ensureFullscreen();
    this.carRig.reset(true);
    this.car.topSpeed = 0;
    this.offTrackT = 0;
    this.offTrackAt = -99;
    if (this.world) this.world._camInit = false;
    this.time = 0;
    this.penalty = 0;
    this.hud.setPenalty(0);
    this.acc = 0;
    this.splitIdx = 0;
    this.splits = [];
    this.noteIdx = 0;
    this.countdownT = 3.0;
    this.goTimer = 0;
    this.countStage = 3;
    this.state = 'countdown';
    this.hud.setScreen(null);
    this.hud.el.hud.classList.add('on');
    this.hud.countdown('3');
    this.car.bump = 0;
  }

  pause() {
    if (this.state !== 'race' && this.state !== 'countdown') return;
    this.pausedFrom = this.state;
    this.state = 'paused';
    this.hud.setScreen('pause');
    this.sfx.silence();
    if (this.sfx.master) this.sfx.master.gain.value = 0;
    this.sfx.suspend();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = this.pausedFrom || 'race';
    this.hud.setScreen(null);
    this.sfx.resume();
    this.applyVolume();
  }

  onResize(force = false) {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    if (!force && w === this._rsW && h === this._rsH && pr === this._rsPr) return;
    this._rsW = w; this._rsH = h; this._rsPr = pr;
    this.renderer.setSize(w, h, true);
    if (this.world) this.world.resize();
  }

  resetToTrack() {
    if (this.state !== 'race' && this.state !== 'countdown') return;
    this.carRig.reset();
    // keep split bookkeeping consistent with the new position (and drop over-shot marks)
    if (this.stage && this.splits) {
      this.splits = this.splits.filter((sp) => sp.s <= this.car.s);
      let i = 0;
      while (i < this.stage.splits.length && this.car.s >= this.stage.splits[i]) i++;
      this.splitIdx = i;
    }
    if (this.state === 'race') {
      // rally rules: using the recovery is paid for with a time penalty
      this.time += 15000;
      this.penalty += 15000;
      this.hud.setPenalty(this.penalty);
      this.hud.toast('回到赛道 · +15 秒罚时');
    } else {
      this.hud.toast('已回到赛道');
    }
  }

  pollActions() {
    for (const a of this.input.takeActions()) {
      if (a === 'pause') {
        if (this.state === 'race' || this.state === 'countdown') this.pause();
        else if (this.state === 'paused') this.resume();
      }
      if (a === 'reset') this.resetToTrack();
      if (a === 'camera') {
        this.cameraMode = (this.cameraMode + 1) % 3;
        if (this.world) this.world._camInit = false;
        this.settings.camera = this.cameraMode;
        writeJSON(SKEY, this.settings);
        this.hud.setCameraUI(this.cameraMode);
      }
      if (a === 'mute') {
        this.settings.muted = !this.settings.muted;
        writeJSON(SKEY, this.settings);
        this.applyVolume();
        this.hud.toast(this.settings.muted ? '静音' : '恢复音量');
      }
    }
  }

  bestFor(seed) {
    return this.bests[seed] || null;
  }

  // expected time at a distance, interpolated from the best run's splits
  expectedAt(s) {
    const best = this.bestFor(this.stage.seed);
    if (!best || !best.splits || best.splits.length < 2) return null;
    const sp = best.splits;
    if (s <= sp[0].s) return (sp[0].time * s) / Math.max(1, sp[0].s);
    for (let i = 1; i < sp.length; i++) {
      if (s <= sp[i].s) {
        const a = sp[i - 1];
        const b = sp[i];
        return a.time + ((s - a.s) / Math.max(1, b.s - a.s)) * (b.time - a.time);
      }
    }
    return best.time;
  }

  recordSplit(s) {
    this.splits.push({ s, time: this.time });
  }

  finish() {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.sfx.silence();
    this.hud.countdown('');
    this.goTimer = 0;
    this.sfx.finish();
    const prev = this.bestFor(this.stage.seed);
    this.recordSplit(this.stage.totalLength);
    const best = !prev || this.time < prev.time;
    const clean = this.penalty === 0;
    const rec = this.bests[this.stage.seed] || {};
    if (best) {
      rec.time = this.time;
      rec.splits = this.splits;
      rec.clean = clean;
    }
    if (clean && (!Number.isFinite(rec.cleanBest) || this.time < rec.cleanBest)) rec.cleanBest = this.time;
    this.bests[this.stage.seed] = rec;
    writeJSON(BKEY, this.bests);
    this.hud.el.hud.classList.remove('on');
    this.hud.showFinish({
      stage: this.stage,
      time: this.time,
      prevBest: prev ? prev.time : null,
      topSpeed: this.car.topSpeed,
      raw: Math.max(0, this.time - this.penalty),
      penalty: this.penalty,
      clean,
      newBest: best,
    });
  }

  step(dt) {
    this.acc += dt;
    let n = 0;
    while (this.acc >= FIXED && n < 20) {
      this.carRig.step(FIXED, this.input.state);
      this.acc -= FIXED;
      n++;
    }
  }

  frame = (now) => {
    try {
      this._frame(now);
    } catch (e) {
      this.errorCount = (this.errorCount || 0) + 1;
      this.lastError = e && (e.stack || e.message || String(e));
      if (this.errorCount < 4) console.error('[frame]', e);
    }
    requestAnimationFrame(this.frame);
  };

  _frame = (now) => {
    const raw = (now - this.last) / 1000;
    this.last = now;
    const dt = clamp(raw || 0.016, 0.001, 0.05);
    // the stage clock follows wall time (capped at 250 ms) so a dropped frame does not
    // hand out free tenths; physics still runs on the clamped dt
    const clockDt = Math.min(raw || 0.016, 0.25);

    this.pollActions();
    this.input.poll(dt);

    const racing = this.state === 'race';
    const counting = this.state === 'countdown';

    if (counting) {
      this.countdownT -= clockDt;
      const n = Math.ceil(this.countdownT);
      if (n !== this.countStage) {
        this.countStage = n;
        if (n > 0 && n <= 3) {
          this.hud.countdown(String(n));
          this.sfx.countdown(n);
        } else if (n <= 0) {
          this.hud.countdown('GO', true);
          this.sfx.countdown(0);
          this.state = 'race'; // the clock starts on GO
          this.goTimer = 0.6;
        }
      }
    }
    if (this.goTimer > 0) {
      this.goTimer -= dt;
      if (this.goTimer <= 0) this.hud.countdown('');
    }

    if (racing) {
      this.time += clockDt * 1000;
      this.step(dt);
      // splits
      while (this.splitIdx < this.stage.splits.length && this.car.s >= this.stage.splits[this.splitIdx]) {
        this.recordSplit(this.stage.splits[this.splitIdx]);
        this.splitIdx++;
      }
      if (this.car.s >= this.stage.totalLength - 12) this.finish();
      // straying far from the stage or wedged in the snow: point at the reset key
      this.offTrackT = this.car.distance > 14 ? this.offTrackT + dt : 0;
      const carSpeed = Math.hypot(this.car.vx, this.car.vz);
      this.stuckT = carSpeed < 1.5 && this.car.grounded ? (this.stuckT || 0) + dt : 0;
      if ((this.offTrackT > 2.5 || this.stuckT > 2.5) && this.time - this.offTrackAt > 8000) {
        this.offTrackAt = this.time;
        this.hud.toast('偏离赛道或卡住了 · 按 R 回到路面（+15 秒罚时）');
      }
    } else if (this.state === 'title') {
      this.titleT += dt;
    }

    // pace notes
    let note = null;
    let noteDist = 0;
    if (this.stage) {
      const notes = this.stage.notes;
      while (this.noteIdx < notes.length && notes[this.noteIdx].s1 < this.car.s - 6) this.noteIdx++;
      const nx = notes[this.noteIdx];
      if (nx && nx.s0 - this.car.s < 165 && nx.s0 - this.car.s > -20) {
        note = nx;
        noteDist = Math.max(0, nx.s0 - this.car.s);
      }
    }

    // audio
    if (this.state === 'race' || this.state === 'countdown') this.sfx.update(dt, this.car);

    // camera / render
    if (this.state === 'title') {
      if (!this.world) return; // the outer frame() already schedules the next tick
      this.world.update(dt, this.car, this.cameraMode);
      const s = this.stage.start;
      const a = this.titleT * 0.15;
      const r = 15 + Math.sin(this.titleT * 0.23) * 2.5;
      this.world.camera.position.set(s.x + Math.sin(a) * r, s.y + 4.6 + Math.sin(this.titleT * 0.4) * 0.35, s.z + Math.cos(a) * r);
      this.world.camera.lookAt(s.x, s.y + 1.0, s.z);
      this.world.camera.fov = 58;
      this.world.camera.updateProjectionMatrix();
    } else if (this.state !== 'boot' && this.world) {
      this.world.update(this.state === 'paused' || this.state === 'finished' ? 0 : dt, this.car, this.cameraMode);
    }
    if (this.world && this.world.scene) {
      this.world.render();
      const pr = this.renderer.getPixelRatio();
      const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
      const vh = window.innerHeight || document.documentElement.clientHeight || 720;
      const ww = Math.max(1, Math.floor(vw * pr));
      const hh = Math.max(1, Math.floor(vh * pr));
      if (this.canvas.width !== ww || this.canvas.height !== hh) this.world.resize();
    }
    this._debug(clamp(dt, 0.001, 0.05));

    // HUD
    if (this.stage) {
      let delta = null;
      if (racing && this.time > 1500) {
        const exp = this.expectedAt(this.car.s);
        if (exp !== null) delta = this.time - exp;
      }
      const surfaceName =
        this.car.surface === 'road'
          ? this.stage.theme.key === 'snow' ? '压实雪' : this.stage.theme.key === 'mist' ? '湿滑柏油' : '砂石'
          : this.car.surface === 'shoulder' ? '路肩' : '深雪 · 慢';
      const speed = Math.hypot(this.car.vx, this.car.vz);
      this.hud.update({
        t: this.time / 1000,
        time: this.time,
        delta,
        speed,
        rpm: this.car.rpm,
        gear: this.car.gear,
        surface: surfaceName,
        note,
        noteDist,
        progress: this.car.progress,
        running: racing,
        car: this.car,
      });
    }

  };

  _tiltCalStep(dt) {
    const c = this.tiltCal;
    if (!c) return;
    const live = this.hud.el.tiltlive;
    c.t += dt;
    if (c.phase === 0) {
      if (c.t < 0) return;
      const t = this.input.tiltRawAxis;
      if (Number.isFinite(t)) { c.sum += t; c.n += 1; }
      if (live) live.textContent = '保持向右压住…';
      if (c.t > 1.0) {
        c.right = c.n ? c.sum / c.n : 0;
        c.phase = 1; c.t = -0.5; c.sum = 0; c.n = 0;
        if (live) live.textContent = '很好！现在向左压住手机';
      }
      return;
    }
    if (c.t < 0) return;
    const t = this.input.tiltRawAxis;
    if (Number.isFinite(t)) { c.sum += t; c.n += 1; }
    if (live) live.textContent = '保持向左压住…';
    if (c.t > 1.0) {
      c.left = c.n ? c.sum / c.n : 0;
      this.finishTiltCal();
    }
  }

  _autoQuality(dt) {
    if (this.state !== 'race' || !this.fps) return;
    if (!this._autoQ) this._autoQ = { slow: 0, done: false };
    const q = this._autoQ;
    if (q.done) return;
    if (this.fps < 30) q.slow += dt;
    else q.slow = Math.max(0, q.slow - dt * 0.5);
    if (q.slow > 3) {
      q.done = true;
      if (this.settings.quality !== 'low') {
        this.settings.quality = 'low';
        writeJSON(SKEY, this.settings);
        this.hud.setQualityUI('low');
        if (this.world) this.world.setQuality(QUALITY.low);
        this.hud.toast('帧率偏低 · 已自动切到低画质');
      }
    }
  }

  _debug(dt) {
    this.dbgT = (this.dbgT || 0) + dt;
    this.fps = this.fps ? this.fps * 0.92 + (1 / Math.max(0.001, dt)) * 0.08 : 1 / Math.max(0.001, dt);
    this._autoQuality(dt);
    this._tiltCalStep(dt);
    const el = this.hud.el.dbg;
    if (!el) return;
    const show = this.debugOn || !!this.lastError;
    el.classList.toggle('on', !!show);
    if (!show || this.dbgT < 0.15) return;
    this.dbgT = 0;
    const info = this.renderer.info.render;
    const gl = this.renderer.getContext();
    const ver = gl && gl.getParameter ? gl.getParameter(gl.VERSION) : '?';
    const cp = this.cameraPos || (this.world && this.world.camera.position);
    const carD = cp && this.car ? Math.hypot(cp.x - this.car.pos.x, cp.z - this.car.pos.z) : 0;
    const lines = [
      `${this.renderer.capabilities.isWebGL2 ? 'GL2' : 'GL1'} · ${this.canvas.width}×${this.canvas.height} · draws ${info.calls} · tris ${(info.triangles / 1000).toFixed(0)}k · ${(this.fps || 0).toFixed(0)}fps`,
      `${this.state} · ${['chase', 'hood', 'cockpit'][this.cameraMode] || 'chase'} · car s=${(this.car ? this.car.s : 0).toFixed(0)}m · cam-car ${carD.toFixed(1)}m · cam y=${this.world ? this.world.camera.position.y.toFixed(1) : '?'}`,
      String(ver).slice(0, 46),
    ];
    if (this.lastError) lines.push('ERR ' + String(this.lastError).split('\n')[0].slice(0, 110));
    else if (LOG.length) lines.push(LOG[LOG.length - 1].slice(0, 110));
    el.textContent = lines.join('\n');
    el.classList.toggle('bad', !!this.lastError || info.calls === 0);
  }
}

function showFatal(err) {
  console.error(err);
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:#080a0c;color:#ece8df;font:13px/1.7 ui-monospace,monospace;padding:24px;text-align:left';
  box.innerHTML = '<div style="max-width:640px"><b style="color:#ff6a1a">启动失败</b><br>这个浏览器可能不支持 WebGL2，或者渲染器初始化出错。<br><br><span style="color:#8a9099">' +
    String((err && err.message) || err).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</span></div>';
  document.body.appendChild(box);
}

try {
  const game = new Game();
  game.boot().catch(showFatal);
} catch (err) {
  showFatal(err);
}
