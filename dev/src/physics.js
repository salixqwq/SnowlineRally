// physics.js — arcade rally car on a slip-angle bicycle model (the model every racing game
// starts from): front/rear slip angles -> saturating tyre forces -> yaw moment, with
// longitudinal weight transfer and a handbrake that locks the rear axle.
// Pure: no three.js, no DOM, so it can be simulated in node.
import { clamp, damp, lerp, smoothstep, signOf, wrapAngle, angleDelta } from './math.js';

export const CAR = {
  mass: 1250,
  inertia: 2050, // kg m^2 about the vertical axis
  wheelbase: 2.62,
  frontAxle: 1.14, // CG -> front axle
  rearAxle: 1.48, // CG -> rear axle
  track: 1.58,
  wheelRadius: 0.345,
  cgHeight: 0.52,
  gearRatios: [3.6, 2.42, 1.78, 1.36, 1.08, 0.87],
  finalDrive: 4.1,
  idleRpm: 900,
  maxRpm: 7600,
  shiftRpm: 7100,
  torquePeak: 460,
  driveSplit: 0.52, // front share of the AWD torque
  drag: 0.00042,
  rollResist: 0.3,
  steerMax: 0.45, // rad at a standstill
  steerMin: 0.07, // rad at top speed
  tyreB: 10, // cornering stiffness: peak grip around 10 deg of slip
  tyreC: 1.5, // shape: how sharply grip falls past the peak
  yawDamp: 0.2, // tyre scrub damping, not a handling aid
  brakeFront: 0.72, // front share of the foot brake (rear stays inside its grip)
  rearTyreMu: 0.95, // rear tyre specification (slightly loose rear = easier rotation)
  escGain: 3.0, // stability control strength (0 = off)
  muScale: 1, // overall surface grip multiplier
};

const SURFACES = {
  snow: { road: 0.78, shoulder: 0.62, offroad: 0.5, drag: 1.05, name: '压实雪', muScale: 1 },
  dusk: { road: 0.9, shoulder: 0.7, offroad: 0.58, drag: 1.18, name: '砂石' },
  mist: { road: 0.96, shoulder: 0.76, offroad: 0.62, drag: 1.06, name: '湿滑柏油' },
};

