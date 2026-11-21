# ink-studio → Godot Gaussian PLY：已验证的字节级规格

所有结论均为**实测**（Node v24.21.0 / Godot 4.7.2-stable.mono / GDGS 3.3.0 / RTX 4080）。
不是推测，每条都带证据位置。

---

## 1. ink-studio 的 splat 行格式

`world.data` 是 `Float32Array`，长度 `world.count * 16`。见 `src/builder.js:1081-1082`。

```
[0] x          [1] y          [2] z          [3] density
[4] c00        [5] c01        [6] c02        [7] packedRGB
[8] c11        [9] c12        [10] c22       [11] kind+flags
[12] phase     [13] speed     [14] range     [15] extra
```
证据：`src/builder.js:5`（注释）+ `src/builder.js:443-456`（写入循环）。

### density（lane0.w）
- 语义是**覆盖度**，不是 0..1 的 alpha。`>= 1` 视为完全不透明（`src/area-lights.js:249`）。
- demo 场景实测：**恒定 3**（p01 = p50 = p99 = max = 3）。
- 其他来源会写小于 1 的值，如 `src/paint-corrections.js:146` 写 `0.99 * coverage`。

### packedRGB（lane1.w）
```js
data[o + 7] = (col[0] | 0) + (col[1] | 0) * 256 + (col[2] | 0) * 65536;  // builder.js:453
```
- **直接颜色**，不是调色板索引：R = byte0，G = byte1，B = byte2，各 0..255。
- 解码（官方写法，`src/shot-lighting.js:134`）：
  ```js
  rgb[c] = (Math.round(packed) >> (c * 8) & 255) / 255
  ```
- 调色板索引另存在 `cidx`（`builder.js:456`），只用于后处理 resolve。`world.pal` 是**打包整数数组**（不是 hex 字符串）。

### 协方差（c00..c22）
- **绝对方差**，世界单位，不是归一化的。
- `iso(x,y,z,s,…)` → `v = s*s`，对角全等（`src/builder.js:500-503`）。
- `axial(x,y,z,ax,sa,sp,…)` → `p = sp*sp`, `d = sa*sa - p`，特征值 `{sa², sp², sp²}`（`src/builder.js:505-524`）。
  → **`sa = 0` 会产生一个特征值为 0 的完全扁平片**，但 demo 场景没有用到。

### 实测统计（Die Watcher，112,600 splat）
```
最小特征值 : 4.410e-4        最大特征值 : 4.761e-3
sigma 范围 : 3.220e-2 .. 6.900e-2
最差扁平度 : sigma_min / sigma_max = 1.000   ← 全部各向同性
完全扁平片 : 0
负特征值   : 0
颜色种类   : 10
```
**结论：ink-studio 烘出的 splat 是良态椭球，不是退化片。** 通用 3DGS 渲染器的奇异性风险不存在。

---

## 2. GDGS 的 PLY 导入契约

行宽 **14 个 float32 = 56 字节/点**。不需要 45 个高阶 SH 系数——缺省时导入器填 0
（`standard_ply_decoder.gd` 用 `_read_property(..., "f_rest_%d", 0.0)`）。

| PLY 属性 | 类型 | 编码 | 解码位置 |
|---|---|---|---|
| `x y z` | float | 世界坐标直写 | `standard_ply_decoder.gd:55-59` |
| `scale_0/1/2` | float | **log(σ)**，导入时 `exp()` | `standard_ply_decoder.gd:64-68` |
| `opacity` | float | **logit(α)**，导入时 `sigmoid()` | `standard_ply_decoder.gd:78` |
| `rot_0..3` | float | 四元数 **顺序 (w,x,y,z)**，`rot_0`=w | `standard_ply_decoder.gd:70-75` |
| `f_dc_0..2` | float | 着色器算 `0.5 + f_dc × 0.28209479177387814` | `gaussian_raster.gdshader:364` |

### 颜色空间
`f_dc` 里的颜色是 **sRGB**，不是 linear。着色器自己做 sRGB→linear：

> `gaussian_raster.gdshader:99` — "sRGB -> linear (exact EOTF). **SH colours are trained in sRGB space**"

所以直接写 `byte/255` 即可，不会二次转换。

