/* 普查：哪些 ink-studio 场景在用非骨骼的程序化动画（kind 1,2,3,5,6,7,8,9,10,11,14,15）*/
const INK = 'D:/GithubSoftware/GameDev/shapeshift-labs-ink-studio';
const fs = require('fs');
const path = require('path');
const lib = require(INK + '/index.js').load();
const KIT = lib.KIT;
const factory = { makeBuilder: lib.makeBuilder, makeSculpt: lib.makeSculpt, KIT };

const VFX = new Set([1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 14, 15]);
const names = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(INK + '/examples').filter(f => f.endsWith('.js')).sort();

const rows = [];
for (const f of names) {
  let desc;
  try { desc = require(path.join(INK, 'examples', f))(factory); }
  catch (e) { continue; }
  if (!desc || !desc.build) continue;
  let w;
  try { w = desc.build(desc.seed ?? 0); } catch (e) { continue; }
  if (!w || !w.data) continue;
  const kinds = {};
  for (let i = 0; i < w.count; i++) {
    const k = Math.round(w.data[i * 16 + 11]) % 16;
    kinds[k] = (kinds[k] || 0) + 1;
  }
  let vfx = 0;
  for (const k of Object.keys(kinds)) if (VFX.has(+k)) vfx += kinds[k];
  if (vfx > 0) rows.push({ f, n: w.count, vfx, pct: (100 * vfx / w.count).toFixed(0), kinds });
}
rows.sort((a, b) => b.vfx - a.vfx);
for (const r of rows.slice(0, 30)) {
  console.log(`${String(r.vfx).padStart(6)} ${r.pct.padStart(3)}%  ${String(r.n).padStart(6)}n  ${r.f.padEnd(34)} ${JSON.stringify(r.kinds)}`);
}
console.log('\n共', rows.length, '个场景有程序化动画');
