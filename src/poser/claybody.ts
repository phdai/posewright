/**
 * Body variants for the Clay export. Pure functions, no Three.js.
 *
 * H3 edits <Picture 1>, so a clay body with a strong build pulls each person
 * toward that build instead of the one in their reference photo. The variants keep
 * the skeleton (every joint position, so height, limb lengths, shoulder and hip
 * joints, and the pose stay as the sliders set them) and change only the volume
 * around the bones:
 * - "sliders": the figure's own body (the original Clay).
 * - "neutral": an average build. Mass, muscle, sex and the shoulder/hip width
 *   sliders no longer shape the surface, and there is no chest volume.
 * - "mannequin": slim, untapered limbs and torso around the same skeleton, like a
 *   wooden artist's mannequin, so only pose, placement and height come through.
 */
import { layoutFigure, type Segment } from "./proportions.ts";
import type { BodyParams } from "./types.ts";

export type ClayBody = "sliders" | "neutral" | "mannequin";

export const CLAY_BODIES: { id: ClayBody; label: string; title: string }[] = [
  { id: "sliders", label: "From sliders", title: "Each figure's own build, as the body sliders set it." },
  {
    id: "neutral",
    label: "Neutral build",
    title: "Same skeleton and height, average build. Body shape comes from the reference photos.",
  },
  {
    id: "mannequin",
    label: "Mannequin",
    title: "Same skeleton and height, slim even limbs. Only pose, placement and height come through.",
  },
];

export function clayBodyOf(value: unknown): ClayBody {
  return value === "neutral" || value === "mannequin" ? value : "sliders";
}

/** Average build used by "neutral". Age, height, torso and leg (the skeleton) stay the figure's own. */
export const NEUTRAL_BUILD: Pick<BodyParams, "sex" | "mass" | "muscle" | "shoulder" | "hip"> = {
  sex: 0.5,
  mass: 0.4,
  muscle: 0.35,
  shoulder: 1,
  hip: 1,
};

export function neutralParams(p: BodyParams): BodyParams {
  return { ...p, ...NEUTRAL_BUILD };
}

/** Mannequin limb thickness relative to the neutral build, and the share of the torso kept. */
const MANNEQUIN_LIMB = 0.78;
const MANNEQUIN_TORSO = 0.72;
const TORSO = new Set(["hips", "spine", "abdomen", "chest"]);

/**
 * Segments for a clay variant: joint positions from `real` (the figure's own
 * layout), radii from the variant. Segment names must match `real`.
 */
export function claySegments(real: Segment[], params: BodyParams, body: ClayBody, detailedFeet: boolean): Segment[] {
  if (body === "sliders") return real;
  const neutral = new Map(layoutFigure(neutralParams(params), detailedFeet).map((s) => [s.name, s]));
  return real.map((seg) => {
    const n = neutral.get(seg.name);
    if (!n) return seg;
    const out: Segment = { ...seg, rx0: n.rx0, rx1: n.rx1, rz0: n.rz0, rz1: n.rz1 };
    if (body === "mannequin" && seg.kind === "tube") {
      const k = TORSO.has(seg.name) ? MANNEQUIN_TORSO : MANNEQUIN_LIMB;
      // Untapered: one radius per axis along the whole segment.
      const rx = Math.min(n.rx0, n.rx1) * k;
      const rz = Math.min(n.rz0, n.rz1) * k;
      out.rx0 = out.rx1 = rx;
      out.rz0 = out.rz1 = rz;
    }
    if (body === "mannequin" && seg.name === "hips") {
      out.rx0 = out.rx1 = n.rx0 * MANNEQUIN_TORSO;
      out.rz0 = out.rz1 = n.rz0 * MANNEQUIN_TORSO;
    }
    return out;
  });
}

/** Chest volume follows the sliders only; the variants have none. */
export function clayChest(body: ClayBody): boolean {
  return body === "sliders";
}
