import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PerspectiveCamera, Raycaster, Vector3 } from "three";
import { FigureView } from "./figure.ts";
import { FACE_GROUPS, FACE_MIRROR, applyFaceOffset, emptyFaceOffsets, faceLandmarks, faceWeights, posedLandmarks, shapedLandmarks } from "./face.ts";
import { fabrik, solveElbow } from "./ik.ts";
import { flattenKeys, openPoseJson, type PersonPose } from "./openpose.ts";
import { animaOutline, animaStrokePx } from "./outline.ts";
import { encodePngRGB, linearRgbToSrgb } from "./png.ts";
import { mirrorPose, jointNames, jointsToPose, poseToJoints, nearestEuler, limitsFor } from "./pose.ts";
import { projectToPixel } from "./project.ts";
import { headLength, layoutFigure, statureOf, footHeel, TOE_DIGITS } from "./proportions.ts";
import { H3_MAX_AREA, H3_PROMPT, buildH3Prompt, ordinal, orderLeftToRight, suggestH3Size } from "./h3.ts";
import { RESOLUTIONS, exportCameraFit, snapResolution } from "./resolution.ts";
import {
  FIGURE_COLORS,
  FIGURE_COLOR_NAMES,
  MAX_FIGURES,
  SPOT_RADIUS,
  clone,
  colorName,
  defaultExport,
  defaultScene,
  isExportAllKey,
  isPickable,
  isSoloed,
  makeFigure,
  nextFigureId,
  nextFreeColor,
  nextFreeSpot,
  normalizeFigure,
  soloVisibility,
  validSelection,
} from "./state.ts";
import type { BodyParams } from "./types.ts";
import { encodeZip } from "./zip.ts";

const adult: BodyParams = {
  sex: 1,
  age: 30,
  heightCm: 175,
  mass: 0.4,
  muscle: 0.4,
  shoulder: 1,
  hip: 1,
  torso: 1,
  leg: 1,
};