### 协方差重建（必须精确匹配）
`gaussian_resource_builder.gd:96-99`：
```gdscript
var scale_mat := Basis.from_scale(scale_linear)
var rot_mat   := Basis(rotation).transposed()
var cov_3d    := (scale_mat * rot_mat).transposed() * (scale_mat * rot_mat)
```
展开即 `cov = R · diag(σᵢ²) · Rᵀ`，其中 `R = Basis(quaternion)`，**列向量**就是三个轴。

反推：对 cov 做特征分解 → `σᵢ = sqrt(λᵢ)`，`R` 的列 = 特征向量 → 由 R 求四元数。
导数非正交时翻转第三轴保证 `det(R)=+1`。

### 最小尺度下限
`gaussian_resource_builder.gd:88-92` 把每个 scale 夹到 `maxf(σ, 1e-6)`。所以写入 log(σ) 时 σ 不能低于 1e-6。

### 导入时的两件事（很重要）
1. **位置被减掉均值**：`gaussian_resource_builder.gd:73-77` 计算 `center`，`gaussian_resource_builder.gd:94` 写 `pos = positions[i] - center`。
   **没有开关**。所以 `GaussianSplatNode` 必须放在 `centroid` 上才能还原世界坐标。导出器把均值写进 sidecar.json。
2. **朝向被默认转 -180° 绕 Z**：`gaussian_splat_node.gd:58-59, 159-162`，只有当节点 basis ≈ 单位阵时才转。
   因为子节点 `_ready` 先于父节点执行，在父脚本 `_ready` 里重设 `transform = Transform3D(Basis.IDENTITY, centroid)` 即可覆盖掉。

### PLY 头部的硬性要求
`binary_ply_reader.gd`：
- 只接受 `format binary_little_endian 1.0`
- **不支持 list property**（`binary_ply_reader.gd:96`）
- 支持类型：`char/uchar/short/ushort/int/uint/float/double`，以及别名 `int8/uint8/int16/uint16/int32/uint32/float32/float64`
- `stride` = 各 property 大小之和

---

## 3. Godot 侧的两个坑（已踩过）

### 坑 1：`.tscn` 里不能写 `type="GaussianSplatNode"`
会报 `ERROR: Cannot get class 'GaussianSplatNode'` → `Node Splat ... cannot be created`。
`_instantiate_internal` 走的是原生 `ClassDB`，不认识脚本 `class_name`。

必须写基类 + 显式脚本：
```
[ext_resource type="Script" path="res://addons/gdgs/runtime/nodes/gaussian_splat_node.gd" id="4_node"]

[node name="Splat" type="VisualInstance3D" parent="."]
script = ExtResource("4_node")
gaussian = ExtResource("1_gauss")
```

### 坑 2：首次 `--import` 时类缓存尚未就绪
第一次跑会报同一个错，跑第二遍就干净了。这是新项目首次导入的正常现象。

### 后端选择
`gdgs/rendering/backend` = `Auto`（默认）在 Forward+ + 有 compute 的机器上会选 **Compute**
（逐 tile 精确排序，无相机滞后）。实测输出：

```
Vulkan 1.4.341 - Forward+ - Using Device #0: NVIDIA - NVIDIA GeForce RTX 4080
[gdgs] rendering backend: Compute
[gdgs] import complete, 112600 gaussians ready for rendering
[ink2godot] capture 0 -> .../shot.png (1280x720)
```

---

## 4. 实测验证结果

| 环节 | 结果 |
|---|---|
| ink-studio 烘焙 112,600 splat | 1,245 ms |
| PLY 导出 | 6.01 MB（56 B/点） |
| GDGS 导入 | `import complete, 112600 gaussians ready for rendering` |
| Godot 渲染 1280×720 | 成功，Compute 后端 |

---

## 5. 还没做的（下一步）

1. **像素风后处理**：palette resolve + ordered dither + outline
   现在 Godot 出来的是平滑渐变的 3DGS 混合；ink-studio 是硬边像素块。
   挂载点：`WorldEnvironment.compositor` 的 `CompositorEffect`（Compute 后端本来就走这条路）。
   参考实现：`patch-gg/pixel-splats`、godotGS 的 `dither_noise()`、Godot 的 Pixel Dither shader。
2. **硬边裁剪**：GDGS 的 `alpha_cutoff` 默认 `0.00392`（≈1/255），ink-studio 是硬 discard
   （`shaders.mjs:480` `if(power>0.0||power < -4.5)discard;`）。需要调高到接近 0.5。
