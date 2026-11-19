import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import { PoserEngine } from "../engine.ts";
import { BODY_PRESETS, MAX_FIGURES } from "../state.ts";
import { POSE_PRESETS, jointGroup, jointLabel, jointNames, limitsFor } from "../pose.ts";
import { FACE_GROUPS, FACE_PRESETS, faceGroupOf } from "../face.ts";
import { RESOLUTIONS, snapResolution } from "../resolution.ts";
import { heightLimits } from "../proportions.ts";
import type { BodyParams, FaceShape, FigureData, GizmoTool, HandPreset, ToePreset } from "../types.ts";

const HANDS: { id: HandPreset; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "relaxed", label: "Relaxed" },
  { id: "fist", label: "Fist" },
  { id: "point", label: "Point" },
  { id: "grip", label: "Grip" },
];

const TOES: { id: ToePreset; label: string }[] = [
  { id: "open", label: "Straight" },
  { id: "relaxed", label: "Relaxed" },
  { id: "curl", label: "Curl" },
];

export function PoserApp() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PoserEngine | null>(null);
  const [engine, setEngine] = useState<PoserEngine | null>(null);
  const [help, setHelp] = useState(false);
  const [tab, setTab] = useState<"stage" | "figure" | "pose" | "face" | "export">("stage");
  const [workspace, setWorkspace] = useState<"pose" | "face">("pose");
  const previews = useRef<Record<string, HTMLCanvasElement | null>>({});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const eng = new PoserEngine(host);
    eng.onHelp = () => setHelp((v) => !v);
    engineRef.current = eng;
    setEngine(eng);
    return () => {
      eng.dispose();
      engineRef.current = null;
    };
  }, []);

  const snap = useSyncExternalStore(
    (cb) => engine?.subscribe(cb) ?? (() => {}),
    () => engine?.getSnapshot() ?? null,
    () => null,
  );
  const state = snap?.state;

  useEffect(() => {
    if (!engine) return;
    const els = previews.current;
    engine.setPreviewCanvases({
      pose: els.pose ?? undefined,
      wire: els.wire ?? undefined,
      depth: els.depth ?? undefined,
      normal: els.normal ?? undefined,
      mask: els.mask ?? undefined,
      model: els.model ?? undefined,
      align: els.align ?? undefined,
    });
  }, [engine, tab]);

  const selected = state?.figures.find((f) => f.id === state.selection.figureId) ?? null;

  useEffect(() => {
    if (!engine) return;
    engine.setFaceEdit(workspace === "face", true);
  }, [engine, workspace, selected?.id]);

  const openWorkspace = (next: "pose" | "face") => {
    setWorkspace(next);
    setTab(next);
  };

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className={`${panelClass(tab === "figure")} lg:flex lg:w-80 lg:flex-col lg:border-r`}>
          {engine && state && (
            <FigurePanel engine={engine} figures={state.figures} selected={selected} atCap={state.figures.length >= MAX_FIGURES} />
          )}
        </aside>
        <div className={`${tab === "stage" || tab === "face" ? "flex" : "hidden"} relative min-h-[40vh] flex-1 flex-col lg:flex`}>
          <div ref={hostRef} className="relative min-h-0 w-full flex-1 overflow-hidden" />
        </div>
        <aside className={`${tab === "pose" || tab === "face" || tab === "export" ? "flex" : "hidden"} min-h-0 flex-col lg:flex lg:w-96 lg:border-l`}>
          {engine && state && (
            <div className={`${tab === "pose" || tab === "face" ? "flex" : "hidden"} min-h-0 flex-1 flex-col lg:flex ${tab === "face" ? "max-h-[52%] lg:max-h-none" : ""}`}>
              <div className="flex gap-1 border-b border-line p-2">
                <button type="button" title="Body joints" className={chip(workspace === "pose")} onClick={() => openWorkspace("pose")}>
                  Body
                </button>
                <button type="button" title="Shape the OpenPose face landmarks" className={chip(workspace === "face")} onClick={() => openWorkspace("face")}>
                  Face
                </button>
              </div>
              {workspace === "face" && selected ? (
                <FacePanel engine={engine} figure={selected} facePoint={state.selection.facePoint ?? null} />
              ) : (
                engine && selected && (
                  <PosePanel
                    engine={engine}
                    figure={selected}
                    figures={state.figures}
                    bone={state.selection.bone}
                    limits={state.jointLimits}
                    showBody={state.showBody}
                    tool={state.tool}
                  />
                )
              )}
            </div>
          )}
          {engine && state && (
            <div className={`${tab === "export" ? "flex" : "hidden"} min-h-0 flex-1 flex-col lg:max-h-[46%] lg:flex`}>
              <ExportPanel
                engine={engine}
                warning={state.warning}
                settings={state.export}
                previews={previews}
                count={state.figures.length}
              />
            </div>
          )}
        </aside>
      </div>
      <nav className="flex border-t border-line lg:hidden">
        {(
          [
            ["stage", "Stage"],
            ["figure", "Figure"],
            ["pose", "Pose"],
            ["face", "Face"],
            ["export", "Export"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            title={`Show the ${label.toLowerCase()} panel`}
            className={`min-h-11 flex-1 text-xs ${tab === id ? "bg-surface-2 text-accent" : "text-muted"}`}
            onClick={() => {
              setTab(id);
              if (id === "face" || id === "pose") setWorkspace(id);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {engine && state && (
        <footer className="flex items-center gap-2 overflow-x-auto border-t border-line bg-surface px-3 py-2">
          <button
            type="button"
            title="Orbit around a target (C)"
            className={chip(engine.getMode() === "orbit")}
            onClick={() => engine.setCameraMode("orbit")}
          >
            Orbit
          </button>
          <button
            type="button"
            title="Fly with WASD. A strafes left, D strafes right, Q down, E up (C)"
            className={chip(engine.getMode() === "fly")}
            onClick={() => engine.setCameraMode("fly")}
          >
            Fly
          </button>
          <label className="flex items-center gap-2 text-xs text-muted" title="Vertical field of view, 20 to 100 degrees">
            FOV
            <input
              type="range"
              min={20}
              max={100}
              value={Math.round(engine.getFov())}
              onChange={(e) => engine.setFov(Number(e.target.value))}
              className="w-24"
            />
          </label>
          <button type="button" title="Frame every visible figure (F frames the selection)" className={chip(false)} onClick={() => engine.frameAll()}>
            Frame all
          </button>
          <button type="button" title="Frame the selected figure (F)" className={chip(false)} onClick={() => engine.frameSelected()}>
            Frame
          </button>
          <button type="button" title="Reset camera to the default view" className={chip(false)} onClick={() => engine.resetCamera()}>
            Reset
          </button>
          <button type="button" title="Undo (Ctrl+Z)" className={chip(false)} onClick={() => engine.undo()}>
            Undo
          </button>
          <button type="button" title="Redo (Ctrl+Shift+Z)" className={chip(false)} onClick={() => engine.redo()}>
            Redo
          </button>
          <button type="button" title="Keyboard shortcuts (?)" className={chip(false)} onClick={() => setHelp(true)}>
            ?
          </button>
          <span className="ml-auto hidden text-xs text-muted sm:inline">
            {state.figures.length}/{MAX_FIGURES} · {state.jointLimits ? "Limits on" : "Limits off"}
          </span>
        </footer>
      )}
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}

function panelClass(show: boolean) {
  return `${show ? "flex" : "hidden"} min-h-0 flex-col border-line bg-surface lg:max-h-none`;
}

function chip(active: boolean) {
  return `min-h-11 shrink-0 rounded-sm border px-2 text-xs ${active ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface-2 text-fg"}`;
}

function btn(active = false) {
  return `min-h-11 shrink-0 rounded-sm border px-2 text-xs ${active ? "border-accent text-accent" : "border-line bg-surface-2 text-fg hover:border-accent"} disabled:opacity-40`;
}

function FigurePanel({
  engine,
  figures,
  selected,
  atCap,
}: {
  engine: PoserEngine;
  figures: FigureData[];
  selected: FigureData | null;
  atCap: boolean;
}) {
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-wide">Posewright</h1>
        <button type="button" title={atCap ? `${MAX_FIGURES} figures is the maximum` : "Add a figure"} className={btn()} disabled={atCap} onClick={() => engine.addFigure()}>
          Add figure
        </button>
      </div>
      <ul className="scroll-thin flex max-h-64 shrink-0 flex-col gap-1 overflow-auto">
        {figures.map((fig) => (
          <li key={fig.id} className={`flex shrink-0 items-center gap-2 rounded-sm border px-2 py-1 ${fig.id === selected?.id ? "border-accent" : "border-line"}`}>
            <button type="button" title={`Select ${fig.name}`} className="flex min-h-11 flex-1 items-center gap-2 text-left text-sm" onClick={() => engine.selectFigure(fig.id)}>
              <span className="inline-block size-3 rounded-full" style={{ background: fig.color }} />
              <span className="truncate">{fig.name}</span>
            </button>
            <button type="button" title={fig.visible ? "Hide figure" : "Show figure"} className={btn()} onClick={() => engine.setVisible(fig.id, !fig.visible)}>
              {fig.visible ? "Hide" : "Show"}
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <>
          <div className="flex gap-2">
            <button type="button" title={atCap ? `${MAX_FIGURES} figures is the maximum` : "Duplicate this figure"} className={btn()} disabled={atCap} onClick={() => engine.duplicateSelected()}>
              Duplicate
            </button>
            <button type="button" title="Delete the selected figure (Del)" className={btn()} onClick={() => engine.deleteSelected()}>
              Delete
            </button>
          </div>
          <label className="text-xs text-muted" title="Figure name">
            Name
            <input
              className="mt-1 w-full rounded-sm border border-line bg-bg px-2 py-1 text-sm text-fg"
              value={selected.name}
              onChange={(e) => engine.rename(selected.id, e.target.value)}
            />
          </label>
          <label className="text-xs text-muted" title="Named body presets">
            Preset
            <select
              className="mt-1 w-full rounded-sm border border-line bg-bg px-2 py-1 text-sm text-fg"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) engine.applyBodyPreset(selected.id, e.target.value);
                e.target.value = "";
              }}
            >
              <option value="">Apply a preset…</option>
              {BODY_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Params engine={engine} figure={selected} />
        </>
      )}
      {!selected && <p className="text-sm text-muted">Add a figure to start posing.</p>}
    </div>
  );
}

function Params({ engine, figure }: { engine: PoserEngine; figure: FigureData }) {
  const p = figure.params;
  const lim = heightLimits(p.age);
  const set = (patch: Partial<BodyParams>) => engine.setParams(figure.id, patch);
  const sexLabel = p.sex < 0.34 ? "Female" : p.sex > 0.66 ? "Male" : "Androgynous";
  return (
    <div>
      <Slider label="Sex presentation" title="Blends shoulder, hip, and chest proportions" min={0} max={1} step={0.01} value={p.sex} display={sexLabel} onChange={(v) => set({ sex: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Age" title="Head-to-body ratio, limb share, height range, and a slight stoop after 55" min={5} max={80} step={1} value={p.age} display={`${Math.round(p.age)} y`} onChange={(v) => { const next = heightLimits(v); set({ age: v, heightCm: Math.min(next.max, Math.max(next.min, p.heightCm)) }); }} onDirty={() => engine.pushHistory()} />
      <Slider label="Height" title={`Centimeters, limited to ${Math.round(lim.min)}–${Math.round(lim.max)} for this age`} min={lim.min} max={lim.max} step={1} value={p.heightCm} display={`${Math.round(p.heightCm)} cm`} onChange={(v) => set({ heightCm: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Body mass" title="Girth, especially waist and thighs" min={0} max={1} step={0.01} value={p.mass} display={p.mass.toFixed(2)} onChange={(v) => set({ mass: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Muscularity" title="Limb thickness without adding as much waist" min={0} max={1} step={0.01} value={p.muscle} display={p.muscle.toFixed(2)} onChange={(v) => set({ muscle: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Shoulder width" title="Multiplier on biacromial breadth" min={0.75} max={1.35} step={0.01} value={p.shoulder} display={p.shoulder.toFixed(2)} onChange={(v) => set({ shoulder: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Hip width" title="Multiplier on bi-iliac breadth" min={0.75} max={1.35} step={0.01} value={p.hip} display={p.hip.toFixed(2)} onChange={(v) => set({ hip: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Torso length" title="Share of height between hip and shoulder" min={0.82} max={1.2} step={0.01} value={p.torso} display={p.torso.toFixed(2)} onChange={(v) => set({ torso: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Leg length" title="Share of height in the legs. Total height stays fixed." min={0.82} max={1.2} step={0.01} value={p.leg} display={p.leg.toFixed(2)} onChange={(v) => set({ leg: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Scale" title="Uniform scale of the whole figure" min={0.4} max={1.8} step={0.01} value={figure.scale} display={figure.scale.toFixed(2)} onChange={(v) => engine.setScale(v)} onDirty={() => engine.pushHistory()} />
      <div className="mt-2 flex gap-2">
        <button type="button" title="Drop the figure so the soles meet the ground" className={btn()} onClick={() => engine.snapFeet()}>
          Snap feet
        </button>
      </div>
    </div>
  );
}

function Slider({
  label,
  title,
  min,
  max,
  step,
  value,
  display,
  onChange,
  onDirty,
}: {
  label: string;
  title: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (v: number) => void;
  onDirty: () => void;
}) {
  return (
    <label className="mt-2 block text-xs text-muted" title={title}>
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono text-fg">{display}</span>
      </span>
      <input
        className="mt-1 w-full"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onDirty}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function PosePanel({
  engine,
  figure,
  figures,
  bone,
  limits,
  showBody,
  tool,
}: {
  engine: PoserEngine;
  figure: FigureData;
  figures: FigureData[];
  bone: string | null;
  limits: boolean;
  showBody: boolean;
  tool: GizmoTool;
}) {
  const euler = bone ? (figure.pose[bone] ?? { x: 0, y: 0, z: 0 }) : { x: 0, y: 0, z: 0 };
  const lim = bone ? limitsFor(bone) : null;
  const driven = !!bone && figure.ik && engine.solverDrives(bone);
  const [draft, setDraft] = useState<{ axis: "x" | "y" | "z"; text: string } | null>(null);
  const rig = new Set(engine.rigNames(figure.id));
  const groups: { title: string; names: string[] }[] = [];
  for (const name of jointNames()) {
    if (!rig.has(name)) continue;
    const title = jointGroup(name);
    const last = groups[groups.length - 1];
    if (!last || last.title !== title) groups.push({ title, names: [name] });
    else last.names.push(name);
  }
  useEffect(() => {
    setDraft(null);
    if (!bone) return;
    document.getElementById(`joint-${figure.id}-${bone}`)?.scrollIntoView({ block: "nearest" });
  }, [bone, figure.id]);

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-auto border-b border-line p-3">
      <h2 className="text-sm font-semibold">Pose</h2>
      <label className="text-xs text-muted" title="Which figure the joint list and angle fields edit">
        Figure
        <select
          className="mt-1 w-full rounded-sm border border-line bg-bg px-2 py-2 text-sm text-fg"
          value={figure.id}
          onChange={(e) => engine.selectBone(e.target.value, bone)}
        >
          {figures.map((fig) => (
            <option key={fig.id} value={fig.id}>
              {fig.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="On builds a heel and a joint for each toe. Off is the original single-bone foot, which is the safer plate for ComfyUI.">
        <input
          type="checkbox"
          checked={figure.detailedFeet === true}
          onChange={(e) => engine.setDetailedFeet(figure.id, e.target.checked)}
        />
        Detailed feet
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Draw the face landmarks on this figure in the main view. Off keeps the plain head. The Face tab edits them either way.">
        <input
          type="checkbox"
          checked={figure.detailedHead === true}
          onChange={(e) => engine.setDetailedHead(figure.id, e.target.checked)}
        />
        Detailed head
      </label>
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-xs text-muted">Joints</p>
          <button type="button" className={btn(!bone)} title="Select the whole figure instead of a joint" onClick={() => engine.selectBone(figure.id, null)}>
            Whole figure
          </button>
        </div>
        <div className="scroll-thin max-h-72 overflow-auto rounded-sm border border-line">
          <JointAccordion figureId={figure.id} groups={groups} bone={bone} pose={figure.pose} onSelect={(name) => engine.selectBone(figure.id, name)} />
        </div>
        <p className="mt-1 text-xs text-muted">Tab next joint, Shift+Tab previous. [ and ] change figure.</p>
      </div>
      <div>
        <p className="mb-1 text-xs text-muted" title="Local XYZ Euler degrees from the T-pose. Up/Down nudge X, Left/Right nudge Y, comma and period nudge Z. Shift jumps 5 degrees.">
          Rotation (degrees)
        </p>
        <div className="grid grid-cols-3 gap-2">
          {(["x", "y", "z"] as const).map((axis) => (
            <label key={axis} className="text-xs text-muted" title={`${axis.toUpperCase()} rotation in degrees`}>
              {axis.toUpperCase()}
              <input
                type="number"
                step={1}
                disabled={!bone}
                min={limits && lim ? lim[axis][0] : undefined}
                max={limits && lim ? lim[axis][1] : undefined}
                className="mt-1 w-full rounded-sm border border-line bg-bg px-2 py-2 text-sm text-fg disabled:opacity-40"
                value={draft?.axis === axis ? draft.text : bone ? String(Number(euler[axis].toFixed(2))) : "0"}
                onFocus={() => engine.pushHistory()}
                onBlur={() => setDraft(null)}
                onChange={(e) => {
                  const text = e.target.value;
                  setDraft({ axis, text });
                  if (text === "" || text === "-" || text === "." || text === "-.") return;
                  const n = Number(text);
                  if (Number.isFinite(n)) engine.setJointEuler(axis, n);
                }}
              />
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">
          {bone
            ? `${jointLabel(bone)}. Arrows nudge X and Y, comma and period nudge Z. Shift is 5°.`
            : "Pick a joint to type its angles."}
        </p>
        {driven && (
          <p className="text-xs text-warn">This joint is solved by IK. Editing it turns IK off and keeps the current pose.</p>
        )}
      </div>
      <p className="text-xs text-muted">
        {figure.ik
          ? "IK is on. Drag hands, feet, head, or hips. Other chain joints follow."
          : "FK is on. Select a joint and rotate it, or type the degrees above."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" title="Forward kinematics (R rotates the selected joint)" className={btn(!figure.ik)} onClick={() => engine.setIk(false)}>
          FK
        </button>
        <button type="button" title="Inverse kinematics for hands, feet, head, and pelvis" className={btn(figure.ik)} onClick={() => engine.setIk(true)}>
          IK
        </button>
        <button type="button" title="Move the figure or an IK target (G)" className={btn(tool === "translate")} onClick={() => engine.setTool("translate")}>
          Move
        </button>
        <button type="button" title="Rotate the selected joint, or yaw the figure (R)" className={btn(tool === "rotate")} onClick={() => engine.setTool("rotate")}>
          Rotate
        </button>
        <button type="button" title="Scale the whole figure" className={btn(tool === "scale")} onClick={() => engine.setTool("scale")}>
          Scale
        </button>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Clamp joints to anatomical ranges. Uncheck this for a full turn on every axis.">
        <input type="checkbox" checked={limits} onChange={(e) => engine.setJointLimits(e.target.checked)} />
        Joint limits
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Show or hide joint handles. In skeleton view the handles stay on so you can pick a joint.">
        <input type="checkbox" checked={engine.state.showJoints} onChange={(e) => engine.setShowJoints(e.target.checked)} />
        Joint handles
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Hide the body mesh and draw stick bones. Much lighter on a slow machine. Exports still include the body.">
        <input type="checkbox" checked={showBody} onChange={(e) => engine.setShowBody(e.target.checked)} />
        Body mesh
      </label>
      {!showBody && <p className="text-xs text-muted">Skeleton only. Joint dots and sticks stay. The skinned body is not drawn.</p>}
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Show or hide the ground grid">
        <input type="checkbox" checked={engine.state.showGrid} onChange={(e) => engine.setShowGrid(e.target.checked)} />
        Ground grid
      </label>
      <div className="flex gap-2">
        <button type="button" title="Copy the left side onto the right" className={btn()} onClick={() => engine.mirror("L2R")}>
          Mirror L → R
        </button>
        <button type="button" title="Copy the right side onto the left" className={btn()} onClick={() => engine.mirror("R2L")}>
          Mirror R → L
        </button>
      </div>
      <div>
        <p className="mb-1 text-xs text-muted">Pose presets</p>
        <div className="flex flex-wrap gap-1">
          {POSE_PRESETS.map((p) => (
            <button key={p.id} type="button" title={`Apply the ${p.name} pose`} className={btn()} onClick={() => engine.applyPosePreset(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1 text-xs text-muted">Hands</p>
        <div className="flex flex-wrap gap-1">
          {HANDS.map((h) => (
            <button key={h.id} type="button" title={`Both hands: ${h.label}`} className={btn()} onClick={() => engine.applyHand("both", h.id)}>
              {h.label}
            </button>
          ))}
        </div>
      </div>
      {figure.detailedFeet === true && (
        <div>
          <p className="mb-1 text-xs text-muted">Toes</p>
          <div className="flex flex-wrap gap-1">
            {TOES.map((t) => (
              <button key={t.id} type="button" title={`Both feet: ${t.label}`} className={btn()} onClick={() => engine.applyToes("both", t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" title="Download every joint as XYZ degrees" className={btn()} onClick={() => engine.savePose()}>
          Save angles
        </button>
        <label title="Load joint degrees onto the selected figure" className={btn()}>
          Load angles
          <input
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void engine.loadPose(file);
              e.target.value = "";
            }}
          />
        </label>
        <button type="button" title="Download this figure's body and joint degrees" className={btn()} onClick={() => engine.saveFigure()}>
          Save figure
        </button>
        <label title="Load a figure file onto the selection. Body sliders, place, and joint degrees come back." className={btn()}>
          Load figure
          <input
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void engine.loadFigure(file);
              e.target.value = "";
            }}
          />
        </label>
        <button type="button" title="Download the whole scene as JSON" className={btn()} onClick={() => engine.saveScene()}>
          Save scene
        </button>
        <label title="Load a scene JSON" className={btn()}>
          Load scene
          <input
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void engine.loadScene(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}

function ExportPanel({
  engine,
  warning,
  settings,
  previews,
  count,
}: {
  engine: PoserEngine;
  warning: string;
  settings: PoserEngine["state"]["export"];
  previews: MutableRefObject<Record<string, HTMLCanvasElement | null>>;
  count: number;
}) {
  const snapped = snapResolution(settings.width, settings.height);
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      <h2 className="text-sm font-semibold">Export for ComfyUI</h2>
      <label className="text-xs text-muted" title="Output size. Custom sizes snap to a multiple of 8.">
        Resolution
        <select
          className="mt-1 w-full rounded-sm border border-line bg-bg px-2 py-1 text-sm text-fg"
          value={settings.preset}
          onChange={(e) => {
            const id = e.target.value;
            const preset = RESOLUTIONS.find((r) => r.id === id);
            if (!preset) return;
            engine.setExport({ preset: id, width: preset.width, height: preset.height });
          }}
        >
          {RESOLUTIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      {settings.preset === "custom" && (
        <div className="flex gap-2">
          <label className="text-xs text-muted" title="Width in pixels">
            W
            <input
              type="number"
              className="mt-1 w-full rounded-sm border border-line bg-bg px-2 py-1 text-sm text-fg"
              value={settings.width}
              onChange={(e) => engine.setExport({ preset: "custom", width: Number(e.target.value) })}
            />
          </label>
          <label className="text-xs text-muted" title="Height in pixels">
            H
            <input
              type="number"
              className="mt-1 w-full rounded-sm border border-line bg-bg px-2 py-1 text-sm text-fg"
              value={settings.height}
              onChange={(e) => engine.setExport({ preset: "custom", height: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      {snapped.warn64 && (
        <p className="text-xs text-warn">Size is not a multiple of 64. Many SD checkpoints prefer that.</p>
      )}
      {warning && <p className="text-xs text-warn">{warning}</p>}
      <label className="flex min-h-11 items-center gap-2 text-sm" title="DWPose-style hands (21 points) and 68 face landmarks">
        <input type="checkbox" checked={settings.includeHandsFace} onChange={(e) => engine.setExport({ includeHandsFace: e.target.checked })} />
        Include hands and face
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Drop keypoints hidden behind the body. Off by default.">
        <input type="checkbox" checked={settings.hideOccluded} onChange={(e) => engine.setExport({ hideOccluded: e.target.checked })} />
        Hide occluded keypoints
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Draw the OpenPose skeleton on the live view to check alignment">
        <input
          type="checkbox"
          checked={settings.overlay !== "off"}
          onChange={(e) => engine.setExport({ overlay: e.target.checked ? "skeleton" : "off" })}
        />
        Skeleton on view
      </label>
      <div className="flex flex-wrap gap-1">
        <button type="button" title="Download the OpenPose PNG" className={btn()} onClick={() => void engine.download("openpose")}>
          OpenPose
        </button>
        <button type="button" title="Download the wireframe PNG" className={btn()} onClick={() => void engine.download("wire")}>
          Wireframe
        </button>
        <button type="button" title="Download the depth PNG" className={btn()} onClick={() => void engine.download("depth")}>
          Depth
        </button>
        <button type="button" title="Download the normal PNG" className={btn()} onClick={() => void engine.download("normal")}>
          Normal
        </button>
        <button type="button" title="Download the combined color mask" className={btn()} onClick={() => void engine.download("mask")}>
          Mask
        </button>
        <button
          type="button"
          title="Shaded 3D body on black for Anima ControlNet-LLLite (anima_3dpose_6200). Strength 1, no preprocessor."
          className={btn()}
          onClick={() => void engine.download("model")}
        >
          3D model
        </button>
        <button
          type="button"
          title="Same shaded body plus a complementary outline for anima_3dpose_outline_7000. About 4px at a 768px short side."
          className={btn()}
          onClick={() => void engine.download("model-outline")}
        >
          3D outline
        </button>
        <button type="button" title="Download OpenPose JSON" className={btn()} onClick={() => void engine.downloadJson()}>
          JSON
        </button>
        <button type="button" title="Zip every conditioning image (E in orbit mode)" className={btn(true)} onClick={() => void engine.exportAll()}>
          Export all
        </button>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Black lines on white">
        <input type="checkbox" checked={settings.wireInvert} onChange={(e) => engine.setExport({ wireInvert: e.target.checked })} />
        Invert wire
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Color each figure's wireframe">
        <input type="checkbox" checked={settings.wireColored} onChange={(e) => engine.setExport({ wireColored: e.target.checked })} />
        Colored wire
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="X-ray: draw hidden edges too">
        <input type="checkbox" checked={settings.wireXray} onChange={(e) => engine.setExport({ wireXray: e.target.checked })} />
        X-ray wire
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Smooth the wire edges. Off is crisper for Canny-style ControlNets.">
        <input type="checkbox" checked={settings.wireAA} onChange={(e) => engine.setExport({ wireAA: e.target.checked })} />
        Antialias wire
      </label>
      <Slider
        label="Wire thickness"
        title="Edge width in the wireframe export, in pixels at the preview size and scaled in the shader"
        min={0.6}
        max={3.5}
        step={0.05}
        value={settings.wireThickness}
        display={settings.wireThickness.toFixed(2)}
        onChange={(v) => engine.setExport({ wireThickness: v })}
        onDirty={() => {}}
      />
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Fit depth white-to-black to the figures instead of the camera planes">
        <input type="checkbox" checked={settings.depthAuto} onChange={(e) => engine.setExport({ depthAuto: e.target.checked })} />
        Auto depth range
      </label>
      <div className="grid grid-cols-3 gap-1">
        {(
          [
            ["pose", "Pose"],
            ["wire", "Wire"],
            ["align", "Align"],
            ["depth", "Depth"],
            ["normal", "Normal"],
            ["mask", "Mask"],
            ["model", "Model"],
          ] as const
        ).map(([id, label]) => (
          <figure key={id} className="overflow-hidden rounded-sm border border-line bg-bg">
            <canvas
              ref={(el) => {
                previews.current[id] = el;
              }}
              className="aspect-square w-full bg-bg"
              title={`${label} preview. Align composites the skeleton on the wireframe.`}
            />
            <figcaption className="px-1 py-0.5 text-xs text-muted">{label}</figcaption>
          </figure>
        ))}
      </div>
      <p className="text-xs text-muted">{count} figure{count === 1 ? "" : "s"} in the scene. The frame overlay matches the export crop.</p>
    </div>
  );
}

function JointAccordion({
  figureId,
  groups,
  bone,
  pose,
  onSelect,
}: {
  figureId: string;
  groups: { title: string; names: string[] }[];
  bone: string | null;
  pose: FigureData["pose"];
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState<string | null>("Torso");
  useEffect(() => {
    if (bone) setOpen(jointGroup(bone));
  }, [bone, figureId]);
  useEffect(() => {
    if (!bone) return;
    document.getElementById(`joint-${figureId}-${bone}`)?.scrollIntoView({ block: "nearest" });
  }, [bone, figureId, open]);

  return (
    <>
      {groups.map((group) => {
        const expanded = open === group.title;
        return (
          <div key={group.title} className="border-b border-line last:border-b-0">
            <button
              type="button"
              aria-expanded={expanded}
              title={expanded ? `Collapse ${group.title}` : `Expand ${group.title}`}
              className="flex min-h-11 w-full items-center justify-between gap-2 px-2 text-left text-xs text-muted hover:bg-surface-2"
              onClick={() => setOpen(expanded ? null : group.title)}
            >
              <span>{group.title}</span>
              <span className="font-mono">
                {expanded ? "−" : "+"} {group.names.length}
              </span>
            </button>
            {expanded &&
              group.names.map((name) => {
                const e = pose[name];
                const moved = e && (Math.abs(e.x) > 0.05 || Math.abs(e.y) > 0.05 || Math.abs(e.z) > 0.05);
                return (
                  <button
                    key={name}
                    id={`joint-${figureId}-${name}`}
                    type="button"
                    title={`Select ${jointLabel(name)}. Tab steps to the next joint.`}
                    className={`flex min-h-11 w-full items-center justify-between gap-2 px-2 text-left text-sm ${bone === name ? "bg-surface-2 text-accent" : "hover:bg-surface-2"}`}
                    onClick={() => onSelect(name)}
                  >
                    <span>{jointLabel(name)}</span>
                    {moved && <span className="font-mono text-xs text-muted">set</span>}
                  </button>
                );
              })}
          </div>
        );
      })}
    </>
  );
}

function FacePanel({ engine, figure, facePoint }: { engine: PoserEngine; figure: FigureData; facePoint: number | null }) {
  const face = figure.face;
  const set = (patch: Partial<FaceShape>) => engine.setFace(figure.id, patch);
  const [open, setOpen] = useState<string | null>(facePoint == null ? "Jaw" : faceGroupOf(facePoint).title);
  useEffect(() => {
    if (facePoint == null) return;
    setOpen(faceGroupOf(facePoint).title);
  }, [facePoint]);
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <h2 className="text-sm font-semibold">Face</h2>
      <p className="text-xs text-muted">
        Drag a point on the head. Arrows nudge it, Shift pushes it in or out, and Alt moves that point alone. Neighbors in the same region follow otherwise. The sliders still set the expression underneath.
      </p>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Show the landmark overlay on this figure in the main view">
        <input
          type="checkbox"
          checked={figure.detailedHead === true}
          onChange={(e) => engine.setDetailedHead(figure.id, e.target.checked)}
        />
        Detailed head
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm" title="Moving a point on one side moves the matching point on the other side">
        <input
          type="checkbox"
          checked={figure.faceMirror !== false}
          onChange={(e) => engine.setFaceMirror(figure.id, e.target.checked)}
        />
        Mirror
      </label>
      <button type="button" title="Clear dragged point offsets. Expression sliders stay as they are." className={btn()} onClick={() => engine.resetFaceOffsets(figure.id)}>
        Reset points
      </button>
      <div className="rounded-md border border-line">
        {FACE_GROUPS.map((group) => {
          const expanded = open === group.title;
          return (
            <div key={group.id} className="border-b border-line last:border-b-0">
              <button
                type="button"
                aria-expanded={expanded}
                title={expanded ? `Collapse ${group.title}` : `Expand ${group.title}`}
                className="flex min-h-11 w-full items-center justify-between gap-2 px-2 text-left text-xs text-muted hover:bg-surface-2"
                onClick={() => setOpen(expanded ? null : group.title)}
              >
                <span>{group.title}</span>
                <span className="font-mono">
                  {expanded ? "−" : "+"} {group.names.length}
                </span>
              </button>
              {expanded &&
                group.names.map((name, i) => {
                  const index = group.from + i;
                  const o = figure.faceOffsets?.[index];
                  const moved = !!o && (Math.abs(o.x) > 0.0008 || Math.abs(o.y) > 0.0008 || Math.abs(o.z) > 0.0008);
                  return (
                    <button
                      key={index}
                      type="button"
                      title={`Select ${group.title} ${name}`}
                      className={`flex min-h-11 w-full items-center justify-between gap-2 px-2 text-left text-sm ${facePoint === index ? "bg-surface-2 text-accent" : "hover:bg-surface-2"}`}
                      onClick={() => engine.selectFacePoint(figure.id, index)}
                    >
                      <span>{name}</span>
                      {moved && <span className="font-mono text-xs text-muted">moved</span>}
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>
      <div>
        <p className="mb-1 text-xs text-muted">Expressions</p>
        <div className="flex flex-wrap gap-1">
          {FACE_PRESETS.map((p) => (
            <button key={p.id} type="button" title={`Apply the ${p.name} face`} className={btn()} onClick={() => engine.applyFacePreset(figure.id, p.id)}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <Slider label="Jaw" title="Opens the jaw and the lower lip" min={0} max={1} step={0.01} value={face.jaw} display={face.jaw.toFixed(2)} onChange={(v) => set({ jaw: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Smile" title="Negative is a frown, positive pulls the corners up" min={-1} max={1} step={0.01} value={face.smile} display={face.smile.toFixed(2)} onChange={(v) => set({ smile: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Brows" title="Negative lowers the brows, positive raises them" min={-1} max={1} step={0.01} value={face.brow} display={face.brow.toFixed(2)} onChange={(v) => set({ brow: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Blink" title="Closes both eyes" min={0} max={1} step={0.01} value={face.blink} display={face.blink.toFixed(2)} onChange={(v) => set({ blink: v })} onDirty={() => engine.pushHistory()} />
      <Slider label="Mouth width" title="1 is the resting mouth" min={0.55} max={1.7} step={0.01} value={face.mouth} display={face.mouth.toFixed(2)} onChange={(v) => set({ mouth: v })} onDirty={() => engine.pushHistory()} />
      <p className="text-xs text-muted">Export includes these points when “Include hands and face” is on. Reset points clears the drags and leaves the sliders.</p>
    </div>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const rows = [
    ["Left drag", "Orbit (or fly-look after click)"],
    ["Right drag", "Pan"],
    ["Scroll", "Zoom"],
    ["C", "Toggle orbit / fly"],
    ["WASD", "Fly move. A left, D right"],
    ["Q / E", "Fly down / up (orbit: E exports)"],
    ["Shift", "Fly faster"],
    ["G / R", "Move gizmo / rotate gizmo"],
    ["Arrows", "Nudge joint, or the selected face point"],
    [", / .", "Nudge joint Z, or a face point in and out"],
    ["Alt", "Face: move only the grabbed point"],
    ["Shift drag", "Face: push a point in or out"],
    ["F", "Frame selection"],
    ["Tab", "Next joint (Shift+Tab previous)"],
    ["[ / ]", "Previous / next figure"],
    ["Del", "Delete figure"],
    ["Ctrl+Z", "Undo"],
    ["Ctrl+Shift+Z", "Redo"],
    ["?", "This sheet"],
  ];
  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-bg/70 p-4" onClick={onClose}>
      <div className="max-h-full w-full max-w-md overflow-auto rounded-md border border-line bg-surface p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-base font-semibold">Shortcuts</h2>
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-t border-line">
                <td className="py-1 pr-3 font-mono text-accent">{k}</td>
                <td className="py-1 text-muted">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className={`${btn()} mt-3`} onClick={onClose} title="Close the shortcut sheet">
          Close
        </button>
      </div>
    </div>
  );
}
