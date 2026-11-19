# Posewright

A local 3D posing bench. Place up to ten procedural human figures, pose them with forward or inverse kinematics, and export pixel-aligned ControlNet conditioning images for ComfyUI. Nothing is downloaded at runtime. The body mesh is generated in the browser.

## Run

```bash
npm install
npm run dev
```

`npm run build` writes a static production bundle. Unit tests:

```bash
npm test
```

The pure-logic tests (proportions, projection, OpenPose JSON, PNG/ZIP, IK) live in `src/poser/logic.test.ts` and run under Node's test runner.

## Controls

| Input | Action |
| --- | --- |
| Left drag | Orbit, or mouse-look in fly mode after you click the view |
| Right drag | Pan |
| Scroll | Zoom |
| C | Toggle orbit / fly |
| WASD | Fly. **A strafes left, D strafes right** |
| Q / E | Fly down / up |
| Shift+E | Export all, in orbit mode. Plain E does nothing in orbit mode, so a stray keypress no longer starts an export |
| Shift | Fly faster |
| G / R | Move gizmo / rotate gizmo |
| Arrow keys | Nudge the selected joint. Up/Down are X, Left/Right are Y. Shift is 5° |
| `,` / `.` | Nudge the selected joint's Z |
| F | Frame the selection |
| Tab | Next joint on the selected figure (Shift+Tab goes backward) |
| `[` / `]` | Previous / next figure, keeping the same joint |
| Del | Delete the selected figure |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo (50 steps) |
| ? | Shortcut sheet |

The frame drawn on the view is the exact crop that will be exported. Change the export resolution and the crop changes with it.

## Figures

Each figure is one shared humanoid: bone lengths come from `src/poser/proportions.ts`, which documents the anthropometric fractions (Drillis & Contini segment lengths, Pheasant shoulder and hip breadth, artistic head-count by age). Sex presentation is a continuous blend. Age changes the head-to-body ratio, the leg share, the allowed height range, and adds a forward stoop after about 55. Mass and muscularity change girth, not height. Shoulder, hip, torso, and leg sliders are multipliers; height is renormalized so the figure stays the requested number of centimeters.

Presets (Adult female average, Adult male muscular, Child 6y, Teen male slim, Elderly female, Heavy adult male) only set those sliders.

The mesh is a `SkinnedMesh` of lofted tubes and ellipsoids, roughly a few thousand triangles, including a 3-bone chain per finger. The torso is three bones — lower, mid, and chest — so a forward fold bends as a curve instead of one tube creasing through itself. **Detailed feet** (pose panel) adds a heel and a toe chain — two bones on the big toe, three on the others. Leave it off for the original single-bone foot, which is the better match for a ComfyUI control image. **Detailed head** draws the 68 face landmarks on the figure. Leave it off for the plain head. The **Face** tab is where those points are shaped (jaw, smile, brows, blink, mouth width). The head mesh itself does not change. Face landmarks stay offsets on the head bone, scaled by head length, so they stay put on a child or an adult.

Changing a slider rebuilds the mesh and keeps the current joint rotations.

Each figure gets the first palette color no other figure is using, so deleting a figure and adding another gives the new one the freed color. New figures stand in the first free spot of a grid of rows of five, 0.9 m apart, each row 1.1 m further back.

In the figure list, **Solo** shows that figure and hides the others (press it again, or **Show all**, to bring them back; it is one undo step). **Lock** stops the viewport from picking, hovering or moving a figure, which helps when figures overlap. The panels still edit a locked figure. Scenes saved before these buttons existed load with every figure unlocked.

## Poses

Rest is a T-pose. Joints are XYZ Euler degrees in that frame (see the comment at the top of `src/poser/pose.ts`). The pose panel lists joints in an accordion, one region open at a time; Tab still walks the full list and opens the group it lands in. Type a degree into X, Y, or Z, or nudge with the arrow keys (comma and period change Z). FK attaches a rotation gizmo to the selected joint. IK solves arms and legs with a two-bone law-of-cosines solver (elbows bend back, knees bend forward) and the spine/neck with FABRIK. Editing a joint that IK is driving turns IK off and keeps the pose, so the number you type stays. Joint limits are on by default; uncheck **Joint limits** in the pose panel for a full turn on every axis. Mirror copies one side onto the other.