3. **多场景/分块**：每个 chunk 一个 `GaussianSplatNode` + 一个 PLY，用 `visibility_range` 分级。

---

# 第二部分：动画

## 6. ink-studio 的动画模型

`src/splat-frames.js` 是权威实现。lane11 低 4 位是 **kind**：

| kind | 行为 | 用的 lane |
|---|---|---|
| 0 | 静态 | — |
| 1 / 7 | 透明度脉动 `alpha *= .62+.38*sin(t*sp+ph)` | 12=相位 13=速度 |
| 2 / 3 | 下落 / 上升（`y ∓= phase*rg`，3 还带横向摆动） | 12,13,14=行程 15=缩放 |
| **5** | **绕 Y 轴自转** `[x,z] = [c*x+s*z, c*z-s*x]`，协方差也跟着转 | 13=角速度 |
| 6 | 悬浮 `y += sin(t*sp+ph)*rg` | 12,13,14 |
| 8 | 扇翅（XZ 缩放呼吸） | 13,14,15 |
| 9 | 径向脉动 | 12,13,14,15 |
| 10 | 波浪（随高度） | 12,13,14,15 |
| 11 | 风吹 | 12,13,14 |
| **12 / 13** | **骨骼蒙皮**（13 = 骨上仍有风摆） | **12=骨A 13=骨B 14=权重B** |
| 14 | 散开 | 12,13,14,15 |
| 15 | 下落 + XZ 抖动 | 12,13,14,15 |

### 骨骼约定（`src/kit/k1-stage.js:625-628`、`K.bones.posed`）

```
anim.bones = Float32Array(12 * 骨数)
每根骨 12 个数：3x3 行主序 basis（9）+ 平移（3）
最终位置：P' = M_行主序 · P_bind + T
双骨：P' = lerp(M_A·P+T_A, M_B·P+T_B, w)   （形状/协方差只跟骨 A）
```

API：`K.bones.tag(W, ids, bid, bid2, w2)` 打标；`K.bones.posed(W)` 返回摆好姿势的 data 副本；
`K.bones.bind(W, {ids,bid,bid2,w2,M,pose})` 一把梭。

**时间推进必须走 `cli/diarama-pose.js` 的 `pose(w, t)`**，它内部是 `anim.update(1/60, t)`；
stateful 场景要按 1/60 逐步走过去，不能跳。`pose()` 还会把 `w.data` 换成 posed 副本、
把 bind 存进 `w.rest`。

### 实测构成

| 场景 | splat | 骨骼 | kind 12 占比 | 双骨权重 |
|---|---|---|---|---|
| pose-blocking.js | 3,920 | 10 | 100% | 0 |
| clip-sequence.js / motion-review.js | 3,920 | 10 | 100% | 0 |
| animation-timeline.js | 8,922 | 11 | 48% | 0 |
| puppet.js | 1,849 | 7 | 42% | 有（21%/23%） |
| motion-fx.js | 13,021 | 15 | 39% | 有（5%） |

### 逐骨刚性切分是**精确**的

`pose-blocking` 的双骨权重为 0，所以「每个 splat 归给一根骨、每根骨一个节点」不丢信息。
导出器自检（用导出的 bind 位置 + 骨骼矩阵重建，对比 `K.bones.posed`）：

```
自检误差 : 1.19e-7   （通过）
```

---

## 7. 骨骼 → Godot 的映射

一个 PLY 一把骨，一个 `GaussianSplatNode` 挂一个 `Transform3D`。因为 GDGS 导入时
减掉了**该 PLY 自己的** centroid，节点变换必须补回来：

```
GDGS 渲染：worldPos = nodeTransform · (P - C)
期望      ：worldPos = M · P + T
所以      ：nodeTransform = Transform3D(basis = M, origin = M·C + T)
```

### ⚠ 最大的坑：`Basis(a, b, c)` 填的是列，不是行

ink-studio 的 12 个数是 **3x3 行主序**。Godot 4 的 `Basis(Vector3, Vector3, Vector3)`
构造参数是矩阵的**列**，而 `Basis * v` 用的是**行**点乘。直接按顺序传 → 实际用了转置矩阵。

后果：带枢轴旋转时变成反向旋转，**离枢轴越远的部位偏得越狠**——躯干（恒等矩阵）看起来正常，
手臂/前臂飞到身体外面去。这正是我第一版渲染出来的画面。

