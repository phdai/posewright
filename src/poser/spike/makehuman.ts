/**
 * SPIKE. Load the converted MakeHuman body (see convert-makehuman.ts) as a three.js
 * SkinnedMesh on its own 163-bone skeleton. Not used by the app.
 */
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  type Material,
} from "three";

export type MhBone = { name: string; parent: string | null; head: [number, number, number]; tail: [number, number, number] };

export type MhBody = {
  group: Group;
  mesh: SkinnedMesh;
  bones: Map<string, Bone>;
  /** Rest height in metres (feet at y = 0). */
  height: number;
};

export function parseMakeHuman(buf: ArrayBuffer) {
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const text = new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)).replace(/\0+$/, "");
  const header = JSON.parse(text) as { vertexCount: number; triangleCount: number; bones: MhBone[] };
  const n = header.vertexCount;
  const t = header.triangleCount;
  let o = 4 + headerLen;
  const positions = new Float32Array(buf.slice(o, o + n * 12));
  o += n * 12;
  const index = new Uint16Array(buf.slice(o, o + t * 6));
  o += t * 6;
  o += (4 - (o % 4)) % 4;
  const skinIndex = new Uint16Array(buf.slice(o, o + n * 8));
  o += n * 8;
  const skinWeight = new Float32Array(buf.slice(o, o + n * 16));
  return { header, positions, index, skinIndex, skinWeight };
}

export function buildMakeHuman(buf: ArrayBuffer, material: Material): MhBody {
  const { header, positions, index, skinIndex, skinWeight } = parseMakeHuman(buf);
  const geom = new BufferGeometry();
  geom.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geom.setIndex(Array.from(index));
  geom.setAttribute("skinIndex", new Uint16BufferAttribute(skinIndex, 4));
  geom.setAttribute("skinWeight", new Float32BufferAttribute(skinWeight, 4));
  geom.computeVertexNormals();

  // Bones carry no rest rotation: each sits at its head, offset from the parent's head.
  const bones = new Map<string, Bone>();
  const list: Bone[] = [];
  const heads = new Map(header.bones.map((b) => [b.name, new Vector3(...b.head)]));
  let root: Bone | null = null;
  for (const b of header.bones) {
    const bone = new Bone();
    bone.name = b.name;
    const head = heads.get(b.name) as Vector3;
    const parent = b.parent ? bones.get(b.parent) : undefined;
    if (parent) {
      bone.position.copy(head).sub(heads.get(b.parent as string) as Vector3);
      parent.add(bone);
    } else {
      bone.position.copy(head);
      root = bone;
    }
    bones.set(b.name, bone);
    list.push(bone);
  }
  const mesh = new SkinnedMesh(geom, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const group = new Group();
  group.add(mesh);
  if (root) mesh.add(root);
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(list));
  geom.computeBoundingBox();
  const height = geom.boundingBox ? geom.boundingBox.max.y - geom.boundingBox.min.y : 1.7;
  return { group, mesh, bones, height };
}

/** Rotate `bone` so the direction from its head to `tip()` points along `dir` (world space). */
function aim(body: MhBody, boneName: string, tipName: string, dir: Vector3) {
  const bone = body.bones.get(boneName);
  const tip = body.bones.get(tipName);
  if (!bone || !tip || !bone.parent) return;
  body.group.updateMatrixWorld(true);
  const head = bone.getWorldPosition(new Vector3());
  const cur = tip.getWorldPosition(new Vector3()).sub(head).normalize();
  const q = new Quaternion().setFromUnitVectors(cur, dir.clone().normalize());
  const p = bone.parent.getWorldQuaternion(new Quaternion());
  const delta = p.clone().invert().multiply(q).multiply(p);
  bone.quaternion.premultiply(delta);
  body.group.updateMatrixWorld(true);
}

/** MakeHuman rests in an A-pose. Straighten both arms out to the sides. */
export function toTPose(body: MhBody) {
  for (const [side, sign] of [
    ["L", 1],
    ["R", -1],
  ] as const) {
    aim(body, `upperarm01.${side}`, `lowerarm01.${side}`, new Vector3(sign, 0, 0));
    aim(body, `lowerarm01.${side}`, `wrist.${side}`, new Vector3(sign, 0, 0));
  }
}
