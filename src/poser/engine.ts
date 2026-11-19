import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  LinearSRGBColorSpace,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  Matrix4,
  WebGLRenderer,
  WebGLRenderTarget,
  type Object3D,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { createDepthMaterial, FigureView } from "./figure.ts";
import { FACE_PRESETS, applyFaceOffset, clampFace, clampFaceOffsets } from "./face.ts";
import { bodyCoverage, drawOpenPose, openPoseJson, type PersonPose } from "./openpose.ts";
import { mirrorPose, poseById, writeHand, writeToes, composedEuler, clampEuler, jointNames, jointsToPose, poseToJoints, type Pose } from "./pose.ts";
import { canvasToRgb, linearRgbToSrgb, pngBlob, rgbaToRgb } from "./png.ts";
import { animaOutline } from "./outline.ts";
import { exportCameraFit, snapResolution } from "./resolution.ts";
import { clampParams, headLength } from "./proportions.ts";
import {
  BODY_PRESETS,
  MAX_FIGURES,
  clone,
  defaultScene,
  downloadBlob,
  isExportAllKey,
  isPickable,
  makeFigure,
  normalizeFigure,
  nextFigureId,
  nextFreeColor,
  nextFreeSpot,
  soloVisibility,
  stamp,
  validSelection,
} from "./state.ts";
import type { BodyParams, CameraMode, FaceShape, FigureData, GizmoTool, HandPreset, SceneState, ToePreset, Vec3 } from "./types.ts";
import { zipBlob, type ZipItem } from "./zip.ts";

/** Offscreen targets are linear, so keep the sRGB byte values we want in the PNG. */
function pngColor(hex: string): Color {
  const srgb = new Color();
  new Color(hex).getRGB(srgb, SRGBColorSpace);
  return new Color().setRGB(srgb.r, srgb.g, srgb.b, LinearSRGBColorSpace);
}

type ExportKind = "openpose" | "wire" | "depth" | "normal" | "mask" | "openpose-figure" | "mask-figure" | "model" | "model-outline";

const IK_BONE: Record<string, string> = {
  "hand.L": "handL",
  "hand.R": "handR",
  "foot.L": "footL",
  "foot.R": "footR",
  head: "head",
  hips: "pelvis",
};

const DRIVEN = new Set([
  "spine",
  "abdomen",
  "chest",
  "neck",
  "upperArm.L",
  "upperArm.R",
  "lowerArm.L",
  "lowerArm.R",
  "upperLeg.L",
  "upperLeg.R",
  "lowerLeg.L",
  "lowerLeg.R",
]);

function nudgeFromCode(code: string): { axis: "x" | "y" | "z"; sign: number } | null {
  switch (code) {
    case "ArrowUp":
    case "Numpad8":
      return { axis: "x", sign: 1 };
    case "ArrowDown":
    case "Numpad2":
      return { axis: "x", sign: -1 };
    case "ArrowRight":
    case "Numpad6":
      return { axis: "y", sign: 1 };
    case "ArrowLeft":
    case "Numpad4":
      return { axis: "y", sign: -1 };
    case "Comma":
    case "Numpad1":
      return { axis: "z", sign: -1 };
    case "Period":
    case "Numpad3":
      return { axis: "z", sign: 1 };
    default:
      return null;
  }
}

type Snap = { v: number; state: SceneState };

function poseFromFile(data: { pose?: Pose; joints?: { name: string; x: number; y: number; z: number }[] }): Pose | null {
  if (Array.isArray(data.joints) && data.joints.length) return jointsToPose(data.joints);
  if (data.pose && typeof data.pose === "object") return data.pose;
  return null;
}

export class PoserEngine {
  readonly state: SceneState;
  private snapshot: Snap;
  private listeners = new Set<() => void>();
  private views: FigureView[] = [];
  private nextId: number;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private renderer: WebGLRenderer;
  private exporter: WebGLRenderer;
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private grid: GridHelper;
  private ground: Mesh;
  private helpers: Object3D[] = [];
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private keys = new Set<string>();
  private fly = { yaw: 0, pitch: -0.12, speed: 0 };
  private host: HTMLElement;
  private overlay: HTMLCanvasElement;
  private crop: HTMLDivElement;
  private hint: HTMLDivElement;
  private resizeObserver: ResizeObserver;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private raf = 0;
  private last = performance.now();
  private skipBone: string | null = null;
  private suppressPick = false;
  private depthMat = createDepthMaterial();
  private preview: {
    pose?: HTMLCanvasElement;
    wire?: HTMLCanvasElement;
    depth?: HTMLCanvasElement;
    normal?: HTMLCanvasElement;
    mask?: HTMLCanvasElement;
    model?: HTMLCanvasElement;
    align?: HTMLCanvasElement;
  } = {};
  private previewTimer = 0;
  /** When false the preview strip keeps its last frame. Downloads and Export all never read it. */
  private livePreviews = readLivePreviews();
  private previewRunning = false;
  private previewQueued = false;
  private disposed = false;
  private cameraDirty = false;
  private depthScratch = new Vector3();
  /** Close-up face editor. Shows landmarks even when the figure's head is simple. */
  private faceEdit = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.state = defaultScene();
    this.nextId = this.state.figures.length + 1;
    this.snapshot = { v: 1, state: this.state };

    this.scene.background = new Color("#14181d");
    this.camera = new PerspectiveCamera(50, 1, 0.05, 80);
    this.camera.position.set(1.55, 1.22, 3.15);

    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.domElement.className = "block h-full w-full";
    this.renderer.domElement.style.touchAction = "none";
    host.appendChild(this.renderer.domElement);

