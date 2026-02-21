import { useState, useRef, useEffect, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Adjustments {
  brightness: number;   // -100 to +100
  contrast: number;     // -100 to +100
  saturation: number;   // -100 to +100
  hue: number;          // -180 to +180
  highlights: number;   // -100 to +100  (lift/lower highlights)
  shadows: number;      // -100 to +100  (lift/lower shadows)
  temperature: number;  // -100 to +100  (cool/warm)
  tint: number;         // -100 to +100  (green/magenta)
  vignette: number;     // 0 to 100
}

const defaultAdj: Adjustments = {
  brightness: 0, contrast: 0, saturation: 0, hue: 0,
  highlights: 0, shadows: 0, temperature: 0, tint: 0, vignette: 0,
};

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  card: { border: '3px solid #000', background: '#fff', padding: '16px', marginBottom: '12px', boxShadow: '4px 4px 0 #000' } as React.CSSProperties,
  h1: { fontFamily: 'DM Serif Text, serif', fontSize: 34, marginBottom: 6 } as React.CSSProperties,
  h2: { fontFamily: 'DM Serif Text, serif', fontSize: 20, marginBottom: 10 } as React.CSSProperties,
  label: { display: 'flex', justifyContent: 'space-between', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 12, marginBottom: 3 } as React.CSSProperties,
  p: { fontFamily: 'Poppins, sans-serif', fontSize: 14 } as React.CSSProperties,
  btn: (bg = '#000', fg = '#fff', disabled = false) => ({
    border: '2px solid #000', background: disabled ? '#ccc' : bg, color: disabled ? '#888' : fg,
    padding: '7px 14px', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 13,
    cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: disabled ? 'none' : '3px 3px 0 #000', marginRight: 8,
  } as React.CSSProperties),
};

// ── Image pixel processing ────────────────────────────────────────────────────

function applyAdjustments(src: ImageData, adj: Adjustments): ImageData {
  const { data, width, height } = src;
  const out = new ImageData(width, height);
  const d = out.data;

  const brightness = adj.brightness / 100;
  const contrast = adj.contrast / 100;
  const saturation = adj.saturation / 100;
  const hueRad = (adj.hue / 180) * Math.PI;
  const temperature = adj.temperature / 100;
  const tint = adj.tint / 100;
  const highlights = adj.highlights / 100;
  const shadows = adj.shadows / 100;

  // Precompute contrast factor
  const cf = Math.tan(((contrast + 1) * Math.PI) / 4);

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255;
    let g = data[i + 1] / 255;
    let b = data[i + 2] / 255;
    const a = data[i + 3];

    // Brightness
    r += brightness;
    g += brightness;
    b += brightness;

    // Contrast (S-curve style)
    r = (r - 0.5) * cf + 0.5;
    g = (g - 0.5) * cf + 0.5;
    b = (b - 0.5) * cf + 0.5;

    // Temperature (warm = more red/yellow, cool = more blue)
    r += temperature * 0.1;
    g += temperature * 0.05;
    b -= temperature * 0.1;

    // Tint (green/magenta)
    r += tint * 0.05;
    g -= tint * 0.1;
    b += tint * 0.05;

    // Clamp before luminance-sensitive ops
    r = Math.max(0, Math.min(1, r));
    g = Math.max(0, Math.min(1, g));
    b = Math.max(0, Math.min(1, b));

    // Highlights/shadows (luma-based)
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (highlights !== 0) {
      const w = Math.pow(luma, 2); // weights highlights toward bright
      r += highlights * w * 0.3;
      g += highlights * w * 0.3;
      b += highlights * w * 0.3;
    }
    if (shadows !== 0) {
      const w = Math.pow(1 - luma, 2); // weights shadows toward dark
      r += shadows * w * 0.3;
      g += shadows * w * 0.3;
      b += shadows * w * 0.3;
    }

    // Saturation (convert to HSL-ish, adjust S)
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const chroma = maxC - minC;
    const lumaNew = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (chroma > 0.001) {
      const scale = 1 + saturation;
      r = lumaNew + (r - lumaNew) * scale;
      g = lumaNew + (g - lumaNew) * scale;
      b = lumaNew + (b - lumaNew) * scale;
    }

    // Hue rotation (using matrix in linear RGB space)
    if (hueRad !== 0) {
      const cosH = Math.cos(hueRad);
      const sinH = Math.sin(hueRad);
      const nr = r * (0.213 + cosH * 0.787 - sinH * 0.213) + g * (0.213 - cosH * 0.213 + sinH * 0.143) + b * (0.213 - cosH * 0.213 - sinH * 0.787);
      const ng = r * (0.715 - cosH * 0.715 - sinH * 0.715) + g * (0.715 + cosH * 0.285 + sinH * 0.140) + b * (0.715 - cosH * 0.715 + sinH * 0.715);
      const nb = r * (0.072 - cosH * 0.072 + sinH * 0.928) + g * (0.072 - cosH * 0.072 - sinH * 0.283) + b * (0.072 + cosH * 0.928 + sinH * 0.072);
      r = nr; g = ng; b = nb;
    }

    d[i] = Math.round(Math.max(0, Math.min(1, r)) * 255);
    d[i + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
    d[i + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    d[i + 3] = a;
  }

  // Vignette
  if (adj.vignette > 0) {
    const cx = width / 2, cy = height / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    const strength = adj.vignette / 100;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist;
        const factor = 1 - strength * Math.pow(dist, 2);
        d[idx] = Math.round(d[idx] * factor);
        d[idx + 1] = Math.round(d[idx + 1] * factor);
        d[idx + 2] = Math.round(d[idx + 2] * factor);
      }
    }
  }

  return out;
}

