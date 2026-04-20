import { useState, useRef, useEffect, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

type HslRange = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta';
const HSL_RANGES: HslRange[] = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
const HSL_CENTERS: Record<HslRange, number> = {
  red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 220, purple: 270, magenta: 310,
};
const HSL_SWATCHES: Record<HslRange, string> = {
  red: '#e53935', orange: '#fb8c00', yellow: '#fdd835', green: '#43a047',
  aqua: '#00acc1', blue: '#1e88e5', purple: '#8e24aa', magenta: '#d81b60',
};

interface CurvePoint { x: number; y: number; }

interface Adjustments {
  // Light
  exposure: number;      // -5 to +5 (stops)
  contrast: number;      // -100 to +100
  highlights: number;    // -100 to +100
  shadows: number;       // -100 to +100
  whites: number;        // -100 to +100
  blacks: number;        // -100 to +100
  // Color
  temperature: number;   // -100 to +100
  tint: number;          // -100 to +100
  vibrance: number;      // -100 to +100
  saturation: number;    // -100 to +100
  hue: number;           // -180 to +180
  // HSL
  hsl: Record<HslRange, { h: number; s: number; l: number }>;
  // Tone curve (values 0..255 in both axes, always includes endpoints at 0 and 255)
  curve: CurvePoint[];
  // Split toning / color grading
  shadowHue: number;     // 0 to 360
  shadowSat: number;     // 0 to 100
  highlightHue: number;  // 0 to 360
  highlightSat: number;  // 0 to 100
  // Detail
  sharpness: number;     // 0 to 100
  noiseReduction: number;// 0 to 100
  clarity: number;       // -100 to +100
  texture: number;       // -100 to +100
  dehaze: number;        // -100 to +100
  // Effects
  vignette: number;      // -100 to +100 (negative = lighten, positive = darken)
  grain: number;         // 0 to 100
}

const emptyHsl = (): Adjustments['hsl'] => ({
  red: { h: 0, s: 0, l: 0 }, orange: { h: 0, s: 0, l: 0 }, yellow: { h: 0, s: 0, l: 0 },
  green: { h: 0, s: 0, l: 0 }, aqua: { h: 0, s: 0, l: 0 }, blue: { h: 0, s: 0, l: 0 },
  purple: { h: 0, s: 0, l: 0 }, magenta: { h: 0, s: 0, l: 0 },
});

const defaultCurve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 255, y: 255 }];

const defaultAdj = (): Adjustments => ({
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temperature: 0, tint: 0, vibrance: 0, saturation: 0, hue: 0,
  hsl: emptyHsl(),
  curve: defaultCurve(),
  shadowHue: 220, shadowSat: 0, highlightHue: 45, highlightSat: 0,
  sharpness: 0, noiseReduction: 0, clarity: 0, texture: 0, dehaze: 0,
  vignette: 0, grain: 0,
});

// ── Presets ───────────────────────────────────────────────────────────────────

const PRESETS: Record<string, Partial<Adjustments>> = {
  Vivid: { vibrance: 35, saturation: 10, contrast: 18, clarity: 15, shadows: 10 },
  Muted: { saturation: -25, contrast: -8, shadows: 12, highlights: -10, vibrance: -5 },
  'B&W': { saturation: -100, contrast: 15, clarity: 20, blacks: 10, whites: 8 },
  Vintage: {
    saturation: -12, temperature: 18, contrast: -6, shadows: 20, highlights: -15,
    grain: 22, vignette: 24,
    shadowHue: 220, shadowSat: 25, highlightHue: 45, highlightSat: 30,
  },
  Cinematic: {
    contrast: 22, clarity: 10, vibrance: 8,
    shadowHue: 200, shadowSat: 35, highlightHue: 30, highlightSat: 28,
    blacks: -10, highlights: -15,
  },
  Soft: { contrast: -15, highlights: 25, shadows: 15, whites: -10, blacks: 5, saturation: -5, clarity: -10 },
  Punchy: { contrast: 30, clarity: 25, vibrance: 20, dehaze: 15, blacks: -8, whites: 8 },
  Moody: { exposure: -0.3, shadows: -20, blacks: -15, highlights: -10, saturation: -10, clarity: 15, temperature: -8 },
};

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  card: { border: '3px solid #000', background: '#fff', padding: '14px', marginBottom: '12px', boxShadow: '4px 4px 0 #000' } as React.CSSProperties,
  panelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none', fontFamily: 'DM Serif Text, serif', fontSize: 18, marginBottom: 8 } as React.CSSProperties,
  h1: { fontFamily: 'DM Serif Text, serif', fontSize: 34, marginBottom: 6 } as React.CSSProperties,
  h2: { fontFamily: 'DM Serif Text, serif', fontSize: 18 } as React.CSSProperties,
  label: { display: 'flex', justifyContent: 'space-between', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 11, marginBottom: 2 } as React.CSSProperties,
  p: { fontFamily: 'Poppins, sans-serif', fontSize: 14 } as React.CSSProperties,
  btn: (bg = '#000', fg = '#fff', disabled = false): React.CSSProperties => ({
    border: '2px solid #000', background: disabled ? '#ccc' : bg, color: disabled ? '#888' : fg,
    padding: '6px 12px', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: disabled ? 'none' : '3px 3px 0 #000',
  }),
  iconBtn: (active = false): React.CSSProperties => ({
    border: '2px solid #000', background: active ? '#000' : '#fff', color: active ? '#fff' : '#000',
    padding: '4px 8px', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 11,
    cursor: 'pointer', boxShadow: '2px 2px 0 #000',
  }),
  select: { border: '2px solid #000', padding: '6px 8px', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 12, background: '#fff', width: '100%' } as React.CSSProperties,
};

