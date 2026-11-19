import {
  Bone,
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshNormalMaterial,
  MeshStandardMaterial,
  Object3D,
  Points,
  PointsMaterial,
  Raycaster,
  ShaderMaterial,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  Vector3,
} from "three";
import type { PerspectiveCamera } from "three";
import { clampFace, clampFaceOffsets, faceLineIndices, headAnchors, posedLandmarks } from "./face.ts";
import { solveIk } from "./ik.ts";
import { buildFigureGeometry } from "./mesh.ts";
import type { PersonPose, Keypoint } from "./openpose.ts";
import { composedEuler, nearestEuler } from "./pose.ts";
import { headLength, layoutFigure, segmentMap, footHeel, TOE_DIGITS, type Segment } from "./proportions.ts";
import { insideFrame, projectToPixel } from "./project.ts";
import type { FigureData, Vec3 } from "./types.ts";

const DEG = Math.PI / 180;
const MARKER_GEO = new SphereGeometry(1, 8, 6);

const WIRE_VERT = /* glsl */ `
#include <skinning_pars_vertex>
attribute vec3 barycentric;
varying vec3 vBary;
void main() {
  #include <begin_vertex>
  #include <skinbase_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vBary = barycentric;
}
`;

const WIRE_FRAG = /* glsl */ `
precision highp float;
varying vec3 vBary;
uniform vec3 uColor;
uniform float uThickness;
uniform float uAA;
void main() {
  vec3 fw = fwidth(vBary);
  float edge = min(vBary.x, min(vBary.y, vBary.z));
  float w = min(fw.x, min(fw.y, fw.z)) * uThickness;
  if (uAA > 0.5) {
    float a = 1.0 - smoothstep(w * 0.25, w, edge);
    if (a < 0.05) discard;
    gl_FragColor = vec4(uColor, 1.0);
  } else {
    if (edge > w) discard;
    gl_FragColor = vec4(uColor, 1.0);
  }
}
`;