describe("proportions", () => {
  it("stacks a figure to the requested height", () => {
    const segs = layoutFigure(adult);
    assert.ok(Math.abs(statureOf(segs) - 1.75) < 0.015);
  });

  it("gives children a larger head share than adults", () => {
    const child = layoutFigure({ ...adult, age: 6, heightCm: 115, sex: 0.5 });
    const grown = layoutFigure(adult);
    const childShare = headLength(child) / statureOf(child);
    const adultShare = headLength(grown) / statureOf(grown);
    assert.ok(childShare > adultShare + 0.02, `${childShare} vs ${adultShare}`);
  });

  it("widens male shoulders relative to female at the same height", () => {
    const span = (sex: number) => {
      const segs = layoutFigure({ ...adult, sex });
      const left = segs.find((s) => s.name === "upperArm.L");
      const right = segs.find((s) => s.name === "upperArm.R");
      if (!left || !right) throw new Error("missing arms");
      return Math.abs(left.head.x - right.head.x);
    };
    assert.ok(span(1) > span(0));
  });

  it("puts the figure's right arm on -X", () => {
    const segs = layoutFigure(adult);
    const right = segs.find((s) => s.name === "upperArm.R");
    const left = segs.find((s) => s.name === "upperArm.L");
    if (!right || !left) throw new Error("missing arms");
    assert.ok(right.head.x < 0);
    assert.ok(left.head.x > 0);
  });

  it("gives each foot a heel and five jointed toes", () => {
    const segs = layoutFigure(adult);
    const foot = segs.find((s) => s.name === "foot.L");
    if (!foot) throw new Error("missing foot");
    const heel = footHeel(foot);
    if (!heel) throw new Error("missing heel");
    assert.ok(heel.center.z < foot.head.z, "heel sits behind the ankle");
    assert.ok(Math.abs(heel.center.y - heel.ry - (foot.tail.y - foot.rz1)) < 0.004, "heel sole meets the ball");
    assert.equal(segs.some((s) => s.name === "hallux3.L"), false);
    for (const side of ["L", "R"] as const) {
      let bones = 0;
      for (const digit of TOE_DIGITS) {
        for (let i = 1; i <= digit.bones; i++) {
          const seg = segs.find((s) => s.name === `${digit.name}${i}.${side}`);
          assert.ok(seg, `${digit.name}${i}.${side}`);
          assert.equal(seg.parent, i === 1 ? `foot.${side}` : `${digit.name}${i - 1}.${side}`);
          bones += 1;
        }
      }
      assert.equal(bones, 14);
    }
    const hallux = segs.find((s) => s.name === "hallux1.L")!;
    const fifth = segs.find((s) => s.name === "fifth1.L")!;
    const ankle = foot.head.x;
    assert.ok(Math.abs(hallux.head.x) < Math.abs(fifth.head.x), "big toe is medial");
    assert.ok(hallux.head.x < ankle && fifth.head.x > ankle);
    const tip = segs.find((s) => s.name === "hallux2.L")!;
    assert.ok(tip.tail.z > foot.tail.z);
    const second = segs.find((s) => s.name === "second1.L")!;
    const gap = second.head.x - hallux.head.x;
    assert.ok(gap > hallux.rx0 + second.rx0 * 0.35, `toes overlap too much (${gap})`);
    const limL = limitsFor("hallux1.L");
    const limR = limitsFor("hallux1.R");
    assert.deepEqual(limL?.x, limR?.x);
    assert.deepEqual(limL?.y, limR ? [-limR.y[1], -limR.y[0]] : null);
    assert.ok(limitsFor("second1.L")!.x[1] >= 48);
    const names = jointNames();
    assert.ok(names.includes("hallux2.L"));
    assert.ok(names.includes("fifth3.R"));
    assert.equal(new Set(names).size, names.length);
  });

  it("drops the toe bones for the original foot", () => {
    const segs = layoutFigure(adult, false);
    assert.equal(segs.some((s) => s.name.startsWith("hallux")), false);
    const foot = segs.find((s) => s.name === "foot.L");
    assert.equal(foot?.kind, "box");
    assert.equal(footHeel(foot!), null);
    const view = new FigureView(makeFigure(1, "adult-m"));
    assert.equal(view.bones.has("hallux1.L"), false);
    view.data.detailedFeet = true;
    view.rebuild(true);
    assert.equal(view.bones.has("hallux2.L"), true);
    assert.equal(view.bones.has("fifth3.R"), true);
    view.data.detailedFeet = false;
    view.rebuild(true);
    assert.equal(view.bones.has("hallux1.L"), false);
    assert.equal(view.bones.has("foot.L"), true);
    assert.equal(view.markers.has("hallux1.L"), false);
  });

  it("splits the torso into lower, mid, and chest", () => {
    const segs = layoutFigure(adult);
    const byName = new Map(segs.map((s) => [s.name, s]));
    const spine = byName.get("spine");
    const abdomen = byName.get("abdomen");
    const chest = byName.get("chest");
    const neck = byName.get("neck");
    if (!spine || !abdomen || !chest || !neck) throw new Error("missing torso");
    assert.equal(spine.parent, "hips");
    assert.equal(abdomen.parent, "spine");
    assert.equal(chest.parent, "abdomen");
    assert.equal(neck.parent, "chest");
    assert.ok(Math.abs(spine.tail.y - abdomen.head.y) < 1e-6);
    assert.ok(Math.abs(abdomen.tail.y - chest.head.y) < 1e-6);
    assert.ok(Math.abs(chest.tail.y - neck.head.y) < 1e-6);
    for (const seg of [spine, abdomen, chest]) {
      const len = seg.tail.y - seg.head.y;
      assert.ok(len > 0.08, `${seg.name} is too short (${len})`);
    }
    const order = jointNames();
    assert.equal(order.indexOf("abdomen"), order.indexOf("spine") + 1);
    assert.equal(order.indexOf("chest"), order.indexOf("abdomen") + 1);
  });
});

