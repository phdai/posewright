import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import type { BodyParams } from "./types.ts";
import type { Segment } from "./proportions.ts";
import { footHeel } from "./proportions.ts";

/**
 * Procedural skinned body. Vertices are in figure space at the T-pose.
 * Each vertex is bound to its segment bone, with a blend onto the parent
 * near the joint so elbows and knees bend instead of cracking.
 * The geometry is non-indexed and carries a barycentric attribute so the
 * wireframe export can draw edges in a shader (WebGL line width is unreliable).
 */

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  skinI: number[] = [];
  skinW: number[] = [];
  idx: number[] = [];

  push(p: Vector3, n: Vector3, bone: number, parent: number, parentWeight: number): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, p.y, p.z);
    const nn = n.lengthSq() > 1e-8 ? n.clone().normalize() : new Vector3(0, 1, 0);
    this.nrm.push(nn.x, nn.y, nn.z);
    const pw = parent >= 0 ? parentWeight : 0;
    this.skinI.push(bone, parent >= 0 ? parent : 0, 0, 0);
    this.skinW.push(1 - pw, pw, 0, 0);
    return i;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
}

function frame(dir: Vector3): { x: Vector3; y: Vector3; z: Vector3 } {
  const y = dir.clone().normalize();
  const x = new Vector3(1, 0, 0).addScaledVector(y, -y.x);
  if (x.lengthSq() < 1e-6) x.set(0, 0, 1).addScaledVector(y, -y.z);
  x.normalize();
  const z = new Vector3().crossVectors(x, y);
  if (z.z < 0) {
    z.negate();
    x.negate();
  }
  z.normalize();
  return { x, y, z };
}

function addTube(b: Builder, seg: Segment, bone: number, parent: number) {
  const head = new Vector3(seg.head.x, seg.head.y, seg.head.z);
  const tail = new Vector3(seg.tail.x, seg.tail.y, seg.tail.z);
  const delta = tail.clone().sub(head);
  const len = delta.length();
  if (len < 1e-5) return;
  const { x: sx, y: axis, z: sz } = frame(delta);
  const rings = seg.rings;
  const segs = seg.radial;
  const row = segs + 1;
  const start = b.pos.length / 3;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const center = head.clone().lerp(tail, t);
    const rx = seg.rx0 + (seg.rx1 - seg.rx0) * t;
    const rz = seg.rz0 + (seg.rz1 - seg.rz0) * t;
    const pw = parent >= 0 && t < 0.25 ? (1 - t / 0.25) * 0.45 : 0;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const radial = new Vector3().addScaledVector(sx, c).addScaledVector(sz, sn);
      const p = center.clone().addScaledVector(sx, c * Math.max(rx, 0.002)).addScaledVector(sz, sn * Math.max(rz, 0.002));
      b.push(p, radial, bone, parent, pw);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = start + r * row + s;
      const c = a + row;
      // Outward-facing quads. `radial` points out; CCW when viewed from outside.
      b.tri(a, c, a + 1);
      b.tri(a + 1, c, c + 1);
    }
  }
  // Caps so depth and normals stay closed at fingertips and limb ends.
  const n0 = axis.clone().negate();
  const cap0 = b.push(head, n0, bone, parent, parent >= 0 ? 0.45 : 0);
  for (let s = 0; s < segs; s++) b.tri(cap0, start + s + 1, start + s);
  const n1 = axis.clone();
  const cap1 = b.push(tail, n1, bone, parent, 0);
  const ring = start + rings * row;
  for (let s = 0; s < segs; s++) b.tri(cap1, ring + s, ring + s + 1);
}

function addEllipsoid(
  b: Builder,
  center: Vector3,
  rx: number,
  ry: number,
  rz: number,
  bone: number,
  parent: number,
  stacks: number,
  slices: number,
  nose: boolean,
  blend = true,
) {
  const start = b.pos.length / 3;
  for (let iy = 0; iy <= stacks; iy++) {
    const phi = (iy / stacks) * Math.PI;
    const y = Math.cos(phi);
    const r = Math.sin(phi);
    const pw = blend && parent >= 0 && phi > 2.4 ? ((phi - 2.4) / (Math.PI - 2.4)) * 0.4 : 0;
    for (let ix = 0; ix <= slices; ix++) {
      const theta = (ix / slices) * Math.PI * 2;
      let x = Math.cos(theta) * r;
      let z = Math.sin(theta) * r;
      if (nose) {
        const front = Math.max(0, z);
        const band = Math.exp(-((y - 0.05) ** 2) / 0.08) * Math.exp(-(x * x) / 0.05);
        z += front * band * 0.22;
      }
      const p = new Vector3(center.x + x * rx, center.y + y * ry, center.z + z * rz);
      const n = new Vector3(x / Math.max(rx, 1e-4), y / Math.max(ry, 1e-4), z / Math.max(rz, 1e-4));
      b.push(p, n, bone, parent, pw);
    }
  }
  const row = slices + 1;
  for (let iy = 0; iy < stacks; iy++) {
    for (let ix = 0; ix < slices; ix++) {
      const a = start + iy * row + ix;
      const c = a + row;
      b.tri(a, c, a + 1);
      b.tri(a + 1, c, c + 1);
    }
  }
}

