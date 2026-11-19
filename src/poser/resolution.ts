/**
 * Export resolutions. SD1.5 likes 512–768; SDXL likes ~1 megapixel buckets. The H3 group sizes
 * a reference image for MiniMax-H3-Image, whose short edge ComfyUI rescales to 1024–2048 px.
 * All presets are multiples of 64.
 */

export const RESOLUTIONS: { id: string; width: number; height: number; label: string; group?: string }[] = [
  { id: "512", width: 512, height: 512, label: "512 × 512" },
  { id: "512x768", width: 512, height: 768, label: "512 × 768" },
  { id: "768x512", width: 768, height: 512, label: "768 × 512" },
  { id: "768", width: 768, height: 768, label: "768 × 768" },
  { id: "1024", width: 1024, height: 1024, label: "1024 × 1024" },
  { id: "832x1216", width: 832, height: 1216, label: "832 × 1216" },
  { id: "1216x832", width: 1216, height: 832, label: "1216 × 832" },
  { id: "896x1152", width: 896, height: 1152, label: "896 × 1152" },
  { id: "1152x896", width: 1152, height: 896, label: "1152 × 896" },
  { id: "1024x1536", width: 1024, height: 1536, label: "1024 × 1536" },
  { id: "h3-2048", width: 2048, height: 2048, label: "2048 × 2048 (H3)", group: "MiniMax H3 Image" },
  { id: "h3-1536x2048", width: 1536, height: 2048, label: "1536 × 2048 (H3)", group: "MiniMax H3 Image" },
  { id: "h3-2048x1536", width: 2048, height: 1536, label: "2048 × 1536 (H3)", group: "MiniMax H3 Image" },
  { id: "h3-1152x2048", width: 1152, height: 2048, label: "1152 × 2048 (H3)", group: "MiniMax H3 Image" },
  { id: "h3-2048x1152", width: 2048, height: 1152, label: "2048 × 1152 (H3)", group: "MiniMax H3 Image" },
  { id: "h3-3136x1344", width: 3136, height: 1344, label: "3136 × 1344 (H3)", group: "MiniMax H3 Image" },
  { id: "custom", width: 768, height: 768, label: "Custom" },
];

export function snapResolution(width: number, height: number): {
  width: number;
  height: number;
  snapped: boolean;
  warn64: boolean;
} {
  const w0 = Math.max(64, Math.round(Number(width) || 512));
  const h0 = Math.max(64, Math.round(Number(height) || 512));
  const w = Math.max(64, Math.round(w0 / 8) * 8);
  const h = Math.max(64, Math.round(h0 / 8) * 8);
  const cap = 4096;
  return {
    width: Math.min(cap, w),
    height: Math.min(cap, h),
    snapped: w !== w0 || h !== h0,
    warn64: w % 64 !== 0 || h % 64 !== 0,
  };
}

/**
 * Crop of the live view that matches an offscreen export.
 * Vertical FOV is preserved when the export is narrower than the view (crop the sides).
 * When the export is wider, horizontal FOV is preserved and the export vertical FOV shrinks
 * so the pixels inside the crop match exactly.
 */
export function exportCameraFit(
  viewW: number,
  viewH: number,
  expW: number,
  expH: number,
  fovDeg: number,
): { fov: number; x: number; y: number; w: number; h: number } {
  const viewAspect = viewW / Math.max(1, viewH);
  const expAspect = expW / Math.max(1, expH);
  if (expAspect <= viewAspect + 1e-6) {
    const h = viewH;
    const w = viewH * expAspect;
    return { fov: fovDeg, x: (viewW - w) / 2, y: 0, w, h };
  }
  const w = viewW;
  const h = viewW / expAspect;
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * viewAspect);
  const expVFov = 2 * Math.atan(Math.tan(hFov / 2) / expAspect);
  return { fov: (expVFov * 180) / Math.PI, x: 0, y: (viewH - h) / 2, w, h };
}