describe("projection and openpose sides", () => {
  it("projects a point in front of the camera to the center", () => {
    const cam = new PerspectiveCamera(90, 1, 0.1, 50);
    cam.position.set(0, 0, 5);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const px = projectToPixel(new Vector3(0, 0, 0), cam, 200, 200);
    assert.equal(px.behind, false);
    assert.ok(Math.abs(px.x - 100) < 1);
    assert.ok(Math.abs(px.y - 100) < 1);
  });

  it("puts the figure's right wrist on the image left when it faces the camera", () => {
    const view = new FigureView(makeFigure(1, "adult-m"));
    view.data.pose = {};
    view.updateSkeleton(false, null);
    const cam = new PerspectiveCamera(40, 1, 0.1, 40);
    cam.position.set(0, 1, 5);
    cam.lookAt(0, 1, 0);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const pose = view.samplePose(cam, 512, 512, false, new Raycaster());
    const rightWrist = pose.body[4];
    const leftWrist = pose.body[7];
    assert.equal(rightWrist.c, 1);
    assert.equal(leftWrist.c, 1);
    assert.ok(rightWrist.x < leftWrist.x, `right ${rightWrist.x} left ${leftWrist.x}`);
    assert.equal(pose.handL.length, 21);
    assert.equal(pose.handR.length, 21);
    assert.equal(pose.face.length, 68);
    view.dispose();
  });
});

describe("openpose json", () => {
  it("writes flat COCO-18 plus optional hands and face", () => {
    const zeros = (n: number) => Array.from({ length: n }, () => ({ x: 1, y: 2, c: 1 }));
    const person: PersonPose = { body: zeros(18), handL: zeros(21), handR: zeros(21), face: zeros(68) };
    const parsed = JSON.parse(openPoseJson([person], 768, 768, true)) as {
      version: number;
      canvas_width: number;
      canvas_height: number;
      people: {
        pose_keypoints_2d: number[];
        face_keypoints_2d: number[];
        hand_left_keypoints_2d: number[];
        hand_right_keypoints_2d: number[];
      }[];
    };
    assert.equal(parsed.version, 1.3);
    assert.equal(parsed.canvas_width, 768);
    assert.equal(parsed.canvas_height, 768);
    assert.equal(parsed.people[0].pose_keypoints_2d.length, 54);
    assert.equal(parsed.people[0].hand_left_keypoints_2d.length, 63);
    assert.equal(parsed.people[0].hand_right_keypoints_2d.length, 63);
    assert.equal(parsed.people[0].face_keypoints_2d.length, 204);
    assert.deepEqual(parsed.people[0].pose_keypoints_2d.slice(0, 3), [1, 2, 1]);
    assert.deepEqual(flattenKeys([], 2), [0, 0, 0, 0, 0, 0]);
  });
});

describe("resolution", () => {
  it("snaps to multiples of 8 and warns off the 64 grid", () => {
    const snapped = snapResolution(100, 100);
    assert.equal(snapped.width % 8, 0);
    assert.equal(snapped.height % 8, 0);
    assert.equal(snapped.snapped, true);
    assert.equal(snapResolution(512, 768).warn64, false);
    assert.equal(snapResolution(520, 512).warn64, true);
  });

  it("crops a square export out of a wide view without changing vertical fov", () => {
    const fit = exportCameraFit(1600, 900, 512, 512, 50);
    assert.equal(fit.fov, 50);
    assert.ok(fit.w < 1600);
    assert.ok(Math.abs(fit.h - 900) < 1);
  });
});

