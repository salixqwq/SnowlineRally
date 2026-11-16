import { buildStage, STAGES } from './src/track.js';
import { createCar } from './src/physics.js';
import { clamp } from './src/math.js';

// a competent-but-dumb driver: pure pursuit + corner speed planning + reverse when wedged
function drive(stage, cfg) {
  const { car, step } = createCar(stage, cfg.theme);
  const dt = 1 / 120;
  let t = 0, off = 0, maxD = 0, stuck = 0, reverse = 0, finish = false, maxLat = 0, maxSlip = 0;
  for (let i = 0; i < 120 * 400; i++) {
    const v = Math.hypot(car.vx, car.vz);
    const idx = clamp(Math.round(car.s / 4), 0, stage.samples.length - 1);
    const look = 10 + v * 0.8;
    const ahead = stage.samples[Math.min(stage.samples.length - 1, idx + Math.round(look / 4))];
    const want = Math.atan2(ahead.x - car.pos.x, ahead.z - car.pos.z);
    let err = want - car.yaw;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    let steer = clamp(-err * 2.0 - car.yawRate * 0.2, -1, 1);

    let minR = 999;
    for (let j = idx; j < Math.min(stage.samples.length, idx + 35); j++) minR = Math.min(minR, stage.samples[j].radius);
    const target = clamp(Math.sqrt(0.5 * 9.81 * Math.max(12, minR)), 8, 42);

    let throttle = 0, brake = 0;
    if (reverse > 0) {
      reverse -= dt;
      brake = 1;
      steer = -steer;
    } else {
      throttle = v < target ? 1 : 0;
      brake = v > target + 0.5 ? clamp((v - target) / 3, 0.15, 1) : 0;
      stuck = v < 1.5 ? stuck + dt : 0;
      if (stuck > 1.2) { reverse = 1.1; stuck = 0; }
    }
    step(dt, { steer, throttle, brake, handbrake: false });
    t += dt;
    if (car.surface === 'offroad') off += dt;
    maxD = Math.max(maxD, car.distance);
    maxLat = Math.max(maxLat, Math.abs(car.lat));
    maxSlip = Math.max(maxSlip, car.slip);
    if (car.s > stage.totalLength - 15) { finish = true; break; }
  }
  return { finish, t: +t.toFixed(0), avg: +(stage.totalLength / t * 3.6).toFixed(0), off: +off.toFixed(0), maxD: +maxD.toFixed(0), maxLat: +maxLat.toFixed(1), maxSlip: +maxSlip.toFixed(2), nan: !Number.isFinite(car.pos.x + car.pos.y + car.pos.z + car.yaw) };
}
for (const cfg of STAGES) {
  console.log(cfg.theme.padEnd(6), JSON.stringify(drive(buildStage(cfg), cfg)));
}