**Save angles** writes every joint as XYZ degrees (`joints` in the JSON, plus the same data as `pose`). **Load angles** reads that file, or an older pose file that only has `pose`. **Save figure** / **Load figure** also store the body sliders, scale, and placement so you can swap a character back in. Save scene still stores everyone.

Turn **Body mesh** off to draw sticks and joint dots instead of the skinned body. That skips the mesh on the GPU, which helps a slow machine. Exports still render the solid body.

Built-in poses: T-pose, A-pose, standing, walking, running, sitting, crouching, arms raised, fighting stance, toe touch. Hand presets: open, relaxed, fist, point, grip. With detailed feet on, toe presets are straight, relaxed, and curl. Toe curl is the X axis on both feet. Positive X on the lower torso, mid torso, and chest all pitch forward; share a deep bend across them.

To add a pose, append an entry to `POSE_PRESETS` in `src/poser/pose.ts`. To add a body type, append to `BODY_PRESETS` in `src/poser/state.ts`.

## Exports

Every PNG is 8-bit RGB, opaque, no alpha. Dimensions snap to a multiple of 8 (a warning appears if they are not a multiple of 64). They are rendered offscreen at the requested size from the same camera and crop, with no grid, gizmos, or handles.

- **OpenPose** matches the `controlnet_aux` body drawing: COCO-18, the same limb list and RGB palette, limbs at 60% brightness, keypoints on top. Widths scale from the 4 px / 512 px annotator so a larger export looks like a 512 image that was upscaled. Optional hands (rainbow edges, blue dots) and 68 white face dots. Left/right are the figure's own, so a figure facing the camera has its right limbs on the left of the image. Points behind the camera or outside the frame are dropped. Self-occluded points are kept unless you hide them. JSON uses OpenPose's flat `[x, y, confidence]` arrays plus canvas size.
- **Wireframe** is white on black by default (invert, per-figure color, thickness, hidden-line removal, antialiasing). Edges are a barycentric shader, not GL lines.
- **Depth** is white = near, black = far, auto-fit to the figures or the camera range.
- **Normals** use the ControlNet camera-space convention, including the flat `(128, 128, 255)` background.
- **Masks** are one white silhouette per figure plus a combined color mask.
- **3D model** is a glossy shaded body on black, one material color per figure, for Anima's `anima_3dpose_6200` ControlNet-LLLite. **3D outline** is that same plate plus a complementary-color silhouette and overlap stroke (4 px at a 768 px short side) for `anima_3dpose_outline_7000`.
- **Export all** writes a store-only zip: `openpose.png`, `wireframe.png`, `depth.png`, `normal.png`, `mask_combined.png`, `model.png`, `model_outline.png`, `mask_figureN.png`, `openpose_figureN.png`, `openpose.json`, `settings.json`. The zip name and single-file downloads include a timestamp. Per-figure files are only written for figures that exist.

The preview strip updates as you pose. Untick **Live previews** to stop it re-rendering on a slow machine; downloads and Export all always render the current scene. **Align** draws the skeleton on top of the wireframe so you can check that they share pixels.

## ComfyUI

Load each PNG with **Load Image** and connect it to **Apply ControlNet**. Do not run a preprocessor. The images are already in the format the ControlNet models were trained on.

Set **Empty Latent Image** to the exact export resolution.

Suggested starting strengths:

- OpenPose / DWPose: 0.8–1.0
- Depth: 0.5–0.7
- Canny or lineart (the wireframe): 0.4–0.6
- Anima 3D pose (`anima_3dpose_6200`, the **3D model** PNG): strength 1.0, about 30 steps, CFG 4. Use **3D outline** with `anima_3dpose_outline_7000` when bodies overlap. Do not run a preprocessor, and match the latent to the export size. OpenPose sticks, depth, and lineart are different conditioning types and will not drive these adapters.

Stack them. OpenPose holds the pose, depth holds the volume, the wireframe holds the silhouette.

For more than one character, export the per-figure masks and the per-figure OpenPose images. A typical regional workflow:

1. One shared latent at the export size.
2. A first pass conditioned on `openpose.png` (everyone) plus `depth.png`.
3. For each character, a regional prompt masked by `mask_figureN.png`, optionally with `openpose_figureN.png` on a second OpenPose ControlNet so that character's pose stays locked while you change their prompt.

If a figure is under about 18% of the frame height, the export panel warns you. ControlNet is much more reliable when the whole body is clearly in frame.

## License

Posewright is free software, released under the [GNU General Public License v3.0](LICENSE).
