#!/usr/bin/env node
// inkstudio2ply — bake an ink-studio scene into a standard Gaussian Splatting PLY
// that ReconWorldLab/godot-gaussian-splatting (GDGS) can import into Godot 4.x.
//
// ink-studio splat row = 16 float32 lanes:
//   [x, y, z, density] [c00, c01, c02, packedRGB] [c11, c12, c22, kind] [phase, speed, range, extra]
//   packedRGB = r | g<<8 | b<<16        (0..255 bytes, direct sRGB colour)
//   c**       = symmetric covariance, ABSOLUTE variance in world units
//               (iso(s) writes s*s, axial(sa,sp) writes sp^2 and sa^2-sp^2)
//
// GDGS PLY contract (verified against addons/gdgs/importers/):
//   * format binary_little_endian 1.0, no list properties
//   * scale_*   is log(sigma)   -> importer applies exp()
//   * opacity   is logit(alpha) -> importer applies sigmoid(), then clamps 0..1
//   * rot_0..3  is the quaternion in (w, x, y, z) order  -> importer builds Quaternion(rot_1, rot_2, rot_3, rot_0)
//   * f_dc_*    is SH band 0;  colour = 0.5 + f_dc * 0.28209479177387814, in sRGB
//   * f_rest_*  (45 higher-order SH) may be omitted entirely -> defaults to 0
//   * positions are re-centred on the mean at import time, so the mean is written to the sidecar
//
// Usage:
//   node inkstudio2ply.js --scene 0 --out watcher.ply
//   node inkstudio2ply.js --scene 0 --out w.ply --detail 1 --alpha 0.98
//   node inkstudio2ply.js --list

const fs = require('fs');
const path = require('path');