正确写法（按列重组）：

```gdscript
var m = frame["m"]
var k = boneIndex * 12
var basis := Basis(
    Vector3(m[k], m[k+3], m[k+6]),   # 列 0 = 行 0,1,2 的第一个元素
    Vector3(m[k+1], m[k+4], m[k+7]),
    Vector3(m[k+2], m[k+5], m[k+8]))
var translation := Vector3(m[k+9], m[k+10], m[k+11])
node.transform = Transform3D(basis, basis * centroid + translation)
```

诊断顺序（值得记住）：
1. 先只放 bind pose（`Transform3D(Basis.IDENTITY, centroid)`）—— 完好 ⇒ PLY 和 centroid 修正都对，
   问题在骨骼矩阵。
2. 再对比 `an.update(0,0)` 与 CLI 的 `pose(w,0)` 骨骼矩阵 —— 差 0.0000 ⇒ 数据没问题，
   问题在 Godot 侧变换。
3. 剩下就是基变换约定。

---

## 8. 实测结果

**Signal courier，3,920 splat / 10 骨 / 48 帧 @ 24fps / 218 KB PLY**

| 时间 | 姿势 |
|---|---|
| t=0.00s | ready，双臂微张 |
| t=0.80s | 抬臂中，躯干转向 |
| t=1.60s | 右臂举起示意（对应 `reach` 关键帧 `rightArm rot [-22,0,144]`）|

性能：**0.40 ms/帧**（1000×700，无 vsync，RTX 4080，Compute 后端）。
3,920 splat 的角色对渲染器基本免费。

---

## 9. 动画的**真实局限**（重要）

PLY 只有 14 个 float，**lane12-15 全部丢失**。所以：

- ✅ **骨骼动画能过桥**（kind 12/13），因为骨骼绑定被转成了「分文件 + 骨骼矩阵轨」。
- ❌ **逐 splat 程序化动画过不了桥**（kind 1/2/3/5/6/7/8/9/10/11/14/15）——
  自转、悬浮、下落、扇翅、风吹、脉动全部依赖 lane12-15 的 phase/speed/range/extra，
  这些在 PLY 里没有位置。风摆（kind 11）在 ink-studio 里是渲染器实时算的。
- ⚠ **双骨混合被降级成单骨**：`w >= 0.5` 归骨 B，否则归骨 A。关节处会有硬接缝
  （`pose-blocking` 无此问题；`puppet.js`、`motion-fx.js` 有）。

---

# 第三部分：VFX（逐 splat 程序化动画）

第九节里那个「❌」已经解决了。

## 10. 关键洞察：45 个空 SH 槽

14-float PLY 装不下 lane12-15 —— 但**根本不需要加宽 PLY**。

ink-studio 的颜色是平的（`packedRGB` 直接给 RGB），所以 45 个高阶 SH 系数
（`f_rest_0..44`）**全是 0**。而 GDGS 本来就把 48 个 SH float 全部传上 GPU。
拿其中 5 个装动画参数就行，缓存布局一个字节都不用改。

### 映射（坑：f_rest 是通道交错的）

`standard_ply_decoder.gd` 的写法是：

```gdscript
sh_coeffs[3 + coeff*3 + 0] = f_rest_{coeff}
sh_coeffs[3 + coeff*3 + 1] = f_rest_{coeff + 15}
sh_coeffs[3 + coeff*3 + 2] = f_rest_{coeff + 30}
```

即 **0..14 = R，15..29 = G，30..44 = B**。所以解码到 `sh_coeffs[3..7]` 的五个名字是：

| PLY 属性 | sh_coeffs | 含义 | ink-studio 的 lane |
|---|---|---|---|
| `f_rest_0`  | c[3] | kind | lane11 & 15 |
| `f_rest_15` | c[4] | phase | lane12 |
| `f_rest_30` | c[5] | speed | lane13 |
| `f_rest_1`  | c[6] | range | lane14 |
| `f_rest_16` | c[7] | extra | lane15 |

导出就是 19 个 float / 76 字节（GDGS 对缺失的 `f_rest` 默认 0，所以其余 40 个不写）。

## 11. 着色器

改的是 **Raster** 后端：`addons/gdgs/runtime/render/raster/materials/gaussian_raster.gdshader`。