export function createCar(stage, themeKey) {
  const surf = SURFACES[themeKey] || SURFACES.snow;
  const g = 9.81;
  const L = CAR.wheelbase;

  const car = {
    stage,
    surf,
    pos: { x: stage.start.x, y: stage.start.y, z: stage.start.z },
    yaw: stage.start.yaw,
    vx: 0,
    vz: 0,
    vy: 0,
    yawRate: 0,
    speed: 0,
    lat: 0,
    ax: 0,
    ay: 0,
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: 0,
    gear: 1,
    rpm: CAR.idleRpm,
    grounded: true,
    airTime: 0,
    slip: 0,
    driftAngle: 0,
    surface: 'road',
    wheelSpin: 0,
    pitch: 0,
    roll: 0,
    suspension: [0, 0, 0, 0],
    bump: 0,
    lastImpact: 0,
    s: 0,
    progress: 0,
    offTrack: 0,
    hitCooldown: 0,
    distance: 0,
    topSpeed: 0,
  };

  const wheelPos = [
    { x: 0.79, z: 1.31, front: true },
    { x: -0.79, z: 1.31, front: true },
    { x: 0.79, z: -1.31, front: false },
    { x: -0.79, z: -1.31, front: false },
  ];

  let prevGround = car.pos.y;
  let climbSmooth = 0;
  let axSmooth = 0;

  function surfaceAt(dist) {
    if (dist < 5.4) return 'road';
    if (dist < 9.5) return 'shoulder';
    return 'offroad';
  }

  function reset(toStart = false) {
    let idx = 0;
    if (!toStart) {
      const ri = stage.roadInfo(car.pos.x, car.pos.z);
      // the spatial hash can pick a wrong segment when far off-road: only trust it when
      // the hit is close and consistent with the last known distance
      const safe = ri.idx >= 0 && ri.dist < 30 && Math.abs(ri.s - car.s) < 150;
      idx = safe ? ri.idx : clamp(Math.round(car.s / 4), 0, stage.samples.length - 1);
    }
    const sm = stage.samples[idx];
    car.pos.x = sm.x;
    car.pos.z = sm.z;
    car.pos.y = sm.y;
    car.yaw = sm.yaw;
    car.s = sm.s;
    car.progress = stage.totalLength ? sm.s / stage.totalLength : 0;
    car.vx = car.vz = car.vy = 0;
    car.yawRate = 0;
    car.speed = car.lat = 0;
    car.grounded = true;
    car.airTime = 0;
    car.pitch = car.roll = 0;
    car.bump = 0;
    car.hitCooldown = 0;
    car.slip = 0;
    car.driftAngle = 0;
    car.distance = 0;
    car.surface = 'road';
    car.offTrack = 0;
    car.lastImpact = 0;
    car.topSpeed = 0;
    car.suspension = [0, 0, 0, 0];
    car.handbrake = 0;
    car.steer = 0;
    car.gear = 1;
    car.rpm = CAR.idleRpm;
    car.throttle = 0;
    car.brake = 0;
    car.wheelSpin = 0;
    car.yawRate = 0;
    car.ax = 0;
    car.ay = 0;
    axSmooth = 0;
    prevGround = sm.y;
    climbSmooth = 0;
    axSmooth = 0;
  }

  // normalised Pacejka curve: F peaks at mu*Fz and falls off slightly past the peak,
  // which is what makes a tyre let go progressively instead of teleporting
  // sin() already peaks at 1.0 near the tyre's peak slip angle; the old 1/sin(C*pi/2)
  // scaled it to 1.414, which the friction ellipse then clipped flat (no post-peak decay)
  const TYRE_NORM = 1;
  function tyreForce(alpha, muFz) {
    const a = Math.abs(alpha);
    if (a < 1e-4) return 0;
    return -Math.sign(alpha) * muFz * Math.sin(CAR.tyreC * Math.atan(CAR.tyreB * a)) * TYRE_NORM;
  }

  function step(dt, input) {
    dt = clamp(dt, 0.001, 0.05);
    const fx = Math.sin(car.yaw);
    const fz = Math.cos(car.yaw);
    const rx = Math.cos(car.yaw); // car-left axis
    const rz = -Math.sin(car.yaw);

    const throttle = clamp(input.throttle || 0, 0, 1);
    const brake = clamp(input.brake || 0, 0, 1);
    const handbrake = input.handbrake ? 1 : 0;

    // ---- terrain under the four wheels ----
    let hSum = 0;
    let frontH = 0;
    let rearH = 0;
    let leftH = 0;
    let rightH = 0;
    for (let i = 0; i < 4; i++) {
      const w = wheelPos[i];
      const wx = car.pos.x + rx * w.x + fx * w.z;
      const wz = car.pos.z + rz * w.x + fz * w.z;
      const h = stage.heightAt(wx, wz);
      hSum += h;
      if (w.front) frontH += h * 0.5;
      else rearH += h * 0.5;
      if (w.x > 0) rightH += h * 0.5;
      else leftH += h * 0.5;
      car.suspension[i] = damp(car.suspension[i], clamp((h - car.pos.y) * 2.2, -0.16, 0.1), 16, dt);
    }
    const groundY = hSum / 4;

    // ---- surface ----
    const ri = stage.roadInfo(car.pos.x, car.pos.z);
    if (ri.idx >= 0) {
      car.s = ri.s;
      car.progress = clamp(ri.s / stage.totalLength, 0, 1);
      car.distance = ri.dist;
    } else {
      car.distance = 1e6; // far outside the search: keep the last known s
    }
    const surfKey = surfaceAt(ri.dist);
    car.surface = surfKey;
    const mu = (surfKey === 'road' ? surf.road : surfKey === 'shoulder' ? surf.shoulder : surf.offroad) * CAR.muScale;
    car.offTrack = surfKey === 'offroad' ? Math.min(1, car.offTrack + dt) : Math.max(0, car.offTrack - dt * 2);

    // ---- attitude ----
    const targetPitch = Math.atan2(frontH - rearH, CAR.wheelbase);
    const targetRoll = Math.atan2(rightH - leftH, CAR.track);
    car.pitch = damp(car.pitch, targetPitch, 9, dt);
    car.roll = damp(car.roll, targetRoll, 9, dt);

    // ---- vertical ----
    const speedAbs = Math.hypot(car.vx, car.vz);
    if (car.grounded) {
      const climb = (groundY - prevGround) / dt;
      climbSmooth = damp(climbSmooth, clamp(climb, -30, 30), 10, dt);
      if (climb < -7.5 && speedAbs > 9) {
        car.grounded = false;
        car.airTime = 0;
        car.vy = Math.max(1.5, climbSmooth * 0.55);
      } else {
        car.pos.y = groundY;
        car.vy = climb;
      }
    }
    if (!car.grounded) {
      car.airTime += dt;
      car.vy -= 17.5 * dt;
      car.pos.y += car.vy * dt;
      car.pitch = damp(car.pitch, clamp(-car.vy * 0.02, -0.14, 0.14), 1.6, dt);
      car.roll = damp(car.roll, 0, 1.2, dt);
      if (car.pos.y <= groundY) {
        const impact = Math.max(0, -car.vy);
        car.pos.y = groundY;
        car.grounded = true;
        car.vy = 0;
        car.bump = Math.min(1, impact / 14);
        if (impact > 2.2) car.lastImpact = impact;
        car.vx *= 1 - Math.min(0.18, impact * 0.012);
        car.vz *= 1 - Math.min(0.18, impact * 0.012);
        car.airTime = 0;
        climbSmooth = 0;
      }
    }
    prevGround = groundY;

    // ---- body-frame velocity ----
    let vf = car.vx * fx + car.vz * fz;
    let vl = car.vx * rx + car.vz * rz; // positive = sliding toward the car's left

    // ---- gearbox ----
    const wheelRpm = (Math.abs(vf) / (Math.PI * 2 * CAR.wheelRadius)) * 60;
    const ratio = CAR.gearRatios[car.gear - 1] * CAR.finalDrive;
    car.rpm = clamp(wheelRpm * ratio, CAR.idleRpm, CAR.maxRpm + 150);
    if (car.rpm > CAR.shiftRpm && car.gear < 6 && throttle > 0.2) car.gear++;
    else if (car.rpm < 2300 && car.gear > 1) car.gear--;
    const gearRatio = CAR.gearRatios[car.gear - 1] * CAR.finalDrive;

    // ---- steering (speed sensitive, smoothed like a real rack) ----
    const steerIn = clamp(input.steer || 0, -1, 1);
    const steerLimit = lerp(CAR.steerMax, CAR.steerMin, smoothstep(0, 35, Math.abs(vf)));
    car.steer = damp(car.steer, steerIn * steerLimit, car.grounded ? 7 : 3, dt);
    const delta = car.steer;

    // ---- axle loads with longitudinal transfer ----
    const staticF = (CAR.mass * g * CAR.rearAxle) / L;
    const staticR = (CAR.mass * g * CAR.frontAxle) / L;
    const transfer = clamp((CAR.mass * axSmooth * CAR.cgHeight) / L, -0.4 * staticF, 0.4 * staticF);
    const Fzf = Math.max(600, staticF - transfer);
    const Fzr = Math.max(600, staticR + transfer);

    // ---- slip angles ----
    const vRef = Math.max(2.2, Math.abs(vf));
    const frontLatVel = (vl + car.yawRate * CAR.frontAxle) * Math.cos(delta) + vf * Math.sin(delta);
    const rearLatVel = vl - car.yawRate * CAR.rearAxle;
    const af = Math.atan2(frontLatVel, vRef);
    const ar = Math.atan2(rearLatVel, vRef);

    const muF = mu * Fzf;
    let muR = mu * Fzr * CAR.rearTyreMu;

    // ---- engine / brakes ----
    const reversing = brake > 0.05 && throttle < 0.1 && vf < 0.5;
    const rpmNorm = clamp(car.rpm / CAR.maxRpm, 0, 1.08);
    const torqueCurve = 0.55 + 1.05 * Math.exp(-Math.pow((rpmNorm - 0.62) / 0.36, 2)) - 0.25 * rpmNorm;
    let driveF = ((CAR.torquePeak * torqueCurve * gearRatio * 0.9) / CAR.wheelRadius) * throttle;
    // the tyres can only transmit so much: excess torque becomes wheelspin, not force
    const tractionMax = mu * (Fzf * CAR.driveSplit + Fzr * (1 - CAR.driveSplit)) * 0.92;
    driveF = Math.min(driveF, tractionMax);
    if (!car.grounded) driveF = 0;
    if (reversing) driveF = vf < -9 ? 0 : -3200 * brake; // reverse
    if (driveF > 0 && vf > 52) driveF = 0;

    let brakeF = 0;
    const brakeCap = mu * CAR.mass * g * 0.95;
    // (brakeForce is zeroed further down when airborne)
    if (!reversing && brake > 0.02 && vf > 0.15) brakeF = -Math.min(brakeCap, CAR.mass * 7.6) * brake;
    else if (!reversing && brake > 0.02 && vf < -0.15) brakeF = Math.min(brakeCap, CAR.mass * 7.6) * brake;

    // handbrake locks the rear: lots of rear longitudinal drag, little lateral grip
    let handF = 0;
    if (handbrake) {
      // a locked wheel slides at ~70% of its peak grip, and drags the car to a stop
      handF = -signOf(vf) * Math.min(Fzr * 0.45, 2600);
      muR *= 0.7;
    }

    const FxF = driveF * CAR.driveSplit;
    // ABS: each axle's brake force is held just below the lock-up point, so the tyres
    // keep some lateral capacity. Without it a locked axle slides straight and the car
    // spins around the remaining one.
    const absF = muF * 0.9;
    const absR = muR * 0.72; // rear ABS leaves some lateral capacity
    const brakeFront = Math.max(brakeF * CAR.brakeFront, -absF);
    const brakeRear = Math.max(brakeF * (1 - CAR.brakeFront), -absR);
    const FxR = (handbrake ? 0 : driveF * (1 - CAR.driveSplit)) + brakeRear + handF;
    const FxFBrake = brakeFront;

    // friction ellipse: what is left for cornering after the tyre is used longitudinally
    const ellipse = (muFz, Fx) => Math.sqrt(Math.max(0, muFz * muFz - Fx * Fx));
    const air = car.grounded ? 1 : 0;
    let FyF = air * clamp(tyreForce(af, muF), -ellipse(muF, FxF + FxFBrake), ellipse(muF, FxF + FxFBrake));
    let FyR = air * clamp(tyreForce(ar, muR), -ellipse(muR, FxR), ellipse(muR, FxR));

    // ---- resistances and slope ----
    const gradeF = (stage.heightAt(car.pos.x + fx * 1.6, car.pos.z + fz * 1.6) - stage.heightAt(car.pos.x - fx * 1.6, car.pos.z - fz * 1.6)) / 3.2;
    const gradeR = (stage.heightAt(car.pos.x + rx * 1.2, car.pos.z + rz * 1.2) - stage.heightAt(car.pos.x - rx * 1.2, car.pos.z - rz * 1.2)) / 2.4;
    const slopeF = -CAR.mass * g * Math.sin(Math.atan(gradeF)) * (car.grounded ? 1 : 0.15);
    const slopeR = -CAR.mass * g * Math.sin(Math.atan(gradeR)) * (car.grounded ? 1 : 0.1);
    const dragF = -CAR.drag * vf * Math.abs(vf) * CAR.mass * 0.8;
    const rollF = -CAR.rollResist * surf.drag * (surfKey === 'offroad' ? 3.0 : 1) * vf * 26;

    const Ff = (FxF + FxR + FxFBrake) * air + FyF * Math.sin(delta) + slopeF + dragF + rollF;
    // a braked, steered front wheel also pushes sideways: opposite to the steering
    // direction, which is exactly why trail braking settles the car
    const brakeLat = -FxFBrake * Math.sin(delta);
    const Fl = FyF * Math.cos(delta) + FyR + brakeLat + slopeR;

    // ---- integrate body velocities ----
    const accF = Ff / CAR.mass + car.yawRate * vl;
    const accL = Fl / CAR.mass - car.yawRate * vf;
    vf += accF * dt;
    vl += accL * dt;

    // yaw moment: only the tyre forces (and a little scrub damping) rotate the car
    let torque = CAR.frontAxle * FyF * Math.cos(delta) - CAR.rearAxle * FyR;
    torque -= CAR.yawDamp * car.yawRate * CAR.inertia;
    if (!car.grounded) torque *= 0.15;
    // ESC: a real car brakes individual wheels when the yaw rate leaves what the tyres
    // can support. It is disabled with the handbrake and eases off under full throttle.
    if (car.grounded && !handbrake && CAR.escGain > 0) {
      const gripYaw = (mu * 9.81) / Math.max(9, Math.abs(vf));
      const kinematic = -(vf * Math.tan(delta)) / L;
      const yawTarget = clamp(kinematic, -gripYaw, gripYaw);
      const fade = 1 - 0.55 * throttle;
      torque += CAR.escGain * fade * CAR.inertia * clamp(yawTarget - car.yawRate, -1.5, 1.5);
    }
    car.yawRate += (torque / CAR.inertia) * dt;
    // a standstill should not creep; this is numerical, not a handling limit
    if (Math.abs(vf) < 1.0 && Math.abs(vl) < 1.0) car.yawRate *= Math.exp(-6 * dt);
    car.yaw = wrapAngle(car.yaw + car.yawRate * dt);

    // ---- back to world space ----
    const nfx = Math.sin(car.yaw);
    const nfz = Math.cos(car.yaw);
    const nrx = Math.cos(car.yaw);
    const nrz = -Math.sin(car.yaw);
    car.vx = nfx * vf + nrx * vl;
    car.vz = nfz * vf + nrz * vl;
    car.pos.x += car.vx * dt;
    car.pos.z += car.vz * dt;

    axSmooth = damp(axSmooth, accF, 8, dt);

    // ---- telemetry ----
    car.speed = vf;
    car.lat = vl;
    car.ax = accF;
    car.ay = accL;
    car.slip = clamp(Math.abs(vl) / 6, 0, 1);
    car.driftAngle = Math.atan2(vl, Math.abs(vf) + 0.6);
    car.topSpeed = Math.max(car.topSpeed, Math.abs(vf));
    car.throttle = throttle;
    car.brake = brake;
    car.handbrake = handbrake;

    const spinTarget = handbrake && car.grounded ? 0 : throttle > 0.5 && mu < 0.85 && Math.abs(vf) < 22 ? throttle * (0.5 + car.slip) : 0;
    car.wheelSpin = damp(car.wheelSpin, spinTarget, 8, dt);

    // ---- prop collisions ----
    car.hitCooldown = Math.max(0, car.hitCooldown - dt);
    if (stage.props && car.hitCooldown <= 0) {
      // capsule: two circles along the car's length, so the sides are not a giant bubble
      const hfx = Math.sin(car.yaw);
      const hfz = Math.cos(car.yaw);
      const R = 0.95;
      let best = null;
      for (const off of [1.05, -1.05]) {
        const px = car.pos.x + hfx * off;
        const pz = car.pos.z + hfz * off;
        const hit = stage.props.query(px, pz, R);
        if (!hit) continue;
        const dx = px - hit.x;
        const dz = pz - hit.z;
        const d = Math.hypot(dx, dz) || 0.001;
        if (!best || d < best.d) best = { hit, dx, dz, d };
      }
      if (best) {
        const { hit, dx, dz, d } = best;
        const push = R + (hit.r || 0.45) + 0.05 - d;
        car.pos.x += (dx / d) * push;
        car.pos.z += (dz / d) * push;
        const sp = Math.hypot(car.vx, car.vz);
        car.vx = -car.vx * 0.25 + (dx / d) * 2;
        car.vz = -car.vz * 0.25 + (dz / d) * 2;
        car.bump = Math.min(1, sp / 22);
        car.lastImpact = Math.max(car.lastImpact, sp * 0.8);
        car.hitCooldown = 0.25;
      }
    }
    return car;
  }

  return { car, reset, step };
}

