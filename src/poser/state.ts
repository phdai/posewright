import { NEUTRAL_FACE, clampFace, clampFaceOffsets, emptyFaceOffsets } from "./face.ts";
import { v3, type BodyParams, type ExportSettings, type FigureData, type SceneState, type Vec3 } from "./types.ts";
import { clampParams } from "./proportions.ts";
import { poseById, writeHand, type Pose } from "./pose.ts";

/** Most figures a scene holds. Every cap in the engine and the UI reads this. */
export const MAX_FIGURES = 10;

/**
 * Figure colors, used for masks, colored wires and the viewport. The first four
 * were the whole palette before ten figures, so older scenes export the same masks.
 */
export const FIGURE_COLORS = [
  "#3ecfb2",
  "#e0a045",
  "#d4654f",
  "#7aa2d4",
  "#a66bd9",
  "#8fc04a",
  "#e87fc0",
  "#4b55d6",
  "#f0e25a",
  "#8a5a3c",
];

/** Plain-English name for each palette color, in palette order. Prompts use these to name a figure. */
export const FIGURE_COLOR_NAMES = [
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
];

/** Name of a palette color, or null for a color outside the palette (an edited scene file, say). */
export function colorName(hex: string): string | null {
  const i = FIGURE_COLORS.indexOf(hex.toLowerCase());
  return i < 0 ? null : (FIGURE_COLOR_NAMES[i] ?? null);
}

/** First palette color no figure is using. Falls back to cycling when every color is taken. */
export function nextFreeColor(figures: { color: string }[]): string {
  const used = new Set(figures.map((f) => f.color.toLowerCase()));
  return FIGURE_COLORS.find((c) => !used.has(c)) ?? FIGURE_COLORS[figures.length % FIGURE_COLORS.length];
}

/** Spots for new figures: rows of five, 0.9 m apart in X, each later row 1.1 m further back. */
export const SPOT_COLUMNS = 5;
export const SPOT_STEP_X = 0.9;
export const SPOT_STEP_Z = 1.1;
/** A spot is taken when a figure stands within this distance of it on the ground. */
export const SPOT_RADIUS = 0.5;

export function spotPosition(index: number): Vec3 {
  const col = index % SPOT_COLUMNS;
  const row = Math.floor(index / SPOT_COLUMNS);
  return v3(col * SPOT_STEP_X, 0, row === 0 ? 0 : -row * SPOT_STEP_Z);
}

/** First spot with no figure standing within SPOT_RADIUS, measured on the ground plane. */
export function nextFreeSpot(figures: { position: Vec3 }[]): Vec3 {
  for (let i = 0; i < 1000; i++) {
    const spot = spotPosition(i);
    const taken = figures.some((f) => Math.hypot(f.position.x - spot.x, f.position.z - spot.z) < SPOT_RADIUS);
    if (!taken) return spot;
  }
  return spotPosition(figures.length);
}