const DEPTH_VERT = /* glsl */ `
#include <skinning_pars_vertex>
varying float vViewZ;
void main() {
  #include <begin_vertex>
  #include <skinbase_vertex>
  #include <skinning_vertex>
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const DEPTH_FRAG = /* glsl */ `
precision highp float;
varying float vViewZ;
uniform float uNear;
uniform float uFar;
void main() {
  float d = clamp((vViewZ - uNear) / max(0.0001, uFar - uNear), 0.0, 1.0);
  float w = 1.0 - d;
  gl_FragColor = vec4(w, w, w, 1.0);
}
`;

/**
 * Khronos PBR Neutral tone mapping (the same curve as three's NeutralToneMapping).
 * Three only links its tone-mapping functions into programs that render to the
 * screen, so the clay shader carries its own copy. It keeps hues, so a yellow
 * figure still reads as yellow after the highlights roll off.
 */
const CLAY_TONE_MAP = /* glsl */ `
vec3 clayToneMap( vec3 color ) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min( color.r, min( color.g, color.b ) );
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < startCompression ) return color;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / ( peak + d - startCompression );
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
  return mix( color, vec3( newPeak ), g );
}
`;

/**
 * Matte clay for the H3 reference render. Export targets are linear and skip the
 * renderer's tone mapping, so the shader applies neutral tone mapping and sRGB
 * encoding itself. The 8-bit target then holds display bytes and the soft
 * shading does not band.
 */
export function createClayMaterial(color: string): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `${CLAY_TONE_MAP}\nvoid main() {`)
      .replace(
        "#include <colorspace_fragment>",
        "gl_FragColor.rgb = clayToneMap( gl_FragColor.rgb );\ngl_FragColor = sRGBTransferOETF( gl_FragColor );",
      );
  };
  mat.customProgramCacheKey = () => "posewright-clay";
  return mat;
}

export function createDepthMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uNear: { value: 0.1 }, uFar: { value: 10 } },
    vertexShader: DEPTH_VERT,
    fragmentShader: DEPTH_FRAG,
  });
}

function skinTint(hex: string): Color {
  const tint = new Color(hex);
  const skin = new Color("#d2b29c");
  return skin.lerp(tint, 0.38);
}

export class FigureView {
  data: FigureData;
  readonly group = new Group();
  readonly bones = new Map<string, Bone>();
  readonly markers = new Map<string, Mesh>();
  readonly facePoints: Points;
  readonly faceLines: LineSegments;
  readonly targets = new Map<string, Object3D>();
  readonly boneLines: LineSegments;
  mesh: SkinnedMesh;
  readonly beauty: MeshStandardMaterial;
  readonly anima: MeshStandardMaterial;
  /** Clay export. The engine sets its color per render (figure color or neutral grey). */
  readonly clay: MeshStandardMaterial;
  readonly wire: ShaderMaterial;
  readonly mask: MeshBasicMaterial;
  readonly normal: MeshNormalMaterial;
  skeleton: Skeleton;
  segments: Segment[] = [];
  private segMap = new Map<string, Segment>();
  private layoutKey = "";
  private boneList: Bone[] = [];
  private linePositions = new Float32Array(0);
  private lineA = new Vector3();
  private lineB = new Vector3();
  private facePos = new Float32Array(68 * 3);
  private faceColor = new Float32Array(68 * 3);
  private faceLinePos = new Float32Array(faceLineIndices().length * 3);
  private faceTmp = new Vector3();
  private faceLocal = Array.from({ length: 68 }, () => new Vector3());
  private faceLineIndex = faceLineIndices();
  /** While a gizmo drags an IK helper, don't overwrite its position. */
  holdTarget: string | null = null;

  constructor(data: FigureData) {
    this.data = data;
    this.data.face = clampFace(data.face);
    this.data.faceOffsets = clampFaceOffsets(data.faceOffsets);
    if (typeof data.faceMirror !== "boolean") this.data.faceMirror = true;
    this.data.detailedHead = data.detailedHead === true;
    this.data.detailedFeet = data.detailedFeet === true;
    this.beauty = new MeshStandardMaterial({
      color: skinTint(data.color),
      roughness: 0.64,
      metalness: 0.02,
    });
    this.anima = new MeshStandardMaterial({
      color: skinTint(data.color),
      roughness: 0.36,
      metalness: 0.06,
    });
    this.clay = createClayMaterial(data.color);
    this.wire = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color("#ffffff") },
        uThickness: { value: 1.4 },
        uAA: { value: 1 },
      },
      vertexShader: WIRE_VERT,
      fragmentShader: WIRE_FRAG,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mask = new MeshBasicMaterial({ color: data.color });
    this.normal = new MeshNormalMaterial({ side: DoubleSide });
    this.mesh = new SkinnedMesh();
    this.skeleton = new Skeleton([]);
    this.boneLines = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: data.color, toneMapped: false }),
    );
    this.boneLines.frustumCulled = false;
    this.boneLines.visible = false;
    const faceGeo = new BufferGeometry();
    for (let i = 0; i < 68; i++) {
      this.faceColor[i * 3] = 0xe7 / 255;
      this.faceColor[i * 3 + 1] = 0xeb / 255;
      this.faceColor[i * 3 + 2] = 0xe6 / 255;
    }
    faceGeo.setAttribute("position", new Float32BufferAttribute(this.facePos, 3));
    faceGeo.setAttribute("color", new Float32BufferAttribute(this.faceColor, 3));
    this.facePoints = new Points(
      faceGeo,
      new PointsMaterial({
        color: "#ffffff",
        vertexColors: true,
        size: 7,
        sizeAttenuation: false,
        depthTest: false,
        toneMapped: false,
      }),
    );
    this.facePoints.frustumCulled = false;
    this.facePoints.renderOrder = 3;
    this.facePoints.visible = false;
    const lineGeo = new BufferGeometry();
    lineGeo.setAttribute("position", new Float32BufferAttribute(this.faceLinePos, 3));
    this.faceLines = new LineSegments(
      lineGeo,
      new LineBasicMaterial({ color: "#3ecfb2", depthTest: false, toneMapped: false }),
    );
    this.faceLines.frustumCulled = false;
    this.faceLines.renderOrder = 3;
    this.faceLines.visible = false;
    this.group.add(this.mesh, this.boneLines, this.facePoints, this.faceLines);
    this.group.name = data.id;
    this.rebuild(true);
    for (const key of ["handL", "handR", "footL", "footR", "head", "pelvis"] as const) {
      const o = new Object3D();
      o.name = key;
      this.group.add(o);
      this.targets.set(key, o);
    }
  }

  /**
   * IK target key when `obj` is one of this figure's target helpers, else null.
   * Matches by identity: the head helper and the head bone are both named "head".
   */
  ikTargetOf(obj: Object3D): string | null {
    for (const [key, helper] of this.targets) if (helper === obj) return key;
    return null;
  }

  /** Bone quaternion as XYZ degrees. Pass the previous total so the result does not flip. */
  readEuler(name: string, prev?: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const b = this.bones.get(name);
    if (!b) return { x: 0, y: 0, z: 0 };
    const e = new Euler().setFromQuaternion(b.quaternion, "XYZ");
    const raw = { x: e.x / DEG, y: e.y / DEG, z: e.z / DEG };
    return prev ? nearestEuler(raw, prev) : raw;
  }

  writeEuler(name: string, deg: { x: number; y: number; z: number }) {
    const bone = this.bones.get(name);
    if (!bone) return;
    bone.quaternion.setFromEuler(new Euler(deg.x * DEG, deg.y * DEG, deg.z * DEG, "XYZ"));
  }

  rebuild(force = false) {
    const detailed = this.data.detailedFeet === true;
    const key = `${JSON.stringify(this.data.params)}|${detailed ? "toes" : "simple"}`;
    if (!force && key === this.layoutKey) return;
    this.layoutKey = key;
    this.segments = layoutFigure(this.data.params, detailed);
    this.segMap = segmentMap(this.segments);
    this.syncBones();
    this.applyRestPositions(false);
    for (const b of this.boneList) b.quaternion.identity();
    this.mesh.updateWorldMatrix(true, true);
    const index = new Map(this.boneList.map((b, i) => [b.name, i]));
    const geom = buildFigureGeometry(this.segments, this.data.params, index);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geom;
    this.mesh.material = this.beauty;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.skeleton = new Skeleton(this.boneList);
    this.mesh.bind(this.skeleton);
    this.beauty.color.copy(skinTint(this.data.color));
    this.anima.color.copy(this.beauty.color);
    this.mask.color.set(this.data.color);
  }

  private syncBones() {
    const wanted = this.segments.map((s) => s.name);
    const same = wanted.length === this.bones.size && wanted.every((name) => this.bones.has(name));
    if (same && this.boneList.length > 0) return;
    this.destroyBones();
    this.createBones();
  }

  private destroyBones() {
    this.bones.get("hips")?.removeFromParent();
    for (const marker of this.markers.values()) {
      marker.removeFromParent();
      (marker.material as MeshBasicMaterial).dispose();
    }
    this.markers.clear();
    this.bones.clear();
    this.boneList = [];
  }

  private createBones() {
    for (const seg of this.segments) {
      const bone = new Bone();
      bone.name = seg.name;
      this.bones.set(seg.name, bone);
    }
    let root: Bone | null = null;
    for (const seg of this.segments) {
      const bone = this.bones.get(seg.name)!;
      if (seg.parent) this.bones.get(seg.parent)!.add(bone);
      else root = bone;
    }
    if (!root) throw new Error("rig has no root");
    this.mesh.add(root);
    this.boneList = this.segments.map((s) => this.bones.get(s.name)!);
    const markerMat = () =>
      new MeshBasicMaterial({ color: this.data.color, depthTest: true, toneMapped: false });
    for (const seg of this.segments) {
      const m = new Mesh(MARKER_GEO, markerMat());
      m.name = seg.name;
      m.userData.figureId = this.data.id;
      m.userData.bone = seg.name;
      const finger = /\d\.[LR]$/.test(seg.name);
      m.userData.finger = finger;
      this.group.add(m);
      this.markers.set(seg.name, m);
    }
  }

  private applyRestPositions(withOffset: boolean) {
    for (const seg of this.segments) {
      const bone = this.bones.get(seg.name);
      if (!bone) continue;
      if (!seg.parent) {
        bone.position.set(seg.head.x, seg.head.y, seg.head.z);
      } else {
        const p = this.segMap.get(seg.parent)!;
        bone.position.set(seg.head.x - p.head.x, seg.head.y - p.head.y, seg.head.z - p.head.z);
      }
    }
    if (withOffset) {
      const hips = this.bones.get("hips");
      const seg = this.segMap.get("hips");
      if (hips && seg) {
        const o = this.data.pelvisOffset;
        hips.position.set(seg.head.x + o.x, seg.head.y + o.y, seg.head.z + o.z);
      }
    }
  }

  /** Write FK (and IK, if enabled) onto the skeleton. Call once per frame. */
  updateSkeleton(jointLimits: boolean, skipBone: string | null) {
    this.group.position.set(this.data.position.x, this.data.position.y, this.data.position.z);
    this.group.rotation.y = this.data.rotationY * DEG;
    this.group.scale.setScalar(this.data.scale);
    this.group.visible = this.data.visible;
    this.applyRestPositions(true);
    const e = new Euler(0, 0, 0, "XYZ");
    for (const seg of this.segments) {
      const bone = this.bones.get(seg.name)!;
      if (bone.name === skipBone) continue;
      const deg = composedEuler(seg.name, this.data.pose, this.data.params, jointLimits);
      e.set(deg.x * DEG, deg.y * DEG, deg.z * DEG);
      bone.quaternion.setFromEuler(e);
    }
    this.mesh.updateWorldMatrix(true, true);
    if (this.data.ik) {
      solveIk(this.bones, this.segMap, this.data.ikTargets, this.mesh);
    }
    this.group.updateWorldMatrix(true, true);
    this.syncMarkers();
    this.syncTargetHelpers();
  }

  private syncMarkers() {
    const h = Math.max(0.4, this.data.params.heightCm / 100);
    const tmp = new Vector3();
    for (const [name, marker] of this.markers) {
      const bone = this.bones.get(name)!;
      bone.getWorldPosition(tmp);
      this.group.worldToLocal(tmp);
      marker.position.copy(tmp);
      const finger = marker.userData.finger === true;
      const s = (finger ? 0.012 : 0.02) * h * this.data.scale;
      marker.scale.setScalar(s);
      marker.visible = this.data.visible;
    }
  }

  /** Landmark overlay. Exports turn this off so the plates stay clean. */
  setFaceGuide(on: boolean) {
    const show = on && this.data.visible;
    this.facePoints.visible = show;
    this.faceLines.visible = show;
  }

  /** Landmark overlay. Call after `setFaceGuide(true)` so hidden heads skip the work. */
  syncFaceGuide() {
    if (!this.facePoints.visible && !this.faceLines.visible) return;
    const len = headLength(this.segments);
    const pts = posedLandmarks(len, this.data.face, this.data.faceOffsets);
    const tmp = this.faceTmp;
    const local = this.faceLocal;
    for (let i = 0; i < pts.length; i++) {
      const off = pts[i];
      const nudged = { x: off.x, y: off.y, z: off.z + len * 0.06 };
      const slot = local[i];
      if (!this.localPoint("head", nudged, tmp)) {
        slot.set(0, 0, 0);
      } else {
        this.group.worldToLocal(tmp);
        slot.copy(tmp);
      }
      this.facePos[i * 3] = slot.x;
      this.facePos[i * 3 + 1] = slot.y;
      this.facePos[i * 3 + 2] = slot.z;
    }
    const attr = this.facePoints.geometry.getAttribute("position");
    (attr.array as Float32Array).set(this.facePos);
    attr.needsUpdate = true;
    const lines = this.faceLineIndex;
    for (let i = 0; i < lines.length; i++) {
      const p = local[lines[i]];
      this.faceLinePos[i * 3] = p.x;
      this.faceLinePos[i * 3 + 1] = p.y;
      this.faceLinePos[i * 3 + 2] = p.z;
    }
    const lineAttr = this.faceLines.geometry.getAttribute("position");
    (lineAttr.array as Float32Array).set(this.faceLinePos);
    lineAttr.needsUpdate = true;
  }

  /** World position of one landmark. Positions are group-local until the guide syncs. */
  faceWorld(index: number, out: Vector3): boolean {
    if (index < 0 || index > 67) return false;
    out.set(this.facePos[index * 3], this.facePos[index * 3 + 1], this.facePos[index * 3 + 2]);
    this.group.localToWorld(out);
    return true;
  }

  /** Amber is selected, teal is hovered, bone is a point that has been moved. */
  tintFacePoints(selected: number | null, hover: number | null) {
    const offsets = this.data.faceOffsets;
    for (let i = 0; i < 68; i++) {
      const o = offsets?.[i];
      const moved = !!o && o.x * o.x + o.y * o.y + o.z * o.z > 1e-8;
      let hex = moved ? 0xd7c4b0 : 0xe7ebe6;
      if (i === hover && i !== selected) hex = 0x3ecfb2;
      if (i === selected) hex = 0xe0a045;
      this.faceColor[i * 3] = ((hex >> 16) & 255) / 255;
      this.faceColor[i * 3 + 1] = ((hex >> 8) & 255) / 255;
      this.faceColor[i * 3 + 2] = (hex & 255) / 255;
    }
    const attr = this.facePoints.geometry.getAttribute("color");
    (attr.array as Float32Array).set(this.faceColor);
    attr.needsUpdate = true;
  }

  private syncTargetHelpers() {
    const put = (key: string, v: Vec3) => {
      if (this.holdTarget === key) return;
      const o = this.targets.get(key);
      if (o) o.position.set(v.x, v.y, v.z);
    };
    put("handL", this.data.ikTargets.handL);
    put("handR", this.data.ikTargets.handR);
    put("footL", this.data.ikTargets.footL);
    put("footR", this.data.ikTargets.footR);
    put("head", this.data.ikTargets.head);
    const hips = this.segMap.get("hips");
    if (hips) {
      const o = this.data.pelvisOffset;
      put("pelvis", { x: hips.head.x + o.x, y: hips.head.y + o.y, z: hips.head.z + o.z });
    }
  }

  /** Sample current joint positions into IK targets so enabling IK does not pop. */
  captureTargets() {
    const localOf = (boneName: string): Vec3 => {
      const bone = this.bones.get(boneName);
      const p = new Vector3();
      if (!bone) return { x: 0, y: 0, z: 0 };
      bone.getWorldPosition(p);
      this.mesh.worldToLocal(p);
      return { x: p.x, y: p.y, z: p.z };
    };
    this.data.ikTargets = {
      handL: localOf("hand.L"),
      handR: localOf("hand.R"),
      footL: localOf("foot.L"),
      footR: localOf("foot.R"),
      head: localOf("head"),
      pelvis: { ...this.data.pelvisOffset },
    };
  }

  /** Bake solved bone quaternions back into the stored pose (stoop removed). */
  bakePose(jointLimits: boolean) {
    const base = composedEuler("spine", {}, this.data.params, false);
    void base;
    for (const seg of this.segments) {
      const stoop = composedEuler(seg.name, {}, this.data.params, false);
      const prevUser = this.data.pose[seg.name] ?? { x: 0, y: 0, z: 0 };
      const total = this.readEuler(seg.name, {
        x: prevUser.x + stoop.x,
        y: prevUser.y + stoop.y,
        z: prevUser.z + stoop.z,
      });
      let user = { x: total.x - stoop.x, y: total.y - stoop.y, z: total.z - stoop.z };
      if (jointLimits) {
        const withStoop = composedEuler(seg.name, { [seg.name]: user }, this.data.params, true);
        user = { x: withStoop.x - stoop.x, y: withStoop.y - stoop.y, z: withStoop.z - stoop.z };
      }
      const eps = 0.05;
      if (Math.abs(user.x) < eps && Math.abs(user.y) < eps && Math.abs(user.z) < eps) {
        delete this.data.pose[seg.name];
      } else {
        this.data.pose[seg.name] = user;
      }
    }
  }

  localPoint(boneName: string, offset: Vec3, out: Vector3): Vector3 | null {
    const bone = this.bones.get(boneName);
    if (!bone) return null;
    out.set(offset.x, offset.y, offset.z);
    bone.localToWorld(out);
    return out;
  }

  tipWorld(boneName: string, out: Vector3): Vector3 | null {
    const seg = this.segMap.get(boneName);
    const bone = this.bones.get(boneName);
    if (!seg || !bone) return null;
    out.set(seg.tail.x - seg.head.x, seg.tail.y - seg.head.y, seg.tail.z - seg.head.z);
    bone.localToWorld(out);
    return out;
  }

  samplePose(
    camera: PerspectiveCamera,
    width: number,
    height: number,
    hideOccluded: boolean,
    raycaster: Raycaster,
  ): PersonPose {
    const project = (world: Vector3): Keypoint => {
      const px = projectToPixel(world, camera, width, height);
      if (px.behind || !insideFrame(px, width, height, 2)) return { x: 0, y: 0, c: 0 };
      if (hideOccluded && this.occluded(world, camera, raycaster)) return { x: 0, y: 0, c: 0 };
      return { x: px.x, y: px.y, c: 1 };
    };
    const joint = (name: string): Keypoint => {
      const bone = this.bones.get(name);
      if (!bone) return { x: 0, y: 0, c: 0 };
      const p = new Vector3();
      bone.getWorldPosition(p);
      return project(p);
    };
    const anchor = (key: string): Keypoint => {
      const len = headLength(this.segments);
      const off = headAnchors(len)[key];
      const p = new Vector3();
      if (!off || !this.localPoint("head", off, p)) return { x: 0, y: 0, c: 0 };
      return project(p);
    };
    const ls = joint("upperArm.L");
    const rs = joint("upperArm.R");
    let neck: Keypoint = { x: 0, y: 0, c: 0 };
    if (ls.c > 0 && rs.c > 0) neck = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, c: 1 };
    else if (ls.c > 0) neck = { ...ls };
    else if (rs.c > 0) neck = { ...rs };

    const body: Keypoint[] = [
      anchor("nose"),
      neck,
      rs,
      joint("lowerArm.R"),
      joint("hand.R"),
      ls,
      joint("lowerArm.L"),
      joint("hand.L"),
      joint("upperLeg.R"),
      joint("lowerLeg.R"),
      joint("foot.R"),
      joint("upperLeg.L"),
      joint("lowerLeg.L"),
      joint("foot.L"),
      anchor("right_eye"),
      anchor("left_eye"),
      anchor("right_ear"),
      anchor("left_ear"),
    ];
    return {
      body,
      handL: this.sampleHand("L", project),
      handR: this.sampleHand("R", project),
      face: this.sampleFace(project),
    };
  }

  private sampleHand(side: "L" | "R", project: (w: Vector3) => Keypoint): Keypoint[] {
    const out: Keypoint[] = [];
    out.push(this.projectBone(`hand.${side}`, project));
    for (const finger of ["thumb", "index", "middle", "ring", "pinky"]) {
      for (let i = 1; i <= 3; i++) {
        const name = `${finger}${i}.${side}`;
        if (i < 3) out.push(this.projectBone(name, project));
        else {
          out.push(this.projectBone(name, project));
          const tip = new Vector3();
          if (this.tipWorld(name, tip)) out.push(project(tip));
          else out.push({ x: 0, y: 0, c: 0 });
        }
      }
    }
    return out;
  }

  private projectBone(name: string, project: (w: Vector3) => Keypoint): Keypoint {
    const bone = this.bones.get(name);
    if (!bone) return { x: 0, y: 0, c: 0 };
    const p = new Vector3();
    bone.getWorldPosition(p);
    return project(p);
  }

  private sampleFace(project: (w: Vector3) => Keypoint): Keypoint[] {
    const len = headLength(this.segments);
    return posedLandmarks(len, this.data.face, this.data.faceOffsets).map((off) => {
      const p = new Vector3();
      if (!this.localPoint("head", off, p)) return { x: 0, y: 0, c: 0 };
      return project(p);
    });
  }

  private occluded(point: Vector3, camera: PerspectiveCamera, raycaster: Raycaster): boolean {
    const dir = point.clone().sub(camera.position);
    const dist = dir.length();
    if (dist < 1e-4) return false;
    dir.multiplyScalar(1 / dist);
    // Joints sit inside the mesh, so the ray always enters the limb a few
    // centimeters early. Only count a hit that is clearly in front of that.
    const slop = Math.max(0.08, (this.data.params.heightCm / 100) * 0.09);
    raycaster.set(camera.position, dir);
    raycaster.far = Math.max(0.01, dist - slop);
    const hits = raycaster.intersectObject(this.mesh, false);
    return hits.length > 0;
  }

  /** Lowest sole estimate in world Y, for snap-to-ground. */
  soleY(): number {
    let min = Infinity;
    const p = new Vector3();
    for (const side of ["L", "R"] as const) {
      const bone = this.bones.get(`foot.${side}`);
      const seg = this.segMap.get(`foot.${side}`);
      if (bone && seg) {
        const heel = footHeel(seg);
        if (heel) {
          p.set(
            heel.center.x - seg.head.x,
            heel.center.y - seg.head.y - heel.ry,
            heel.center.z - seg.head.z,
          );
          bone.localToWorld(p);
          min = Math.min(min, p.y);
        } else {
          bone.getWorldPosition(p);
          min = Math.min(min, p.y - Math.max(seg.rx0, seg.rz0) * this.data.scale);
        }
        if (this.tipWorld(`foot.${side}`, p)) min = Math.min(min, p.y - seg.rz1 * this.data.scale);
      }
      for (const toe of TOE_DIGITS) {
        const name = `${toe.name}${toe.bones}.${side}`;
        const tseg = this.segMap.get(name);
        if (!tseg || !this.tipWorld(name, p)) continue;
        min = Math.min(min, p.y - Math.min(tseg.rx1, tseg.rz1) * this.data.scale);
      }
    }
    return min;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.beauty.dispose();
    this.anima.dispose();
    this.clay.dispose();
    this.wire.dispose();
    this.mask.dispose();
    this.normal.dispose();
    this.boneLines.geometry.dispose();
    (this.boneLines.material as LineBasicMaterial).dispose();
    for (const m of this.markers.values()) (m.material as MeshBasicMaterial).dispose();
    this.facePoints.geometry.dispose();
    (this.facePoints.material as PointsMaterial).dispose();
    this.faceLines.geometry.dispose();
    (this.faceLines.material as LineBasicMaterial).dispose();
    this.group.removeFromParent();
  }

  /**
   * Viewport body. Exports call this with the mesh forced on and the sticks off
   * so conditioning images stay solid even in skeleton view.
   */
  setViewportBody(showBody: boolean) {
    const on = this.data.visible;
    this.mesh.visible = on && showBody;
    this.boneLines.visible = on && !showBody;
    if (this.boneLines.visible) this.syncSkeletonLines();
  }

  private syncSkeletonLines() {
    const n = this.segments.length * 6;
    if (this.linePositions.length < n) this.linePositions = new Float32Array(n);
    let o = 0;
    for (const seg of this.segments) {
      const bone = this.bones.get(seg.name);
      if (!bone || !this.tipWorld(seg.name, this.lineB)) continue;
      bone.getWorldPosition(this.lineA);
      this.group.worldToLocal(this.lineA);
      this.group.worldToLocal(this.lineB);
      this.linePositions[o++] = this.lineA.x;
      this.linePositions[o++] = this.lineA.y;
      this.linePositions[o++] = this.lineA.z;
      this.linePositions[o++] = this.lineB.x;
      this.linePositions[o++] = this.lineB.y;
      this.linePositions[o++] = this.lineB.z;
    }
    const geom = this.boneLines.geometry;
    const attr = geom.getAttribute("position");
    if (!attr || attr.count !== o / 3) {
      geom.setAttribute("position", new Float32BufferAttribute(this.linePositions.slice(0, o), 3));
    } else {
      (attr.array as Float32Array).set(this.linePositions.subarray(0, o));
      attr.needsUpdate = true;
    }
    (this.boneLines.material as LineBasicMaterial).color.set(this.data.color);
  }

  setMarkerStyle(selectedBone: string | null, hovered: string | null, show: boolean) {
    for (const [name, marker] of this.markers) {
      const mat = marker.material as MeshBasicMaterial;
      const selected = name === selectedBone;
      marker.visible = show && this.data.visible && (selected || !marker.userData.finger || show);
      if (!show) marker.visible = false;
      mat.color.set(selected ? "#ffe08a" : name === hovered ? "#ffffff" : this.data.color);
      const base = marker.userData.finger ? 0.012 : 0.02;
      const h = Math.max(0.4, this.data.params.heightCm / 100);
      marker.scale.setScalar(base * h * (selected ? 1.45 : 1));
    }
  }
}