// autopilot used by the headless regression test
export function autopilot(stage, car, look = 16) {
  const idxS = clamp(Math.round(car.s / 4), 0, stage.samples.length - 1);
  const ahead = Math.min(stage.samples.length - 1, idxS + Math.round((12 + Math.abs(car.speed) * 0.8) / 4));
  const target = stage.samples[ahead];
  const dx = target.x - car.pos.x;
  const dz = target.z - car.pos.z;
  const want = Math.atan2(dx, dz);
  const err = angleDelta(car.yaw, want);
  // positive steering turns right; add a touch of counter-steer damping
  const steer = clamp(-err * 2.0 - car.yawRate * 0.2, -1, 1);

  let minR = 999;
  for (let i = idxS; i < Math.min(stage.samples.length, idxS + 18); i++) minR = Math.min(minR, stage.samples[i].radius);
  const speedTarget = clamp(Math.sqrt(0.72 * 9.81 * Math.max(14, minR)), 10, 46);
  const v = Math.hypot(car.vx, car.vz);
  let throttle = 0;
  let brake = 0;
  if (v < speedTarget - 1.5) throttle = 1;
  else if (v > speedTarget + 2.5) brake = clamp((v - speedTarget) / 6, 0.2, 1);
  else throttle = clamp(1 - (v - speedTarget) / 4, 0, 1);
  return { steer, throttle, brake, handbrake: false };
}
