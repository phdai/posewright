/**
 * SPIKE page: Classic procedural body next to the MakeHuman body, both in a T-pose,
 * rendered as the viewport, Clay and Depth. Not part of the app: the dev server does
 * not route a page to it, so inject it into any page on the dev server, e.g. in the
 * console: `import("/src/poser/spike/main.ts")`.
 */
import {
  CircleGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { FigureView, createDepthMaterial } from "../figure.ts";
import { POSE_PRESETS } from "../pose.ts";
import { makeFigure } from "../state.ts";
import { buildMakeHuman, toTPose } from "./makehuman.ts";
import binUrl from "./mh-base.bin?url";

const SIZE = 480;
const HEIGHT_M = 1.666;

type Mode = "viewport" | "clay" | "depth" | "close";

async function main() {
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  // Classic body: default figure at the same height, androgynous to match the MakeHuman base.
  const fig = makeFigure(1);
  fig.params = { ...fig.params, sex: 0.5, heightCm: HEIGHT_M * 100 };
  fig.pose = { ...(POSE_PRESETS.find((p) => p.id === "t")?.pose ?? {}) };
  const classic = new FigureView(fig);
  classic.updateSkeleton(true, null);
  classic.setViewportBody(true);
  for (const m of classic.markers.values()) m.visible = false;

  const res = await fetch(binUrl);
  const mhMat = new MeshStandardMaterial({ color: "#8fb3a6", roughness: 0.64, metalness: 0.02 });
  const mh = buildMakeHuman(await res.arrayBuffer(), mhMat);
  const s = HEIGHT_M / mh.height;
  mh.group.scale.setScalar(s);
  toTPose(mh);

  const bodies: { name: string; root: Object3D; mesh: Mesh; beauty: Material }[] = [
    { name: "Classic", root: classic.group, mesh: classic.mesh, beauty: classic.beauty },
    { name: "MakeHuman", root: mh.group, mesh: mh.mesh, beauty: mhMat },
  ];

  const camera = new PerspectiveCamera(40, 1, 0.05, 50);
  camera.position.set(1.3, 1.25, 3.4);
  camera.lookAt(0, 0.9, 0);
  camera.updateMatrixWorld();
  const close = new PerspectiveCamera(35, 1, 0.05, 50);
  close.position.set(0.75, 1.5, 1.35);
  close.lookAt(0, 1.3, 0);
  close.updateMatrixWorld();

  const clay = new MeshStandardMaterial({ color: "#9c9c9c", roughness: 1, metalness: 0 });
  const depth = createDepthMaterial();
  const ground = new Mesh(new CircleGeometry(16, 64), new MeshStandardMaterial({ color: "#1a1f24", roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const grid = new GridHelper(10, 20, 0x44515c, 0x2c343c);
  grid.position.y = 0.001;
  const catcher = new Mesh(new PlaneGeometry(60, 60), new ShadowMaterial({ opacity: 0.3 }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.receiveShadow = true;

  document.body.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = `body{margin:0;padding:16px;background:#0d1014;color:#c9d1d9;font:14px system-ui,sans-serif}
    section{display:flex;flex-wrap:wrap;gap:8px}h2{width:100%;font-size:14px;margin:12px 0 4px}
    canvas{width:360px;height:360px;border:1px solid #2c343c}`;
  document.head.appendChild(style);
  const out = document.createElement("div");
  out.innerHTML = "<p>Spike: Classic body vs MakeHuman base mesh (CC0), T-pose. Viewport, Clay, Depth.</p>";
  document.body.appendChild(out);
  for (const body of bodies) {
    const row = document.createElement("section");
    row.innerHTML = `<h2>${body.name}</h2>`;
    out.appendChild(row);
    for (const mode of ["viewport", "clay", "depth", "close"] as Mode[]) {
      const scene = new Scene();
      const hemi = new HemisphereLight();
      const sun = new DirectionalLight();
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = sun.shadow.camera.bottom = -3;
      sun.shadow.camera.right = sun.shadow.camera.top = 3;
      sun.shadow.camera.far = 20;
      scene.add(hemi, sun, sun.target, body.root);
      if (mode === "viewport") {
        scene.background = new Color("#14181d");
        hemi.color.set("#d5e2ea");
        hemi.groundColor.set("#3a342c");
        hemi.intensity = 0.85;
        sun.color.set("#fff6ea");
        sun.intensity = 1.35;
        sun.position.set(2.4, 4.2, 2.2);
        scene.add(ground, grid);
        body.mesh.material = body.beauty;
        renderer.toneMapping = NeutralToneMapping;
      } else if (mode === "clay" || mode === "close") {
        scene.background = new Color("#d6d6d6");
        hemi.color.set("#ffffff");
        hemi.groundColor.set("#b4b1ab");
        hemi.intensity = 2.3;
        sun.intensity = 2.6;
        sun.shadow.radius = 6;
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.015;
        const toCam = camera.position.clone().setY(0).normalize();
        const left = new Vector3().crossVectors(new Vector3(0, 1, 0), toCam).normalize();
        sun.position.copy(toCam.multiplyScalar(0.9).addScaledVector(left, 0.6).add(new Vector3(0, 1.4, 0)).normalize().multiplyScalar(8));
        scene.add(catcher);
        body.mesh.material = clay;
        renderer.toneMapping = NeutralToneMapping;
      } else {
        scene.background = new Color("#000000");
        const d = camera.position.distanceTo(new Vector3(0, 0.9, 0));
        depth.uniforms.uNear.value = d - 0.45;
        depth.uniforms.uFar.value = d + 0.45;
        body.mesh.material = depth;
        renderer.toneMapping = NoToneMapping;
      }
      renderer.render(scene, mode === "close" ? close : camera);
      const c = document.createElement("canvas");
      c.width = c.height = SIZE;
      c.getContext("2d")?.drawImage(renderer.domElement, 0, 0);
      c.title = `${body.name} ${mode}`;
      row.appendChild(c);
      scene.remove(body.root);
    }
  }
  (window as unknown as { __spike: { ready: boolean } }).__spike = { ready: true };
}

void main();