// ── Slider component ──────────────────────────────────────────────────────────

function Slider({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={S.label}>
        <span>{label}</span>
        <span style={{ fontFamily: 'monospace' }}>{value > 0 ? '+' : ''}{value}</span>
      </div>
      <input
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#000' }}
      />
    </div>
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

  const originalRef = useRef<ImageData | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const render = useCallback((adjustments: Adjustments) => {
    if (!originalRef.current || !canvasRef.current) return;
    setRendering(true);
    if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    renderTimeoutRef.current = setTimeout(() => {
      const out = applyAdjustments(originalRef.current!, adjustments);
      canvasRef.current!.getContext('2d')!.putImageData(out, 0, 0);
      setRendering(false);
    }, 30);
  }, []);

  const loadFile = async (f: File) => {
    const isTiff = f.type === 'image/tiff' || f.type === 'image/x-tiff' || /\.tiff?$/i.test(f.name);
    if (!f.type.startsWith('image/') && !isTiff) return;
    setFile(f);
    setAdj(defaultAdj);
    setLoadError(null);

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

        const maxW = 1200, maxH = 800;
        const scale = Math.min(1, maxW / srcW, maxH / srcH);
        const dw = Math.round(srcW * scale);
        const dh = Math.round(srcH * scale);

        if (canvasRef.current) {
          // Paint raw RGBA onto a temp canvas, then scale-draw to the display canvas
          const tmp = document.createElement('canvas');
          tmp.width = srcW; tmp.height = srcH;
          tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), srcW, srcH), 0, 0);

          canvasRef.current.width = dw;
          canvasRef.current.height = dh;
          const ctx = canvasRef.current.getContext('2d')!;
          ctx.drawImage(tmp, 0, 0, dw, dh);
          originalRef.current = ctx.getImageData(0, 0, dw, dh);
        }
      } catch (e: any) {
        setLoadError('Failed to load TIFF: ' + (e.message ?? String(e)));
      }
      return;
    }

    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const maxW = 1200, maxH = 800;
      const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      if (canvasRef.current) {
        canvasRef.current.width = w;
        canvasRef.current.height = h;
        const ctx = canvasRef.current.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        originalRef.current = ctx.getImageData(0, 0, w, h);
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => setLoadError('Failed to load image. Try a different format.');
    img.src = url;
  };

  const updateAdj = (key: keyof Adjustments) => (v: number) => {
    const next = { ...adj, [key]: v };
    setAdj(next);
    render(next);
  };

  const reset = () => {
    setAdj(defaultAdj);
    if (originalRef.current && canvasRef.current) {
      canvasRef.current.getContext('2d')!.putImageData(originalRef.current, 0, 0);
    }
  };

  const download = () => {
    if (!canvasRef.current || !file) return;
    const isTiff = /\.tiff?$/i.test(file.name);
    // TIFF can't be written by canvas — save as PNG instead
    const ext = isTiff ? 'png' : (file.name.match(/\.(jpe?g|png|webp)$/i)?.[1] ?? 'jpg');
    const type = ext.startsWith('j') ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const a = document.createElement('a');
    a.href = canvasRef.current.toDataURL(type, 0.92);
    a.download = file.name.replace(/\.[^.]+$/, `-edited.${ext === 'jpeg' ? 'jpg' : ext}`);
    a.click();
  };

  const hasChanges = Object.values(adj).some((v) => v !== 0);

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={S.card}>
        <h1 style={S.h1}>🎨 Color Editor</h1>
        <p style={S.p}>Color-grade photos with non-destructive adjustments. Processing happens entirely in your browser.</p>
      </div>

      {!file && (
        <div
          onClick={() => document.getElementById('color-input')?.click()}
          style={{ ...S.card, textAlign: 'center', padding: '60px 20px', cursor: 'pointer', minHeight: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}
        >
          <input id='color-input' type='file' accept='image/*,.tif,.tiff' style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
          <span style={{ fontSize: 52 }}>📷</span>
          <p style={{ ...S.p, fontWeight: 700, fontSize: 16 }}>Drop an image here or click to open</p>
          <p style={{ ...S.p, fontSize: 12, color: '#666' }}>JPEG · PNG · WebP · TIFF</p>
        </div>
      )}
      {loadError && <p style={{ ...S.p, color: '#c00', marginBottom: 12 }}>{loadError}</p>}

      {file && (
        <div
          style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 12, alignItems: 'start' }}
        >
          {/* Controls panel */}
          <div>
            <div style={S.card}>
              <h2 style={S.h2}>Tone</h2>
              <Slider label='Brightness' value={adj.brightness} min={-100} max={100} onChange={updateAdj('brightness')} />
              <Slider label='Contrast' value={adj.contrast} min={-100} max={100} onChange={updateAdj('contrast')} />
              <Slider label='Highlights' value={adj.highlights} min={-100} max={100} onChange={updateAdj('highlights')} />
              <Slider label='Shadows' value={adj.shadows} min={-100} max={100} onChange={updateAdj('shadows')} />
            </div>

            <div style={S.card}>
              <h2 style={S.h2}>Color</h2>
              <Slider label='Saturation' value={adj.saturation} min={-100} max={100} onChange={updateAdj('saturation')} />
              <Slider label='Hue' value={adj.hue} min={-180} max={180} onChange={updateAdj('hue')} />
              <Slider label='Temperature' value={adj.temperature} min={-100} max={100} onChange={updateAdj('temperature')} />
              <Slider label='Tint' value={adj.tint} min={-100} max={100} onChange={updateAdj('tint')} />
            </div>

            <div style={S.card}>
              <h2 style={S.h2}>Effects</h2>
              <Slider label='Vignette' value={adj.vignette} min={0} max={100} onChange={updateAdj('vignette')} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button style={S.btn()} onClick={download} disabled={!hasChanges}>⬇ Download</button>
              <button style={S.btn('#fff', '#000')} onClick={reset} disabled={!hasChanges}>↺ Reset</button>
              <button style={S.btn('#eee', '#000')} onClick={() => { document.getElementById('color-input')?.click(); }}>
                📂 Open different image
              </button>
              <input id='color-input' type='file' accept='image/*,.tif,.tiff' style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
            </div>
          </div>

          {/* Canvas */}
          <div style={{ position: 'relative' }}>
            {rendering && (
              <div style={{ position: 'absolute', top: 8, right: 8, background: '#000', color: '#fff', padding: '4px 10px', fontFamily: 'Poppins, sans-serif', fontSize: 12, zIndex: 10 }}>
                Rendering…
              </div>
            )}
            <canvas
              ref={canvasRef}
              style={{ border: '3px solid #000', display: 'block', maxWidth: '100%', boxShadow: '5px 5px 0 #000' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