const INK = path.resolve(__dirname, '..', 'shapeshift-labs-ink-studio');
const SH_C0 = 0.28209479177387814;

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const out = { scene: '0', out: null, alpha: 0.98, detail: 1, minSigma: 0, list: false, stats: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--scene') out.scene = val();
    else if (a === '--out') out.out = val();
    else if (a === '--alpha') out.alpha = Number(val());
    else if (a === '--detail') out.detail = Number(val());
    else if (a === '--min-sigma') out.minSigma = Number(val());
    else if (a === '--vfx') out.vfx = true;
    else if (a === '--example') out.example = val();
    else if (a === '--list') out.list = true;
    else if (a === '--stats') out.stats = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

// ------------------------------------------------- 3x3 symmetric eigen (Jacobi)
// Returns eigenvalues descending and V whose COLUMNS are the unit eigenvectors.
function eigenSymmetric(a00, a01, a02, a11, a12, a22) {
  const A = [
    [a00, a01, a02],
    [a01, a11, a12],
    [a02, a12, a22],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 64; sweep++) {
    const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
    if (off < 1e-30) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // A = Jt A J  with J = rotation in (p,q)
        for (let k = 0; k < 3; k++) {
          const kp = A[k][p], kq = A[k][q];
          A[k][p] = c * kp - s * kq;
          A[k][q] = s * kp + c * kq;
        }
        for (let k = 0; k < 3; k++) {
          const pk = A[p][k], qk = A[q][k];
          A[p][k] = c * pk - s * qk;
          A[q][k] = s * pk + c * qk;
        }
        for (let k = 0; k < 3; k++) {
          const kp = V[k][p], kq = V[k][q];
          V[k][p] = c * kp - s * kq;
          V[k][q] = s * kp + c * kq;
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

// rotation matrix (columns = axes) -> quaternion (w, x, y, z) with det forced +1
function matrixToQuaternion(m) {
  const r = m;
  let det =
    r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
    r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
    r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  if (det < 0) {
    // flip the third axis so the basis stays a proper rotation
    r[0][2] = -r[0][2];
    r[1][2] = -r[1][2];
    r[2][2] = -r[2][2];
  }
  const trace = r[0][0] + r[1][1] + r[2][2];
  let w, x, y, z;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2;
    w = 0.25 * s;
    x = (r[2][1] - r[1][2]) / s;
    y = (r[0][2] - r[2][0]) / s;
    z = (r[1][0] - r[0][1]) / s;
  } else if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = Math.sqrt(1.0 + r[0][0] - r[1][1] - r[2][2]) * 2;
    w = (r[2][1] - r[1][2]) / s;
    x = 0.25 * s;
    y = (r[0][1] + r[1][0]) / s;
    z = (r[0][2] + r[2][0]) / s;
  } else if (r[1][1] > r[2][2]) {
    const s = Math.sqrt(1.0 + r[1][1] - r[0][0] - r[2][2]) * 2;
    w = (r[0][2] - r[2][0]) / s;
    x = (r[0][1] + r[1][0]) / s;
    y = 0.25 * s;
    z = (r[1][2] + r[2][1]) / s;
  } else {
    const s = Math.sqrt(1.0 + r[2][2] - r[0][0] - r[1][1]) * 2;
    w = (r[1][0] - r[0][1]) / s;
    x = (r[0][2] + r[2][0]) / s;
    y = (r[1][2] + r[2][1]) / s;
    z = 0.25 * s;
  }
  const len = Math.hypot(w, x, y, z) || 1;
  return [w / len, x / len, y / len, z / len];
}

const logit = (p) => Math.log(p / (1 - p));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- main
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('// Usage:')[1].split('const fs')[0].replace(/^/gm, ''));
    return;
  }

  const lib = require(path.join(INK, 'index.js')).load();
  const scenes = lib.SCENES;

  if (args.list) {
    scenes.forEach((s, i) => console.log(i, s.id, '-', s.name, '|', s.blurb || ''));
    return;
  }

  const t0 = Date.now();
  const K = lib.KIT;
  let scene, world;
  if (args.example) {
    // An examples/*.js factory, shaped ({makeBuilder, makeSculpt, KIT}) => descriptor.
    // These are where ink-studio actually authors VFX (weather, wind, cloth);
    // the seven SCENES dioramas barely use it.
    const file = path.resolve(INK, 'examples', args.example);
    const descriptor = require(file)({ makeBuilder: lib.makeBuilder, makeSculpt: lib.makeSculpt, KIT: K });
    scene = { id: descriptor.id || path.basename(args.example, '.js'), name: descriptor.name || '', seed: descriptor.seed };
    world = descriptor.build(descriptor.seed);
  } else {
    const index = /^\d+$/.test(args.scene) ? Number(args.scene) : scenes.findIndex((s) => s.id === args.scene);
    scene = scenes[index];
    if (!scene) throw new Error('no such scene: ' + args.scene);
    world = scene.build({ K, KIT: K });
  }
  const tBuild = Date.now() - t0;

  const D = world.data;
  const n = world.count;
  if (!D || D.length !== n * 16) throw new Error('unexpected splat buffer: ' + (D && D.length) + ' for count ' + n);

  const outFile = args.out || path.join(__dirname, 'out', scene.id + '.ply');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // header: 14 float properties = 56 bytes per vertex
  const props = [
    'x', 'y', 'z',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity',
    'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
  ];
  // --vfx: ink-studio's procedural per-splat animation lives in lanes 12-15. A
  // 14-float PLY has nowhere to put it, but ink-studio is flat-coloured, so its
  // 45 higher-order SH slots are all empty and five of them are free. f_rest is
  // CHANNEL-interleaved (0..14 = R, 15..29 = G, 30..44 = B), so these five
  // names decode to sh_coeffs[3..7] -- exactly the slots the patched GDGS
  // raster shader reads in ink_anim(). Any f_rest left out defaults to 0 on
  // import, so the other 40 stay cheap.
  const VFX_PROPS = ['f_rest_0', 'f_rest_15', 'f_rest_30', 'f_rest_1', 'f_rest_16'];
  if (args.vfx) props.push(...VFX_PROPS);
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    'comment generated by inkstudio2ply from ink-studio scene "' + scene.id + '"\n' +
    'element vertex ' + n + '\n' +
    props.map((p) => 'property float ' + p + '\n').join('') +
    'end_header\n';

  const body = Buffer.alloc(n * props.length * 4);
  let o = 0;

  const centroid = [0, 0, 0];
  const aabbMin = [Infinity, Infinity, Infinity];
  const aabbMax = [-Infinity, -Infinity, -Infinity];

  let sigmaMin = Infinity, sigmaMax = -Infinity, ratioMin = Infinity;
  let alphaMin = Infinity, alphaMax = -Infinity;
  let flattened = 0;
  const palUsed = new Set();

  for (let i = 0; i < n; i++) {
    const b = i * 16;
    const x = D[b], y = D[b + 1], z = D[b + 2];
    const density = D[b + 3];
    const c00 = D[b + 4], c01 = D[b + 5], c02 = D[b + 6];
    const packed = Math.round(D[b + 7]);
    const c11 = D[b + 8], c12 = D[b + 9], c22 = D[b + 10];

    centroid[0] += x; centroid[1] += y; centroid[2] += z;
    if (x < aabbMin[0]) aabbMin[0] = x;
    if (y < aabbMin[1]) aabbMin[1] = y;
    if (z < aabbMin[2]) aabbMin[2] = z;
    if (x > aabbMax[0]) aabbMax[0] = x;
    if (y > aabbMax[1]) aabbMax[1] = y;
    if (z > aabbMax[2]) aabbMax[2] = z;

    const eig = eigenSymmetric(c00, c01, c02, c11, c12, c22);
    const sigma = [
      Math.sqrt(Math.max(eig.values[0], 0)),
      Math.sqrt(Math.max(eig.values[1], 0)),
      Math.sqrt(Math.max(eig.values[2], 0)),
    ];
    if (sigma[2] > 0) ratioMin = Math.min(ratioMin, sigma[0] / sigma[2]);
    if (args.minSigma > 0 && sigma[0] < args.minSigma) {
      sigma[0] = args.minSigma;
      flattened++;
    }
    if (sigma[0] < sigmaMin) sigmaMin = sigma[0];
    if (sigma[2] > sigmaMax) sigmaMax = sigma[2];

    // ink-studio density is coverage-like: >= 1 means opaque. GDGS wants alpha 0..1.
    const alpha = clamp(Math.min(1, Math.max(0, density)), 1e-4, 0.999);
    const opacityValue = logit(args.alpha > 0 ? Math.min(alpha, args.alpha) : alpha);
    if (alpha < alphaMin) alphaMin = alpha;
    if (alpha > alphaMax) alphaMax = alpha;

    const q = matrixToQuaternion(eig.vectors);

    // packedRGB = r | g<<8 | b<<16, sRGB bytes
    const r = (packed & 255) / 255;
    const g = ((packed >> 8) & 255) / 255;
    const bl = ((packed >> 16) & 255) / 255;
    palUsed.add(packed);

    const f = (c) => (c - 0.5) / SH_C0;

    body.writeFloatLE(x, o); o += 4;
    body.writeFloatLE(y, o); o += 4;
    body.writeFloatLE(z, o); o += 4;
    body.writeFloatLE(f(r), o); o += 4;
    body.writeFloatLE(f(g), o); o += 4;
    body.writeFloatLE(f(bl), o); o += 4;
    body.writeFloatLE(opacityValue, o); o += 4;
    body.writeFloatLE(Math.log(Math.max(sigma[0], 1e-9)), o); o += 4;
    body.writeFloatLE(Math.log(Math.max(sigma[1], 1e-9)), o); o += 4;
    body.writeFloatLE(Math.log(Math.max(sigma[2], 1e-9)), o); o += 4;
    body.writeFloatLE(q[0], o); o += 4;
    body.writeFloatLE(q[1], o); o += 4;
    body.writeFloatLE(q[2], o); o += 4;
    body.writeFloatLE(q[3], o); o += 4;

    if (args.vfx) {
      const kind = Math.round(D[b + 11]) % 16;
      // Kinds 12/13 hold bone indices in lanes 12-14, not animation. Those go
      // through the per-bone node path; writing them here would make the shader
      // read a bone index as a phase.
      const skeletal = kind === 12 || kind === 13;
      body.writeFloatLE(kind, o); o += 4;                        // -> c[3]
      body.writeFloatLE(skeletal ? 0 : D[b + 12], o); o += 4;    // -> c[4] phase
      body.writeFloatLE(skeletal ? 0 : D[b + 13], o); o += 4;    // -> c[5] speed
      body.writeFloatLE(skeletal ? 0 : D[b + 14], o); o += 4;    // -> c[6] range
      body.writeFloatLE(skeletal ? 0 : D[b + 15], o); o += 4;    // -> c[7] extra
    }
  }

  for (let k = 0; k < 3; k++) centroid[k] /= n;

  fs.writeFileSync(outFile, Buffer.concat([Buffer.from(header, 'ascii'), body]));

  const sidecar = {
    source: 'ink-studio',
    scene: { id: scene.id, name: scene.name, blurb: scene.blurb, seed: world.seed },
    count: n,
    // GDGS re-centres positions on the mean at import; place GaussianSplatNode here to restore world coords.
    centroid,
    aabb: { min: aabbMin, max: aabbMax },
    ink: {
      radius: world.radius,
      bg: world.bg,
      palName: world.palName,
      palette: Array.from(world.pal || []),
      dither: world.dither,
      fog: world.fog,
      outline: world.outline,
      // 作者相机：Godot 侧靠它构图，比拿 AABB 硬框可靠（AABB 里有 -99 哨兵）。
      cam: world.cam || null,
    },
    plyBytes: Buffer.byteLength(header, 'ascii') + body.length,
    sigma: { min: sigmaMin, max: sigmaMax, worstAspect: ratioMin },
    alpha: { min: alphaMin, max: alphaMax },
    flattened,
    paletteUsed: palUsed.size,
  };
  const sideFile = outFile.replace(/\.ply$/i, '') + '.ply.json';
  fs.writeFileSync(sideFile, JSON.stringify(sidecar, null, 2));

  const mb = (x) => (x / 1048576).toFixed(2) + ' MB';
  console.log('scene      :', scene.id, '/', scene.name);
  console.log('splats     :', n);
  console.log('build time :', tBuild, 'ms');
  console.log('sigma      :', sigmaMin.toExponential(3), '..', sigmaMax.toExponential(3),
    '| worst aspect', ratioMin.toFixed(3));
  console.log('alpha      :', alphaMin, '..', alphaMax);
  console.log('flattened  :', flattened);
  console.log('colours    :', palUsed.size, 'distinct');
  console.log('centroid   :', centroid.map((v) => v.toFixed(3)).join(', '));
  console.log('wrote      :', outFile, mb(sidecar.plyBytes));
  console.log('sidecar    :', sideFile);
}

main();
