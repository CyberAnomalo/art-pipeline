# art-pipeline

把 [ink-studio](../shapeshift-labs-ink-studio) 的像素风高斯 splat 场景，烘焙成
[GDGS](../godot-gaussian-splatting) 能直接吃的 Gaussian `.ply`。

配套的 Godot 工程在 [`../ink2godot`](../ink2godot)，它消费这里产出的资产。

## 导出器

| 脚本 | 用途 |
|---|---|
| `inkstudio2ply.js` | 单场景导出。`--scene <id>` 用内置七个 diorama，`--example <file>.js` 用任意示例工厂 |
| `inkstudio2ply-boned.js` | 统一导出器。有骨骼就拆成逐骨骼 PLY + `anim.json`，没有就把全部 splat 写进带 VFX 属性的 `fixed.ply` |

```powershell
# 内置 diorama
node inkstudio2ply.js --scene watcher --out ../ink2godot/assets/dioramas/watcher.ply --stats

# 任意示例，带程序化 VFX（19 浮点/顶点）
node inkstudio2ply.js --example motion-cadence.js --out ../ink2godot/assets/vfx/motion-cadence.ply --vfx --stats

# 角色动画（逐骨骼 PLY + anim.json）
node inkstudio2ply-boned.js --example pose-blocking.js --out ../ink2godot/assets/courier --fps 24 --seconds 2
```

## 验证

```powershell
# VFX 数学等价：JS 版 ink_anim 逐行对照 ink-studio 的 SplatFrames.sample()
# 六个场景 ~46 万 splat，位置/不透明度/协方差误差必须全是 0.000e+0
node test-vfx-math.js

# 探针
node probe-dioramas.js   # 七个场景的相机/半径/调色板/splat 数
node probe-vfx.js        # 各示例的程序化动画种类分布
node probe-anim.js       # 各示例的骨骼/kind 组成
node probe-pal.js        # 调色板字节序验证

# 总览表 + 调色板断言（需要 ../ink2godot 先抓图）
./overview-sheet.ps1
```

## 文档

| 文件 | 内容 |
|---|---|
| `SPEC-inkstudio-to-godot-ply.md` | **完整技术规格**：PLY 字节布局、调色板编码、骨骼矩阵约定、动画 kinds、VFX shader 注入、像素后处理、七个场景全量结果 |
| `VERSIONS.md` | 外部依赖的固定 commit、工具链版本、换版本时必须重新核对的关键契约 |

## 依赖

需要把 `ink-studio` 克隆到本目录的兄弟位置，并固定到 `VERSIONS.md` 记录的 commit：

```
GameDev/
  art-pipeline/                     <- 本仓库
  shapeshift-labs-ink-studio/       <- 美术烘焙器（私有，按 commit 固定）
  ink2godot/                        <- Godot 工程
```

导出器用 `path.resolve(__dirname, '..', 'shapeshift-labs-ink-studio')` 定位它。
