/** Serializable scene types. Kept free of Three.js so save/load and undo stay plain JSON. */

/** Expression controls for the 68 iBUG face points. Not body joints. */
export type FaceShape = {
  /** 0 closed, 1 dropped. */
  jaw: number;
  /** -1 frown, 1 smile. */
  smile: number;
  /** -1 lowered, 1 raised. */
  brow: number;
  /** 0 open, 1 shut. */
  blink: number;
  /** Width of the mouth, 1 is the rest shape. */
  mouth: number;
};

export type Vec3 = { x: number; y: number; z: number };
export type EulerDeg = { x: number; y: number; z: number };

/** 0 = female presentation, 0.5 = androgynous, 1 = male presentation. */
export type BodyParams = {
  sex: number;
  age: number;
  heightCm: number;
  mass: number;
  muscle: number;
  shoulder: number;
  hip: number;
  torso: number;
  leg: number;
};

export type HandPreset = "open" | "relaxed" | "fist" | "point" | "grip";
export type ToePreset = "open" | "relaxed" | "curl";

export type IkTargets = {
  handL: Vec3;
  handR: Vec3;
  footL: Vec3;
  footR: Vec3;
  head: Vec3;
  pelvis: Vec3;
};

export type FigureData = {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  /** Locked figures cannot be picked or moved in the viewport. Panels still edit them. */
  locked: boolean;
  params: BodyParams;
  /** Ground-plane transform. Y lifts the figure off the floor. */
  position: Vec3;
  rotationY: number;
  scale: number;
  /** Local XYZ Euler degrees added on top of the T-pose rest. */
  pose: Record<string, EulerDeg>;
  ik: boolean;
  ikTargets: IkTargets;
  /** Added to the rest hip position. Lets a crouch drop the pelvis while feet stay put. */
  pelvisOffset: Vec3;
  /** Heel and individual toes. Off is the original single-bone foot. */
  detailedFeet: boolean;
  /** Draw the 68 face landmarks on the figure. Off keeps the plain head. */
  detailedHead: boolean;
  /** Deforms the OpenPose face points. The body mesh stays the plain head. */
  face: FaceShape;
  /** Added to the shaped landmarks, in head-local space. One entry per iBUG point. */
  faceOffsets: Vec3[];
  /** A drag on one side of the face moves the mirrored point. */
  faceMirror: boolean;
};

export type CameraMode = "orbit" | "fly";
export type GizmoTool = "translate" | "rotate" | "scale";

export type ExportSettings = {
  preset: string;
  width: number;
  height: number;
  includeHandsFace: boolean;
  hideOccluded: boolean;
  wireThickness: number;
  wireInvert: boolean;
  wireColored: boolean;
  wireXray: boolean;
  wireAA: boolean;
  depthAuto: boolean;
  overlay: "off" | "skeleton" | "align";
};

export type SceneState = {
  figures: FigureData[];
  selection: { figureId: string | null; bone: string | null; facePoint?: number | null };
  tool: GizmoTool;
  jointLimits: boolean;
  showJoints: boolean;
  /** When false the viewport draws stick bones instead of the skinned mesh. */
  showBody: boolean;
  showGrid: boolean;
  export: ExportSettings;
  warning: string;
};

export const ZERO: EulerDeg = { x: 0, y: 0, z: 0 };
export const V0: Vec3 = { x: 0, y: 0, z: 0 };

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}
