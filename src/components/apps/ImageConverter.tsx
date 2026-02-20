import { useState, useRef, useCallback } from 'react';

type Format = 'image/png' | 'image/jpeg' | 'image/webp';

const S = {
  card: { border: '3px solid #000', background: '#fff', padding: '20px', marginBottom: '16px', boxShadow: '5px 5px 0 #000' } as React.CSSProperties,
  h1: { fontFamily: 'DM Serif Text, serif', fontSize: 36, marginBottom: 8 } as React.CSSProperties,
  h2: { fontFamily: 'DM Serif Text, serif', fontSize: 22, marginBottom: 12 } as React.CSSProperties,
  label: { display: 'block', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 13, marginBottom: 4 } as React.CSSProperties,
  input: { border: '2px solid #000', padding: '6px 10px', fontFamily: 'Poppins, sans-serif', fontSize: 14, width: '100%', boxSizing: 'border-box' as const, marginBottom: 8 },
  select: { border: '2px solid #000', padding: '7px 10px', fontFamily: 'Poppins, sans-serif', fontSize: 14, background: '#fff', width: '100%' } as React.CSSProperties,
  btn: (bg = '#000', fg = '#fff') => ({ border: '2px solid #000', background: bg, color: fg, padding: '9px 18px', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 14, cursor: 'pointer', boxShadow: '3px 3px 0 #000', marginRight: 8 } as React.CSSProperties),
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' as const },
};