describe("serialization", () => {
  it("round-trips scene state through JSON", () => {
    const scene = defaultScene();
    const copy = clone(scene);
    assert.equal(copy.figures.length, 1);
    assert.equal(copy.figures[0].params.heightCm, scene.figures[0].params.heightCm);
    assert.equal(copy.figures[0].pose["upperArm.L"]?.z, scene.figures[0].pose["upperArm.L"]?.z);
  });

  it("mirrors limb euler signs", () => {
    const mirrored = mirrorPose({ "upperArm.L": { x: 1, y: 2, z: -72 } }, "L2R");
    assert.deepEqual(mirrored["upperArm.R"], { x: 1, y: -2, z: 72 });
  });

  it("round-trips a full joint-angle table", () => {
    const names = jointNames();
    assert.ok(names.includes("spine"));
    assert.ok(names.includes("abdomen"));
    assert.ok(names.includes("thumb3.R"));
    assert.equal(new Set(names).size, names.length);
    const pose = jointsToPose([{ name: "upperArm.L", x: 0, y: 1, z: -42 }]);
    const back = poseToJoints(pose);
    assert.deepEqual(
      back.find((j) => j.name === "upperArm.L"),
      { name: "upperArm.L", x: 0, y: 1, z: -42 },
    );
    assert.deepEqual(
      back.find((j) => j.name === "hips"),
      { name: "hips", x: 0, y: 0, z: 0 },
    );
  });

  it("lets the upper arm twist past 90 degrees", () => {
    const lim = limitsFor("upperArm.L");
    assert.ok(lim);
    assert.ok(lim.x[0] <= -160);
    assert.ok(lim.x[1] >= 160);
    const kept = nearestEuler({ x: 10, y: 170, z: 10 }, { x: 190, y: 10, z: 190 });
    assert.ok(Math.abs(kept.x - 190) < 1);
    assert.ok(Math.abs(kept.y - 10) < 1);
    assert.ok(Math.abs(kept.z - 190) < 1);
  });
});

describe("files", () => {
  it("encodes an 8-bit RGB png", () => {
    const png = encodePngRGB(8, 8, new Uint8Array(8 * 8 * 3).fill(10));
    assert.equal(png[0], 137);
    assert.equal(png[1], 80);
    assert.equal(String.fromCharCode(...png.subarray(12, 16)), "IHDR");
    assert.equal((png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19], 8);
  });

  it("maps linear mid-gray to a brighter sRGB byte", () => {
    const out = linearRgbToSrgb(new Uint8Array([0, 128, 255]));
    assert.equal(out[0], 0);
    assert.equal(out[2], 255);
    assert.ok(out[1] > 170 && out[1] < 200, String(out[1]));
  });

  it("stores a zip entry", () => {
    const zip = encodeZip([{ name: "openpose.png", data: new Uint8Array([1, 2, 3, 4]) }]);
    assert.equal(zip[0], 0x50);
    assert.equal(zip[1], 0x4b);
    const text = new TextDecoder().decode(zip);
    assert.ok(text.includes("openpose.png"));
  });
});

describe("ik", () => {
  it("reaches a target two segments away", () => {
    const solved = fabrik(
      [new Vector3(0, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 2, 0)],
      [1, 1],
      new Vector3(0, 0, 2),
      12,
    );
    assert.ok(solved[2].distanceTo(new Vector3(0, 0, 2)) < 0.05);
  });

  it("keeps bone lengths in a two-bone solve", () => {
    const elbow = solveElbow(new Vector3(0, 0, 0), new Vector3(1.2, 0.2, 0.4), 0.8, 0.7, new Vector3(0, 0, -1), new Vector3());
    const root = new Vector3(0, 0, 0);
    const target = new Vector3(1.2, 0.2, 0.4);
    const d1 = elbow.distanceTo(root);
    const d2 = elbow.distanceTo(target);
    assert.ok(Math.abs(d1 - 0.8) < 0.05, `upper ${d1}`);
    assert.ok(d2 < 0.75);
  });
});

