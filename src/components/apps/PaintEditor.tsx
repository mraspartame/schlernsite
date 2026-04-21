import { useState, useRef, useEffect, useCallback } from 'react';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_W = 1920, DEFAULT_H = 1080;
const HANDLE_R = 8;   // hit radius for resize handles (px)
const HANDLE_SZ = 8;  // visual size of handles (px)

// ── Types ─────────────────────────────────────────────────────────────────────

type Tool = 'select' | 'pencil' | 'eraser' | 'blur' | 'eyedropper' | 'fill' | 'shape' | 'text' | 'crop' | 'smart-select';
type SamStatus = 'unloaded' | 'downloading' | 'ready' | 'inferring';
type BlendMode = 'source-over' | 'multiply' | 'screen' | 'overlay';
type HandlePos = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type BrushKind = 'pencil' | 'marker' | 'airbrush' | 'calligraphy';

const BRUSHES: { id: BrushKind; label: string; icon: string }[] = [
  { id: 'pencil',      label: 'Pencil',      icon: '\u270F\uFE0F' },
  { id: 'marker',      label: 'Marker',      icon: '\uD83D\uDD8D' },
  { id: 'airbrush',    label: 'Airbrush',    icon: '\uD83D\uDCA8' },
  { id: 'calligraphy', label: 'Calligraphy', icon: '\u270D\uFE0F' },
];

interface EffectShadow { enabled: boolean; color: string; blur: number; offsetX: number; offsetY: number; }
interface EffectGlow   { enabled: boolean; color: string; blur: number; }
interface EffectStroke { enabled: boolean; color: string; width: number; }
interface ObjectEffects {
  shadow?: EffectShadow;
  glow?: EffectGlow;
  stroke?: EffectStroke;
}

interface GradientFill {
  enabled: boolean;
  color1: string;
  color2: string;
  angle: number;    // degrees, 0 = left-to-right
  type: 'linear' | 'radial';
}

interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  effects?: ObjectEffects;
}

// Moveable objects (shapes, text, images)
type ShapeKind = 'rect' | 'rect-round' | 'ellipse' | 'circle' | 'line' | 'arrow' | 'triangle' | 'diamond' | 'pentagon' | 'hexagon' | 'star' | 'heart';
type ObjType = ShapeKind | 'text' | 'image';

const SHAPE_KINDS: ShapeKind[] = ['rect', 'rect-round', 'ellipse', 'circle', 'line', 'arrow', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star', 'heart'];

interface PaintObj {
  id: string;
  layerId: string;
  type: ObjType;
  x: number; y: number; w: number; h: number;
  opacity: number;
  // shape
  strokeColor?: string;
  strokeWidth?: number;
  fillColor?: string | null;  // null/undefined = no fill
  fillGradient?: GradientFill; // if enabled, overrides fillColor
  // text
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textAlign?: 'left' | 'center' | 'right';
  // image
  src?: string;
  lockAspect?: boolean;  // maintain aspect ratio on resize
  naturalAr?: number;    // natural w/h ratio
  rotation?: number;     // degrees (0 = upright)
  // effects
  effects?: ObjectEffects;
}

function defaultEffects(): ObjectEffects {
  return {
    shadow: { enabled: false, color: '#000000', blur: 8,  offsetX: 4, offsetY: 4 },
    glow:   { enabled: false, color: '#ffff66', blur: 12 },
    stroke: { enabled: false, color: '#000000', width: 2 },
  };
}

function hasEffects(fx?: ObjectEffects): boolean {
  return !!(fx && (fx.shadow?.enabled || fx.glow?.enabled || fx.stroke?.enabled));
}

// ── Shape path builder ────────────────────────────────────────────────────────

function isShapeKind(t: ObjType): t is ShapeKind {
  return (SHAPE_KINDS as string[]).includes(t);
}

/**
 * Builds the path for a shape inside its bounding box (x,y,w,h — w/h may be negative
 * for drag-in-progress). Does NOT begin or close its own sub-paths for 'line'; the
 * caller is expected to beginPath() before. For filled shapes the path is closed.
 */
function buildShapePath(ctx: CanvasRenderingContext2D, type: ShapeKind, x: number, y: number, w: number, h: number) {
  // Normalize bounding box for polygon-based shapes
  const nx = w < 0 ? x + w : x;
  const ny = h < 0 ? y + h : y;
  const nw = Math.abs(w);
  const nh = Math.abs(h);
  const cx = nx + nw / 2;
  const cy = ny + nh / 2;
  const rx = nw / 2;
  const ry = nh / 2;

  switch (type) {
    case 'rect':
      ctx.rect(x, y, w, h);
      return;
    case 'rect-round': {
      const r = Math.min(nw, nh) * 0.15;
      if (typeof (ctx as any).roundRect === 'function') {
        (ctx as any).roundRect(nx, ny, nw, nh, r);
      } else {
        ctx.moveTo(nx + r, ny);
        ctx.arcTo(nx + nw, ny, nx + nw, ny + nh, r);
        ctx.arcTo(nx + nw, ny + nh, nx, ny + nh, r);
        ctx.arcTo(nx, ny + nh, nx, ny, r);
        ctx.arcTo(nx, ny, nx + nw, ny, r);
        ctx.closePath();
      }
      return;
    }
    case 'ellipse':
    case 'circle':
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      return;
    case 'line':
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
      return;
    case 'arrow':
      // Arrow is drawn in drawObj with stem + head; this path is the head only.
      drawArrowHeadPath(ctx, x, y, w, h);
      return;
    case 'triangle':
      ctx.moveTo(cx, ny);
      ctx.lineTo(nx, ny + nh);
      ctx.lineTo(nx + nw, ny + nh);
      ctx.closePath();
      return;
    case 'diamond':
      ctx.moveTo(cx, ny);
      ctx.lineTo(nx + nw, cy);
      ctx.lineTo(cx, ny + nh);
      ctx.lineTo(nx, cy);
      ctx.closePath();
      return;
    case 'pentagon':
      regularPolygonPath(ctx, cx, cy, rx, ry, 5, -Math.PI / 2);
      return;
    case 'hexagon':
      regularPolygonPath(ctx, cx, cy, rx, ry, 6, -Math.PI / 2);
      return;
    case 'star':
      starPath(ctx, cx, cy, rx, ry, 5, 0.45);
      return;
    case 'heart':
      heartPath(ctx, nx, ny, nw, nh);
      return;
  }
}

function regularPolygonPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, sides: number, rotation: number) {
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    const px = cx + Math.cos(a) * rx;
    const py = cy + Math.sin(a) * ry;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, points: number, innerRatio: number) {
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const r = (i % 2 === 0) ? 1 : innerRatio;
    const a = -Math.PI / 2 + i * step;
    const px = cx + Math.cos(a) * rx * r;
    const py = cy + Math.sin(a) * ry * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function heartPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const topY = y + h * 0.28;
  ctx.moveTo(x + w / 2, y + h);
  ctx.bezierCurveTo(x - w * 0.1, y + h * 0.62, x + w * 0.08, y, x + w / 2, topY);
  ctx.bezierCurveTo(x + w * 0.92, y, x + w * 1.1, y + h * 0.62, x + w / 2, y + h);
  ctx.closePath();
}

function drawArrowHeadPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const len = Math.hypot(w, h);
  if (len < 1) return;
  const ux = w / len, uy = h / len;
  const head = Math.min(24, Math.max(8, len * 0.25));
  const ex = x + w, ey = y + h;
  const baseX = ex - ux * head, baseY = ey - uy * head;
  const nxh = -uy * head * 0.55, nyh = ux * head * 0.55;
  ctx.moveTo(ex, ey);
  ctx.lineTo(baseX + nxh, baseY + nyh);
  ctx.lineTo(baseX - nxh, baseY - nyh);
  ctx.closePath();
}

// ── Pure utility functions (outside component) ────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 7);

function isLineLike(t: ObjType) { return t === 'line' || t === 'arrow'; }

/** Bounding box for display/hit-testing (lines have signed w,h for direction) */
function getDisplayBounds(o: PaintObj) {
  if (isLineLike(o.type)) {
    return {
      x: Math.min(o.x, o.x + o.w),
      y: Math.min(o.y, o.y + o.h),
      w: Math.abs(o.w),
      h: Math.abs(o.h),
    };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

function ptSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function hitTest(o: PaintObj, px: number, py: number): boolean {
  // Transform click into object's local (unrotated) space
  let lx = px, ly = py;
  const rot = o.rotation ?? 0;
  if (rot !== 0) {
    const { x, y, w, h } = getDisplayBounds(o);
    const cx = x + w / 2, cy = y + h / 2;
    const local = rotatePoint(px, py, cx, cy, toRad(-rot));
    lx = local.x; ly = local.y;
  }
  if (isLineLike(o.type)) {
    const d = ptSegDist(lx, ly, o.x, o.y, o.x + o.w, o.y + o.h);
    return d < (o.strokeWidth ?? 2) / 2 + 6;
  }
  const { x, y, w, h } = getDisplayBounds(o);
  return lx >= x - 4 && lx <= x + w + 4 && ly >= y - 4 && ly <= y + h + 4;
}

function getHandles(o: PaintObj): { pos: HandlePos; x: number; y: number }[] {
  if (isLineLike(o.type)) {
    return [
      { pos: 'nw', x: o.x, y: o.y },
      { pos: 'se', x: o.x + o.w, y: o.y + o.h },
    ];
  }
  const { x, y, w, h } = getDisplayBounds(o);
  return [
    { pos: 'nw', x, y },
    { pos: 'n', x: x + w / 2, y },
    { pos: 'ne', x: x + w, y },
    { pos: 'e', x: x + w, y: y + h / 2 },
    { pos: 'se', x: x + w, y: y + h },
    { pos: 's', x: x + w / 2, y: y + h },
    { pos: 'sw', x, y: y + h },
    { pos: 'w', x, y: y + h / 2 },
  ];
}

function handleAt(o: PaintObj, px: number, py: number): HandlePos | null {
  // Transform into local space before checking resize handles
  let lx = px, ly = py;
  const rot = o.rotation ?? 0;
  if (rot !== 0) {
    const { x, y, w, h } = getDisplayBounds(o);
    const cx = x + w / 2, cy = y + h / 2;
    const local = rotatePoint(px, py, cx, cy, toRad(-rot));
    lx = local.x; ly = local.y;
  }
  for (const h of getHandles(o)) {
    if (Math.abs(lx - h.x) < HANDLE_R && Math.abs(ly - h.y) < HANDLE_R) return h.pos;
  }
  return null;
}

function applyResize(orig: PaintObj, handle: HandlePos, dx: number, dy: number): PaintObj {
  const o = { ...orig };
  if (isLineLike(o.type)) {
    if (handle === 'nw') { o.x += dx; o.y += dy; o.w -= dx; o.h -= dy; }
    if (handle === 'se') { o.w += dx; o.h += dy; }
    return o;
  }
  switch (handle) {
    case 'nw': o.x += dx; o.y += dy; o.w -= dx; o.h -= dy; break;
    case 'n':  o.y += dy; o.h -= dy; break;
    case 'ne': o.y += dy; o.w += dx; o.h -= dy; break;
    case 'e':  o.w += dx; break;
    case 'se': o.w += dx; o.h += dy; break;
    case 's':  o.h += dy; break;
    case 'sw': o.x += dx; o.w -= dx; o.h += dy; break;
    case 'w':  o.x += dx; o.w -= dx; break;
  }
  return o;
}

function normBounds(o: PaintObj): PaintObj {
  if (isLineLike(o.type)) return o;
  const r = { ...o };
  if (r.w < 0) { r.x += r.w; r.w = -r.w; }
  if (r.h < 0) { r.y += r.h; r.h = -r.h; }
  return r;
}

function measureText(text: string, fontSize: number, fontFamily = 'Poppins, sans-serif'): { w: number; h: number } {
  const c = document.createElement('canvas').getContext('2d')!;
  c.font = `${fontSize}px ${fontFamily}`;
  const lineH = Math.ceil(fontSize * 1.4);
  const lines = (text || '').split('\n');
  let maxW = 0;
  for (const line of lines) maxW = Math.max(maxW, c.measureText(line).width);
  return { w: Math.ceil(maxW), h: lineH * Math.max(1, lines.length) };
}

/** Get the x,y pixel offset of a cursor at position `pos` within multi-line text */
function getTextCursorXY(text: string, pos: number, fontSize: number, fontFamily = 'Poppins, sans-serif'): { x: number; y: number } {
  const c = document.createElement('canvas').getContext('2d')!;
  c.font = `${fontSize}px ${fontFamily}`;
  const lineH = Math.ceil(fontSize * 1.4);
  const before = text.slice(0, pos);
  const lines = before.split('\n');
  const row = lines.length - 1;
  const lastLine = lines[row];
  return { x: c.measureText(lastLine).width, y: row * lineH };
}

// ── Rotation helpers ───────────────────────────────────────────────────────────

function toRad(deg: number) { return deg * Math.PI / 180; }

function rotatePoint(px: number, py: number, cx: number, cy: number, rad: number) {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: (px - cx) * cos - (py - cy) * sin + cx, y: (px - cx) * sin + (py - cy) * cos + cy };
}

/** World-space position of the rotation handle circle (30px above top-center, rotated with object). */
function getRotationHandle(o: PaintObj): { x: number; y: number } {
  const { x, y, w, h } = getDisplayBounds(o);
  const cx = x + w / 2, cy = y + h / 2;
  return rotatePoint(cx, cy - h / 2 - 30, cx, cy, toRad(o.rotation ?? 0));
}

function rotationHandleHit(o: PaintObj, px: number, py: number): boolean {
  const rh = getRotationHandle(o);
  return Math.hypot(px - rh.x, py - rh.y) < HANDLE_R + 4;
}

function buildShapeFillStyle(ctx: CanvasRenderingContext2D, o: PaintObj): string | CanvasGradient | null {
  if (o.fillGradient?.enabled) {
    const g = o.fillGradient;
    const nx = o.w < 0 ? o.x + o.w : o.x;
    const ny = o.h < 0 ? o.y + o.h : o.y;
    const nw = Math.abs(o.w);
    const nh = Math.abs(o.h);
    if (g.type === 'radial') {
      const cx = nx + nw / 2, cy = ny + nh / 2;
      const r = Math.max(nw, nh) / 2;
      const grad = ctx.createRadialGradient(cx, cy, r * 0.05, cx, cy, r);
      grad.addColorStop(0, g.color1);
      grad.addColorStop(1, g.color2);
      return grad;
    }
    const rad = toRad(g.angle);
    const cx = nx + nw / 2, cy = ny + nh / 2;
    const half = Math.abs(Math.cos(rad)) * nw / 2 + Math.abs(Math.sin(rad)) * nh / 2;
    const x0 = cx - Math.cos(rad) * half;
    const y0 = cy - Math.sin(rad) * half;
    const x1 = cx + Math.cos(rad) * half;
    const y1 = cy + Math.sin(rad) * half;
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, g.color1);
    grad.addColorStop(1, g.color2);
    return grad;
  }
  return o.fillColor ?? null;
}

