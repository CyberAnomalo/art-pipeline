/* 验证：gaussian_raster.gdshader 里的 ink_anim() 是否是 src/splat-frames.js 的忠实移植。
 *
 * 做法：把 GLSL 的实现逐行镜像成 JS（下面 inkAnim），对同一批 splat、同一批时间，
 * 和 ink-studio 的权威 CPU 解算器 SplatFrames.sample(i).position() / .opacity() 比较。
 * 这样能在不开 GPU 的情况下抓出公式错误（比如赋值顺序、用了改写后的 x）。
 */
const INK = require('./find-ink.js');
const path = require('path');
const lib = require(INK + '/index.js').load();
const KIT = lib.KIT;
const SplatFrames = require(INK + '/src/splat-frames.js');
const { pose } = require(INK + '/cli/diarama-pose.js');

// --- 最小 3x3 矩阵库（SplatFrames 需要 M.mul / tr / det / inv / app / id）---
const M = {
  mul: (a, b) => {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
  },
  tr: (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]],
  det: (a) => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]),
  inv: (a) => {
    const d = M.det(a), o = new Array(9);
    o[0] = (a[4] * a[8] - a[5] * a[7]) / d; o[1] = (a[2] * a[7] - a[1] * a[8]) / d; o[2] = (a[1] * a[5] - a[2] * a[4]) / d;
    o[3] = (a[5] * a[6] - a[3] * a[8]) / d; o[4] = (a[0] * a[8] - a[2] * a[6]) / d; o[5] = (a[2] * a[3] - a[0] * a[5]) / d;
    o[6] = (a[3] * a[7] - a[4] * a[6]) / d; o[7] = (a[1] * a[6] - a[0] * a[7]) / d; o[8] = (a[0] * a[4] - a[1] * a[3]) / d;
    return o;
  },
  app: (a, v) => [0, 1, 2].map(r => a[r * 3] * v[0] + a[r * 3 + 1] * v[1] + a[r * 3 + 2] * v[2]),
  id: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
};

// --- 逐行镜像 gaussian_raster.gdshader 的 ink_anim() ---
function smooth(a, b, x) { x = Math.max(0, Math.min(1, (x - a) / (b - a))); return x * x * (3 - 2 * x); }

function inkAnim(p, alpha, kindF, ph, sp, rg, ex, time) {
  const kind = Math.round(kindF);
  const C = { x: p[0], y: p[1], z: p[2], alpha, covScale: 1 };
  if (kind === 0) return C;
  if (kind === 5) {
    const a = time * sp, c = Math.cos(a), s = Math.sin(a);
    const ox = C.x, oz = C.z;             // GLSL 里必须显式保存旧值
    C.x = c * ox + s * oz;
    C.z = c * oz - s * ox;
  } else if ((kind === 2 || kind === 3 || kind === 15) && Math.abs(rg) > 1e-8) {
    const tick = time * sp / rg + ph;
    const u = tick - Math.floor(tick);
    C.y += (kind === 3 ? 1 : -1) * u * rg;
    if (kind === 3) C.x += Math.sin(u * 7 + ph * 50) * 0.25 * u;
    if (kind === 15) {
      C.x += Math.sin(u * 11 + ph * 40) * ex;
      C.z += Math.cos(u * 7 + ph * 23) * ex * 0.6;
    }
    if (kind === 2) C.alpha *= 1 - u * u;
    else if (kind === 3) C.alpha *= (1 - u) * smooth(0, 0.1, u);
    else C.alpha *= smooth(0, 0.05, u) * (1 - smooth(0.92, 1, u));
    C.covScale = (kind === 2 || kind === 3) ? ((kind === 3 ? 0.6 : 1) + u * ex) : 1;
  } else if (kind === 6) {
    C.y += Math.sin(time * sp + ph) * rg;
  } else if (kind === 8) {
    const flap = 0.2 + 0.8 * Math.abs(Math.sin(time * sp + ph));
    C.x = rg + (C.x - rg) * flap;
    C.z = ex + (C.z - ex) * flap;
    C.y += 0.14 * Math.sin(time * sp * 0.31 + ph);
  } else if (kind === 9) {
    const scale = 1 + rg * Math.sin(time * sp + ph - C.y * ex);
    C.x *= scale;
    C.z *= scale;
  } else if (kind === 10) {
    const r = Math.hypot(C.x, C.z);
    C.y += rg * Math.min(1, r * 0.22) * Math.sin(time * sp + r * ex);
  } else if (kind === 11) {
    C.x += rg * Math.sin(time * sp + C.y * 1.3 + C.z * 0.9 + ph);
    C.y += rg * 0.6 * Math.sin(time * sp * 1.3 + C.x * 1.1 + ph);  // 用改写后的 x
  } else if (kind === 14) {
    const spread = rg * Math.max(0, C.y - ex);
    C.x += spread * Math.sin(time * sp + ph);
    C.z += spread * 0.6 * Math.sin(time * sp * 0.73 + ph * 1.7);
  }
  if (kind === 1) C.alpha *= 0.62 + 0.38 * Math.sin(time * sp + ph);
  else if (kind === 7) C.alpha *= 0.82 + 0.18 * Math.sin(time * sp + ph);
  return C;
}