describe("face", () => {
  it("has 68 landmarks", () => {
    assert.equal(faceLandmarks(0.22).length, 68);
  });

  it("keeps a neutral face on the rest landmarks and opens the jaw", () => {
    const rest = faceLandmarks(0.22);
    const neutral = shapedLandmarks(0.22, { jaw: 0, smile: 0, brow: 0, blink: 0, mouth: 1 });
    assert.equal(neutral.length, 68);
    assert.ok(Math.abs(neutral[8].y - rest[8].y) < 1e-6);
    const open = shapedLandmarks(0.22, { jaw: 1, smile: 0, brow: 0, blink: 0, mouth: 1 });
    assert.ok(open[8].y < rest[8].y);
    const shut = shapedLandmarks(0.22, { jaw: 0, smile: 0, brow: 0, blink: 1, mouth: 1 });
    const span = (pts: { y: number }[], a: number, b: number) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = a; i <= b; i++) {
        lo = Math.min(lo, pts[i].y);
        hi = Math.max(hi, pts[i].y);
      }
      return hi - lo;
    };
    assert.ok(span(shut, 36, 41) < span(rest, 36, 41));
  });

  it("covers every landmark with one group", () => {
    const seen = new Set<number>();
    for (const group of FACE_GROUPS) {
      assert.equal(group.names.length, group.to - group.from + 1);
      for (let i = group.from; i <= group.to; i++) {
        assert.equal(seen.has(i), false);
        seen.add(i);
      }
    }
    assert.equal(seen.size, 68);
  });

  it("moves neighbors unless the drag is isolated, and mirrors X", () => {
    const zeros = emptyFaceOffsets();
    const chin = applyFaceOffset(zeros, 8, { x: 0, y: -0.02, z: 0 }, { isolate: false, mirror: true });
    assert.ok(Math.abs(chin[8].y + 0.02) < 1e-6);
    assert.ok(chin[7].y < -0.005 && chin[7].y > chin[8].y);
    assert.ok(Math.abs(chin[0].y) < 1e-4);
    const alone = applyFaceOffset(zeros, 8, { x: 0, y: -0.02, z: 0 }, { isolate: true, mirror: false });
    assert.ok(Math.abs(alone[8].y + 0.02) < 1e-6);
    assert.ok(Math.abs(alone[7].y) < 1e-6);
    const partner = FACE_MIRROR[36];
    assert.ok(partner != null && partner !== 36);
    assert.equal(FACE_MIRROR[partner], 36);
    const eye = applyFaceOffset(zeros, 36, { x: 0.02, y: 0, z: 0 }, { isolate: true, mirror: true });
    assert.ok(Math.abs(eye[36].x - 0.02) < 1e-6);
    assert.ok(Math.abs(eye[partner].x + 0.02) < 1e-6);
    const weights = faceWeights(8, false);
    assert.equal(weights[8], 1);
    assert.ok(weights[7] < 1 && weights[7] > 0.4);
    assert.equal(weights[0], 0);
    const posed = posedLandmarks(0.22, { jaw: 0, smile: 0, brow: 0, blink: 0, mouth: 1 }, chin);
    assert.ok(posed[8].y < shapedLandmarks(0.22)[8].y - 0.01);
  });
});

describe("anima outline", () => {
  it("uses a 4px stroke at a 768 short side", () => {
    assert.equal(animaStrokePx(768, 1152), 4);
    assert.equal(animaStrokePx(1536, 1024), 5);
  });

  it("draws a complementary edge and keeps the interior", () => {
    const w = 12;
    const h = 12;
    const color = new Uint8Array(w * h * 3);
    const depth = new Uint8Array(w * h * 3);
    const mask = new Uint8Array(w * h * 3);
    for (let y = 2; y < 10; y++) {
      for (let x = 2; x < 10; x++) {
        const o = (y * w + x) * 3;
        color[o] = 200;
        color[o + 1] = 160;
        color[o + 2] = 80;
        depth[o] = depth[o + 1] = depth[o + 2] = x < 6 ? 200 : 40;
        mask[o] = 10;
        mask[o + 1] = 200;
        mask[o + 2] = 10;
      }
    }
    const out = animaOutline(color, depth, mask, w, h);
    const at = (x: number, y: number) => {
      const o = (y * w + x) * 3;
      return [out[o], out[o + 1], out[o + 2]];
    };
    assert.deepEqual(at(0, 0), [0, 0, 0]);
    assert.deepEqual(at(5, 5), [55, 95, 175]);
    assert.deepEqual(at(4, 6), [200, 160, 80]);
  });
});