/** Next numeric figure id, kept above every `fN` id in the scene so a new figure never reuses one. */
export function nextFigureId(figures: { id: string }[], current: number): number {
  let max = 0;
  for (const f of figures) {
    const m = /^f(\d+)$/.exec(f.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Math.max(current, max + 1);
}

/** Keep a saved selection only when it points at a figure in the scene. Otherwise select the first one. */
export function validSelection(
  selection: SceneState["selection"] | undefined,
  figures: { id: string }[],
): SceneState["selection"] {
  if (selection && selection.figureId && figures.some((f) => f.id === selection.figureId)) {
    return { figureId: selection.figureId, bone: selection.bone ?? null, facePoint: selection.facePoint ?? null };
  }
  return { figureId: figures[0]?.id ?? null, bone: null };
}

export const BODY_PRESETS: { id: string; name: string; params: BodyParams }[] = [
  {
    id: "adult-f",
    name: "Adult female average",
    params: { sex: 0.05, age: 30, heightCm: 163, mass: 0.42, muscle: 0.28, shoulder: 1, hip: 1.02, torso: 1, leg: 1 },
  },
  {
    id: "adult-m",
    name: "Adult male muscular",
    params: { sex: 1, age: 28, heightCm: 181, mass: 0.55, muscle: 0.88, shoulder: 1.12, hip: 0.96, torso: 1.02, leg: 1 },
  },
  {
    id: "child",
    name: "Child 6y",
    params: { sex: 0.5, age: 6, heightCm: 115, mass: 0.38, muscle: 0.18, shoulder: 0.98, hip: 1, torso: 1, leg: 0.98 },
  },
  {
    id: "teen",
    name: "Teen male slim",
    params: { sex: 0.85, age: 15, heightCm: 170, mass: 0.22, muscle: 0.32, shoulder: 0.96, hip: 0.94, torso: 1, leg: 1.05 },
  },
  {
    id: "elder-f",
    name: "Elderly female",
    params: { sex: 0.08, age: 78, heightCm: 156, mass: 0.5, muscle: 0.12, shoulder: 0.94, hip: 1.06, torso: 0.96, leg: 0.97 },
  },
  {
    id: "heavy-m",
    name: "Heavy adult male",
    params: { sex: 0.92, age: 45, heightCm: 178, mass: 0.94, muscle: 0.34, shoulder: 1.06, hip: 1.1, torso: 1.05, leg: 0.98 },
  },
];

const ZERO_TARGETS = {
  handL: v3(),
  handR: v3(),
  footL: v3(),
  footR: v3(),
  head: v3(),
  pelvis: v3(),
};

export function defaultExport(): ExportSettings {
  return {
    preset: "768",
    width: 768,
    height: 768,
    includeHandsFace: false,
    hideOccluded: false,
    wireThickness: 1.35,
    wireInvert: false,
    wireColored: false,
    wireXray: false,
    wireAA: false,
    depthAuto: true,
    overlay: "off",
    clayTint: true,
  };
}

export function makeFigure(index: number, presetId = "adult-f"): FigureData {
  const preset = BODY_PRESETS.find((p) => p.id === presetId) ?? BODY_PRESETS[0];
  const pose: Pose = { ...(poseById("stand") ?? {}) };
  writeHand(pose, "L", "relaxed");
  writeHand(pose, "R", "relaxed");
  return {
    id: `f${index}`,
    name: `Figure ${index}`,
    color: FIGURE_COLORS[(index - 1) % FIGURE_COLORS.length],
    visible: true,
    locked: false,
    params: clampParams({ ...preset.params }),
    position: v3((index - 1) * 0.85 - 0, 0, 0),
    rotationY: 0,
    scale: 1,
    pose,
    ik: false,
    ikTargets: { ...ZERO_TARGETS, handL: v3(), handR: v3(), footL: v3(), footR: v3(), head: v3(), pelvis: v3() },
    pelvisOffset: v3(),
    detailedFeet: false,
    detailedHead: false,
    face: { ...NEUTRAL_FACE },
    faceOffsets: emptyFaceOffsets(),
    faceMirror: true,
  };
}

/**
 * Fill fields that older scene files and undo snapshots may lack. Scenes saved
 * before a field existed must still load, so every new figure field gets a default here.
 */
export function normalizeFigure(fig: FigureData): FigureData {
  fig.visible = fig.visible !== false;
  fig.locked = fig.locked === true;
  fig.detailedFeet = fig.detailedFeet === true;
  fig.detailedHead = fig.detailedHead === true;
  fig.face = clampFace(fig.face);
  fig.faceOffsets = clampFaceOffsets(fig.faceOffsets);
  if (typeof fig.faceMirror !== "boolean") fig.faceMirror = true;
  return fig;
}

/** Visibility flags for "Solo": only the chosen figure stays visible. */
export function soloVisibility(figures: { id: string }[], id: string): boolean[] {
  return figures.map((f) => f.id === id);
}

/** True when the figure is the only visible one in a scene of more than one figure. */
export function isSoloed(figures: { id: string; visible: boolean }[], id: string): boolean {
  if (figures.length < 2) return false;
  return figures.every((f) => f.visible === (f.id === id));
}

/** The viewport may pick, hover or drag a figure only when it is shown and not locked. */
export function isPickable(fig: { visible: boolean; locked?: boolean }): boolean {
  return fig.visible && fig.locked !== true;
}

/** Export all is Shift+E in orbit mode. Plain E does nothing there; in fly mode E climbs. */
export function isExportAllKey(
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  mode: "orbit" | "fly",
): boolean {
  return mode === "orbit" && e.key.toLowerCase() === "e" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export function defaultScene(): SceneState {
  return {
    figures: [makeFigure(1, "adult-f")],
    selection: { figureId: "f1", bone: null },
    tool: "rotate",
    jointLimits: true,
    showJoints: true,
    showBody: true,
    showGrid: true,
    export: defaultExport(),
    warning: "",
  };
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