// ── Color space helpers ───────────────────────────────────────────────────────

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  // r,g,b in 0..1 — returns h in 0..360, s and l in 0..1
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const l = (maxC + minC) / 2;
  let h = 0, s = 0;
  if (maxC !== minC) {
    const d = maxC - minC;
    s = l > 0.5 ? d / (2 - maxC - minC) : d / (maxC + minC);
    switch (maxC) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      default: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, hh + 1 / 3), hue2rgb(p, q, hh), hue2rgb(p, q, hh - 1 / 3)];
}

// ── Tone curve LUT ────────────────────────────────────────────────────────────

function buildCurveLUT(points: CurvePoint[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const pts = [...points].sort((a, b) => a.x - b.x);
  if (pts[0].x > 0) pts.unshift({ x: 0, y: pts[0].y });
  if (pts[pts.length - 1].x < 255) pts.push({ x: 255, y: pts[pts.length - 1].y });
  let seg = 0;
  for (let i = 0; i < 256; i++) {
    while (seg < pts.length - 2 && pts[seg + 1].x < i) seg++;
    const p0 = pts[seg], p1 = pts[seg + 1];
    const t = p1.x === p0.x ? 0 : (i - p0.x) / (p1.x - p0.x);
    lut[i] = Math.round(p0.y + (p1.y - p0.y) * t);
  }
  return lut;
}

// ── Build a combined input-space LUT for light adjustments ────────────────────
// Applies: exposure → blacks/whites → highlights/shadows → contrast → tone curve.
// Note: this is an approximation — real Lightroom acts in scene-linear space with
// protected roll-off, but a carefully ordered LUT gives a very plausible result.

function buildLightLUT(adj: Adjustments): Uint8ClampedArray {
  const curveLUT = buildCurveLUT(adj.curve);
  const lut = new Uint8ClampedArray(256);
  const expMul = Math.pow(2, adj.exposure);
  const contrastF = Math.tan(((adj.contrast / 100 + 1) * Math.PI) / 4);
  const blacks = adj.blacks / 100;
  const whites = adj.whites / 100;
  const highlights = adj.highlights / 100;
  const shadows = adj.shadows / 100;
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    // Exposure (multiply)
    v *= expMul;
    // Blacks: push very dark values down/up. Hits only lower third.
    if (blacks !== 0) {
      const w = Math.max(0, 1 - v / 0.35);
      v += blacks * w * 0.4;
    }
    // Whites: lift highlights. Hits only upper third.
    if (whites !== 0) {
      const w = Math.max(0, (v - 0.65) / 0.35);
      v += whites * w * 0.4;
    }
    // Highlights: soften/boost bright values (smooth falloff)
    if (highlights !== 0) {
      const t = Math.max(0, v - 0.5) / 0.5;
      const w = t * t;
      v += highlights * w * 0.35;
    }
    // Shadows: lift/lower dark values (smooth falloff)
    if (shadows !== 0) {
      const t = Math.max(0, 0.5 - v) / 0.5;
      const w = t * t;
      v += shadows * w * 0.35;
    }
    // Contrast S-curve around 0.5
    v = (v - 0.5) * contrastF + 0.5;
    // Clamp then apply tone curve
    const i2 = Math.max(0, Math.min(255, Math.round(v * 255)));
    lut[i] = curveLUT[i2];
  }
  return lut;
}

// ── Separable box blur on a single-channel Float32 buffer ─────────────────────

function boxBlur1D(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h;
  const other = horizontal ? h : w;
  const inv = 1 / (2 * r + 1);
  for (let o = 0; o < other; o++) {
    let sum = 0;
    // Prime running sum with left edge
    const firstIdx = horizontal ? o * w : o;
    const step = horizontal ? 1 : w;
    sum = src[firstIdx] * (r + 1);
    for (let i = 0; i < r && i < len; i++) {
      sum += src[firstIdx + (i + 1) * step];
    }
    for (let i = 0; i < len; i++) {
      const idx = firstIdx + i * step;
      dst[idx] = sum * inv;
      const iOut = Math.max(0, i - r);
      const iIn = Math.min(len - 1, i + r + 1);
      sum += src[firstIdx + iIn * step] - src[firstIdx + iOut * step];
    }
  }
}

function boxBlur(src: Float32Array, w: number, h: number, r: number, passes = 1): Float32Array {
  let a = src;
  let b = new Float32Array(src.length);
  for (let i = 0; i < passes; i++) {
    boxBlur1D(a, b, w, h, r, true);
    boxBlur1D(b, a, w, h, r, false);
  }
  return a;
}

// ── Compute histogram ─────────────────────────────────────────────────────────

interface Histo { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; }
function computeHistogram(data: Uint8ClampedArray): Histo {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++;
    const lum = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    l[Math.max(0, Math.min(255, lum))]++;
  }
  return { r, g, b, l };
}

// ── HSL range membership (smooth weighting) ───────────────────────────────────

function hslWeight(hue: number, center: number): number {
  // Returns 0..1 with smooth falloff within ±~30° of center.
  let d = Math.abs(hue - center);
  if (d > 180) d = 360 - d;
  if (d > 45) return 0;
  const t = 1 - d / 45;
  return t * t * (3 - 2 * t);
}