describe("figure palette and placement", () => {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  /** Add figures the way the engine does: first free color, first free spot. */
  const addFigure = (figures: ReturnType<typeof makeFigure>[], id: number) => {
    const fig = makeFigure(id);
    fig.color = nextFreeColor(figures);
    fig.position = nextFreeSpot(figures);
    figures.push(fig);
    return fig;
  };

  it("has one distinct color per figure slot, the first four unchanged", () => {
    assert.equal(FIGURE_COLORS.length, MAX_FIGURES);
    assert.equal(new Set(FIGURE_COLORS.map((c) => c.toLowerCase())).size, FIGURE_COLORS.length);
    assert.deepEqual(FIGURE_COLORS.slice(0, 4), ["#3ecfb2", "#e0a045", "#d4654f", "#7aa2d4"]);
  });

  it("keeps every pair of colors far apart and every color far from the black mask background", () => {
    for (let i = 0; i < FIGURE_COLORS.length; i++) {
      const [r, g, b] = rgb(FIGURE_COLORS[i]);
      assert.ok(Math.hypot(r, g, b) > 150, `${FIGURE_COLORS[i]} is too close to black`);
      assert.ok(0.2126 * r + 0.7152 * g + 0.0722 * b > 80, `${FIGURE_COLORS[i]} is too dark`);
      for (let j = i + 1; j < FIGURE_COLORS.length; j++) {
        const a = rgb(FIGURE_COLORS[i]);
        const c = rgb(FIGURE_COLORS[j]);
        const d = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
        assert.ok(d >= 60, `${FIGURE_COLORS[i]} and ${FIGURE_COLORS[j]} are only ${d.toFixed(1)} apart`);
      }
    }
  });

  it("fills to the cap with no shared color or spot", () => {
    const figures = [makeFigure(1)];
    for (let id = 2; figures.length < MAX_FIGURES; id++) addFigure(figures, id);
    assert.equal(new Set(figures.map((f) => f.color)).size, MAX_FIGURES);
    assert.deepEqual(figures.map((f) => f.color), FIGURE_COLORS);
    for (let i = 0; i < figures.length; i++) {
      for (let j = i + 1; j < figures.length; j++) {
        const a = figures[i].position;
        const b = figures[j].position;
        assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= SPOT_RADIUS, `figures ${i + 1} and ${j + 1} share a spot`);
      }
    }
    assert.deepEqual(figures[4].position, { x: 3.6, y: 0, z: 0 });
    assert.ok(Math.abs(figures[5].position.z + 1.1) < 1e-9);
    assert.equal(figures[5].position.x, 0);
  });

  it("reuses a deleted figure's color and spot", () => {
    const figures = [makeFigure(1)];
    for (let id = 2; id <= 6; id++) addFigure(figures, id);
    const gone = figures.splice(2, 1)[0];
    const fresh = addFigure(figures, 7);
    assert.equal(fresh.color, gone.color);
    assert.deepEqual(fresh.position, gone.position);
  });

  it("treats a figure within half a meter as occupying a spot", () => {
    const fig = makeFigure(1);
    fig.position = { x: 0.3, y: 0, z: 0.2 };
    assert.deepEqual(nextFreeSpot([fig]), { x: 0.9, y: 0, z: 0 });
    fig.position = { x: 0.6, y: 0, z: 0 };
    assert.deepEqual(nextFreeSpot([fig]), { x: 0, y: 0, z: 0 });
  });

  it("keeps the next id above every id in the scene", () => {
    assert.equal(nextFigureId([{ id: "f1" }, { id: "f7" }, { id: "f3" }], 2), 8);
    assert.equal(nextFigureId([{ id: "f1" }], 12), 12);
    assert.equal(nextFigureId([{ id: "custom" }], 1), 1);
  });

  it("falls back to the first figure when the saved selection is gone", () => {
    const figures = [{ id: "f2" }, { id: "f5" }];
    assert.deepEqual(validSelection({ figureId: "f9", bone: "head" }, figures), { figureId: "f2", bone: null });
    assert.equal(validSelection({ figureId: "f5", bone: "head" }, figures).figureId, "f5");
    assert.deepEqual(validSelection(undefined, []), { figureId: null, bone: null });
  });
});

