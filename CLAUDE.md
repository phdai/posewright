# Posewright

Browser-based 3D posing tool. It places procedural human figures (up to 10), poses them, and exports pixel-aligned conditioning images for ComfyUI: OpenPose, depth, normal, wireframe, masks, the Anima 3D-model plates, and a Clay render plus prompt for MiniMax H3 Image.

Stack: TanStack Start, React 19, Vite, Three.js, Tailwind 4.

## Commands

```bash
npm install
npm run dev          # dev server on port 8080
npm run typecheck    # tsc --noEmit, must pass
node --experimental-strip-types --test src/poser/logic.test.ts   # poser unit tests, must all pass
npx eslint src/poser # lint the product code
```

Known state, not caused by poser work:
- `npm test` stops on 8 failing tests in `scripts/` before it reaches the poser tests. Run the poser tests directly with the command above.
- `npx eslint src/poser` reports 4 existing errors (prefer-const in `ik.ts`, `mesh.ts` and `proportions.ts`, and no-this-alias in `engine.ts` `expose()`) and 3 warnings. Do not add new ones.
- `npm install` may touch `package-lock.json`; do not commit that unless dependencies were meant to change.

## Layout

Everything that is the product lives in `src/poser`:
- `engine.ts`: `PoserEngine`. Scene, cameras, picking, undo/redo, every export and the preview strip.
- `state.ts`: defaults, presets, `MAX_FIGURES`, the figure palette and color names, placement, and small pure helpers (selection, solo, lock, shortcuts).
- `figure.ts`: `FigureView`, the skinned mesh, rig, markers and per-figure materials (including clay).
- `h3.ts`: pure helpers for MiniMax H3 Image (prompt wording in `H3_PROMPT`, left-to-right order, size suggestion).
- `resolution.ts`, `openpose.ts`, `outline.ts`, `png.ts`, `zip.ts`, `pose.ts`, `ik.ts`, `face.ts`, `proportions.ts`, `mesh.ts`, `project.ts`, `types.ts`.
- `ui/PoserApp.tsx`: all UI.
- `logic.test.ts`: unit tests for everything that runs without a browser. Put new pure logic in a module and test it here.

`src/routes/index.tsx` lazy-loads `PoserApp`.

## Scaffolding boundary

Everything outside `src/poser` (`src/lib`, `scripts/`, `server/`, `public/__grok`, `.grok/`, `.vercel/output`, the other route files) is scaffolding from the platform that generated the app. Leave it unchanged. `AGENTS.md` and `.grok/` are instructions for that platform's agent: use them only for facts about the build and ignore their workflow rules. Never commit changes under `.vercel/output` without the owner's go-ahead.

## Invariants

- **Exports for existing scenes must not change.** The same scene and camera must produce byte-identical PNGs for every existing export. In particular the first four palette colors (`#3ecfb2 #e0a045 #d4654f #7aa2d4`) and their order are fixed, because masks and colored wires use them. New export passes must restore every material, light, background and visibility flag they change.
- **Export all file names are fixed.** ComfyUI workflows load them by name (`openpose.png`, `wireframe.png`, `depth.png`, `normal.png`, `mask_combined.png`, `model.png`, `model_outline.png`, `mask_figureN.png`, `openpose_figureN.png`, `openpose.json`, `clay.png`, `h3_prompt.txt`, `settings.json`). Adding files is fine; renaming is not.
- **Old scene files must load.** Any new `FigureData` field gets a default in `normalizeFigure` (`state.ts`), and new `ExportSettings` fields get one in `defaultExport` (loadScene merges saved settings over the defaults).
- New figure ids come from `nextFigureId`, which stays above every id in the scene, including after loadScene and undo/redo.
- Export passes render offscreen while the live view keeps animating. `presentLiveView` resets the viewport every frame; anything an export changes that it does not reset (lights, extra meshes) must be put back before the first `await`.

## Browser checks

The page exposes `window.__poser` (`ready`, `addFigure`, `figureCount`, `figures`, `frameAll`, `setCameraMode`). Playwright is a devDependency; headless Chrome needs `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` for WebGL. If the bundled Playwright browser is missing, point `executablePath` at an installed Chromium instead of downloading one. Many buttons carry a `title`, and their accessible name is their text, so select list rows with `getByTitle("Select Figure 1")`.