export default function ImageConverter() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [originalDims, setOriginalDims] = useState<{ w: number; h: number } | null>(null);

  const [format, setFormat] = useState<Format>('image/jpeg');
  const [quality, setQuality] = useState(90);
  const [resizeMode, setResizeMode] = useState<'none' | 'pixels' | 'percent'>('none');
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [percent, setPercent] = useState(50);
  const [keepAspect, setKeepAspect] = useState(true);

  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputSize, setOutputSize] = useState<number | null>(null);
  const [converting, setConverting] = useState(false);

  const dropRef = useRef<HTMLDivElement>(null);

  const loadFile = (f: File) => {
    if (!f.type.startsWith('image/')) return;
    setFile(f);
    setOutputUrl(null);
    const url = URL.createObjectURL(f);
    setPreview(url);
    const img = new Image();
    img.onload = () => {
      setOriginalDims({ w: img.naturalWidth, h: img.naturalHeight });
      setWidth(img.naturalWidth);
      setHeight(img.naturalHeight);
    };
    img.src = url;
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  }, []);

  const convert = async () => {
    if (!file || !preview) return;
    setConverting(true);
    try {
      const img = new Image();
      await new Promise<void>((res) => { img.onload = () => res(); img.src = preview; });

      let targetW = img.naturalWidth;
      let targetH = img.naturalHeight;

      if (resizeMode === 'pixels') {
        if (keepAspect) {
          const ratio = img.naturalWidth / img.naturalHeight;
          if (width / height > ratio) {
            targetW = Math.round(height * ratio);
            targetH = height;
          } else {
            targetW = width;
            targetH = Math.round(width / ratio);
          }
        } else {
          targetW = width;
          targetH = height;
        }
      } else if (resizeMode === 'percent') {
        targetW = Math.round((img.naturalWidth * percent) / 100);
        targetH = Math.round((img.naturalHeight * percent) / 100);
      }

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d')!;

      if (format === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);

      const q = format === 'image/png' ? undefined : quality / 100;
      canvas.toBlob((blob) => {
        if (!blob) return;
        if (outputUrl) URL.revokeObjectURL(outputUrl);
        const url = URL.createObjectURL(blob);
        setOutputUrl(url);
        setOutputSize(blob.size);
        setConverting(false);
      }, format, q);
    } catch {
      setConverting(false);
    }
  };

  const download = () => {
    if (!outputUrl || !file) return;
    const ext = format === 'image/jpeg' ? 'jpg' : format === 'image/webp' ? 'webp' : 'png';
    const base = file.name.replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = outputUrl;
    a.download = `${base}-converted.${ext}`;
    a.click();
  };

  const fmt = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(2)} MB`;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={S.card}>
        <h1 style={S.h1}>🖼️ Image Converter</h1>
        <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 14 }}>
          Convert between PNG, JPEG, and WebP. Resize by pixels or percentage.
        </p>
      </div>

      {/* Drop zone */}
      <div
        ref={dropRef}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => document.getElementById('img-input')?.click()}
        style={{
          ...S.card,
          textAlign: 'center',
          cursor: 'pointer',
          padding: '40px 20px',
          background: file ? '#f0fff0' : '#fff',
          minHeight: 140,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <input
          id='img-input'
          type='file'
          accept='image/*'
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
        />
        {file ? (
          <>
            <strong style={{ fontFamily: 'Poppins, sans-serif' }}>{file.name}</strong>
            <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13, color: '#555' }}>
              {originalDims ? `${originalDims.w} × ${originalDims.h}px` : ''} · {fmt(file.size)}
            </span>
            {preview && (
              <img src={preview} alt='preview' style={{ maxHeight: 180, maxWidth: '100%', border: '2px solid #000', marginTop: 8 }} />
            )}
          </>
        ) : (
          <>
            <span style={{ fontSize: 48 }}>📂</span>
            <p style={{ fontFamily: 'Poppins, sans-serif', fontWeight: 700 }}>Drop an image here or click to select</p>
            <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 12, color: '#666' }}>PNG, JPEG, WebP, GIF, AVIF, BMP…</p>
          </>
        )}
      </div>

      {file && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Format & quality */}
          <div style={S.card}>
            <h2 style={S.h2}>Output Format</h2>
            <label style={S.label}>Format</label>
            <select style={S.select} value={format} onChange={(e) => setFormat(e.target.value as Format)}>
              <option value='image/jpeg'>JPEG</option>
              <option value='image/png'>PNG (lossless)</option>
              <option value='image/webp'>WebP</option>
            </select>

            {format !== 'image/png' && (
              <div style={{ marginTop: 12 }}>
                <label style={S.label}>Quality: {quality}%</label>
                <input
                  type='range'
                  min={1}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(parseInt(e.target.value))}
                  style={{ width: '100%' }}
                />
              </div>
            )}
          </div>

          {/* Resize */}
          <div style={S.card}>
            <h2 style={S.h2}>Resize</h2>
            <label style={S.label}>Mode</label>
            <select style={S.select} value={resizeMode} onChange={(e) => setResizeMode(e.target.value as any)}>
              <option value='none'>No resize (original size)</option>
              <option value='pixels'>By pixels</option>
              <option value='percent'>By percentage</option>
            </select>

            {resizeMode === 'pixels' && (
              <>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label style={S.label}>Width (px)</label>
                    <input style={S.input} type='number' min={1} value={width} onChange={(e) => {
                      const w = parseInt(e.target.value) || 1;
                      setWidth(w);
                      if (keepAspect && originalDims) setHeight(Math.round(w / originalDims.w * originalDims.h));
                    }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={S.label}>Height (px)</label>
                    <input style={S.input} type='number' min={1} value={height} onChange={(e) => {
                      const h = parseInt(e.target.value) || 1;
                      setHeight(h);
                      if (keepAspect && originalDims) setWidth(Math.round(h / originalDims.h * originalDims.w));
                    }} />
                  </div>
                </div>
                <label style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13 }}>
                  <input type='checkbox' checked={keepAspect} onChange={(e) => setKeepAspect(e.target.checked)} />{' '}
                  Keep aspect ratio
                </label>
              </>
            )}

            {resizeMode === 'percent' && (
              <div style={{ marginTop: 8 }}>
                <label style={S.label}>Scale: {percent}%</label>
                <input type='range' min={1} max={200} value={percent} onChange={(e) => setPercent(parseInt(e.target.value))} style={{ width: '100%' }} />
                {originalDims && (
                  <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 12, color: '#555', marginTop: 4 }}>
                    Output: {Math.round(originalDims.w * percent / 100)} × {Math.round(originalDims.h * percent / 100)} px
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {file && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <button style={S.btn()} onClick={convert} disabled={converting}>
            {converting ? 'Converting…' : 'Convert'}
          </button>
          {outputUrl && (
            <button style={S.btn('#fff', '#000')} onClick={download}>
              ⬇ Download
            </button>
          )}
        </div>
      )}

      {outputUrl && outputSize !== null && (
        <div style={S.card}>
          <h2 style={S.h2}>Result</h2>
          <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13, marginBottom: 12 }}>
            Output size: <strong>{fmt(outputSize)}</strong>
            {file && <> (was {fmt(file.size)}, {Math.round((outputSize / file.size) * 100)}%)</>}
          </p>
          <img src={outputUrl} alt='converted' style={{ maxWidth: '100%', maxHeight: 400, border: '3px solid #000' }} />
        </div>
      )}
    </div>
  );
}
