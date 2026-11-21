// 打印七个 diorama 的 sidecar 概要：作者相机、半径、调色板、splat 数
const fs = require('fs');
const path = require('path');
const ids = ['watcher', 'burn', 'idol', 'bench', 'stuff', 'cabinet', 'rehearsal'];
const rows = [];
for (const id of ids) {
  const f = path.join('out', 'dioramas', id + '.ply.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = m.ink && m.ink.cam;
  const cam = c
    ? 'target [' + c.target.map((v) => v.toFixed(1)).join(',') + '] dist ' + c.dist +
      ' pitch ' + Number(c.pitch).toFixed(2) + ' yaw ' + Number(c.yaw).toFixed(2)
    : '(无 cam)';
  console.log(
    id.padEnd(10),
    String(m.count).padStart(7) + ' splats',
    String(m.ink.palette.length).padStart(3) + ' 色',
    'radius ' + m.ink.radius,
    '|',
    cam
  );
  rows.push({ id, count: m.count, radius: m.ink.radius, cam: c || null });
}
const total = rows.reduce((s, r) => s + r.count, 0);
console.log('\n合计', total, 'splats');