function drawObjCore(ctx: CanvasRenderingContext2D, o: PaintObj, imgCache: Map<string, HTMLImageElement>) {
  if (isShapeKind(o.type)) {
    ctx.strokeStyle = o.strokeColor ?? '#000';
    ctx.lineWidth = o.strokeWidth ?? 2;
    ctx.lineJoin = o.type === 'rect' ? 'miter' : 'round';

    if (o.type === 'arrow') {
      const len = Math.hypot(o.w, o.h);
      if (len >= 1) {
        const ux = o.w / len, uy = o.h / len;
        const head = Math.min(24, Math.max(8, len * 0.25));
        const baseX = o.x + o.w - ux * head;
        const baseY = o.y + o.h - uy * head;
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(baseX, baseY);
        ctx.stroke();
        ctx.beginPath();
        drawArrowHeadPath(ctx, o.x, o.y, o.w, o.h);
        ctx.fillStyle = o.strokeColor ?? '#000';
        ctx.fill();
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      buildShapePath(ctx, o.type, o.x, o.y, o.w, o.h);
      const fs = buildShapeFillStyle(ctx, o);
      if (fs && o.type !== 'line') {
        ctx.fillStyle = fs;
        ctx.fill();
      }
      ctx.stroke();
    }
  } else switch (o.type) {
    case 'text': {
      ctx.fillStyle = o.color ?? '#000';
      const fSize = o.fontSize ?? 24;
      const wt = o.fontWeight ?? 'normal';
      const st = o.fontStyle ?? 'normal';
      ctx.font = `${st} ${wt} ${fSize}px ${o.fontFamily ?? 'Poppins, sans-serif'}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      const lineH = Math.ceil(fSize * 1.4);
      const textLines = (o.text ?? '').split('\n');
      for (let li = 0; li < textLines.length; li++) {
        ctx.fillText(textLines[li], o.x, o.y + li * lineH);
      }
      break;
    }
    case 'image': {
      const img = imgCache.get(o.src ?? '');
      if (img) ctx.drawImage(img, o.x, o.y, o.w, o.h);
      break;
    }
  }
}

/** Draw a stroke/outline effect around the object (text = strokeText, shapes = wider stroke underneath). */
function drawEffectStroke(ctx: CanvasRenderingContext2D, o: PaintObj, fx: EffectStroke) {
  ctx.save();
  ctx.strokeStyle = fx.color;
  ctx.lineWidth = fx.width * 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (isShapeKind(o.type)) {
    if (o.type === 'arrow') {
      const len = Math.hypot(o.w, o.h);
      if (len >= 1) {
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(o.x + o.w, o.y + o.h);
        ctx.stroke();
        ctx.beginPath();
        drawArrowHeadPath(ctx, o.x, o.y, o.w, o.h);
        ctx.fillStyle = fx.color;
        ctx.fill();
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      buildShapePath(ctx, o.type, o.x, o.y, o.w, o.h);
      ctx.stroke();
    }
  } else if (o.type === 'text') {
    const fSize = o.fontSize ?? 24;
    const wt = o.fontWeight ?? 'normal';
    const st = o.fontStyle ?? 'normal';
    ctx.font = `${st} ${wt} ${fSize}px ${o.fontFamily ?? 'Poppins, sans-serif'}`;
    ctx.textBaseline = 'top';
    ctx.miterLimit = 2;
    const lineH = Math.ceil(fSize * 1.4);
    const textLines = (o.text ?? '').split('\n');
    for (let li = 0; li < textLines.length; li++) {
      ctx.strokeText(textLines[li], o.x, o.y + li * lineH);
    }
  }
  ctx.restore();
}

function drawObj(ctx: CanvasRenderingContext2D, o: PaintObj, imgCache: Map<string, HTMLImageElement>) {
  ctx.save();
  ctx.globalAlpha = o.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const rot = o.rotation ?? 0;
  if (rot !== 0) {
    const { x, y, w, h } = getDisplayBounds(o);
    const cx = x + w / 2, cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(toRad(rot));
    ctx.translate(-cx, -cy);
  }

  const fx = o.effects;

  // Outline (stroke effect) — draw first, underneath, so it frames the object
  if (fx?.stroke?.enabled) {
    drawEffectStroke(ctx, o, fx.stroke);
  }

  // Glow effect — blurred copy centered under
  if (fx?.glow?.enabled) {
    ctx.save();
    ctx.shadowColor = fx.glow.color;
    ctx.shadowBlur = fx.glow.blur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    // draw object twice to reinforce glow
    drawObjCore(ctx, o, imgCache);
    drawObjCore(ctx, o, imgCache);
    ctx.restore();
  }

  // Drop shadow — apply via canvas shadow filter, then draw object
  if (fx?.shadow?.enabled) {
    ctx.save();
    ctx.shadowColor = fx.shadow.color;
    ctx.shadowBlur = fx.shadow.blur;
    ctx.shadowOffsetX = fx.shadow.offsetX;
    ctx.shadowOffsetY = fx.shadow.offsetY;
    drawObjCore(ctx, o, imgCache);
    ctx.restore();
  }

  // The object itself
  drawObjCore(ctx, o, imgCache);

  ctx.restore();
}

/**
 * Flood fill that READS boundaries from `readCtx` and WRITES fill to `writeCtx`.
 * This lets us use the visual composite (with shape objects) as the boundary
 * while writing only to the raster pixel canvas.
 */
function floodFill(
  readCtx: CanvasRenderingContext2D,
  writeCtx: CanvasRenderingContext2D,
  px: number, py: number,
  hex: string, opacity: number,
) {
  // Use write canvas dimensions as the authoritative size
  const CW = writeCtx.canvas.width, CH = writeCtx.canvas.height;

  // Build a fresh read canvas to avoid any stale context state
  const freshRead = document.createElement('canvas');
  freshRead.width = CW; freshRead.height = CH;
  const freshCtx = freshRead.getContext('2d')!;
  freshCtx.drawImage(readCtx.canvas, 0, 0, CW, CH);
  const rd = freshCtx.getImageData(0, 0, CW, CH).data;

  const ix = Math.round(Math.min(Math.max(px, 0), CW - 1));
  const iy = Math.round(Math.min(Math.max(py, 0), CH - 1));
  const i0 = (iy * CW + ix) * 4;
  const [tr, tg, tb, ta] = [rd[i0], rd[i0 + 1], rd[i0 + 2], rd[i0 + 3]];

  const h = hex.replace('#', '');
  const fr = parseInt(h.slice(0, 2), 16);
  const fg = parseInt(h.slice(2, 4), 16);
  const fb = parseInt(h.slice(4, 6), 16);
  const fa = Math.round(opacity * 255);

  if (tr === fr && tg === fg && tb === fb && ta === fa) return;

  const TOL = 80;
  const matchesAt = (pi: number) => {
    const i = pi * 4;
    return Math.abs(rd[i] - tr) <= TOL &&
      Math.abs(rd[i + 1] - tg) <= TOL &&
      Math.abs(rd[i + 2] - tb) <= TOL &&
      Math.abs(rd[i + 3] - ta) <= TOL;
  };

  // Build fill mask using scanline flood fill
  const fillImg = new ImageData(CW, CH);
  const fd = fillImg.data;
  const visited = new Uint8Array(CW * CH);
  const stack: [number, number][] = [[ix, iy]];

  while (stack.length) {
    const [sx, sy] = stack.pop()!;
    const pi0 = sy * CW + sx;
    if (visited[pi0] || !matchesAt(pi0)) continue;

    let xl = sx;
    while (xl > 0 && !visited[sy * CW + xl - 1] && matchesAt(sy * CW + xl - 1)) xl--;

    let x = xl;
    let aboveOpen = false, belowOpen = false;
    while (x < CW && !visited[sy * CW + x] && matchesAt(sy * CW + x)) {
      const pi = sy * CW + x;
      visited[pi] = 1;
      const bi = pi * 4;
      fd[bi] = fr; fd[bi + 1] = fg; fd[bi + 2] = fb; fd[bi + 3] = fa;

      if (sy > 0) {
        const above = (sy - 1) * CW + x;
        if (!visited[above] && matchesAt(above)) {
          if (!aboveOpen) { stack.push([x, sy - 1]); aboveOpen = true; }
        } else { aboveOpen = false; }
      }

      if (sy < CH - 1) {
        const below = (sy + 1) * CW + x;
        if (!visited[below] && matchesAt(below)) {
          if (!belowOpen) { stack.push([x, sy + 1]); belowOpen = true; }
        } else { belowOpen = false; }
      }

      x++;
    }
  }

  // 1-pixel dilation: expand fill into anti-aliased boundary fringe pixels that
  // were blocked only because two edges combined to exceed TOL (e.g. rect corners).
  // Only dilate into pixels that are NOT solid boundaries (not fully opaque non-target color).
  const isSolidBoundary = (pi: number) => {
    const i = pi * 4;
    // A pixel is a solid boundary if it's significantly different from the target in alpha AND rgb
    return Math.abs(rd[i + 3] - ta) > 200 ||
      (Math.abs(rd[i] - tr) > 200 && Math.abs(rd[i + 1] - tg) > 200 && Math.abs(rd[i + 2] - tb) > 200);
  };
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const pi = y * CW + x;
      if (visited[pi]) continue;
      // Dilate if adjacent to a filled pixel and not a solid boundary
      if (isSolidBoundary(pi)) continue;
      if ((x > 0 && visited[pi - 1]) || (x < CW - 1 && visited[pi + 1]) ||
          (y > 0 && visited[pi - CW]) || (y < CH - 1 && visited[pi + CW])) {
        const bi = pi * 4;
        fd[bi] = fr; fd[bi + 1] = fg; fd[bi + 2] = fb; fd[bi + 3] = fa;
      }
    }
  }

  // Composite fill onto write canvas via a temp canvas (avoids putImageData on writeCtx)
  const fillCanvas = document.createElement('canvas');
  fillCanvas.width = CW; fillCanvas.height = CH;
  fillCanvas.getContext('2d')!.putImageData(fillImg, 0, 0);
  writeCtx.drawImage(fillCanvas, 0, 0);
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  panel: { border: '2px solid #000', background: '#fff', padding: '10px' } as React.CSSProperties,
  toolBtn: (active: boolean) => ({
    border: '2px solid #000',
    background: active ? '#000' : '#fff',
    color: active ? '#fff' : '#000',
    padding: '5px 8px',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'Poppins, sans-serif',
    fontWeight: 700,
    width: '100%',
    textAlign: 'left' as const,
    display: 'block',
    marginBottom: 2,
    boxSizing: 'border-box' as const,
  }),
  smallBtn: (bg = '#fff', fg = '#000') => ({
    border: '1px solid #000', background: bg, color: fg,
    padding: '2px 6px', fontSize: 11, cursor: 'pointer',
    fontFamily: 'Poppins, sans-serif', fontWeight: 700,
  } as React.CSSProperties),
  label: { fontFamily: 'Poppins, sans-serif', fontSize: 11, fontWeight: 700, display: 'block', marginBottom: 2 } as React.CSSProperties,
  input: { border: '1px solid #000', padding: '3px 6px', width: '100%', boxSizing: 'border-box' as const, fontFamily: 'Poppins, sans-serif', fontSize: 12, marginBottom: 4 },
};

// ── EffectsEditor (for objects and layers) ────────────────────────────────────

function EffectsEditor({ title, effects, onChange }: {
  title: string;
  effects: ObjectEffects | undefined;
  onChange: (fx: ObjectEffects) => void;
}) {
  const fx = effects ?? defaultEffects();
  const patch = (p: Partial<ObjectEffects>) => onChange({ ...fx, ...p });

  const sh = fx.shadow ?? { enabled: false, color: '#000000', blur: 8, offsetX: 4, offsetY: 4 };
  const gl = fx.glow ?? { enabled: false, color: '#ffff66', blur: 12 };
  const st = fx.stroke ?? { enabled: false, color: '#000000', width: 2 };

  return (
    <>
      <hr style={{ border: 'none', borderTop: '1px solid #ccc', margin: '8px 0' }} />
      <p style={{ ...S.label, marginBottom: 4 }}>{title}</p>

      {/* Drop Shadow */}
      <label style={{ ...S.label, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
        <input type='checkbox' checked={sh.enabled}
          onChange={(e) => patch({ shadow: { ...sh, enabled: e.target.checked } })} />
        Drop shadow
      </label>
      {sh.enabled && (
        <div style={{ padding: 6, border: '1px solid #000', marginBottom: 4, background: '#fafafa' }}>
          <label style={{ ...S.label, fontSize: 10 }}>Color</label>
          <input type='color' value={sh.color}
            onChange={(e) => patch({ shadow: { ...sh, color: e.target.value } })}
            style={{ width: '100%', height: 22, border: '1px solid #000', padding: 0, cursor: 'pointer', marginBottom: 3 }} />
          <label style={{ ...S.label, fontSize: 10 }}>Blur: {sh.blur}px</label>
          <input type='range' min={0} max={60} value={sh.blur}
            onChange={(e) => patch({ shadow: { ...sh, blur: parseInt(e.target.value) } })}
            style={{ width: '100%' }} />
          <label style={{ ...S.label, fontSize: 10 }}>Offset X: {sh.offsetX}px</label>
          <input type='range' min={-40} max={40} value={sh.offsetX}
            onChange={(e) => patch({ shadow: { ...sh, offsetX: parseInt(e.target.value) } })}
            style={{ width: '100%' }} />
          <label style={{ ...S.label, fontSize: 10 }}>Offset Y: {sh.offsetY}px</label>
          <input type='range' min={-40} max={40} value={sh.offsetY}
            onChange={(e) => patch({ shadow: { ...sh, offsetY: parseInt(e.target.value) } })}
            style={{ width: '100%' }} />
        </div>
      )}

      {/* Outer Glow */}
      <label style={{ ...S.label, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
        <input type='checkbox' checked={gl.enabled}
          onChange={(e) => patch({ glow: { ...gl, enabled: e.target.checked } })} />
        Outer glow
      </label>
      {gl.enabled && (
        <div style={{ padding: 6, border: '1px solid #000', marginBottom: 4, background: '#fafafa' }}>
          <label style={{ ...S.label, fontSize: 10 }}>Color</label>
          <input type='color' value={gl.color}
            onChange={(e) => patch({ glow: { ...gl, color: e.target.value } })}
            style={{ width: '100%', height: 22, border: '1px solid #000', padding: 0, cursor: 'pointer', marginBottom: 3 }} />
          <label style={{ ...S.label, fontSize: 10 }}>Blur: {gl.blur}px</label>
          <input type='range' min={0} max={80} value={gl.blur}
            onChange={(e) => patch({ glow: { ...gl, blur: parseInt(e.target.value) } })}
            style={{ width: '100%' }} />
        </div>
      )}

      {/* Stroke / Outline */}
      <label style={{ ...S.label, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
        <input type='checkbox' checked={st.enabled}
          onChange={(e) => patch({ stroke: { ...st, enabled: e.target.checked } })} />
        Outline
      </label>
      {st.enabled && (
        <div style={{ padding: 6, border: '1px solid #000', marginBottom: 4, background: '#fafafa' }}>
          <label style={{ ...S.label, fontSize: 10 }}>Color</label>
          <input type='color' value={st.color}
            onChange={(e) => patch({ stroke: { ...st, color: e.target.value } })}
            style={{ width: '100%', height: 22, border: '1px solid #000', padding: 0, cursor: 'pointer', marginBottom: 3 }} />
          <label style={{ ...S.label, fontSize: 10 }}>Width: {st.width}px</label>
          <input type='range' min={1} max={20} value={st.width}
            onChange={(e) => patch({ stroke: { ...st, width: parseInt(e.target.value) } })}
            style={{ width: '100%' }} />
        </div>
      )}
    </>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PaintEditor() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [layers, setLayers] = useState<Layer[]>([]);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [objects, setObjects] = useState<PaintObj[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('pencil');
  const [shapeType, setShapeType] = useState<ShapeKind>('rect');
  const [shapeFlyoutOpen, setShapeFlyoutOpen] = useState(false);
  const [fillColor, setFillColor] = useState<string | null>(null);
  const [fillGradient, setFillGradient] = useState<GradientFill>({ enabled: false, color1: '#ff6b6b', color2: '#4ecdc4', angle: 0, type: 'linear' });
  const [brushKind, setBrushKind] = useState<BrushKind>('pencil');
  const [brushFlyoutOpen, setBrushFlyoutOpen] = useState(false);
  const [color, setColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(4);
  const [opacity, setOpacity] = useState(1);
  const prevToolRef = useRef<Tool>('pencil'); // for auto-switching back from eyedropper
  const [fontSize, setFontSize] = useState(24);
  const [fontFamily, setFontFamily] = useState('Poppins, sans-serif');
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [snapRotation, setSnapRotation] = useState(true);

  // Document dimensions (dynamic - changes on crop)
  const [docW, setDocW] = useState(DEFAULT_W);
  const [docH, setDocH] = useState(DEFAULT_H);
  const docWRef = useRef(DEFAULT_W); docWRef.current = docW;
  const docHRef = useRef(DEFAULT_H); docHRef.current = docH;

  // Zoom
  const [zoom, setZoom] = useState(0.5);
  const zoomRef = useRef(0.5); zoomRef.current = zoom;

  // Paste dialog
  const [pasteDialog, setPasteDialog] = useState<string | null>(null);

  // Layer thumbnail hover popup
  const [thumbPopup, setThumbPopup] = useState<{ layerId: string; x: number; y: number } | null>(null);

  // Smart Select / SAM
  const [samStatus, setSamStatus] = useState<SamStatus>('unloaded');
  const [smartSelectDownloadPopup, setSmartSelectDownloadPopup] = useState(false);
  const [samActionPopup, setSamActionPopup] = useState<{ screenX: number; screenY: number } | null>(null);
  const [useGrabCut, setUseGrabCut] = useState(() => localStorage.getItem('paint_grabcut') === '1');
  const [modifyingMask, setModifyingMask] = useState(false);

  // Layer effects expand state (only one layer's FX panel at a time)
  const [expandedFxLayer, setExpandedFxLayer] = useState<string | null>(null);

  // Settings popup
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fullPage, setFullPage] = useState(() => localStorage.getItem('paint_fullpage') === '1');

  // ── Refs (always-fresh values for event callbacks) ─────────────────────────
  const layersRef = useRef(layers);           layersRef.current = layers;
  const objectsRef = useRef(objects);         objectsRef.current = objects;
  const selectedIdRef = useRef(selectedId);   selectedIdRef.current = selectedId;
  const toolRef = useRef(tool);               toolRef.current = tool;
  const colorRef = useRef(color);             colorRef.current = color;
  const brushSizeRef = useRef(brushSize);     brushSizeRef.current = brushSize;
  const opacityRef = useRef(opacity);         opacityRef.current = opacity;
  const shapeTypeRef = useRef(shapeType);     shapeTypeRef.current = shapeType;
  const fillColorRef = useRef(fillColor);     fillColorRef.current = fillColor;
  const fillGradientRef = useRef(fillGradient); fillGradientRef.current = fillGradient;
  const brushKindRef = useRef(brushKind);     brushKindRef.current = brushKind;
  const lastAirbrushStampRef = useRef(0);
  const editingTextIdRef = useRef(editingTextId); editingTextIdRef.current = editingTextId;
  const textCursorPosRef = useRef(0); // character index within the text being edited
  const fontSizeRef = useRef(fontSize);       fontSizeRef.current = fontSize;
  const fontFamilyRef = useRef(fontFamily);   fontFamilyRef.current = fontFamily;
  const activeLayerRef = useRef(activeLayerId); activeLayerRef.current = activeLayerId;

  // ── Canvas refs ────────────────────────────────────────────────────────────
  const displayRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  /** Per-layer raster pixel canvas (pencil / eraser / fill) */
  const pixelCanvases = useRef<Map<string, HTMLCanvasElement>>(new Map());
  /** Per-layer temp canvas for compositing pixels + objects */
  const tempCanvases = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const imageCache = useRef<Map<string, HTMLImageElement>>(new Map());
  /** Per-layer thumbnail canvas elements (in layers panel) */
  const thumbnailRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const popupCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SAM refs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const samModelRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const samProcessorRef = useRef<any>(null);
  const samStatusRef = useRef<SamStatus>('unloaded');
  const samMaskRef = useRef<{ data: boolean[]; dw: number; dh: number } | null>(null);
  const samClickLayerRef = useRef<string | null>(null);
  /** Stroke points accumulated while user highlights in smart-select mode */
  const samStrokeRef = useRef<{ x: number; y: number }[]>([]);
  const useGrabCutRef = useRef(false); useGrabCutRef.current = useGrabCut;
  const modifyingMaskRef = useRef(false); modifyingMaskRef.current = modifyingMask;
  const maskModifyEraseRef = useRef(false); // true = erasing from mask, false = adding

  // ── Interaction state (refs to avoid stale closures in handlers) ───────────
  const drawing = useRef(false);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const strokePoints = useRef<{ x: number; y: number }[]>([]);
  const pixelSnapshot = useRef<ImageData | null>(null);

  // For select tool drag
  const dragMode = useRef<'move' | 'resize' | 'rotate' | null>(null);
  const dragHandle = useRef<HandlePos | null>(null);
  const dragOrigObj = useRef<PaintObj | null>(null);
  const dragStartAngle = useRef(0);
  const dragStartRotation = useRef(0);
  const snapToRef = useRef(snapRotation); snapToRef.current = snapRotation;

  // For text cursor preview
  const cursorPos = useRef<{ x: number; y: number } | null>(null);
  // For crop tool
  const cropRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  cropRectRef.current = cropRect;

  // ── History ────────────────────────────────────────────────────────────────
  const history = useRef<{ pixels: { id: string; data: ImageData }[]; objects: PaintObj[]; docW: number; docH: number }[]>([]);
  const histIdx = useRef(-1);

  // ── Rendering ──────────────────────────────────────────────────────────────

  function getTempCanvas(layerId: string): HTMLCanvasElement {
    const dw = docWRef.current, dh = docHRef.current;
    let c = tempCanvases.current.get(layerId);
    if (!c) {
      c = document.createElement('canvas');
      c.width = dw; c.height = dh;
      tempCanvases.current.set(layerId, c);
    }
    if (c.width !== dw || c.height !== dh) {
      c.width = dw; c.height = dh;
    }
    return c;
  }

  const renderAll = useCallback((
    currentLayers: Layer[],
    currentObjects: PaintObj[],
    currentSelectedId: string | null,
    previewShape?: { type: ObjType; x: number; y: number; w: number; h: number } | null,
  ) => {
    if (!displayRef.current || !overlayRef.current) return;
    const dw = docWRef.current, dh = docHRef.current;
    const display = displayRef.current.getContext('2d')!;
    const overlay = overlayRef.current.getContext('2d')!;

    // Composite layers onto display
    display.clearRect(0, 0, dw, dh);
    display.fillStyle = '#fff';
    display.fillRect(0, 0, dw, dh);

    for (const layer of currentLayers) {
      if (!layer.visible) continue;
      const pc = pixelCanvases.current.get(layer.id);
      if (!pc) continue;

      const tc = getTempCanvas(layer.id);
      const tcCtx = tc.getContext('2d')!;
      tcCtx.clearRect(0, 0, dw, dh);
      tcCtx.drawImage(pc, 0, 0);
      currentObjects
        .filter((o) => o.layerId === layer.id)
        .forEach((o) => drawObj(tcCtx, o, imageCache.current));

      display.globalAlpha = layer.opacity;
      display.globalCompositeOperation = layer.blendMode;

      // Layer effects — shadow/glow applied by drawing the composite with canvas shadow props
      const lfx = layer.effects;
      if (lfx?.glow?.enabled) {
        display.save();
        display.shadowColor = lfx.glow.color;
        display.shadowBlur = lfx.glow.blur;
        display.shadowOffsetX = 0;
        display.shadowOffsetY = 0;
        display.drawImage(tc, 0, 0);
        display.drawImage(tc, 0, 0);
        display.restore();
      }
      if (lfx?.shadow?.enabled) {
        display.save();
        display.shadowColor = lfx.shadow.color;
        display.shadowBlur = lfx.shadow.blur;
        display.shadowOffsetX = lfx.shadow.offsetX;
        display.shadowOffsetY = lfx.shadow.offsetY;
        display.drawImage(tc, 0, 0);
        display.restore();
      }

      display.drawImage(tc, 0, 0);
      display.globalAlpha = 1;
      display.globalCompositeOperation = 'source-over';
    }

    // Overlay: selection handles + shape/text preview
    overlay.clearRect(0, 0, dw, dh);

    // Draw selected object highlight (rotated with the object)
    if (currentSelectedId) {
      const sel = currentObjects.find((o) => o.id === currentSelectedId);
      if (sel) {
        const { x, y, w, h } = getDisplayBounds(sel);
        const cx = x + w / 2, cy = y + h / 2;
        const rad = toRad(sel.rotation ?? 0);

        overlay.save();
        // Rotate the entire selection UI around the object's center
        overlay.translate(cx, cy);
        overlay.rotate(rad);
        overlay.translate(-cx, -cy);

        // Dashed selection rect
        overlay.strokeStyle = '#0088ff';
        overlay.lineWidth = 1.5;
        overlay.setLineDash([5, 3]);
        overlay.strokeRect(x - 2, y - 2, w + 4, h + 4);
        overlay.setLineDash([]);

        // Resize handles
        overlay.fillStyle = '#fff';
        overlay.strokeStyle = '#0088ff';
        overlay.lineWidth = 1.5;
        for (const handle of getHandles(sel)) {
          overlay.fillRect(handle.x - HANDLE_SZ / 2, handle.y - HANDLE_SZ / 2, HANDLE_SZ, HANDLE_SZ);
          overlay.strokeRect(handle.x - HANDLE_SZ / 2, handle.y - HANDLE_SZ / 2, HANDLE_SZ, HANDLE_SZ);
        }

        // Rotation handle -- stem line then circle, 30px above top-center in local space
        const rhX = x + w / 2, rhY = y - 2;
        overlay.beginPath();
        overlay.moveTo(rhX, rhY);
        overlay.lineTo(rhX, rhY - 28);
        overlay.setLineDash([3, 2]);
        overlay.strokeStyle = '#0088ff';
        overlay.lineWidth = 1;
        overlay.stroke();
        overlay.setLineDash([]);
        overlay.beginPath();
        overlay.arc(rhX, rhY - 28, 6, 0, Math.PI * 2);
        overlay.fillStyle = '#fff';
        overlay.fill();
        overlay.strokeStyle = '#0088ff';
        overlay.lineWidth = 1.5;
        overlay.stroke();

        overlay.restore();
      }
    }

    // Draw shape creation preview
    if (previewShape && isShapeKind(previewShape.type)) {
      overlay.save();
      overlay.strokeStyle = colorRef.current;
      overlay.lineWidth = brushSizeRef.current;
      overlay.globalAlpha = opacityRef.current;
      overlay.lineCap = 'round';
      overlay.setLineDash([4, 4]);
      const { type, x, y, w, h } = previewShape;
      if (fillColorRef.current && !isLineLike(type)) {
        overlay.beginPath();
        buildShapePath(overlay, type as ShapeKind, x, y, w, h);
        overlay.fillStyle = fillColorRef.current;
        overlay.globalAlpha = opacityRef.current * 0.5;
        overlay.fill();
        overlay.globalAlpha = opacityRef.current;
      }
      overlay.beginPath();
      buildShapePath(overlay, type as ShapeKind, x, y, w, h);
      overlay.stroke();
      if (type === 'arrow') {
        // Also show the filled head preview
        overlay.beginPath();
        drawArrowHeadPath(overlay, x, y, w, h);
        overlay.stroke();
      }
      overlay.restore();
    }

    // Text tool hover preview — show cursor line where text will be placed
    if (toolRef.current === 'text' && cursorPos.current && !editingTextIdRef.current) {
      const { x, y } = cursorPos.current;
      const fSize = fontSizeRef.current;
      overlay.save();
      overlay.strokeStyle = colorRef.current;
      overlay.lineWidth = 1.5;
      overlay.globalAlpha = 0.7;
      overlay.beginPath();
      overlay.moveTo(x, y);
      overlay.lineTo(x, y + fSize * 1.2);
      overlay.stroke();
      overlay.restore();
    }

    // Blinking cursor for inline text editing
    if (editingTextIdRef.current) {
      const editObj = currentObjects.find((o) => o.id === editingTextIdRef.current);
      if (editObj && editObj.type === 'text') {
        const blink = Math.floor(Date.now() / 500) % 2 === 0;
        if (blink) {
          const fSize = editObj.fontSize ?? 24;
          const ff = editObj.fontFamily ?? 'Poppins, sans-serif';
          const txt = editObj.text ?? '';
          const cp = Math.min(textCursorPosRef.current, txt.length);
          const cur = getTextCursorXY(txt, cp, fSize, ff);
          const lineH = Math.ceil(fSize * 1.2);
          overlay.save();
          overlay.strokeStyle = editObj.color ?? '#000';
          overlay.lineWidth = 1.5;
          overlay.beginPath();
          overlay.moveTo(editObj.x + cur.x, editObj.y + cur.y);
          overlay.lineTo(editObj.x + cur.x, editObj.y + cur.y + lineH);
          overlay.stroke();
          overlay.restore();
        }
      }
    }

    // Crop rect overlay
    if (cropRectRef.current) {
      const { x, y, w, h } = cropRectRef.current;
      overlay.save();
      overlay.fillStyle = 'rgba(0,0,0,0.45)';
      overlay.fillRect(0, 0, dw, y);
      overlay.fillRect(0, y + h, dw, dh - y - h);
      overlay.fillRect(0, y, x, h);
      overlay.fillRect(x + w, y, dw - x - w, h);
      overlay.strokeStyle = '#fff';
      overlay.lineWidth = 1.5;
      overlay.setLineDash([5, 4]);
      overlay.strokeRect(x, y, w, h);
      overlay.setLineDash([]);
      overlay.restore();
    }

    // SAM mask overlay
    if (samMaskRef.current) {
      const { data, dw: mdw, dh: mdh } = samMaskRef.current;
      const imgData = overlay.createImageData(mdw, mdh);
      for (let i = 0; i < data.length; i++) {
        if (data[i]) {
          imgData.data[i * 4]     = 0;
          imgData.data[i * 4 + 1] = 120;
          imgData.data[i * 4 + 2] = 255;
          imgData.data[i * 4 + 3] = 110;
        }
      }
      overlay.putImageData(imgData, 0, 0);
    }

    // Mask modify cursor circle preview
    if (modifyingMaskRef.current && cursorPos.current) {
      const { x, y } = cursorPos.current;
      const r = brushSizeRef.current / 2;
      overlay.save();
      overlay.strokeStyle = maskModifyEraseRef.current ? '#ff4444' : '#44aaff';
      overlay.lineWidth = 2;
      overlay.setLineDash([4, 3]);
      overlay.beginPath();
      overlay.arc(x, y, r, 0, Math.PI * 2);
      overlay.stroke();
      overlay.setLineDash([]);
      overlay.restore();
    }

    // SAM stroke highlight preview
    if (samStrokeRef.current.length > 1) {
      const pts = samStrokeRef.current;
      overlay.save();
      overlay.globalAlpha = 0.45;
      overlay.strokeStyle = '#facc15';
      overlay.lineWidth = 18;
      overlay.lineCap = 'round';
      overlay.lineJoin = 'round';
      overlay.beginPath();
      overlay.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) overlay.lineTo(pts[i].x, pts[i].y);
      overlay.stroke();
      overlay.restore();
    }

    updateThumbnails();
  }, []);

  // ── Layer thumbnails ───────────────────────────────────────────────────────

  function updateThumbnails() {
    const dw = docWRef.current, dh = docHRef.current;
    if (!dw || !dh) return;
    const SZ = 64; // square canvas resolution
    for (const layer of layersRef.current) {
      const tc = thumbnailRefs.current.get(layer.id);
      if (!tc) continue;
      if (tc.width !== SZ || tc.height !== SZ) { tc.width = SZ; tc.height = SZ; }
      renderLayerIntoCanvas(tc, layer.id, dw, dh, SZ, SZ);
    }
  }

  function renderLayerIntoCanvas(
    tc: HTMLCanvasElement,
    layerId: string,
    dw: number, dh: number,
    outW: number, outH: number,
  ) {
    const ctx = tc.getContext('2d')!;
    // Checkerboard background
    const cell = Math.max(4, Math.round(outW / 12));
    for (let ty = 0; ty < outH; ty += cell) {
      for (let tx = 0; tx < outW; tx += cell) {
        ctx.fillStyle = (Math.floor(tx / cell) + Math.floor(ty / cell)) % 2 === 0 ? '#bbb' : '#fff';
        ctx.fillRect(tx, ty, cell, cell);
      }
    }
    // Contain-fit: scale doc to fill outW x outH while preserving aspect ratio
    const scale = Math.min(outW / dw, outH / dh);
    const tw = Math.round(dw * scale);
    const th = Math.round(dh * scale);
    const ox = Math.round((outW - tw) / 2);
    const oy = Math.round((outH - th) / 2);
    const pc = pixelCanvases.current.get(layerId);
    if (pc) ctx.drawImage(pc, ox, oy, tw, th);
    const sx = tw / dw, sy = th / dh;
    ctx.save();
    ctx.translate(ox, oy);
    objectsRef.current
      .filter((o) => o.layerId === layerId)
      .forEach((o) => {
        ctx.save();
        ctx.scale(sx, sy);
        drawObj(ctx, o, imageCache.current);
        ctx.restore();
      });
    ctx.restore();
  }

  function renderPopupPreview(layerId: string) {
    const dw = docWRef.current, dh = docHRef.current;
    if (!dw || !dh || !popupCanvasRef.current) return;
    const POP_W = 240, POP_H = 160;
    const pc_canvas = popupCanvasRef.current;
    pc_canvas.width = POP_W;
    pc_canvas.height = POP_H;
    renderLayerIntoCanvas(pc_canvas, layerId, dw, dh, POP_W, POP_H);
  }

  // ── Smart Select / SAM ─────────────────────────────────────────────────────

  async function loadSamModel() {
    setSamStatus('downloading');
    samStatusRef.current = 'downloading';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tf = await import('@huggingface/transformers') as any;
      samProcessorRef.current = await tf.SamProcessor.from_pretrained('Xenova/sam-vit-base');
      samModelRef.current = await tf.SamModel.from_pretrained('Xenova/sam-vit-base', { dtype: 'q8' });
      localStorage.setItem('paint_sam_ready', '1');
      setSamStatus('ready');
      samStatusRef.current = 'ready';
    } catch (err) {
      console.error('SAM load failed:', err);
      setSamStatus('unloaded');
      samStatusRef.current = 'unloaded';
    }
  }

async function runSmartSelect(
    points: { x: number; y: number }[],
    screenX: number,
    screenY: number,
    layerId: string,
    strokeBbox: [number, number, number, number],
  ) {
    const model = samModelRef.current;
    const processor = samProcessorRef.current;
    if (!model || !processor) return;
    setSamStatus('inferring');
    samStatusRef.current = 'inferring';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { RawImage } = await import('@huggingface/transformers') as any;
      const dw = docWRef.current, dh = docHRef.current;

      // Composite the layer content into a temp canvas for SAM input
      const tc = getTempCanvas('__sam_input__');
      tc.width = dw; tc.height = dh;
      const tcCtx = tc.getContext('2d')!;
      tcCtx.clearRect(0, 0, dw, dh);
      tcCtx.fillStyle = '#fff';
      tcCtx.fillRect(0, 0, dw, dh);
      const pc = pixelCanvases.current.get(layerId);
      if (pc) tcCtx.drawImage(pc, 0, 0);
      objectsRef.current
        .filter((o) => o.layerId === layerId)
        .forEach((o) => drawObj(tcCtx, o, imageCache.current));

      const image = await RawImage.fromCanvas(tc);
      console.log('[SAM] image size:', image.width, 'x', image.height, '| doc:', dw, 'x', dh);
      console.log('[SAM] positive points:', points.map(p => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`));
      console.log('[SAM] strokeBbox:', strokeBbox);


      // Negative points: canvas corners, but skip any that are inside or near
      // the stroke bbox (the user may be selecting an object at the canvas edge)
      const PAD = 80; // min distance from stroke bbox to use a corner as negative
      const [sbx1_, sby1_, sbx2_, sby2_] = strokeBbox;
      const allCorners: [number, number][] = [[0, 0], [dw, 0], [0, dh], [dw, dh]];
      const negatives = allCorners.filter(([cx, cy]) =>
        cx < sbx1_ - PAD || cx > sbx2_ + PAD || cy < sby1_ - PAD || cy > sby2_ + PAD
      );
      console.log(`[SAM] using ${negatives.length}/4 corner negatives (skipped corners near stroke)`);
      const allPts = [...points.map((p): [number, number] => [p.x, p.y]), ...negatives];
      const allLabels = [...points.map(() => 1), ...negatives.map(() => 0)];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // Note: input_boxes is NOT passed — Transformers.js SAM silently drops it
      // ("Too many inputs, 5 > 4"). We apply bbox clipping in post-processing instead.
      const prompt: any = { input_points: [allPts], input_labels: [allLabels] };
      console.log('[SAM] prompt:', JSON.stringify(prompt));
      const inputs = await processor(image, prompt);
      console.log('[SAM] inputs keys:', Object.keys(inputs));
      console.log('[SAM] original_sizes:', inputs.original_sizes?.tolist?.() ?? inputs.original_sizes);
      console.log('[SAM] reshaped_input_sizes:', inputs.reshaped_input_sizes?.tolist?.() ?? inputs.reshaped_input_sizes);
      const outputs = await model(inputs);
      console.log('[SAM] outputs keys:', Object.keys(outputs));
      console.log('[SAM] pred_masks shape:', outputs.pred_masks?.dims ?? outputs.pred_masks?.shape ?? 'unknown');
      console.log('[SAM] iou_scores shape:', outputs.iou_scores?.dims ?? outputs.iou_scores?.shape ?? 'unknown');
      console.log('[SAM] iou_scores data:', Array.from(outputs.iou_scores.data as Float32Array));

      const masks = await processor.post_process_masks(
        outputs.pred_masks,
        inputs.original_sizes,
        inputs.reshaped_input_sizes,
      );
      // masks[0] is a tensor of shape [1, 3, H, W] — need masks[0][0] to get [3, H, W]
      const maskBatch = masks[0];
      console.log('[SAM] masks structure: masks.length=', masks.length,
        '| masks[0] dims:', maskBatch?.dims ?? 'unknown');
      const maskSet = maskBatch[0]; // shape [3, H, W]
      console.log('[SAM] maskSet (masks[0][0]) dims:', maskSet?.dims ?? 'unknown');

      // Inspect each mask
      const iouScores = outputs.iou_scores.data as Float32Array;
      const [sbx1, sby1, sbx2, sby2] = strokeBbox;
      const numMasks = 3;

      for (let m = 0; m < numMasks; m++) {
        let mData: Uint8Array | Float32Array | null = null;
        let mLen = 0;
        try {
          const mTensor = maskSet[m]; // shape [H, W]
          mData = mTensor.data as Uint8Array | Float32Array;
          mLen = mData.length;
          console.log(`[SAM] mask[${m}] dims:`, mTensor.dims ?? mTensor.shape ?? 'unknown', '| data.length:', mLen, `| expected: ${dw * dh}`);
        } catch (e) {
          console.error(`[SAM] mask[${m}] access error:`, e);
        }
        if (mData) {
          let trueCount = 0, inside = 0;
          let minVal = Infinity, maxVal = -Infinity;
          for (let i = 0; i < mData.length; i++) {
            const v = mData[i];
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
            if (v > 0.5) {
              trueCount++;
              const px = i % dw, py = Math.floor(i / dw);
              if (px >= sbx1 && px <= sbx2 && py >= sby1 && py <= sby2) inside++;
            }
          }
          const containment = trueCount > 0 ? inside / trueCount : 0;
          const score = iouScores[m] * containment;
          console.log(`[SAM] mask[${m}]: truePixels=${trueCount}/${mLen} (${(trueCount/mLen*100).toFixed(1)}%), inside bbox=${inside}, containment=${containment.toFixed(4)}, iou=${iouScores[m]?.toFixed(4)}, score=${score.toFixed(6)}, valueRange=[${minVal}, ${maxVal}]`);
        }
      }

      // Pick best mask using two-tier scoring:
      // Tier 1: Masks with >95% containment are "precise" — prefer them, break
      //         ties by coverage*iou (how much of the stroke bbox they fill).
      // Tier 2: Masks with lower containment use containment*coverage*iou.
      // This avoids both problems: masks that spill outside the stroke (mountains)
      // AND tiny masks that are trivially 100% contained (single window).
      const bboxArea = Math.max(1, (sbx2 - sbx1) * (sby2 - sby1));
      let bestIdx = 0;
      let bestScore = -1;
      for (let m = 0; m < numMasks; m++) {
        const mTensor = maskSet[m];
        const mData = mTensor.data as Uint8Array | Float32Array;
        let inside = 0, total = 0;
        for (let i = 0; i < mData.length; i++) {
          if (mData[i] > 0.5) {
            total++;
            const px = i % dw, py = Math.floor(i / dw);
            if (px >= sbx1 && px <= sbx2 && py >= sby1 && py <= sby2) inside++;
          }
        }
        const containment = total > 0 ? inside / total : 0;
        const coverage = inside / bboxArea; // how much of stroke bbox is filled
        const iou = iouScores[m];
        if (iou < 0.5) continue;
        // Tier 1 masks (tightly contained) get a large bonus so they always win
        const score = containment >= 0.95
          ? 1000 + coverage * iou
          : containment * coverage * iou;
        console.log(`[SAM] mask[${m}] scoring: containment=${containment.toFixed(4)}, coverage=${coverage.toFixed(4)}, iou=${iou.toFixed(4)}, tier=${containment >= 0.95 ? 1 : 2}, score=${score.toFixed(6)}`);
        if (score > bestScore) { bestScore = score; bestIdx = m; }
      }
      console.log(`[SAM] SELECTED mask[${bestIdx}] with score=${bestScore.toFixed(6)}`);

      const maskTensor = maskSet[bestIdx];
      const maskData = maskTensor.data as Uint8Array | Float32Array;
      const maskBool: boolean[] = new Array(dw * dh).fill(false);
      // Clip mask to stroke bounding box — this is our spatial constraint
      // since Transformers.js SAM ignores input_boxes.
      const clipX1 = Math.max(0, Math.floor(sbx1));
      const clipY1 = Math.max(0, Math.floor(sby1));
      const clipX2 = Math.min(dw - 1, Math.ceil(sbx2));
      const clipY2 = Math.min(dh - 1, Math.ceil(sby2));
      let clippedCount = 0;
      for (let i = 0; i < maskData.length; i++) {
        if (maskData[i] > 0.5) {
          const px = i % dw, py = Math.floor(i / dw);
          if (px >= clipX1 && px <= clipX2 && py >= clipY1 && py <= clipY2) {
            maskBool[i] = true;
          } else {
            clippedCount++;
          }
        }
      }
      console.log(`[SAM] bbox clip removed ${clippedCount} pixels outside stroke region`);

      // Morphological close (dilate then erode) to close small boundary gaps.
      // SAM's 256x256 internal mask upscaled to full res leaves thin gaps along
      // edges — this seals them so hole-fill can then solidify the interior.
      // Uses separable box filters: O(w*h) per pass, 4 passes total.
      const CLOSE_R = 6;
      {
        const N = dw * dh;
        const m = new Uint8Array(N);
        for (let i = 0; i < N; i++) m[i] = maskBool[i] ? 1 : 0;

        // --- Dilate (any pixel in window is true → true) ---
        const dh1 = new Uint8Array(N); // horizontal pass
        for (let y = 0; y < dh; y++) {
          const row = y * dw;
          let cnt = 0;
          for (let x = 0; x <= Math.min(CLOSE_R, dw - 1); x++) cnt += m[row + x];
          dh1[row] = cnt > 0 ? 1 : 0;
          for (let x = 1; x < dw; x++) {
            if (x + CLOSE_R < dw) cnt += m[row + x + CLOSE_R];
            if (x - CLOSE_R - 1 >= 0) cnt -= m[row + x - CLOSE_R - 1];
            dh1[row + x] = cnt > 0 ? 1 : 0;
          }
        }
        const dilated = new Uint8Array(N); // vertical pass
        for (let x = 0; x < dw; x++) {
          let cnt = 0;
          for (let y = 0; y <= Math.min(CLOSE_R, dh - 1); y++) cnt += dh1[y * dw + x];
          dilated[x] = cnt > 0 ? 1 : 0;
          for (let y = 1; y < dh; y++) {
            if (y + CLOSE_R < dh) cnt += dh1[(y + CLOSE_R) * dw + x];
            if (y - CLOSE_R - 1 >= 0) cnt -= dh1[(y - CLOSE_R - 1) * dw + x];
            dilated[y * dw + x] = cnt > 0 ? 1 : 0;
          }
        }

        // --- Erode (all pixels in window must be true → true) ---
        const eh1 = new Uint8Array(N); // horizontal pass
        for (let y = 0; y < dh; y++) {
          const row = y * dw;
          let cnt = 0;
          const initEnd = Math.min(CLOSE_R, dw - 1);
          for (let x = 0; x <= initEnd; x++) cnt += dilated[row + x];
          eh1[row] = cnt === initEnd + 1 ? 1 : 0;
          for (let x = 1; x < dw; x++) {
            if (x + CLOSE_R < dw) cnt += dilated[row + x + CLOSE_R];
            if (x - CLOSE_R - 1 >= 0) cnt -= dilated[row + x - CLOSE_R - 1];
            const ws = Math.min(x + CLOSE_R, dw - 1) - Math.max(x - CLOSE_R, 0) + 1;
            eh1[row + x] = cnt === ws ? 1 : 0;
          }
        }
        // vertical pass → write back to maskBool
        for (let x = 0; x < dw; x++) {
          let cnt = 0;
          const initEnd = Math.min(CLOSE_R, dh - 1);
          for (let y = 0; y <= initEnd; y++) cnt += eh1[y * dw + x];
          maskBool[x] = cnt === initEnd + 1;
          for (let y = 1; y < dh; y++) {
            if (y + CLOSE_R < dh) cnt += eh1[(y + CLOSE_R) * dw + x];
            if (y - CLOSE_R - 1 >= 0) cnt -= eh1[(y - CLOSE_R - 1) * dw + x];
            const ws = Math.min(y + CLOSE_R, dh - 1) - Math.max(y - CLOSE_R, 0) + 1;
            maskBool[y * dw + x] = cnt === ws;
          }
        }

        const afterClose = maskBool.filter(Boolean).length;
        console.log(`[SAM] morph close (r=${CLOSE_R}): ${afterClose} true pixels`);
      }

      // Fill interior holes — flood-fill "outside" from all border pixels,
      // then any unfilled non-mask pixel is an enclosed hole → fill it.
      const outside = new Uint8Array(dw * dh);
      const holeStack: number[] = [];
      for (let x = 0; x < dw; x++) {
        if (!maskBool[x]) { outside[x] = 1; holeStack.push(x); }
        const bi = (dh - 1) * dw + x;
        if (!maskBool[bi]) { outside[bi] = 1; holeStack.push(bi); }
      }
      for (let y = 1; y < dh - 1; y++) {
        const li = y * dw;
        if (!maskBool[li]) { outside[li] = 1; holeStack.push(li); }
        const ri = y * dw + dw - 1;
        if (!maskBool[ri]) { outside[ri] = 1; holeStack.push(ri); }
      }
      while (holeStack.length > 0) {
        const idx = holeStack.pop()!;
        const px = idx % dw, py = (idx - px) / dw;
        for (const [nx, ny] of [[px+1,py],[px-1,py],[px,py+1],[px,py-1]]) {
          if (nx < 0 || nx >= dw || ny < 0 || ny >= dh) continue;
          const ni = ny * dw + nx;
          if (!outside[ni] && !maskBool[ni]) { outside[ni] = 1; holeStack.push(ni); }
        }
      }
      let holesFilled = 0;
      for (let i = 0; i < dw * dh; i++) {
        if (!maskBool[i] && !outside[i]) { maskBool[i] = true; holesFilled++; }
      }
      const finalTrueCount = maskBool.filter(Boolean).length;
      console.log(`[SAM] final mask: ${finalTrueCount} true pixels, holes filled: ${holesFilled}`);

      samMaskRef.current = { data: maskBool, dw, dh };
      samClickLayerRef.current = layerId;
      setSamActionPopup({ screenX, screenY });
      setSamStatus('ready');
      samStatusRef.current = 'ready';
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
    } catch (err) {
      console.error('SAM inference failed:', err);
      setSamStatus('ready');
      samStatusRef.current = 'ready';
    }
  }

  /** Bake all objects on a layer into its pixel canvas and remove them from the objects array */
  function flattenLayerObjects(layerId: string) {
    const pc = pixelCanvases.current.get(layerId);
    if (!pc) return;
    const layerObjs = objectsRef.current.filter((o) => o.layerId === layerId);
    if (layerObjs.length === 0) return;
    const pcCtx = pc.getContext('2d')!;
    for (const o of layerObjs) {
      drawObj(pcCtx, o, imageCache.current);
    }
    // Remove flattened objects
    const remaining = objectsRef.current.filter((o) => o.layerId !== layerId);
    objectsRef.current = remaining;
    setObjects(remaining);
    console.log(`[flattenLayerObjects] baked ${layerObjs.length} objects into pixel canvas for layer ${layerId}`);
  }

  /** Extract masked pixels into a cropped dataURL; optionally erase from source pixel canvas */
  function extractMaskedPixels(mask: { data: boolean[]; dw: number; dh: number }, layerId: string, eraseSource: boolean) {
    const { dw, dh } = mask;
    const pc = pixelCanvases.current.get(layerId);
    if (!pc) return null;

    const tc = getTempCanvas('__sam_extract__');
    tc.width = dw; tc.height = dh;
    const tcCtx = tc.getContext('2d')!;
    tcCtx.clearRect(0, 0, dw, dh);
    tcCtx.drawImage(pc, 0, 0);
    objectsRef.current
      .filter((o) => o.layerId === layerId)
      .forEach((o) => drawObj(tcCtx, o, imageCache.current));

    const fullImg = tcCtx.getImageData(0, 0, dw, dh);
    const maskedImg = new ImageData(dw, dh);
    let minX = dw, minY = dh, maxX = 0, maxY = 0;
    for (let row = 0; row < dh; row++) {
      for (let col = 0; col < dw; col++) {
        const i = row * dw + col;
        if (mask.data[i]) {
          maskedImg.data[i * 4]     = fullImg.data[i * 4];
          maskedImg.data[i * 4 + 1] = fullImg.data[i * 4 + 1];
          maskedImg.data[i * 4 + 2] = fullImg.data[i * 4 + 2];
          maskedImg.data[i * 4 + 3] = fullImg.data[i * 4 + 3];
          if (col < minX) minX = col;
          if (col > maxX) maxX = col;
          if (row < minY) minY = row;
          if (row > maxY) maxY = row;
        }
      }
    }
    if (minX > maxX || minY > maxY) return null;

    const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropW; cropCanvas.height = cropH;
    cropCanvas.getContext('2d')!.putImageData(maskedImg, -minX, -minY);
    const dataUrl = cropCanvas.toDataURL('image/png');

    if (eraseSource) {
      const pcCtx = pc.getContext('2d')!;
      const srcImg = pcCtx.getImageData(0, 0, dw, dh);
      let erasedCount = 0;
      for (let i = 0; i < mask.data.length; i++) {
        if (mask.data[i]) {
          if (srcImg.data[i * 4 + 3] > 0) erasedCount++;
          srcImg.data[i * 4] = 0;
          srcImg.data[i * 4 + 1] = 0;
          srcImg.data[i * 4 + 2] = 0;
          srcImg.data[i * 4 + 3] = 0;
        }
      }
      pcCtx.putImageData(srcImg, 0, 0);
      console.log(`[extractMaskedPixels] eraseSource: cleared ${erasedCount} pixels from layer pc ${pc.width}x${pc.height}`);
    }
    console.log(`[extractMaskedPixels] extracted ${cropW}x${cropH} at (${minX},${minY}), dataUrl length=${dataUrl.length}`);
    return { dataUrl, x: minX, y: minY, w: cropW, h: cropH };
  }

  function clearSamSelection() {
    samMaskRef.current = null;
    samClickLayerRef.current = null;
    setSamActionPopup(null);
    setModifyingMask(false);
    renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
  }

  /** Paint (add=true) or erase (add=false) a circle of radius r at (cx,cy) on the mask */
  function paintMask(cx: number, cy: number, r: number, add: boolean) {
    const mask = samMaskRef.current;
    if (!mask) return;
    const { data, dw, dh } = mask;
    const x1 = Math.max(0, Math.floor(cx - r));
    const y1 = Math.max(0, Math.floor(cy - r));
    const x2 = Math.min(dw - 1, Math.ceil(cx + r));
    const y2 = Math.min(dh - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) {
          data[y * dw + x] = add;
        }
      }
    }
  }

  function startModifyMask() {
    setSamActionPopup(null);
    setModifyingMask(true);
  }

  function finishModifyMask() {
    setModifyingMask(false);
    // Re-show action popup at center of screen
    setSamActionPopup({ screenX: window.innerWidth / 2 - 80, screenY: window.innerHeight / 2 - 60 });
  }

  function runGrabCutSegment(
    stroke: { x: number; y: number }[],
    layerId: string,
  ): { data: boolean[]; dw: number; dh: number } | null {
    const dw = docWRef.current, dh = docHRef.current;
    if (!dw || !dh || stroke.length === 0) return null;

    // Composite layer into a temp canvas
    const tc = getTempCanvas('__grabcut__');
    tc.width = dw; tc.height = dh;
    const tcCtx = tc.getContext('2d')!;
    tcCtx.clearRect(0, 0, dw, dh);
    tcCtx.fillStyle = '#fff';
    tcCtx.fillRect(0, 0, dw, dh);
    const pc = pixelCanvases.current.get(layerId);
    if (pc) tcCtx.drawImage(pc, 0, 0);
    objectsRef.current.filter((o) => o.layerId === layerId).forEach((o) => drawObj(tcCtx, o, imageCache.current));
    const pixels = tcCtx.getImageData(0, 0, dw, dh).data;

    // Centroid (positive seed) and stroke bounding box
    const cx = Math.round(stroke.reduce((s, p) => s + p.x, 0) / stroke.length);
    const cy = Math.round(stroke.reduce((s, p) => s + p.y, 0) / stroke.length);
    const xs = stroke.map((p) => p.x), ys = stroke.map((p) => p.y);
    const bx1 = Math.max(0, Math.floor(Math.min(...xs)));
    const by1 = Math.max(0, Math.floor(Math.min(...ys)));
    const bx2 = Math.min(dw - 1, Math.ceil(Math.max(...xs)));
    const by2 = Math.min(dh - 1, Math.ceil(Math.max(...ys)));
    console.log(`[GrabCut] doc: ${dw}x${dh}, stroke points: ${stroke.length}`);
    console.log(`[GrabCut] centroid: (${cx}, ${cy}), bbox: [${bx1}, ${by1}, ${bx2}, ${by2}]`);
    console.log(`[GrabCut] bbox size: ${bx2 - bx1}x${by2 - by1} = ${(bx2-bx1)*(by2-by1)} pixels`);
    // Log centroid pixel color
    const cIdx = (cy * dw + cx) * 4;
    console.log(`[GrabCut] centroid pixel color: rgb(${pixels[cIdx]}, ${pixels[cIdx+1]}, ${pixels[cIdx+2]})`);

    // Sample FG colors along the stroke (slightly inward toward centroid)
    // and around the centroid. Individual samples, NOT averaged — handles
    // multi-colored objects like a person with skin, hair, and clothing.
    const fgSamples: [number, number, number][] = [];
    const step = Math.max(1, Math.floor(stroke.length / 40));
    for (let i = 0; i < stroke.length; i += step) {
      const p = stroke[i];
      // 25% inward toward centroid to avoid sampling background at edges
      const sx = Math.max(0, Math.min(dw - 1, Math.round(p.x + (cx - p.x) * 0.25)));
      const sy = Math.max(0, Math.min(dh - 1, Math.round(p.y + (cy - p.y) * 0.25)));
      const idx = (sy * dw + sx) * 4;
      fgSamples.push([pixels[idx], pixels[idx + 1], pixels[idx + 2]]);
    }
    // Also sample a grid around the centroid
    for (let dy = -15; dy <= 15; dy += 5) {
      for (let dx = -15; dx <= 15; dx += 5) {
        const x = Math.max(0, Math.min(dw - 1, cx + dx));
        const y = Math.max(0, Math.min(dh - 1, cy + dy));
        const idx = (y * dw + x) * 4;
        fgSamples.push([pixels[idx], pixels[idx + 1], pixels[idx + 2]]);
      }
    }

    // Sample BG colors from a ring outside the stroke bbox + canvas corners
    const bgSamples: [number, number, number][] = [];
    const PAD = 30;
    const ox1 = Math.max(0, bx1 - PAD), oy1 = Math.max(0, by1 - PAD);
    const ox2 = Math.min(dw - 1, bx2 + PAD), oy2 = Math.min(dh - 1, by2 + PAD);
    for (let y = oy1; y <= oy2; y += 8) {
      for (let x = ox1; x <= ox2; x += 8) {
        if (x < bx1 || x > bx2 || y < by1 || y > by2) {
          const idx = (y * dw + x) * 4;
          bgSamples.push([pixels[idx], pixels[idx + 1], pixels[idx + 2]]);
        }
      }
    }
    for (const [x, y] of [[0, 0], [dw - 1, 0], [0, dh - 1], [dw - 1, dh - 1]]) {
      const idx = (y * dw + x) * 4;
      bgSamples.push([pixels[idx], pixels[idx + 1], pixels[idx + 2]]);
    }
    if (bgSamples.length === 0) bgSamples.push([128, 128, 128]);

    console.log(`[GrabCut] FG samples: ${fgSamples.length}, BG samples: ${bgSamples.length}`);
    console.log(`[GrabCut] FG sample colors (first 10):`, fgSamples.slice(0, 10).map(c => `rgb(${c[0]},${c[1]},${c[2]})`));
    console.log(`[GrabCut] BG sample colors (first 10):`, bgSamples.slice(0, 10).map(c => `rgb(${c[0]},${c[1]},${c[2]})`));

    // Per-pixel classification: closest FG sample vs closest BG sample.
    // Checking nearest sample (not mean) handles multi-colored objects.
    const classified = new Uint8Array(dw * dh); // 1 = likely foreground
    for (let y = by1; y <= by2; y++) {
      for (let x = bx1; x <= bx2; x++) {
        const i = (y * dw + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        let minFg = Infinity;
        for (let s = 0; s < fgSamples.length; s++) {
          const d = (r - fgSamples[s][0]) ** 2 + (g - fgSamples[s][1]) ** 2 + (b - fgSamples[s][2]) ** 2;
          if (d < minFg) minFg = d;
        }
        let minBg = Infinity;
        for (let s = 0; s < bgSamples.length; s++) {
          const d = (r - bgSamples[s][0]) ** 2 + (g - bgSamples[s][1]) ** 2 + (b - bgSamples[s][2]) ** 2;
          if (d < minBg) minBg = d;
        }
        classified[y * dw + x] = minFg <= minBg ? 1 : 0;
      }
    }

    // Count classified pixels
    let fgCount = 0, bgCount = 0;
    for (let y = by1; y <= by2; y++) {
      for (let x = bx1; x <= bx2; x++) {
        if (classified[y * dw + x] === 1) fgCount++; else bgCount++;
      }
    }
    const bboxArea = (bx2 - bx1 + 1) * (by2 - by1 + 1);
    console.log(`[GrabCut] classified: FG=${fgCount} (${(fgCount/bboxArea*100).toFixed(1)}%), BG=${bgCount} (${(bgCount/bboxArea*100).toFixed(1)}%) within bbox`);

    // DFS from centroid — 8-connectivity for better region cohesion
    const result = new Uint8Array(dw * dh);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const startIdx = cy * dw + cx;
    console.log(`[GrabCut] centroid classified as: ${classified[startIdx] === 1 ? 'FG' : 'BG'} (value=${classified[startIdx]})`);

    function floodFill(seedIdx: number) {
      const stack = [seedIdx];
      classified[seedIdx] = 2;
      while (stack.length > 0) {
        const idx = stack.pop()!;
        result[idx] = 1;
        const px = idx % dw, py = Math.floor(idx / dw);
        for (const [ddx, ddy] of dirs) {
          const nx = px + ddx, ny = py + ddy;
          if (nx < bx1 || nx > bx2 || ny < by1 || ny > by2) continue;
          const ni = ny * dw + nx;
          if (classified[ni] === 1) { classified[ni] = 2; stack.push(ni); }
        }
      }
    }

    if (classified[startIdx] !== 1) {
      // Seed fell on a background pixel — find nearest FG pixel
      let found = false;
      outer: for (let r = 1; r <= 60; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < bx1 || nx > bx2 || ny < by1 || ny > by2) continue;
            if (classified[ny * dw + nx] === 1) {
              floodFill(ny * dw + nx);
              found = true; break outer;
            }
          }
        }
      }
      if (!found) return null;
    } else {
      floodFill(startIdx);
    }

    const data: boolean[] = new Array(dw * dh);
    let finalCount = 0;
    for (let i = 0; i < dw * dh; i++) { data[i] = result[i] === 1; if (data[i]) finalCount++; }
    console.log(`[GrabCut] flood fill result: ${finalCount} pixels (${(finalCount / (dw*dh) * 100).toFixed(2)}% of canvas)`);
    return { data, dw, dh };
  }

  function smartSelectDelete() {
    const mask = samMaskRef.current;
    const layerId = samClickLayerRef.current;
    if (!mask || !layerId) return;
    saveHistory();
    // Flatten objects into pixel canvas so we erase the actual visible pixels
    flattenLayerObjects(layerId);
    const pc = pixelCanvases.current.get(layerId);
    if (!pc) { clearSamSelection(); return; }
    const dw = mask.dw, dh = mask.dh;
    const pcCtx = pc.getContext('2d')!;
    const imgData = pcCtx.getImageData(0, 0, dw, dh);
    let erased = 0;
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i]) {
        imgData.data[i * 4] = 0;
        imgData.data[i * 4 + 1] = 0;
        imgData.data[i * 4 + 2] = 0;
        imgData.data[i * 4 + 3] = 0;
        erased++;
      }
    }
    pcCtx.putImageData(imgData, 0, 0);
    console.log(`[SmartSelect delete] erased ${erased} pixels from layer ${layerId}`);
    clearSamSelection();
    updateThumbnails();
  }

  function smartSelectToNewLayer() {
    const mask = samMaskRef.current;
    const layerId = samClickLayerRef.current;
    if (!mask || !layerId) return;
    saveHistory();
    flattenLayerObjects(layerId);
    const extracted = extractMaskedPixels(mask, layerId, true);
    if (!extracted) { clearSamSelection(); return; }

    const { dataUrl, x, y, w, h } = extracted;
    const newLayerId = uid();
    const newLayer: Layer = { id: newLayerId, name: 'Selected Object', visible: true, opacity: 1, blendMode: 'source-over' };
    const pc2 = document.createElement('canvas');
    pc2.width = mask.dw; pc2.height = mask.dh;
    pixelCanvases.current.set(newLayerId, pc2);
    const newLayers = [...layersRef.current, newLayer];
    layersRef.current = newLayers;
    setLayers(newLayers);

    const img = new Image();
    img.onload = () => {
      imageCache.current.set(dataUrl, img);
      const newObj: PaintObj = {
        id: uid(), layerId: newLayerId, type: 'image',
        x, y, w, h, opacity: 1, src: dataUrl, lockAspect: true, naturalAr: w / h,
      };
      const next = [...objectsRef.current, newObj];
      objectsRef.current = next;
      setObjects(next);
      setActiveLayerId(newLayerId);
      setSelectedId(newObj.id);
      selectedIdRef.current = newObj.id;
      setTool('select');
      toolRef.current = 'select';
      clearSamSelection();
      updateThumbnails();
      renderAll(newLayers, next, newObj.id);
    };
    img.src = dataUrl;
  }

  function smartSelectMakeObject() {
    const mask = samMaskRef.current;
    const layerId = samClickLayerRef.current;
    if (!mask || !layerId) return;
    saveHistory();
    flattenLayerObjects(layerId);
    const extracted = extractMaskedPixels(mask, layerId, true);
    if (!extracted) { clearSamSelection(); return; }

    const { dataUrl, x, y, w, h } = extracted;
    const img = new Image();
    img.onload = () => {
      imageCache.current.set(dataUrl, img);
      const newObj: PaintObj = {
        id: uid(), layerId, type: 'image',
        x, y, w, h, opacity: 1, src: dataUrl, lockAspect: true, naturalAr: w / h,
      };
      const next = [...objectsRef.current, newObj];
      objectsRef.current = next;
      setObjects(next);
      setSelectedId(newObj.id);
      selectedIdRef.current = newObj.id;
      setTool('select');
      toolRef.current = 'select';
      clearSamSelection();
      updateThumbnails();
      renderAll(layersRef.current, next, newObj.id);
    };
    img.src = dataUrl;
  }

  // ── History ────────────────────────────────────────────────────────────────

  function saveHistory() {
    const dw = docWRef.current, dh = docHRef.current;
    const pixels = Array.from(pixelCanvases.current.entries()).map(([id, c]) => ({
      id,
      data: c.getContext('2d')!.getImageData(0, 0, dw, dh),
    }));
    const snap = { pixels, objects: [...objectsRef.current], docW: dw, docH: dh };
    history.current = history.current.slice(0, histIdx.current + 1);
    history.current.push(snap);
    histIdx.current++;
  }

  function applyHistoryEntry(entry: typeof history.current[0]) {
    // Restore doc dimensions if changed
    if (entry.docW !== docWRef.current || entry.docH !== docHRef.current) {
      docWRef.current = entry.docW;
      docHRef.current = entry.docH;
      setDocW(entry.docW);
      setDocH(entry.docH);
      pixelCanvases.current.forEach((pc) => {
        pc.width = entry.docW;
        pc.height = entry.docH;
      });
      tempCanvases.current.forEach((tc) => {
        tc.width = entry.docW;
        tc.height = entry.docH;
      });
    }
    entry.pixels.forEach(({ id, data }) => {
      const c = pixelCanvases.current.get(id);
      if (c) c.getContext('2d')!.putImageData(data, 0, 0);
    });
    const objs = entry.objects;
    objectsRef.current = objs;
    setObjects(objs);
    setSelectedId(null);
    renderAll(layersRef.current, objs, null);
  }

  const undo = useCallback(() => {
    if (histIdx.current <= 0) return;
    histIdx.current--;
    applyHistoryEntry(history.current[histIdx.current]);
  }, []);

  const redo = useCallback(() => {
    if (histIdx.current >= history.current.length - 1) return;
    histIdx.current++;
    applyHistoryEntry(history.current[histIdx.current]);
  }, []);

  // ── Pointer -> canvas coords ────────────────────────────────────────────────

  function getPos(e: React.MouseEvent | MouseEvent): { x: number; y: number } {
    const rect = overlayRef.current!.getBoundingClientRect();
    const scaleX = docWRef.current / rect.width;
    const scaleY = docHRef.current / rect.height;
    return {
      x: ((e as MouseEvent).clientX - rect.left) * scaleX,
      y: ((e as MouseEvent).clientY - rect.top) * scaleY,
    };
  }

  /** Get a composite of only the target layer's content (pixels + objects) for flood fill boundary reading */
  function getLayerCtx(targetLayerId: string): CanvasRenderingContext2D {
    const dw = docWRef.current, dh = docHRef.current;
    const tc = getTempCanvas('__fill_composite__');
    const ctx = tc.getContext('2d')!;
    ctx.clearRect(0, 0, dw, dh);
    const pc = pixelCanvases.current.get(targetLayerId);
    if (pc) {
      ctx.drawImage(pc, 0, 0);
      objectsRef.current
        .filter((o) => o.layerId === targetLayerId)
        .forEach((o) => drawObj(ctx, o, imageCache.current));
    }
    return ctx;
  }

  // ── Brush variants ────────────────────────────────────────────────────────

  function configureBrush(ctx: CanvasRenderingContext2D, kind: BrushKind, col: string, size: number, op: number) {
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = 'source-over';
    switch (kind) {
      case 'pencil':
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = size;
        break;
      case 'marker':
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        ctx.lineWidth = size * 1.4;
        ctx.globalAlpha = Math.min(1, op * 0.6);
        ctx.globalCompositeOperation = 'multiply';
        break;
      case 'airbrush':
        // stamp-based; main line operations are still configured for fallback
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = size;
        break;
      case 'calligraphy':
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        ctx.lineWidth = size;
        break;
    }
  }

  /** Airbrush stamp — soft radial gradient circle. */
  function airbrushStamp(ctx: CanvasRenderingContext2D, x: number, y: number, col: string, size: number, op: number) {
    const r = size;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    // parse color to rgb
    const hex = col.replace('#', '');
    const rr = parseInt(hex.slice(0, 2), 16);
    const gg = parseInt(hex.slice(2, 4), 16);
    const bb = parseInt(hex.slice(4, 6), 16);
    g.addColorStop(0, `rgba(${rr},${gg},${bb},${0.25 * op})`);
    g.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Calligraphy stamp — rotated ellipse at a fixed pen angle (~45°). */
  function calligraphyStamp(ctx: CanvasRenderingContext2D, x: number, y: number, col: string, size: number, op: number) {
    ctx.save();
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = col;
    ctx.translate(x, y);
    ctx.rotate(-Math.PI / 4);
    ctx.beginPath();
    ctx.ellipse(0, 0, size / 2, size / 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Stamps along a segment at a given spacing. Used by airbrush / calligraphy. */
  function stampAlongSegment(
    stamp: (x: number, y: number) => void,
    x0: number, y0: number, x1: number, y1: number,
    spacing: number,
  ) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(dist / spacing));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      stamp(x0 + dx * t, y0 + dy * t);
    }
  }

  /** Box-blur a rectangular region of a canvas in-place. */
  function blurRegion(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, strength: number) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(cw, Math.ceil(cx + r));
    const y1 = Math.min(ch, Math.ceil(cy + r));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 1 || h <= 1) return;
    const img = ctx.getImageData(x0, y0, w, h);
    const src = img.data;
    const tmp = new Uint8ClampedArray(src.length);
    const radius = Math.max(1, Math.round(strength));

    // Circle mask — only blur pixels inside the brush circle, but use full neighborhood
    // For simplicity we blur the whole rect and then alpha-composite a circle mask on output.
    // Horizontal pass: tmp from src
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let rs = 0, gs = 0, bs = 0, as = 0, cnt = 0;
        for (let k = -radius; k <= radius; k++) {
          const xi = Math.min(w - 1, Math.max(0, x + k));
          const i = (y * w + xi) * 4;
          rs += src[i]; gs += src[i + 1]; bs += src[i + 2]; as += src[i + 3];
          cnt++;
        }
        const o = (y * w + x) * 4;
        tmp[o]     = rs / cnt;
        tmp[o + 1] = gs / cnt;
        tmp[o + 2] = bs / cnt;
        tmp[o + 3] = as / cnt;
      }
    }
    // Vertical pass: src from tmp
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let rs = 0, gs = 0, bs = 0, as = 0, cnt = 0;
        for (let k = -radius; k <= radius; k++) {
          const yi = Math.min(h - 1, Math.max(0, y + k));
          const i = (yi * w + x) * 4;
          rs += tmp[i]; gs += tmp[i + 1]; bs += tmp[i + 2]; as += tmp[i + 3];
          cnt++;
        }
        const o = (y * w + x) * 4;
        src[o]     = rs / cnt;
        src[o + 1] = gs / cnt;
        src[o + 2] = bs / cnt;
        src[o + 3] = as / cnt;
      }
    }
    // Composite only the circular area
    const blurredCanvas = document.createElement('canvas');
    blurredCanvas.width = w;
    blurredCanvas.height = h;
    blurredCanvas.getContext('2d')!.putImageData(img, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(blurredCanvas, x0, y0);
    ctx.restore();
  }

  // ── Mouse event handlers ───────────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = getPos(e);
    const t = toolRef.current;
    const al = activeLayerRef.current;
    drawing.current = true;
    startPos.current = pos;
    lastPos.current = pos;

    // Finish inline text editing if clicking with a non-text tool
    if (editingTextIdRef.current && t !== 'text') {
      finishTextEditing();
    }

    // Mask modification mode — paint or erase mask pixels
    if (modifyingMaskRef.current && samMaskRef.current) {
      const erase = e.altKey || e.button === 2;
      maskModifyEraseRef.current = erase;
      paintMask(pos.x, pos.y, brushSizeRef.current / 2, !erase);
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      return;
    }

    if (t === 'select') {
      // Check handles first (on selected object)
      const sel = selectedIdRef.current
        ? objectsRef.current.find((o) => o.id === selectedIdRef.current)
        : null;

      if (sel) {
        // Rotation handle takes priority
        if (rotationHandleHit(sel, pos.x, pos.y)) {
          saveHistory();
          dragMode.current = 'rotate';
          dragOrigObj.current = { ...sel };
          const { x, y, w, h } = getDisplayBounds(sel);
          const cx = x + w / 2, cy = y + h / 2;
          dragStartAngle.current = Math.atan2(pos.y - cy, pos.x - cx);
          dragStartRotation.current = sel.rotation ?? 0;
          return;
        }
        const h = handleAt(sel, pos.x, pos.y);
        if (h) {
          saveHistory();
          dragMode.current = 'resize';
          dragHandle.current = h;
          dragOrigObj.current = { ...sel };
          return;
        }
      }

      // Hit test all objects (topmost first)
      const objs = [...objectsRef.current].reverse();
      const hit = objs.find((o) => hitTest(o, pos.x, pos.y));
      if (hit) {
        if (hit.id !== selectedIdRef.current) {
          setSelectedId(hit.id);
          selectedIdRef.current = hit.id;
        }
        saveHistory();
        dragMode.current = 'move';
        dragOrigObj.current = { ...hit };
        renderAll(layersRef.current, objectsRef.current, hit.id);
      } else {
        setSelectedId(null);
        selectedIdRef.current = null;
        renderAll(layersRef.current, objectsRef.current, null);
      }
      return;
    }

    if (t === 'crop') {
      // Clear any existing crop rect and start fresh
      cropRectRef.current = null;
      setCropRect(null);
      return;
    }

    if (t === 'smart-select') {
      if (useGrabCutRef.current) {
        // GrabCut needs no model — always ready
        samStrokeRef.current = [pos];
        return;
      }
      const status = samStatusRef.current;
      if (status === 'downloading' || status === 'inferring') { drawing.current = false; return; }
      if (status === 'unloaded') {
        drawing.current = false;
        if (localStorage.getItem('paint_sam_ready') === '1') {
          loadSamModel();
        } else {
          setSmartSelectDownloadPopup(true);
        }
        return;
      }
      // ready — start accumulating stroke; onMouseUp will fire inference
      samStrokeRef.current = [pos];
      return;
    }

    if (!al) return;
    const pc = pixelCanvases.current.get(al);
    if (!pc) return;
    const ctx = pc.getContext('2d')!;

    if (t === 'fill') {
      saveHistory();
      const compCtx = getLayerCtx(al);
      floodFill(compCtx, ctx, pos.x, pos.y, colorRef.current, opacityRef.current);
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      drawing.current = false;
      return;
    }

    if (t === 'text') {
      // If already editing a text object, finish it first
      if (editingTextIdRef.current) {
        finishTextEditing();
      }
      const fSize = fontSizeRef.current;
      const ff = fontFamilyRef.current;
      const dims = measureText('|', fSize, ff); // minimal width for empty text
      saveHistory();
      const newId = uid();
      const newObj: PaintObj = {
        id: newId, layerId: al, type: 'text',
        x: pos.x, y: pos.y, w: dims.w, h: dims.h,
        opacity: opacityRef.current,
        text: '', fontSize: fSize, fontFamily: ff, color: colorRef.current,
      };
      const next = [...objectsRef.current, newObj];
      objectsRef.current = next;
      setObjects(next);
      setSelectedId(newId);
      selectedIdRef.current = newId;
      setEditingTextId(newId);
      editingTextIdRef.current = newId;
      textCursorPosRef.current = 0;
      renderAll(layersRef.current, next, newId);
      drawing.current = false;
      return;
    }

    if (t === 'pencil' || t === 'eraser') {
      saveHistory();
      strokePoints.current = [pos];
      const bk = brushKindRef.current;
      if (t === 'eraser') {
        ctx.globalAlpha = opacityRef.current;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = brushSizeRef.current * 3;
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = colorRef.current;
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
        ctx.lineTo(pos.x + 0.1, pos.y + 0.1);
        ctx.stroke();
      } else {
        configureBrush(ctx, bk, colorRef.current, brushSizeRef.current, opacityRef.current);
        if (bk === 'airbrush') {
          airbrushStamp(ctx, pos.x, pos.y, colorRef.current, brushSizeRef.current, opacityRef.current);
          lastAirbrushStampRef.current = performance.now();
        } else if (bk === 'calligraphy') {
          calligraphyStamp(ctx, pos.x, pos.y, colorRef.current, brushSizeRef.current, opacityRef.current);
        } else {
          ctx.beginPath();
          ctx.moveTo(pos.x, pos.y);
          ctx.lineTo(pos.x + 0.1, pos.y + 0.1);
          ctx.stroke();
        }
      }
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      return;
    }

    if (t === 'blur') {
      saveHistory();
      strokePoints.current = [pos];
      blurRegion(ctx, pos.x, pos.y, brushSizeRef.current * 2, Math.max(1, Math.round(brushSizeRef.current / 2)));
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      return;
    }

    // Shape creation begins -- save snapshot for live preview
    if (t === 'shape') {
      saveHistory();
      const dw = docWRef.current, dh = docHRef.current;
      pixelSnapshot.current = pc.getContext('2d')!.getImageData(0, 0, dw, dh);
    }

    if (t === 'eyedropper') {
      // Sample the composite display at this position, set it as current color
      const display = displayRef.current;
      if (display) {
        const ctx = display.getContext('2d')!;
        const px = Math.max(0, Math.min(display.width - 1, Math.round(pos.x)));
        const py = Math.max(0, Math.min(display.height - 1, Math.round(pos.y)));
        const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
        const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        setColor(hex);
        colorRef.current = hex;
      }
      // Return to previous tool after sampling
      drawing.current = false;
      const back = prevToolRef.current === 'eyedropper' ? 'pencil' : prevToolRef.current;
      setTool(back);
      toolRef.current = back;
    }
  }, [renderAll]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = getPos(e);
    const t = toolRef.current;

    // Mask modification mode
    if (modifyingMaskRef.current && samMaskRef.current) {
      cursorPos.current = pos;
      if (drawing.current) {
        paintMask(pos.x, pos.y, brushSizeRef.current / 2, !maskModifyEraseRef.current);
      }
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      return;
    }

    // Text cursor preview
    if (t === 'text') {
      cursorPos.current = pos;
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      return;
    }

    if (!drawing.current) {
      // Update cursor style for handles
      if (t === 'select') {
        const sel = selectedIdRef.current
          ? objectsRef.current.find((o) => o.id === selectedIdRef.current)
          : null;
        const canvas = overlayRef.current;
        if (canvas) {
          if (sel && rotationHandleHit(sel, pos.x, pos.y)) canvas.style.cursor = 'grab';
          else if (sel && handleAt(sel, pos.x, pos.y)) canvas.style.cursor = 'crosshair';
          else if (objectsRef.current.find((o) => hitTest(o, pos.x, pos.y))) canvas.style.cursor = 'move';
          else canvas.style.cursor = 'default';
        }
      }
      return;
    }

    const al = activeLayerRef.current;

    if (t === 'smart-select') {
      samStrokeRef.current.push(pos);
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      return;
    }

    if (t === 'crop' && startPos.current) {
      const x = Math.min(startPos.current.x, pos.x);
      const y = Math.min(startPos.current.y, pos.y);
      const w = Math.abs(pos.x - startPos.current.x);
      const h = Math.abs(pos.y - startPos.current.y);
      const rect = { x, y, w, h };
      cropRectRef.current = rect;
      setCropRect(rect);
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      return;
    }

    if (t === 'select') {
      const selId = selectedIdRef.current;
      if (!selId || !dragMode.current) return;
      const dx = pos.x - (lastPos.current?.x ?? pos.x);
      const dy = pos.y - (lastPos.current?.y ?? pos.y);
      lastPos.current = pos;

      // Rotation drag -- computed from angle to object center
      if (dragMode.current === 'rotate' && dragOrigObj.current) {
        const orig = dragOrigObj.current;
        const { x, y, w, h } = getDisplayBounds(orig);
        const cx = x + w / 2, cy = y + h / 2;
        const angle = Math.atan2(pos.y - cy, pos.x - cx);
        const delta = (angle - dragStartAngle.current) * 180 / Math.PI;
        let newRot = ((dragStartRotation.current + delta) % 360 + 360) % 360;
        // Snap within 8deg of any 90deg multiple
        if (snapToRef.current) {
          const nearest = Math.round(newRot / 90) * 90 % 360;
          if (Math.abs(newRot - nearest) < 8) newRot = nearest;
        }
        const objs = objectsRef.current.map((o) => o.id === selId ? { ...o, rotation: newRot } : o);
        objectsRef.current = objs;
        setObjects(objs);
        renderAll(layersRef.current, objs, selId);
        return;
      }

      const objs = objectsRef.current.map((o) => {
        if (o.id !== selId) return o;
        if (dragMode.current === 'move') return { ...o, x: o.x + dx, y: o.y + dy };
        if (dragMode.current === 'resize' && dragHandle.current && dragOrigObj.current) {
          const orig = dragOrigObj.current;
          const totalDx = pos.x - startPos.current!.x;
          const totalDy = pos.y - startPos.current!.y;
          let updated = applyResize({ ...orig }, dragHandle.current, totalDx, totalDy);
          // Aspect ratio constraint for images
          if (orig.lockAspect && orig.naturalAr && orig.type !== 'line') {
            const ar = orig.naturalAr;
            const handle = dragHandle.current;
            const isNS = handle === 'n' || handle === 's';
            if (isNS) {
              updated.h = Math.max(10, updated.h);
              updated.w = updated.h * ar;
              updated.x = orig.x + orig.w / 2 - updated.w / 2;
            } else {
              updated.w = Math.max(10, updated.w);
              updated.h = updated.w / ar;
              if (handle === 'nw' || handle === 'ne') updated.y = orig.y + orig.h - updated.h;
            }
          }
          return updated;
        }
        return o;
      });
      objectsRef.current = objs;
      renderAll(layersRef.current, objs, selId);
      return;
    }

    if (!al) return;
    const pc = pixelCanvases.current.get(al);
    if (!pc) return;
    const ctx = pc.getContext('2d')!;

    if (t === 'pencil' || t === 'eraser') {
      const prev = strokePoints.current[strokePoints.current.length - 1] ?? pos;
      strokePoints.current.push(pos);
      const bk = brushKindRef.current;
      if (t === 'eraser' || bk === 'pencil' || bk === 'marker') {
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
      } else if (bk === 'airbrush') {
        const col = colorRef.current;
        const sz = brushSizeRef.current;
        const op = opacityRef.current;
        stampAlongSegment((sx, sy) => airbrushStamp(ctx, sx, sy, col, sz, op), prev.x, prev.y, pos.x, pos.y, Math.max(2, sz / 3));
      } else if (bk === 'calligraphy') {
        const col = colorRef.current;
        const sz = brushSizeRef.current;
        const op = opacityRef.current;
        stampAlongSegment((sx, sy) => calligraphyStamp(ctx, sx, sy, col, sz, op), prev.x, prev.y, pos.x, pos.y, Math.max(1, sz / 4));
      }
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
    } else if (t === 'blur') {
      const prev = strokePoints.current[strokePoints.current.length - 1] ?? pos;
      strokePoints.current.push(pos);
      const r = brushSizeRef.current * 2;
      const strength = Math.max(1, Math.round(brushSizeRef.current / 2));
      // Stamp blur along the segment for smooth strokes
      const dist = Math.hypot(pos.x - prev.x, pos.y - prev.y);
      const n = Math.max(1, Math.ceil(dist / (r * 0.5)));
      for (let i = 1; i <= n; i++) {
        const t2 = i / n;
        const sx = prev.x + (pos.x - prev.x) * t2;
        const sy = prev.y + (pos.y - prev.y) * t2;
        blurRegion(ctx, sx, sy, r, strength);
      }
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
    } else if (t === 'shape' && startPos.current) {
      const x = startPos.current.x;
      const y = startPos.current.y;
      let w = pos.x - x;
      let h = pos.y - y;
      if (shapeTypeRef.current === 'circle') {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = s * (w < 0 ? -1 : 1);
        h = s * (h < 0 ? -1 : 1);
      }
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current, { type: shapeTypeRef.current, x, y, w, h });
    }
    lastPos.current = pos;
  }, [renderAll]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!drawing.current) return;
    drawing.current = false;
    const pos = getPos(e);
    const t = toolRef.current;
    const al = activeLayerRef.current;

    // In mask modify mode, just stop drawing — don't trigger inference
    if (modifyingMaskRef.current) return;

    if (t === 'crop' && startPos.current) {
      const x = Math.min(startPos.current.x, pos.x);
      const y = Math.min(startPos.current.y, pos.y);
      const w = Math.abs(pos.x - startPos.current.x);
      const h = Math.abs(pos.y - startPos.current.y);
      if (w > 3 && h > 3) {
        const rect = { x, y, w, h };
        cropRectRef.current = rect;
        setCropRect(rect);
      } else {
        cropRectRef.current = null;
        setCropRect(null);
      }
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      return;
    }

    if (t === 'select') {
      if (dragMode.current) {
        const objs = objectsRef.current.map(normBounds);
        objectsRef.current = objs;
        setObjects(objs);
        dragMode.current = null;
        dragHandle.current = null;
        renderAll(layersRef.current, objs, selectedIdRef.current);
      }
      return;
    }

    if (t === 'smart-select') {
      const stroke = samStrokeRef.current;
      samStrokeRef.current = [];
      console.log(`[SmartSelect mouseUp] stroke.length=${stroke.length}, activeLayer=${al}, mode=${useGrabCutRef.current ? 'GrabCut' : 'SAM'}, samStatus=${samStatusRef.current}`);
      if (!al || stroke.length < 10) {
        console.log('[SmartSelect mouseUp] aborted: no layer or stroke too short (need 10+ points)');
        renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
        return;
      }

      if (useGrabCutRef.current) {
        console.log('[SmartSelect mouseUp] running GrabCut...');
        const result = runGrabCutSegment(stroke, al);
        console.log('[SmartSelect mouseUp] GrabCut result:', result ? `${result.dw}x${result.dh}, ${result.data.filter(Boolean).length} true pixels` : 'null');
        if (result) {
          samMaskRef.current = result;
          samClickLayerRef.current = al;
          setSamActionPopup({ screenX: e.clientX, screenY: e.clientY });
        }
        renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
        return;
      }

      // SAM mode — build multiple interior positive points from the stroke
      if (samStatusRef.current !== 'ready') {
        console.log('[SmartSelect mouseUp] SAM not ready, status:', samStatusRef.current);
        renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
        return;
      }
      const centroid = {
        x: stroke.reduce((s, p) => s + p.x, 0) / stroke.length,
        y: stroke.reduce((s, p) => s + p.y, 0) / stroke.length,
      };
      const xs = stroke.map((p) => p.x), ys = stroke.map((p) => p.y);
      const strokeBbox: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

      // Sample ~16 evenly-spaced stroke points and create interior points
      // at two depths: 25% inward (near edges — catches overhangs, details)
      // and 50% inward (solidly inside — catches windows, colored parts).
      const positivePoints: { x: number; y: number }[] = [centroid];
      const sampleCount = Math.min(12, stroke.length);
      const sampleStep = Math.max(1, Math.floor(stroke.length / sampleCount));
      for (let i = 0; i < stroke.length; i += sampleStep) {
        const p = stroke[i];
        positivePoints.push({
          x: p.x + (centroid.x - p.x) * 0.25,
          y: p.y + (centroid.y - p.y) * 0.25,
        });
        positivePoints.push({
          x: p.x + (centroid.x - p.x) * 0.5,
          y: p.y + (centroid.y - p.y) * 0.5,
        });
      }
      console.log(`[SmartSelect mouseUp] SAM centroid: (${centroid.x.toFixed(1)}, ${centroid.y.toFixed(1)}), bbox: [${strokeBbox.map(v => v.toFixed(1)).join(', ')}], positive points: ${positivePoints.length}`);
      runSmartSelect(positivePoints, e.clientX, e.clientY, al, strokeBbox);
      return;
    }

    if (!al) return;
    const pc = pixelCanvases.current.get(al);
    if (!pc) return;
    const ctx = pc.getContext('2d')!;

    if (t === 'pencil' || t === 'eraser' || t === 'blur') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    if (t === 'shape' && startPos.current) {
      const x = startPos.current.x;
      const y = startPos.current.y;
      let w = pos.x - x;
      let h = pos.y - y;

      if (Math.abs(w) < 3 && Math.abs(h) < 3) {
        pixelSnapshot.current = null;
        renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
        return;
      }

      const kind = shapeTypeRef.current;
      if (kind === 'circle') {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = s * (w < 0 ? -1 : 1);
        h = s * (h < 0 ? -1 : 1);
      }

      const newObj: PaintObj = {
        id: uid(), layerId: al, type: kind,
        x, y, w, h,
        opacity: opacityRef.current,
        strokeColor: colorRef.current,
        strokeWidth: brushSizeRef.current,
        fillColor: fillColorRef.current,
        fillGradient: fillGradientRef.current.enabled ? { ...fillGradientRef.current } : undefined,
      };
      const next = normBounds(newObj);
      const objs = [...objectsRef.current, next];
      objectsRef.current = objs;
      setObjects(objs);
      setSelectedId(next.id);
      selectedIdRef.current = next.id;
      setTool('select');
      toolRef.current = 'select';
      pixelSnapshot.current = null;
      renderAll(layersRef.current, objs, next.id);
    }
  }, [renderAll]);

  // ── Layer management ────────────────────────────────────────────────────────

  function makePixelCanvas() {
    const c = document.createElement('canvas');
    c.width = docWRef.current; c.height = docHRef.current;
    return c;
  }

  const addLayer = useCallback(() => {
    const id = uid();
    pixelCanvases.current.set(id, makePixelCanvas());
    const layer: Layer = { id, name: `Layer ${layersRef.current.length + 1}`, visible: true, opacity: 1, blendMode: 'source-over' };
    const next = [...layersRef.current, layer];
    setLayers(next);
    setActiveLayerId(id);
  }, []);

  const deleteLayer = useCallback((id: string) => {
    if (layersRef.current.length <= 1) return;
    pixelCanvases.current.delete(id);
    tempCanvases.current.delete(id);
    const remaining = layersRef.current.filter((l) => l.id !== id);
    setLayers(remaining);
    if (activeLayerRef.current === id) setActiveLayerId(remaining[remaining.length - 1].id);
    const objs = objectsRef.current.filter((o) => o.layerId !== id);
    objectsRef.current = objs;
    setObjects(objs);
    if (selectedIdRef.current) {
      const stillExists = objs.find((o) => o.id === selectedIdRef.current);
      if (!stillExists) { setSelectedId(null); selectedIdRef.current = null; }
    }
  }, []);

  const moveLayer = useCallback((id: string, dir: 1 | -1) => {
    const idx = layersRef.current.findIndex((l) => l.id === id);
    const ni = idx + dir;
    if (ni < 0 || ni >= layersRef.current.length) return;
    const next = [...layersRef.current];
    [next[idx], next[ni]] = [next[ni], next[idx]];
    setLayers(next);
  }, []);

  const updateLayer = useCallback((id: string, patch: Partial<Layer>) => {
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  // ── Object management ───────────────────────────────────────────────────────

  const deleteSelected = useCallback(() => {
    const id = selectedIdRef.current;
    if (!id) return;
    saveHistory();
    const objs = objectsRef.current.filter((o) => o.id !== id);
    objectsRef.current = objs;
    setObjects(objs);
    setSelectedId(null);
    selectedIdRef.current = null;
    renderAll(layersRef.current, objs, null);
  }, [renderAll]);

  const updateSelectedObj = useCallback((patch: Partial<PaintObj>) => {
    const id = selectedIdRef.current;
    if (!id) return;
    const objs = objectsRef.current.map((o) => (o.id === id ? { ...o, ...patch } : o));
    objectsRef.current = objs;
    setObjects(objs);
    renderAll(layersRef.current, objs, id);
  }, [renderAll]);

  /** Finish inline text editing — remove the object if text is empty */
  function finishTextEditing() {
    const eid = editingTextIdRef.current;
    if (!eid) return;
    setEditingTextId(null);
    editingTextIdRef.current = null;
    // If text is empty, remove the object
    const obj = objectsRef.current.find((o) => o.id === eid);
    if (obj && (!obj.text || obj.text.trim() === '')) {
      const next = objectsRef.current.filter((o) => o.id !== eid);
      objectsRef.current = next;
      setObjects(next);
      if (selectedIdRef.current === eid) {
        setSelectedId(null);
        selectedIdRef.current = null;
      }
      renderAll(layersRef.current, next, selectedIdRef.current);
    } else {
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
    }
  }

  /** Start editing an existing text object inline */
  function startTextEditing(objId: string) {
    const obj = objectsRef.current.find((o) => o.id === objId);
    setEditingTextId(objId);
    editingTextIdRef.current = objId;
    textCursorPosRef.current = (obj?.text ?? '').length;
    setSelectedId(objId);
    selectedIdRef.current = objId;
    renderAll(layersRef.current, objectsRef.current, objId);
  }

  // ── Import image as object ─────────────────────────────────────────────────

  const addImageToLayer = useCallback((src: string, layerId: string) => {
    const img = new Image();
    img.onload = () => {
      imageCache.current.set(src, img);
      const dw = docWRef.current, dh = docHRef.current;
      const scale = Math.min(1, dw / img.naturalWidth, dh / img.naturalHeight);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const x = Math.round((dw - w) / 2);
      const y = Math.round((dh - h) / 2);
      saveHistory();
      const newObj: PaintObj = {
        id: uid(), layerId, type: 'image',
        x, y, w, h, opacity: 1, src,
        naturalAr: w / h,
      };
      const objs = [...objectsRef.current, newObj];
      objectsRef.current = objs;
      setObjects(objs);
      setSelectedId(newObj.id);
      selectedIdRef.current = newObj.id;
      setTool('select');
      toolRef.current = 'select';
      renderAll(layersRef.current, objs, newObj.id);
    };
    img.src = src;
  }, [renderAll]);

  const importImage = useCallback((file: File) => {
    if (!activeLayerRef.current) return;
    const src = URL.createObjectURL(file);
    addImageToLayer(src, activeLayerRef.current);
  }, [addImageToLayer]);

  // ── Paste handling ─────────────────────────────────────────────────────────

  const pasteToCurrentLayer = useCallback((dataUrl: string) => {
    if (!activeLayerRef.current) return;
    addImageToLayer(dataUrl, activeLayerRef.current);
    setPasteDialog(null);
  }, [addImageToLayer]);

  const pasteAsNewLayer = useCallback((dataUrl: string) => {
    const id = uid();
    pixelCanvases.current.set(id, makePixelCanvas());
    const layer: Layer = { id, name: `Layer ${layersRef.current.length + 1}`, visible: true, opacity: 1, blendMode: 'source-over' };
    const next = [...layersRef.current, layer];
    layersRef.current = next;
    setLayers(next);
    setActiveLayerId(id);
    activeLayerRef.current = id;
    addImageToLayer(dataUrl, id);
    setPasteDialog(null);
  }, [addImageToLayer]);

  // ── Crop ────────────────────────────────────────────────────────────────────

  const applyCrop = useCallback((rect: { x: number; y: number; w: number; h: number }) => {
    saveHistory();
    const dw = docWRef.current, dh = docHRef.current;
    const ix = Math.max(0, Math.round(rect.x));
    const iy = Math.max(0, Math.round(rect.y));
    const iw = Math.min(dw - ix, Math.round(rect.w));
    const ih = Math.min(dh - iy, Math.round(rect.h));
    if (iw < 1 || ih < 1) return;

    // Extract cropped region from each pixel canvas and resize
    pixelCanvases.current.forEach((pc) => {
      const ctx = pc.getContext('2d')!;
      const data = ctx.getImageData(ix, iy, iw, ih);
      pc.width = iw;
      pc.height = ih;
      ctx.putImageData(data, 0, 0);
    });

    // Resize temp canvases
    tempCanvases.current.forEach((tc) => {
      tc.width = iw;
      tc.height = ih;
    });

    // Update document dimensions
    docWRef.current = iw;
    docHRef.current = ih;
    setDocW(iw);
    setDocH(ih);

    // Shift all objects by the crop offset
    const objs = objectsRef.current.map((o) => ({ ...o, x: o.x - ix, y: o.y - iy }));
    objectsRef.current = objs;
    setObjects(objs);
    setSelectedId(null);
    selectedIdRef.current = null;
    cropRectRef.current = null;
    setCropRect(null);
    setTool('select');
    toolRef.current = 'select';
    renderAll(layersRef.current, objs, null);
  }, [renderAll]);

  const cropToSelection = useCallback(() => {
    const sel = selectedIdRef.current
      ? objectsRef.current.find((o) => o.id === selectedIdRef.current)
      : null;
    if (!sel) return;
    const bounds = getDisplayBounds(sel);
    applyCrop(bounds);
  }, [applyCrop]);

  // ── Zoom ──────────────────────────────────────────────────────────────────

  const fullPageRef = useRef(fullPage); fullPageRef.current = fullPage;
  const fitToContainer = useCallback(() => {
    if (canvasContainerRef.current) {
      const containerW = canvasContainerRef.current.clientWidth - 6;
      // In full page mode, the container can use the full grid row height.
      // In normal mode, use 78vh (the maxHeight CSS value), not clientHeight which shrinks with content.
      const containerH = fullPageRef.current
        ? canvasContainerRef.current.parentElement!.clientHeight - 6
        : window.innerHeight * 0.78;
      const z = Math.min(containerW / docWRef.current, containerH / docHRef.current);
      setZoom(z);
      zoomRef.current = z;
    }
  }, []);

  // ── Export / new ───────────────────────────────────────────────────────────

  const exportPng = useCallback(() => {
    if (!displayRef.current) return;
    const a = document.createElement('a');
    a.href = displayRef.current.toDataURL('image/png');
    a.download = 'painting.png';
    a.click();
  }, []);

  const newCanvas = useCallback(() => {
    pixelCanvases.current.clear();
    tempCanvases.current.clear();
    history.current = [];
    histIdx.current = -1;
    docWRef.current = DEFAULT_W;
    docHRef.current = DEFAULT_H;
    setDocW(DEFAULT_W);
    setDocH(DEFAULT_H);
    const id = uid();
    const c = document.createElement('canvas');
    c.width = DEFAULT_W; c.height = DEFAULT_H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, DEFAULT_W, DEFAULT_H);
    pixelCanvases.current.set(id, c);
    const layer: Layer = { id, name: 'Layer 1', visible: true, opacity: 1, blendMode: 'source-over' };
    objectsRef.current = [];
    setObjects([]);
    setSelectedId(null);
    selectedIdRef.current = null;
    setLayers([layer]);
    setActiveLayerId(id);
  }, []);

  // ── Init + effects ─────────────────────────────────────────────────────────

  useEffect(() => {
    const id = uid();
    const pc = document.createElement('canvas');
    pc.width = DEFAULT_W; pc.height = DEFAULT_H;
    const pCtx = pc.getContext('2d')!;
    pCtx.fillStyle = '#ffffff';
    pCtx.fillRect(0, 0, DEFAULT_W, DEFAULT_H);
    pixelCanvases.current.set(id, pc);
    const layer: Layer = { id, name: 'Layer 1', visible: true, opacity: 1, blendMode: 'source-over' };
    setLayers([layer]);
    setActiveLayerId(id);
    saveHistory();
    // Fit zoom to container after first render
    requestAnimationFrame(() => {
      if (canvasContainerRef.current) {
        const containerW = canvasContainerRef.current.clientWidth - 6;
        const z = Math.min(1, containerW / DEFAULT_W);
        setZoom(z);
        zoomRef.current = z;
      }
    });
  }, []);

  useEffect(() => {
    renderAll(layers, objects, selectedId);
  }, [layers, objects, selectedId, docW, docH, renderAll]);

  // Blink timer for inline text editing cursor
  useEffect(() => {
    if (!editingTextId) return;
    const id = setInterval(() => {
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
    }, 500);
    return () => clearInterval(id);
  }, [editingTextId, renderAll]);

  // Render popup preview after the popup canvas is mounted
  useEffect(() => {
    if (thumbPopup) {
      renderPopupPreview(thumbPopup.layerId);
    }
  }, [thumbPopup]);

  // Auto-load SAM model if previously downloaded and user selects smart-select
  useEffect(() => {
    if (tool !== 'smart-select') return;
    if (useGrabCutRef.current) return;
    if (samStatusRef.current !== 'unloaded') return;
    if (localStorage.getItem('paint_sam_ready') === '1') {
      loadSamModel();
    }
  }, [tool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'SELECT') return;

      // Inline text editing — route keys to the editing text object
      if (editingTextIdRef.current) {
        const eid = editingTextIdRef.current;
        const obj = objectsRef.current.find((o) => o.id === eid);
        if (!obj) return;
        const oldTxt = obj.text ?? '';
        const cp = textCursorPosRef.current;

        if (e.key === 'Escape') {
          e.preventDefault();
          finishTextEditing();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); return; }

        // Arrow keys — move cursor
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          textCursorPosRef.current = Math.max(0, cp - 1);
          renderAll(layersRef.current, objectsRef.current, eid);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          textCursorPosRef.current = Math.min(oldTxt.length, cp + 1);
          renderAll(layersRef.current, objectsRef.current, eid);
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          // Find current line and column
          const before = oldTxt.slice(0, cp);
          const lines = oldTxt.split('\n');
          const beforeLines = before.split('\n');
          const curLine = beforeLines.length - 1;
          const curCol = beforeLines[curLine].length;
          const targetLine = e.key === 'ArrowUp' ? curLine - 1 : curLine + 1;
          if (targetLine < 0 || targetLine >= lines.length) return;
          const targetCol = Math.min(curCol, lines[targetLine].length);
          // Compute new absolute position
          let newPos = 0;
          for (let i = 0; i < targetLine; i++) newPos += lines[i].length + 1; // +1 for \n
          newPos += targetCol;
          textCursorPosRef.current = newPos;
          renderAll(layersRef.current, objectsRef.current, eid);
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          // Move to start of current line
          const before = oldTxt.slice(0, cp);
          const lastNewline = before.lastIndexOf('\n');
          textCursorPosRef.current = lastNewline + 1;
          renderAll(layersRef.current, objectsRef.current, eid);
          return;
        }
        if (e.key === 'End') {
          e.preventDefault();
          // Move to end of current line
          const nextNewline = oldTxt.indexOf('\n', cp);
          textCursorPosRef.current = nextNewline === -1 ? oldTxt.length : nextNewline;
          renderAll(layersRef.current, objectsRef.current, eid);
          return;
        }

        // Helper to update text and cursor
        const updateText = (newTxt: string, newCp: number) => {
          const dims = measureText(newTxt || '|', obj.fontSize ?? 24, obj.fontFamily);
          const objs = objectsRef.current.map((o) => o.id === eid ? { ...o, text: newTxt, w: dims.w, h: dims.h } : o);
          objectsRef.current = objs;
          setObjects(objs);
          textCursorPosRef.current = newCp;
          renderAll(layersRef.current, objs, eid);
        };

        if (e.key === 'Enter') {
          e.preventDefault();
          updateText(oldTxt.slice(0, cp) + '\n' + oldTxt.slice(cp), cp + 1);
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (cp === 0) return;
          updateText(oldTxt.slice(0, cp - 1) + oldTxt.slice(cp), cp - 1);
          return;
        }
        if (e.key === 'Delete') {
          e.preventDefault();
          if (cp >= oldTxt.length) return;
          updateText(oldTxt.slice(0, cp) + oldTxt.slice(cp + 1), cp);
          return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          updateText(oldTxt.slice(0, cp) + e.key + oldTxt.slice(cp), cp + 1);
          return;
        }
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
      if (e.key === 'Escape') { setSelectedId(null); selectedIdRef.current = null; renderAll(layersRef.current, objectsRef.current, null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelected, undo, redo, renderAll]);

  // Paste event listener
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;
          const url = URL.createObjectURL(blob);
          setPasteDialog(url);
          return;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // Ctrl+wheel zoom
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left + container.scrollLeft;
      const mouseY = e.clientY - rect.top + container.scrollTop;
      const oldZ = zoomRef.current;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZ = Math.max(0.1, Math.min(4, oldZ * factor));
      setZoom(newZ);
      zoomRef.current = newZ;
      // Adjust scroll to zoom toward cursor
      requestAnimationFrame(() => {
        const scale = newZ / oldZ;
        container.scrollLeft = mouseX * scale - (e.clientX - rect.left);
        container.scrollTop = mouseY * scale - (e.clientY - rect.top);
      });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // ── Selected object for sidebar display ────────────────────────────────────

  const selObj = objects.find((o) => o.id === selectedId) ?? null;

  const FONTS = [
    { label: 'Poppins', value: 'Poppins, sans-serif' },
    { label: 'DM Serif Text', value: 'DM Serif Text, serif' },
    { label: 'Monospace', value: 'monospace' },
  ];

  const SWATCHES = ['#000000', '#ffffff', '#2563eb', '#16a34a', '#dc2626', '#9333ea'];

  const TOOLS: { id: Tool; label: string; icon: string }[] = [
    { id: 'select', label: 'Select', icon: '\u2196' },
    { id: 'pencil', label: 'Brush', icon: '\u270F\uFE0F' },
    { id: 'eraser', label: 'Eraser', icon: '\uD83E\uDDF9' },
    { id: 'blur',   label: 'Blur',   icon: '\uD83D\uDCA7' },
    { id: 'fill', label: 'Fill', icon: '\uD83E\uDEA3' },
    { id: 'eyedropper', label: 'Eyedropper', icon: '\uD83D\uDC41' },
    { id: 'shape', label: 'Shapes', icon: '\u25A2' },
    { id: 'text', label: 'Text', icon: 'T' },
    { id: 'crop', label: 'Crop', icon: '\u2702' },
    { id: 'smart-select', label: 'Smart Select', icon: '\u2728' },
  ];

  const SHAPE_ICONS: Record<ShapeKind, { icon: string; label: string }> = {
    'rect':       { icon: '\u25AD', label: 'Rectangle' },
    'rect-round': { icon: '\u25A2', label: 'Rounded rect' },
    'ellipse':    { icon: '\u2B2D', label: 'Ellipse' },
    'circle':     { icon: '\u25EF', label: 'Circle' },
    'line':       { icon: '\u2571', label: 'Line' },
    'arrow':      { icon: '\u2197', label: 'Arrow' },
    'triangle':   { icon: '\u25B3', label: 'Triangle' },
    'diamond':    { icon: '\u25C7', label: 'Diamond' },
    'pentagon':   { icon: '\u2B1F', label: 'Pentagon' },
    'hexagon':    { icon: '\u2B22', label: 'Hexagon' },
    'star':       { icon: '\u2606', label: 'Star' },
    'heart':      { icon: '\u2661', label: 'Heart' },
  };

  const BLENDS: BlendMode[] = ['source-over', 'multiply', 'screen', 'overlay'];

  // ── JSX ────────────────────────────────────────────────────────────────────

  return (
    <div style={fullPage ? { position: 'fixed', inset: 0, zIndex: 9000, background: '#fff', display: 'flex', flexDirection: 'column', overflow: 'hidden' } : { maxWidth: 1340, margin: '0 auto' }}>
      {/* Paste dialog */}
      {pasteDialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', border: '3px solid #000', padding: 24, boxShadow: '5px 5px 0 #000', fontFamily: 'Poppins, sans-serif', textAlign: 'center', maxWidth: 360 }}>
            <p style={{ fontWeight: 700, fontSize: 16, marginBottom: 16, marginTop: 0 }}>Paste Image</p>
            <p style={{ fontSize: 13, marginBottom: 20, color: '#555' }}>Where would you like to paste this image?</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button style={{ ...S.smallBtn('#000', '#fff'), padding: '8px 16px', fontSize: 13 }}
                onClick={() => pasteToCurrentLayer(pasteDialog)}>
                Current Layer
              </button>
              <button style={{ ...S.smallBtn('#2563eb', '#fff'), padding: '8px 16px', fontSize: 13 }}
                onClick={() => pasteAsNewLayer(pasteDialog)}>
                New Layer
              </button>
              <button style={{ ...S.smallBtn(), padding: '8px 16px', fontSize: 13 }}
                onClick={() => { URL.revokeObjectURL(pasteDialog); setPasteDialog(null); }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SAM model download popup */}
      {smartSelectDownloadPopup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', border: '3px solid #000', padding: 24, boxShadow: '5px 5px 0 #000', fontFamily: 'Poppins, sans-serif', textAlign: 'center', maxWidth: 380 }}>
            <p style={{ fontWeight: 700, fontSize: 16, marginBottom: 12, marginTop: 0 }}>{'\u2728'} Smart Select</p>
            <p style={{ fontSize: 13, marginBottom: 8, color: '#333' }}>Requires a one-time model download (~90&nbsp;MB) which will be cached in your browser.</p>
            <p style={{ fontSize: 12, marginBottom: 20, color: '#666' }}>Uses SAM ViT-Base (Segment Anything) running entirely in your browser — nothing is uploaded.</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                style={{ ...S.smallBtn('#000', '#fff'), padding: '8px 20px', fontSize: 13 }}
                onClick={() => { setSmartSelectDownloadPopup(false); loadSamModel(); }}
              >
                Download &amp; Enable
              </button>
              <button
                style={{ ...S.smallBtn(), padding: '8px 16px', fontSize: 13 }}
                onClick={() => setSmartSelectDownloadPopup(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SAM action popup — shown after a mask is computed */}
      {samActionPopup && (
        <div style={{ position: 'fixed', top: samActionPopup.screenY + 12, left: samActionPopup.screenX + 12, zIndex: 9998, background: '#fff', border: '3px solid #000', boxShadow: '4px 4px 0 #000', padding: '12px 14px', fontFamily: 'Poppins, sans-serif' }}>
          <p style={{ fontWeight: 700, fontSize: 12, margin: '0 0 8px' }}>Selection ready — what to do?</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <button style={{ ...S.smallBtn('#c00', '#fff'), textAlign: 'left' }} onClick={smartSelectDelete}>
              {'\uD83D\uDDD1\uFE0F'} Delete selection
            </button>
            <button style={{ ...S.smallBtn('#2563eb', '#fff'), textAlign: 'left' }} onClick={smartSelectToNewLayer}>
              {'\u2B06\uFE0F'} Move to new layer
            </button>
            <button style={{ ...S.smallBtn('#166534', '#fff'), textAlign: 'left' }} onClick={smartSelectMakeObject}>
              {'\uD83D\uDCE6'} Make moveable object
            </button>
            <button style={{ ...S.smallBtn('#7c3aed', '#fff'), textAlign: 'left' }} onClick={startModifyMask}>
              {'\u270F\uFE0F'} Modify selection
            </button>
            <button style={{ ...S.smallBtn(), textAlign: 'left' }} onClick={clearSamSelection}>
              {'\u2715'} Cancel
            </button>
          </div>
        </div>
      )}

      {/* Mask modify mode floating controls */}
      {modifyingMask && (
        <div style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 9998, background: '#fff', border: '3px solid #000', boxShadow: '4px 4px 0 #000', padding: '10px 16px', fontFamily: 'Poppins, sans-serif', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>Modify Selection</span>
          <span style={{ fontSize: 11, color: '#666' }}>Click to add · Alt+click or right-click to erase</span>
          <button style={S.smallBtn('#166534', '#fff')} onClick={finishModifyMask}>Done</button>
          <button style={S.smallBtn()} onClick={clearSamSelection}>Cancel</button>
        </div>
      )}

      {/* Settings popup */}
      {settingsOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
          onClick={() => setSettingsOpen(false)}
        >
          <div
            style={{ background: '#fff', border: '3px solid #000', padding: 24, boxShadow: '5px 5px 0 #000', fontFamily: 'Poppins, sans-serif', minWidth: 320, maxWidth: 420 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <strong style={{ fontFamily: 'DM Serif Text, serif', fontSize: 18 }}>{'\u2699\uFE0F'} Settings</strong>
              <button style={S.smallBtn()} onClick={() => setSettingsOpen(false)}>{'\u2715'}</button>
            </div>

            <p style={{ ...S.label, marginBottom: 10 }}>SMART SELECT</p>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginBottom: 14 }}>
              <input
                type='checkbox'
                checked={useGrabCut}
                onChange={(e) => {
                  setUseGrabCut(e.target.checked);
                  localStorage.setItem('paint_grabcut', e.target.checked ? '1' : '0');
                }}
                style={{ marginTop: 3, flexShrink: 0, width: 14, height: 14 }}
              />
              <span>
                <span style={{ fontWeight: 700, fontSize: 12, display: 'block', marginBottom: 3 }}>Use color-based (GrabCut) instead of AI</span>
                <span style={{ fontSize: 11, color: '#555', lineHeight: 1.5, display: 'block' }}>
                  No model download needed. Works instantly but only reliably selects objects
                  whose color differs clearly from the background. Best for colorful subjects
                  against plain backgrounds.
                </span>
              </span>
            </label>

            <div style={{ marginTop: 4, opacity: useGrabCut ? 0.4 : 1 }}>
              <span style={{ fontWeight: 700, fontSize: 12, display: 'block', marginBottom: 3 }}>Spatial constraint</span>
              <span style={{ fontSize: 11, color: '#555', lineHeight: 1.5, display: 'block' }}>
                The selection is always clipped to the bounding box of your painted stroke.
                For best results, trace closely around the object you want to select.
              </span>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid #ccc', margin: '16px 0' }} />
            <p style={{ ...S.label, marginBottom: 10 }}>DISPLAY</p>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={fullPage}
                onChange={(e) => {
                  setFullPage(e.target.checked);
                  localStorage.setItem('paint_fullpage', e.target.checked ? '1' : '0');
                  // Re-fit after layout change
                  requestAnimationFrame(() => fitToContainer());
                }}
                style={{ marginTop: 3, flexShrink: 0, width: 14, height: 14 }}
              />
              <span>
                <span style={{ fontWeight: 700, fontSize: 12, display: 'block', marginBottom: 3 }}>Full page mode</span>
                <span style={{ fontSize: 11, color: '#555', lineHeight: 1.5, display: 'block' }}>
                  Hides the site header and expands the editor to fill the entire browser window.
                </span>
              </span>
            </label>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div style={{ border: fullPage ? 'none' : '3px solid #000', borderBottom: '3px solid #000', background: '#fff', padding: '8px 12px', marginBottom: fullPage ? 0 : 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', boxShadow: fullPage ? 'none' : '4px 4px 0 #000', flexShrink: 0 }}>
        <strong style={{ fontFamily: 'DM Serif Text, serif', fontSize: 20 }}>{'\uD83C\uDFA8'} Paint</strong>
        <button style={S.smallBtn()} onClick={newCanvas}>New</button>
        <label style={{ ...S.smallBtn(), cursor: 'pointer' }}>
          Add image
          <input type='file' accept='image/*' style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && importImage(e.target.files[0])} />
        </label>
        <button style={S.smallBtn()} onClick={exportPng}>{'\u2B07'} PNG</button>
        <button style={S.smallBtn()} onClick={() => setSettingsOpen(true)} title='Settings'>{'\u2699\uFE0F'}</button>
        <span style={{ width: 1, background: '#000', height: 20, display: 'inline-block', margin: '0 4px' }} />
        <button style={S.smallBtn()} onClick={undo} title='Ctrl+Z'>{'\u21A9'} Undo</button>
        <button style={S.smallBtn()} onClick={redo} title='Ctrl+Y'>{'\u21AA'} Redo</button>
        {selectedId && (
          <button style={S.smallBtn('#f44', '#fff')} onClick={deleteSelected}>
            {'\u2715'} Delete selected
          </button>
        )}
        {selectedId && (
          <button style={S.smallBtn()} onClick={cropToSelection} title='Crop canvas to bounding box of selected object'>
            {'\u2702'} Crop to Selection
          </button>
        )}
        {cropRect && (
          <>
            <button style={S.smallBtn('#0a0', '#fff')} onClick={() => applyCrop(cropRect)}>{'\u2713'} Apply Crop</button>
            <button style={S.smallBtn()} onClick={() => {
              cropRectRef.current = null;
              setCropRect(null);
              renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
            }}>{'\u2715'} Cancel</button>
          </>
        )}
        <span style={{ width: 1, background: '#000', height: 20, display: 'inline-block', margin: '0 4px' }} />
        {/* Zoom controls */}
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setZoom((z) => { const nz = Math.min(4, +(z + 0.01).toFixed(2)); zoomRef.current = nz; return nz; });
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setZoom((z) => { const nz = Math.max(0.1, +(z - 0.01).toFixed(2)); zoomRef.current = nz; return nz; });
            }
          }}
        >
        <button style={S.smallBtn()} onClick={() => setZoom((z) => { const nz = Math.max(0.1, +(z - 0.05).toFixed(2)); zoomRef.current = nz; return nz; })} title='Zoom out'>{'\u2212'}</button>
        <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 11, fontWeight: 700, minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <button style={S.smallBtn()} onClick={() => setZoom((z) => { const nz = Math.min(4, +(z + 0.05).toFixed(2)); zoomRef.current = nz; return nz; })} title='Zoom in'>+</button>
        </span>
        <button style={S.smallBtn()} onClick={fitToContainer} title='Fit to view'>Fit</button>
        <button style={S.smallBtn()} onClick={() => { setZoom(1); zoomRef.current = 1; }} title='100%'>1:1</button>
        <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 10, color: '#666' }}>{docW}{'\u00D7'}{docH}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '158px 1fr 192px', gap: fullPage ? 0 : 8, alignItems: 'start', ...(fullPage ? { flex: 1, overflow: 'hidden' } : {}) }}>

        {/* -- Left panel: tools + drawing options -- */}
        <div style={{ ...S.panel, display: 'flex', flexDirection: 'column', gap: 2, ...(fullPage ? { border: 'none', borderRight: '2px solid #000', height: '100%', overflow: 'auto' } : {}) }}>
          <p style={{ ...S.label, marginBottom: 6 }}>TOOLS</p>
          {TOOLS.map((t) => (
            <div key={t.id} style={{ position: 'relative' }}>
              <button
                style={{ ...S.toolBtn(tool === t.id), width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                onClick={() => {
                  if (editingTextIdRef.current) finishTextEditing();
                  if (t.id === 'shape') {
                    setShapeFlyoutOpen((o) => !o);
                    setBrushFlyoutOpen(false);
                  } else if (t.id === 'pencil') {
                    setBrushFlyoutOpen((o) => !o);
                    setShapeFlyoutOpen(false);
                  } else {
                    setShapeFlyoutOpen(false);
                    setBrushFlyoutOpen(false);
                  }
                  if (toolRef.current !== 'eyedropper' && t.id === 'eyedropper') {
                    prevToolRef.current = toolRef.current;
                  }
                  setTool(t.id);
                  toolRef.current = t.id;
                  if (t.id !== 'text') cursorPos.current = null;
                  renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
                }}
              >
                <span>{t.icon} {t.label}</span>
                {(t.id === 'shape' || t.id === 'pencil') && (
                  <span style={{ fontSize: 10, opacity: 0.6 }}>
                    {(t.id === 'shape' ? shapeFlyoutOpen : brushFlyoutOpen) ? '\u25BE' : '\u25B8'}
                  </span>
                )}
              </button>
              {t.id === 'pencil' && brushFlyoutOpen && (
                <div style={{ position: 'absolute', left: 'calc(100% + 6px)', top: 0, zIndex: 50, background: '#fff', border: '3px solid #000', boxShadow: '4px 4px 0 #000', padding: 6, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 }}>
                  {BRUSHES.map((b) => (
                    <button
                      key={b.id}
                      title={b.label}
                      onClick={() => {
                        setBrushKind(b.id);
                        brushKindRef.current = b.id;
                        setTool('pencil');
                        toolRef.current = 'pencil';
                        setBrushFlyoutOpen(false);
                      }}
                      style={{
                        border: brushKind === b.id ? '3px solid #0088ff' : '2px solid #000',
                        background: brushKind === b.id ? '#e6f4ff' : '#fff',
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '4px 8px',
                        textAlign: 'left',
                        fontFamily: 'Poppins, sans-serif',
                        fontWeight: 700,
                      }}
                    >
                      {b.icon} {b.label}
                    </button>
                  ))}
                </div>
              )}
              {t.id === 'shape' && shapeFlyoutOpen && (
                <div style={{ position: 'absolute', left: 'calc(100% + 6px)', top: 0, zIndex: 50, background: '#fff', border: '3px solid #000', boxShadow: '4px 4px 0 #000', padding: 6, display: 'grid', gridTemplateColumns: 'repeat(3, 32px)', gap: 4 }}>
                  {SHAPE_KINDS.map((k) => (
                    <button
                      key={k}
                      title={SHAPE_ICONS[k].label}
                      onClick={() => {
                        setShapeType(k);
                        shapeTypeRef.current = k;
                        setTool('shape');
                        toolRef.current = 'shape';
                        setShapeFlyoutOpen(false);
                      }}
                      style={{
                        width: 32, height: 32,
                        border: shapeType === k ? '3px solid #0088ff' : '2px solid #000',
                        background: shapeType === k ? '#e6f4ff' : '#fff',
                        cursor: 'pointer',
                        fontSize: 16,
                        padding: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'Poppins, sans-serif',
                      }}
                    >
                      {SHAPE_ICONS[k].icon}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          {tool === 'shape' && (
            <div style={{ fontSize: 11, fontFamily: 'Poppins, sans-serif', marginTop: 4, color: '#444' }}>
              Shape: <strong>{SHAPE_ICONS[shapeType].label}</strong>
              {shapeType === 'circle' && <span style={{ color: '#666' }}> (1:1)</span>}
            </div>
          )}

          {tool === 'pencil' && (
            <div style={{ fontSize: 11, fontFamily: 'Poppins, sans-serif', marginTop: 4, color: '#444' }}>
              Brush: <strong>{BRUSHES.find((b) => b.id === brushKind)?.label}</strong>
            </div>
          )}

          {tool === 'blur' && (
            <p style={{ fontSize: 11, fontFamily: 'Poppins, sans-serif', margin: '4px 0 0', color: '#666' }}>
              Drag to soften pixels on the active layer.
            </p>
          )}

          {tool === 'eyedropper' && (
            <p style={{ fontSize: 11, fontFamily: 'Poppins, sans-serif', margin: '4px 0 0', color: '#666' }}>
              Click anywhere on the canvas to pick a color.
            </p>
          )}

          <hr style={{ border: 'none', borderTop: '1px solid #ccc', margin: '8px 0' }} />

          {/* Smart Select status */}
          {tool === 'smart-select' && (
            <div style={{ fontSize: 11, fontFamily: 'Poppins, sans-serif', marginBottom: 6 }}>
              {useGrabCut ? (
                samActionPopup
                  ? <p style={{ margin: 0, color: '#000', fontWeight: 700 }}>Selection active. Choose an action.</p>
                  : <p style={{ margin: 0, color: '#166534' }}>Paint around the object (color-based). No AI needed.</p>
              ) : (
                <>
                  {samStatus === 'unloaded' && <p style={{ margin: 0, color: '#666' }}>Paint over the edges of the object you want to select.</p>}
                  {samStatus === 'downloading' && <p style={{ margin: 0, color: '#2563eb', fontWeight: 700 }}>Downloading AI model...</p>}
                  {samStatus === 'ready' && !samActionPopup && <p style={{ margin: 0, color: '#166534' }}>Paint over the edges of the object to select it.</p>}
                  {samStatus === 'inferring' && <p style={{ margin: 0, color: '#d97706', fontWeight: 700 }}>Analysing...</p>}
                  {samActionPopup && <p style={{ margin: 0, color: '#000', fontWeight: 700 }}>Selection active. Choose an action.</p>}
                  {modifyingMask && <p style={{ margin: 0, color: '#7c3aed', fontWeight: 700 }}>Modifying selection. Click to add, Alt/right-click to erase.</p>}
                </>
              )}
            </div>
          )}

          {/* Contextual options -- selected object vs drawing */}
          {selObj ? (
            <>
              <p style={{ ...S.label, color: '#0088ff' }}>SELECTED: {selObj.type.toUpperCase()}</p>

              {isShapeKind(selObj.type) && (
                <>
                  <label style={S.label}>Stroke color</label>
                  <input type='color' value={selObj.strokeColor ?? '#000000'}
                    onChange={(e) => updateSelectedObj({ strokeColor: e.target.value })}
                    style={{ width: '100%', height: 30, border: '2px solid #000', padding: 0, cursor: 'pointer', marginBottom: 4 }} />
                  <label style={S.label}>Stroke width: {selObj.strokeWidth ?? 2}px</label>
                  <input type='range' min={1} max={30} value={selObj.strokeWidth ?? 2}
                    onChange={(e) => updateSelectedObj({ strokeWidth: parseInt(e.target.value) })}
                    style={{ width: '100%' }} />

                  {!isLineLike(selObj.type) && (
                    <>
                      <label style={{ ...S.label, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type='checkbox'
                          checked={!!selObj.fillColor && !selObj.fillGradient?.enabled}
                          onChange={(e) => updateSelectedObj({ fillColor: e.target.checked ? (selObj.fillColor ?? '#ffffff') : null, fillGradient: undefined })}
                        />
                        Fill
                      </label>
                      {selObj.fillColor && !selObj.fillGradient?.enabled && (
                        <input type='color' value={selObj.fillColor}
                          onChange={(e) => updateSelectedObj({ fillColor: e.target.value })}
                          style={{ width: '100%', height: 30, border: '2px solid #000', padding: 0, cursor: 'pointer', marginBottom: 4 }} />
                      )}
                      <label style={{ ...S.label, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type='checkbox'
                          checked={!!selObj.fillGradient?.enabled}
                          onChange={(e) => {
                            const g: GradientFill = selObj.fillGradient
                              ? { ...selObj.fillGradient, enabled: e.target.checked }
                              : { enabled: e.target.checked, color1: '#ff6b6b', color2: '#4ecdc4', angle: 0, type: 'linear' };
                            updateSelectedObj({ fillGradient: g, fillColor: selObj.fillColor ?? '#ffffff' });
                          }}
                        />
                        Gradient fill
                      </label>
                      {selObj.fillGradient?.enabled && (
                        <div style={{ padding: 6, border: '1px solid #000', marginBottom: 4, background: '#fafafa' }}>
                          <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
                            <button style={{ ...S.smallBtn(selObj.fillGradient.type === 'linear' ? '#000' : '#fff', selObj.fillGradient.type === 'linear' ? '#fff' : '#000'), flex: 1 }}
                              onClick={() => updateSelectedObj({ fillGradient: { ...selObj.fillGradient!, type: 'linear' } })}>Linear</button>
                            <button style={{ ...S.smallBtn(selObj.fillGradient.type === 'radial' ? '#000' : '#fff', selObj.fillGradient.type === 'radial' ? '#fff' : '#000'), flex: 1 }}
                              onClick={() => updateSelectedObj({ fillGradient: { ...selObj.fillGradient!, type: 'radial' } })}>Radial</button>
                          </div>
                          <label style={{ ...S.label, fontSize: 10 }}>Start</label>
                          <input type='color' value={selObj.fillGradient.color1}
                            onChange={(e) => updateSelectedObj({ fillGradient: { ...selObj.fillGradient!, color1: e.target.value } })}
                            style={{ width: '100%', height: 22, border: '1px solid #000', padding: 0, cursor: 'pointer', marginBottom: 3 }} />
                          <label style={{ ...S.label, fontSize: 10 }}>End</label>
                          <input type='color' value={selObj.fillGradient.color2}
                            onChange={(e) => updateSelectedObj({ fillGradient: { ...selObj.fillGradient!, color2: e.target.value } })}
                            style={{ width: '100%', height: 22, border: '1px solid #000', padding: 0, cursor: 'pointer', marginBottom: 3 }} />
                          {selObj.fillGradient.type === 'linear' && (
                            <>
                              <label style={{ ...S.label, fontSize: 10 }}>Angle: {selObj.fillGradient.angle}{'\u00B0'}</label>
                              <input type='range' min={0} max={359} value={selObj.fillGradient.angle}
                                onChange={(e) => updateSelectedObj({ fillGradient: { ...selObj.fillGradient!, angle: parseInt(e.target.value) } })}
                                style={{ width: '100%' }} />
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {selObj.type === 'text' && (
                <>
                  <label style={S.label}>Font</label>
                  <select value={selObj.fontFamily ?? 'Poppins, sans-serif'}
                    onChange={(e) => {
                      const dims = measureText(selObj.text ?? '', selObj.fontSize ?? 24, e.target.value);
                      updateSelectedObj({ fontFamily: e.target.value, w: dims.w, h: dims.h });
                    }}
                    style={{ width: '100%', border: '1px solid #000', padding: '3px 4px', fontFamily: 'Poppins, sans-serif', fontSize: 11, marginBottom: 4 }}>
                    {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                  <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
                    <button
                      style={S.smallBtn(selObj.fontWeight === 'bold' ? '#000' : '#fff', selObj.fontWeight === 'bold' ? '#fff' : '#000')}
                      onClick={() => updateSelectedObj({ fontWeight: selObj.fontWeight === 'bold' ? 'normal' : 'bold' })}
                    ><strong>B</strong></button>
                    <button
                      style={S.smallBtn(selObj.fontStyle === 'italic' ? '#000' : '#fff', selObj.fontStyle === 'italic' ? '#fff' : '#000')}
                      onClick={() => updateSelectedObj({ fontStyle: selObj.fontStyle === 'italic' ? 'normal' : 'italic' })}
                    ><em>I</em></button>
                  </div>
                  <label style={S.label}>Color</label>
                  <input type='color' value={selObj.color ?? '#000000'}
                    onChange={(e) => updateSelectedObj({ color: e.target.value })}
                    style={{ width: '100%', height: 30, border: '2px solid #000', padding: 0, cursor: 'pointer', marginBottom: 4 }} />
                  <label style={S.label}>Font size: {selObj.fontSize ?? 24}px</label>
                  <input type='range' min={8} max={200} value={selObj.fontSize ?? 24}
                    onChange={(e) => {
                      const fz = parseInt(e.target.value);
                      const dims = measureText(selObj.text ?? '', fz, selObj.fontFamily);
                      updateSelectedObj({ fontSize: fz, w: dims.w, h: dims.h });
                    }}
                    style={{ width: '100%' }} />
                </>
              )}

              {selObj.type === 'image' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...S.label, marginTop: 6, cursor: 'pointer' }}>
                  <input type='checkbox' checked={selObj.lockAspect ?? false}
                    onChange={(e) => updateSelectedObj({ lockAspect: e.target.checked })} />
                  Lock aspect ratio
                </label>
              )}

              <label style={{ ...S.label, marginTop: 6 }}>Opacity: {Math.round((selObj.opacity ?? 1) * 100)}%</label>
              <input type='range' min={0} max={100} value={Math.round((selObj.opacity ?? 1) * 100)}
                onChange={(e) => updateSelectedObj({ opacity: parseInt(e.target.value) / 100 })}
                style={{ width: '100%' }} />

              <hr style={{ border: 'none', borderTop: '1px solid #ccc', margin: '8px 0' }} />
              <label style={S.label}>Rotation: {Math.round(selObj.rotation ?? 0)}{'\u00B0'}</label>
              <input type='range' min={0} max={359} value={Math.round(selObj.rotation ?? 0)}
                onChange={(e) => updateSelectedObj({ rotation: parseInt(e.target.value) })}
                style={{ width: '100%' }} />
              <div style={{ display: 'flex', gap: 3, marginBottom: 4, flexWrap: 'wrap' }}>
                {[0, 90, 180, 270].map((a) => (
                  <button key={a} style={S.smallBtn()} onClick={() => updateSelectedObj({ rotation: a })}>{a}{'\u00B0'}</button>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...S.label, cursor: 'pointer', marginBottom: 0 }}>
                <input type='checkbox' checked={snapRotation} onChange={(e) => setSnapRotation(e.target.checked)} />
                Snap to 90{'\u00B0'}
              </label>

              {(selObj.type === 'text' || isShapeKind(selObj.type) || selObj.type === 'image') && (
                <EffectsEditor
                  title='EFFECTS'
                  effects={selObj.effects}
                  onChange={(fx) => updateSelectedObj({ effects: fx })}
                />
              )}
            </>
          ) : (
            <>
              <label style={S.label}>Color</label>
              <input type='color' value={color} onChange={(e) => setColor(e.target.value)}
                style={{ width: '100%', height: 30, border: '2px solid #000', padding: 0, cursor: 'pointer', marginBottom: 4 }} />
              {/* Quick-select swatches */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6 }}>
                {SWATCHES.map((c) => (
                  <button key={c} onClick={() => setColor(c)} title={c}
                    style={{ width: 22, height: 22, background: c, border: color === c ? '3px solid #0088ff' : '2px solid #000', cursor: 'pointer', padding: 0, boxSizing: 'border-box' as const }} />
                ))}
              </div>

              <label style={{ ...S.label, marginTop: 4 }}>Size: {brushSize}px</label>
              <input type='range' min={1} max={60} value={brushSize}
                onChange={(e) => setBrushSize(parseInt(e.target.value))}
                style={{ width: '100%' }} />

              <label style={{ ...S.label, marginTop: 4 }}>Opacity: {Math.round(opacity * 100)}%</label>
              <input type='range' min={0} max={100} value={Math.round(opacity * 100)}
                onChange={(e) => setOpacity(parseInt(e.target.value) / 100)}
                style={{ width: '100%' }} />

              {tool === 'shape' && !isLineLike(shapeType) && (
                <>
                  <label style={{ ...S.label, marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type='checkbox'
                      checked={fillColor !== null}
                      onChange={(e) => {
                        const next = e.target.checked ? (fillColor ?? '#ffffff') : null;
                        setFillColor(next);
                        fillColorRef.current = next;
                      }}
                    />
                    Fill shape
                  </label>
                  {fillColor !== null && !fillGradient.enabled && (
                    <input type='color' value={fillColor}
                      onChange={(e) => { setFillColor(e.target.value); fillColorRef.current = e.target.value; }}
                      style={{ width: '100%', height: 30, border: '2px solid #000', padding: 0, cursor: 'pointer', marginBottom: 4 }} />
                  )}
                  <label style={{ ...S.label, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type='checkbox'
                      checked={fillGradient.enabled}
                      onChange={(e) => {
                        const g = { ...fillGradient, enabled: e.target.checked };
                        setFillGradient(g);
                        fillGradientRef.current = g;
                        if (e.target.checked && fillColor === null) {
                          setFillColor('#ffffff');
                          fillColorRef.current = '#ffffff';
                        }
                      }}
                    />
                    Gradient
                  </label>
                  {fillGradient.enabled && (
                    <div style={{ padding: 6, border: '1px solid #000', marginBottom: 4, background: '#fafafa' }}>
                      <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
                        <button
                          style={{ ...S.smallBtn(fillGradient.type === 'linear' ? '#000' : '#fff', fillGradient.type === 'linear' ? '#fff' : '#000'), flex: 1 }}
                          onClick={() => { const g = { ...fillGradient, type: 'linear' as const }; setFillGradient(g); fillGradientRef.current = g; }}
                        >Linear</button>
                        <button
                          style={{ ...S.smallBtn(fillGradient.type === 'radial' ? '#000' : '#fff', fillGradient.type === 'radial' ? '#fff' : '#000'), flex: 1 }}
                          onClick={() => { const g = { ...fillGradient, type: 'radial' as const }; setFillGradient(g); fillGradientRef.current = g; }}
                        >Radial</button>
                      </div>
                      <label style={{ ...S.label, fontSize: 10 }}>Start</label>
                      <input type='color' value={fillGradient.color1}
                        onChange={(e) => { const g = { ...fillGradient, color1: e.target.value }; setFillGradient(g); fillGradientRef.current = g; }}
                        style={{ width: '100%', height: 22, border: '1px solid #000', padding: 0, cursor: 'pointer', marginBottom: 3 }} />
                      <label style={{ ...S.label, fontSize: 10 }}>End</label>
                      <input type='color' value={fillGradient.color2}
                        onChange={(e) => { const g = { ...fillGradient, color2: e.target.value }; setFillGradient(g); fillGradientRef.current = g; }}
                        style={{ width: '100%', height: 22, border: '1px solid #000', padding: 0, cursor: 'pointer', marginBottom: 3 }} />
                      {fillGradient.type === 'linear' && (
                        <>
                          <label style={{ ...S.label, fontSize: 10 }}>Angle: {fillGradient.angle}{'\u00B0'}</label>
                          <input type='range' min={0} max={359} value={fillGradient.angle}
                            onChange={(e) => { const g = { ...fillGradient, angle: parseInt(e.target.value) }; setFillGradient(g); fillGradientRef.current = g; }}
                            style={{ width: '100%' }} />
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              {tool === 'text' && (
                <>
                  <hr style={{ border: 'none', borderTop: '1px solid #ccc', margin: '8px 0' }} />
                  <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 11, color: '#555', margin: '0 0 6px' }}>Click on the canvas to place text, then type.</p>
                  <label style={S.label}>Font</label>
                  <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}
                    style={{ width: '100%', border: '1px solid #000', padding: '3px 4px', fontFamily: 'Poppins, sans-serif', fontSize: 11, marginBottom: 4 }}>
                    {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                  <label style={S.label}>Font size: {fontSize}px</label>
                  <input type='range' min={8} max={200} value={fontSize}
                    onChange={(e) => setFontSize(parseInt(e.target.value))}
                    style={{ width: '100%', marginBottom: 6 }} />
                </>
              )}
            </>
          )}
        </div>

        {/* -- Center: canvas -- */}
        <div ref={canvasContainerRef} style={{ overflow: 'auto', maxHeight: fullPage ? '100%' : '78vh', ...(fullPage ? { height: '100%', background: '#e5e5e5' } : {}) }}>
          <div style={{ width: 'fit-content', margin: '0 auto', border: '3px solid #000', boxShadow: fullPage ? 'none' : '5px 5px 0 #000', lineHeight: 0 }}>
          <div style={{ width: docW * zoom, height: docH * zoom, position: 'relative' }}>
            {/* Display (composite) */}
            <canvas ref={displayRef} width={docW} height={docH}
              style={{ display: 'block', width: '100%', height: '100%', pointerEvents: 'none' }} />
            {/* Overlay (events, selection, preview) */}
            <canvas ref={overlayRef} width={docW} height={docH}
              style={{ display: 'block', width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, cursor: modifyingMask ? 'none' : tool === 'text' ? 'text' : tool === 'select' ? 'default' : tool === 'smart-select' ? (samStatus === 'inferring' || samStatus === 'downloading' ? 'wait' : 'cell') : 'crosshair' }}
              onMouseDown={onMouseDown}
              onDoubleClick={(e) => {
                if (toolRef.current !== 'select') return;
                const pos = getPos(e);
                const hit = [...objectsRef.current].reverse().find((o) => o.type === 'text' && hitTest(o, pos.x, pos.y));
                if (hit) {
                  e.preventDefault();
                  startTextEditing(hit.id);
                }
              }}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onContextMenu={(e) => { if (modifyingMaskRef.current) e.preventDefault(); }}
              onMouseLeave={(e) => {
                cursorPos.current = null;
                // In mask modify mode, just stop drawing but keep state
                if (modifyingMaskRef.current) {
                  drawing.current = false;
                  renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
                  return;
                }
                // For smart-select, don't end stroke on leave — let user come back on
                if (toolRef.current === 'smart-select' && drawing.current) {
                  const rect = overlayRef.current!.getBoundingClientRect();
                  const scaleX = docWRef.current / rect.width;
                  const scaleY = docHRef.current / rect.height;
                  const cx = Math.max(0, Math.min(docWRef.current, (e.clientX - rect.left) * scaleX));
                  const cy = Math.max(0, Math.min(docHRef.current, (e.clientY - rect.top) * scaleY));
                  samStrokeRef.current.push({ x: cx, y: cy });
                  renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
                  return;
                }
                if (drawing.current) {
                  drawing.current = false;
                  dragMode.current = null;
                  renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
                } else {
                  renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
                }
              }}
              onMouseEnter={(e) => {
                // Resume mask modify drawing when mouse re-enters canvas
                if (modifyingMaskRef.current && (e.buttons & 1)) {
                  drawing.current = true;
                }
                // Resume smart-select stroke when mouse re-enters canvas
                if (toolRef.current === 'smart-select' && samStrokeRef.current.length > 0 && (e.buttons & 1)) {
                  drawing.current = true;
                  const rect = overlayRef.current!.getBoundingClientRect();
                  const scaleX = docWRef.current / rect.width;
                  const scaleY = docHRef.current / rect.height;
                  const cx = Math.max(0, Math.min(docWRef.current, (e.clientX - rect.left) * scaleX));
                  const cy = Math.max(0, Math.min(docHRef.current, (e.clientY - rect.top) * scaleY));
                  samStrokeRef.current.push({ x: cx, y: cy });
                }
              }}
            />
          </div>
          </div>
        </div>

        {/* -- Right: layers panel -- */}
        <div style={{ ...S.panel, ...(fullPage ? { border: 'none', borderLeft: '2px solid #000', height: '100%', overflow: 'auto' } : {}) }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <p style={S.label}>LAYERS</p>
            <button style={S.smallBtn('#000', '#fff')} onClick={addLayer}>+ Add</button>
          </div>

          {[...layers].reverse().map((layer) => (
            <div
              key={layer.id}
              onClick={() => setActiveLayerId(layer.id)}
              style={{ border: `2px solid ${activeLayerId === layer.id ? '#000' : '#ccc'}`, background: activeLayerId === layer.id ? '#f0f0f0' : '#fff', padding: '6px 8px', marginBottom: 4, cursor: 'pointer' }}
            >
              {/* Top row: controls + square thumbnail */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
                {/* Left: name + buttons */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 3 }}>
                    <button
                      style={{ ...S.smallBtn(layer.visible ? '#000' : '#eee', layer.visible ? '#fff' : '#000'), fontSize: 10, padding: '1px 4px' }}
                      onClick={(e) => { e.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }}
                    >
                      {layer.visible ? '\uD83D\uDC41' : '\u25CB'}
                    </button>
                    <input
                      value={layer.name}
                      onChange={(e) => updateLayer(layer.id, { name: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      style={{ border: 'none', background: 'transparent', fontSize: 11, fontFamily: 'Poppins, sans-serif', fontWeight: 700, flex: 1, minWidth: 0, padding: 0 }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 3 }}>
                    <button style={S.smallBtn()} onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, 1); }}>{'\u2191'}</button>
                    <button style={S.smallBtn()} onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, -1); }}>{'\u2193'}</button>
                    <button style={S.smallBtn('#f44', '#fff')} onClick={(e) => { e.stopPropagation(); deleteLayer(layer.id); }}>{'\u2715'}</button>
                  </div>
                </div>
                {/* Right: square thumbnail with hover popup */}
                <div
                  style={{ position: 'relative', flexShrink: 0 }}
                  onMouseEnter={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    hoverTimerRef.current = setTimeout(() => {
                      setThumbPopup({ layerId: layer.id, x: rect.left, y: rect.top });
                    }, 500);
                  }}
                  onMouseLeave={() => {
                    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
                    setThumbPopup(null);
                  }}
                >
                  <canvas
                    ref={(el) => { if (el) thumbnailRefs.current.set(layer.id, el); else thumbnailRefs.current.delete(layer.id); }}
                    style={{ display: 'block', width: 40, height: 40, border: '1px solid #ccc' }}
                  />
                </div>
              </div>
              <div style={{ marginTop: 4 }}>
                <label style={{ ...S.label, fontSize: 9 }}>Opacity: {Math.round(layer.opacity * 100)}%</label>
                <input type='range' min={0} max={100} value={Math.round(layer.opacity * 100)}
                  onChange={(e) => { e.stopPropagation(); updateLayer(layer.id, { opacity: parseInt(e.target.value) / 100 }); }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: '100%' }} />
              </div>
              <div style={{ marginTop: 4 }}>
                <label style={{ ...S.label, fontSize: 9 }}>Blend</label>
                <select
                  value={layer.blendMode}
                  onChange={(e) => { updateLayer(layer.id, { blendMode: e.target.value as BlendMode }); }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: '100%', border: '1px solid #000', fontSize: 10, fontFamily: 'Poppins, sans-serif' }}
                >
                  {BLENDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                <button
                  style={{ ...S.smallBtn(expandedFxLayer === layer.id ? '#000' : '#fff', expandedFxLayer === layer.id ? '#fff' : '#000'), width: '100%', fontSize: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  onClick={() => setExpandedFxLayer((id) => id === layer.id ? null : layer.id)}
                >
                  <span>FX {hasEffects(layer.effects) ? '\u2713' : ''}</span>
                  <span style={{ opacity: 0.6 }}>{expandedFxLayer === layer.id ? '\u25BE' : '\u25B8'}</span>
                </button>
                {expandedFxLayer === layer.id && (
                  <EffectsEditor
                    title='LAYER EFFECTS'
                    effects={layer.effects}
                    onChange={(fx) => updateLayer(layer.id, { effects: fx })}
                  />
                )}
              </div>
            </div>
          ))}

          {/* Thumbnail hover popup */}
          {thumbPopup && (
            <div
              style={{
                position: 'fixed',
                top: thumbPopup.y,
                left: thumbPopup.x - 248,
                zIndex: 9999,
                border: '2px solid #000',
                boxShadow: '4px 4px 0 #000',
                background: '#fff',
                pointerEvents: 'none',
              }}
            >
              <canvas
                ref={popupCanvasRef}
                style={{ display: 'block', width: 240, height: 160 }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
