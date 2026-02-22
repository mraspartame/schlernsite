import { useState, useRef, useEffect, useCallback } from 'react';

// ── Constants ─────────────────────────────────────────────────────────────────

const W = 900, H = 600;
const HANDLE_R = 8;   // hit radius for resize handles (px)
const HANDLE_SZ = 8;  // visual size of handles (px)

// ── Types ─────────────────────────────────────────────────────────────────────

type Tool = 'select' | 'pencil' | 'eraser' | 'fill' | 'line' | 'rect' | 'ellipse' | 'text' | 'crop';
type BlendMode = 'source-over' | 'multiply' | 'screen' | 'overlay';
type HandlePos = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
}

// Moveable objects (shapes, text, images)
type ObjType = 'rect' | 'ellipse' | 'line' | 'text' | 'image';

interface PaintObj {
  id: string;
  layerId: string;
  type: ObjType;
  x: number; y: number; w: number; h: number;
  opacity: number;
  // shape
  strokeColor?: string;
  strokeWidth?: number;
  // text
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  // image
  src?: string;
  lockAspect?: boolean;  // maintain aspect ratio on resize
  naturalAr?: number;    // natural w/h ratio
  rotation?: number;     // degrees (0 = upright)
}

// ── Pure utility functions (outside component) ────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 7);

