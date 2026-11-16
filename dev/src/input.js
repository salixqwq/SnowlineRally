// input.js — keyboard, gamepad and touch, all producing the same small state object.
import { clamp, damp } from './math.js';

export class Input {
  constructor() {
    this.keys = new Set();
    this.state = {
      steer: 0,
      throttle: 0,
      brake: 0,
      handbrake: false,
      reset: false,
    };
    this.actions = [];
    this.steerSmooth = 0;
    this.touch = { steer: 0, gas: false, brake: false, hand: false, active: false, pointerId: null };
    // device-tilt steering (mobile)
    this.tiltOn = false;
    this.tiltInvert = false;
    this.tiltValue = 0;
    this.tiltTarget = 0;
    this.tiltNeutral = null;
    this.tiltSamples = [];
    this._motionHandler = null;
    this._orientHandler = null;
    this.tiltGotData = false;
    this._hasMotion = false;
    this.tiltCalibN = 0;
    // native bridge (HarmonyOS ArkTS can feed a sensor-derived steering value)
    this.nativeSteer = null;
    this.padIndex = -1;

    if (typeof window !== 'undefined') {
      window.__rallySetSteer = (v) => { this.nativeSteer = clamp(Number(v) || 0, -1, 1); };
      window.__rallyClearSteer = () => { this.nativeSteer = null; };
    }

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (k === 'escape' || k === 'p') this.actions.push('pause');
      if (k === 'r') this.actions.push('reset');
      if (k === 'c') this.actions.push('camera');
      if (k === 'm') this.actions.push('mute');
      if (k === 'enter' && this.onEnter) this.actions.push('enter');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.touch.steer = 0;
      this.touch.gas = false;
      this.touch.brake = false;
      this.touch.hand = false;
      this.touch.active = false;
      this.touch.pointerId = null;
    });
  }

  bindTouch(root) {
    this.touchRoot = root;
    const zone = root.querySelector('[data-touch="steer"]');
    let startX = 0;
    const STEER_DEAD = 5; // px before the wheel reacts
    const setSteer = (px) => {
      const w = Math.max(40, Math.min(140, window.innerWidth * 0.22));
      const dx = px - startX;
      const usable = Math.max(1, w - STEER_DEAD);
      const dead = Math.sign(dx) * Math.min(Math.abs(dx), STEER_DEAD);
      this.touch.steer = clamp((dx - dead) / usable, -1, 1);
    };
    zone.addEventListener('pointerdown', (e) => {
      if (this.touch.pointerId !== null) return; // one finger owns the wheel
      this.touch.pointerId = e.pointerId;
      // relative drag: the touch point itself is neutral, so there is no jump on tap
      startX = e.clientX;
      try { zone.setPointerCapture(e.pointerId); } catch (_) {}
      this.touch.active = true;
      e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.touch.pointerId) return;
      setSteer(e.clientX);
      e.preventDefault();
    });
    const end = (e) => {
      if (this.touch.pointerId === null) return;
      if (e.pointerId !== this.touch.pointerId) return;
      this.touch.pointerId = null;
      this.touch.steer = 0;
      if (e.cancelable) e.preventDefault();
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
    // if the capture is lost outside the zone (some WebViews), never leave the wheel stuck
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    for (const btn of root.querySelectorAll('[data-hold]')) {
      const key = btn.dataset.hold;
      let downAt = 0;
      let latch = null;
      const on = (e) => {
        if (latch) { clearTimeout(latch); latch = null; }
        this.touch[key] = true;
        btn.classList.add('on');
        this.touch.active = true;
        downAt = performance.now();
        e.preventDefault();
      };
      const off = (e) => {
        this.touch[key] = false;
        btn.classList.remove('on');
        if (key === 'hand' && performance.now() - downAt < 450) {
          // tap-latch: makes "handbrake + throttle" possible with two thumbs
          this.touch.hand = true;
          btn.classList.add('on');
          latch = setTimeout(() => {
            this.touch.hand = false;
            btn.classList.remove('on');
            latch = null;
          }, 650);
        }
        e.preventDefault();
      };
      btn.addEventListener('pointerdown', on);
      btn.addEventListener('pointerup', off);
      btn.addEventListener('pointercancel', off);
      btn.addEventListener('pointerleave', off);
    }
  }

  screenAngle() {
    let a = 0;
    if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') a = window.screen.orientation.angle;
    else a = window.orientation || 0;
    return ((a % 360) + 360) % 360;
  }

  async requestTiltPermission() {
    const DM = window.DeviceMotionEvent;
    if (!DM) return false;
    if (typeof DM.requestPermission === 'function') {
      try {
        const r = await DM.requestPermission();
        return r === 'granted';
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  enableTilt() {
    if (this.tiltOn) return;
    this.tiltOn = true;
    this.tiltNeutral = null;
    this.tiltSamples = [];
    this.tiltValue = 0;
    this.tiltTarget = 0;
    this.tiltGotData = false;
    this._motionHandler = (e) => this._onMotion(e);
    this._orientHandler = (e) => this._onOrientation(e);
    window.addEventListener('devicemotion', this._motionHandler, { passive: true });
    window.addEventListener('deviceorientation', this._orientHandler, { passive: true });
    this.calibrateTilt();
  }

  disableTilt() {
    this.tiltOn = false;
    this.tiltValue = 0;
    this.tiltTarget = 0;
    if (this._motionHandler) window.removeEventListener('devicemotion', this._motionHandler);
    if (this._orientHandler) window.removeEventListener('deviceorientation', this._orientHandler);
    this._motionHandler = null;
    this._orientHandler = null;
    this.tiltGotData = false;
    this._hasMotion = false;
    this.tiltNeutral = null;
  }

  calibrateTilt(samples = 12) {
    // the next N samples define "straight ahead" (averaged, not a single reading)
    this.tiltNeutral = null;
    this.tiltSamples = [];
    this.tiltCalibN = samples;
  }

  // Screen-frame components of the accelerometer vector (proper acceleration = "up").
  // content axes in device coords: right = (cos a, -sin a), up = (sin a, cos a)
  tiltVec(g) {
    let a = this.screenAngle();
    const mq = window.matchMedia ? window.matchMedia('(orientation: landscape)') : null;
    if (mq) {
      // some devices report a stale angle right after rotating; trust the viewport instead
      if (mq.matches && (a === 0 || a === 180)) a = 90;
      else if (!mq.matches && (a === 90 || a === 270)) a = 0;
    }
    const r = (a * Math.PI) / 180;
    return {
      rx: Math.cos(r) * g.x - Math.sin(r) * g.y, // + = right on screen
      uy: Math.sin(r) * g.x + Math.cos(r) * g.y, // + = up on screen
    };
  }

  // Steering angle in degrees, positive when the phone is rotated clockwise (like a wheel)
  tiltAngle(g) {
    const { rx, uy } = this.tiltVec(g);
    if (Math.hypot(rx, uy) < 3) return null; // phone lying flat: no usable roll reference
    return (Math.atan2(-rx, uy) * 180) / Math.PI;
  }

  _onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y)) return;
    this._hasMotion = true;
    const ang = this.tiltAngle(g);
    if (ang !== null) this._applyTiltAngle(ang);
  }

  // fallback for devices that only expose orientation angles: rebuild the proper
  // acceleration vector from beta/gamma and use the same angle logic
  _onOrientation(e) {
    if (this._hasMotion) return; // motion events are the better source
    const beta = ((e.beta || 0) * Math.PI) / 180;
    const gamma = ((e.gamma || 0) * Math.PI) / 180;
    const g = {
      x: -9.81 * Math.cos(beta) * Math.sin(gamma),
      y: 9.81 * Math.sin(beta),
    };
    const ang = this.tiltAngle(g);
    if (ang !== null) this._applyTiltAngle(ang);
  }

  _applyTiltAngle(deg) {
    if (!Number.isFinite(deg)) return;
    if (this.tiltNeutral === null) {
      // average a handful of samples so a shaky first frame does not become "straight"
      this.tiltSamples.push(deg);
      this.tiltCalibN = (this.tiltCalibN || 12) - 1;
      if (this.tiltCalibN > 0) return;
      this.tiltNeutral = this.tiltSamples.reduce((x, y) => x + y, 0) / Math.max(1, this.tiltSamples.length);
      this.tiltSamples = [];
      this.tiltGotData = true;
      return;
    }
    this.tiltGotData = true;
    const d = deg - this.tiltNeutral;
    this.tiltRawAxis = d;
    const DZ = 7;   // dead zone in degrees: micro-adjustments around neutral do nothing
    const FULL = 40; // degrees for full lock (gentler than before)
    let v = 0;
    if (Math.abs(d) > DZ) v = Math.sign(d) * Math.min(1, (Math.abs(d) - DZ) / (FULL - DZ));
    const sign = (this.tiltSign || 1) * (this.tiltInvert ? -1 : 1);
    this.tiltTarget = clamp(v * sign, -1, 1);
  }

  poll(dt = 1 / 60) {
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    let steer = 0;
    let throttle = 0;
    let brake = 0;
    let hand = false;

    const k = this.keys;
    if (k.has('a') || k.has('arrowleft')) steer -= 1;
    if (k.has('d') || k.has('arrowright')) steer += 1;
    if (k.has('w') || k.has('arrowup')) throttle = 1;
    if (k.has('s') || k.has('arrowdown')) brake = 1;
    if (k.has(' ') || k.has('shift')) hand = true;

    if (pad) {
      const ax = pad.axes[0] || 0;
      if (Math.abs(ax) > 0.12) steer += ax;
      const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
      const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
      throttle = Math.max(throttle, rt);
      brake = Math.max(brake, lt);
      if (pad.buttons[0] && pad.buttons[0].pressed) hand = true;
      // edge detection: holding Start/Y must not fire every frame
      if (pad.buttons[9] && pad.buttons[9].pressed) {
        if (!this._padPause) this.actions.push('pause');
        this._padPause = true;
      } else this._padPause = false;
      if (pad.buttons[3] && pad.buttons[3].pressed) {
        if (!this._padReset) this.actions.push('reset');
        this._padReset = true;
      } else this._padReset = false;
      if (pad.buttons[2] && pad.buttons[2].pressed && !this._padCam) {
        this._padCam = true;
        this.actions.push('camera');
      }
      if (!(pad.buttons[2] && pad.buttons[2].pressed)) this._padCam = false;
    }

    if (this.tiltOn) {
      // tilt only: rate-limited follow so sensor noise never twitches the wheel
      const k = Math.max(0.001, dt);
      const delta = clamp(this.tiltTarget - this.tiltValue, -2.4 * k, 2.4 * k);
      this.tiltValue += delta;
      // dragging the touch wheel overrides the tilt while the finger is down
      if (Math.abs(this.touch.steer) < 0.05) steer += this.tiltValue;
    }
    if (this.nativeSteer !== null) steer += this.nativeSteer;
    if (this.touch.active) {
      steer += this.touch.steer;
      if (this.touch.gas) throttle = 1;
      if (this.touch.brake) brake = 1;
      if (this.touch.hand) hand = true;
    }

    steer = clamp(steer, -1, 1);
    // keyboard steering is on/off: give it a ramp so the car does not snap
    const rate = Math.abs(steer) > Math.abs(this.steerSmooth) ? 3.6 : 6.5;
    this.steerSmooth = damp(this.steerSmooth, steer, rate, Math.max(0.001, dt));

    this.state.steer = this.steerSmooth;
    this.state.throttle = clamp(throttle, 0, 1);
    this.state.brake = clamp(brake, 0, 1);
    this.state.handbrake = hand;
    return this.state;
  }

  takeActions() {
    const a = this.actions;
    this.actions = [];
    return a;
  }
}
