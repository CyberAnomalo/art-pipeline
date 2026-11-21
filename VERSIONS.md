# 版本与依赖固定

本仓库不包含第三方源码，但整条管线**依赖**它们。重新生成资产时必须是这些版本，
否则 splat 布局、调色板表编码、splat 解码行为都可能悄悄变掉。

## 第三方源码（未入库，需各自克隆到本仓库的兄弟位置）

```
GameDev/
  art-pipeline/                     <- 本仓库
  shapeshift-labs-ink-studio/       <- 美术烘焙器
  godot-gaussian-splatting/         <- GDGS 上游
  ink2godot/                        <- Godot 工程（另一个仓库）
```

| 目录 | 来源 | 固定 commit | 说明 |
|---|---|---|---|
| `../shapeshift-labs-ink-studio/` | `github.com/siliconjungle/shapeshift-labs-ink-studio`（私有） | `1350b4f` | 美术烘焙器。package.json 是 `private: true` 且无 semver，**只能按 commit 固定** |
| `../godot-gaussian-splatting/` | `github.com/ReconWorldLab/godot-gaussian-splatting` | `c22024b` | GDGS addon 上游。`../ink2godot/addons/gdgs/` 是它的**已打补丁副本**，改动见 `../ink2godot/VENDOR-PATCHES.md` |

克隆与固定：

```powershell
git clone https://github.com/siliconjungle/shapeshift-labs-ink-studio.git
git -C shapeshift-labs-ink-studio checkout 1350b4f

git clone https://github.com/ReconWorldLab/godot-gaussian-splatting.git
git -C godot-gaussian-splatting checkout c22024b
```

## 工具链

| 工具 | 本机验证版本 | 要求 |
|---|---|---|
| Node.js | v24.21.0 | >= 18（ink-studio 的下限） |
| Godot | 4.7.2.stable.mono.official.ed1daf0bf | 4.3+，需 **Forward+** 渲染器 |
| git | 2.49.0.windows.1 | — |

Godot 用 mono（.NET）版，但本工程**一行 C# 都没有** —— GDScript + GDScript 即可，
选 mono 只是因为装的是这个。标准版同样能跑。

## 关键锚点（换版本时必须重新核对）

这些是从源码里实测出来的契约，任何一侧升级都要重新验证：

1. **splat 行布局**：16 个 float（64 字节）—— `src/builder.js`
2. **调色板表编码**：`world.pal` 是 `0xRRGGBB`（红在高位），而逐 splat 的 packedRGB lane
   是 `r | g<<8 | b<<16`（红在低位）—— **两者相反**。搞反会让冷色变暖、边缘出一圈假描边。
3. **默认垂直 fov**：38°（`src/camera-lens.js:3`），且 `cam.fov` 存弧度。
4. **GDGS 运行时布局**：60 个 float / 240 字节，协方差顺序 c00,c01,c02,c11,c12,c22
5. **GDGS PLY 解码器**：只接受 binary_little_endian，拒绝任何 list 属性
6. **GDGS 默认朝向修正**：identity basis 会被乘上一个绕 Z 转 180° 的矩阵，
   所以必须把节点摆到质心（非 identity 平移）来同时恢复坐标和抵消翻转

## 已知的环境注意点

- 目录名是 `shapeshift-labs-ink-studio`（不是 `ink-studio`），导出器用
  `path.resolve(__dirname, '..', 'shapeshift-labs-ink-studio')` 定位
- `node --test tests/*.test.js` 在 Windows 上约 96% 通过（3012 个测试，6 个失败：
  3 个 POSIX 路径假设 + 3 个 authoring 逻辑 bug）。作者只在 macOS 上跑过，
  仓库里没有 CI 配置