/** Bounding box for display/hit-testing (lines have signed w,h for direction) */
function getDisplayBounds(o: PaintObj) {
  if (o.type === 'line') {
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
  if (o.type === 'line') {
    const d = ptSegDist(lx, ly, o.x, o.y, o.x + o.w, o.y + o.h);
    return d < (o.strokeWidth ?? 2) / 2 + 6;
  }
  const { x, y, w, h } = getDisplayBounds(o);
  return lx >= x - 4 && lx <= x + w + 4 && ly >= y - 4 && ly <= y + h + 4;
}

function getHandles(o: PaintObj): { pos: HandlePos; x: number; y: number }[] {
  if (o.type === 'line') {
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
  if (o.type === 'line') {
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
  if (o.type === 'line') return o;
  const r = { ...o };
  if (r.w < 0) { r.x += r.w; r.w = -r.w; }
  if (r.h < 0) { r.y += r.h; r.h = -r.h; }
  return r;
}

function measureText(text: string, fontSize: number, fontFamily = 'Poppins, sans-serif'): { w: number; h: number } {
  const c = document.createElement('canvas').getContext('2d')!;
  c.font = `${fontSize}px ${fontFamily}`;
  return { w: Math.ceil(c.measureText(text).width), h: Math.ceil(fontSize * 1.4) };
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

function drawObj(ctx: CanvasRenderingContext2D, o: PaintObj, imgCache: Map<string, HTMLImageElement>) {
  ctx.save();
  ctx.globalAlpha = o.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Apply rotation around the object's center
  const rot = o.rotation ?? 0;
  if (rot !== 0) {
    const { x, y, w, h } = getDisplayBounds(o);
    const cx = x + w / 2, cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(toRad(rot));
    ctx.translate(-cx, -cy);
  }

  switch (o.type) {
    case 'rect':
      ctx.strokeStyle = o.strokeColor ?? '#000';
      ctx.lineWidth = o.strokeWidth ?? 2;
      ctx.beginPath();
      ctx.rect(o.x, o.y, o.w, o.h);
      ctx.stroke();
      break;
    case 'ellipse':
      ctx.strokeStyle = o.strokeColor ?? '#000';
      ctx.lineWidth = o.strokeWidth ?? 2;
      ctx.beginPath();
      ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.abs(o.w / 2), Math.abs(o.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'line':
      ctx.strokeStyle = o.strokeColor ?? '#000';
      ctx.lineWidth = o.strokeWidth ?? 2;
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(o.x + o.w, o.y + o.h);
      ctx.stroke();
      break;
    case 'text':
      ctx.fillStyle = o.color ?? '#000';
      ctx.font = `${o.fontSize ?? 24}px ${o.fontFamily ?? 'Poppins, sans-serif'}`;
      ctx.textBaseline = 'top';
      ctx.fillText(o.text ?? '', o.x, o.y);
      break;
    case 'image': {
      const img = imgCache.get(o.src ?? '');
      if (img) ctx.drawImage(img, o.x, o.y, o.w, o.h);
      break;
    }
  }
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
  const CW = readCtx.canvas.width, CH = readCtx.canvas.height;
  const readImg = readCtx.getImageData(0, 0, CW, CH);
  const writeImg = writeCtx.getImageData(0, 0, CW, CH);
  const rd = readImg.data, wd = writeImg.data;

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
  const matches = (i: number) =>
    Math.abs(rd[i] - tr) <= TOL &&
    Math.abs(rd[i + 1] - tg) <= TOL &&
    Math.abs(rd[i + 2] - tb) <= TOL &&
    Math.abs(rd[i + 3] - ta) <= TOL;

  const visited = new Uint8Array(CW * CH);
  const stack = [i0];

  while (stack.length) {
    const i = stack.pop()!;
    const pi = i >> 2;
    if (visited[pi] || !matches(i)) continue;
    visited[pi] = 1;
    wd[i] = fr; wd[i + 1] = fg; wd[i + 2] = fb; wd[i + 3] = fa;
    const x = pi % CW, y = Math.floor(pi / CW);
    if (x > 0) stack.push(i - 4);
    if (x < CW - 1) stack.push(i + 4);
    if (y > 0) stack.push(i - CW * 4);
    if (y < CH - 1) stack.push(i + CW * 4);
  }
  writeCtx.putImageData(writeImg, 0, 0);
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function PaintEditor() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [layers, setLayers] = useState<Layer[]>([]);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [objects, setObjects] = useState<PaintObj[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(4);
  const [opacity, setOpacity] = useState(1);
  const [textInput, setTextInput] = useState('Hello');
  const [fontSize, setFontSize] = useState(24);
  const [fontFamily, setFontFamily] = useState('Poppins, sans-serif');
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [snapRotation, setSnapRotation] = useState(true);

  // ── Refs (always-fresh values for event callbacks) ─────────────────────────
  const layersRef = useRef(layers);           layersRef.current = layers;
  const objectsRef = useRef(objects);         objectsRef.current = objects;
  const selectedIdRef = useRef(selectedId);   selectedIdRef.current = selectedId;
  const toolRef = useRef(tool);               toolRef.current = tool;
  const colorRef = useRef(color);             colorRef.current = color;
  const brushSizeRef = useRef(brushSize);     brushSizeRef.current = brushSize;
  const opacityRef = useRef(opacity);         opacityRef.current = opacity;
  const textInputRef = useRef(textInput);     textInputRef.current = textInput;
  const fontSizeRef = useRef(fontSize);       fontSizeRef.current = fontSize;
  const fontFamilyRef = useRef(fontFamily);   fontFamilyRef.current = fontFamily;
  const activeLayerRef = useRef(activeLayerId); activeLayerRef.current = activeLayerId;

  // ── Canvas refs ────────────────────────────────────────────────────────────
  const displayRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  /** Per-layer raster pixel canvas (pencil / eraser / fill) */
  const pixelCanvases = useRef<Map<string, HTMLCanvasElement>>(new Map());
  /** Per-layer temp canvas for compositing pixels + objects */
  const tempCanvases = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const imageCache = useRef<Map<string, HTMLImageElement>>(new Map());

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
  const history = useRef<{ pixels: { id: string; data: ImageData }[]; objects: PaintObj[] }[]>([]);
  const histIdx = useRef(-1);

  // ── Rendering ──────────────────────────────────────────────────────────────

  function getTempCanvas(layerId: string): HTMLCanvasElement {
    if (!tempCanvases.current.has(layerId)) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      tempCanvases.current.set(layerId, c);
    }
    return tempCanvases.current.get(layerId)!;
  }

  const renderAll = useCallback((
    currentLayers: Layer[],
    currentObjects: PaintObj[],
    currentSelectedId: string | null,
    previewShape?: { type: ObjType; x: number; y: number; w: number; h: number } | null,
  ) => {
    if (!displayRef.current || !overlayRef.current) return;
    const display = displayRef.current.getContext('2d')!;
    const overlay = overlayRef.current.getContext('2d')!;

    // Composite layers onto display
    display.clearRect(0, 0, W, H);
    display.fillStyle = '#fff';
    display.fillRect(0, 0, W, H);

    for (const layer of currentLayers) {
      if (!layer.visible) continue;
      const pc = pixelCanvases.current.get(layer.id);
      if (!pc) continue;

      const tc = getTempCanvas(layer.id);
      const tcCtx = tc.getContext('2d')!;
      tcCtx.clearRect(0, 0, W, H);
      tcCtx.drawImage(pc, 0, 0);
      currentObjects
        .filter((o) => o.layerId === layer.id)
        .forEach((o) => drawObj(tcCtx, o, imageCache.current));

      display.globalAlpha = layer.opacity;
      display.globalCompositeOperation = layer.blendMode;
      display.drawImage(tc, 0, 0);
      display.globalAlpha = 1;
      display.globalCompositeOperation = 'source-over';
    }

    // Overlay: selection handles + shape/text preview
    overlay.clearRect(0, 0, W, H);

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

        // Rotation handle — stem line then circle, 30px above top-center in local space
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
    if (previewShape) {
      overlay.save();
      overlay.strokeStyle = colorRef.current;
      overlay.lineWidth = brushSizeRef.current;
      overlay.globalAlpha = opacityRef.current;
      overlay.lineCap = 'round';
      overlay.setLineDash([4, 4]);
      const { type, x, y, w, h } = previewShape;
      if (type === 'rect') {
        overlay.beginPath();
        overlay.rect(x, y, w, h);
        overlay.stroke();
      } else if (type === 'ellipse') {
        overlay.beginPath();
        overlay.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        overlay.stroke();
      } else if (type === 'line') {
        overlay.beginPath();
        overlay.moveTo(x, y);
        overlay.lineTo(x + w, y + h);
        overlay.stroke();
      }
      overlay.restore();
    }

    // Text cursor preview
    if (toolRef.current === 'text' && cursorPos.current) {
      const { x, y } = cursorPos.current;
      const fSize = fontSizeRef.current;
      const txt = textInputRef.current || 'Click to place text';
      overlay.save();
      overlay.globalAlpha = 0.5;
      overlay.fillStyle = colorRef.current;
      overlay.font = `${fSize}px ${fontFamilyRef.current}`;
      overlay.textBaseline = 'top';
      overlay.fillText(txt, x, y);
      overlay.restore();
    }

    // Crop rect overlay
    if (cropRectRef.current) {
      const { x, y, w, h } = cropRectRef.current;
      overlay.save();
      overlay.fillStyle = 'rgba(0,0,0,0.45)';
      overlay.fillRect(0, 0, W, y);
      overlay.fillRect(0, y + h, W, H - y - h);
      overlay.fillRect(0, y, x, h);
      overlay.fillRect(x + w, y, W - x - w, h);
      overlay.strokeStyle = '#fff';
      overlay.lineWidth = 1.5;
      overlay.setLineDash([5, 4]);
      overlay.strokeRect(x, y, w, h);
      overlay.setLineDash([]);
      overlay.restore();
    }
  }, []);

  // ── History ────────────────────────────────────────────────────────────────

  function saveHistory() {
    const pixels = Array.from(pixelCanvases.current.entries()).map(([id, c]) => ({
      id,
      data: c.getContext('2d')!.getImageData(0, 0, W, H),
    }));
    const snap = { pixels, objects: [...objectsRef.current] };
    history.current = history.current.slice(0, histIdx.current + 1);
    history.current.push(snap);
    histIdx.current++;
  }

  function applyHistoryEntry(entry: typeof history.current[0]) {
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

  // ── Pointer → canvas coords ────────────────────────────────────────────────

  function getPos(e: React.MouseEvent | MouseEvent): { x: number; y: number } {
    const rect = overlayRef.current!.getBoundingClientRect();
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    return {
      x: ((e as MouseEvent).clientX - rect.left) * scaleX,
      y: ((e as MouseEvent).clientY - rect.top) * scaleY,
    };
  }

  /** Get the composite of all layers up to (and including) targetLayerId, for flood fill reading */
  function getCompositeCtx(targetLayerId: string): CanvasRenderingContext2D {
    const tc = getTempCanvas('__fill_composite__');
    if (!tempCanvases.current.has('__fill_composite__')) {
      tc.width = W; tc.height = H;
      tempCanvases.current.set('__fill_composite__', tc);
    }
    const ctx = tc.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    for (const layer of layersRef.current) {
      if (!layer.visible) continue;
      const pc = pixelCanvases.current.get(layer.id);
      if (pc) {
        ctx.drawImage(pc, 0, 0);
        objectsRef.current
          .filter((o) => o.layerId === layer.id)
          .forEach((o) => drawObj(ctx, o, imageCache.current));
      }
      if (layer.id === targetLayerId) break;
    }
    return ctx;
  }

  // ── Mouse event handlers ───────────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = getPos(e);
    const t = toolRef.current;
    const al = activeLayerRef.current;
    drawing.current = true;
    startPos.current = pos;
    lastPos.current = pos;

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

    if (!al) return;
    const pc = pixelCanvases.current.get(al);
    if (!pc) return;
    const ctx = pc.getContext('2d')!;

    if (t === 'fill') {
      saveHistory();
      const compCtx = getCompositeCtx(al);
      floodFill(compCtx, ctx, pos.x, pos.y, colorRef.current, opacityRef.current);
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      drawing.current = false;
      return;
    }

    if (t === 'text') {
      const fSize = fontSizeRef.current;
      const ff = fontFamilyRef.current;
      const txt = textInputRef.current || 'Text';
      const dims = measureText(txt, fSize, ff);
      saveHistory();
      const newObj: PaintObj = {
        id: uid(), layerId: al, type: 'text',
        x: pos.x, y: pos.y, w: dims.w, h: dims.h,
        opacity: opacityRef.current,
        text: txt, fontSize: fSize, fontFamily: ff, color: colorRef.current,
      };
      const next = [...objectsRef.current, newObj];
      objectsRef.current = next;
      setObjects(next);
      setSelectedId(newObj.id);
      selectedIdRef.current = newObj.id;
      setTool('select');
      toolRef.current = 'select';
      renderAll(layersRef.current, next, newObj.id);
      drawing.current = false;
      return;
    }

    if (t === 'pencil' || t === 'eraser') {
      saveHistory();
      strokePoints.current = [pos];
      ctx.globalAlpha = opacityRef.current;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = t === 'eraser' ? brushSizeRef.current * 3 : brushSizeRef.current;
      ctx.globalCompositeOperation = t === 'eraser' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = colorRef.current;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.lineTo(pos.x + 0.1, pos.y + 0.1);
      ctx.stroke();
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
      return;
    }

    // Shape creation begins — save snapshot for live preview
    if (t === 'line' || t === 'rect' || t === 'ellipse') {
      saveHistory();
      pixelSnapshot.current = pc.getContext('2d')!.getImageData(0, 0, W, H);
    }
  }, [renderAll]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = getPos(e);
    const t = toolRef.current;

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

      // Rotation drag — computed from angle to object center
      if (dragMode.current === 'rotate' && dragOrigObj.current) {
        const orig = dragOrigObj.current;
        const { x, y, w, h } = getDisplayBounds(orig);
        const cx = x + w / 2, cy = y + h / 2;
        const angle = Math.atan2(pos.y - cy, pos.x - cx);
        const delta = (angle - dragStartAngle.current) * 180 / Math.PI;
        let newRot = ((dragStartRotation.current + delta) % 360 + 360) % 360;
        // Snap within 8° of any 90° multiple
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
      strokePoints.current.push(pos);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
    } else if ((t === 'line' || t === 'rect' || t === 'ellipse') && startPos.current) {
      const x = startPos.current.x;
      const y = startPos.current.y;
      const w = pos.x - x;
      const h = pos.y - y;
      renderAll(layersRef.current, objectsRef.current, selectedIdRef.current, { type: t, x, y, w, h });
    }
    lastPos.current = pos;
  }, [renderAll]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!drawing.current) return;
    drawing.current = false;
    const pos = getPos(e);
    const t = toolRef.current;
    const al = activeLayerRef.current;

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

    if (!al) return;
    const pc = pixelCanvases.current.get(al);
    if (!pc) return;
    const ctx = pc.getContext('2d')!;

    if (t === 'pencil' || t === 'eraser') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    if ((t === 'line' || t === 'rect' || t === 'ellipse') && startPos.current) {
      const x = startPos.current.x;
      const y = startPos.current.y;
      let w = pos.x - x;
      let h = pos.y - y;

      if (Math.abs(w) < 3 && Math.abs(h) < 3) {
        pixelSnapshot.current = null;
        renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
        return;
      }

      const newObj: PaintObj = {
        id: uid(), layerId: al, type: t,
        x, y, w, h,
        opacity: opacityRef.current,
        strokeColor: colorRef.current,
        strokeWidth: brushSizeRef.current,
      };
      const next = normBounds(newObj.type === 'line' ? newObj : newObj);
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
    c.width = W; c.height = H;
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

  // ── Import image as object ─────────────────────────────────────────────────

  const importImage = useCallback((file: File) => {
    if (!activeLayerRef.current) return;
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imageCache.current.set(src, img);
      const scale = Math.min(1, W / img.naturalWidth, H / img.naturalHeight);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const x = Math.round((W - w) / 2);
      const y = Math.round((H - h) / 2);
      saveHistory();
      const newObj: PaintObj = {
        id: uid(), layerId: activeLayerRef.current!, type: 'image',
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

  // ── Crop ────────────────────────────────────────────────────────────────────

  const applyCrop = useCallback((rect: { x: number; y: number; w: number; h: number }) => {
    saveHistory();
    const ix = Math.max(0, Math.round(rect.x));
    const iy = Math.max(0, Math.round(rect.y));
    const iw = Math.min(W - ix, Math.round(rect.w));
    const ih = Math.min(H - iy, Math.round(rect.h));
    // Shift pixel canvas content so crop top-left becomes (0,0)
    pixelCanvases.current.forEach((pc) => {
      const ctx = pc.getContext('2d')!;
      const data = ctx.getImageData(ix, iy, iw, ih);
      ctx.clearRect(0, 0, W, H);
      ctx.putImageData(data, 0, 0);
    });
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
    const id = uid();
    const pc = makePixelCanvas();
    pc.getContext('2d')!.fillStyle = '#ffffff';
    pc.getContext('2d')!.fillRect(0, 0, W, H);
    pixelCanvases.current.set(id, pc);
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
    const pc = makePixelCanvas();
    const pCtx = pc.getContext('2d')!;
    pCtx.fillStyle = '#ffffff';
    pCtx.fillRect(0, 0, W, H);
    pixelCanvases.current.set(id, pc);
    const layer: Layer = { id, name: 'Layer 1', visible: true, opacity: 1, blendMode: 'source-over' };
    setLayers([layer]);
    setActiveLayerId(id);
    saveHistory();
  }, []);

  useEffect(() => {
    renderAll(layers, objects, selectedId);
  }, [layers, objects, selectedId, renderAll]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }
      if (e.key === 'Escape') { setSelectedId(null); selectedIdRef.current = null; renderAll(layersRef.current, objectsRef.current, null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelected, undo, redo, renderAll]);

  // ── Selected object for sidebar display ────────────────────────────────────

  const selObj = objects.find((o) => o.id === selectedId) ?? null;

  const FONTS = [
    { label: 'Poppins', value: 'Poppins, sans-serif' },
    { label: 'DM Serif Text', value: 'DM Serif Text, serif' },
    { label: 'Monospace', value: 'monospace' },
  ];

  const SWATCHES = ['#000000', '#ffffff', '#2563eb', '#16a34a', '#dc2626', '#9333ea'];

  const TOOLS: { id: Tool; label: string; icon: string }[] = [
    { id: 'select', label: 'Select', icon: '↖' },
    { id: 'pencil', label: 'Pencil', icon: '✏️' },
    { id: 'eraser', label: 'Eraser', icon: '🧹' },
    { id: 'fill', label: 'Fill', icon: '🪣' },
    { id: 'line', label: 'Line', icon: '╱' },
    { id: 'rect', label: 'Rect', icon: '▭' },
    { id: 'ellipse', label: 'Ellipse', icon: '◯' },
    { id: 'text', label: 'Text', icon: 'T' },
    { id: 'crop', label: 'Crop', icon: '✂' },
  ];

  const BLENDS: BlendMode[] = ['source-over', 'multiply', 'screen', 'overlay'];

  // ── JSX ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 1340, margin: '0 auto' }}>
      {/* Top bar */}
      <div style={{ border: '3px solid #000', background: '#fff', padding: '8px 12px', marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', boxShadow: '4px 4px 0 #000' }}>
        <strong style={{ fontFamily: 'DM Serif Text, serif', fontSize: 20 }}>🖌️ Paint</strong>
        <button style={S.smallBtn()} onClick={newCanvas}>New</button>
        <label style={{ ...S.smallBtn(), cursor: 'pointer' }}>
          Add image
          <input type='file' accept='image/*' style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && importImage(e.target.files[0])} />
        </label>
        <button style={S.smallBtn()} onClick={exportPng}>⬇ PNG</button>
        <span style={{ width: 1, background: '#000', height: 20, display: 'inline-block', margin: '0 4px' }} />
        <button style={S.smallBtn()} onClick={undo} title='Ctrl+Z'>↩ Undo</button>
        <button style={S.smallBtn()} onClick={redo} title='Ctrl+Y'>↪ Redo</button>
        {selectedId && (
          <button style={S.smallBtn('#f44', '#fff')} onClick={deleteSelected}>
            ✕ Delete selected
          </button>
        )}
        {selectedId && (
          <button style={S.smallBtn()} onClick={cropToSelection} title='Crop canvas to bounding box of selected object'>
            ✂ Crop to Selection
          </button>
        )}
        {cropRect && (
          <>
            <button style={S.smallBtn('#0a0', '#fff')} onClick={() => applyCrop(cropRect)}>✓ Apply Crop</button>
            <button style={S.smallBtn()} onClick={() => {
              cropRectRef.current = null;
              setCropRect(null);
              renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
            }}>✕ Cancel</button>
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '158px 1fr 192px', gap: 8, alignItems: 'start' }}>

        {/* ── Left panel: tools + drawing options ─────────────────────────── */}
        <div style={{ ...S.panel, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <p style={{ ...S.label, marginBottom: 6 }}>TOOLS</p>
          {TOOLS.map((t) => (
            <button key={t.id} style={S.toolBtn(tool === t.id)} onClick={() => {
              setTool(t.id);
              if (t.id !== 'text') cursorPos.current = null;
              renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
            }}>
              {t.icon} {t.label}
            </button>
          ))}

          <hr style={{ border: 'none', borderTop: '1px solid #ccc', margin: '8px 0' }} />

          {/* Contextual options — selected object vs drawing */}
          {selObj ? (
            <>
              <p style={{ ...S.label, color: '#0088ff' }}>SELECTED: {selObj.type.toUpperCase()}</p>

              {(selObj.type === 'rect' || selObj.type === 'ellipse' || selObj.type === 'line') && (
                <>
                  <label style={S.label}>Stroke color</label>
                  <input type='color' value={selObj.strokeColor ?? '#000000'}
                    onChange={(e) => updateSelectedObj({ strokeColor: e.target.value })}
                    style={{ width: '100%', height: 30, border: '2px solid #000', padding: 0, cursor: 'pointer', marginBottom: 4 }} />
                  <label style={S.label}>Stroke width: {selObj.strokeWidth ?? 2}px</label>
                  <input type='range' min={1} max={30} value={selObj.strokeWidth ?? 2}
                    onChange={(e) => updateSelectedObj({ strokeWidth: parseInt(e.target.value) })}
                    style={{ width: '100%' }} />
                </>
              )}

              {selObj.type === 'text' && (
                <>
                  <label style={S.label}>Text</label>
                  <input style={S.input} value={selObj.text ?? ''}
                    onChange={(e) => {
                      const dims = measureText(e.target.value, selObj.fontSize ?? 24, selObj.fontFamily);
                      updateSelectedObj({ text: e.target.value, w: dims.w, h: dims.h });
                    }} />
                  <label style={S.label}>Font</label>
                  <select value={selObj.fontFamily ?? 'Poppins, sans-serif'}
                    onChange={(e) => {
                      const dims = measureText(selObj.text ?? '', selObj.fontSize ?? 24, e.target.value);
                      updateSelectedObj({ fontFamily: e.target.value, w: dims.w, h: dims.h });
                    }}
                    style={{ width: '100%', border: '1px solid #000', padding: '3px 4px', fontFamily: 'Poppins, sans-serif', fontSize: 11, marginBottom: 4 }}>
                    {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
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
              <label style={S.label}>Rotation: {Math.round(selObj.rotation ?? 0)}°</label>
              <input type='range' min={0} max={359} value={Math.round(selObj.rotation ?? 0)}
                onChange={(e) => updateSelectedObj({ rotation: parseInt(e.target.value) })}
                style={{ width: '100%' }} />
              <div style={{ display: 'flex', gap: 3, marginBottom: 4, flexWrap: 'wrap' }}>
                {[0, 90, 180, 270].map((a) => (
                  <button key={a} style={S.smallBtn()} onClick={() => updateSelectedObj({ rotation: a })}>{a}°</button>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...S.label, cursor: 'pointer', marginBottom: 0 }}>
                <input type='checkbox' checked={snapRotation} onChange={(e) => setSnapRotation(e.target.checked)} />
                Snap to 90°
              </label>
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

              {tool === 'text' && (
                <>
                  <hr style={{ border: 'none', borderTop: '1px solid #ccc', margin: '8px 0' }} />
                  <label style={S.label}>Text to place</label>
                  <input style={S.input} value={textInput} onChange={(e) => setTextInput(e.target.value)} placeholder='Enter text…' />
                  <label style={S.label}>Font</label>
                  <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}
                    style={{ width: '100%', border: '1px solid #000', padding: '3px 4px', fontFamily: 'Poppins, sans-serif', fontSize: 11, marginBottom: 4 }}>
                    {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                  <label style={S.label}>Font size: {fontSize}px</label>
                  <input type='range' min={8} max={200} value={fontSize}
                    onChange={(e) => setFontSize(parseInt(e.target.value))}
                    style={{ width: '100%', marginBottom: 6 }} />
                  {/* Live font preview */}
                  <div style={{ border: '1px dashed #999', padding: 6, background: '#fafafa', minHeight: 40, overflow: 'hidden' }}>
                    <span style={{ fontFamily, fontSize: Math.min(fontSize, 48), color, lineHeight: 1.2, display: 'block', whiteSpace: 'pre' }}>
                      {textInput || 'Preview'}
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* ── Center: canvas ───────────────────────────────────────────────── */}
        <div style={{ position: 'relative', lineHeight: 0, border: '3px solid #000', boxShadow: '5px 5px 0 #000' }}>
          {/* Display (composite) */}
          <canvas ref={displayRef} width={W} height={H}
            style={{ display: 'block', width: '100%', pointerEvents: 'none' }} />
          {/* Overlay (events, selection, preview) */}
          <canvas ref={overlayRef} width={W} height={H}
            style={{ display: 'block', width: '100%', position: 'absolute', top: 0, left: 0, cursor: tool === 'text' ? 'text' : tool === 'select' ? 'default' : 'crosshair' }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={() => {
              cursorPos.current = null;
              if (drawing.current) {
                drawing.current = false;
                dragMode.current = null;
                renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
              } else {
                renderAll(layersRef.current, objectsRef.current, selectedIdRef.current);
              }
            }}
          />
        </div>

        {/* ── Right: layers panel ──────────────────────────────────────────── */}
        <div style={S.panel}>
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
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                <button
                  style={{ ...S.smallBtn(layer.visible ? '#000' : '#eee', layer.visible ? '#fff' : '#000'), fontSize: 10, padding: '1px 4px' }}
                  onClick={(e) => { e.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }}
                >
                  {layer.visible ? '👁' : '○'}
                </button>
                <input
                  value={layer.name}
                  onChange={(e) => updateLayer(layer.id, { name: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  style={{ border: 'none', background: 'transparent', fontSize: 11, fontFamily: 'Poppins, sans-serif', fontWeight: 700, flex: 1, padding: 0 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 3 }}>
                <button style={S.smallBtn()} onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, 1); }}>↑</button>
                <button style={S.smallBtn()} onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, -1); }}>↓</button>
                <button style={S.smallBtn('#f44', '#fff')} onClick={(e) => { e.stopPropagation(); deleteLayer(layer.id); }}>✕</button>
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
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