export function buildFigureGeometry(
  segments: Segment[],
  params: BodyParams,
  boneIndex: Map<string, number>,
  /** `chest: false` leaves out the chest volume (used by the neutral and mannequin clay bodies). */
  opts: { chest?: boolean } = {},
): BufferGeometry {
  const b = new Builder();
  const byName = new Map(segments.map((s) => [s.name, s]));
  for (const seg of segments) {
    const bone = boneIndex.get(seg.name);
    if (bone === undefined) continue;
    const parent = seg.parent ? (boneIndex.get(seg.parent) ?? -1) : -1;
    if (seg.kind === "ellipsoid") {
      const center = new Vector3(
        (seg.head.x + seg.tail.x) / 2,
        (seg.head.y + seg.tail.y) / 2,
        (seg.head.z + seg.tail.z) / 2,
      );
      const ry = Math.max(0.01, Math.abs(seg.tail.y - seg.head.y) / 2);
      addEllipsoid(b, center, seg.rx0, ry, seg.rz0, bone, parent, seg.rings, seg.radial, seg.name === "head");
    } else {
      addTube(b, seg, bone, parent);
    }
  }

  // Chest volume for an adult female-leaning presentation. Scaled off below ~14
  // so children stay child-shaped. Geometric, not detailed.
  const chest = byName.get("chest");
  const chestBone = boneIndex.get("chest");
  if (opts.chest !== false && chest && chestBone !== undefined && params.sex < 0.8 && params.age > 14) {
    const k = (1 - params.sex) * Math.min(1, (params.age - 14) / 8);
    const y = chest.head.y + (chest.tail.y - chest.head.y) * 0.45;
    const r = chest.rx0 * 0.42 * (0.35 + k);
    const parent = chest.parent ? (boneIndex.get(chest.parent) ?? -1) : -1;
    for (const sign of [1, -1]) {
      addEllipsoid(
        b,
        new Vector3(sign * chest.rx0 * 0.55, y, chest.rz0 * 0.72),
        r,
        r * 0.85,
        r * 0.95,
        chestBone,
        parent,
        6,
        8,
        false,
      );
    }
  }

  for (const seg of segments) {
    if (!seg.name.startsWith("foot.")) continue;
    const bone = boneIndex.get(seg.name);
    const heel = footHeel(seg);
    if (bone === undefined || !heel) continue;
    const parent = seg.parent ? (boneIndex.get(seg.parent) ?? -1) : -1;
    addEllipsoid(
      b,
      new Vector3(heel.center.x, heel.center.y, heel.center.z),
      heel.rx,
      heel.ry,
      heel.rz,
      bone,
      parent,
      8,
      10,
      false,
      false,
    );
  }

  const geom = new BufferGeometry();
  geom.setAttribute("position", new Float32BufferAttribute(b.pos, 3));
  geom.setAttribute("normal", new Float32BufferAttribute(b.nrm, 3));
  geom.setAttribute("skinIndex", new Uint16BufferAttribute(b.skinI, 4));
  geom.setAttribute("skinWeight", new Float32BufferAttribute(b.skinW, 4));
  geom.setIndex(b.idx);
  const non = geom.toNonIndexed();
  geom.dispose();
  const count = non.getAttribute("position").count;
  const bary = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 3) {
    bary[i * 3] = 1;
    bary[i * 3 + 4] = 1;
    bary[i * 3 + 8] = 1;
  }
  non.setAttribute("barycentric", new BufferAttribute(bary, 3));
  non.computeBoundingSphere();
  if (non.boundingSphere) non.boundingSphere.radius *= 1.6;
  return non;
}

export function triangleCount(geom: BufferGeometry): number {
  const pos = geom.getAttribute("position");
  return pos ? pos.count / 3 : 0;
}