describe("solo, lock and shortcuts", () => {
  it("solo keeps only the chosen figure visible and detects the solo state", () => {
    const figures = [makeFigure(1), makeFigure(2), makeFigure(3)];
    assert.deepEqual(soloVisibility(figures, "f2"), [false, true, false]);
    assert.equal(isSoloed(figures, "f2"), false);
    figures.forEach((f, i) => {
      f.visible = soloVisibility(figures, "f2")[i];
    });
    assert.equal(isSoloed(figures, "f2"), true);
    assert.equal(isSoloed(figures, "f1"), false);
    assert.equal(isSoloed([makeFigure(1)], "f1"), false);
  });

  it("does not let the viewport pick hidden or locked figures", () => {
    const fig = makeFigure(1);
    assert.equal(isPickable(fig), true);
    fig.locked = true;
    assert.equal(isPickable(fig), false);
    fig.locked = false;
    fig.visible = false;
    assert.equal(isPickable(fig), false);
  });

  it("loads a figure saved before lock existed as unlocked and keeps its visibility", () => {
    const old = clone(makeFigure(1)) as Partial<ReturnType<typeof makeFigure>>;
    delete old.locked;
    old.visible = false;
    const fig = normalizeFigure(old as ReturnType<typeof makeFigure>);
    assert.equal(fig.locked, false);
    assert.equal(fig.visible, false);
    assert.equal(normalizeFigure({ ...makeFigure(2), locked: true }).locked, true);
  });

  it("exports all on Shift+E in orbit mode only", () => {
    const k = (key: string, shiftKey: boolean, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
      key,
      shiftKey,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...extra,
    });
    assert.equal(isExportAllKey(k("E", true), "orbit"), true);
    assert.equal(isExportAllKey(k("e", false), "orbit"), false);
    assert.equal(isExportAllKey(k("E", true), "fly"), false);
    assert.equal(isExportAllKey(k("E", true, { ctrlKey: true }), "orbit"), false);
  });
});