// ── The big pipeline ──────────────────────────────────────────────────────────

function renderPipeline(src: ImageData, adj: Adjustments): ImageData {
  const { width, height } = src;
  const srcData = src.data;
  const out = new ImageData(width, height);
  const d = out.data;

  const lut = buildLightLUT(adj);

  // Compute luma plane if any neighborhood op is needed
  const npx = width * height;
  const needsClarity = adj.clarity !== 0;
  const needsTexture = adj.texture !== 0;
  const needsDehaze = adj.dehaze !== 0;
  const needsLumaBuf = needsClarity || needsTexture || needsDehaze;

  let luma: Float32Array | null = null;
  let blurClarity: Float32Array | null = null;
  let blurTexture: Float32Array | null = null;

  if (needsLumaBuf) {
    luma = new Float32Array(npx);
    for (let i = 0, p = 0; i < srcData.length; i += 4, p++) {
      luma[p] = (0.2126 * srcData[i] + 0.7152 * srcData[i + 1] + 0.0722 * srcData[i + 2]) / 255;
    }
    // Scale radii with image size so effect looks similar across resolutions
    const baseR = Math.max(2, Math.round(Math.min(width, height) / 60));
    if (needsClarity) {
      const clarRadius = baseR * 4;
      const buf = new Float32Array(luma);
      blurClarity = boxBlur(buf, width, height, clarRadius, 2);
    }
    if (needsTexture || needsDehaze) {
      const texRadius = baseR;
      const buf = new Float32Array(luma);
      blurTexture = boxBlur(buf, width, height, texRadius, 2);
    }
  }

  const tempR = adj.temperature / 100 * 0.12;
  const tempG = adj.temperature / 100 * 0.04;
  const tempB = adj.temperature / 100 * -0.12;
  const tintR = adj.tint / 100 * 0.06;
  const tintG = adj.tint / 100 * -0.1;
  const tintB = adj.tint / 100 * 0.06;

  const vibrance = adj.vibrance / 100;
  const saturation = adj.saturation / 100;
  const clarity = adj.clarity / 100;
  const texture = adj.texture / 100;
  const dehaze = adj.dehaze / 100;

  const hueRad = (adj.hue / 180) * Math.PI;
  const doHueRotate = hueRad !== 0;

  // Precompute per-range HSL adjustments so inner loop is lean
  const hslH: number[] = new Array(8);
  const hslS: number[] = new Array(8);
  const hslL: number[] = new Array(8);
  let anyHsl = false;
  HSL_RANGES.forEach((name, i) => {
    hslH[i] = adj.hsl[name].h; hslS[i] = adj.hsl[name].s; hslL[i] = adj.hsl[name].l;
    if (hslH[i] || hslS[i] || hslL[i]) anyHsl = true;
  });
  const rangeCenters = HSL_RANGES.map((n) => HSL_CENTERS[n]);

  // Split toning setup
  const doShadowTone = adj.shadowSat > 0;
  const doHighlightTone = adj.highlightSat > 0;
  const [sR, sG, sB] = doShadowTone ? hslToRgb(adj.shadowHue, 1, 0.5) : [0, 0, 0];
  const [hR, hG, hB] = doHighlightTone ? hslToRgb(adj.highlightHue, 1, 0.5) : [0, 0, 0];
  const shadowAmt = adj.shadowSat / 200;
  const highlightAmt = adj.highlightSat / 200;

  for (let i = 0, p = 0; i < srcData.length; i += 4, p++) {
    // Apply light LUT
    let r = lut[srcData[i]] / 255;
    let g = lut[srcData[i + 1]] / 255;
    let b = lut[srcData[i + 2]] / 255;
    const a = srcData[i + 3];

    // Dehaze (contrast stretch on local area)
    if (needsDehaze && blurTexture) {
      const base = blurTexture[p];
      // Push away from local mean (boost contrast) + slight saturation up
      const factor = 1 + dehaze * 0.5;
      r = base + (r - base) * factor;
      g = base + (g - base) * factor;
      b = base + (b - base) * factor;
    }
    // Clarity (mid-tone local contrast)
    if (needsClarity && blurClarity && luma) {
      const diff = luma[p] - blurClarity[p];
      const mid = 1 - Math.abs(luma[p] * 2 - 1); // peaks in midtones
      const amt = clarity * diff * mid * 1.6;
      r += amt; g += amt; b += amt;
    }
    // Texture (fine detail enhancement)
    if (needsTexture && blurTexture && luma) {
      const diff = luma[p] - blurTexture[p];
      const amt = texture * diff * 1.2;
      r += amt; g += amt; b += amt;
    }

    // Temperature/tint
    r += tempR; g += tempG; b += tempB;
    r += tintR; g += tintG; b += tintB;

    // Clamp so HSL math is stable
    r = r < 0 ? 0 : r > 1 ? 1 : r;
    g = g < 0 ? 0 : g > 1 ? 1 : g;
    b = b < 0 ? 0 : b > 1 ? 1 : b;

    // Split toning
    if (doShadowTone || doHighlightTone) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (doShadowTone) {
        const w = Math.pow(1 - lum, 2) * shadowAmt;
        r = r * (1 - w) + sR * w;
        g = g * (1 - w) + sG * w;
        b = b * (1 - w) + sB * w;
      }
      if (doHighlightTone) {
        const w = Math.pow(lum, 2) * highlightAmt;
        r = r * (1 - w) + hR * w;
        g = g * (1 - w) + hG * w;
        b = b * (1 - w) + hB * w;
      }
    }

    // HSL per-range + global hue rotate + vibrance + saturation
    const needsHsl = anyHsl || vibrance !== 0 || saturation !== 0 || doHueRotate;
    if (needsHsl) {
      let [H, Sv, L] = rgbToHsl(r, g, b);
      if (doHueRotate) H += adj.hue;
      if (anyHsl) {
        let dH = 0, dS = 0, dL = 0;
        for (let k = 0; k < 8; k++) {
          const w = hslWeight(H, rangeCenters[k]);
          if (w > 0) { dH += hslH[k] * w; dS += hslS[k] * w; dL += hslL[k] * w; }
        }
        H += dH * 0.6;          // degrees
        Sv += (dS / 100) * (Sv > 0 ? 1 : 0.3);
        L += (dL / 100) * 0.35;
      }
      if (vibrance !== 0) {
        Sv += vibrance * (1 - Sv);
      }
      if (saturation !== 0) {
        Sv *= 1 + saturation;
      }
      Sv = Sv < 0 ? 0 : Sv > 1 ? 1 : Sv;
      L = L < 0 ? 0 : L > 1 ? 1 : L;
      [r, g, b] = hslToRgb(H, Sv, L);
    }

    d[i] = r < 0 ? 0 : r > 1 ? 255 : Math.round(r * 255);
    d[i + 1] = g < 0 ? 0 : g > 1 ? 255 : Math.round(g * 255);
    d[i + 2] = b < 0 ? 0 : b > 1 ? 255 : Math.round(b * 255);
    d[i + 3] = a;
  }

  // Sharpen (unsharp mask using output luma)
  if (adj.sharpness > 0) {
    applySharpen(d, width, height, adj.sharpness / 100);
  }
  // Noise reduction (blur luma channel, keep chroma)
  if (adj.noiseReduction > 0) {
    applyNoiseReduction(d, width, height, adj.noiseReduction / 100);
  }
  // Grain
  if (adj.grain > 0) {
    applyGrain(d, width, height, adj.grain / 100);
  }
  // Vignette
  if (adj.vignette !== 0) {
    applyVignette(d, width, height, adj.vignette / 100);
  }

  return out;
}

