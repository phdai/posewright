/**
 * Helpers for MiniMax-H3-Image edit mode. H3 has no ControlNet: the Clay render
 * goes in as <Picture 1> (the image that gets edited) and each character photo
 * as a later picture. Pure functions only, so they run under Node's test runner.
 */

/**
 * All prompt wording lives here. `intro` is used when the clay bodies follow the
 * body sliders; `introReference` when they are the neutral build or the mannequin,
 * so each person's body shape comes from their reference photo. Placeholders:
 * - figure: {color} (palette color name, or empty when tint is off), {ordinal}, {picture}
 * - size: {width}, {height}
 */
export const H3_PROMPT = {
  intro:
    "Turn the 3D figures in <Picture 1> into a photorealistic scene. Keep every figure's pose, position, size and the camera angle exactly as in <Picture 1>.",
  introReference:
    "Turn the 3D figures in <Picture 1> into a photorealistic scene. Keep every figure's pose, position, height and the camera angle exactly as in <Picture 1>. The figures only mark pose and placement: take each person's face, body shape, hair and clothing from their reference picture.",
  figure: "The {color} figure ({ordinal} from the left) is the person in <Picture {picture}>.",
  size: "Suggested output size: {width} × {height}",
} as const;

export type H3PromptTemplate = { intro: string; introReference: string; figure: string; size: string };

/** H3 accepts up to 16 pictures. <Picture 1> is the pose image, so at most 15 people. */
export const H3_MAX_REFERENCES = 15;
/** Output edges are multiples of this. */
export const H3_GRID = 32;
/** Largest suggested output area (16 MiB of pixels, 4096 × 4096). */
export const H3_MAX_AREA = 16_777_216;

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export type ProjectedFigure<T> = {
  item: T;
  /** Projected keypoints (bone heads) in export pixels. `behind` is true for points behind the camera. */
  points: { x: number; y: number; behind: boolean }[];
};

/**
 * Order figures as they appear left to right in the export frame. A figure's
 * position is the mean X of its points that are in front of the camera and inside
 * the frame. Figures with no such point are not in the picture and are dropped.
 * Equal positions keep their input order.
 */
export function orderLeftToRight<T>(figures: ProjectedFigure<T>[], width: number, height: number): T[] {
  const keyed: { item: T; x: number; i: number }[] = [];
  figures.forEach((fig, i) => {
    let sum = 0;
    let n = 0;
    for (const p of fig.points) {
      if (p.behind || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue;
      sum += p.x;
      n += 1;
    }
    if (n > 0) keyed.push({ item: fig.item, x: sum / n, i });
  });
  keyed.sort((a, b) => a.x - b.x || a.i - b.i);
  return keyed.map((k) => k.item);
}

/**
 * Largest output size for H3 that keeps the export's aspect ratio as closely as
 * the 32 px grid allows. Every width on the grid is paired with the grid height
 * nearest to width / aspect, and every height with its nearest grid width. Of the
 * pairs whose area is at most H3_MAX_AREA, the largest area wins; a tie goes to the
 * smaller aspect error.
 */
export function suggestH3Size(width: number, height: number): { width: number; height: number } {
  const aspect = Math.max(1e-6, width) / Math.max(1e-6, height);
  const g = H3_GRID;
  const snap = (v: number) => Math.max(g, Math.round(v / g) * g);
  let best = { width: g, height: g, area: g * g, err: Math.abs(Math.log(aspect)) };
  const consider = (w: number, h: number) => {
    const area = w * h;
    if (area > H3_MAX_AREA) return;
    const err = Math.abs(Math.log(w / h / aspect));
    if (area > best.area || (area === best.area && err < best.err)) best = { width: w, height: h, area, err };
  };
  const maxEdge = H3_MAX_AREA / g;
  for (let w = g; w <= maxEdge; w += g) consider(w, snap(w / aspect));
  for (let h = g; h <= maxEdge; h += g) consider(snap(h * aspect), h);
  return { width: best.width, height: best.height };
}

function fill(text: string, values: Record<string, string | number>): string {
  return text
    .replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? String(values[key]) : m))
    .replace(/ {2,}/g, " ")
    .replace(/ ([.,)])/g, "$1")
    .replace(/\( /g, "(");
}

/**
 * The prompt for H3 edit mode. `figures` are already in left-to-right order;
 * the first maps to <Picture 2>, the next to <Picture 3>, and so on. A null color
 * leaves the color word out.
 */
export function buildH3Prompt(
  figures: { color: string | null }[],
  size: { width: number; height: number },
  template: H3PromptTemplate = H3_PROMPT,
  opts: { bodyFromReference?: boolean } = {},
): string {
  const lines = [opts.bodyFromReference ? template.introReference : template.intro];
  figures.slice(0, H3_MAX_REFERENCES).forEach((fig, i) => {
    lines.push(fill(template.figure, { color: fig.color ?? "", ordinal: ordinal(i + 1), picture: i + 2 }));
  });
  lines.push(fill(template.size, { width: size.width, height: size.height }));
  return lines.join("\n");
}