    this.exporter = new WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: false });
    this.exporter.outputColorSpace = LinearSRGBColorSpace;
    this.exporter.setPixelRatio(1);
    this.exporter.toneMapping = 0;

    this.overlay = document.createElement("canvas");
    this.overlay.className = "pointer-events-none absolute inset-0 h-full w-full";
    host.appendChild(this.overlay);
    this.crop = document.createElement("div");
    this.crop.className = "pointer-events-none absolute border border-accent";
    this.crop.style.boxShadow = "0 0 0 9999px rgba(8, 10, 12, 0.45)";
    host.appendChild(this.crop);
    this.hint = document.createElement("div");
    this.hint.className =
      "pointer-events-none absolute left-3 top-3 rounded-sm bg-surface/80 px-2 py-1 text-xs text-muted";
    host.appendChild(this.hint);

    const hemi = new HemisphereLight("#d5e2ea", "#3a342c", 0.85);
    const sun = new DirectionalLight("#fff6ea", 1.35);
    sun.position.set(2.4, 4.2, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 0.2;
    sun.shadow.camera.far = 18;
    sun.shadow.camera.left = -6;
    sun.shadow.camera.right = 6;
    sun.shadow.camera.top = 6;
    sun.shadow.camera.bottom = -6;
    this.scene.add(hemi, sun);

    this.ground = new Mesh(
      new CircleGeometry(16, 64),
      new MeshStandardMaterial({ color: "#1a1f24", roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.grid = new GridHelper(10, 20, 0x44515c, 0x2c343c);
    this.grid.position.y = 0.001;
    this.scene.add(this.grid);
    this.helpers.push(this.ground, this.grid);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0.95, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 0.3;
    this.orbit.maxDistance = 30;
    this.orbit.update();
    this.orbit.addEventListener("change", () => {
      this.cameraDirty = true;
    });

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.scene.add(this.gizmo.getHelper());
    this.helpers.push(this.gizmo.getHelper());
    this.gizmo.addEventListener("dragging-changed", (event) => {
      const dragging = (event as { value: boolean }).value;
      this.orbit.enabled = !dragging && this.mode === "orbit";
      if (dragging) this.pushHistory();
      else this.finishDrag();
    });
    this.gizmo.addEventListener("mouseDown", () => {
      this.suppressPick = true;
    });
    this.gizmo.addEventListener("objectChange", () => this.onGizmo());

    for (const fig of this.state.figures) this.attachView(fig, true);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("click", () => {
      if (this.mode === "fly") canvas.requestPointerLock();
    });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("pointerlockchange", this.onLock);
    window.addEventListener("blur", this.clearKeys);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.syncGizmo();
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
    this.expose();
    this.emit();
  }

  private mode: CameraMode = "orbit";

  getSnapshot(): Snap {
    return this.snapshot;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.snapshot = { v: this.snapshot.v + 1, state: this.state };
    for (const fn of this.listeners) fn();
    this.schedulePreview();
  }

  private touch() {
    this.syncGizmo();
    this.emit();
  }

  pushHistory() {
    this.undoStack.push(JSON.stringify(this.historyBlob()));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.historyBlob()));
    this.restore(prev);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.historyBlob()));
    this.restore(next);
  }

  private historyBlob() {
    return {
      figures: this.state.figures,
      selection: this.state.selection,
      jointLimits: this.state.jointLimits,
    };
  }

  private restore(json: string) {
    const data = JSON.parse(json) as ReturnType<PoserEngine["historyBlob"]>;
    this.state.figures = data.figures;
    this.state.selection = data.selection;
    this.state.jointLimits = data.jointLimits;
    for (const fig of this.state.figures) this.normalizeFigure(fig);
    const live = new Map(this.views.map((v) => [v.data.id, v]));
    const next: FigureView[] = [];
    for (const fig of this.state.figures) {
      let view = live.get(fig.id);
      if (!view) view = this.attachView(fig, false);
      else {
        view.data = fig;
        view.rebuild(true);
      }
      live.delete(fig.id);
      next.push(view);
    }
    for (const stale of live.values()) stale.dispose();
    this.views = next;
    this.nextId = nextFigureId(this.state.figures, this.nextId);
    this.touch();
  }

  private attachView(fig: FigureData, capture: boolean): FigureView {
    const view = new FigureView(fig);
    this.scene.add(view.group);
    this.views.push(view);
    view.updateSkeleton(this.state.jointLimits, null);
    if (capture) view.captureTargets();
    return view;
  }

  private selected(): FigureView | undefined {
    return this.views.find((v) => v.data.id === this.state.selection.figureId);
  }

  addFigure(presetId = "adult-f") {
    if (this.state.figures.length >= MAX_FIGURES) return;
    this.pushHistory();
    const fig = makeFigure(this.nextId++, presetId);
    fig.color = nextFreeColor(this.state.figures);
    fig.position = nextFreeSpot(this.state.figures);
    this.state.figures.push(fig);
    this.state.selection = { figureId: fig.id, bone: null };
    this.attachView(fig, true);
    this.touch();
  }

  deleteSelected() {
    const id = this.state.selection.figureId;
    if (!id) return;
    this.pushHistory();
    this.state.figures = this.state.figures.filter((f) => f.id !== id);
    const view = this.views.find((v) => v.data.id === id);
    view?.dispose();
    this.views = this.views.filter((v) => v.data.id !== id);
    this.state.selection = {
      figureId: this.state.figures[0]?.id ?? null,
      bone: null,
    };
    this.touch();
  }

  duplicateSelected() {
    const src = this.selected();
    if (!src || this.state.figures.length >= MAX_FIGURES) return;
    this.pushHistory();
    const fig = clone(src.data);
    fig.id = `f${this.nextId++}`;
    fig.name = `${src.data.name} copy`;
    fig.position = { ...src.data.position, x: src.data.position.x + 0.55 };
    fig.color = nextFreeColor(this.state.figures);
    this.state.figures.push(fig);
    this.state.selection = { figureId: fig.id, bone: null };
    this.attachView(fig, false);
    this.touch();
  }

  selectFigure(id: string) {
    this.state.selection = { figureId: id, bone: null };
    this.touch();
  }

  rename(id: string, name: string) {
    const fig = this.state.figures.find((f) => f.id === id);
    if (!fig) return;
    fig.name = name.slice(0, 40);
    this.emit();
  }

  setVisible(id: string, visible: boolean) {
    const fig = this.state.figures.find((f) => f.id === id);
    if (!fig) return;
    this.pushHistory();
    fig.visible = visible;
    this.emit();
  }

  /** Show this figure and hide the rest. Uses the visible flag, so one undo brings the others back. */
  soloFigure(id: string) {
    if (!this.state.figures.some((f) => f.id === id)) return;
    const next = soloVisibility(this.state.figures, id);
    if (this.state.figures.every((f, i) => f.visible === next[i])) return;
    this.pushHistory();
    this.state.figures.forEach((f, i) => {
      f.visible = next[i];
    });
    this.touch();
  }

  showAll() {
    if (this.state.figures.every((f) => f.visible)) return;
    this.pushHistory();
    for (const f of this.state.figures) f.visible = true;
    this.touch();
  }

  setLocked(id: string, locked: boolean) {
    const fig = this.state.figures.find((f) => f.id === id);
    if (!fig || fig.locked === locked) return;
    this.pushHistory();
    fig.locked = locked;
    if (locked) {
      this.hoverBone = null;
      this.hoverFace = null;
    }
    this.touch();
  }

  setParams(id: string, patch: Partial<BodyParams>) {
    const fig = this.state.figures.find((f) => f.id === id);
    if (!fig) return;
    fig.params = clampParams({ ...fig.params, ...patch });
    const view = this.views.find((v) => v.data.id === id);
    view?.rebuild();
    this.emit();
  }

  setDetailedFeet(id: string, on: boolean) {
    const view = this.views.find((v) => v.data.id === id);
    if (!view || view.data.detailedFeet === on) return;
    this.pushHistory();
    view.data.detailedFeet = on;
    view.rebuild(true);
    if (this.state.selection.figureId === id && this.state.selection.bone && !view.bones.has(this.state.selection.bone)) {
      this.state.selection.bone = null;
    }
    view.updateSkeleton(this.state.jointLimits, null);
    this.touch();
  }

  setFace(id: string, patch: Partial<FaceShape>) {
    const fig = this.state.figures.find((f) => f.id === id);
    if (!fig) return;
    fig.face = clampFace({ ...clampFace(fig.face), ...patch });
    this.emit();
  }

  applyFacePreset(id: string, presetId: string) {
    const preset = FACE_PRESETS.find((p) => p.id === presetId);
    const fig = this.state.figures.find((f) => f.id === id);
    if (!preset || !fig) return;
    this.pushHistory();
    fig.face = { ...preset.face };
    this.emit();
  }

  setDetailedHead(id: string, on: boolean) {
    const fig = this.state.figures.find((f) => f.id === id);
    if (!fig || fig.detailedHead === on) return;
    this.pushHistory();
    fig.detailedHead = on;
    this.emit();
  }

  selectFacePoint(figureId: string, index: number | null) {
    this.state.selection = { figureId, bone: null, facePoint: index };
    this.touch();
  }

  setFaceMirror(id: string, on: boolean) {
    const fig = this.state.figures.find((f) => f.id === id);
    if (!fig || fig.faceMirror === on) return;
    this.pushHistory();
    fig.faceMirror = on;
    this.emit();
  }

  resetFaceOffsets(id: string) {
    const fig = this.state.figures.find((f) => f.id === id);
    if (!fig) return;
    this.pushHistory();
    fig.faceOffsets = clampFaceOffsets(null);
    this.emit();
  }

  private normalizeFigure(fig: FigureData) {
    normalizeFigure(fig);
  }

  /**
   * Face tab. Frames the selected head from the front when opening, or when
   * the selected figure changes while the tab is already open.
   */
  setFaceEdit(on: boolean, frame = false) {
    const changed = this.faceEdit !== on;
    this.faceEdit = on;
    if (!on) {
      this.faceDrag = null;
      this.hoverFace = null;
      if (this.mode === "orbit") this.orbit.enabled = true;
    }
    if (on && (changed || frame)) this.frameHead();
    if (!on && changed && this.mode === "orbit") {
      this.hint.textContent = "Orbit · left drag look · right drag pan · scroll zoom";
    }
    this.syncGizmo();
    if (changed) this.emit();
  }

  private frameHead() {
    const view = this.selected();
    const head = view?.bones.get("head");
    if (!view || !head) return;
    const center = new Vector3();
    head.getWorldPosition(center);
    const len = Math.max(0.12, headLength(view.segments) * view.data.scale);
    center.y += len * 0.42;
    const front = new Vector3(0, 0, 1).applyQuaternion(view.group.quaternion);
    const dist = Math.max(0.28, len * 2.6);
    this.mode = "orbit";
    this.orbit.enabled = true;
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(front, dist);
    this.orbit.update();
    this.syncFlyFromCamera();
    this.hint.textContent = "Face · drag a point · arrows nudge · Alt one point · Shift in/out";
    this.cameraDirty = true;
  }

  /** Joints that exist on this figure. Simple feet omit the toe bones. */
  rigNames(id: string): string[] {
    const view = this.views.find((v) => v.data.id === id);
    if (!view) return [];
    return jointNames().filter((name) => view.bones.has(name));
  }

  applyBodyPreset(id: string, presetId: string) {
    const preset = BODY_PRESETS.find((p) => p.id === presetId);
    const fig = this.state.figures.find((f) => f.id === id);
    if (!preset || !fig) return;
    this.pushHistory();
    fig.params = { ...preset.params };
    this.views.find((v) => v.data.id === id)?.rebuild(true);
    this.touch();
  }

  applyPosePreset(poseId: string) {
    const view = this.selected();
    const pose = poseById(poseId);
    if (!view || !pose) return;
    this.pushHistory();
    view.data.pose = clone(pose) as Pose;
    view.data.pelvisOffset = { x: 0, y: 0, z: 0 };
    view.updateSkeleton(false, null);
    view.captureTargets();
    this.touch();
  }

  applyHand(side: "L" | "R" | "both", preset: HandPreset) {
    const view = this.selected();
    if (!view) return;
    this.pushHistory();
    if (side !== "R") writeHand(view.data.pose, "L", preset);
    if (side !== "L") writeHand(view.data.pose, "R", preset);
    this.touch();
  }

  applyToes(side: "L" | "R" | "both", preset: ToePreset) {
    const view = this.selected();
    if (!view) return;
    this.pushHistory();
    if (side !== "R") writeToes(view.data.pose, "L", preset);
    if (side !== "L") writeToes(view.data.pose, "R", preset);
    this.touch();
  }

  mirror(direction: "L2R" | "R2L") {
    const view = this.selected();
    if (!view) return;
    this.pushHistory();
    view.data.pose = mirrorPose(view.data.pose, direction);
    view.updateSkeleton(this.state.jointLimits, null);
    view.captureTargets();
    this.touch();
  }

  setIk(on: boolean) {
    const view = this.selected();
    if (!view) return;
    this.pushHistory();
    if (on) {
      view.updateSkeleton(this.state.jointLimits, null);
      view.captureTargets();
    } else {
      view.updateSkeleton(this.state.jointLimits, null);
      view.bakePose(this.state.jointLimits);
    }
    view.data.ik = on;
    this.touch();
  }

  setJointLimits(on: boolean) {
    this.state.jointLimits = on;
    this.emit();
  }

  setShowJoints(on: boolean) {
    this.state.showJoints = on;
    this.emit();
  }

  setShowGrid(on: boolean) {
    this.state.showGrid = on;
    this.grid.visible = on;
    this.emit();
  }

  setShowBody(on: boolean) {
    this.state.showBody = on;
    this.emit();
  }

  selectBone(figureId: string, bone: string | null) {
    this.state.selection = { figureId, bone, facePoint: null };
    if (bone) this.state.tool = "rotate";
    this.touch();
  }

  /** Step through the selected figure's joints. Tab / Shift+Tab. */
  cycleJoint(dir: number) {
    const view = this.selected();
    if (!view) return;
    const names = jointNames().filter((name) => view.bones.has(name));
    if (!names.length) return;
    const cur = this.state.selection.bone;
    let i = cur ? names.indexOf(cur) : -1;
    if (i < 0) i = dir > 0 ? -1 : 0;
    const next = names[(i + dir + names.length) % names.length];
    this.selectBone(view.data.id, next);
  }

  cycleFigure(dir: number) {
    const ids = this.state.figures.map((f) => f.id);
    if (!ids.length) return;
    const i = Math.max(0, ids.indexOf(this.state.selection.figureId ?? ""));
    const next = ids[(i + dir + ids.length) % ids.length];
    this.state.selection = { figureId: next, bone: this.state.selection.bone };
    this.touch();
  }

  solverDrives(bone: string) {
    return DRIVEN.has(bone);
  }

  /**
   * Write one stored Euler axis in degrees. If IK is currently driving this
   * joint, bake the solved pose and turn IK off so the typed angle sticks.
   */
  setJointEuler(axis: "x" | "y" | "z", value: number) {
    const view = this.selected();
    const bone = this.state.selection.bone;
    if (!view || !bone || !Number.isFinite(value)) return;
    this.releaseIkIfDriven(view, bone);
    const cur = { ...(view.data.pose[bone] ?? { x: 0, y: 0, z: 0 }) };
    cur[axis] = value;
    view.data.pose[bone] = this.state.jointLimits ? clampEuler(bone, cur) : cur;
    this.emit();
  }

  nudgeJoint(axis: "x" | "y" | "z", delta: number) {
    const view = this.selected();
    const bone = this.state.selection.bone;
    if (!view || !bone || !Number.isFinite(delta)) return;
    this.releaseIkIfDriven(view, bone);
    const cur = view.data.pose[bone]?.[axis] ?? 0;
    this.setJointEuler(axis, cur + delta);
  }

  private releaseIkIfDriven(view: FigureView, bone: string) {
    if (!view.data.ik || !DRIVEN.has(bone)) return;
    view.updateSkeleton(this.state.jointLimits, null);
    view.bakePose(this.state.jointLimits);
    view.data.ik = false;
  }

  setTool(tool: GizmoTool) {
    this.state.tool = tool;
    this.touch();
  }

  setExport(patch: Partial<SceneState["export"]>) {
    const next = { ...this.state.export, ...patch };
    if (patch.width !== undefined || patch.height !== undefined || patch.preset === "custom") {
      const snapped = snapResolution(next.width, next.height);
      next.width = snapped.width;
      next.height = snapped.height;
    }
    this.state.export = next;
    this.emit();
  }

  snapFeet() {
    const view = this.selected();
    if (!view) return;
    this.pushHistory();
    view.updateSkeleton(this.state.jointLimits, null);
    const y = view.soleY();
    if (Number.isFinite(y)) view.data.position.y -= y;
    this.touch();
  }

  getMode(): CameraMode {
    return this.mode;
  }

  getFov(): number {
    return this.camera.fov;
  }

  setScale(scale: number) {
    const view = this.selected();
    if (!view) return;
    view.data.scale = Math.min(1.8, Math.max(0.4, scale));
    this.emit();
  }

  setCameraMode(mode: CameraMode) {
    if (mode === "fly" && this.mode !== "fly") this.syncFlyFromCamera();
    if (mode === "orbit" && this.mode !== "orbit") {
      const dir = new Vector3();
      this.camera.getWorldDirection(dir);
      this.orbit.target.copy(this.camera.position).addScaledVector(dir, 2.2);
    }
    this.mode = mode;
    this.orbit.enabled = mode === "orbit";
    if (mode !== "fly" && document.pointerLockElement) document.exitPointerLock();
    this.hint.textContent =
      mode === "fly"
        ? "Fly · click to look · WASD move · A left D right · Q down E up · Shift faster · Esc release"
        : "Orbit · left drag look · right drag pan · scroll zoom";
    this.syncGizmo();
    this.emit();
  }

  setFov(fov: number) {
    this.camera.fov = Math.min(100, Math.max(20, fov));
    this.camera.updateProjectionMatrix();
    this.cameraDirty = true;
    this.emit();
  }

  frameAll() {
    this.frame(this.views.filter((v) => v.data.visible));
  }

  frameSelected() {
    const v = this.selected();
    this.frame(v ? [v] : this.views);
  }

  private frame(list: FigureView[]) {
    if (!list.length) return;
    const boxMin = new Vector3(Infinity, Infinity, Infinity);
    const boxMax = new Vector3(-Infinity, -Infinity, -Infinity);
    const p = new Vector3();
    for (const view of list) {
      for (const bone of view.bones.values()) {
        bone.getWorldPosition(p);
        boxMin.min(p);
        boxMax.max(p);
      }
    }
    const center = boxMin.clone().add(boxMax).multiplyScalar(0.5);
    const size = boxMax.clone().sub(boxMin);
    const radius = 0.5 * Math.max(size.x, size.y, size.z, 0.4);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = Math.min(24, Math.max(0.8, radius / Math.sin(fov / 2)));
    if (this.mode === "orbit") {
      const dir = this.camera.position.clone().sub(this.orbit.target);
      if (dir.lengthSq() < 1e-4) dir.set(0.4, 0.25, 1);
      dir.normalize();
      this.orbit.target.copy(center);
      this.camera.position.copy(center).addScaledVector(dir, dist * 1.15);
      this.orbit.update();
    } else {
      const look = new Vector3();
      this.camera.getWorldDirection(look);
      this.camera.position.copy(center).addScaledVector(look, -dist);
      this.syncFlyFromCamera();
    }
    this.cameraDirty = true;
  }

  resetCamera() {
    this.mode = "orbit";
    this.orbit.enabled = true;
    this.camera.position.set(1.55, 1.22, 3.15);
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
    this.orbit.target.set(0, 0.95, 0);
    this.orbit.update();
    this.syncFlyFromCamera();
    this.hint.textContent = "Orbit · left drag look · right drag pan · scroll zoom";
    this.emit();
  }

  private syncFlyFromCamera() {
    const dir = new Vector3();
    this.camera.getWorldDirection(dir);
    this.fly.pitch = Math.asin(Math.min(1, Math.max(-1, dir.y)));
    this.fly.yaw = Math.atan2(-dir.x, -dir.z);
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.overlay.width = w;
    this.overlay.height = h;
    this.updateCrop();
  }

  private updateCrop() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const fit = exportCameraFit(w, h, this.state.export.width, this.state.export.height, this.camera.fov);
    this.crop.style.left = `${fit.x}px`;
    this.crop.style.top = `${fit.y}px`;
    this.crop.style.width = `${fit.w}px`;
    this.crop.style.height = `${fit.h}px`;
  }

  private tick(now: number) {
    if (this.disposed) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.mode === "fly") this.stepFly(dt);
    else this.fly.speed = 0;
    if (this.mode === "orbit") this.orbit.update();
    const skip = this.skipBone;
    for (const view of this.views) {
      view.rebuild();
      view.updateSkeleton(this.state.jointLimits, view.data.id === this.state.selection.figureId ? skip : null);
    }
    this.presentLiveView();
    this.updateCrop();
    this.drawViewportOverlay();
    this.renderer.render(this.scene, this.camera);
    if (this.cameraDirty && !this.previewRunning) {
      this.cameraDirty = false;
      this.schedulePreview();
    } else {
      this.cameraDirty = false;
    }
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Put the shaded viewport back. Export passes borrow the same meshes. */
  private presentLiveView() {
    const bg = this.scene.background;
    if (bg instanceof Color) bg.set("#14181d");
    else this.scene.background = new Color("#14181d");
    for (const helper of this.helpers) helper.visible = true;
    this.grid.visible = this.state.showGrid;
    this.gizmo.getHelper().visible = true;
    for (const view of this.views) {
      const selected = view.data.id === this.state.selection.figureId;
      view.mesh.material = view.beauty;
      view.setViewportBody(this.state.showBody);
      view.setMarkerStyle(
        selected ? this.state.selection.bone : null,
        this.hoverBone,
        this.state.showJoints || !this.state.showBody,
      );
      view.setFaceGuide(view.data.detailedHead === true || (this.faceEdit && selected));
      if (view.facePoints.visible) {
        view.syncFaceGuide();
        const point = selected ? (this.state.selection.facePoint ?? null) : null;
        view.tintFacePoints(point, selected ? this.hoverFace : null);
      }
    }
  }

  private stepFly(dt: number) {
    const speed = (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 4.8 : 1.9) * dt;
    const yaw = this.fly.yaw;
    const pitch = this.fly.pitch;
    const forward = new Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const before = this.camera.position.clone();
    if (this.keys.has("KeyW")) this.camera.position.addScaledVector(forward, speed);
    if (this.keys.has("KeyS")) this.camera.position.addScaledVector(forward, -speed);
    if (this.keys.has("KeyD")) this.camera.position.addScaledVector(right, speed);
    if (this.keys.has("KeyA")) this.camera.position.addScaledVector(right, -speed);
    if (this.keys.has("KeyE")) this.camera.position.y += speed;
    if (this.keys.has("KeyQ")) this.camera.position.y -= speed;
    const look = this.camera.position.clone().add(forward);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(look);
    const moved = this.camera.position.distanceTo(before);
    this.fly.speed = dt > 0 ? moved / dt : 0;
    if (moved > 0) this.cameraDirty = true;
  }

  private hoverBone: string | null = null;
  private hoverFace: number | null = null;
  private faceDrag: { index: number; x: number; y: number; pushed: boolean; base: Vec3[] } | null = null;
  private faceA = new Vector3();
  private faceB = new Vector3();
  private faceC = new Vector3();
  private faceM = new Matrix4();
  private down = { x: 0, y: 0 };

  private onPointerDown = (e: PointerEvent) => {
    this.down.x = e.clientX;
    this.down.y = e.clientY;
    if (!this.faceEdit || e.button !== 0) return;
    const hit = this.pickFacePoint(e);
    const view = this.selected();
    if (hit == null || !view) return;
    this.faceDrag = { index: hit, x: e.clientX, y: e.clientY, pushed: false, base: clone(view.data.faceOffsets) };
    this.orbit.enabled = false;
    this.state.selection = { figureId: view.data.id, bone: null, facePoint: hit };
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.touch();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.faceDrag) {
      this.updateFaceDrag(e);
      return;
    }
    if (document.pointerLockElement === this.renderer.domElement && this.mode === "fly") {
      this.fly.yaw -= e.movementX * 0.0022;
      this.fly.pitch -= e.movementY * 0.0022;
      this.fly.pitch = Math.min(1.35, Math.max(-1.35, this.fly.pitch));
      return;
    }
    this.pointerFrom(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const markers = this.views.flatMap((v) => (isPickable(v.data) ? [...v.markers.values()] : []));
    const hit = this.raycaster.intersectObjects(markers, false)[0];
    this.hoverBone = hit ? (hit.object.userData.bone as string) : null;
    this.hoverFace = this.faceEdit ? this.pickFacePoint(e) : null;
    this.renderer.domElement.style.cursor = this.hoverFace != null ? "pointer" : "";
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.faceDrag) {
      const moved = this.faceDrag.pushed;
      this.faceDrag = null;
      if (this.mode === "orbit") this.orbit.enabled = true;
      this.renderer.domElement.style.cursor = "";
      if (moved) this.emit();
      return;
    }
    if (this.suppressPick) {
      this.suppressPick = false;
      return;
    }
    const dx = e.clientX - this.down.x;
    const dy = e.clientY - this.down.y;
    if (dx * dx + dy * dy > 16) return;
    if (this.faceEdit) {
      const hit = this.pickFacePoint(e);
      this.state.selection = { figureId: this.state.selection.figureId, bone: null, facePoint: hit };
      this.touch();
      return;
    }
    this.pointerFrom(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const pickable = this.state.showJoints || !this.state.showBody;
    const markers = this.views.flatMap((v) => (isPickable(v.data) && pickable ? [...v.markers.values()] : []));
    const hit = this.raycaster.intersectObjects(markers, false)[0];
    if (hit) {
      this.state.selection = {
        figureId: hit.object.userData.figureId as string,
        bone: hit.object.userData.bone as string,
        facePoint: null,
      };
      this.touch();
      return;
    }
    const meshes = this.views.filter((v) => isPickable(v.data)).map((v) => v.mesh);
    const body = this.raycaster.intersectObjects(meshes, false)[0];
    if (body) {
      const view = this.views.find((v) => v.mesh === body.object);
      if (view) this.state.selection = { figureId: view.data.id, bone: null, facePoint: null };
      this.touch();
      return;
    }
    this.state.selection = { figureId: this.state.selection.figureId, bone: null, facePoint: null };
    this.touch();
  };

  private pointerFrom(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** Nearest landmark under the cursor, in the selected figure only. */
  private pickFacePoint(e: PointerEvent): number | null {
    const view = this.selected();
    if (!view || !view.facePoints.visible || view.data.locked) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best = -1;
    let bestD = 16 * 16;
    for (let i = 0; i < 68; i++) {
      if (!view.faceWorld(i, this.faceA)) continue;
      this.faceA.project(this.camera);
      if (this.faceA.z < -1 || this.faceA.z > 1) continue;
      const sx = (this.faceA.x * 0.5 + 0.5) * rect.width;
      const sy = (-this.faceA.y * 0.5 + 0.5) * rect.height;
      const d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best < 0 ? null : best;
  }

  /** Screen pixels to a head-local move. Shift keeps only the in/out axis. */
  private faceScreenDelta(view: FigureView, index: number, dxPx: number, dyPx: number, depth: boolean): Vec3 {
    const head = view.bones.get("head");
    if (!head || !view.faceWorld(index, this.faceA)) return { x: 0, y: 0, z: 0 };
    const dist = Math.max(0.05, this.camera.position.distanceTo(this.faceA));
    const rect = this.renderer.domElement.getBoundingClientRect();
    const worldPerPx = (2 * Math.tan((this.camera.fov * Math.PI) / 360) * dist) / Math.max(1, rect.height);
    const world = this.faceB;
    if (depth) {
      world.set(0, 0, 1).transformDirection(head.matrixWorld).multiplyScalar(-dyPx * worldPerPx);
    } else {
      const right = this.faceC.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = this.faceA.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      world.copy(right).multiplyScalar(dxPx * worldPerPx).addScaledVector(up, -dyPx * worldPerPx);
    }
    const origin = this.faceC.setFromMatrixPosition(head.matrixWorld);
    const end = this.faceA.copy(origin).add(world);
    this.faceM.copy(head.matrixWorld).invert();
    origin.applyMatrix4(this.faceM);
    end.applyMatrix4(this.faceM);
    end.sub(origin);
    if (depth) return { x: 0, y: 0, z: end.z };
    return { x: end.x, y: end.y, z: 0 };
  }

  private updateFaceDrag(e: PointerEvent) {
    const drag = this.faceDrag;
    const view = this.selected();
    if (!drag || !view) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.pushed && dx * dx + dy * dy < 4) return;
    if (!drag.pushed) {
      this.pushHistory();
      drag.pushed = true;
    }
    const delta = this.faceScreenDelta(view, drag.index, dx, dy, e.shiftKey);
    view.data.faceOffsets = applyFaceOffset(drag.base, drag.index, delta, {
      isolate: e.altKey,
      mirror: view.data.faceMirror !== false,
    });
    this.renderer.domElement.style.cursor = "grabbing";
  }

  private nudgeFacePoint(index: number, code: string, shift: boolean, isolate: boolean) {
    const view = this.selected();
    if (!view) return;
    const px = shift ? 28 : 8;
    let dx = 0;
    let dy = 0;
    let depth = false;
    if (code === "ArrowRight" || code === "Numpad6") dx = px;
    else if (code === "ArrowLeft" || code === "Numpad4") dx = -px;
    else if (code === "ArrowUp" || code === "Numpad8") dy = -px;
    else if (code === "ArrowDown" || code === "Numpad2") dy = px;
    else if (code === "Period" || code === "Numpad3") {
      depth = true;
      dy = -px;
    } else if (code === "Comma" || code === "Numpad1") {
      depth = true;
      dy = px;
    } else return;
    const delta = this.faceScreenDelta(view, index, dx, dy, depth);
    view.data.faceOffsets = applyFaceOffset(view.data.faceOffsets, index, delta, {
      isolate,
      mirror: view.data.faceMirror !== false,
    });
    this.emit();
  }

  private cycleFacePoint(dir: number) {
    const view = this.selected();
    if (!view) return;
    const cur = this.state.selection.facePoint;
    const i = cur == null || cur < 0 || cur > 67 ? (dir > 0 ? -1 : 0) : cur;
    const next = (i + dir + 68) % 68;
    this.selectFacePoint(view.data.id, next);
  }

  private typingTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.typingTarget(e.target)) return;
    this.keys.add(e.code);
    const key = e.key.toLowerCase();
    if (e.key === "?" || (e.shiftKey && e.key === "/")) {
      this.onHelp?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === "y") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (e.key === "Delete") {
      this.deleteSelected();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (this.faceEdit) this.cycleFacePoint(e.shiftKey ? -1 : 1);
      else this.cycleJoint(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      this.cycleFigure(e.key === "]" ? 1 : -1);
      return;
    }
    if (!e.ctrlKey && !e.metaKey) {
      const nudge = nudgeFromCode(e.code);
      const lockedSel = this.selected()?.data.locked === true;
      if (nudge && this.faceEdit) {
        const point = this.state.selection.facePoint;
        if (point != null && !lockedSel) {
          e.preventDefault();
          if (!e.repeat) this.pushHistory();
          this.nudgeFacePoint(point, e.code, e.shiftKey, e.altKey);
        } else {
          e.preventDefault();
        }
        return;
      }
      if (nudge && !e.altKey && this.state.selection.bone && lockedSel) {
        e.preventDefault();
        return;
      }
      if (nudge && !e.altKey && this.state.selection.bone) {
        e.preventDefault();
        if (!e.repeat) this.pushHistory();
        const step = e.shiftKey ? 5 : 1;
        this.nudgeJoint(nudge.axis, nudge.sign * step);
        return;
      }
    }
    if (isExportAllKey(e, this.mode)) {
      e.preventDefault();
      void this.exportAll();
      return;
    }
    if (this.mode === "fly" && (key === "e" || key === "q")) return;
    if (key === "g") this.setTool("translate");
    else if (key === "r") this.setTool("rotate");
    else if (key === "f") this.frameSelected();
    else if (key === "c") this.setCameraMode(this.mode === "orbit" ? "fly" : "orbit");
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private clearKeys = () => {
    this.keys.clear();
  };

  private onLock = () => {
    if (document.pointerLockElement !== this.renderer.domElement) this.keys.clear();
  };

  onHelp: (() => void) | null = null;

  private syncGizmo() {
    if (this.faceEdit) {
      this.gizmo.detach();
      return;
    }
    const view = this.selected();
    this.gizmo.enabled = this.mode === "orbit";
    if (!view || this.mode === "fly" || view.data.locked) {
      this.gizmo.detach();
      return;
    }
    const bone = this.state.selection.bone;
    const tool = this.state.tool;
    const ikKey = bone ? IK_BONE[bone] : undefined;
    const driven = !!view.data.ik && !!bone && DRIVEN.has(bone);
    if (!bone || tool === "scale") {
      this.gizmo.attach(view.group);
      this.gizmo.setMode(tool === "rotate" ? "rotate" : tool === "scale" ? "scale" : "translate");
      this.gizmo.space = "world";
      const rot = tool === "rotate";
      this.gizmo.showX = !rot;
      this.gizmo.showY = true;
      this.gizmo.showZ = !rot;
      return;
    }
    if (view.data.ik && ikKey && tool === "translate") {
      const helper = view.targets.get(ikKey);
      if (!helper) return;
      this.gizmo.attach(helper);
      this.gizmo.setMode("translate");
      this.gizmo.space = "local";
      this.gizmo.showX = this.gizmo.showY = this.gizmo.showZ = true;
      return;
    }
    if (driven || tool !== "rotate") {
      this.gizmo.detach();
      return;
    }
    const b = view.bones.get(bone);
    if (!b) return;
    this.gizmo.attach(b);
    this.gizmo.setMode("rotate");
    this.gizmo.space = "local";
    this.gizmo.showX = this.gizmo.showY = this.gizmo.showZ = true;
  }

  private onGizmo() {
    const view = this.selected();
    if (!view || !this.gizmo.object) return;
    const obj = this.gizmo.object;
    if (obj === view.group) {
      view.data.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
      view.data.rotationY = (obj.rotation.y * 180) / Math.PI;
      const s = (obj.scale.x + obj.scale.y + obj.scale.z) / 3;
      obj.scale.setScalar(s);
      view.data.scale = s;
      this.skipBone = null;
      view.holdTarget = null;
      return;
    }
    if (obj instanceof Object && view.targets.has(obj.name)) {
      view.holdTarget = obj.name;
      if (obj.name === "pelvis") {
        const hips = view.segments.find((s) => s.name === "hips");
        if (hips) {
          view.data.pelvisOffset = {
            x: obj.position.x - hips.head.x,
            y: obj.position.y - hips.head.y,
            z: obj.position.z - hips.head.z,
          };
        }
      } else {
        const key = obj.name as keyof FigureData["ikTargets"];
        view.data.ikTargets[key] = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
      }
      return;
    }
    const boneName = obj.name;
    if (view.bones.has(boneName)) {
      this.skipBone = boneName;
      const stoopOnly = composedEuler(boneName, {}, view.data.params, false);
      const prevUser = view.data.pose[boneName] ?? { x: 0, y: 0, z: 0 };
      const euler = view.readEuler(boneName, {
        x: prevUser.x + stoopOnly.x,
        y: prevUser.y + stoopOnly.y,
        z: prevUser.z + stoopOnly.z,
      });
      let user = {
        x: euler.x - stoopOnly.x,
        y: euler.y - stoopOnly.y,
        z: euler.z - stoopOnly.z,
      };
      if (this.state.jointLimits) user = clampEuler(boneName, user);
      view.data.pose[boneName] = user;
      if (this.state.jointLimits) {
        const applied = composedEuler(boneName, view.data.pose, view.data.params, true);
        const drifted =
          Math.abs(applied.x - euler.x) > 0.2 ||
          Math.abs(applied.y - euler.y) > 0.2 ||
          Math.abs(applied.z - euler.z) > 0.2;
        if (drifted) view.writeEuler(boneName, applied);
      }
    }
  }

  private finishDrag() {
    const view = this.selected();
    this.skipBone = null;
    if (view) view.holdTarget = null;
    this.suppressPick = true;
    this.touch();
  }

  private exportCamera(width: number, height: number) {
    const fit = exportCameraFit(
      Math.max(1, this.host.clientWidth),
      Math.max(1, this.host.clientHeight),
      width,
      height,
      this.camera.fov,
    );
    const cam = this.camera.clone() as PerspectiveCamera;
    cam.fov = fit.fov;
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return cam;
  }

  private people(cam: PerspectiveCamera, width: number, height: number, only?: string): PersonPose[] {
    const out: PersonPose[] = [];
    for (const view of this.views) {
      if (!view.data.visible) continue;
      if (only && view.data.id !== only) continue;
      out.push(view.samplePose(cam, width, height, this.state.export.hideOccluded, this.raycaster));
    }
    return out;
  }

  private poseCanvas(width: number, height: number, only?: string, clear = true): HTMLCanvasElement {
    const cam = this.exportCamera(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    drawOpenPose(ctx, this.people(cam, width, height, only), width, height, {
      handsFace: this.state.export.includeHandsFace,
      clear,
    });
    return canvas;
  }

  private updateWarning(people: PersonPose[], height: number) {
    const cover = bodyCoverage(people, height);
    const text =
      people.length > 0 && cover < 0.18
        ? "A figure spans under 18% of the frame. ControlNet is more reliable when the full body is larger."
        : "";
    if (text !== this.state.warning) {
      this.state.warning = text;
      this.snapshot = { v: this.snapshot.v + 1, state: this.state };
      for (const fn of this.listeners) fn();
    }
  }

  private async renderGL(
    width: number,
    height: number,
    clear: string,
    draw: (cam: PerspectiveCamera) => void,
  ): Promise<Uint8Array> {
    const cam = this.exportCamera(width, height);
    const target = new WebGLRenderTarget(width, height, { depthBuffer: true });
    target.texture.colorSpace = LinearSRGBColorSpace;
    const prev = this.scene.background;
    this.scene.background = pngColor(clear);
    for (const h of this.helpers) h.visible = false;
    for (const v of this.views) {
      for (const m of v.markers.values()) m.visible = false;
      v.setFaceGuide(false);
      v.setViewportBody(true);
    }
    this.gizmo.getHelper().visible = false;
    this.exporter.setSize(width, height, false);
    this.exporter.setRenderTarget(target);
    this.exporter.setClearColor(pngColor(clear), 1);
    draw(cam);
    this.exporter.render(this.scene, cam);
    const buf = new Uint8Array(width * height * 4);
    await this.exporter.readRenderTargetPixelsAsync(target, 0, 0, width, height, buf);
    this.exporter.setRenderTarget(null);
    target.dispose();
    this.scene.background = prev;
    for (const h of this.helpers) h.visible = true;
    this.grid.visible = this.state.showGrid;
    this.gizmo.getHelper().visible = true;
    return rgbaToRgb(buf, width, height, true);
  }

  private async glPng(width: number, height: number, clear: string, prepare: () => void): Promise<Blob> {
    const rgb = await this.renderGL(width, height, clear, () => prepare());
    for (const v of this.views) v.mesh.material = v.beauty;
    return pngBlob(width, height, rgb);
  }

  async exportPng(kind: ExportKind, figureIndex = 0): Promise<Blob> {
    const { width, height } = this.state.export;
    if (kind === "openpose" || kind === "openpose-figure") {
      const only = kind === "openpose-figure" ? this.state.figures[figureIndex]?.id : undefined;
      const canvas = this.poseCanvas(width, height, only, true);
      const people = this.people(this.exportCamera(width, height), width, height, only);
      this.updateWarning(people, height);
      return pngBlob(width, height, canvasToRgb(canvas));
    }
    if (kind === "wire") return this.wireBlobReal(width, height);
    if (kind === "depth") return this.depthBlob(width, height);
    if (kind === "normal") {
      return this.glPng(width, height, "#8080ff", () => {
        for (const v of this.views) {
          v.mesh.material = v.normal;
          v.mesh.visible = v.data.visible;
        }
      });
    }
    if (kind === "mask" || kind === "mask-figure") {
      const only = kind === "mask-figure" ? this.state.figures[figureIndex] : undefined;
      return this.glPng(width, height, "#000000", () => {
        for (const v of this.views) {
          const on = v.data.visible && (!only || v.data.id === only.id);
          v.mesh.visible = on;
          v.mask.color.copy(pngColor(only ? "#ffffff" : v.data.color));
          v.mesh.material = v.mask;
        }
      });
    }
    if (kind === "model" || kind === "model-outline") return this.modelBlob(width, height, kind === "model-outline");
    throw new Error(`unknown export ${kind}`);
  }

  private async wireBlobReal(width: number, height: number): Promise<Blob> {
    const exp = this.state.export;
    const clear = exp.wireInvert ? "#ffffff" : "#000000";
    const cam = this.exportCamera(width, height);
    const target = new WebGLRenderTarget(width, height, { depthBuffer: true });
    target.texture.colorSpace = LinearSRGBColorSpace;
    const prev = this.scene.background;
    this.scene.background = pngColor(clear);
    for (const h of this.helpers) h.visible = false;
    for (const v of this.views) {
      for (const m of v.markers.values()) m.visible = false;
      v.setFaceGuide(false);
      v.setViewportBody(true);
    }
    this.gizmo.getHelper().visible = false;
    this.exporter.setSize(width, height, false);
    this.exporter.setRenderTarget(target);
    this.exporter.setClearColor(pngColor(clear), 1);
    this.exporter.autoClear = true;
    this.exporter.clear(true, true, true);

    if (!exp.wireXray) {
      const depthOnly = new MeshStandardMaterial({ colorWrite: false });
      for (const v of this.views) {
        v.mesh.visible = v.data.visible;
        v.mesh.material = depthOnly;
      }
      this.exporter.render(this.scene, cam);
      depthOnly.dispose();
      this.exporter.autoClear = false;
    }
    for (const v of this.views) {
      v.mesh.visible = v.data.visible;
      const color = pngColor(exp.wireColored ? v.data.color : exp.wireInvert ? "#000000" : "#ffffff");
      v.wire.uniforms.uColor.value = color;
      v.wire.uniforms.uThickness.value = exp.wireThickness;
      v.wire.uniforms.uAA.value = exp.wireAA ? 1 : 0;
      v.wire.depthTest = !exp.wireXray;
      v.wire.depthWrite = false;
      v.mesh.material = v.wire;
    }
    this.exporter.render(this.scene, cam);
    this.exporter.autoClear = true;
    const buf = new Uint8Array(width * height * 4);
    await this.exporter.readRenderTargetPixelsAsync(target, 0, 0, width, height, buf);
    this.exporter.setRenderTarget(null);
    target.dispose();
    this.scene.background = prev;
    for (const h of this.helpers) h.visible = true;
    this.grid.visible = this.state.showGrid;
    this.gizmo.getHelper().visible = true;
    for (const v of this.views) {
      v.mesh.material = v.beauty;
      v.mesh.visible = v.data.visible;
    }
    return pngBlob(width, height, rgbaToRgb(buf, width, height, true));
  }

  private async depthBlob(width: number, height: number): Promise<Blob> {
    return pngBlob(width, height, await this.depthRgb(width, height));
  }

  private fitDepth(cam: PerspectiveCamera) {
    let near = cam.near;
    let far = Math.min(cam.far, 12);
    if (this.state.export.depthAuto) {
      near = Infinity;
      far = 0.05;
      for (const v of this.views) {
        if (!v.data.visible) continue;
        for (const bone of v.bones.values()) {
          bone.getWorldPosition(this.depthScratch);
          this.depthScratch.applyMatrix4(cam.matrixWorldInverse);
          const z = -this.depthScratch.z;
          if (z > 0) {
            near = Math.min(near, z);
            far = Math.max(far, z);
          }
        }
      }
      if (!Number.isFinite(near)) {
        near = 0.2;
        far = 8;
      }
      near = Math.max(0.05, near * 0.85);
      far = Math.max(near + 0.3, far * 1.08);
    }
    this.depthMat.uniforms.uNear.value = near;
    this.depthMat.uniforms.uFar.value = far;
    this.depthMat.colorWrite = true;
  }

  private async depthRgb(width: number, height: number): Promise<Uint8Array> {
    const cam = this.exportCamera(width, height);
    this.fitDepth(cam);
    const rgb = await this.renderGL(width, height, "#000000", () => {
      for (const v of this.views) {
        v.mesh.material = this.depthMat;
        v.mesh.visible = v.data.visible;
      }
    });
    for (const v of this.views) v.mesh.material = v.beauty;
    return rgb;
  }

  private async maskRgb(width: number, height: number): Promise<Uint8Array> {
    const rgb = await this.renderGL(width, height, "#000000", () => {
      for (const v of this.views) {
        v.mesh.visible = v.data.visible;
        v.mask.color.copy(pngColor(v.data.color));
        v.mesh.material = v.mask;
      }
    });
    for (const v of this.views) v.mesh.material = v.beauty;
    return rgb;
  }

  /** Glossy shaded body on black. The bytes are sRGB, for Anima's 3D-pose ControlNet. */
  private async shadedRgb(width: number, height: number): Promise<Uint8Array> {
    const cam = this.exportCamera(width, height);
    const target = new WebGLRenderTarget(width, height, { depthBuffer: true });
    target.texture.colorSpace = LinearSRGBColorSpace;
    const prevBg = this.scene.background;
    const prevTone = this.exporter.toneMapping;
    const prevExposure = this.exporter.toneMappingExposure;
    const prevShadow = this.exporter.shadowMap.enabled;
    try {
      this.scene.background = new Color(0x000000);
      for (const h of this.helpers) h.visible = false;
      for (const v of this.views) {
        for (const m of v.markers.values()) m.visible = false;
        v.setFaceGuide(false);
        v.setViewportBody(true);
        v.mesh.material = v.anima;
        v.mesh.visible = v.data.visible;
      }
      this.gizmo.getHelper().visible = false;
      this.exporter.toneMapping = ACESFilmicToneMapping;
      this.exporter.toneMappingExposure = 1.05;
      this.exporter.shadowMap.enabled = true;
      this.exporter.shadowMap.type = PCFShadowMap;
      this.exporter.setSize(width, height, false);
      this.exporter.setRenderTarget(target);
      this.exporter.setClearColor(0x000000, 1);
      this.exporter.clear(true, true, true);
      this.exporter.render(this.scene, cam);
      const buf = new Uint8Array(width * height * 4);
      await this.exporter.readRenderTargetPixelsAsync(target, 0, 0, width, height, buf);
      return linearRgbToSrgb(rgbaToRgb(buf, width, height, true));
    } finally {
      this.exporter.setRenderTarget(null);
      target.dispose();
      this.exporter.toneMapping = prevTone;
      this.exporter.toneMappingExposure = prevExposure;
      this.exporter.shadowMap.enabled = prevShadow;
      this.scene.background = prevBg;
      for (const h of this.helpers) h.visible = true;
      this.grid.visible = this.state.showGrid;
      this.gizmo.getHelper().visible = true;
      for (const v of this.views) {
        v.mesh.material = v.beauty;
        v.setViewportBody(this.state.showBody);
      }
    }
  }

  private async modelBlob(width: number, height: number, outline: boolean): Promise<Blob> {
    const color = await this.shadedRgb(width, height);
    if (!outline) return pngBlob(width, height, color);
    const depth = await this.depthRgb(width, height);
    const mask = await this.maskRgb(width, height);
    return pngBlob(width, height, animaOutline(color, depth, mask, width, height));
  }

  async exportJson(): Promise<Blob> {
    const { width, height } = this.state.export;
    const cam = this.exportCamera(width, height);
    const people = this.people(cam, width, height);
    this.updateWarning(people, height);
    const json = openPoseJson(people, width, height, this.state.export.includeHandsFace);
    return new Blob([json], { type: "application/json" });
  }

  async exportAll() {
    const { width, height } = this.state.export;
    const items: ZipItem[] = [];
    const push = async (name: string, blob: Blob) => {
      items.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
    };
    await push("openpose.png", await this.exportPng("openpose"));
    await push("wireframe.png", await this.wireBlobReal(width, height));
    await push("depth.png", await this.depthBlob(width, height));
    await push("normal.png", await this.exportPng("normal"));
    await push("mask_combined.png", await this.exportPng("mask"));
    await push("model.png", await this.exportPng("model"));
    await push("model_outline.png", await this.exportPng("model-outline"));
    await push("openpose.json", await this.exportJson());
    for (let i = 0; i < this.state.figures.length; i++) {
      if (!this.state.figures[i].visible) continue;
      const n = i + 1;
      await push(`mask_figure${n}.png`, await this.exportPng("mask-figure", i));
      await push(`openpose_figure${n}.png`, await this.exportPng("openpose-figure", i));
    }
    const settings = {
      version: 1,
      exportedAt: new Date().toISOString(),
      resolution: { width, height },
      export: this.state.export,
      camera: this.cameraBlob(),
      figures: this.state.figures,
    };
    items.push({ name: "settings.json", data: new TextEncoder().encode(JSON.stringify(settings, null, 2)) });
    downloadBlob(zipBlob(items), `posewright-${stamp()}.zip`);
  }

  async download(kind: ExportKind) {
    const blob = kind === "wire" ? await this.wireBlobReal(this.state.export.width, this.state.export.height) : await this.exportPng(kind);
    downloadBlob(blob, `${kind}-${stamp()}.png`);
  }

  async downloadJson() {
    downloadBlob(await this.exportJson(), `openpose-${stamp()}.json`);
  }

  saveScene() {
    const payload = { version: 1, state: this.state, camera: this.cameraBlob() };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `posewright-scene-${stamp()}.json`);
  }

  async loadScene(file: File) {
    const data = JSON.parse(await file.text()) as { version: number; state: SceneState; camera?: ReturnType<PoserEngine["cameraBlob"]> };
    if (!data?.state?.figures) throw new Error("That file is not a Posewright scene.");
    this.pushHistory();
    for (const v of this.views) v.dispose();
    this.views = [];
    this.state.figures = data.state.figures.slice(0, MAX_FIGURES);
    this.state.selection = validSelection(data.state.selection, this.state.figures);
    this.state.jointLimits = data.state.jointLimits ?? true;
    this.state.showJoints = data.state.showJoints ?? true;
    this.state.showBody = data.state.showBody ?? true;
    this.state.showGrid = data.state.showGrid ?? true;
    this.state.export = { ...this.state.export, ...data.state.export };
    this.state.tool = data.state.tool ?? "rotate";
    for (const fig of this.state.figures) {
      this.normalizeFigure(fig);
      this.attachView(fig, false);
    }
    this.nextId = nextFigureId(this.state.figures, this.nextId);
    if (data.camera) this.applyCamera(data.camera);
    this.touch();
  }

  savePose() {
    const view = this.selected();
    if (!view) return;
    const payload = {
      version: 2,
      note: "Joint rotations are intrinsic XYZ degrees from the T-pose. X pitches, Y yaws, Z rolls.",
      name: view.data.name,
      joints: poseToJoints(view.data.pose),
      pose: view.data.pose,
      pelvisOffset: view.data.pelvisOffset,
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `angles-${stamp()}.json`);
  }

  saveFigure() {
    const view = this.selected();
    if (!view) return;
    const fig = view.data;
    const payload = {
      version: 2,
      kind: "figure",
      note: "Posewright figure. joints[] are XYZ degrees from the T-pose.",
      name: fig.name,
      params: fig.params,
      position: fig.position,
      rotationY: fig.rotationY,
      scale: fig.scale,
      pose: fig.pose,
      joints: poseToJoints(fig.pose),
      ik: fig.ik,
      ikTargets: fig.ikTargets,
      pelvisOffset: fig.pelvisOffset,
      detailedFeet: fig.detailedFeet === true,
      detailedHead: fig.detailedHead === true,
      face: clampFace(fig.face),
      faceOffsets: clampFaceOffsets(fig.faceOffsets),
      faceMirror: fig.faceMirror !== false,
    };
    const slug = fig.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "figure";
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `${slug}-${stamp()}.json`);
  }

  async loadPose(file: File) {
    const view = this.selected();
    if (!view) return;
    const data = JSON.parse(await file.text()) as {
      pose?: Pose;
      joints?: { name: string; x: number; y: number; z: number }[];
      pelvisOffset?: FigureData["pelvisOffset"];
    };
    const pose = poseFromFile(data);
    if (!pose) throw new Error("That file has no joint angles.");
    this.pushHistory();
    view.data.pose = pose;
    if (data.pelvisOffset) view.data.pelvisOffset = data.pelvisOffset;
    view.updateSkeleton(this.state.jointLimits, null);
    view.captureTargets();
    this.touch();
  }

  async loadFigure(file: File) {
    const view = this.selected();
    if (!view) return;
    const data = JSON.parse(await file.text()) as {
      name?: string;
      params?: FigureData["params"];
      position?: FigureData["position"];
      rotationY?: number;
      scale?: number;
      pose?: Pose;
      joints?: { name: string; x: number; y: number; z: number }[];
      ik?: boolean;
      ikTargets?: FigureData["ikTargets"];
      pelvisOffset?: FigureData["pelvisOffset"];
      detailedFeet?: boolean;
      detailedHead?: boolean;
      face?: FigureData["face"];
      faceOffsets?: FigureData["faceOffsets"];
      faceMirror?: boolean;
    };
    const pose = poseFromFile(data);
    if (!pose && !data.params) throw new Error("That file is not a Posewright figure.");
    this.pushHistory();
    if (data.params) view.data.params = clampParams({ ...view.data.params, ...data.params });
    if (pose) view.data.pose = pose;
    if (data.pelvisOffset) view.data.pelvisOffset = data.pelvisOffset;
    if (data.position) view.data.position = { ...data.position };
    if (typeof data.rotationY === "number") view.data.rotationY = data.rotationY;
    if (typeof data.scale === "number") view.data.scale = data.scale;
    if (typeof data.name === "string" && data.name.trim()) view.data.name = data.name.slice(0, 40);
    if (typeof data.ik === "boolean") view.data.ik = data.ik;
    if (data.ikTargets) view.data.ikTargets = data.ikTargets;
    if (typeof data.detailedFeet === "boolean") view.data.detailedFeet = data.detailedFeet;
    if (typeof data.detailedHead === "boolean") view.data.detailedHead = data.detailedHead;
    if (data.face) view.data.face = clampFace(data.face);
    if (data.faceOffsets) view.data.faceOffsets = clampFaceOffsets(data.faceOffsets);
    if (typeof data.faceMirror === "boolean") view.data.faceMirror = data.faceMirror;
    view.rebuild(true);
    view.updateSkeleton(this.state.jointLimits, null);
    view.captureTargets();
    this.touch();
  }

  private cameraBlob() {
    return {
      mode: this.mode,
      fov: this.camera.fov,
      position: this.camera.position.toArray(),
      target: this.orbit.target.toArray(),
      yaw: this.fly.yaw,
      pitch: this.fly.pitch,
    };
  }

  private applyCamera(cam: ReturnType<PoserEngine["cameraBlob"]>) {
    this.camera.fov = cam.fov;
    this.camera.position.fromArray(cam.position);
    this.orbit.target.fromArray(cam.target);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    this.fly.yaw = cam.yaw;
    this.fly.pitch = cam.pitch;
    this.setCameraMode(cam.mode);
  }

  getLivePreviews(): boolean {
    return this.livePreviews;
  }

  setLivePreviews(on: boolean) {
    if (this.livePreviews === on) return;
    this.livePreviews = on;
    writeLivePreviews(on);
    this.emit();
  }

  setPreviewCanvases(canvases: PoserEngine["preview"]) {
    this.preview = canvases;
    this.schedulePreview();
  }

  private schedulePreview() {
    if (this.disposed) return;
    this.previewQueued = true;
    if (this.previewRunning) return;
    window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => void this.flushPreview(), 180);
  }

  private async flushPreview() {
    if (this.previewRunning || this.disposed) return;
    this.previewRunning = true;
    this.previewQueued = false;
    try {
      await this.renderPreviewInner();
    } catch (err) {
      console.error("preview failed", err);
    } finally {
      this.previewRunning = false;
      // Orbit damping during a pass is not a new pose. Don't chain another full render off it.
      this.cameraDirty = false;
      if (this.previewQueued && !this.disposed) this.schedulePreview();
    }
  }

  private async renderPreviewInner() {
    const aspect = this.state.export.width / this.state.export.height;
    const w = 256;
    const h = Math.max(64, Math.round(w / aspect / 8) * 8);
    const ww = Math.round(w / 8) * 8;
    if (!this.livePreviews) {
      // Keep the small-figure warning current without any GPU work.
      this.updateWarning(this.people(this.exportCamera(ww, h), ww, h), h);
      return;
    }
    const pose = this.preview.pose;
    if (!pose) return;
    const drawInto = (el: HTMLCanvasElement | undefined, src: HTMLCanvasElement) => {
      if (!el) return;
      el.width = src.width;
      el.height = src.height;
      el.getContext("2d")?.drawImage(src, 0, 0);
    };
    const poseCanvas = this.poseCanvas(ww, h);
    drawInto(pose, poseCanvas);
    const people = this.people(this.exportCamera(ww, h), ww, h);
    this.updateWarning(people, h);
    const paint = async (el: HTMLCanvasElement | undefined, blob: Blob) => {
      if (!el) return;
      const bmp = await createImageBitmap(blob);
      el.width = bmp.width;
      el.height = bmp.height;
      el.getContext("2d")?.drawImage(bmp, 0, 0);
      bmp.close();
    };
    await paint(this.preview.wire, await this.wireBlobReal(ww, h));
    await paint(this.preview.depth, await this.depthBlob(ww, h));
    await paint(this.preview.normal, await this.smallNormal(ww, h));
    await paint(this.preview.mask, await this.smallMask(ww, h));
    await paint(this.preview.model, await this.modelBlob(ww, h, false));
    if (this.preview.align) {
      const align = document.createElement("canvas");
      align.width = ww;
      align.height = h;
      const ctx = align.getContext("2d");
      if (ctx && this.preview.wire) ctx.drawImage(this.preview.wire, 0, 0);
      const ctx2 = poseCanvas.getContext("2d");
      if (ctx && ctx2) {
        const img = ctx2.getImageData(0, 0, ww, h);
        const over = ctx.getImageData(0, 0, ww, h);
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 12) {
            over.data[i] = img.data[i];
            over.data[i + 1] = img.data[i + 1];
            over.data[i + 2] = img.data[i + 2];
            over.data[i + 3] = 255;
          }
        }
        ctx.putImageData(over, 0, 0);
      }
      drawInto(this.preview.align, align);
    }
  }

  private async smallMask(w: number, h: number): Promise<Blob> {
    return this.glPng(w, h, "#000000", () => {
      for (const v of this.views) {
        v.mesh.visible = v.data.visible;
        v.mask.color.copy(pngColor(v.data.color));
        v.mesh.material = v.mask;
      }
    });
  }

  private async smallNormal(w: number, h: number): Promise<Blob> {
    return this.glPng(w, h, "#8080ff", () => {
      for (const v of this.views) {
        v.mesh.material = v.normal;
        v.mesh.visible = v.data.visible;
      }
    });
  }

  private drawViewportOverlay() {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const w = this.overlay.width;
    const h = this.overlay.height;
    ctx.clearRect(0, 0, w, h);
    if (this.state.export.overlay === "off") return;
    this.camera.updateMatrixWorld();
    const people = this.people(this.camera, w, h);
    drawOpenPose(ctx, people, w, h, { handsFace: this.state.export.includeHandsFace, clear: false });
  }

  private expose() {
    const engine = this;
    window.__poser = {
      ready: true,
      addFigure: (preset?: string) => engine.addFigure(preset),
      setCameraMode: (mode: CameraMode) => engine.setCameraMode(mode),
      frameAll: () => engine.frameAll(),
      figureCount: () => engine.state.figures.length,
      figures: () => clone(engine.state.figures),
    };
    window.__controlsTest = {
      getYaw: () => engine.fly.yaw,
      getSpeed: () => engine.fly.speed,
      getPos: () => ({ x: engine.camera.position.x, y: engine.camera.position.y, z: engine.camera.position.z }),
      setKeys: (codes: string[]) => {
        engine.keys = new Set(codes);
      },
    };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.previewTimer);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.clearKeys);
    document.removeEventListener("pointerlockchange", this.onLock);
    this.resizeObserver.disconnect();
    for (const v of this.views) v.dispose();
    this.views = [];
    // React mounts twice in dev. Leave nothing behind that could cover the live engine's canvas.
    this.renderer.domElement.remove();
    this.overlay.remove();
    this.crop.remove();
    this.hint.remove();
    this.renderer.dispose();
    this.exporter.dispose();
    this.orbit.dispose();
    this.gizmo.dispose();
  }
}

const LIVE_PREVIEWS_KEY = "posewright.livePreviews";

/** A per-browser preference, not part of the scene. Storage may be blocked, so fall back to on. */
function readLivePreviews(): boolean {
  try {
    return window.localStorage.getItem(LIVE_PREVIEWS_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeLivePreviews(on: boolean) {
  try {
    window.localStorage.setItem(LIVE_PREVIEWS_KEY, on ? "on" : "off");
  } catch {
    // Ignore: the toggle still works for this session.
  }
}

declare global {
  interface Window {
    __poser?: {
      ready: boolean;
      addFigure: (preset?: string) => void;
      setCameraMode: (mode: CameraMode) => void;
      frameAll: () => void;
      figureCount: () => number;
      /** Read-only copy of the scene's figures, for browser checks. */
      figures: () => FigureData[];
    };
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      getPos: () => { x: number; y: number; z: number };
      setKeys: (codes: string[]) => void;
    };
  }
}