// ── Detail / effect passes ────────────────────────────────────────────────────

function applySharpen(data: Uint8ClampedArray, w: number, h: number, amount: number) {
  // Extract luma, blur (r=1), compute mask and add back amplified difference.
  const n = w * h;
  const luma = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    luma[p] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
  }
  const blur = boxBlur(new Float32Array(luma), w, h, 1, 1);
  const k = amount * 1.2;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const delta = luma[p] - blur[p];
    const add = delta * k;
    data[i] = clamp255(data[i] + add);
    data[i + 1] = clamp255(data[i + 1] + add);
    data[i + 2] = clamp255(data[i + 2] + add);
  }
}

function applyNoiseReduction(data: Uint8ClampedArray, w: number, h: number, amount: number) {
  // Simple: blend each pixel with a small box-blurred version proportional to amount.
  const n = w * h;
  const chan = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    chan[0][p] = data[i]; chan[1][p] = data[i + 1]; chan[2][p] = data[i + 2];
  }
  const r = Math.max(1, Math.round(1 + amount * 2));
  const b0 = boxBlur(chan[0], w, h, r, 1);
  const b1 = boxBlur(chan[1], w, h, r, 1);
  const b2 = boxBlur(chan[2], w, h, r, 1);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    data[i] = clamp255(data[i] * (1 - amount) + b0[p] * amount);
    data[i + 1] = clamp255(data[i + 1] * (1 - amount) + b1[p] * amount);
    data[i + 2] = clamp255(data[i + 2] * (1 - amount) + b2[p] * amount);
  }
}

function applyGrain(data: Uint8ClampedArray, _w: number, _h: number, amount: number) {
  // Monochrome film-like grain.
  const range = amount * 40;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * range;
    data[i] = clamp255(data[i] + n);
    data[i + 1] = clamp255(data[i + 1] + n);
    data[i + 2] = clamp255(data[i + 2] + n);
  }
}

function applyVignette(data: Uint8ClampedArray, w: number, h: number, amount: number) {
  const cx = w / 2, cy = h / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist;
      const factor = 1 - amount * Math.pow(dist, 2);
      data[idx] = clamp255(data[idx] * factor);
      data[idx + 1] = clamp255(data[idx + 1] * factor);
      data[idx + 2] = clamp255(data[idx + 2] * factor);
    }
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ── Slider ────────────────────────────────────────────────────────────────────

function Slider({ label, value, min, max, step = 1, onChange, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; onCommit?: () => void;
}) {
  const display = step < 1 ? value.toFixed(2) : String(value);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={S.label}>
        <span>{label}</span>
        <span style={{ fontFamily: 'monospace', cursor: 'pointer' }} onDoubleClick={() => onChange(0)}>{value > 0 ? '+' : ''}{display}</span>
      </div>
      <input
        type='range' min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onMouseUp={onCommit} onTouchEnd={onCommit}
        style={{ width: '100%', accentColor: '#000' }}
      />
    </div>
  );
}

// ── Collapsible panel ─────────────────────────────────────────────────────────

