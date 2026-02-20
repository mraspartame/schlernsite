import { useState, useRef, useEffect, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageEntry {
  id: string;
  pageNum: number;
  thumbnail: string;
}

type AnnType = 'rect' | 'text' | 'image';

interface Annotation {
  id: string;
  pageId: string;
  type: AnnType;
  x: number; y: number; w: number; h: number;
  color: string;
  text?: string;
  imageSrc?: string;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  card: { border: '3px solid #000', background: '#fff', padding: '14px', marginBottom: '12px', boxShadow: '4px 4px 0 #000' } as React.CSSProperties,
  h1: { fontFamily: 'DM Serif Text, serif', fontSize: 32, marginBottom: 6 } as React.CSSProperties,
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

const uid = () => Math.random().toString(36).slice(2, 8);

const HANDLE_R = 8;

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
  for (const h of getHandlePositions(ann)) {
    if (Math.abs(px - h.x) < HANDLE_R && Math.abs(py - h.y) < HANDLE_R) return h.pos;
  }
  return null;
}

function annHitTest(ann: Annotation, px: number, py: number): boolean {
  if (ann.type === 'rect') {
    // Hit on the border (not just interior) for easier selection
    const bw = 6;
    return px >= ann.x - bw && px <= ann.x + ann.w + bw &&
           py >= ann.y - bw && py <= ann.y + ann.h + bw;
  }
  return px >= ann.x - 4 && px <= ann.x + ann.w + 4 &&
         py >= ann.y - 4 && py <= ann.y + ann.h + 4;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PdfEditor() {
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [activePage, setActivePage] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnId, setSelectedAnnId] = useState<string | null>(null);
  const [tool, setTool] = useState<'select' | 'rect' | 'text' | 'image'>('select');
  const [annColor, setAnnColor] = useState('#ffff00');
  const [textInput, setTextInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewScale, setViewScale] = useState(1);

  const pdfDocRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<File | null>(null);
  const imageCache = useRef<Map<string, HTMLImageElement>>(new Map());

  // Refs for event handlers
  const annotationsRef = useRef(annotations);   annotationsRef.current = annotations;
  const selectedAnnRef = useRef(selectedAnnId); selectedAnnRef.current = selectedAnnId;
  const toolRef = useRef(tool);                 toolRef.current = tool;
  const colorRef = useRef(annColor);            colorRef.current = annColor;
  const textInputRef = useRef(textInput);       textInputRef.current = textInput;
  const activePageRef = useRef(activePage);     activePageRef.current = activePage;

  // Interaction state
  const interactRef = useRef<{
    mode: 'create-rect' | 'move' | 'resize' | null;
    handle: string | null;
    startX: number; startY: number;
    origAnn: Annotation | null;
    drawing: boolean;
  }>({ mode: null, handle: null, startX: 0, startY: 0, origAnn: null, drawing: false });

  // ── Load PDF.js (CDN, avoids bundler/worker issues) ──────────────────────

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

  // ── Render PDF page to canvas ─────────────────────────────────────────────

  const renderPage = useCallback(async (pageNum: number, pdfDoc?: any) => {
    const doc = pdfDoc ?? pdfDocRef.current;
    if (!doc || !canvasRef.current || !overlayRef.current || pageNum < 1) return;
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: viewScale });
    canvasRef.current.width = vp.width;
    canvasRef.current.height = vp.height;
    overlayRef.current.width = vp.width;
    overlayRef.current.height = vp.height;
    await page.render({ canvasContext: canvasRef.current.getContext('2d')!, viewport: vp }).promise;
  }, [viewScale]);

  // ── Draw annotations on overlay canvas ───────────────────────────────────

  const redrawOverlay = useCallback((
    currentAnns: Annotation[],
    currentSelId: string | null,
    pageId: string | null,
  ) => {
    if (!overlayRef.current) return;
    const ctx = overlayRef.current.getContext('2d')!;
    const W = overlayRef.current.width;
    const H = overlayRef.current.height;
    ctx.clearRect(0, 0, W, H);

    if (!pageId) return;
    const pageAnns = currentAnns.filter((a) => a.pageId === pageId);

    pageAnns.forEach((ann) => {
      ctx.save();
      if (ann.type === 'rect') {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = ann.color;
        ctx.fillRect(ann.x, ann.y, ann.w, ann.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
      } else if (ann.type === 'text' && ann.text) {
        ctx.font = 'bold 16px Poppins, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(ann.text, ann.x + 1, ann.y + 1);
        ctx.fillStyle = ann.color;
        ctx.fillText(ann.text, ann.x, ann.y);
      } else if (ann.type === 'image' && ann.imageSrc) {
        const img = imageCache.current.get(ann.imageSrc);
        if (img) {
          ctx.globalAlpha = 0.9;
          ctx.drawImage(img, ann.x, ann.y, ann.w, ann.h);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
        }
      }
      ctx.restore();
    });

    // Draw selection
    if (currentSelId) {
      const sel = pageAnns.find((a) => a.id === currentSelId);
      if (sel) {
        ctx.save();
        ctx.strokeStyle = '#0088ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(sel.x - 3, sel.y - 3, sel.w + 6, sel.h + 6);
        ctx.setLineDash([]);
        // Corner handles (only for non-text objects, since text size isn't user-resizable)
        if (sel.type !== 'text') {
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#0088ff';
          ctx.lineWidth = 1.5;
          for (const h of getHandlePositions(sel)) {
            ctx.fillRect(h.x - 5, h.y - 5, 10, 10);
            ctx.strokeRect(h.x - 5, h.y - 5, 10, 10);
          }
        }
        ctx.restore();
      }
    }
  }, []);

  // Sync overlay whenever annotations or selection changes
  useEffect(() => {
    redrawOverlay(annotations, selectedAnnId, activePage);
  }, [annotations, selectedAnnId, activePage, redrawOverlay]);

  // ── Active page rendering ─────────────────────────────────────────────────

  useEffect(() => {
    if (activePage && pdfDocRef.current) {
      const entry = pages.find((p) => p.id === activePage);
      if (entry && entry.pageNum > 0) renderPage(entry.pageNum);
    }
  }, [activePage, viewScale, renderPage]);

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

    try {
      const pdfjsLib = await loadPdfjsLib();
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      pdfDocRef.current = pdf;

      const entries: PageEntry[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 0.25 });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
        entries.push({ id: uid(), pageNum: i, thumbnail: c.toDataURL('image/jpeg', 0.65) });
        setLoadProgress(Math.round((i / pdf.numPages) * 100));
      }

      setPages(entries);
      if (entries.length > 0) {
        setActivePage(entries[0].id);
        renderPage(1, pdf);
      }
    } catch (e: any) {
      setError('Failed to load PDF: ' + (e.message ?? String(e)));
    } finally {
      setLoading(false);
    }
  };

  // ── Overlay canvas coords ─────────────────────────────────────────────────

  function getOverlayPos(e: React.MouseEvent): { x: number; y: number } {
    const rect = overlayRef.current!.getBoundingClientRect();
    const sx = overlayRef.current!.width / rect.width;
    const sy = overlayRef.current!.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  // ── Overlay mouse events ──────────────────────────────────────────────────

  const onOverlayDown = (e: React.MouseEvent) => {
    if (!activePageRef.current) return;
    const pos = getOverlayPos(e);
    const t = toolRef.current;
    const ia = interactRef.current;

    if (t === 'text') {
      const txt = textInputRef.current || prompt('Enter annotation text:', '') || '';
      if (!txt) return;
      const newAnn: Annotation = {
        id: uid(), pageId: activePageRef.current, type: 'text',
        x: pos.x, y: pos.y, w: txt.length * 9, h: 20,
        color: colorRef.current, text: txt,
      };
      const next = [...annotationsRef.current, newAnn];
      annotationsRef.current = next;
      setAnnotations(next);
      setSelectedAnnId(newAnn.id);
      setTool('select');
      return;
    }

    if (t === 'select') {
      const pageAnns = annotationsRef.current.filter((a) => a.pageId === activePageRef.current);

      // Check handles first
      const selId = selectedAnnRef.current;
      const selAnn = selId ? pageAnns.find((a) => a.id === selId) : null;
      if (selAnn && selAnn.type !== 'text') {
        const h = handleAtPoint(selAnn, pos.x, pos.y);
        if (h) {
          ia.mode = 'resize';
          ia.handle = h;
          ia.startX = pos.x; ia.startY = pos.y;
          ia.origAnn = { ...selAnn };
          ia.drawing = true;
          return;
        }
      }

      // Hit test annotations (topmost first)
      const hit = [...pageAnns].reverse().find((a) => annHitTest(a, pos.x, pos.y));
      if (hit) {
        setSelectedAnnId(hit.id);
        selectedAnnRef.current = hit.id;
        ia.mode = 'move';
        ia.startX = pos.x; ia.startY = pos.y;
        ia.origAnn = { ...hit };
        ia.drawing = true;
      } else {
        setSelectedAnnId(null);
        selectedAnnRef.current = null;
      }
      return;
    }

    if (t === 'rect') {
      ia.mode = 'create-rect';
      ia.startX = pos.x; ia.startY = pos.y;
      ia.drawing = true;
    }
  };

  const onOverlayMove = (e: React.MouseEvent) => {
    const ia = interactRef.current;
    if (!ia.drawing || !activePageRef.current) return;
    const pos = getOverlayPos(e);

    if (ia.mode === 'create-rect') {
      const x = Math.min(ia.startX, pos.x);
      const y = Math.min(ia.startY, pos.y);
      const w = Math.abs(pos.x - ia.startX);
      const h = Math.abs(pos.y - ia.startY);
      // Show live preview
      const currentAnns = annotationsRef.current;
      redrawOverlay(currentAnns, selectedAnnRef.current, activePageRef.current);
      const ctx = overlayRef.current!.getContext('2d')!;
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = colorRef.current;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colorRef.current;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
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
        // Resize via corner handles
        updated = { ...orig };
        switch (ia.handle) {
          case 'nw': updated.x = orig.x + dx; updated.y = orig.y + dy; updated.w = orig.w - dx; updated.h = orig.h - dy; break;
          case 'ne': updated.y = orig.y + dy; updated.w = orig.w + dx; updated.h = orig.h - dy; break;
          case 'se': updated.w = orig.w + dx; updated.h = orig.h + dy; break;
          case 'sw': updated.x = orig.x + dx; updated.w = orig.w - dx; updated.h = orig.h + dy; break;
        }
        // Clamp to minimum size
        if (updated.w < 10) { updated.w = 10; if (ia.handle?.includes('w')) updated.x = orig.x + orig.w - 10; }
        if (updated.h < 10) { updated.h = 10; if (ia.handle?.includes('n')) updated.y = orig.y + orig.h - 10; }
      }

      const next = annotationsRef.current.map((a) =>
        a.id === updated.id ? updated : a,
      );
      annotationsRef.current = next;
      setAnnotations(next);
    }
  };

  const onOverlayUp = (e: React.MouseEvent) => {
    const ia = interactRef.current;
    if (!ia.drawing || !activePageRef.current) return;
    const pos = getOverlayPos(e);

    if (ia.mode === 'create-rect') {
      const w = Math.abs(pos.x - ia.startX);
      const h = Math.abs(pos.y - ia.startY);
      if (w > 5 && h > 5) {
        const newAnn: Annotation = {
          id: uid(), pageId: activePageRef.current, type: 'rect',
          x: Math.min(ia.startX, pos.x), y: Math.min(ia.startY, pos.y), w, h,
          color: colorRef.current,
        };
        const next = [...annotationsRef.current, newAnn];
        annotationsRef.current = next;
        setAnnotations(next);
        setSelectedAnnId(newAnn.id);
        selectedAnnRef.current = newAnn.id;
        setTool('select');
      }
    }

    ia.drawing = false;
    ia.mode = null;
    ia.handle = null;
    ia.origAnn = null;
  };

  // ── Image annotation ──────────────────────────────────────────────────────

  const addImageAnnotation = (file: File) => {
    if (!activePage) return;
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imageCache.current.set(src, img);
      // Default size: fit within 300×300
      const scale = Math.min(1, 300 / img.naturalWidth, 300 / img.naturalHeight);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const newAnn: Annotation = {
        id: uid(), pageId: activePage, type: 'image',
        x: 20, y: 20, w, h,
        color: '#000', imageSrc: src,
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
    setPages((p) => [...p, { id, pageNum: -1, thumbnail: '' }]);
  };

  const clearPageAnnotations = () => {
    if (!activePage) return;
    const next = annotations.filter((a) => a.pageId !== activePage);
    annotationsRef.current = next;
    setAnnotations(next);
    setSelectedAnnId(null);
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
    if (!pdfDocRef.current || !fileRef.current) return;
    setSaving(true);
    try {
      const { PDFDocument } = await import('pdf-lib');
      const originalBytes = await fileRef.current.arrayBuffer();
      const srcDoc = await PDFDocument.load(originalBytes);
      const newDoc = await PDFDocument.create();

      for (const entry of pages) {
        if (entry.pageNum === -1) {
          newDoc.addPage([595, 842]);
        } else {
          const [copied] = await newDoc.copyPages(srcDoc, [entry.pageNum - 1]);
          newDoc.addPage(copied);
        }
      }

      // Embed annotations as image layers
      for (let i = 0; i < pages.length; i++) {
        const entry = pages[i];
        const pageAnns = annotations.filter((a) => a.pageId === entry.id);
        if (pageAnns.length === 0) continue;
        if (entry.pageNum < 1) continue;

        const pdfPage = newDoc.getPage(i);
        const { width, height } = pdfPage.getSize();
        const SCALE = 2;

        const srcPage = await pdfDocRef.current.getPage(entry.pageNum);
        const vp = srcPage.getViewport({ scale: SCALE });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        const ctx = c.getContext('2d')!;
        await srcPage.render({ canvasContext: ctx, viewport: vp }).promise;

        const scaleX = vp.width / width;
        const scaleY = vp.height / height;

        pageAnns.forEach((ann) => {
          ctx.save();
          if (ann.type === 'rect') {
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = ann.color;
            ctx.fillRect(ann.x * scaleX, ann.y * scaleY, ann.w * scaleX, ann.h * scaleY);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = ann.color;
            ctx.lineWidth = 2;
            ctx.strokeRect(ann.x * scaleX, ann.y * scaleY, ann.w * scaleX, ann.h * scaleY);
          } else if (ann.type === 'text' && ann.text) {
            ctx.font = `bold ${16 * SCALE}px sans-serif`;
            ctx.fillStyle = ann.color;
            ctx.fillText(ann.text, ann.x * scaleX, ann.y * scaleY);
          } else if (ann.type === 'image' && ann.imageSrc) {
            const img = imageCache.current.get(ann.imageSrc);
            if (img) ctx.drawImage(img, ann.x * scaleX, ann.y * scaleY, ann.w * scaleX, ann.h * scaleY);
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

  // ── Selected annotation for property panel ────────────────────────────────

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

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={S.card}>
        <h1 style={S.h1}>📄 PDF Editor</h1>
        <p style={S.p}>Load a PDF to reorder/delete pages, add highlight boxes, text labels, and images, then save.</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <label style={{ ...S.btn(), cursor: 'pointer', display: 'inline-block' }}>
            📂 Open PDF
            <input type='file' accept='application/pdf' style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && loadPdf(e.target.files[0])} />
          </label>
          {pages.length > 0 && (
            <>
              <button style={S.btn('#fff', '#000')} onClick={addBlankPage}>+ Blank page</button>
              <button style={S.btn('#0a0', '#fff', saving)} onClick={savePdf} disabled={saving}>
                {saving ? 'Saving…' : '⬇ Save PDF'}
              </button>
            </>
          )}
        </div>
        {loading && <p style={{ ...S.p, marginTop: 8, color: '#555' }}>Loading… {loadProgress}%</p>}
        {error && <p style={{ ...S.p, color: '#c00', marginTop: 8 }}>{error}</p>}
      </div>

      {pages.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr 210px', gap: 12, alignItems: 'start' }}>

          {/* Page list */}
          <div style={{ ...S.card, padding: 10 }}>
            <h2 style={S.h2}>Pages ({pages.length})</h2>
            <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              {pages.map((p, idx) => (
                <div
                  key={p.id}
                  onClick={() => setActivePage(p.id)}
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

          {/* Main canvas */}
          <div>
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
                {tool === 'text' && (
                  <input value={textInput} onChange={(e) => setTextInput(e.target.value)}
                    placeholder='Text to add…'
                    style={{ border: '2px solid #000', padding: '4px 8px', fontSize: 12, fontFamily: 'Poppins, sans-serif' }} />
                )}
                {tool === 'image' && (
                  <label style={{ ...S.btn('#fff', '#000'), cursor: 'pointer' }}>
                    Choose image…
                    <input type='file' accept='image/*' style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && addImageAnnotation(e.target.files[0])} />
                  </label>
                )}
                <span style={{ marginLeft: 'auto', fontFamily: 'Poppins, sans-serif', fontSize: 11 }}>
                  Zoom: {Math.round(viewScale * 100)}%
                </span>
                <input type='range' min={0.5} max={2.5} step={0.1} value={viewScale}
                  onChange={(e) => setViewScale(parseFloat(e.target.value))} style={{ width: 80 }} />
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

            {/* Canvas */}
            <div style={{ border: '3px solid #000', background: '#888', overflow: 'auto', maxHeight: '75vh', boxShadow: '5px 5px 0 #000' }}>
              <div style={{ display: 'block', position: 'relative', margin: '12px auto', width: 'fit-content' }}>
                <canvas ref={canvasRef} style={{ display: 'block' }} />
                <canvas
                  ref={overlayRef}
                  style={{ position: 'absolute', top: 0, left: 0, cursor: tool === 'text' ? 'text' : tool === 'select' ? 'default' : 'crosshair' }}
                  onMouseDown={onOverlayDown}
                  onMouseMove={onOverlayMove}
                  onMouseUp={onOverlayUp}
                />
              </div>
            </div>
          </div>

          {/* Properties panel */}
          <div style={S.card}>
            <h2 style={S.h2}>Properties</h2>

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
                    <input
                      value={selAnn.text ?? ''}
                      onChange={(e) => updateSelAnn({ text: e.target.value, w: e.target.value.length * 9 })}
                      style={{ border: '1px solid #000', padding: '4px 6px', width: '100%', boxSizing: 'border-box', fontFamily: 'Poppins, sans-serif', fontSize: 12, marginBottom: 8 }}
                    />
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
              </>
            ) : (
              <p style={{ ...S.p, color: '#888' }}>
                Select an annotation to edit its properties.
                <br /><br />
                <strong>Tips:</strong><br />
                · Drag to move<br />
                · Drag corner handles to resize<br />
                · Delete key removes selected<br />
                · Escape to deselect
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
