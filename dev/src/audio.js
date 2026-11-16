// audio.js — everything is synthesised: engine, transmission whine, gravel, wind, bells.
// The context is created on the first user gesture (browser autoplay rules).
export class Sound {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.volume = 0.7;
    this.lastGear = 1;
    this.rpmSm = 1200;
    this.turbo = 0;
    this.spool = 0;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try {
      ctx = new AC();
    } catch (e) {
      console.warn('[rally] audio unavailable', e);
      this.ready = false;
      return;
    }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);

    // a 2 second noise buffer reused by everything
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // ---- engine ----
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 900;
    this.engFilter.Q.value = 3.5;
    this.engGain.connect(this.engFilter).connect(this.master);

    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscB = ctx.createOscillator();
    this.oscB.type = 'square';
    this.oscC = ctx.createOscillator();
    this.oscC.type = 'sawtooth';
    this.oscC.detune.value = 9;
    const oa = ctx.createGain();
    oa.gain.value = 0.5;
    const ob = ctx.createGain();
    ob.gain.value = 0.22;
    const oc = ctx.createGain();
    oc.gain.value = 0.3;
    this.oscA.connect(oa).connect(this.engGain);
    this.oscB.connect(ob).connect(this.engGain);
    this.oscC.connect(oc).connect(this.engGain);
    this.oscA.start();
    this.oscB.start();
    this.oscC.start();

    // intake rasp
    this.rasp = ctx.createBufferSource();
    this.rasp.buffer = buf;
    this.rasp.loop = true;
    this.raspFilter = ctx.createBiquadFilter();
    this.raspFilter.type = 'bandpass';
    this.raspFilter.frequency.value = 1400;
    this.raspFilter.Q.value = 0.9;
    this.raspGain = ctx.createGain();
    this.raspGain.gain.value = 0;
    this.rasp.connect(this.raspFilter).connect(this.raspGain).connect(this.master);
    this.rasp.start();

    // ---- gravel / snow ----
    this.gravel = ctx.createBufferSource();
    this.gravel.buffer = buf;
    this.gravel.loop = true;
    this.gravelFilter = ctx.createBiquadFilter();
    this.gravelFilter.type = 'lowpass';
    this.gravelFilter.frequency.value = 1200;
    this.gravelGain = ctx.createGain();
    this.gravelGain.gain.value = 0;
    this.gravel.connect(this.gravelFilter).connect(this.gravelGain).connect(this.master);
    this.gravel.start();

    // ---- wind ----
    this.wind = ctx.createBufferSource();
    this.wind.buffer = buf;
    this.wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'highpass';
    this.windFilter.frequency.value = 700;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.wind.start();

    // ---- turbo whistle ----
    this.whistle = ctx.createOscillator();
    this.whistle.type = 'sine';
    this.whistle.frequency.value = 2400;
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    this.whistle.connect(this.whistleGain).connect(this.master);
    this.whistle.start();

    this.ready = true;
  }

  silence() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    for (const g of [this.engGain, this.raspGain, this.gravelGain, this.windGain, this.whistleGain]) {
      if (g) g.gain.setTargetAtTime(0, now, 0.04);
    }
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  update(dt, car) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const rpm = car.rpm || 900;
    this.rpmSm += (rpm - this.rpmSm) * Math.min(1, dt * 14);
    const firing = (this.rpmSm / 60) * 2; // 4-cylinder firing frequency
    const on = car.throttle;
    const load = 0.35 + on * 0.65;
    const speed = Math.hypot(car.vx, car.vz);

    this.oscA.frequency.setTargetAtTime(firing, now, 0.03);
    this.oscB.frequency.setTargetAtTime(firing * 0.5, now, 0.03);
    this.oscC.frequency.setTargetAtTime(firing * 2.02, now, 0.03);
    const cutoff = 380 + this.rpmSm * 0.55 + on * 900;
    this.engFilter.frequency.setTargetAtTime(cutoff, now, 0.04);
    this.engGain.gain.setTargetAtTime(0.14 * load + 0.05, now, 0.05);

    this.raspGain.gain.setTargetAtTime(0.035 + on * 0.07, now, 0.05);
    this.raspFilter.frequency.setTargetAtTime(900 + this.rpmSm * 0.35, now, 0.06);

    // gravel hiss from speed + slip, louder off the packed line
    const off = car.surface === 'offroad' ? 1.6 : car.surface === 'shoulder' ? 1.15 : 0.8;
    const gravelAmt = Math.min(1, speed / 32) * (0.5 + car.slip * 0.8) * off;
    this.gravelGain.gain.setTargetAtTime(0.16 * gravelAmt, now, 0.08);
    this.gravelFilter.frequency.setTargetAtTime(600 + speed * 26 + car.slip * 500, now, 0.1);

    this.windGain.gain.setTargetAtTime(Math.min(0.22, speed * 0.006), now, 0.2);
    this.windFilter.frequency.setTargetAtTime(500 + speed * 18, now, 0.2);

    // turbo builds with throttle and rpm, releases on lift
    const targetSpool = on > 0.25 && car.gear > 1 ? Math.min(1, (this.rpmSm - 2600) / 3200) : 0;
    this.spool += (targetSpool - this.spool) * Math.min(1, dt * (targetSpool > this.spool ? 2.2 : 5));
    this.whistle.frequency.setTargetAtTime(1500 + this.spool * 3400, now, 0.05);
    this.whistleGain.gain.setTargetAtTime(this.spool * 0.018, now, 0.1);

    if (car.gear !== this.lastGear) {
      this.lastGear = car.gear;
      this.shiftPop(car.throttle > 0.6);
    }
  }

  _bleep(freq, dur, type = 'square', gain = 0.12, when = 0) {
    if (!this.ready) return;
    try {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
    } catch (e) {
      this.ready = false;
    }
  }

  _noiseBurst(dur, freq, gain, type = 'lowpass') {
    if (!this.ready) return;
    try {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
    } catch (e) {
      this.ready = false;
    }
  }

  shiftPop(hard) {
    this._noiseBurst(0.12, hard ? 2600 : 1600, hard ? 0.18 : 0.1, 'bandpass');
  }

  bump(strength) {
    this._noiseBurst(0.18, 300, Math.min(0.28, 0.08 + strength * 0.02));
  }

  countdown(n) {
    this._bleep(n === 0 ? 880 : 440, n === 0 ? 0.42 : 0.16, 'square', 0.13);
  }

  finish() {
    this._bleep(660, 0.18, 'triangle', 0.12, 0);
    this._bleep(880, 0.18, 'triangle', 0.12, 0.16);
    this._bleep(1320, 0.5, 'triangle', 0.12, 0.32);
  }

  ui(kind = 'click') {
    this._bleep(kind === 'click' ? 1200 : 700, 0.05, 'square', 0.05);
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
}