function Panel({ title, children, open, onToggle }: { title: string; children: React.ReactNode; open: boolean; onToggle: () => void; }) {
  return (
    <div style={S.card}>
      <div style={S.panelHeader} onClick={onToggle}>
        <span>{title}</span>
        <span style={{ fontSize: 18 }}>{open ? '−' : '+'}</span>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

// ── Tone curve editor ─────────────────────────────────────────────────────────

function ToneCurveEditor({ points, onChange, histo }: { points: CurvePoint[]; onChange: (pts: CurvePoint[]) => void; histo: Uint32Array | null; }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef<number | null>(null);
  const SIZE = 220;

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, SIZE, SIZE);
    // Histogram background
    if (histo) {
      let max = 0;
      for (let i = 0; i < 256; i++) if (histo[i] > max) max = histo[i];
      if (max > 0) {
        ctx.fillStyle = '#ddd';
        for (let i = 0; i < 256; i++) {
          const bar = (histo[i] / max) * SIZE;
          const x = (i / 255) * SIZE;
          ctx.fillRect(x, SIZE - bar, SIZE / 255 + 1, bar);
        }
      }
    }
    // Grid
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = (i / 4) * SIZE;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(SIZE, p); ctx.stroke();
    }
    // Diagonal reference
    ctx.strokeStyle = '#ccc';
    ctx.beginPath(); ctx.moveTo(0, SIZE); ctx.lineTo(SIZE, 0); ctx.stroke();
    // Curve
    const lut = buildCurveLUT(points);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < 256; x++) {
      const cx = (x / 255) * SIZE;
      const cy = SIZE - (lut[x] / 255) * SIZE;
      if (x === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
    }
    ctx.stroke();
    // Points
    ctx.fillStyle = '#000';
    points.forEach((pt) => {
      const cx = (pt.x / 255) * SIZE;
      const cy = SIZE - (pt.y / 255) * SIZE;
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.stroke();
    });
  }, [points, histo]);

  useEffect(() => { draw(); }, [draw]);

  const toDataCoords = (e: React.MouseEvent | React.TouchEvent) => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const cx = ('touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX) - rect.left;
    const cy = ('touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY) - rect.top;
    return {
      x: Math.max(0, Math.min(255, Math.round((cx / rect.width) * 255))),
      y: Math.max(0, Math.min(255, Math.round((1 - cy / rect.height) * 255))),
    };
  };

  const findPoint = (x: number, y: number): number => {
    for (let i = 0; i < points.length; i++) {
      const px = (points[i].x / 255) * SIZE;
      const py = SIZE - (points[i].y / 255) * SIZE;
      const mx = (x / 255) * SIZE;
      const my = SIZE - (y / 255) * SIZE;
      if (Math.hypot(mx - px, my - py) < 12) return i;
    }
    return -1;
  };

  const onDown = (e: React.MouseEvent | React.TouchEvent) => {
    const { x, y } = toDataCoords(e);
    let idx = findPoint(x, y);
    if (idx === -1) {
      const next = [...points, { x, y }].sort((a, b) => a.x - b.x);
      idx = next.findIndex((p) => p.x === x && p.y === y);
      onChange(next);
    }
    draggingRef.current = idx;
  };

  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (draggingRef.current == null) return;
    e.preventDefault();
    const i = draggingRef.current;
    const { x, y } = toDataCoords(e);
    const next = [...points];
    // Lock endpoints on x axis
    if (i === 0) next[i] = { x: 0, y };
    else if (i === next.length - 1) next[i] = { x: 255, y };
    else {
      const minX = next[i - 1].x + 1;
      const maxX = next[i + 1].x - 1;
      next[i] = { x: Math.max(minX, Math.min(maxX, x)), y };
    }
    onChange(next);
  };

  const onUp = () => { draggingRef.current = null; };

  const onDouble = (e: React.MouseEvent) => {
    const { x, y } = toDataCoords(e);
    const idx = findPoint(x, y);
    if (idx > 0 && idx < points.length - 1) {
      onChange(points.filter((_, i) => i !== idx));
    }
  };

  return (
    <div>
      <canvas
        ref={canvasRef} width={SIZE} height={SIZE}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
        onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
        onDoubleClick={onDouble}
        style={{ border: '2px solid #000', display: 'block', background: '#fff', width: '100%', maxWidth: SIZE, touchAction: 'none', cursor: 'crosshair' }}
      />
      <p style={{ ...S.p, fontSize: 11, marginTop: 6, color: '#555' }}>
        Click to add a point · drag to move · double-click to remove
      </p>
    </div>
  );
}

// ── Histogram view ────────────────────────────────────────────────────────────

