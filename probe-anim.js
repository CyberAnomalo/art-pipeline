/* 实测例子场景的动画构成：kind 直方图 + 骨骼/部件绑定 */
const INK = require('./find-ink.js');
const path = require('path');
const lib = require(INK + '/index.js').load();
const KIT = lib.KIT;
const factory = { makeBuilder: lib.makeBuilder, makeSculpt: lib.makeSculpt, KIT };

function hist(world, label) {
  const d = world.data, n = world.count;
  const kinds = new Map();
  let laneNonZero = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const k = Math.round(d[o + 11]) % 16;
    kinds.set(k, (kinds.get(k) || 0) + 1);
    for (let l = 0; l < 4; l++) if (d[o + 12 + l]) laneNonZero[l]++;
  }
  const a = world.anim;
  const rig = a && a.rig;
  let parts = 0, boneArr = 0;
  if (rig && rig.bid) parts = new Set(Array.from(rig.bid).filter(Boolean)).size;
  if (a && a.bones) boneArr = a.bones.length / 12;
  const out = {
    label,
    splats: n,
    kinds: Object.fromEntries([...kinds.entries()].sort((x, y) => y[1] - x[1])),
    'lane12/13/14/15 非零数': laneNonZero.map(c => `${(100 * c / n).toFixed(0)}%`),
    'anim keys': a ? Object.keys(a).join(',') : 'none',
    'rig parts': parts,
    'bones(矩阵数)': boneArr,
    hasRest: !!world.rest,
    'moving数': world.moving ? world.moving.length : 0
  };
  console.log(JSON.stringify(out, null, 1));
  return out;
}

const which = process.argv.slice(2);
const files = which.length ? which : [
  'animation-timeline.js', 'pose-blocking.js', 'clip-sequence.js',
  'puppet.js', 'motion-review.js', 'motion-fx.js', 'authored-contacts.js'
];
for (const f of files) {
  try {
    const desc = require(path.join(INK, 'examples', f))(factory);
    const w = desc.build(desc.seed ?? 0);
    hist(w, f + '  [' + (desc.name || desc.id) + ']');
  } catch (e) {
    console.log(f, '-> 失败:', String(e.message).slice(0, 160));
  }
}
