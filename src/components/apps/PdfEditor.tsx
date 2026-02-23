import { useState, useRef, useEffect, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageEntry {
  id: string;
  pdfDoc: any | null;    // pdf.js document (null for blank pages)
  pdfFile: File | null;  // source File for pdf-lib save (null for blank pages)
  pageNum: number;       // 1-indexed; -1 for blank pages
  thumbnail: string;
}

type AnnType = 'rect' | 'text' | 'image';

interface Annotation {
  id: string;
  pageId: string;
  type: AnnType;
  x: number; y: number; w: number; h: number;
  color: string;
  opacity?: number;
  lockAspect?: boolean;
  naturalAr?: number;
  text?: string;
  fontFamily?: string;
  imageSrc?: string;
  rotation?: number;   // degrees (0 = upright)
}

const FONTS = [
  { label: 'Poppins', value: 'Poppins, sans-serif' },
  { label: 'DM Serif Text', value: 'DM Serif Text, serif' },
  { label: 'Monospace', value: 'monospace' },
];

const PAGE_GAP = 14;

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  card: { border: '3px solid #000', background: '#fff', padding: '14px', marginBottom: '12px', boxShadow: '4px 4px 0 #000' } as React.CSSProperties,
  h2: { fontFamily: 'DM Serif Text, serif', fontSize: 18, marginBottom: 8 } as React.CSSProperties,
  label: { display: 'block', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 11, marginBottom: 3 } as React.CSSProperties,
  p: { fontFamily: 'Poppins, sans-serif', fontSize: 13 } as React.CSSProperties,
  btn: (bg = '#000', fg = '#fff', disabled = false) => ({
    border: '2px solid #000', background: disabled ? '#ccc' : bg, color: disabled ? '#888' : fg,
    padding: '6px 12px', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: disabled ? 'none' : '2px 2px 0 #000',
    marginRight: 6, marginBottom: 4,
  } as React.CSSProperties),
};

// Wide button variant for the right panel
const wideBtn: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box',
  textAlign: 'center', marginBottom: 4, marginRight: 0,
};

const uid = () => Math.random().toString(36).slice(2, 8);

const HANDLE_R = 8;

// ── Rotation helpers ───────────────────────────────────────────────────────────

function toRad(deg: number) { return deg * Math.PI / 180; }

function rotatePoint(px: number, py: number, cx: number, cy: number, rad: number) {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: (px - cx) * cos - (py - cy) * sin + cx, y: (px - cx) * sin + (py - cy) * cos + cy };
}

/** World-space position of the rotation handle circle (30px above top-center, rotated with annotation). */
function getAnnRotationHandle(ann: Annotation): { x: number; y: number } {
  const cx = ann.x + ann.w / 2, cy = ann.y + ann.h / 2;
  return rotatePoint(cx, cy - ann.h / 2 - 30, cx, cy, toRad(ann.rotation ?? 0));
}

function annRotationHandleHit(ann: Annotation, px: number, py: number): boolean {
  const rh = getAnnRotationHandle(ann);
  return Math.hypot(px - rh.x, py - rh.y) < HANDLE_R + 4;
}

function getHandlePositions(ann: Annotation) {
  const { x, y, w, h } = ann;
  return [
    { pos: 'nw', x, y },
    { pos: 'ne', x: x + w, y },
    { pos: 'se', x: x + w, y: y + h },
    { pos: 'sw', x, y: y + h },
  ];
}

function handleAtPoint(ann: Annotation, px: number, py: number): string | null {
  // Transform into local (unrotated) space before checking handles
  let lx = px, ly = py;
  const rot = ann.rotation ?? 0;
  if (rot !== 0) {
    const cx = ann.x + ann.w / 2, cy = ann.y + ann.h / 2;
    const local = rotatePoint(px, py, cx, cy, toRad(-rot));
    lx = local.x; ly = local.y;
  }
  for (const h of getHandlePositions(ann)) {
    if (Math.abs(lx - h.x) < HANDLE_R && Math.abs(ly - h.y) < HANDLE_R) return h.pos;
  }
  return null;
}

