/*
 * inkstudio2ply-boned.js — 把 ink-studio 的骨骼动画角色导出成 Godot 能驱动的多块 PLY
 *
 * ink-studio 的骨骼模型（src/kit/k1-stage.js:625-628, src/splat-frames.js）：
 *   lane11 的 kind 12/13 = 骨骼蒙皮
 *   lane12 = 骨骼索引 A   lane13 = 骨骼索引 B   lane14 = B 的权重
 *   anim.bones = Float32Array(12 * 骨数)，每根骨 12 个数：3x3 行主序 + 平移
 *   最终位置 P' = M行主序 · P + T（双骨再按权重插值）
 *
 * 因为 pose-blocking 这类场景的第二骨权重为 0，逐骨刚性切开是**精确**的，不是近似。
 *
 * 用法：
 *   node inkstudio2ply-boned.js --example pose-blocking.js --out out/courier --fps 24 --seconds 2
 *   node inkstudio2ply-boned.js --list-examples
 */
const fs = require('fs');
const path = require('path');

const INK = require('./find-ink.js');
const SH_C0 = 0.28209479177387814;

function parseArgs(argv) {
  const a = { example: 'pose-blocking.js', out: 'out/boned', fps: 24, seconds: 2, alpha: 0.98 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--example') a.example = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--fps') a.fps = Number(argv[++i]);
    else if (k === '--seconds') a.seconds = Number(argv[++i]);
    else if (k === '--alpha') a.alpha = Number(argv[++i]);
    else if (k === '--list-examples') a.list = true;
  }
  return a;
}

// 对称 3x3 的 Jacobi 特征分解（返回列向量为特征向量，按特征值降序）
function eigenSymmetric(a00, a01, a02, a11, a12, a22) {
  const A = [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 64; sweep++) {
    const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
    if (off < 1e-30) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const kp = A[k][p], kq = A[k][q];
          A[k][p] = c * kp - s * kq; A[k][q] = s * kp + c * kq;
        }
        for (let k = 0; k < 3; k++) {
          const pk = A[p][k], qk = A[q][k];
          A[p][k] = c * pk - s * qk; A[q][k] = s * pk + c * qk;
        }
        for (let k = 0; k < 3; k++) {
          const kp = V[k][p], kq = V[k][q];
          V[k][p] = c * kp - s * kq; V[k][q] = s * kp + c * kq;
        }
      }
    }
  }
  const idx = [0, 1, 2].sort((x, y) => A[y][y] - A[x][x]);
  return {
    values: [A[idx[0]][idx[0]], A[idx[1]][idx[1]], A[idx[2]][idx[2]]],
    vectors: [
      [V[0][idx[0]], V[0][idx[1]], V[0][idx[2]]],
      [V[1][idx[0]], V[1][idx[1]], V[1][idx[2]]],
      [V[2][idx[0]], V[2][idx[1]], V[2][idx[2]]],
    ],
  };
}

function matrixToQuaternion(r) {
  const det =
    r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
    r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
    r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  if (det < 0) { r[0][2] = -r[0][2]; r[1][2] = -r[1][2]; r[2][2] = -r[2][2]; }
  const trace = r[0][0] + r[1][1] + r[2][2];
  let w, x, y, z;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2;
    w = 0.25 * s; x = (r[2][1] - r[1][2]) / s; y = (r[0][2] - r[2][0]) / s; z = (r[1][0] - r[0][1]) / s;
  } else if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = Math.sqrt(1.0 + r[0][0] - r[1][1] - r[2][2]) * 2;
    w = (r[2][1] - r[1][2]) / s; x = 0.25 * s; y = (r[0][1] + r[1][0]) / s; z = (r[0][2] + r[2][0]) / s;
  } else if (r[1][1] > r[2][2]) {
    const s = Math.sqrt(1.0 + r[1][1] - r[0][0] - r[2][2]) * 2;
    w = (r[0][2] - r[2][0]) / s; x = (r[0][1] + r[1][0]) / s; y = 0.25 * s; z = (r[1][2] + r[2][1]) / s;
  } else {
    const s = Math.sqrt(1.0 + r[2][2] - r[0][0] - r[1][1]) * 2;
    w = (r[1][0] - r[0][1]) / s; x = (r[0][2] + r[2][0]) / s; y = (r[1][2] + r[2][1]) / s; z = 0.25 * s;
  }
  const len = Math.hypot(w, x, y, z) || 1;
  return [w / len, x / len, y / len, z / len];
}

const logit = (p) => Math.log(p / (1 - p));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