- 新增 `ink_anim()`，是 `src/splat-frames.js` 的逐行移植（position / opacity / covariance）。
- 在 `vertex()` 里读完 `t0/t1/t2` 后立刻做：两次 `texelFetch`（前两个 SH texel）拿到 5 个参数，
  不满足就直接跳过。静态 splat 和没带 `--vfx` 导出的资产都是无操作。
- 时间用 **`TIME` 内建**，所以**不需要动任何 GDScript 驱动**。
- 填完 `c[48]` 后必须把 `c[3..7]` 清零，否则 `eval_sh()` 会把动画参数当成一阶 SH 染色。

### 三个移植陷阱（都踩过）

1. **JS 解构赋值 vs GLSL 顺序执行**。kind 5 的 `[x,z] = [c*x+s*z, c*z-s*x]` 两边都用旧 x；
   GLSL 里 `p.x` 写完再算 `p.z` 就错了。必须存临时量。
   *例外*：kind 11 的 `p.y` **故意**用上一行改写后的 `p.x`（ink-studio 就是这样的）。
2. **kind 15 不缩放协方差**。`covariance()` 只在 `kind===2||kind===3` 时乘 `scale²`，
   kind 15 把 lane15 拿去做抖动偏移了。我第一版错算成 2/3/15，相对误差 0.348。
3. **`mat3(a,b,c)` 填列**。kind 5 的旋转矩阵 `[c 0 s; 0 1 0; -s 0 c]` 行主序，
   而 GLSL 构造函数给的是列，所以要传 `mat3(vec3(c,0,-s), vec3(0,1,0), vec3(s,0,c))`。
   行列搞反 → 协方差的旋转方向和位置相反。

## 12. 验证

### 数学一致性（不开 GPU）

`art-pipeline/test-vfx-math.js` 把 GLSL 逐行镜像成 JS，对同一批 splat、同一批时间，
和 ink-studio 的权威 CPU 解算器 `SplatFrames.sample(i).position()/.opacity()/.covariance()` 比：

| 场景 | 覆盖 kind | 位置 | 不透明度 | 协方差 |
|---|---|---|---|---|
| motion-cadence.js | 1, 2, 11 | 0 | 0 | 0 |
| windbreak.js | 3, 11 | 0 | 0 | 0 |
| lantern-squall.js | 2, 15 | 0 | 0 | 0 |
| art-effects.js | 5 | 0 | 0 | 0 |
| sheltered-arch.js | 2, 11 | 0 | 0 | 0 |
| weather-courtyard.js | 2, 11 | 0 | 0 | 0 |

全部**精确为 0**。

### 实测（GPU）

`motion-cadence.js`（Rain at the lantern landing，26,625 splat，kind 2 雨 + kind 11 风）
在 Godot 里用 Raster 后端跑起来，雨实时下落；帧间平均像素差 1.76～1.85 / 255，
几何体完全不变。和 ink-studio 自己 `cli render` 出来的同一场雨在滴形/倾角/配色上一致。

成本：**每帧 0 字节 CPU 传输**，每 splat 多两次 `texelFetch`，资产从 56 涨到 76 字节/顶点。

## 13. 生产流程现状

| 能力 | 状态 | 命令 |
|---|---|---|
| 静态机位场景 | ✅ | `inkstudio2ply.js --example X.js --out out/x.ply` |
| 骨骼角色 | ✅ | `inkstudio2ply-boned.js --example pose-blocking.js --out out/courier` |
| 程序化 VFX | ✅ | 上面两条都加 `--vfx`（boned 版对非骨骼 bucket 自动开） |
| 一套资产里同时含角色 + VFX | ✅ 机制已通 | bone_*.ply + fixed.ply（带 VFX）+ anim.json |
| 像素风后处理 | ❌ 未做 | 见第五节 |

`inkstudio2ply-boned.js` 现在能吃任意场景：有 `anim.bones` 就按骨切，没有就把全部 splat
写进带 VFX 的 `fixed.ply`。verification 自检（重建 vs `K.bones.posed`）误差 1.19e-7。

## 14. VFX 仍有的局限

1. **只移植到 Raster 后端**。Compute 后端（`gsplat_projection.glsl`）没改，
   而 Forward+ 的 Auto 会选 Compute。用 VFX 资产必须设 `gdgs/rendering/backend="Raster"`。
2. **kind 6/7/8/9/10/14 没有出厂范例可以对照**。代码路径结构相同、镜像自同一份源码，
   但没有实测数据背锅。真要依赖它们，先用 `K.splatFields` 造一个测试场景再跑 `test-vfx-math.js`。
