# art-pipeline

**Bake pixel-art Gaussian-splat scenes into Gaussian `.ply` files that any 3DGS renderer can load.**

[中文](README.zh-CN.md) · [Spec](SPEC-inkstudio-to-godot-ply.md) · [Versions](VERSIONS.md)

---

## What this is

An offline exporter. It builds a scene with [ink-studio](https://github.com/siliconjungle/shapeshift-labs-ink-studio)
— a JavaScript SDF-sculpting / Gaussian-splat art tool — and writes a standard 3D Gaussian Splatting
PLY file, plus a JSON sidecar carrying the metadata a renderer needs to reproduce the look.

The consumer for this repo is [ink2godot](https://github.com/CyberAnomalo/ink2godot) (Godot 4 +
[GDGS](https://github.com/ReconWorldLab/godot-gaussian-splatting)), but the PLY output is not
Godot-specific — it is the usual `x/y/z`, `f_dc_*`, `opacity`, `scale_*`, `rot_*` layout that
3DGS tooling expects.

## Why not just use ink-studio's own renderer?

Because the target is a game engine. ink-studio is a browser/Node toolkit; using it as a runtime
means adopting its renderer, its input layer and its whole 26k-line world runtime. Baking to a
portable splat file lets a mature engine handle rendering, physics, streaming and tooling, while
ink-studio stays what it is genuinely good at: **procedural, AI-friendly art generation**.

So this repo is deliberately small: two exporters, a numeric verification harness, and a spec.

## Usage

```powershell
# one of the seven built-in dioramas
node inkstudio2ply.js --scene watcher --out ../ink2godot/assets/dioramas/watcher.ply --stats

# any example scene, carrying procedural per-splat animation (19 floats/vertex)
node inkstudio2ply.js --example motion-cadence.js --out ../ink2godot/assets/vfx/motion-cadence.ply --vfx --stats

# a rigged character: one PLY per bone + baked bone matrices
node inkstudio2ply-boned.js --example pose-blocking.js --out ../ink2godot/assets/courier --fps 24 --seconds 2
```

| Script | Handles |
|---|---|
| `inkstudio2ply.js` | Static scenes and procedural VFX. `--scene` for built-ins, `--example <file>.js` for any example |
| `inkstudio2ply-boned.js` | Everything: splits skeletal splats into per-bone PLYs, routes the rest to `fixed.ply`, emits `anim.json` |

## Output contract

Binary little-endian PLY, **no list properties** (many decoders reject them outright).

Base properties, 14 × float32 = 56 bytes per splat:

```
x y z  f_dc_0 f_dc_1 f_dc_2  opacity  scale_0 scale_1 scale_2  rot_0 rot_1 rot_2 rot_3
```

With `--vfx`, five extra floats raise the stride to 19 × float32 = 76 bytes:

```
f_rest_0  f_rest_15  f_rest_30  f_rest_1  f_rest_16
   kind      phase       speed      range      extra
```

They sit in unused SH slots because the colour is flat (`f_rest_*` are omitted for pixel-art
assets anyway), so carrying animation data costs **no buffer-layout change** on the renderer side.

Conversions applied on write:

- **scales** = `log(sigma)`, from an eigendecomposition of ink-studio's covariance matrix
- **opacity** = `logit(alpha)`, with alpha clamped
- **f_dc** = `(srgbByte/255 - 0.5) / 0.28209479177387814` — sRGB, not linearised (this is what the
  SH decoder expects; the renderer does sRGB→linear itself)
- **rotation** = unit quaternion in `w x y z` order

A sidecar `.ply.json` records the centroid, AABB, palette, background, dither amount and the
author's camera. **The centroid matters**: renderers that re-centre on the mean need it to restore
world coordinates.

## Verification

Two things are machine-checked, because both fail in ways that look fine visually:

```powershell
node test-vfx-math.js        # one scene
./verify-all.ps1             # six scenes, 461,535 splats, ~5 s
```

`test-vfx-math.js` re-implements the renderer's GLSL animation function line-for-line in JS and
compares position, opacity and covariance against ink-studio's own CPU solver across several
timestamps. It must report **exactly 0.000e+0**.

This is not ceremony — it caught a `mat3` column/row mix-up that rotated covariance *opposite* to
position, and a case where a life-swell scale was wrongly applied to an animation kind that reuses
the same parameter lane.

```powershell
node probe-dioramas.js   # per-scene camera, radius, palette, splat count
node probe-anim.js       # bone/kind composition per example
node probe-vfx.js        # procedural animation census
node probe-pal.js        # palette byte-order check
./overview-sheet.ps1     # contact sheet + off-palette pixel assertion
```

## Dependencies

ink-studio is not vendored. Clone it as a sibling (or point `INK_STUDIO_DIR` at it):

```
some-parent-dir/
  art-pipeline/                     <- this repo
  shapeshift-labs-ink-studio/       <- the art baker
  ink2godot/                        <- the Godot project
```

```powershell
$env:INK_STUDIO_DIR = "D:/somewhere/ink-studio"
```

`find-ink.js` resolves it and, if it cannot, prints the three ways to fix it instead of an ENOENT
stack.

Requires **Node 18+**. ink-studio needs **no build step** — `index.js` concatenates its sources
into `dist/standalone.js` on demand.

Pinned commits for everything, plus the contracts that must be re-checked on any version bump,
are in [VERSIONS.md](VERSIONS.md).

## Two traps worth knowing before you read the code

1. **The two colour encodings use opposite byte orders.** `world.pal` entries are `0xRRGGBB`
   (red in the high byte); the per-splat colour lane is `r | g<<8 | b<<16` (red in the low byte).
   Verified on a 112,465-splat scene: 0 matches reading the palette one way, 112,465 the other.
2. **ink-studio's covariance values are variances in world units**, not scales — eigenvalues are
   `sigma²`, so `scale_*` needs `log(sqrt(eigenvalue))`. Copying variances straight into `scale_*`
   produces subtly wrong (too large, too soft) splats that still look plausible.

## License

MIT. ink-studio is MIT (© 2026 siliconjungle); GDGS is MIT.