// 程序化 VFX：ink-studio 颜色是平的，45 个高阶 SH 槽全空，从中拿 5 个装动画记录。
// f_rest 是通道交错的（0..14=R, 15..29=G, 30..44=B），所以这 5 个名字正好解码成
// sh_coeffs[3..7] —— 也就是改过的 GDGS raster 着色器读的那五个槽。
const VFX_PROPS = ['f_rest_0', 'f_rest_15', 'f_rest_30', 'f_rest_1', 'f_rest_16'];

// 一组 splat 索引 -> PLY 字节
function writePly(D, ids, alphaCap, label, vfx = false) {
  const n = ids.length;
  const props = vfx ? PROPS.concat(VFX_PROPS) : PROPS;
  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    'comment ink-studio boned splats: ' + label + '\n' +
    'element vertex ' + n + '\n' +
    props.map((p) => 'property float ' + p + '\n').join('') +
    'end_header\n';
  const body = Buffer.alloc(n * props.length * 4);
  let o = 0;
  const centroid = [0, 0, 0];
  for (const i of ids) {
    const b = i * 16;
    const x = D[b], y = D[b + 1], z = D[b + 2];
    centroid[0] += x; centroid[1] += y; centroid[2] += z;
    const eig = eigenSymmetric(D[b + 4], D[b + 5], D[b + 6], D[b + 8], D[b + 9], D[b + 10]);
    const sigma = eig.values.map((v) => Math.sqrt(Math.max(v, 0)));
    const a = clamp(Math.min(1, Math.max(0, D[b + 3])), 1e-4, 0.999);
    const opacity = logit(Math.min(a, alphaCap));
    const q = matrixToQuaternion(eig.vectors);
    const packed = Math.round(D[b + 7]);
    const f = (c) => (c - 0.5) / SH_C0;
    const vals = [
      x, y, z,
      f((packed & 255) / 255), f(((packed >> 8) & 255) / 255), f(((packed >> 16) & 255) / 255),
      opacity,
      Math.log(Math.max(sigma[0], 1e-9)), Math.log(Math.max(sigma[1], 1e-9)), Math.log(Math.max(sigma[2], 1e-9)),
      q[0], q[1], q[2], q[3],
    ];
    for (let k = 0; k < 14; k++) { body.writeFloatLE(vals[k], o); o += 4; }
    if (vfx) {
      const kind = Math.round(D[b + 11]) % 16;
      // kind 12/13 的 lane12-14 是骨骼索引，走逐骨节点那条路，这里必须留零。
      const skeletal = kind === 12 || kind === 13;
      body.writeFloatLE(kind, o); o += 4;                       // f_rest_0  -> c[3]
      body.writeFloatLE(skeletal ? 0 : D[b + 12], o); o += 4;   // f_rest_15 -> c[4]
      body.writeFloatLE(skeletal ? 0 : D[b + 13], o); o += 4;   // f_rest_30 -> c[5]
      body.writeFloatLE(skeletal ? 0 : D[b + 14], o); o += 4;   // f_rest_1  -> c[6]
      body.writeFloatLE(skeletal ? 0 : D[b + 15], o); o += 4;   // f_rest_16 -> c[7]
    }
  }
  if (n) { centroid[0] /= n; centroid[1] /= n; centroid[2] /= n; }
  return { buffer: Buffer.concat([Buffer.from(header, 'ascii'), body]), centroid, count: n };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lib = require(path.join(INK, 'index.js')).load();
  const K = lib.KIT;
  const factory = { makeBuilder: lib.makeBuilder, makeSculpt: lib.makeSculpt, KIT: K };

  if (args.list) {
    console.log('examples 目录里带骨骼 anim.bones 的场景需要逐个探测，先用：');
    console.log('  pose-blocking.js   Signal courier 3920 splat / 10 骨 / 100% 骨骼 / 0 混合权重');
    console.log('  animation-timeline.js  8922 / 11 骨');
    console.log('  puppet.js         1849 / 7 骨 / 有双骨混合');
    return;
  }

  const t0 = Date.now();
  const desc = require(path.join(INK, 'examples', args.example))(factory);
  const W = desc.build(desc.seed ?? 0);
  const buildMs = Date.now() - t0;

  const D = W.data, N = W.count, an = W.anim;
  // 没有骨骼的场景（纯场景/纯 VFX）也能导：全部当作 fixed，带上 VFX 参数即可。
  const hasBones = !!(an && an.bones);
  const boneCount = hasBones ? an.bones.length / 12 : 0;

  // ---- 按骨骼分组（第二骨权重 > 0.5 时归给第二骨）
  const idsByBone = Array.from({ length: boneCount }, () => []);
  const fixed = [];
  let blended = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 16, kind = Math.round(D[o + 11]) % 16;
    if (!hasBones || (kind !== 12 && kind !== 13)) { fixed.push(i); continue; }
    const a = Math.round(D[o + 12]), b = Math.round(D[o + 13]), w = D[o + 14];
    if (w > 0) blended++;
    idsByBone[w >= 0.5 && b > 0 ? b : a].push(i);
  }

  fs.mkdirSync(args.out, { recursive: true });
  const bones = [];
  for (let b = 0; b < boneCount; b++) {
    if (!idsByBone[b].length) continue;
    const ply = writePly(D, idsByBone[b], args.alpha, 'bone ' + b);
    const file = 'bone_' + String(b).padStart(2, '0') + '.ply';
    fs.writeFileSync(path.join(args.out, file), ply.buffer);
    bones.push({ index: b, file, count: ply.count, centroid: ply.centroid, fixed: false });
  }
  if (fixed.length) {
    const ply = writePly(D, fixed, args.alpha, 'static', true);
    fs.writeFileSync(path.join(args.out, 'fixed.ply'), ply.buffer);
    bones.push({ index: -1, file: 'fixed.ply', count: ply.count, centroid: ply.centroid, fixed: true });
  }

  // ---- 采样骨骼矩阵
  const frameCount = hasBones ? Math.max(1, Math.round(args.fps * args.seconds)) : 0;
  const frames = [];
  let prev = 0;
  for (let f = 0; f < frameCount; f++) {
    const t = f / args.fps;
    an.update(Math.max(0, t - prev), t);
    prev = t;
    const m = Array.from(an.bones, (v) => Number(v.toFixed(6)));
    frames.push({ t: Number(t.toFixed(4)), m });
  }

  // ---- 自检：用导出的 (bind 位置, 骨骼矩阵) 重建，必须与 K.bones.posed 一致
  let maxErr = 0;
  if (hasBones) {
    an.update(0, 0);
    prev = 0;
    const midT = frameCount > 1 ? Math.floor(frameCount / 2) / args.fps : 0;
    an.update(midT, midT);
    const posed = K.bones.posed(W);
    const M = an.bones;
    for (let b = 0; b < boneCount; b++) {
      for (const i of idsByBone[b]) {
        const o = i * 16, k = b * 12;
        const x = D[o], y = D[o + 1], z = D[o + 2];
        const px = M[k] * x + M[k + 1] * y + M[k + 2] * z + M[k + 9];
        const py = M[k + 3] * x + M[k + 4] * y + M[k + 5] * z + M[k + 10];
        const pz = M[k + 6] * x + M[k + 7] * y + M[k + 8] * z + M[k + 11];
        maxErr = Math.max(maxErr, Math.abs(px - posed[o]), Math.abs(py - posed[o + 1]), Math.abs(pz - posed[o + 2]));
      }
    }
  }

  const meta = {
    source: 'ink-studio',
    example: args.example,
    name: desc.name || desc.id,
    splats: N,
    boneCount,
    blendedSplats: blended,
    fps: args.fps,
    seconds: args.seconds,
    frameCount,
    bones,
    // 每帧每骨 12 个数：3x3 行主序 basis + 平移。
    // Godot: Transform3D(Basis(Vector3(m0,m1,m2),Vector3(m3,m4,m5),Vector3(m6,m7,m8)), origin)
    //        其中 origin = basis * centroid + translation  （GDGS 导入时已减去 centroid）
    frames,
    selfCheck: { maxReconstructionError: maxErr },
    // 像素风后处理需要的调色板信息。
    // ⚠ world.pal 是 0xRRGGBB（红在高字节），和逐 splat 的 packedRGB lane 相反。
    ink: {
      palName: W.palName,
      palette: Array.from(W.pal || []),
      dither: W.dither,
      bg: W.bg,
      radius: W.radius,
    },
  };
  fs.writeFileSync(path.join(args.out, 'anim.json'), JSON.stringify(meta, null, 1));

  const kb = (x) => (x / 1024).toFixed(0) + ' KB';
  console.log('场景        :', args.example, '/', meta.name);
  console.log('splat 总数  :', N, '| 骨骼:', boneCount, '| 混合权重 splat:', blended);
  console.log('非骨骼 splat:', fixed.length, '->', fixed.length ? 'fixed.ply' : '(无)');
  console.log('逐骨分布    :', bones.filter((b) => !b.fixed).map((b) => b.index + ':' + b.count).join(' '));
  console.log('帧          :', frameCount, '@', args.fps, 'fps =', args.seconds, 's');
  console.log('自检误差    :', maxErr.toExponential(2), maxErr < 1e-5 ? '(通过)' : '(失败!)');
  console.log('PLY 总大小  :', kb(bones.reduce((s, b) => s + fs.statSync(path.join(args.out, b.file)).size, 0)));
  console.log('输出        :', path.resolve(args.out));
}

main();