3. **kind 12/13（骨骼）不走着色器**。它们的 lane12-14 是骨骼索引，导出时留零，
   继续用逐骨节点 + 骨骼矩阵轨那条路。两条路可以在同一场景共存。
4. **双骨混合仍是降级**（`w>=0.5` 归单骨）。要做真正的 2-bone LBS 需要改
   GDGS 把骨骼权重也塞进数据纹理，工作量大。

---

# 第四部分：像素风后处理

前三部分把几何和动画搬到了 Godot，但画面还是平滑渐变的三维渲染。
这一部分把它变成 ink-studio 的像素画。

## 15. 挂载点：为什么必须是 CompositorEffect

GDGS 的 Raster splat 是 `blend_mix` 的透明物体，在透明阶段才画。
所以用「全屏 QuadMesh + spatial shader 读 `hint_screen_texture`」这个常见招数**不行** ——
它拿到的是不透明阶段的拷贝，splat 根本不在里面。

唯一正确的位置是 `EFFECT_CALLBACK_TYPE_POST_TRANSPARENT` 的 CompositorEffect：
挂在 `WorldEnvironment.compositor` 上，GDGS 的合成 effect 之后、整帧完整之后。

实测：`main.tscn` / `vfx.tscn` 的 effect 链都是 2 个（GDGS + inkpixel）。

## 16. ⚠⚠ 调色板字节序陷阱（这个坑值得单独记）

**`world.pal` 和逐 splat 的 `packedRGB` lane 用的是相反的字节序。**

| 来源 | 编码 | 举例 |
|---|---|---|
| `world.pal[i]`（sidecar 的 `ink.palette`） | `0xRRGGBB`，**红在高位** | `0x2a2e36` = rgb(42,46,54) |
| 逐 splat 的 row lane 7（`packedRGB`） | `r \| g<<8 \| b<<16`，**红在低位** | `0x362e2a` 解出 rgb(42,46,54) |

两者是**同一个颜色**，但整数编码相反。实测 watcher 场景 112,465 个 lane 值，
**112,465 个**全部等于某个调色板项按字节交换后的值。

判定方法（可复现）：把一个未量化的渲染图的主要颜色集合，分别按两种解 A/B 去匹配调色板：

| 场景 | 解释A（红在低位） | 解释B（红在高位） |
|---|---|---|
| watcher（18 色） | 加权平均误差 3.34，精确命中 0% | **误差 0.01，命中 100%** |
| motion-cadence（27 色） | 误差 13.53，命中 0% | **误差 0.04，命中 99.4%** |

**解反的后果**：冷色全部变暖（蓝灰石柱变棕），并且量化会在边缘选出错的暗色，
在物体轮廓上叠一圈不存在的深棕/暗红描边。不是“抗锯齿”问题，也不是“抖动太强”问题。

导出器写 `f_dc` 用的是 lane（低字节红），是**对的**；只有调色板表的解码要反过来。

## 17. 算法：三步

### 17.1 块平均（真正让画面变像素画的一步）

量化本身不产生像素感 —— 全分辨率量化只是“色阶压缩的三维渲染”。
ink-studio 是在小的 art grid 上渲染再放大。这里在 compute shader 里做等价的事：

把 `ps×ps` 的块平均成一个线性颜色，抖动和量化都基于**块坐标**，最后整块写同一个值。
`ps=3` 时 1280x720 变成 ~427x240 的硬边方形像素。

> 抖动必须用块坐标 `pq` 而不是像素坐标，否则会被块平均洗掉。

### 17.2 调色板量化 + 投影抖动

用的是 ink-studio 的 `constraintPalette`（`src/webgl/shaders.mjs:716-728`），
不是“先加噪声再取最近”：

```glsl
// 找 best 和 second（加权距离，权重 0.30/0.55/0.15）
vec3 delta = second - best;
float t   = dot(W*delta, srgb - best) / dot(W*delta, delta);  // 投影位置，0 = 正好是 best
float rank = (BAYER[(pq.x&3) + ((pq.y&3)<<2)] + 0.5) / 16.0;   // Bayer 秩 [0,1)
float thr  = 0.5 + (rank - 0.5) * dither;
if (t >= thr) use second else best;
```