describe("MiniMax H3 Image", () => {
  const pt = (x: number, y = 100, behind = false) => ({ x, y, behind });

  it("names every palette color in palette order", () => {
    assert.deepEqual(FIGURE_COLOR_NAMES, [
      "teal",
      "amber",
      "coral",
      "sky blue",
      "purple",
      "lime green",
      "pink",
      "royal blue",
      "yellow",
      "brown",
    ]);
    assert.equal(colorName("#3ECFB2"), "teal");
    assert.equal(colorName("#8a5a3c"), "brown");
    assert.equal(colorName("#123456"), null);
  });

  it("tints clay by figure color unless turned off", () => {
    assert.equal(defaultExport().clayTint, true);
  });

  it("offers the H3 presets on the 32 px grid", () => {
    const want = ["2048x2048", "1536x2048", "2048x1536", "1152x2048", "2048x1152", "3136x1344"];
    const h3 = RESOLUTIONS.filter((r) => r.group).map((r) => `${r.width}x${r.height}`);
    assert.deepEqual(h3, want);
    for (const r of RESOLUTIONS.filter((x) => x.group)) {
      assert.equal(r.width % 32, 0);
      assert.equal(r.height % 32, 0);
      assert.deepEqual(snapResolution(r.width, r.height), { width: r.width, height: r.height, snapped: false, warn64: false });
    }
    assert.ok(RESOLUTIONS.some((r) => r.id === "768" && !r.group), "existing presets stay");
  });

  it("writes English ordinals", () => {
    assert.deepEqual([1, 2, 3, 4, 10, 11, 12, 13, 21, 22, 23].map(ordinal), [
      "1st",
      "2nd",
      "3rd",
      "4th",
      "10th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
    ]);
  });

  it("orders figures left to right by where they appear in the frame", () => {
    const order = orderLeftToRight(
      [
        { item: "right", points: [pt(600), pt(640)] },
        { item: "left", points: [pt(50), pt(90)] },
        { item: "middle", points: [pt(300), pt(340)] },
      ],
      768,
      768,
    );
    assert.deepEqual(order, ["left", "middle", "right"]);
  });

  it("uses only the in-frame part of a figure and drops figures not in the picture", () => {
    const order = orderLeftToRight(
      [
        // Mostly off the left edge; the visible part sits at x 20.
        { item: "edge", points: [pt(-900), pt(-800), pt(20)] },
        { item: "inside", points: [pt(10), pt(30)] },
        { item: "behind", points: [pt(100, 100, true)] },
        { item: "outside", points: [pt(2000), pt(-5, 900)] },
      ],
      768,
      768,
    );
    assert.deepEqual(order, ["edge", "inside"]);
    assert.deepEqual(orderLeftToRight([{ item: "a", points: [pt(5)] }, { item: "b", points: [pt(5)] }], 10, 200), ["a", "b"]);
  });

  it("suggests the largest 32-grid size within 16,777,216 pixels that keeps the aspect", () => {
    assert.deepEqual(suggestH3Size(768, 768), { width: 4096, height: 4096 });
    assert.deepEqual(suggestH3Size(2048, 2048), { width: 4096, height: 4096 });
    // The ComfyUI table lists 3552 × 4736 for 3:4, but that is 16,822,272 pixels, over the cap.
    assert.deepEqual(suggestH3Size(1536, 2048), { width: 3520, height: 4704 });
    assert.deepEqual(suggestH3Size(2048, 1536), { width: 4704, height: 3520 });
    for (const [w, h] of [
      [3136, 1344],
      [1152, 2048],
      [832, 1216],
      [512, 768],
      [1000, 333],
    ]) {
      const s = suggestH3Size(w, h);
      assert.equal(s.width % 32, 0);
      assert.equal(s.height % 32, 0);
      assert.ok(s.width * s.height <= H3_MAX_AREA, `${w}x${h} -> ${s.width}x${s.height}`);
      // Within half a grid step of the true aspect on the short edge.
      const err = Math.abs(s.width / s.height - w / h) / (w / h);
      assert.ok(err <= 16 / Math.min(s.width, s.height) + 1e-9, `${w}x${h} -> ${s.width}x${s.height} err ${err}`);
      // Nothing larger on the grid keeps the aspect at least as well.
      for (let ww = s.width; ww <= s.width + 256; ww += 32) {
        const hh = Math.round(ww / (w / h) / 32) * 32;
        if (ww * hh > s.width * s.height) assert.ok(ww * hh > H3_MAX_AREA, `${ww}x${hh} also fits`);
      }
    }
    assert.deepEqual(suggestH3Size(3136, 1344), { width: 6240, height: 2688 });
  });

  it("builds the prompt with one line per figure and the suggested size", () => {
    const text = buildH3Prompt([{ color: "teal" }, { color: "amber" }], { width: 4096, height: 4096 });
    assert.deepEqual(text.split("\n"), [
      H3_PROMPT.intro,
      "The teal figure (1st from the left) is the person in <Picture 2>.",
      "The amber figure (2nd from the left) is the person in <Picture 3>.",
      "Suggested output size: 4096 × 4096",
    ]);
  });

  it("leaves the color word out when tint is off", () => {
    const text = buildH3Prompt([{ color: null }, { color: null }, { color: null }], { width: 4736, height: 3552 });
    const lines = text.split("\n");
    assert.equal(lines[1], "The figure (1st from the left) is the person in <Picture 2>.");
    assert.equal(lines[3], "The figure (3rd from the left) is the person in <Picture 4>.");
    assert.equal(lines[4], "Suggested output size: 4736 × 3552");
  });
});

describe("gizmo targets", () => {
  it("tells the head bone apart from the head IK helper that shares its name", () => {
    const view = new FigureView(makeFigure(1));
    const bone = view.bones.get("head");
    const helper = view.targets.get("head");
    assert.ok(bone && helper);
    assert.equal(bone.name, helper.name);
    assert.equal(view.ikTargetOf(bone), null);
    assert.equal(view.ikTargetOf(helper), "head");
    const pelvis = view.targets.get("pelvis");
    assert.ok(pelvis);
    assert.equal(view.ikTargetOf(pelvis), "pelvis");
    view.dispose();
  });
});
