const path=require('path');
const INK = require('./find-ink.js');
const lib=require(path.join(INK,'index.js')).load();
const sc=lib.SCENES.find(s=>s.id==='watcher');
const W=sc.build(sc.seed);
const pal=Array.from(W.pal||[]);
const hex=v=>{const i=Number(v);return '0x'+i.toString(16).padStart(6,'0');};
const A=v=>[(v&255),((v>>8)&255),((v>>16)&255)];
const B=v=>[((v>>16)&255),((v>>8)&255),(v&255)];
console.log('world.pal 前 4 项 (原样 hex):', pal.slice(0,4).map(hex).join(' '));
console.log(' 解A(r低字节):', pal.slice(0,4).map(v=>A(Number(v)).join(',')).join(' | '));
console.log(' 解B(r高字节):', pal.slice(0,4).map(v=>B(Number(v)).join(',')).join(' | '));
// 取前 6 个 splat 的 packedRGB lane (lane 7 = 第二个 vec4 的 .w)
const D=W.data;
console.log('\nsplat packedRGB lane 前 6 个:');
const seen=new Set();
for(let i=0;i<40&&seen.size<6;i++){
  const v=Math.round(D[i*16+7]); if(seen.has(v))continue; seen.add(v);
  console.log('  lane',hex(v),' 解A:',A(v).join(','),'  解B:',B(v).join(','));
}
// 判断：lane 解A 是否能对上 pal 的某一项
const laneVals=[];
for(let i=0;i<W.count;i++) laneVals.push(Math.round(D[i*16+7]));
const palSetA=new Set(pal.map(Number));
const palSetB=new Set(pal.map(v=>{const [r,g,b]=B(Number(v));return r|(g<<8)|(b<<16);}));
let hitA=0,hitB=0;
for(const v of laneVals){ if(palSetA.has(v))hitA++; if(palSetB.has(v))hitB++; }
console.log('\nlane 值直接命中 pal 原样 :',hitA,'/',laneVals.length);
console.log('lane 值命中 pal(B转A序) :',hitB,'/',laneVals.length);