关键区别：输入色已经精确命中调色板时 `t = 0`，永远赢不了阈值 → **抖动量自动归零**，
不会在纯色区域凭空造出噪点。这就是最初那版（加噪声再最近邻）把背景抖成一片麻点的根本原因。

### 17.3 描边（可选，默认关）

GDGS 的 raster splat 用 `depth_draw_never`，**深度缓冲里没有 splat 的深度**，
所以基于深度的轮廓检测对 splat 场景完全无效。只能从（线性→sRGB 后的）亮度突变求边，
是近似，不是真正的几何轮廓。默认 `edge_amount = 0`。

场景自带的暗色轮廓 splat 已经被正确量化成调色板里的深色，看起来已经有描边感了。

## 18. 背景不能被量化

diorama 的背景是清屏色，不属于 splat 调色板。若也走量化，会被抖到两个相邻调色板色之间，
变成一片噪点。

做法：直接从颜色缓冲的**角落像素**取清屏色（左上角必是背景），等值像素原样返回。
不需要传 `ink.bg`，也不需要做任何颜色空间转换 —— 没有猜错的可能。

## 19. splat 要压成硬边实心盘

ink-studio 的 splat 是一个**硬边实心盘**（不透明圆盘，没有高斯衰减），
所以它的源图本身就只有调色板里那几十种颜色。GDGS 默认是平滑高斯，源图是连续的。

这一层要在两个旋钮上同时改，二者是耦合的：

| 旋钮 | 作用 | 太小会怎样 |
|---|---|---|
| `flat_alpha` | 盘内 alpha 恒为 1，去掉高斯衰减 | — |
| `alpha_cutoff` | 高斯截断阈值 → 盘半径 `sqrt(2·ln(opacity/cutoff))` | 盘变小，表面上露缝 |

**开了 `flat_alpha` 反而要把 `alpha_cutoff` 调低（盘变大）**，和直觉相反：
实心盘意味着前面完全遮住后面（画家算法），盘不够大就会在表面上露出背景缝。

```ini
[gdgs]
rendering/backend="Raster"
rendering/raster/flat_alpha=true
rendering/raster/alpha_cutoff=0.1     # 0.98 的不透明度下 ≈2.13σ 盘半径
```

实测对比（watcher，1280x720，px=3）：

| flat_alpha | alpha_cutoff | 盘半径 | PNG | 观感 |
|---|---|---|---|---|
| false | 0.8 | ~0.5σ | 14,729 | 骰子面仍是渐变 |
| true | 0.3 | ~1.54σ | 10,219 | 平色，但骰子面跨 3 个色带 |
| **true** | **0.1** | **~2.13σ** | **9,828** | **骰子面纯一块紫，最接近 ink-studio** |

两个盘尺寸都没露缝，选 0.1。

### 坑：这两个 uniform 原本根本没接口

`gaussian_raster.gdshader` 里的 `alpha_cutoff` 是个**普通 shader uniform，没有 GDScript setter**，
所以它永远停在默认值 0.00392。也就是说早期“调 cutoff 看效果”的实验全部是空操作
（这也解释了为什么整张图看起来没变化）—— 中间出现过的 0.55/0.9/0.98 差异都只是噪声。

真正生效的接线在 `raster_render_backend.gd` 创建 ShaderMaterial 的那几行（~294 行后），
从 `ProjectSettings.get_setting("gdgs/rendering/raster/alpha_cutoff")` 和
`.../flat_alpha` 读。注意：这个设置在 **GaussianSplatNode 创建时**生效，
所以不能用 `--cutoff=` 在父节点 `_ready` 里改（子节点 `_ready` 早于父节点）。

## 20. 验证

对 watcher 开了像素后处理的渲染图统计全图像素：

- 颜色种类：从 116,918 字节（平滑渐变）降到约 20 种
- **非调色板颜色：0 种** —— 量化是精确的，没有一个像素偏出调色板

这就把“看起来对了”变成了“可以断言对了”。
最初被误判为“暗红描边 bug”的那圈线，经统计其实是场景自带的轮廓 splat，
被正确量化成了 `#3e2e20` —— 但其实是字节序错误让它变成了暖色，修好后消失。

## 21. 还没做的

1. **真正的几何轮廓描边**。需要每个 splat 的轮廓标记（或让 splat 写深度），
   不是屏幕空间亮度差分能替代的。目前靠场景自带的暗色轮廓 splat。