function annHitTest(ann: Annotation, px: number, py: number): boolean {
  // Transform into local (unrotated) space
  let lx = px, ly = py;
  const rot = ann.rotation ?? 0;
  if (rot !== 0) {
    const cx = ann.x + ann.w / 2, cy = ann.y + ann.h / 2;
    const local = rotatePoint(px, py, cx, cy, toRad(-rot));
    lx = local.x; ly = local.y;
  }
  if (ann.type === 'rect') {
    const bw = 6;
    return lx >= ann.x - bw && lx <= ann.x + ann.w + bw &&
           ly >= ann.y - bw && ly <= ann.y + ann.h + bw;
  }
  return lx >= ann.x - 4 && lx <= ann.x + ann.w + 4 &&
         ly >= ann.y - 4 && ly <= ann.y + ann.h + 4;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PdfEditor() {
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [activePage, setActivePage] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnId, setSelectedAnnId] = useState<string | null>(null);
  const [tool, setTool] = useState<'select' | 'rect' | 'text' | 'image'>('select');
  const [annColor, setAnnColor] = useState('#000000');
  const [annFont, setAnnFont] = useState('Poppins, sans-serif');
  const [textInput, setTextInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewScale, setViewScale] = useState(1);

  const fileRef = useRef<File | null>(null);
  const firstPageWidthRef = useRef<number | null>(null);
  // Per-page canvas refs — populated via callback refs in JSX
  const pageCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const pageOverlayRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const pageDivRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const imageCache = useRef<Map<string, HTMLImageElement>>(new Map());
  // Cancellation token: increments on each renderAllPages call
  const renderCountRef = useRef(0);
  // Per-page in-progress pdf.js render task — cancelled before starting a new render on the same canvas
  const renderTasksRef = useRef<Map<string, any>>(new Map());

  // Refs for event handlers
  const annotationsRef = useRef(annotations);   annotationsRef.current = annotations;
  const selectedAnnRef = useRef(selectedAnnId); selectedAnnRef.current = selectedAnnId;
  const toolRef = useRef(tool);                 toolRef.current = tool;
  const colorRef = useRef(annColor);            colorRef.current = annColor;
  const annFontRef = useRef(annFont);           annFontRef.current = annFont;
  const textInputRef = useRef(textInput);       textInputRef.current = textInput;
  const activePageRef = useRef(activePage);     activePageRef.current = activePage;

  const [snapRotation, setSnapRotation] = useState(true);
  const snapToRef = useRef(snapRotation); snapToRef.current = snapRotation;

  // Interaction state
  const interactRef = useRef<{
    mode: 'create-rect' | 'move' | 'resize' | 'rotate' | null;
    handle: string | null;
    startX: number; startY: number;
    startPageId: string | null;
    origAnn: Annotation | null;
    drawing: boolean;
    startAngle: number;
    startRotation: number;
  }>({ mode: null, handle: null, startX: 0, startY: 0, startPageId: null, origAnn: null, drawing: false, startAngle: 0, startRotation: 0 });

  // ── Load PDF.js (CDN, avoids bundler/worker issues) ───────────────────────

  const loadPdfjsLib = useCallback(() => {
    return new Promise<any>((resolve, reject) => {
      if ((window as any).pdfjsLib) return resolve((window as any).pdfjsLib);
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = () => {
        const lib = (window as any).pdfjsLib;
        lib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(lib);
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }, []);

  // ── Fit to width ──────────────────────────────────────────────────────────

  const fitToWidth = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const natW = firstPageWidthRef.current ?? 595;
    const available = container.clientWidth - 24; // 12px padding each side in the content div
    if (available > 0 && natW > 0) {
      const scale = Math.max(0.25, Math.min(2.5, parseFloat((available / natW).toFixed(2))));
      setViewScale(scale);
    }
  }, []);

  // Auto-fit when pages are first loaded (transition from 0 → N)
  const prevPagesLenRef = useRef(0);
  useEffect(() => {
    if (prevPagesLenRef.current === 0 && pages.length > 0) {
      // Two nested rAFs: first waits for React commit → DOM paint, second waits for layout to settle
      requestAnimationFrame(() => requestAnimationFrame(fitToWidth));
    }
    prevPagesLenRef.current = pages.length;
  }, [pages.length, fitToWidth]);

  // ── Per-page overlay drawing ───────────────────────────────────────────────

  const redrawPageOverlay = useCallback((pageId: string) => {
    const overlay = pageOverlayRefs.current.get(pageId);
    if (!overlay) return;
    const ctx = overlay.getContext('2d')!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const anns = annotationsRef.current.filter((a) => a.pageId === pageId);
    const selId = selectedAnnRef.current;

    for (const ann of anns) {
      const rot = ann.rotation ?? 0;
      const cx = ann.x + ann.w / 2, cy = ann.y + ann.h / 2;

      ctx.save();
      // Apply rotation around the annotation's center
      if (rot !== 0) {
        ctx.translate(cx, cy);
        ctx.rotate(toRad(rot));
        ctx.translate(-cx, -cy);
      }

      if (ann.type === 'rect') {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = ann.color;
        ctx.fillRect(ann.x, ann.y, ann.w, ann.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
      } else if (ann.type === 'text' && ann.text) {
        const ff = ann.fontFamily ?? 'Poppins, sans-serif';
        ctx.font = `bold 16px ${ff}`;
        ctx.fillStyle = '#fff';
        ctx.fillText(ann.text, ann.x + 1, ann.y + 1);
        ctx.fillStyle = ann.color;
        ctx.fillText(ann.text, ann.x, ann.y);
      } else if (ann.type === 'image' && ann.imageSrc) {
        const img = imageCache.current.get(ann.imageSrc);
        if (img) {
          ctx.globalAlpha = ann.opacity ?? 1;
          ctx.drawImage(img, ann.x, ann.y, ann.w, ann.h);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
        }
      }
      ctx.restore();

      if (selId === ann.id) {
        ctx.save();
        // Rotate selection UI with the annotation
        if (rot !== 0) {
          ctx.translate(cx, cy);
          ctx.rotate(toRad(rot));
          ctx.translate(-cx, -cy);
        }
        ctx.strokeStyle = '#0088ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(ann.x - 3, ann.y - 3, ann.w + 6, ann.h + 6);
        ctx.setLineDash([]);
        if (ann.type !== 'text') {
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#0088ff';
          ctx.lineWidth = 1.5;
          for (const h of getHandlePositions(ann)) {
            ctx.fillRect(h.x - 5, h.y - 5, 10, 10);
            ctx.strokeRect(h.x - 5, h.y - 5, 10, 10);
          }
        }
        // Rotation handle stem + circle (30px above top-center in local space) — all types
        {
          const rhX = ann.x + ann.w / 2, rhY = ann.y - 3;
          ctx.beginPath();
          ctx.moveTo(rhX, rhY);
          ctx.lineTo(rhX, rhY - 28);
          ctx.setLineDash([3, 2]);
          ctx.strokeStyle = '#0088ff';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(rhX, rhY - 28, 6, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.strokeStyle = '#0088ff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }, []);

  // ── Render one page to its canvas ─────────────────────────────────────────

  const renderOnePage = useCallback(async (entry: PageEntry, scale: number) => {
    const canvas = pageCanvasRefs.current.get(entry.id);
    const overlay = pageOverlayRefs.current.get(entry.id);
    if (!canvas || !overlay) return;

    // Cancel any in-progress pdf.js render on this canvas to avoid concurrent render corruption
    const existingTask = renderTasksRef.current.get(entry.id);
    if (existingTask) {
      try { existingTask.cancel(); } catch { /* ignore */ }
      renderTasksRef.current.delete(entry.id);
    }

    try {
      let pw: number, ph: number;
      if (entry.pageNum < 1 || !entry.pdfDoc) {
        pw = Math.round(595 * scale); ph = Math.round(842 * scale);
        canvas.width = pw; canvas.height = ph;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, pw, ph);
      } else {
        const page = await entry.pdfDoc.getPage(entry.pageNum);
        const vp = page.getViewport({ scale });
        pw = Math.round(vp.width); ph = Math.round(vp.height);
        canvas.width = pw; canvas.height = ph;
        const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp });
        renderTasksRef.current.set(entry.id, task);
        try {
          await task.promise;
        } catch (err: any) {
          // RenderingCancelledException means a newer render took over — not an error
          if (err?.name === 'RenderingCancelledException') return;
          throw err;
        }
        renderTasksRef.current.delete(entry.id);
      }
      overlay.width = pw; overlay.height = ph;
      redrawPageOverlay(entry.id);
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error(`Failed to render page ${entry.pageNum}:`, err);
      }
    }
  }, [redrawPageOverlay]);

  const renderAllPages = useCallback(async (pagesArg: PageEntry[], scale: number) => {
    const myCount = ++renderCountRef.current;
    for (const entry of pagesArg) {
      if (renderCountRef.current !== myCount) return; // cancelled by newer call
      await renderOnePage(entry, scale);
    }
  }, [renderOnePage]);

  // Sync overlays when annotations or selection changes
  useEffect(() => {
    for (const pageId of pageOverlayRefs.current.keys()) {
      redrawPageOverlay(pageId);
    }
  }, [annotations, selectedAnnId, redrawPageOverlay]);

  // Re-render pages when page list or zoom changes
  useEffect(() => {
    if (pages.length > 0) {
      renderAllPages(pages, viewScale);
    }
  }, [pages, viewScale, renderAllPages]);

  // ── Load PDF ──────────────────────────────────────────────────────────────

  const loadPdf = async (file: File) => {
    setError(null);
    setLoading(true);
    setLoadProgress(0);
    setPages([]);
    setActivePage(null);
    setAnnotations([]);
    setSelectedAnnId(null);
    fileRef.current = file;
    firstPageWidthRef.current = null;
    pageCanvasRefs.current.clear();
    pageOverlayRefs.current.clear();
    pageDivRefs.current.clear();

    try {
      const pdfjsLib = await loadPdfjsLib();
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      const entries: PageEntry[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        if (i === 1) firstPageWidthRef.current = page.getViewport({ scale: 1 }).width;
        const vp = page.getViewport({ scale: 0.25 });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
        entries.push({ id: uid(), pdfDoc: pdf, pdfFile: file, pageNum: i, thumbnail: c.toDataURL('image/jpeg', 0.65) });
        setLoadProgress(Math.round((i / pdf.numPages) * 100));
      }

      setPages(entries);
      if (entries.length > 0) setActivePage(entries[0].id);
    } catch (e: any) {
      setError('Failed to load PDF: ' + (e.message ?? String(e)));
    } finally {
      setLoading(false);
    }
  };

  // ── Add another PDF (combine) ─────────────────────────────────────────────

  const addPdf = async (file: File) => {
    setError(null);
    setLoading(true);
    setLoadProgress(0);
    try {
      const pdfjsLib = await loadPdfjsLib();
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      const newEntries: PageEntry[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 0.25 });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
        newEntries.push({ id: uid(), pdfDoc: pdf, pdfFile: file, pageNum: i, thumbnail: c.toDataURL('image/jpeg', 0.65) });
        setLoadProgress(Math.round((i / pdf.numPages) * 100));
      }

      // Insert pages after the currently active page (or at end if none)
      setPages((prev) => {
        const idx = activePageRef.current ? prev.findIndex((p) => p.id === activePageRef.current) : prev.length - 1;
        const insertAt = idx === -1 ? prev.length : idx + 1;
        const next = [...prev];
        next.splice(insertAt, 0, ...newEntries);
        return next;
      });
    } catch (e: any) {
      setError('Failed to add PDF: ' + (e.message ?? String(e)));
    } finally {
      setLoading(false);
    }
  };

  // ── Overlay canvas helpers ─────────────────────────────────────────────────

  /** Canvas-local coords from a mousedown on a per-page overlay (uses e.currentTarget). */
  function getOverlayPos(e: React.MouseEvent): { x: number; y: number } {
    const canvas = e.currentTarget as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  /** Canvas-local coords relative to a specific page overlay (used during drag). */
  function getPosByPage(e: React.MouseEvent, pageId: string): { x: number; y: number } | null {
    const overlay = pageOverlayRefs.current.get(pageId);
    if (!overlay) return null;
    const rect = overlay.getBoundingClientRect();
    const sx = overlay.width / rect.width;
    const sy = overlay.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  // ── Per-page mousedown ────────────────────────────────────────────────────

  const onOverlayDown = (e: React.MouseEvent, pageId: string) => {
    const pos = getOverlayPos(e);
    if (pageId !== activePageRef.current) {
      setActivePage(pageId);
      activePageRef.current = pageId;
    }
    const t = toolRef.current;
    const ia = interactRef.current;

    if (t === 'text') {
      const txt = textInputRef.current || prompt('Enter annotation text:', '') || '';
      if (!txt) return;
      const newAnn: Annotation = {
        id: uid(), pageId, type: 'text',
        x: pos.x, y: pos.y, w: txt.length * 9, h: 20,
        color: colorRef.current, text: txt, fontFamily: annFontRef.current,
      };
      const next = [...annotationsRef.current, newAnn];
      annotationsRef.current = next;
      setAnnotations(next);
      setSelectedAnnId(newAnn.id);
      setTool('select');
      return;
    }

    if (t === 'select') {
      const pageAnns = annotationsRef.current.filter((a) => a.pageId === pageId);
      const selId = selectedAnnRef.current;
      const selAnn = selId ? pageAnns.find((a) => a.id === selId) : null;
      if (selAnn) {
        // Rotation handle takes priority (all annotation types)
        if (annRotationHandleHit(selAnn, pos.x, pos.y)) {
          const cx = selAnn.x + selAnn.w / 2, cy = selAnn.y + selAnn.h / 2;
          ia.mode = 'rotate';
          ia.startAngle = Math.atan2(pos.y - cy, pos.x - cx);
          ia.startRotation = selAnn.rotation ?? 0;
          ia.origAnn = { ...selAnn }; ia.drawing = true;
          ia.startPageId = pageId;
          return;
        }
        // Resize handles only for non-text
        if (selAnn.type !== 'text') {
          const h = handleAtPoint(selAnn, pos.x, pos.y);
          if (h) {
            ia.mode = 'resize'; ia.handle = h;
            ia.startX = pos.x; ia.startY = pos.y;
            ia.origAnn = { ...selAnn }; ia.drawing = true;
            return;
          }
        }
      }
      const hit = [...pageAnns].reverse().find((a) => annHitTest(a, pos.x, pos.y));
      if (hit) {
        setSelectedAnnId(hit.id);
        selectedAnnRef.current = hit.id;
        ia.mode = 'move';
        ia.startX = pos.x; ia.startY = pos.y;
        ia.origAnn = { ...hit }; ia.drawing = true;
      } else {
        setSelectedAnnId(null);
        selectedAnnRef.current = null;
      }
      return;
    }

    if (t === 'rect') {
      ia.mode = 'create-rect';
      ia.startX = pos.x; ia.startY = pos.y;
      ia.startPageId = pageId; ia.drawing = true;
    }
  };

  // ── Container-level move/up (captures drags that leave a page overlay) ────

  const onContainerMove = (e: React.MouseEvent) => {
    const ia = interactRef.current;
    if (!ia.drawing) return;
    const pageId = ia.mode === 'create-rect' ? ia.startPageId : (ia.origAnn?.pageId ?? null);
    if (!pageId) return;
    const pos = getPosByPage(e, pageId);
    if (!pos) return;

    if (ia.mode === 'create-rect') {
      const x = Math.min(ia.startX, pos.x);
      const y = Math.min(ia.startY, pos.y);
      const w = Math.abs(pos.x - ia.startX);
      const h = Math.abs(pos.y - ia.startY);
      redrawPageOverlay(pageId);
      const overlay = pageOverlayRefs.current.get(pageId);
      if (overlay) {
        const ctx = overlay.getContext('2d')!;
        ctx.save();
        ctx.globalAlpha = 0.3; ctx.fillStyle = colorRef.current;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1; ctx.strokeStyle = colorRef.current; ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
      }
      return;
    }

    if (ia.mode === 'rotate' && ia.origAnn) {
      const orig = ia.origAnn;
      const cx = orig.x + orig.w / 2, cy = orig.y + orig.h / 2;
      const angle = Math.atan2(pos.y - cy, pos.x - cx);
      const delta = (angle - ia.startAngle) * 180 / Math.PI;
      let newRot = ((ia.startRotation + delta) % 360 + 360) % 360;
      // Snap within 8° of any 90° multiple
      if (snapToRef.current) {
        const nearest = Math.round(newRot / 90) * 90 % 360;
        if (Math.abs(newRot - nearest) < 8) newRot = nearest;
      }
      const next = annotationsRef.current.map((a) => a.id === orig.id ? { ...a, rotation: newRot } : a);
      annotationsRef.current = next;
      setAnnotations(next);
      return;
    }

    if ((ia.mode === 'move' || ia.mode === 'resize') && ia.origAnn) {
      const dx = pos.x - ia.startX;
      const dy = pos.y - ia.startY;
      const orig = ia.origAnn;
      let updated: Annotation;
      if (ia.mode === 'move') {
        updated = { ...orig, x: orig.x + dx, y: orig.y + dy };
      } else {
        updated = { ...orig };
        switch (ia.handle) {
          case 'nw': updated.x = orig.x + dx; updated.y = orig.y + dy; updated.w = orig.w - dx; updated.h = orig.h - dy; break;
          case 'ne': updated.y = orig.y + dy; updated.w = orig.w + dx; updated.h = orig.h - dy; break;
          case 'se': updated.w = orig.w + dx; updated.h = orig.h + dy; break;
          case 'sw': updated.x = orig.x + dx; updated.w = orig.w - dx; updated.h = orig.h + dy; break;
        }
        if (updated.w < 10) { updated.w = 10; if (ia.handle?.includes('w')) updated.x = orig.x + orig.w - 10; }
        if (updated.h < 10) { updated.h = 10; if (ia.handle?.includes('n')) updated.y = orig.y + orig.h - 10; }
        if (orig.lockAspect && orig.naturalAr) {
          const ar = orig.naturalAr;
          const h = ia.handle;
          if (h === 'nw' || h === 'ne' || h === 'se' || h === 'sw') {
            updated.w = Math.max(10, updated.w);
            updated.h = updated.w / ar;
            if (h === 'nw' || h === 'ne') updated.y = orig.y + orig.h - updated.h;
          }
        }
      }
      const next = annotationsRef.current.map((a) => a.id === updated.id ? updated : a);
      annotationsRef.current = next;
      setAnnotations(next);
    }
  };

  const onContainerUp = (e: React.MouseEvent) => {
    const ia = interactRef.current;
    if (!ia.drawing) return;

    if (ia.mode === 'create-rect' && ia.startPageId) {
      const pos = getPosByPage(e, ia.startPageId);
      if (pos) {
        const w = Math.abs(pos.x - ia.startX);
        const h = Math.abs(pos.y - ia.startY);
        if (w > 5 && h > 5) {
          const newAnn: Annotation = {
            id: uid(), pageId: ia.startPageId, type: 'rect',
            x: Math.min(ia.startX, pos.x), y: Math.min(ia.startY, pos.y),
            w, h, color: colorRef.current,
          };
          const next = [...annotationsRef.current, newAnn];
          annotationsRef.current = next;
          setAnnotations(next);
          setSelectedAnnId(newAnn.id);
          selectedAnnRef.current = newAnn.id;
          setTool('select');
        }
      }
    }

    ia.drawing = false; ia.mode = null; ia.handle = null;
    ia.origAnn = null; ia.startPageId = null;
  };

  // ── Image annotation ──────────────────────────────────────────────────────

  const addImageAnnotation = (file: File) => {
    if (!activePage) return;
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imageCache.current.set(src, img);
      const scale = Math.min(1, 300 / img.naturalWidth, 300 / img.naturalHeight);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const newAnn: Annotation = {
        id: uid(), pageId: activePage, type: 'image',
        x: 20, y: 20, w, h, color: '#000', imageSrc: src, opacity: 1, naturalAr: w / h,
      };
      const next = [...annotations, newAnn];
      annotationsRef.current = next;
      setAnnotations(next);
      setSelectedAnnId(newAnn.id);
      selectedAnnRef.current = newAnn.id;
      setTool('select');
    };
    img.src = src;
  };

  // ── Page management ───────────────────────────────────────────────────────

  const movePage = (id: string, dir: -1 | 1) => {
    const idx = pages.findIndex((p) => p.id === id);
    const ni = idx + dir;
    if (ni < 0 || ni >= pages.length) return;
    const next = [...pages];
    [next[idx], next[ni]] = [next[ni], next[idx]];
    setPages(next);
  };

  const deletePage = (id: string) => {
    if (pages.length <= 1) return;
    const remaining = pages.filter((p) => p.id !== id);
    setPages(remaining);
    if (activePage === id) setActivePage(remaining[0].id);
    const anns = annotations.filter((a) => a.pageId !== id);
    annotationsRef.current = anns;
    setAnnotations(anns);
  };

  const addBlankPage = () => {
    const id = uid();
    setPages((prev) => {
      // Insert after the currently active page
      const idx = activePageRef.current ? prev.findIndex((p) => p.id === activePageRef.current) : prev.length - 1;
      const insertAt = idx === -1 ? prev.length : idx + 1;
      const next = [...prev];
      next.splice(insertAt, 0, { id, pdfDoc: null, pdfFile: null, pageNum: -1, thumbnail: '' });
      return next;
    });
    setActivePage(id);
    activePageRef.current = id;
  };

  const clearPageAnnotations = () => {
    if (!activePage) return;
    const next = annotations.filter((a) => a.pageId !== activePage);
    annotationsRef.current = next;
    setAnnotations(next);
    setSelectedAnnId(null);
  };

  const scrollToPage = (pageId: string) => {
    const el = pageDivRefs.current.get(pageId);
    if (!el || !scrollContainerRef.current) return;
    scrollContainerRef.current.scrollTop = Math.max(0, el.offsetTop - 20);
  };

  const deleteSelectedAnnotation = () => {
    if (!selectedAnnId) return;
    const next = annotations.filter((a) => a.id !== selectedAnnId);
    annotationsRef.current = next;
    setAnnotations(next);
    setSelectedAnnId(null);
    selectedAnnRef.current = null;
  };

  // ── Save PDF ──────────────────────────────────────────────────────────────

  const savePdf = async () => {
    if (!fileRef.current || pages.length === 0) return;
    setSaving(true);
    try {
      const { PDFDocument } = await import('pdf-lib');
      const newDoc = await PDFDocument.create();

      // Cache pdf-lib documents by source File to avoid re-loading the same file multiple times
      const pdfLibDocCache = new Map<File, any>();
      const getPdfLibDoc = async (file: File) => {
        if (!pdfLibDocCache.has(file)) {
          const bytes = await file.arrayBuffer();
          pdfLibDocCache.set(file, await PDFDocument.load(bytes));
        }
        return pdfLibDocCache.get(file)!;
      };

      // First pass: copy / create all pages
      for (const entry of pages) {
        if (entry.pageNum === -1 || !entry.pdfFile) {
          newDoc.addPage([595, 842]);
        } else {
          const srcDoc = await getPdfLibDoc(entry.pdfFile);
          const [copied] = await newDoc.copyPages(srcDoc, [entry.pageNum - 1]);
          newDoc.addPage(copied);
        }
      }

      // Second pass: bake annotations onto their pages
      for (let i = 0; i < pages.length; i++) {
        const entry = pages[i];
        const pageAnns = annotations.filter((a) => a.pageId === entry.id);
        if (pageAnns.length === 0 || entry.pageNum < 1 || !entry.pdfDoc) continue;

        const pdfPage = newDoc.getPage(i);
        const { width, height } = pdfPage.getSize();
        const SCALE = 2;

        const srcPage = await entry.pdfDoc.getPage(entry.pageNum);
        const vp = srcPage.getViewport({ scale: SCALE });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        const ctx = c.getContext('2d')!;
        await srcPage.render({ canvasContext: ctx, viewport: vp }).promise;

        const scaleX = vp.width / width;
        const scaleY = vp.height / height;

        pageAnns.forEach((ann) => {
          ctx.save();
          const rot = ann.rotation ?? 0;
          if (rot !== 0) {
            const annCX = (ann.x + ann.w / 2) * scaleX;
            const annCY = (ann.y + ann.h / 2) * scaleY;
            ctx.translate(annCX, annCY);
            ctx.rotate(toRad(rot));
            ctx.translate(-annCX, -annCY);
          }
          if (ann.type === 'rect') {
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = ann.color;
            ctx.fillRect(ann.x * scaleX, ann.y * scaleY, ann.w * scaleX, ann.h * scaleY);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = ann.color; ctx.lineWidth = 2;
            ctx.strokeRect(ann.x * scaleX, ann.y * scaleY, ann.w * scaleX, ann.h * scaleY);
          } else if (ann.type === 'text' && ann.text) {
            ctx.font = `bold ${16 * SCALE}px ${ann.fontFamily ?? 'sans-serif'}`;
            ctx.fillStyle = ann.color;
            ctx.fillText(ann.text, ann.x * scaleX, ann.y * scaleY);
          } else if (ann.type === 'image' && ann.imageSrc) {
            const img = imageCache.current.get(ann.imageSrc);
            if (img) {
              ctx.globalAlpha = ann.opacity ?? 1;
              ctx.drawImage(img, ann.x * scaleX, ann.y * scaleY, ann.w * scaleX, ann.h * scaleY);
              ctx.globalAlpha = 1;
            }
          }
          ctx.restore();
        });

        const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.9));
        const imgBytes = await blob.arrayBuffer();
        const img = await newDoc.embedJpg(imgBytes);
        pdfPage.drawImage(img, { x: 0, y: 0, width, height });
      }

      const pdfBytes = await newDoc.save();
      const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileRef.current.name.replace('.pdf', '-edited.pdf');
      a.click();
    } catch (e: any) {
      setError('Save failed: ' + (e.message ?? String(e)));
    } finally {
      setSaving(false);
    }
  };

  // ── Selected annotation property panel ────────────────────────────────────

  const selAnn = annotations.find((a) => a.id === selectedAnnId) ?? null;

  const updateSelAnn = (patch: Partial<Annotation>) => {
    if (!selectedAnnId) return;
    const next = annotations.map((a) => (a.id === selectedAnnId ? { ...a, ...patch } : a));
    annotationsRef.current = next;
    setAnnotations(next);
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'Delete' || e.key === 'Backspace') deleteSelectedAnnotation();
      if (e.key === 'Escape') { setSelectedAnnId(null); selectedAnnRef.current = null; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedAnnId]);

  // ── Render ────────────────────────────────────────────────────────────────

  const overlayStyle = (pageId: string): React.CSSProperties => ({
    position: 'absolute', top: 0, left: 0,
    cursor: tool === 'text' ? 'text' : tool === 'select' ? 'default' : 'crosshair',
    outline: activePage === pageId ? '2px solid #0088ff' : 'none',
  });

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '190px minmax(0, 1fr) 210px', gap: 12, alignItems: 'start' }}>

        {/* ── Page list sidebar ── */}
        {pages.length > 0 ? (
          <div style={{ ...S.card, padding: 10 }}>
            <h2 style={S.h2}>Pages ({pages.length})</h2>
            <div style={{ maxHeight: '80vh', overflowY: 'auto' }}>
              {pages.map((p, idx) => (
                <div key={p.id}
                  onClick={() => { setActivePage(p.id); scrollToPage(p.id); }}
                  style={{ border: `2px solid ${activePage === p.id ? '#000' : '#ddd'}`, background: activePage === p.id ? '#eee' : '#fff', padding: 6, marginBottom: 6, cursor: 'pointer' }}
                >
                  <p style={{ ...S.label, marginBottom: 4 }}>Page {idx + 1}</p>
                  {p.thumbnail ? (
                    <img src={p.thumbnail} alt={`Page ${idx + 1}`} style={{ width: '100%', display: 'block', border: '1px solid #ccc' }} />
                  ) : (
                    <div style={{ width: '100%', aspectRatio: '210/297', background: '#f5f5f5', border: '1px solid #ccc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: 11, fontFamily: 'Poppins, sans-serif', color: '#aaa' }}>Blank</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
                    <button style={S.btn('#fff', '#000')} onClick={(e) => { e.stopPropagation(); movePage(p.id, -1); }}>↑</button>
                    <button style={S.btn('#fff', '#000')} onClick={(e) => { e.stopPropagation(); movePage(p.id, 1); }}>↓</button>
                    <button style={S.btn('#f44', '#fff')} onClick={(e) => { e.stopPropagation(); deletePage(p.id); }}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : <div />}

        {/* ── Main canvas area ── */}
        <div style={{ minWidth: 0 }}>
          {pages.length === 0 ? (
            <div style={{ border: '3px solid #000', background: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 500, boxShadow: '5px 5px 0 #000' }}>
              {loading ? (
                <p style={{ color: '#eee', fontFamily: 'Poppins, sans-serif', fontSize: 16 }}>Loading… {loadProgress}%</p>
              ) : (
                <p style={{ color: '#eee', fontFamily: 'Poppins, sans-serif', fontSize: 16, textAlign: 'center', lineHeight: 1.8 }}>
                  Open a PDF to get started
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Annotation toolbar */}
              <div style={{ ...S.card, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 12 }}>Tool:</span>
                  {(['select', 'rect', 'text', 'image'] as const).map((t) => (
                    <button key={t} style={S.btn(tool === t ? '#000' : '#fff', tool === t ? '#fff' : '#000')} onClick={() => setTool(t)}>
                      {t === 'select' ? '↖ Select' : t === 'rect' ? '▭ Highlight' : t === 'text' ? 'T Text' : '🖼 Image'}
                    </button>
                  ))}
                  <input type='color' value={annColor} onChange={(e) => setAnnColor(e.target.value)}
                    style={{ width: 32, height: 28, border: '2px solid #000', cursor: 'pointer', padding: 0 }} title='Color' />
                  {[['#000000', 'Black'], ['#ff0000', 'Red'], ['#0000ff', 'Blue']].map(([c, label]) => (
                    <button key={c} onClick={() => setAnnColor(c)} title={label}
                      style={{ width: 22, height: 22, background: c, border: annColor === c ? '3px solid #0088ff' : '2px solid #ccc', cursor: 'pointer', padding: 0, boxSizing: 'border-box' as const }} />
                  ))}
                  {tool === 'text' && (
                    <>
                      <input value={textInput} onChange={(e) => setTextInput(e.target.value)}
                        placeholder='Text to add…'
                        style={{ border: '2px solid #000', padding: '4px 8px', fontSize: 12, fontFamily: 'Poppins, sans-serif' }} />
                      <select value={annFont} onChange={(e) => setAnnFont(e.target.value)}
                        style={{ border: '2px solid #000', padding: '4px 6px', fontSize: 12, fontFamily: 'Poppins, sans-serif', cursor: 'pointer' }}>
                        {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </>
                  )}
                  {tool === 'image' && (
                    <label style={{ ...S.btn('#fff', '#000'), cursor: 'pointer' }}>
                      Choose image…
                      <input type='file' accept='image/*' style={{ display: 'none' }}
                        onChange={(e) => e.target.files?.[0] && addImageAnnotation(e.target.files[0])} />
                    </label>
                  )}
                  <span style={{ marginLeft: 'auto', fontFamily: 'Poppins, sans-serif', fontSize: 11 }}>
                    Zoom: {Math.round(viewScale * 100)}%
                  </span>
                  <input type='range' min={0.25} max={2.5} step={0.05} value={viewScale}
                    onChange={(e) => setViewScale(parseFloat(e.target.value))} style={{ width: 80 }} />
                  <button style={S.btn('#fff', '#000')} onClick={fitToWidth} title='Fit page to available width'>⊞ Fit</button>
                  <button style={S.btn('#fff', '#000')} onClick={clearPageAnnotations}>Clear page</button>
                </div>
                {selectedAnnId && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 11, fontWeight: 700, color: '#0088ff' }}>Selected:</span>
                    <button style={S.btn('#f44', '#fff')} onClick={deleteSelectedAnnotation}>✕ Delete</button>
                    <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 11, color: '#555' }}>
                      Drag to move · Drag corner handles to resize · Delete key
                    </span>
                  </div>
                )}
              </div>

              {/* Scrollable per-page canvas stack */}
              <div ref={scrollContainerRef}
                style={{ border: '3px solid #000', background: '#888', overflow: 'auto', maxHeight: '75vh', boxShadow: '5px 5px 0 #000', userSelect: 'none' }}
                onMouseMove={onContainerMove}
                onMouseUp={onContainerUp}
                onMouseLeave={onContainerUp}
              >
                <div style={{ padding: `${PAGE_GAP}px 12px` }}>
                  {pages.map((p) => (
                    <div key={p.id}
                      ref={(el) => { if (el) pageDivRefs.current.set(p.id, el); else pageDivRefs.current.delete(p.id); }}
                      style={{ margin: `0 auto ${PAGE_GAP}px`, width: 'fit-content', position: 'relative' }}
                    >
                      <canvas
                        ref={(el) => { if (el) pageCanvasRefs.current.set(p.id, el); else pageCanvasRefs.current.delete(p.id); }}
                        style={{ display: 'block' }}
                      />
                      <canvas
                        ref={(el) => { if (el) pageOverlayRefs.current.set(p.id, el); else pageOverlayRefs.current.delete(p.id); }}
                        style={overlayStyle(p.id)}
                        onMouseDown={(e) => onOverlayDown(e, p.id)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── Properties + file operations panel ── */}
        <div style={S.card}>
          <h2 style={S.h2}>📄 PDF Editor</h2>

          {/* File operations — always visible */}
          <label style={{ ...S.btn(), ...wideBtn, cursor: 'pointer' }}>
            📂 Open PDF
            <input type='file' accept='application/pdf' style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && loadPdf(e.target.files[0])} />
          </label>
          {pages.length > 0 && (
            <>
              <button style={{ ...S.btn('#fff', '#000'), ...wideBtn }} onClick={addBlankPage}>
                + Blank page
              </button>
              <label style={{ ...S.btn('#fff', '#000'), ...wideBtn, cursor: 'pointer' }}>
                📎 Add PDF…
                <input type='file' accept='application/pdf' style={{ display: 'none' }}
                  onChange={(e) => e.target.files?.[0] && addPdf(e.target.files[0])} />
              </label>
              <button style={{ ...S.btn('#0a0', '#fff', saving), ...wideBtn }}
                onClick={savePdf} disabled={saving}>
                {saving ? 'Saving…' : '⬇ Save PDF'}
              </button>
            </>
          )}
          {loading && <p style={{ ...S.p, color: '#555', fontSize: 11, marginTop: 2 }}>Loading… {loadProgress}%</p>}
          {error && <p style={{ ...S.p, color: '#c00', fontSize: 11, marginTop: 2 }}>{error}</p>}

          {/* Properties section */}
          {pages.length > 0 && (
            <>
              <hr style={{ margin: '10px 0', border: 'none', borderTop: '2px solid #000' }} />
              <h2 style={{ ...S.h2, marginBottom: 6 }}>Properties</h2>
              {selAnn ? (
                <>
                  <p style={{ ...S.label, color: '#0088ff', marginBottom: 8 }}>
                    {selAnn.type.toUpperCase()} ANNOTATION
                  </p>
                  {(selAnn.type === 'rect' || selAnn.type === 'text') && (
                    <>
                      <label style={S.label}>Color</label>
                      <input type='color' value={selAnn.color}
                        onChange={(e) => updateSelAnn({ color: e.target.value })}
                        style={{ width: '100%', height: 28, border: '2px solid #000', padding: 0, cursor: 'pointer', marginBottom: 8 }} />
                    </>
                  )}
                  {selAnn.type === 'text' && (
                    <>
                      <label style={S.label}>Text</label>
                      <input value={selAnn.text ?? ''}
                        onChange={(e) => updateSelAnn({ text: e.target.value, w: e.target.value.length * 9 })}
                        style={{ border: '1px solid #000', padding: '4px 6px', width: '100%', boxSizing: 'border-box' as const, fontFamily: 'Poppins, sans-serif', fontSize: 12, marginBottom: 8 }}
                      />
                      <label style={S.label}>Font</label>
                      <select value={selAnn.fontFamily ?? 'Poppins, sans-serif'}
                        onChange={(e) => updateSelAnn({ fontFamily: e.target.value })}
                        style={{ border: '2px solid #000', padding: '4px 6px', width: '100%', boxSizing: 'border-box' as const, fontFamily: 'Poppins, sans-serif', fontSize: 12, marginBottom: 8, cursor: 'pointer' }}
                      >
                        {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontFamily: 'Poppins, sans-serif', fontSize: 11 }}>
                    <div>
                      <label style={S.label}>X</label>
                      <input type='number' value={Math.round(selAnn.x)} onChange={(e) => updateSelAnn({ x: parseInt(e.target.value) || 0 })}
                        style={{ border: '1px solid #000', padding: '3px', width: '100%', fontFamily: 'Poppins, sans-serif', fontSize: 11 }} />
                    </div>
                    <div>
                      <label style={S.label}>Y</label>
                      <input type='number' value={Math.round(selAnn.y)} onChange={(e) => updateSelAnn({ y: parseInt(e.target.value) || 0 })}
                        style={{ border: '1px solid #000', padding: '3px', width: '100%', fontFamily: 'Poppins, sans-serif', fontSize: 11 }} />
                    </div>
                    {selAnn.type !== 'text' && (
                      <>
                        <div>
                          <label style={S.label}>W</label>
                          <input type='number' value={Math.round(selAnn.w)} onChange={(e) => updateSelAnn({ w: parseInt(e.target.value) || 1 })}
                            style={{ border: '1px solid #000', padding: '3px', width: '100%', fontFamily: 'Poppins, sans-serif', fontSize: 11 }} />
                        </div>
                        <div>
                          <label style={S.label}>H</label>
                          <input type='number' value={Math.round(selAnn.h)} onChange={(e) => updateSelAnn({ h: parseInt(e.target.value) || 1 })}
                            style={{ border: '1px solid #000', padding: '3px', width: '100%', fontFamily: 'Poppins, sans-serif', fontSize: 11 }} />
                        </div>
                      </>
                    )}
                  </div>
                  {selAnn.type === 'image' && (
                    <div style={{ marginTop: 8 }}>
                      <label style={S.label}>Opacity: {Math.round((selAnn.opacity ?? 1) * 100)}%</label>
                      <input type='range' min={0} max={100} value={Math.round((selAnn.opacity ?? 1) * 100)}
                        onChange={(e) => updateSelAnn({ opacity: parseInt(e.target.value) / 100 })}
                        style={{ width: '100%', marginBottom: 8 }} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Poppins, sans-serif', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                        <input type='checkbox' checked={selAnn.lockAspect ?? false}
                          onChange={(e) => updateSelAnn({ lockAspect: e.target.checked })} />
                        Lock aspect ratio
                      </label>
                    </div>
                  )}
                  <div style={{ marginTop: 8 }}>
                      <hr style={{ margin: '6px 0', border: 'none', borderTop: '1px solid #ccc' }} />
                      <label style={S.label}>Rotation: {Math.round(selAnn.rotation ?? 0)}°</label>
                      <input type='range' min={0} max={359} value={Math.round(selAnn.rotation ?? 0)}
                        onChange={(e) => updateSelAnn({ rotation: parseInt(e.target.value) })}
                        style={{ width: '100%', marginBottom: 4 }} />
                      <div style={{ display: 'flex', gap: 3, marginBottom: 6, flexWrap: 'wrap' }}>
                        {[0, 90, 180, 270].map((a) => (
                          <button key={a} style={S.btn('#fff', '#000')} onClick={() => updateSelAnn({ rotation: a })}>{a}°</button>
                        ))}
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'Poppins, sans-serif', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                        <input type='checkbox' checked={snapRotation} onChange={(e) => setSnapRotation(e.target.checked)} />
                        Snap to 90°
                      </label>
                    </div>
                </>
              ) : (
                <p style={{ ...S.p, color: '#888', fontSize: 11 }}>
                  Select an annotation to edit its properties.
                  <br /><br />
                  <strong>Tips:</strong><br />
                  · Drag to move<br />
                  · Drag corner handles to resize<br />
                  · Delete key removes selected<br />
                  · Escape to deselect
                </p>
              )}
            </>
          )}

          {pages.length === 0 && !loading && (
            <p style={{ ...S.p, color: '#888', fontSize: 11, marginTop: 6 }}>
              Open a PDF file to start editing.
            </p>
          )}
        </div>

      </div>
    </div>
  );
}
