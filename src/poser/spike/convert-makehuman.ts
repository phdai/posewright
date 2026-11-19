/**
 * SPIKE. Convert the MakeHuman base mesh, default skeleton and weights (all CC0)
 * into one compact binary for the browser. Not used by the app.
 *
 *   node --experimental-strip-types src/poser/spike/convert-makehuman.ts <makehuman/data> <out.bin>
 *
 * <makehuman/data> is `makehuman/data` from github.com/makehumancommunity/makehuman
 * (needs 3dobjs/base.obj, rigs/default.mhskel, rigs/default_weights.mhw).
 *
 * Output layout (little endian):
 *   u32 headerBytes | header JSON (utf8, padded to 4) |
 *   f32 position[n*3] (metres, feet at y = 0) | u16 index[t*3] |
 *   u16 skinIndex[n*4] | f32 skinWeight[n*4]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Mesh groups kept: the skin and the eyeballs. Clothing helpers, teeth, tongue and lashes are dropped. */
const KEEP = new Set(["body", "helper-l-eye", "helper-r-eye"]);
const DM_TO_M = 0.1;

type Skeleton = {
  bones: Record<string, { head: string; tail: string; parent: string | null }>;
  joints: Record<string, number[]>;
};

export function convert(dataDir: string): Uint8Array {
  const obj = readFileSync(join(dataDir, "3dobjs/base.obj"), "utf8");
  const all: [number, number, number][] = [];
  const faces: number[][] = [];
  let group = "";
  for (const line of obj.split("\n")) {
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.trim().split(/\s+/);
      all.push([Number(x), Number(y), Number(z)]);
    } else if (line.startsWith("g ")) {
      group = line.trim().slice(2);
    } else if (line.startsWith("f ") && KEEP.has(group)) {
      faces.push(line.trim().split(/\s+/).slice(1).map((t) => Number(t.split("/")[0]) - 1));
    }
  }

  // Compact the kept vertices.
  const remap = new Map<number, number>();
  const used: number[] = [];
  for (const f of faces) for (const v of f) if (!remap.has(v)) {
    remap.set(v, used.length);
    used.push(v);
  }
  let minY = Infinity;
  for (const v of used) minY = Math.min(minY, all[v][1]);
  const toM = (p: [number, number, number]): [number, number, number] => [
    p[0] * DM_TO_M,
    (p[1] - minY) * DM_TO_M,
    p[2] * DM_TO_M,
  ];

  const positions = new Float32Array(used.length * 3);
  used.forEach((v, i) => positions.set(toM(all[v]), i * 3));
  const tris: number[] = [];
  for (const f of faces) {
    const ids = f.map((v) => remap.get(v) as number);
    for (let k = 1; k + 1 < ids.length; k++) tris.push(ids[0], ids[k], ids[k + 1]);
  }

  // Skeleton: each joint is the centroid of a vertex group (joint-* helper cubes).
  const skel = JSON.parse(readFileSync(join(dataDir, "rigs/default.mhskel"), "utf8")) as Skeleton;
  const joint = (name: string) => {
    const ids = skel.joints[name];
    const c: [number, number, number] = [0, 0, 0];
    for (const i of ids) for (let k = 0; k < 3; k++) c[k] += all[i][k] / ids.length;
    return toM(c);
  };
  const names = Object.keys(skel.bones);
  // Parents before children.
  const order: string[] = [];
  const visit = (n: string) => {
    if (order.includes(n)) return;
    const p = skel.bones[n].parent;
    if (p) visit(p);
    order.push(n);
  };
  names.forEach(visit);
  const boneIndex = new Map(order.map((n, i) => [n, i]));
  const bones = order.map((n) => ({
    name: n,
    parent: skel.bones[n].parent,
    head: joint(skel.bones[n].head),
    tail: joint(skel.bones[n].tail),
  }));

  // Weights: keep the four largest per vertex, renormalised.
  const mhw = JSON.parse(readFileSync(join(dataDir, "rigs/default_weights.mhw"), "utf8")) as {
    weights: Record<string, [number, number][]>;
  };
  const influences: [number, number][][] = used.map(() => []);
  for (const [bone, list] of Object.entries(mhw.weights)) {
    const b = boneIndex.get(bone);
    if (b === undefined) continue;
    for (const [v, w] of list) {
      const i = remap.get(v);
      if (i !== undefined && w > 0) influences[i].push([b, w]);
    }
  }
  const skinIndex = new Uint16Array(used.length * 4);
  const skinWeight = new Float32Array(used.length * 4);
  let unweighted = 0;
  influences.forEach((list, i) => {
    list.sort((a, b) => b[1] - a[1]);
    const top = list.slice(0, 4);
    const sum = top.reduce((s, x) => s + x[1], 0);
    if (!top.length) unweighted++;
    top.forEach(([b, w], k) => {
      skinIndex[i * 4 + k] = b;
      skinWeight[i * 4 + k] = sum > 0 ? w / sum : 0;
    });
    if (!top.length) skinWeight[i * 4] = 1; // bone 0 (root)
  });

  const header = new TextEncoder().encode(
    JSON.stringify({
      source: "MakeHuman base mesh, default skeleton and weights (CC0 1.0), github.com/makehumancommunity/makehuman",
      vertexCount: used.length,
      triangleCount: tris.length / 3,
      unweighted,
      bones,
    }),
  );
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const headerLen = header.length + pad(header.length);
  const indexBytes = tris.length * 2;
  const parts = [
    new Uint32Array([headerLen]),
    header,
    new Uint8Array(pad(header.length)),
    positions,
    new Uint16Array(tris),
    new Uint8Array(pad(indexBytes)),
    skinIndex,
    new Uint8Array(pad(skinIndex.byteLength)),
    skinWeight,
  ];
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
    o += p.byteLength;
  }
  return out;
}

if (process.argv[1]?.endsWith("convert-makehuman.ts")) {
  const [dataDir, outPath] = process.argv.slice(2);
  if (!dataDir || !outPath) throw new Error("usage: convert-makehuman.ts <makehuman/data> <out.bin>");
  const bin = convert(dataDir);
  writeFileSync(outPath, bin);
  console.log(`wrote ${outPath}: ${(bin.byteLength / 1024).toFixed(0)} KiB`);
}
