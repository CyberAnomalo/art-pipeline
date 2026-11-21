/* 诊断：对比 an.update(0,0) 与 CLI 权威路径 diarama-pose.pose() 的骨骼矩阵 */
const INK = require('./find-ink.js');
const path = require('path');
const lib = require(INK + '/index.js').load();
const KIT = lib.KIT;
const factory = { makeBuilder: lib.makeBuilder, makeSculpt: lib.makeSculpt, KIT };
const { pose } = require(INK + '/cli/diarama-pose.js');

const ex = process.argv[2] || 'pose-blocking.js';
const desc = require(path.join(INK, 'examples', ex))(factory);

// --- 路径 A：我的做法
const A = desc.build(desc.seed ?? 0);
console.log('stateful:', A.anim.stateful, '| bones:', A.anim.bones.length / 12, '| 初始 bones 是否单位阵:',
  Array.from(A.anim.bones).every((v, i) => Math.abs(v - (i % 12 === 0 || i % 12 === 4 || i % 12 === 8 ? 1 : 0)) < 1e-9));
A.anim.update(0, 0);
const bonesA = Float32Array.from(A.anim.bones);

// --- 路径 B：CLI 权威路径
const B = desc.build(desc.seed ?? 0);
pose(B, 0, { kit: lib });
const bonesB = Float32Array.from(B.anim.bones);

// --- 路径 C：CLI 路径但 dt=1/60
const C = desc.build(desc.seed ?? 0);
C.anim.update(1 / 60, 0);
const bonesC = Float32Array.from(C.anim.bones);

function diff(x, y) {
  let mx = 0;
  for (let i = 0; i < x.length; i++) mx = Math.max(mx, Math.abs(x[i] - y[i]));
  return mx;
}
console.log('A(update 0,0) vs B(CLI pose) 最大差:', diff(bonesA, bonesB).toFixed(4));
console.log('C(update 1/60,0) vs B(CLI pose) 最大差:', diff(bonesC, bonesB).toFixed(4));

function bbox(world, data) {
  const d = data || world.data;
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < world.count; i++) {
    const o = i * 16;
    for (let a = 0; a < 3; a++) { const v = d[o + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  }
  return { lo: lo.map(v => +v.toFixed(2)), hi: hi.map(v => +v.toFixed(2)) };
}
console.log('\nA(update 0,0)   包围盒:', JSON.stringify(bbox(A, KIT.bones.posed(A))));
console.log('B(CLI pose t=0) 包围盒:', JSON.stringify(bbox(B, KIT.bones.posed(B))));
console.log('B 的 data 已是 posed（CLI 会替换）:', B.data !== B.rest);

// 骨骼矩阵本身打印前两根
const row = (b, i) => Array.from(b.slice(i * 12, i * 12 + 12)).map(v => +v.toFixed(2));
console.log('\n骨0  A:', JSON.stringify(row(bonesA, 0)));
console.log('骨0  B:', JSON.stringify(row(bonesB, 0)));
