# MakeHuman body spike

Throwaway experiment, not used by the app. It checks whether the MakeHuman base mesh can replace the procedural body.

- `mh-base.bin`: the MakeHuman base mesh (skin and eyeballs), default 163-bone skeleton and its skin weights, converted by `convert-makehuman.ts` from `makehuman/data` in https://github.com/makehumancommunity/makehuman. These assets are released under **CC0 1.0 Universal** (see that repository's `LICENSE.ASSETS.md`); MakeHuman's program code (AGPL) is not used.
- `makehuman.ts`: loads the binary as a three.js `SkinnedMesh` and straightens the rest A-pose into a T-pose.
- `main.ts`: renders the Classic body and the MakeHuman body side by side (viewport, Clay, Depth, a close-up). The dev server does not route a page to it; on any dev-server page run `import("/src/poser/spike/main.ts")` in the browser console.

Rebuild the binary:

```bash
node --experimental-strip-types src/poser/spike/convert-makehuman.ts <makehuman/data> src/poser/spike/mh-base.bin
```
