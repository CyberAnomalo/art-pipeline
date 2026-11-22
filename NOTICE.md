# Third-party notices

This project is MIT licensed (see LICENSE).

It contains **no** ink-studio source code. It is a tool that runs against a separate checkout of
ink-studio, which the user must clone themselves:

## ink-studio

Copyright (c) 2026 siliconjungle
https://github.com/siliconjungle/shapeshift-labs-ink-studio

Licensed MIT. `package.json` marks it `private: true` with no semver, so this project pins it by
commit SHA instead — see `VERSIONS.md`.

The GLSL animation function reproduced in `test-vfx-math.js` is a line-for-line port of
ink-studio's `src/splat-frames.js`, kept in this repo solely as a regression harness so that the
renderer-side port can be checked numerically.
