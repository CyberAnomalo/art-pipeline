/* 验证：anim.update(dt,t) 是否真的推进骨骼 + 统计每根骨承载的 splat 数 */
const INK = 'D:/GithubSoftware/GameDev/shapeshift-labs-ink-studio';
const path = require('path');
const lib = require(INK + '/index.js').load();
const KIT = lib.KIT;
const factory = { makeBuilder: lib.makeBuilder, makeSculpt: lib.makeSculpt, KIT };

const file = process.argv[2] || 'pose-blocking.js';
const desc = require(path.join(INK, 'examples', file))(factory);
const W = desc.build(desc.seed ?? 0);
const an = W.anim;
console.log('场景:', file, '| splats:', W.count, '| bones:', an.bones.length / 12,
  '| boned 数:', an.boned ? an.boned.length : 0);

// 每根骨承载多少 splat（用主骨 lane12）
const per = new Map();
let blended = 0;
for (let i = 0; i < W.count; i++) {
  const o = i * 16;
  if (Math.round(W.data[o + 11]) % 16 !== 12 && Math.round(W.data[o + 11]) % 16 !== 13) continue;
  const b = Math.round(W.data[o + 12]);
  per.set(b, (per.get(b) || 0) + 1);
  if (W.data[o + 14] > 0) blended++;
}
console.log('每骨 splat 数:', JSON.stringify([...per.entries()].sort((a, b) => a[0] - b[0])));
console.log('带第二骨权重的 splat:', blended);

// 时间推进
const times = [0, 0.4, 0.8, 1.2];
const snap = [];
let dtAcc = 0;
for (const t of times) {
  an.update(Math.max(0, t - dtAcc), t);
  dtAcc = t;
  snap.push(Float32Array.from(an.bones));
  // posed 后的包围盒
  const d = KIT.bones.posed(W);
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < W.count; i++) {
    const o = i * 16;
    for (let a = 0; a < 3; a++) { const v = d[o + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  }
  console.log(`t=${t.toFixed(2)}  posed 包围盒 Y: ${lo[1].toFixed(3)} .. ${hi[1].toFixed(3)}  X: ${lo[0].toFixed(2)}..${hi[0].toFixed(2)}`);
}

// 每根骨相对 t=0 变了多少
const n = an.bones.length / 12;
console.log('\n每骨相对 t=0 的最大位移:');
for (let b = 0; b < n; b++) {
  let mx = 0, rot = 0;
  for (const s of snap.slice(1)) {
    for (let a = 0; a < 3; a++) {
      mx = Math.max(mx, Math.abs(s[b * 12 + 9 + a] - snap[0][b * 12 + 9 + a]));
      rot = Math.max(rot, Math.abs(s[b * 12 + a] - snap[0][b * 12 + a]));
    }
  }
  if (mx > 1e-6 || rot > 1e-6) console.log(`  骨 ${b}: 位移 ${mx.toFixed(3)}  旋转 ${rot.toFixed(3)}`);
}