function HistogramView({ histo }: { histo: Histo | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const W = 220, H = 70;
  useEffect(() => {
    const c = canvasRef.current; if (!c || !histo) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    const max = Math.max(
      ...histo.r, ...histo.g, ...histo.b,
    );
    if (max === 0) return;
    ctx.globalCompositeOperation = 'screen';
    const channels: Array<[Uint32Array, string]> = [[histo.r, '#f00'], [histo.g, '#0f0'], [histo.b, '#00f']];
    channels.forEach(([arr, color]) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * W;
        const y = H - (arr[i] / max) * H;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
  }, [histo]);
  return (
    <canvas ref={canvasRef} width={W} height={H} style={{ border: '2px solid #000', background: '#000', display: 'block', width: W, height: H }} />
  );
}

// ── TIFF loader via UTIF.js (CDN) ─────────────────────────────────────────────

function loadUtif(): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).UTIF) return resolve((window as any).UTIF);
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js';
    script.onload = () => resolve((window as any).UTIF);
    script.onerror = () => reject(new Error('Failed to load UTIF.js'));
    document.head.appendChild(script);
  });
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ColorEditor() {
  const [file, setFile] = useState<File | null>(null);
  const [adj, setAdj] = useState<Adjustments>(defaultAdj);
  const [rendering, setRendering] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [compareDown, setCompareDown] = useState(false);
  const [hslSelected, setHslSelected] = useState<HslRange>('red');
  const [histo, setHisto] = useState<Histo | null>(null);
  const [panels, setPanels] = useState({
    light: true, color: true, hsl: false, curve: false, grade: false, detail: false, effects: false,
  });

  const originalRef = useRef<ImageData | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<Adjustments[]>([defaultAdj()]);
  const historyIdxRef = useRef<number>(0);
  const renderRafRef = useRef<number | null>(null);
  const pendingAdjRef = useRef<Adjustments | null>(null);

  const scheduleRender = useCallback((adjustments: Adjustments) => {
    pendingAdjRef.current = adjustments;
    if (renderRafRef.current != null) return;
    setRendering(true);
    renderRafRef.current = requestAnimationFrame(() => {
      renderRafRef.current = null;
      const next = pendingAdjRef.current!;
      pendingAdjRef.current = null;
      if (!originalRef.current || !canvasRef.current) { setRendering(false); return; }
      const out = renderPipeline(originalRef.current, next);
      canvasRef.current.getContext('2d')!.putImageData(out, 0, 0);
      setHisto(computeHistogram(out.data));
      setRendering(false);
    });
  }, []);

  // Recompute histogram for original once when loaded, before any render
  const setOriginal = (img: ImageData) => {
    originalRef.current = img;
    setHisto(computeHistogram(img.data));
  };

  const loadFile = async (f: File) => {
    const isTiff = f.type === 'image/tiff' || f.type === 'image/x-tiff' || /\.tiff?$/i.test(f.name);
    if (!f.type.startsWith('image/') && !isTiff) return;
    setFile(f);
    const fresh = defaultAdj();
    setAdj(fresh);
    historyRef.current = [fresh];
    historyIdxRef.current = 0;
    setLoadError(null);

    const maxW = 1400, maxH = 900;
    const paintFrom = (source: CanvasImageSource | ImageData, srcW: number, srcH: number) => {
      const scale = Math.min(1, maxW / srcW, maxH / srcH);
      const w = Math.round(srcW * scale);
      const h = Math.round(srcH * scale);
      const c = canvasRef.current!;
      c.width = w; c.height = h;
      const ctx = c.getContext('2d')!;
      if (source instanceof ImageData) {
        const tmp = document.createElement('canvas');
        tmp.width = srcW; tmp.height = srcH;
        tmp.getContext('2d')!.putImageData(source, 0, 0);
        ctx.drawImage(tmp, 0, 0, w, h);
      } else {
        ctx.drawImage(source, 0, 0, w, h);
      }
      setOriginal(ctx.getImageData(0, 0, w, h));
    };

    if (isTiff) {
      try {
        const UTIF = await loadUtif();
        const buf = await f.arrayBuffer();
        const ifds = UTIF.decode(buf);
        if (!ifds.length) throw new Error('No images found in TIFF');
        UTIF.decodeImage(buf, ifds[0]);
        const rgba = UTIF.toRGBA8(ifds[0]);
        const srcW = ifds[0].width as number;
        const srcH = ifds[0].height as number;
        paintFrom(new ImageData(new Uint8ClampedArray(rgba), srcW, srcH), srcW, srcH);
      } catch (e: any) {
        setLoadError('Failed to load TIFF: ' + (e.message ?? String(e)));
      }
      return;
    }

    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { paintFrom(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); };
    img.onerror = () => setLoadError('Failed to load image. Try a different format.');
    img.src = url;
  };

  const applyAdj = (next: Adjustments) => {
    setAdj(next);
    scheduleRender(next);
  };

  const commitHistory = useCallback(() => {
    const cur = adj;
    const hist = historyRef.current;
    const idx = historyIdxRef.current;
    // Skip commits that don't change anything
    if (idx >= 0 && JSON.stringify(hist[idx]) === JSON.stringify(cur)) return;
    hist.splice(idx + 1);
    hist.push(JSON.parse(JSON.stringify(cur)));
    if (hist.length > 40) hist.shift();
    historyIdxRef.current = hist.length - 1;
  }, [adj]);

  const undo = () => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current--;
    const prev = historyRef.current[historyIdxRef.current];
    applyAdj(JSON.parse(JSON.stringify(prev)));
  };
  const redo = () => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current++;
    const next = historyRef.current[historyIdxRef.current];
    applyAdj(JSON.parse(JSON.stringify(next)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!file) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file]);

  const update = <K extends keyof Adjustments>(key: K) => (v: Adjustments[K]) => {
    applyAdj({ ...adj, [key]: v });
  };

  const updateHsl = (param: 'h' | 's' | 'l') => (v: number) => {
    const next = {
      ...adj,
      hsl: { ...adj.hsl, [hslSelected]: { ...adj.hsl[hslSelected], [param]: v } },
    };
    applyAdj(next);
  };

  const reset = () => {
    applyAdj(defaultAdj());
    commitHistory();
  };

  const applyPreset = (name: string) => {
    if (name === 'Default') { reset(); return; }
    const p = PRESETS[name];
    if (!p) return;
    applyAdj({ ...defaultAdj(), ...p });
    setTimeout(commitHistory, 0);
  };

  // Show original on compare hold
  useEffect(() => {
    if (!file || !originalRef.current || !canvasRef.current) return;
    if (compareDown) {
      canvasRef.current.getContext('2d')!.putImageData(originalRef.current, 0, 0);
    } else if (hasChanges(adj)) {
      scheduleRender(adj);
    }
  }, [compareDown]);

  const download = () => {
    if (!canvasRef.current || !file) return;
    const isTiff = /\.tiff?$/i.test(file.name);
    const ext = isTiff ? 'png' : (file.name.match(/\.(jpe?g|png|webp)$/i)?.[1] ?? 'jpg');
    const type = ext.startsWith('j') ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const a = document.createElement('a');
    a.href = canvasRef.current.toDataURL(type, 0.95);
    a.download = file.name.replace(/\.[^.]+$/, `-edited.${ext === 'jpeg' ? 'jpg' : ext}`);
    a.click();
  };

  const changed = hasChanges(adj);

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={S.card}>
        <h1 style={S.h1}>🎨 Color Editor</h1>
        <p style={S.p}>Lightroom-style non-destructive color grading in your browser. Tone, HSL mixer, tone curve, split toning, detail, and grain — all processed locally.</p>
      </div>

      {!file && (
        <div
          onClick={() => fileInputRef.current?.click()}
          style={{ ...S.card, textAlign: 'center', padding: '60px 20px', cursor: 'pointer', minHeight: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}
        >
          <input ref={fileInputRef} type='file' accept='image/*,.tif,.tiff' style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
          <span style={{ fontSize: 52 }}>📷</span>
          <p style={{ ...S.p, fontWeight: 700, fontSize: 16 }}>Drop an image here or click to open</p>
          <p style={{ ...S.p, fontSize: 12, color: '#666' }}>JPEG · PNG · WebP · TIFF</p>
        </div>
      )}
      {loadError && <p style={{ ...S.p, color: '#c00', marginBottom: 12 }}>{loadError}</p>}

      {file && (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12, alignItems: 'start' }}>
          {/* ── Controls column ───────────────────────────────────────────── */}
          <div>
            {/* Presets */}
            <div style={S.card}>
              <h2 style={{ ...S.h2, marginBottom: 8 }}>Preset</h2>
              <select
                style={S.select}
                onChange={(e) => { if (e.target.value) { applyPreset(e.target.value); e.target.value = ''; } }}
                defaultValue=''
              >
                <option value='' disabled>Choose a look…</option>
                <option value='Default'>Default (reset)</option>
                {Object.keys(PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>

            {/* Light */}
            <Panel title='Light' open={panels.light} onToggle={() => setPanels((s) => ({ ...s, light: !s.light }))}>
              <Slider label='Exposure' value={adj.exposure} min={-5} max={5} step={0.05} onChange={update('exposure')} onCommit={commitHistory} />
              <Slider label='Contrast' value={adj.contrast} min={-100} max={100} onChange={update('contrast')} onCommit={commitHistory} />
              <Slider label='Highlights' value={adj.highlights} min={-100} max={100} onChange={update('highlights')} onCommit={commitHistory} />
              <Slider label='Shadows' value={adj.shadows} min={-100} max={100} onChange={update('shadows')} onCommit={commitHistory} />
              <Slider label='Whites' value={adj.whites} min={-100} max={100} onChange={update('whites')} onCommit={commitHistory} />
              <Slider label='Blacks' value={adj.blacks} min={-100} max={100} onChange={update('blacks')} onCommit={commitHistory} />
            </Panel>

            {/* Color */}
            <Panel title='Color' open={panels.color} onToggle={() => setPanels((s) => ({ ...s, color: !s.color }))}>
              <Slider label='Temperature' value={adj.temperature} min={-100} max={100} onChange={update('temperature')} onCommit={commitHistory} />
              <Slider label='Tint' value={adj.tint} min={-100} max={100} onChange={update('tint')} onCommit={commitHistory} />
              <Slider label='Vibrance' value={adj.vibrance} min={-100} max={100} onChange={update('vibrance')} onCommit={commitHistory} />
              <Slider label='Saturation' value={adj.saturation} min={-100} max={100} onChange={update('saturation')} onCommit={commitHistory} />
              <Slider label='Hue shift' value={adj.hue} min={-180} max={180} onChange={update('hue')} onCommit={commitHistory} />
            </Panel>

            {/* HSL */}
            <Panel title='Color mixer (HSL)' open={panels.hsl} onToggle={() => setPanels((s) => ({ ...s, hsl: !s.hsl }))}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
                {HSL_RANGES.map((r) => (
                  <button key={r} onClick={() => setHslSelected(r)} title={r}
                    style={{
                      width: 30, height: 30, border: hslSelected === r ? '3px solid #000' : '2px solid #000',
                      background: HSL_SWATCHES[r], cursor: 'pointer',
                      boxShadow: hslSelected === r ? '2px 2px 0 #000' : 'none',
                    }}
                  />
                ))}
              </div>
              <Slider label='Hue' value={adj.hsl[hslSelected].h} min={-100} max={100} onChange={updateHsl('h')} onCommit={commitHistory} />
              <Slider label='Saturation' value={adj.hsl[hslSelected].s} min={-100} max={100} onChange={updateHsl('s')} onCommit={commitHistory} />
              <Slider label='Luminance' value={adj.hsl[hslSelected].l} min={-100} max={100} onChange={updateHsl('l')} onCommit={commitHistory} />
            </Panel>

            {/* Curve */}
            <Panel title='Tone curve' open={panels.curve} onToggle={() => setPanels((s) => ({ ...s, curve: !s.curve }))}>
              <ToneCurveEditor
                points={adj.curve}
                onChange={(pts) => applyAdj({ ...adj, curve: pts })}
                histo={histo?.l ?? null}
              />
              <button style={{ ...S.btn('#fff', '#000'), marginTop: 8 }} onClick={() => applyAdj({ ...adj, curve: defaultCurve() })}>
                Reset curve
              </button>
            </Panel>

            {/* Color grading / split toning */}
            <Panel title='Color grading' open={panels.grade} onToggle={() => setPanels((s) => ({ ...s, grade: !s.grade }))}>
              <p style={{ ...S.p, fontSize: 11, color: '#666', marginBottom: 6 }}>Shadows</p>
              <Slider label='Hue' value={adj.shadowHue} min={0} max={360} onChange={update('shadowHue')} onCommit={commitHistory} />
              <Slider label='Saturation' value={adj.shadowSat} min={0} max={100} onChange={update('shadowSat')} onCommit={commitHistory} />
              <p style={{ ...S.p, fontSize: 11, color: '#666', margin: '8px 0 6px' }}>Highlights</p>
              <Slider label='Hue' value={adj.highlightHue} min={0} max={360} onChange={update('highlightHue')} onCommit={commitHistory} />
              <Slider label='Saturation' value={adj.highlightSat} min={0} max={100} onChange={update('highlightSat')} onCommit={commitHistory} />
            </Panel>

            {/* Detail */}
            <Panel title='Detail' open={panels.detail} onToggle={() => setPanels((s) => ({ ...s, detail: !s.detail }))}>
              <Slider label='Texture' value={adj.texture} min={-100} max={100} onChange={update('texture')} onCommit={commitHistory} />
              <Slider label='Clarity' value={adj.clarity} min={-100} max={100} onChange={update('clarity')} onCommit={commitHistory} />
              <Slider label='Dehaze' value={adj.dehaze} min={-100} max={100} onChange={update('dehaze')} onCommit={commitHistory} />
              <Slider label='Sharpness' value={adj.sharpness} min={0} max={100} onChange={update('sharpness')} onCommit={commitHistory} />
              <Slider label='Noise reduction' value={adj.noiseReduction} min={0} max={100} onChange={update('noiseReduction')} onCommit={commitHistory} />
            </Panel>

            {/* Effects */}
            <Panel title='Effects' open={panels.effects} onToggle={() => setPanels((s) => ({ ...s, effects: !s.effects }))}>
              <Slider label='Vignette' value={adj.vignette} min={-100} max={100} onChange={update('vignette')} onCommit={commitHistory} />
              <Slider label='Grain' value={adj.grain} min={0} max={100} onChange={update('grain')} onCommit={commitHistory} />
            </Panel>
          </div>

          {/* ── Preview column ────────────────────────────────────────────── */}
          <div>
            {/* Toolbar */}
            <div style={{ ...S.card, padding: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button style={S.iconBtn()} onClick={undo} title='Undo (⌘Z)'>↶ Undo</button>
                <button style={S.iconBtn()} onClick={redo} title='Redo (⌘⇧Z)'>↷ Redo</button>
                <button
                  style={S.iconBtn(compareDown)}
                  onMouseDown={() => setCompareDown(true)}
                  onMouseUp={() => setCompareDown(false)}
                  onMouseLeave={() => setCompareDown(false)}
                  onTouchStart={() => setCompareDown(true)}
                  onTouchEnd={() => setCompareDown(false)}
                  title='Hold to see original'
                >⇄ Before</button>
                <button style={S.iconBtn()} onClick={reset} disabled={!changed}>↺ Reset</button>
                <button style={S.iconBtn()} onClick={() => fileInputRef.current?.click()}>📂 Open</button>
                <input ref={fileInputRef} type='file' accept='image/*,.tif,.tiff' style={{ display: 'none' }}
                  onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <HistogramView histo={histo} />
                <button style={S.btn()} onClick={download}>⬇ Download</button>
              </div>
            </div>

            {/* Canvas */}
            <div style={{ position: 'relative' }}>
              {rendering && (
                <div style={{ position: 'absolute', top: 8, right: 8, background: '#000', color: '#fff', padding: '4px 10px', fontFamily: 'Poppins, sans-serif', fontSize: 12, zIndex: 10 }}>
                  Rendering…
                </div>
              )}
              {compareDown && (
                <div style={{ position: 'absolute', top: 8, left: 8, background: '#fff', color: '#000', padding: '4px 10px', border: '2px solid #000', fontFamily: 'Poppins, sans-serif', fontSize: 12, fontWeight: 700, zIndex: 10 }}>
                  ORIGINAL
                </div>
              )}
              <canvas
                ref={canvasRef}
                style={{ border: '3px solid #000', display: 'block', maxWidth: '100%', boxShadow: '5px 5px 0 #000', background: '#000' }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasChanges(adj: Adjustments): boolean {
  const d = defaultAdj();
  return JSON.stringify(adj) !== JSON.stringify(d);
}
