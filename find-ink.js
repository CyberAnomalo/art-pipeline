// 定位 ink-studio 仓库。
//
// 优先看环境变量 INK_STUDIO_DIR，其次找兄弟目录。找不到就抛出可直接照做的提示，
// 而不是一个 ENOENT 栈。
const fs = require('fs'),
  path = require('path');

const here = __dirname,
  parent = path.resolve(here, '..'),
  grandparent = path.resolve(here, '..', '..');

const candidates = [
  process.env.INK_STUDIO_DIR,
  path.join(parent, 'shapeshift-labs-ink-studio'),
  path.join(parent, 'ink-studio'),
  path.join(grandparent, 'shapeshift-labs-ink-studio'),
  path.join(grandparent, 'ink-studio')
].filter(Boolean);

const found = candidates.find(
  c => fs.existsSync(path.join(c, 'index.js')) && fs.existsSync(path.join(c, 'src', 'splat-frames.js'))
);

if (!found) {
  throw new Error(
    [
      '找不到 ink-studio 仓库。三选一：',
      '  1. 设置环境变量 INK_STUDIO_DIR=<ink-studio 仓库根目录>',
      '  2. 克隆到 ' + path.join(parent, 'shapeshift-labs-ink-studio'),
      '  3. 只是想看画面/做关卡：不需要 ink-studio，直接打开 ink2godot 工程（见 ONBOARDING.md）'
    ].join('\n')
  );
}

module.exports = found;