2. **计算后端未做像素后处理验证**。目前全在 Raster 后端验证过。
3. **调色板/抖动是全局的**。ink-studio 的 `look` 可以按区域/按物件作用，
   这里一个场景一套。

---

# 第五部分：七个 diorama 全量过一遍

单个场景能跑不等于管线能生产。把内置的七个 diorama 全导出、全渲染、全断言。

## 22. 全量结果

| id | 名称 | splat | 调色板 | 磁盘 | worst aspect |
|---|---|---|---|---|---|
| watcher | Die Watcher | 112,600 | 18 | 6.01 MB | 1.000 |
| burn | Slow Burn | 46,902 | 24 | 2.51 MB | 1.000 |
| idol | Old Idol | 77,917 | 12 | 4.16 MB | 1.000 |
| bench | The Bench | 78,942 | 19 | 4.22 MB | 1.000 |
| stuff | Soft Things | 33,820 | 25 | 1.81 MB | 1.000 |
| cabinet | Night Cabinet | 75,862 | **42** | 4.05 MB | 1.000 |
| rehearsal | The Rehearsal | 15,605 | 16 | 0.83 MB | **1.533** |
| | **合计** | **441,648** | | **23.6 MB** | |

七个全部导入成功、渲染成功、退出码 0。

## 23. 扁平 splat 风险：只有一个场景需要担心

之前只在 watcher 上测过扁平 splat（worst aspect 1.000，完全各向同性）。
全量跑下来：**七个里有六个 worst aspect 正好 1.000**，永远各向同性；
只有 **rehearsal = 1.533**。

这说明 `axial()` 产生的扇盘在 shipped 场景里极少出现。
1.533 也只是轻微各向异性（不是零厚度），实测渲染没有炸开或闪烁。

另一个差异：rehearsal 的 alpha 全是 0.999（完全不透明），其他六个都是 0.0001..0.999。

## 24. 作者相机：sidecar 现在带 cam 了

之前 sidecar 没有 cam 字段，Godot 侧只能拿 AABB 硬框 —— 而 watcher 的 AABB 带一个
**Y = -99 的背景哨兵**，直接框会毁掉构图。现在导出器把 `world.cam`
（target / dist / pitch / yaw / 可选 fov）写进 `ink.cam`。

### fov 是 38° 不是 45°

ink-studio 的默认垂直 fov 是 **38°**（`src/camera-lens.js:3`，`defaultFov = 38 * PI / 180`），
并且 `cam.fov` 存的是**弧度**（`kc-data.js` 校验 `0 < fov < PI`）。

用 45° 会比作者视角更广，主体显得偏小。七个场景全部没有写 fov，所以取默认 38°。
修正后主体尺寸正常，不再需要额外乘一个退后系数。

## 25. 总览工具

- `ink2godot/overview.tscn` + `overview.gd`：逐个加载七个 PLY，按作者相机构图，挂像素风后处理，抓图后换下一个。
- `art-pipeline/overview-sheet.ps1`：拼成 4x2 总览表，同时逐个做调色板断言。

```powershell
& $GODOT --path $G --rendering-driver vulkan --resolution 640x360 res://overview.tscn -- --capture
& D:/GithubSoftware/GameDev/art-pipeline/overview-sheet.ps1
```

断言结果（图内除背景清屏色外，落在调色板外的颜色）：

| 场景 | 图内颜色 | 调色板 | 越界颜色 |
|---|---|---|---|
| watcher | 11 | 18 | **0** |
| burn | 17 | 24 | **0** |
| idol | 11 | 12 | **0** |
| bench | 18 | 19 | **0** |
| stuff | 23 | 25 | **0** |
| cabinet | 40 | 42 | **0** |
| rehearsal | 15 | 16 | **0** |

七个场景、零越界像素。这是整条管线最强的回归门禁。

## 26. 踩到的两个工具坑（写脚本时）

1. **PowerShell 变量名大小写不敏感**：`$G`（项目路径）被
   `$g = [System.Drawing.Graphics]::FromImage(...)` 覆盖，导致所有路径变成
   `System.Drawing.Graphics/overview_watcher.png`。改成 `$proj` / `$canvas`。
2. **`powershell.exe`（5.1）按 ANSI 读 UTF-8 脚本文件**，中文注释/输出全乱码。
   用当前 shell（pwsh 7）直接 `& ./script.ps1` 跑。




