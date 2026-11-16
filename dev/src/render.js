// render.js — three.js world: terrain, road, snow banks, forest, car, sky, spray, snow.
const THREE = window.THREE;
import { buildCarParts, buildWheelParts } from './carmesh.js';
import { buildCockpit, COCKPIT_EYE, COCKPIT_LOOK, COCKPIT_FOV, BONNET_EYE, BONNET_LOOK, BONNET_FOV } from './cockpit.js';
import { clamp, lerp, damp, smoothstep, wrapAngle } from './math.js';
import { fbm2 } from './noise.js';

const Y_UP = new THREE.Vector3(0, 1, 0);

function canvasTexture(w, h, draw, { repeatX = 1, repeatY = 1 } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 4;
  return tex;
}

// --- textures -------------------------------------------------------------
function detailTexture(theme) {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    // soft mottling: this multiplies the terrain vertex colours
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = 4 + Math.random() * 22;
      const v = 226 + Math.random() * 26;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${v},${v},${v},0.10)`);
      grad.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 9000; i++) {
      const v = 236 + Math.random() * 19;
      g.fillStyle = `rgba(${v},${v},${v},${0.05 + Math.random() * 0.12})`;
      g.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
  }, { repeatX: 1, repeatY: 1 });
}

function linearTexture(w, h, draw, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

// tileable-ish normal map from fbm, to break up the flat snow surface
function snowNormalTexture() {
  const N = 128;
  const hgt = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      hgt[y * N + x] = fbm2(x * 0.09, y * 0.09, 4) * 0.5 + fbm2(x * 0.31, y * 0.31, 3) * 0.18;
    }
  }
  return linearTexture(N, N, (g) => {
    const img = g.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const l = hgt[y * N + ((x + N - 1) % N)];
        const r = hgt[y * N + ((x + 1) % N)];
        const d = hgt[((y + N - 1) % N) * N + x];
        const u = hgt[((y + 1) % N) * N + x];
        let nx = (l - r) * 3.2;
        let ny = (d - u) * 3.2;
        const nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len;
        const i = (y * N + x) * 4;
        img.data[i] = Math.round((nx * 0.5 + 0.5) * 255);
        img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        img.data[i + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, 1);
}

function roadTexture(theme) {
  return canvasTexture(512, 1024, (g, w, h) => {
    const base = theme.road.map((v) => Math.round(v * 255));
    g.fillStyle = `rgb(${base.join(',')})`;
    g.fillRect(0, 0, w, h);

    // fine packed-snow grain
    for (let i = 0; i < 24000; i++) {
      const v = Math.random();
      g.fillStyle = v < 0.5
        ? `rgba(255,255,255,${0.04 + Math.random() * 0.08})`
        : `rgba(52,58,66,${0.03 + Math.random() * 0.07})`;
      g.fillRect(Math.random() * w, Math.random() * h, 1, 1 + Math.random() * 2);
    }

    // two polished ruts (u = across the road)
    const rut = theme.rut.map((v) => Math.round(v * 255));
    for (const cx of [0.28, 0.72]) {
      const grad = g.createLinearGradient(w * (cx - 0.11), 0, w * (cx + 0.11), 0);
      grad.addColorStop(0, `rgba(${rut.join(',')},0)`);
      grad.addColorStop(0.38, `rgba(${rut.join(',')},0.55)`);
      grad.addColorStop(0.5, `rgba(${rut.join(',')},0.72)`);
      grad.addColorStop(0.62, `rgba(${rut.join(',')},0.55)`);
      grad.addColorStop(1, `rgba(${rut.join(',')},0)`);
      g.fillStyle = grad;
      g.fillRect(w * (cx - 0.12), 0, w * 0.24, h);

      // icy sheen line inside each rut
      const sheen = g.createLinearGradient(w * (cx - 0.03), 0, w * (cx + 0.03), 0);
      sheen.addColorStop(0, 'rgba(236,246,255,0)');
      sheen.addColorStop(0.5, 'rgba(236,246,255,0.22)');
      sheen.addColorStop(1, 'rgba(236,246,255,0)');
      g.fillStyle = sheen;
      g.fillRect(w * (cx - 0.035), 0, w * 0.07, h);
    }

    // loose snow ridge along the centre and the edges
    const ridge = g.createLinearGradient(0, 0, w, 0);
    ridge.addColorStop(0, 'rgba(255,255,255,0.20)');
    ridge.addColorStop(0.1, 'rgba(255,255,255,0)');
    ridge.addColorStop(0.46, 'rgba(255,255,255,0)');
    ridge.addColorStop(0.5, 'rgba(255,255,255,0.16)');
    ridge.addColorStop(0.54, 'rgba(255,255,255,0)');
    ridge.addColorStop(0.9, 'rgba(255,255,255,0)');
    ridge.addColorStop(1, 'rgba(255,255,255,0.20)');
    g.fillStyle = ridge;
    g.fillRect(0, 0, w, h);

    // faint longitudinal streaks from the tyres
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * w;
      g.strokeStyle = `rgba(${rut.join(',')},${0.03 + Math.random() * 0.05})`;
      g.lineWidth = 1 + Math.random() * 2;
      g.beginPath();
      g.moveTo(x, 0);
      g.bezierCurveTo(x + 6, h * 0.33, x - 6, h * 0.66, x + 2, h);
      g.stroke();
    }
  }, { repeatX: 1, repeatY: 1 });
}

function roadRoughness(theme) {
  return linearTexture(256, 512, (g, w, h) => {
    g.fillStyle = '#e2e2e2';
    g.fillRect(0, 0, w, h);
    for (const cx of [0.28, 0.72]) {
      const grad = g.createLinearGradient(w * (cx - 0.11), 0, w * (cx + 0.11), 0);
      grad.addColorStop(0, 'rgba(60,60,60,0)');
      grad.addColorStop(0.5, 'rgba(60,60,60,0.85)');
      grad.addColorStop(1, 'rgba(60,60,60,0)');
      g.fillStyle = grad;
      g.fillRect(w * (cx - 0.12), 0, w * 0.24, h);
    }
  }, { repeatX: 1, repeatY: 1 });
}
function bannerTexture(text) {
  return canvasTexture(512, 128, (g, w, h) => {
    g.fillStyle = '#101418';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ff7a1a';
    g.fillRect(0, 0, w, 10);
    g.fillRect(0, h - 10, w, 10);
    if (text === 'FINISH') {
      const s = 16;
      for (let y = 10; y < h - 10; y += s) {
        for (let x = 0; x < w; x += s) {
          if (((x / s) + (y / s)) % 2 < 1) {
            g.fillStyle = 'rgba(236,232,223,0.16)';
            g.fillRect(x, y, s, s);
          }
        }
      }
    }
    g.fillStyle = '#f2efe6';
    g.font = '700 62px "PingFang SC", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2);
  });
}

function mergeGeoms(parts) {
  let total = 0;
  const prepped = parts.map(({ geo, color }) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const n = g.attributes.position.count;
    total += n;
    const colors = new Float32Array(n * 3);
    if (typeof color === 'function') {
      const pos = g.attributes.position;
      for (let i = 0; i < n; i++) {
        const c = color(pos.getX(i), pos.getY(i), pos.getZ(i));
        colors[i * 3] = c[0];
        colors[i * 3 + 1] = c[1];
        colors[i * 3 + 2] = c[2];
      }
    } else {
      for (let i = 0; i < n; i++) {
        colors[i * 3] = color[0];
        colors[i * 3 + 1] = color[1];
        colors[i * 3 + 2] = color[2];
      }
    }
    return { g, colors };
  });
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const { g, colors } of prepped) {
    const p = g.attributes.position.array;
    const nn = g.attributes.normal ? g.attributes.normal.array : null;
    pos.set(p, o * 3);
    if (nn) nor.set(nn, o * 3);
    col.set(colors, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function treeGeometry(theme) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.07, 0.17, 1.7, 6).translate(0, 0.85, 0);
  parts.push({ geo: trunk, color: [0.14, 0.1, 0.08] });
  const tiers = [
    { r: 1.22, h: 1.9, y: 0.95 },
    { r: 0.98, h: 1.9, y: 2.0 },
    { r: 0.72, h: 1.7, y: 3.05 },
    { r: 0.44, h: 1.4, y: 4.0 },
  ];
  for (const t of tiers) {
    const cone = new THREE.ConeGeometry(t.r, t.h, 8, 1, true).translate(0, t.y + t.h * 0.5, 0);
    parts.push({
      geo: cone,
      color: (x, y) => {
        const k = clamp((y - t.y) / t.h, 0, 1);
        // snow settles toward the tips of each tier
        const snow = smoothstep(0.3, 0.9, k) * 0.9;
        return [
          lerp(theme.tree[0], theme.treeSnow[0], snow),
          lerp(theme.tree[1], theme.treeSnow[1], snow),
          lerp(theme.tree[2], theme.treeSnow[2], snow),
        ];
      },
    });
  }
  return mergeGeoms(parts);
}
export class World {
  constructor(renderer, stage, theme, quality) {
    this.stage = stage;
    this.theme = theme;
    this.quality = quality;

    this.renderer = renderer;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.dpr));
    this.renderer.shadowMap.enabled = quality.shadow > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(new THREE.Color(...theme.sky), 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(...theme.sky);
    this.scene.fog = new THREE.FogExp2(new THREE.Color(...theme.fogColor), 1.5 / Math.max(80, theme.fogFar));

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.2, 4000);
    this.camera.position.set(0, 30, -12);

    this.sunDir = new THREE.Vector3(...(theme.sunDir || [0.62, 0.52, -0.42])).normalize();
    this._buildSky();
    this._buildEnvironment();
    this._buildLights();
    this._buildTerrain();
    this._buildRoad();
    this._buildForest();
    this._buildGantries();
    this._buildCar();
    this._buildWeather();
    this.scene.add(this.car.root);
    if (this.carShadow) this.scene.add(this.carShadow);

    this.postDisabled = typeof location !== 'undefined' && /[?&]nopost/.test(location.search);
    if (!this.postDisabled && this.quality.shadow > 0) {
      try { this._setupPost(); } catch (e) { console.warn('[rally] post unavailable', e); }
    }

    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this._camInit = false;
    this.shake = 0;
    this.time = 0;
    this.resize();
  }

  _makeSkyMaterial() {
    const theme = this.theme;
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: new THREE.Color(...theme.sky) },
        horizon: { value: new THREE.Color(...theme.horizon) },
        sunColor: { value: new THREE.Color(...theme.sun) },
        sunDir: { value: this.sunDir.clone() },
        time: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vSkyDir;
        void main() {
          vSkyDir = position;
          vec4 eyeSpace = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * eyeSpace;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith, horizon, sunColor, sunDir;
        uniform float time;
        varying vec3 vSkyDir;

        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 sq = f * f;
          f = sq * (3.0 - f - f);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0));
          vec2 ab = mix(a, b, f.x);
          vec2 cd = mix(c, d, f.x);
          return mix(ab, cd, f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int k = 0; k < 5; k++) {
            v += vnoise(p) * a;
            p *= 2.03;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 dir = normalize(vSkyDir);
          float up = clamp(dir.y, -0.15, 1.0);
          vec3 col = mix(horizon, zenith, pow(smoothstep(-0.06, 0.85, up), 0.72));
          float sd = max(dot(dir, normalize(sunDir)), 0.0);
          col += sunColor * pow(sd, 1200.0) * 9.0;
          col += sunColor * pow(sd, 18.0) * 0.30;
          col += sunColor * pow(sd, 4.0) * 0.06;

          if (dir.y > 0.005) {
            vec2 uv = dir.xz / (dir.y + 0.16);
            float c = fbm(uv * 1.5 + vec2(time * 0.004, time * 0.002));
            c = smoothstep(0.52, 0.88, c) * smoothstep(0.0, 0.2, dir.y);
            vec3 lit = mix(vec3(0.52, 0.57, 0.66), vec3(1.08, 1.0, 0.94), pow(sd, 2.5));
            col = mix(col, lit, c * 0.62);
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
  }

  _buildSky() {
    const geo = new THREE.SphereGeometry(2600, 32, 20);
    this.skyMat = this._makeSkyMaterial();
    this.sky = new THREE.Mesh(geo, this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
  }

  _buildEnvironment() {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      const mat = this._makeSkyMaterial();
      const geo = new THREE.SphereGeometry(30, 24, 16);
      const dome = new THREE.Mesh(geo, mat);
      dome.frustumCulled = false;
      envScene.add(dome);
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(26, 24),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(...this.theme.groundDark) })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -2.2;
      envScene.add(ground);
      const rt = pmrem.fromScene(envScene, 0.04);
      this.envRT = rt;
      this.scene.environment = rt.texture;
      this.scene.environmentIntensity = 0.6;
      pmrem.dispose();
      geo.dispose();
      mat.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
    } catch (e) {
      console.warn('[rally] environment map unavailable', e);
    }
  }
  _buildLights() {
    const t = this.theme;
    this.hemi = new THREE.HemisphereLight(new THREE.Color(...t.horizon), new THREE.Color(...t.groundDark), t.ambient);
    this.scene.add(this.hemi);

    const sun = new THREE.DirectionalLight(new THREE.Color(...t.sun), t.sunIntensity);
    sun.castShadow = this.quality.shadow > 0;
    const sc = sun.shadow.camera;
    sc.left = -52;
    sc.right = 52;
    sc.top = 52;
    sc.bottom = -52;
    sc.near = 1;
    sc.far = 320;
    sc.updateProjectionMatrix();
    sun.shadow.mapSize.set(this.quality.shadow || 1024, this.quality.shadow || 1024);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.035;
    this.sun = sun;
    this.sunTarget = new THREE.Object3D();
    this.scene.add(sun);
    this.scene.add(this.sunTarget);
    sun.target = this.sunTarget;
  }

  _buildTerrain() {
    const st = this.stage;
    const b = st.bbox;
    const step = this.quality.terrain || 9;
    const nx = Math.floor((b.maxX - b.minX) / step);
    const nz = Math.floor((b.maxZ - b.minZ) / step);
    const vcount = (nx + 1) * (nz + 1);
    const pos = new Float32Array(vcount * 3);
    const uv = new Float32Array(vcount * 2);
    let p = 0;
    let q = 0;
    for (let iz = 0; iz <= nz; iz++) {
      const z = b.minZ + iz * step;
      for (let ix = 0; ix <= nx; ix++) {
        const x = b.minX + ix * step;
        pos[p++] = x;
        let h = st.heightAt(x, z);
        const ri = st.roadInfo(x, z);
        if (ri.idx >= 0 && ri.dist < 12) h = Math.min(h, ri.y - 0.05);
        pos[p++] = h;
        pos[p++] = z;
        uv[q++] = (x - b.minX) / 46;
        uv[q++] = (z - b.minZ) / 46;
      }
    }
    const idx = new Uint32Array(nx * nz * 6);
    let k = 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = iz * (nx + 1) + ix;
        const bb = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = bb;
        idx[k++] = bb;
        idx[k++] = c;
        idx[k++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    const theme = this.theme;
    const colors = new Float32Array(vcount * 3);
    const nrm = geo.attributes.normal.array;
    for (let i = 0; i < vcount; i++) {
      const ny = nrm[i * 3 + 1];
      const y = pos[i * 3 + 1];
      const x = pos[i * 3];
      const z = pos[i * 3 + 2];
      // rock shows through on steep faces, snow stays on top
      const rocky = smoothstep(0.86, 0.58, ny);
      const high = smoothstep(78, 118, y);
      const grain = Math.sin(x * 0.63 + z * 0.41) * 0.5 + Math.sin(x * 0.17 - z * 0.29) * 0.5;
      const shade = 0.95 + grain * 0.045;
      const base = theme.ground;
      const snowC = [base[0] * shade, base[1] * shade, base[2] * shade];
      const rockC = theme.rock;
      // cool blue in the hollows, warm where the sun hits
      const warm = clamp(0.5 + ny * 0.5, 0, 1);
      colors[i * 3] = lerp(lerp(snowC[0], rockC[0], rocky), 0.98, high * 0.35) * lerp(0.94, 1.03, warm);
      colors[i * 3 + 1] = lerp(lerp(snowC[1], rockC[1], rocky), 0.99, high * 0.35) * lerp(0.96, 1.02, warm);
      colors[i * 3 + 2] = lerp(lerp(snowC[2], rockC[2], rocky), 1.0, high * 0.35) * lerp(1.02, 0.99, warm);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.93,
      metalness: 0,
      map: detailTexture(theme),
      normalMap: snowNormalTexture(),
      normalScale: new THREE.Vector2(0.55, 0.55),
    });
    mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping;
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.terrain.frustumCulled = false;
    this.scene.add(this.terrain);
  }

  _buildRoad() {
    const st = this.stage;
    const theme = this.theme;
    const S = st.samples;
    const halfW = 4.9;
    const n = S.length;

    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    const idx = new Uint32Array((n - 1) * 6);
    for (let i = 0; i < n; i++) {
      const s = S[i];
      const y = s.y + 0.06;
      pos[i * 6] = s.x - s.rx * halfW;
      pos[i * 6 + 1] = y;
      pos[i * 6 + 2] = s.z - s.rz * halfW;
      pos[i * 6 + 3] = s.x + s.rx * halfW;
      pos[i * 6 + 4] = y;
      pos[i * 6 + 5] = s.z + s.rz * halfW;
      uv[i * 4] = 0;
      uv[i * 4 + 1] = s.s / 16;
      uv[i * 4 + 2] = 1;
      uv[i * 4 + 3] = s.s / 16;
    }
    let k = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx[k++] = a;
      idx[k++] = a + 2;
      idx[k++] = a + 1;
      idx[k++] = a + 1;
      idx[k++] = a + 2;
      idx[k++] = a + 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: roadTexture(theme),
      roughnessMap: roadRoughness(theme),
      roughness: 1.0,
      metalness: 0.06,
    });
    this.road = new THREE.Mesh(geo, mat);
    this.road.receiveShadow = true;
    this.road.frustumCulled = false;
    this.scene.add(this.road);

    const bankGeo = this._buildBanks(S);
    this.banks = new THREE.Mesh(
      bankGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 })
    );
    this.banks.receiveShadow = true;
    this.banks.frustumCulled = false;
    this.scene.add(this.banks);
  }
  _buildBanks(S) {
    const theme = this.theme;
    const profile = [
      { o: 4.85, h: 0.02 },
      { o: 5.45, h: 0.52 },
      { o: 6.6, h: 0.44 },
      { o: 7.9, h: 0.05 },
      { o: 10.5, h: -0.02 },
    ];
    const n = S.length;
    const cols = profile.length * 2;
    const pos = new Float32Array(n * cols * 3);
    const col = new Float32Array(n * cols * 3);
    const idx = new Uint32Array((n - 1) * (cols - 1) * 6);
    const base = theme.ground;
    for (let i = 0; i < n; i++) {
      const s = S[i];
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? -1 : 1;
        for (let j = 0; j < profile.length; j++) {
          const pr = profile[j];
          const o = pr.o * sgn;
          const vi = i * cols + side * profile.length + j;
          const jitter = Math.sin(s.s * 0.11 + j * 2.1 + side) * 0.035;
          pos[vi * 3] = s.x + s.rx * o;
          pos[vi * 3 + 1] = s.y + pr.h + jitter;
          pos[vi * 3 + 2] = s.z + s.rz * o;
          const shade = 0.9 + Math.sin(s.s * 0.7 + j) * 0.05;
          const rockish = j >= 3 ? 0.3 : 1;
          // snow banks read slightly cooler than the field so the road edge is legible
          const bankTint = [0.91, 0.955, 1.03];
          col[vi * 3] = lerp(base[0] * shade * bankTint[0], theme.groundDark[0] * shade, 1 - rockish);
          col[vi * 3 + 1] = lerp(base[1] * shade * bankTint[1], theme.groundDark[1] * shade, 1 - rockish);
          col[vi * 3 + 2] = lerp(base[2] * shade * bankTint[2], theme.groundDark[2] * shade, 1 - rockish);
        }
      }
    }
    let k = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let side = 0; side < 2; side++) {
        for (let j = 0; j < profile.length - 1; j++) {
          const a = i * cols + side * profile.length + j;
          const b = a + 1;
          const c = a + cols;
          const d = c + 1;
          if (side === 0) {
            idx[k++] = a;
            idx[k++] = b;
            idx[k++] = c;
            idx[k++] = b;
            idx[k++] = d;
            idx[k++] = c;
          } else {
            idx[k++] = a;
            idx[k++] = c;
            idx[k++] = b;
            idx[k++] = b;
            idx[k++] = c;
            idx[k++] = d;
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    return geo;
  }

  _buildForest() {
    const st = this.stage;
    const theme = this.theme;
    const treeGeo = treeGeometry(theme);
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    const trees = st.trees;
    this.treeMesh = new THREE.InstancedMesh(treeGeo, treeMat, trees.length);
    this.treeMesh.castShadow = this.quality.shadow >= 2048;
    this.treeMesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const p = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      q.setFromAxisAngle(Y_UP, t.rot);
      const tall = t.kind ? 1.18 : 1;
      scl.set(t.scale, t.scale * tall, t.scale);
      p.set(t.x, t.y - 0.1, t.z);
      m.compose(p, q, scl);
      this.treeMesh.setMatrixAt(i, m);
      const k = 0.82 + ((i * 53) % 100) / 100 * 0.34;
      col.setRGB(k, k * (0.97 + ((i * 17) % 9) / 100), k * 1.02);
      this.treeMesh.setColorAt(i, col);
    }
    this.treeMesh.instanceMatrix.needsUpdate = true;
    if (this.treeMesh.instanceColor) this.treeMesh.instanceColor.needsUpdate = true;
    this.treeMesh.frustumCulled = false;
    this.treeMesh.count = Math.max(1, Math.floor(trees.length * (this.quality.trees || 1)));
    this.scene.add(this.treeMesh);

    // rocks
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...theme.rock), roughness: 0.88, flatShading: true });
    this.rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, st.rocks.length);
    this.rockMesh.castShadow = this.quality.shadow > 0;
    this.rockMesh.receiveShadow = true;
    for (let i = 0; i < st.rocks.length; i++) {
      const r = st.rocks[i];
      q.setFromAxisAngle(Y_UP, r.rot);
      scl.set(r.scale, r.scale * (0.55 + (i % 5) * 0.07), r.scale * (0.8 + (i % 3) * 0.1));
      p.set(r.x, r.y + r.scale * 0.2, r.z);
      m.compose(p, q, scl);
      this.rockMesh.setMatrixAt(i, m);
      const k = 0.8 + ((i * 31) % 100) / 100 * 0.4;
      col.setRGB(k, k, k * 1.03);
      this.rockMesh.setColorAt(i, col);
    }
    this.rockMesh.instanceMatrix.needsUpdate = true;
    if (this.rockMesh.instanceColor) this.rockMesh.instanceColor.needsUpdate = true;
    this.rockMesh.frustumCulled = false;
    this.scene.add(this.rockMesh);

    // marker poles
    const poleGeo = new THREE.CylinderGeometry(0.045, 0.045, 1.65, 5).translate(0, 0.82, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...theme.pole), roughness: 0.55 });
    this.poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, st.poles.length);
    for (let i = 0; i < st.poles.length; i++) {
      const pl = st.poles[i];
      q.setFromAxisAngle(Y_UP, pl.rot);
      scl.set(1, 1, 1);
      p.set(pl.x, pl.y, pl.z);
      m.compose(p, q, scl);
      this.poleMesh.setMatrixAt(i, m);
    }
    this.poleMesh.instanceMatrix.needsUpdate = true;
    this.poleMesh.frustumCulled = false;
    this.scene.add(this.poleMesh);
  }
  _buildGantries() {
    const st = this.stage;
    const build = (smp, text) => {
      const g = new THREE.Group();
      const postMat = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.6, metalness: 0.4 });
      const postGeo = new THREE.BoxGeometry(0.3, 5.6, 0.3);
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(side * 5.4, 2.8, 0);
        post.castShadow = true;
        g.add(post);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(11.2, 0.36, 0.36), postMat);
      beam.position.y = 5.45;
      beam.castShadow = true;
      g.add(beam);
      const banner = new THREE.Mesh(
        new THREE.PlaneGeometry(9.4, 1.5),
        new THREE.MeshBasicMaterial({ map: bannerTexture(text), side: THREE.DoubleSide })
      );
      banner.position.set(0, 4.55, 0);
      banner.rotation.y = Math.PI; // face the car approaching from -Z
      g.add(banner);
      g.position.set(smp.x, smp.y, smp.z);
      g.rotation.y = smp.yaw;
      return g;
    };
    this.scene.add(build(st.samples[10], 'START'));
    this.scene.add(build(st.samples[st.samples.length - 3], 'FINISH'));
  }

  _buildCar() {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const paint = new THREE.MeshPhysicalMaterial({
      color: 0xb8321a,
      metalness: 0.28,
      roughness: 0.36,
      clearcoat: 0.9,
      clearcoatRoughness: 0.16,
      envMapIntensity: 1.1,
    });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x0a1016,
      metalness: 0.35,
      roughness: 0.05,
      transparent: true,
      opacity: 0.9,
      envMapIntensity: 1.5,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0e1013, roughness: 0.62, metalness: 0.2 });
    const lightF = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff0c8, emissiveIntensity: 1.35, roughness: 0.2, metalness: 0.1 });
    const lightR = new THREE.MeshStandardMaterial({ color: 0x2a0402, emissive: 0xff2412, emissiveIntensity: 1.1, roughness: 0.3 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc3c8cf, metalness: 0.95, roughness: 0.26, envMapIntensity: 1.2 });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.95, side: THREE.DoubleSide });
    const brakeMat = new THREE.MeshStandardMaterial({ color: 0x33363a, metalness: 0.7, roughness: 0.5 });
    const mats = { paint, glass, dark, lightF, lightR, rim: rimMat, brake: brakeMat, tyre: tyreMat };
    this.lightRMat = lightR;
    this.glassMat = glass;

    const toGeo = (part, rotY = 0) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(part.pos, 3));
      geo.setIndex(new THREE.BufferAttribute(part.idx, 1));
      geo.computeVertexNormals();
      if (rotY) geo.rotateY(rotY);
      return geo;
    };

    const shellMeshes = [];
    for (const part of buildCarParts()) {
      const mesh = new THREE.Mesh(toGeo(part), mats[part.mat] || dark);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      body.add(mesh);
      shellMeshes.push(mesh);
    }
    this.shellMeshes = shellMeshes;

    // door roundels (a livery detail that reads at a distance)
    const roundelTex = canvasTexture(128, 128, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#f2efe6';
      g.beginPath();
      g.arc(64, 64, 58, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#16181b';
      g.font = '700 72px "PingFang SC", system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('47', 64, 68);
    });
    const roundelMat = new THREE.MeshBasicMaterial({
      map: roundelTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    for (const sx of [-1, 1]) {
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36), roundelMat);
      decal.position.set(sx * 0.912, 0.66, 0.1);
      decal.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
      body.add(decal);
      shellMeshes.push(decal);
    }

    // wheels: geometry is authored with a Z axis, rotate so the axle runs along X
    const wheelParts = buildWheelParts();
    const tyreGeo = toGeo(wheelParts.tyre[0], Math.PI / 2);
    const detailGeos = wheelParts.details.map((d) => ({ mat: d.mat, geo: toGeo(d, Math.PI / 2) }));
    const wheels = [];
    for (const w of [
      [0.79, 1.31, true],
      [-0.79, 1.31, true],
      [0.79, -1.31, false],
      [-0.79, -1.31, false],
    ]) {
      const pivot = new THREE.Group();
      pivot.position.set(w[0], 0.345, w[1]);
      const tyre = new THREE.Mesh(tyreGeo, tyreMat);
      tyre.castShadow = true;
      const spin = new THREE.Group();
      spin.add(tyre);
      for (const d of detailGeos) {
        const mesh = new THREE.Mesh(d.geo, mats[d.mat] || dark);
        mesh.castShadow = false;
        spin.add(mesh);
      }
      pivot.add(spin);
      root.add(pivot);
      wheels.push({ pivot, spin, front: w[2] });
    }

    // soft contact shadow so the car sits in the snow instead of floating on it
    const blob = canvasTexture(128, 128, (g) => {
      const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
      grd.addColorStop(0, 'rgba(0,0,0,0.75)');
      grd.addColorStop(0.55, 'rgba(0,0,0,0.35)');
      grd.addColorStop(1, 'rgba(0,0,0,0.0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
    });
    const shadowGroup = new THREE.Group();
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 2.6),
      new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false, opacity: 0.55, side: THREE.DoubleSide })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = 0.03;
    shadowGroup.add(shadowPlane);
    this.carShadow = shadowGroup;

    const cockpit = buildCockpit(THREE);
    body.add(cockpit.group);
    this.interior = cockpit.group;
    this.steerWheel = cockpit.wheel;
    this.gaugeNeedles = cockpit.needles;

    this.car = { root, body, wheels };
  }


  _buildWeather() {
    const theme = this.theme;
    // falling snow
    const N = this.quality.snow || 1200;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 90;
      pos[i * 3 + 1] = Math.random() * 34;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 90;
      vel[i * 3] = 0.6 + Math.random() * 0.8;
      vel[i * 3 + 1] = 1.1 + Math.random() * 2.4;
      vel[i * 3 + 2] = 0.2 + Math.random() * 0.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dot = canvasTexture(32, 32, (g) => {
      const grd = g.createRadialGradient(16, 16, 0, 16, 16, 15);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.45, 'rgba(255,255,255,0.65)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 32, 32);
    });
    const mat = new THREE.PointsMaterial({
      size: 0.22,
      map: dot,
      transparent: true,
      depthWrite: false,
      opacity: theme.snowFall > 0 ? 0.85 : 0.0,
      sizeAttenuation: true,
      color: 0xffffff,
    });
    this.snowGeo = geo;
    this.snowTotal = N;
    this.snowVel = vel;
    this.snow = new THREE.Points(geo, mat);
    this.snow.frustumCulled = false;
    this.scene.add(this.snow);

    // snow spray behind the wheels
    const M = 260;
    const sp = new Float32Array(M * 3);
    for (let i = 0; i < M; i++) sp[i * 3 + 1] = -1000;
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const smat = new THREE.PointsMaterial({
      size: 0.42,
      map: dot,
      transparent: true,
      depthWrite: false,
      opacity: 0.75,
      color: new THREE.Color(...theme.ground).lerp(new THREE.Color(1, 1, 1), 0.4),
    });
    this.spray = new THREE.Points(sgeo, smat);
    this.spray.frustumCulled = false;
    this.sprayGeo = sgeo;
    this.sprayLife = new Float32Array(M);
    this.sprayVel = new Float32Array(M * 3);
    this.sprayIdx = 0;
    this.scene.add(this.spray);
  }

  _setupPost() {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(2, Math.floor(size.x));
    const h = Math.max(2, Math.floor(size.y));

    // HDR path when the GPU can render to half-float, so tone mapping happens after bloom
    const ext = r.extensions;
    const canHalf = !!(ext.get('EXT_color_buffer_float') || ext.get('EXT_color_buffer_half_float'));
    if (!canHalf) throw new Error('no float render target support');
    this.postHdr = canHalf;
    const type = canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType;

    const samples = this.quality.shadow >= 2048 ? 4 : 2;
    this.rtScene = new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false, samples });
    const half = { type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(Math.max(2, Math.floor(w / 2)), Math.max(2, Math.floor(h / 2)), half);
    this.rtB = new THREE.WebGLRenderTarget(Math.max(2, Math.floor(w / 2)), Math.max(2, Math.floor(h / 2)), half);

    this.postScene = new THREE.Scene();
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.postQuad.frustumCulled = false;
    this.postScene.add(this.postQuad);

    const vs = 'varying vec2 vPostUv; void main(){ vPostUv = uv; vec4 ndc = vec4(position.xy, 0.0, 1.0); gl_Position = ndc; }';
    this.matBright = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, threshold: { value: canHalf ? 1.1 : 0.85 }, knee: { value: 0.4 } },
      vertexShader: vs,
      fragmentShader: 'uniform sampler2D tDiffuse; uniform float threshold; uniform float knee; varying vec2 vPostUv; void main(){ vec3 c = texture2D(tDiffuse, vPostUv).rgb; float l = max(max(c.r,c.g),c.b); float k = smoothstep(threshold, threshold + knee, l); gl_FragColor = vec4(c * k, 1.0); }',
      depthTest: false, depthWrite: false,
    });
    this.matBlur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, texel: { value: new THREE.Vector2(2 / w, 2 / h) } },
      vertexShader: vs,
      fragmentShader: 'uniform sampler2D tDiffuse; uniform vec2 dir; uniform vec2 texel; varying vec2 vPostUv; void main(){ vec2 o = dir * texel; vec3 c = texture2D(tDiffuse, vPostUv).rgb * 0.227; c += (texture2D(tDiffuse, vPostUv + o*1.4).rgb + texture2D(tDiffuse, vPostUv - o*1.4).rgb) * 0.316; c += (texture2D(tDiffuse, vPostUv + o*3.3).rgb + texture2D(tDiffuse, vPostUv - o*3.3).rgb) * 0.070; gl_FragColor = vec4(c, 1.0); }',
      depthTest: false, depthWrite: false,
    });
    this.matComposite = new THREE.ShaderMaterial({
      uniforms: { tBloom: { value: null }, tScene: { value: null }, bloom: { value: 0.5 }, grain: { value: 0.025 }, time: { value: 0 }, exposure: { value: 1.05 } },
      vertexShader: vs,
      fragmentShader: [
        'uniform sampler2D tScene; uniform sampler2D tBloom;',
        'uniform float bloom; uniform float time; uniform float grain; uniform float exposure;',
        'varying vec2 vPostUv;',
        'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }',
        'vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }',
        'void main(){',
        '  vec3 base = texture2D(tScene, vPostUv).rgb;',
        '  vec3 glow = texture2D(tBloom, vPostUv).rgb;',
        '  vec3 col = base + glow * bloom;',
        '  col = aces(col * exposure);',
        '  vec2 q = vPostUv - 0.5;',
        '  float vig = 1.0 - smoothstep(0.18, 0.85, length(q * vec2(1.05, 1.25)));',
        '  col *= mix(0.72, 1.0, vig);',
        '  vec3 lo = col * 12.92;',
        '  vec3 hi = 1.055 * pow(max(col, vec3(0.0)), vec3(0.41666667)) - 0.055;',
        '  col = mix(lo, hi, step(vec3(0.0031308), col));',
        '  col += (hash(vPostUv * 1024.0 + time) - 0.5) * grain;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}',
      ].join('\n'),
      depthTest: false, depthWrite: false,
    });
    const gl = r.getContext();
    r.setRenderTarget(this.rtScene);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    r.setRenderTarget(null);
    if (!complete) throw new Error('post framebuffer incomplete');
    this.postOk = true;
  }

  _resizePost(w, h) {
    if (!this.rtScene) return;
    this.rtScene.setSize(w, h);
    this.rtA.setSize(Math.max(2, Math.floor(w / 2)), Math.max(2, Math.floor(h / 2)));
    this.rtB.setSize(Math.max(2, Math.floor(w / 2)), Math.max(2, Math.floor(h / 2)));
    this.matBlur.uniforms.texel.value.set(2 / w, 2 / h);
  }

  _renderPost() {
    const r = this.renderer;
    r.setRenderTarget(this.rtScene);
    r.render(this.scene, this.camera);

    this.postQuad.material = this.matBright;
    this.matBright.uniforms.tDiffuse.value = this.rtScene.texture;
    r.setRenderTarget(this.rtA);
    r.render(this.postScene, this.postCam);

    this.postQuad.material = this.matBlur;
    this.matBlur.uniforms.tDiffuse.value = this.rtA.texture;
    this.matBlur.uniforms.dir.value.set(1, 0);
    r.setRenderTarget(this.rtB);
    r.render(this.postScene, this.postCam);

    this.matBlur.uniforms.tDiffuse.value = this.rtB.texture;
    this.matBlur.uniforms.dir.value.set(0, 1);
    r.setRenderTarget(this.rtA);
    r.render(this.postScene, this.postCam);

    this.postQuad.material = this.matComposite;
    this.matComposite.uniforms.tScene.value = this.rtScene.texture;
    this.matComposite.uniforms.tBloom.value = this.rtA.texture;
    this.matComposite.uniforms.time.value = this.time;
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCam);
  }

  resize() {
    const doc = document.documentElement;
    let w = window.innerWidth || (doc && doc.clientWidth) || 0;
    let h = window.innerHeight || (doc && doc.clientHeight) || 0;
    // some embedded webviews report 0 before the first layout pass
    if (!(w > 1)) w = 1280;
    if (!(h > 1)) h = 720;
    this.renderer.setSize(w, h, true);
    this.camera.aspect = Math.min(4, Math.max(0.3, w / h));
    this.camera.fov = 62;
    this.camera.updateProjectionMatrix();
    if (this.postOk && !this.postDisabled) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this._resizePost(Math.max(2, Math.floor(size.x)), Math.max(2, Math.floor(size.y)));
    }
  }

  setQuality(q) {
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    this.renderer.shadowMap.enabled = q.shadow > 0;
    if (this.sun) {
      this.sun.castShadow = q.shadow > 0;
      this.sun.shadow.mapSize.set(q.shadow || 1024, q.shadow || 1024);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    if (this.treeMesh) this.treeMesh.castShadow = q.shadow > 0;
    if (this.treeMesh) this.treeMesh.count = Math.max(1, Math.floor(this.stage.trees.length * (q.trees || 1)));
    if (this.snowGeo && this.theme && this.theme.snowFall > 0) {
      const n = Math.min(this.snowTotal || 0, q.snow || 0);
      this.snowGeo.setDrawRange(0, Math.max(0, n));
    }
    if (q.shadow === 0 && this.postOk) this._teardownPost();
    // switching up from the low preset should also bring the post pipeline back
    if (!this.postDisabled && !this.postOk && q.shadow > 0) {
      try { this._setupPost(); } catch (e) { console.warn('[rally] post unavailable', e); }
    }
    this.resize();
  }

  _teardownPost() {
    if (!this.postOk) return;
    this.postOk = false;
    for (const rt of [this.rtScene, this.rtA, this.rtB]) {
      try { if (rt) rt.dispose(); } catch (e) { /* ignore */ }
    }
    for (const m of [this.matBright, this.matBlur, this.matComposite]) {
      try { if (m) m.dispose(); } catch (e) { /* ignore */ }
    }
    try { if (this.postQuad) this.postQuad.geometry.dispose(); } catch (e) { /* ignore */ }
    this.rtScene = this.rtA = this.rtB = null;
    this.postScene = this.postCam = this.postQuad = null;
    this.matBright = this.matBlur = this.matComposite = null;
  }

  _spawnSpray(x, y, z, amount) {
    const pos = this.sprayGeo.attributes.position.array;
    for (let i = 0; i < amount; i++) {
      const idx = this.sprayIdx++ % this.sprayLife.length;
      pos[idx * 3] = x + (Math.random() - 0.5) * 0.6;
      pos[idx * 3 + 1] = y + 0.15;
      pos[idx * 3 + 2] = z + (Math.random() - 0.5) * 0.6;
      this.sprayVel[idx * 3] = (Math.random() - 0.5) * 4.5;
      this.sprayVel[idx * 3 + 1] = 1.6 + Math.random() * 3.4;
      this.sprayVel[idx * 3 + 2] = (Math.random() - 0.5) * 4.5;
      this.sprayLife[idx] = 0.5 + Math.random() * 0.55;
    }
    this.sprayGeo.attributes.position.needsUpdate = true;
  }

  update(dt, car, camMode = 0) {
    this.time += dt;
    const t = this.theme;
    if (this.skyMat) this.skyMat.uniforms.time.value = this.time;

    // car transform
    const root = this.car.root;
    // the road mesh sits 6 cm above the physics surface; lift the car to match
    root.position.set(car.pos.x, car.pos.y + 0.06, car.pos.z);
    root.rotation.y = car.yaw;
    if (this.carShadow) {
      this.carShadow.position.set(car.pos.x, car.pos.y + 0.075, car.pos.z);
      this.carShadow.rotation.y = car.yaw;
    }
    this.car.body.rotation.x = -car.pitch;
    this.car.body.rotation.z = car.roll;
    this.car.body.position.y = Math.sin(this.time * 2.4) * 0.004 + (car.grounded ? 0 : 0.04);
    for (let i = 0; i < this.car.wheels.length; i++) {
      const w = this.car.wheels[i];
      const sus = car.suspension[i] || 0;
      w.pivot.position.y = 0.345 + sus * 0.5;
      if (w.front) w.pivot.rotation.y = -car.steer * 1.15;
      const locked = car.handbrake && !w.front;
      const spin = locked ? 0 : car.speed / 0.345 + (w.front ? 0 : car.wheelSpin * 18);
      w.spin.rotation.x += spin * dt;
    }

    // spray from the rear wheels when the tyres are working
    const sprayAmount = car.grounded ? clamp(car.slip * 1.4 + Math.abs(car.throttle - car.brake) * 0.5, 0, 1) * (car.surface === 'offroad' ? 1.2 : 0.85) : 0;
    if (sprayAmount > 0.12 && Math.random() < sprayAmount) {
      const fx = Math.sin(car.yaw);
      const fz = Math.cos(car.yaw);
      const rx = Math.cos(car.yaw);
      const rz = -Math.sin(car.yaw);
      this._spawnSpray(
        car.pos.x - fx * 1.3 + rx * 0.79,
        car.pos.y + 0.2,
        car.pos.z - fz * 1.3 + rz * 0.79,
        2
      );
      this._spawnSpray(car.pos.x - fx * 1.3 - rx * 0.79, car.pos.y + 0.2, car.pos.z - fz * 1.3 - rz * 0.79, 2);
      if (car.slip > 0.35) {
        this._spawnSpray(
          car.pos.x + fx * 1.3 + rx * 0.79,
          car.pos.y + 0.2,
          car.pos.z + fz * 1.3 + rz * 0.79,
          1
        );
        this._spawnSpray(car.pos.x + fx * 1.3 - rx * 0.79, car.pos.y + 0.2, car.pos.z + fz * 1.3 - rz * 0.79, 1);
      }
    }
    if (this.sprayLife) {
      const pos = this.sprayGeo.attributes.position.array;
      for (let i = 0; i < this.sprayLife.length; i++) {
        if (this.sprayLife[i] <= 0) continue;
        this.sprayLife[i] -= dt;
        this.sprayVel[i * 3 + 1] -= 9 * dt;
        pos[i * 3] += this.sprayVel[i * 3] * dt;
        pos[i * 3 + 1] += this.sprayVel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += this.sprayVel[i * 3 + 2] * dt;
        if (this.sprayLife[i] <= 0) pos[i * 3 + 1] = -1000;
      }
      this.sprayGeo.attributes.position.needsUpdate = true;
    }

    // snow follows the camera
    if (this.snow) {
      const pos = this.snowGeo.attributes.position.array;
      const cx = this.camera.position.x;
      const cy = this.camera.position.y;
      const cz = this.camera.position.z;
      for (let i = 0; i < pos.length / 3; i++) {
        pos[i * 3] += this.snowVel[i * 3] * dt;
        pos[i * 3 + 1] -= this.snowVel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += this.snowVel[i * 3 + 2] * dt;
        // keep the flake box centred on the camera so高速行驶时 the field does not get left behind
        if (pos[i * 3] - cx < -45) pos[i * 3] += 90;
        else if (pos[i * 3] - cx > 45) pos[i * 3] -= 90;
        if (pos[i * 3 + 2] - cz < -45) pos[i * 3 + 2] += 90;
        else if (pos[i * 3 + 2] - cz > 45) pos[i * 3 + 2] -= 90;
        if (pos[i * 3 + 1] < cy - 6) {
          pos[i * 3] = cx + (Math.random() - 0.5) * 90;
          pos[i * 3 + 1] = cy + 26 + Math.random() * 12;
          pos[i * 3 + 2] = cz + (Math.random() - 0.5) * 90;
        }
      }
      this.snowGeo.attributes.position.needsUpdate = true;
    }

    // camera
    const speed = Math.hypot(car.vx, car.vz);
    this.shake = damp(this.shake, car.bump + (car.grounded ? 0 : 0.06), 4, dt);
    car.bump = damp(car.bump, 0, 3, dt);

    let camYaw = car.yaw;
    if (speed > 4 && car.speed > 4) {
      const velYaw = Math.atan2(car.vx, car.vz);
      let slip = velYaw - car.yaw;
      slip = Math.atan2(Math.sin(slip), Math.cos(slip));
      camYaw = car.yaw + clamp(slip * 0.35, -0.5, 0.5);
    }
    if (this.camYaw === undefined) {
      this.camYaw = camYaw;
    } else {
      // shortest-arc angular damping: linear damping across the ±pi wrap spins the camera
      const d = Math.atan2(Math.sin(camYaw - this.camYaw), Math.cos(camYaw - this.camYaw));
      this.camYaw = wrapAngle(this.camYaw + d * (1 - Math.exp(-6 * dt)));
    }

    if (this.interior) this.interior.visible = camMode === 2;
    if (this.shellMeshes) for (const m of this.shellMeshes) m.visible = camMode !== 2;
    // wheels are outside the cabin: hide them with the shell so no tyre shows through the door
    if (this.car && this.car.wheels) for (const w of this.car.wheels) w.pivot.visible = camMode !== 2;
    if (this.steerWheel) this.steerWheel.rotation.z = -car.steer * 2.4;
    if (camMode === 2 && this.gaugeNeedles && this.gaugeNeedles.length === 2) {
      const tach = clamp(car.rpm / 7600, 0, 1);
      const kmh = clamp(Math.abs(car.speed) * 3.6 / 180, 0, 1);
      this.gaugeNeedles[0].rotation.z = -2.1 + tach * 2.5;
      this.gaugeNeedles[1].rotation.z = -2.1 + kmh * 2.5;
    }
    if (this.glassMat) this.glassMat.opacity = camMode === 2 ? 0.32 : 0.9;
    if (this.lightRMat) {
      const braking = car.ax < -2.2 && speed > 2;
      this.lightRMat.emissiveIntensity = damp(this.lightRMat.emissiveIntensity, braking ? 3.2 : 0.55, 12, dt);
    }

    if (camMode === 2) {
      // The eye is attached with yaw only: body pitch/roll (which can swing hard in a
      // spin) only nudges the look direction, so the camera can never leave the cabin.
      // The eye follows the body's full attitude, but its displacement is capped at a few
      // centimetres around the seat anchor, so pitch/roll can be *felt* without ever
      // throwing the camera out of the cabin.
      const yawQ = new THREE.Quaternion().setFromAxisAngle(Y_UP, car.yaw);
      const bodyQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-car.pitch, car.yaw, car.roll, 'YXZ'));
      const base = new THREE.Vector3(...COCKPIT_EYE);
      base.y += 0.06; // body group lift
      const anchor = base.clone().applyQuaternion(yawQ).add(car.pos);
      const shift = base.clone().applyQuaternion(bodyQ).add(car.pos).sub(anchor);
      const MAX_SHIFT = 0.06;
      if (shift.lengthSq() > MAX_SHIFT * MAX_SHIFT) shift.setLength(MAX_SHIFT);
      const eye = anchor.add(shift);
      const tilt = new THREE.Euler(
        -clamp(car.pitch, -0.12, 0.12) * 0.6,
        0,
        clamp(car.roll, -0.18, 0.18) * 0.5,
        'YXZ'
      );
      const look = new THREE.Vector3(...COCKPIT_LOOK).applyEuler(tilt).applyQuaternion(yawQ).add(car.pos);
      look.y += 0.06;
      this.camera.position.copy(eye);
      this.camera.lookAt(look);
      if (this.camera.near !== 0.05) { this.camera.near = 0.05; this.camera.updateProjectionMatrix(); }
      if (Math.abs(this.camera.fov - COCKPIT_FOV) > 0.01) { this.camera.fov = COCKPIT_FOV; this.camera.updateProjectionMatrix(); }
    } else if (camMode === 1) {
      // bonnet cam: just above the hood line, so the car is visible instead of the
      // camera sitting inside the windscreen
      const yawQ = new THREE.Quaternion().setFromAxisAngle(Y_UP, car.yaw);
      const bodyQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-car.pitch, car.yaw, car.roll, 'YXZ'));
      const base = new THREE.Vector3(...BONNET_EYE);
      base.y += 0.06; // body group lift
      const anchor = base.clone().applyQuaternion(yawQ).add(car.pos);
      const shift = base.clone().applyQuaternion(bodyQ).add(car.pos).sub(anchor);
      const MAX_SHIFT = 0.08;
      if (shift.lengthSq() > MAX_SHIFT * MAX_SHIFT) shift.setLength(MAX_SHIFT);
      const eye = anchor.add(shift);
      const tilt = new THREE.Euler(
        -clamp(car.pitch, -0.15, 0.15) * 0.5,
        0,
        clamp(car.roll, -0.2, 0.2) * 0.4,
        'YXZ'
      );
      const look = new THREE.Vector3(...BONNET_LOOK).applyEuler(tilt).applyQuaternion(yawQ).add(car.pos);
      look.y += 0.06;
      this.camera.position.copy(eye);
      this.camera.lookAt(look);
      if (this.camera.near !== 0.2) { this.camera.near = 0.2; this.camera.updateProjectionMatrix(); }
      if (Math.abs(this.camera.fov - BONNET_FOV) > 0.01) { this.camera.fov = BONNET_FOV; this.camera.updateProjectionMatrix(); }
    } else {
      const back = 7.2 + speed * 0.08;
      const height = 2.62 + speed * 0.013;
      const want = new THREE.Vector3(
        car.pos.x - Math.sin(this.camYaw) * back,
        car.pos.y + height,
        car.pos.z - Math.cos(this.camYaw) * back
      );
      const wantLook = new THREE.Vector3(
        car.pos.x + Math.sin(this.camYaw) * (7 + speed * 0.12),
        car.pos.y + 1.25,
        car.pos.z + Math.cos(this.camYaw) * (7 + speed * 0.12)
      );
      if (!this._camInit) {
        this.camPos.copy(want);
        this.camLook.copy(wantLook);
        this._camInit = true;
      }
      this.camPos.x = damp(this.camPos.x, want.x, 5.5, dt);
      this.camPos.y = damp(this.camPos.y, want.y, 4.5, dt);
      this.camPos.z = damp(this.camPos.z, want.z, 5.5, dt);
      this.camLook.x = damp(this.camLook.x, wantLook.x, 8, dt);
      this.camLook.y = damp(this.camLook.y, wantLook.y, 6, dt);
      this.camLook.z = damp(this.camLook.z, wantLook.z, 8, dt);

      const groundY = this.stage.heightAt(this.camPos.x, this.camPos.z) + 1.0;
      if (this.camPos.y < groundY) this.camPos.y = groundY;
      const sh = this.shake * 0.35;
      this.camera.position.set(
        this.camPos.x + (Math.random() - 0.5) * sh,
        this.camPos.y + (Math.random() - 0.5) * sh,
        this.camPos.z + (Math.random() - 0.5) * sh
      );
      this.camera.lookAt(this.camLook);
      if (this.camera.near !== 0.2) { this.camera.near = 0.2; this.camera.updateProjectionMatrix(); }
      const targetFov = 62 + clamp(speed * 0.28, 0, 12);
      this.camera.fov = damp(this.camera.fov, targetFov, 3, dt);
      this.camera.updateProjectionMatrix();
    }

    // sun shadow follows the car, snapped to texels
    const sun = this.sun;
    if (sun) {
      const texel = 104 / (this.quality.shadow || 1024);
      const tx = Math.round(car.pos.x / texel) * texel;
      const tz = Math.round(car.pos.z / texel) * texel;
      this.sunTarget.position.set(tx, car.pos.y, tz);
      sun.position.set(tx + this.sunDir.x * 150, car.pos.y + this.sunDir.y * 150, tz + this.sunDir.z * 150);
      sun.target.updateMatrixWorld();
    }

    // sky follows the camera so it never clips
    this.sky.position.copy(this.camera.position);
  }

  render() {
    if (this.postOk) {
      try { this._renderPost(); return; } catch (e) {
        console.warn('[rally] post failed, falling back', e);
        this.postOk = false;
        this.renderer.setRenderTarget(null);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    // InstancedMesh keeps its own instanceMatrix / instanceColor buffers
    for (const m of [this.treeMesh, this.rockMesh, this.poleMesh]) if (m && m.dispose) m.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        for (const k of ['map', 'alphaMap', 'normalMap', 'roughnessMap']) {
          if (m[k] && m[k].dispose) m[k].dispose();
        }
        m.dispose();
      }
    });
    for (const rt of [this.rtScene, this.rtA, this.rtB]) if (rt) rt.dispose();
    this.rtScene = this.rtA = this.rtB = null;
    this.postOk = false;
    if (this.postQuad) { this.postQuad.geometry.dispose(); this.postQuad.material = null; }
    for (const m of [this.matBright, this.matBlur, this.matComposite]) if (m) m.dispose();
    this.matBright = this.matBlur = this.matComposite = null;
    if (this.sun && this.sun.shadow && this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    if (this.scene.environment) this.scene.environment.dispose();
    if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    this.scene.clear();
    this.scene = null;
  }
}