// --- 跑对照 ---
const ex = process.argv[2] || 'motion-cadence.js';
const descriptor = require(path.join(INK, 'examples', ex))({ makeBuilder: lib.makeBuilder, makeSculpt: lib.makeSculpt, KIT });
const world = descriptor.build(descriptor.seed ?? 0);
const D = world.data, n = world.count;

const VFX = new Set([1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 14, 15]);
const buckets = new Map();
for (let i = 0; i < n; i++) {
  const kind = Math.round(D[i * 16 + 11]) % 16;
  if (!VFX.has(kind)) continue;
  if (!buckets.has(kind)) buckets.set(kind, []);
  const arr = buckets.get(kind);
  if (arr.length < 40) arr.push(i);
}
console.log(`场景 ${ex}：${n} splat，程序化 kind = ${[...buckets.keys()].sort((a, b) => a - b).join(',')}`);

let worstPos = 0, worstAlpha = 0, worstCov = 0, checks = 0;
for (const time of [0, 0.137, 1.0, 3.71, 17.5]) {
  pose(world, time, { kit: lib });
  const sample = SplatFrames.create(world, time, M);
  for (const [kind, ids] of buckets) {
    for (const i of ids) {
      const q = i * 16;
      const s = sample(i);
      const truthPos = s.position();
      const truthAlpha = s.opacity();
      const truthCov = s.covariance();

      const mine = inkAnim(
        [D[q], D[q + 1], D[q + 2]], D[q + 3],
        kind, D[q + 12], D[q + 13], D[q + 14], D[q + 15], time);

      worstPos = Math.max(worstPos, Math.hypot(
        mine.x - truthPos[0], mine.y - truthPos[1], mine.z - truthPos[2]));
      worstAlpha = Math.max(worstAlpha, Math.abs(mine.alpha - truthAlpha));

      // 协方差：我们只做 A·C·Aᵀ（kind 5）和 scale²（kind 2/3）
      const [xx, xy, xz, yy, yz, zz] = [4, 5, 6, 8, 9, 10].map(k => D[q + k]);
      const Cm = [xx, xy, xz, xy, yy, yz, xz, yz, zz];
      let expect;
      if (kind === 5) {
        const a = time * D[q + 13], c = Math.cos(a), sn = Math.sin(a);
        const A = [c, 0, sn, 0, 1, 0, -sn, 0, c];
        expect = M.mul(M.mul(A, Cm), M.tr(A));
      } else {
        const k2 = mine.covScale * mine.covScale;
        expect = Cm.map(v => v * k2);
      }
      for (let j = 0; j < 6; j++) {
        const idx = [0, 1, 2, 4, 5, 8][j];
        worstCov = Math.max(worstCov, Math.abs(expect[idx] - truthCov[j]) / Math.max(1e-6, Math.abs(truthCov[j])));
      }
      checks++;
    }
  }
}

console.log(`比较 ${checks} 组（splat × 时间 × kind）`);
console.log(`位置最大误差   : ${worstPos.toExponential(3)}`);
console.log(`不透明度最大误差: ${worstAlpha.toExponential(3)}`);
console.log(`协方差最大相对误差: ${worstCov.toExponential(3)}`);

const ok = worstPos < 1e-4 && worstAlpha < 1e-4 && worstCov < 1e-3;
console.log(ok ? '\n✅ ink_anim() 与 SplatFrames 一致' : '\n❌ 有偏差，需要修着色器');
process.exit(ok ? 0 : 1);
