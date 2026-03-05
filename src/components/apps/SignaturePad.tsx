import { useState, useRef, useEffect } from 'react';

async function loadPeer(): Promise<typeof import('peerjs').Peer> {
  const { Peer } = await import('peerjs');
  return Peer;
}

type Status = 'loading' | 'connecting' | 'ready' | 'sent' | 'error';

const S = {
  btn: (bg = '#000', fg = '#fff') => ({
    border: '3px solid #000', background: bg, color: fg,
    padding: '14px 20px', fontFamily: 'Poppins, sans-serif',
    fontWeight: 700, fontSize: 16, cursor: 'pointer',
    boxShadow: '4px 4px 0 #000', flex: 1,
  } as React.CSSProperties),
};

export default function SignaturePad() {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peerRef = useRef<any>(null);
  const connRef = useRef<any>(null);
  const drawingRef = useRef(false);
  const hasStrokesRef = useRef(false);

  // Connect to the PDF editor peer using the code in the URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const c = params.get('c');
    if (!c) { setError('No connection code in URL.'); setStatus('error'); return; }

    let info: { id: string };
    try { info = JSON.parse(atob(c)); } catch {
      setError('Invalid connection code.'); setStatus('error'); return;
    }

    setStatus('connecting');
    (async () => {
      try {
        const Peer = await loadPeer();
        const peer = new Peer();
        peerRef.current = peer;
        peer.on('open', () => {
          const conn = peer.connect(info.id, { reliable: true });
          connRef.current = conn;
          conn.on('open', () => setStatus('ready'));
          conn.on('error', (e: any) => { setError(String(e)); setStatus('error'); });
        });
        peer.on('error', (e: any) => { setError(String(e)); setStatus('error'); });
      } catch (e: any) {
        setError(String(e)); setStatus('error');
      }
    })();

    return () => { try { peerRef.current?.destroy(); } catch {} };
  }, []);

  // Init canvas dimensions once ready + re-init on resize/rotate (clears drawing)
  useEffect(() => {
    if (status !== 'ready') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const initCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      hasStrokesRef.current = false;
    };

    initCanvas();
    window.addEventListener('resize', initCanvas);
    return () => window.removeEventListener('resize', initCanvas);
  }, [status]);

  // Touch and mouse drawing
  useEffect(() => {
    if (status !== 'ready') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getPos = (e: TouchEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      if ('touches' in e && e.touches.length > 0) {
        return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
      }
      return { x: (e as MouseEvent).clientX - rect.left, y: (e as MouseEvent).clientY - rect.top };
    };

    const onStart = (e: TouchEvent | MouseEvent) => {
      e.preventDefault();
      drawingRef.current = true;
      hasStrokesRef.current = true;
      const pos = getPos(e);
      const ctx = canvas.getContext('2d')!;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    };

    const onMove = (e: TouchEvent | MouseEvent) => {
      e.preventDefault();
      if (!drawingRef.current) return;
      const pos = getPos(e);
      const ctx = canvas.getContext('2d')!;
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    };

    const onEnd = () => { drawingRef.current = false; };

    canvas.addEventListener('touchstart', onStart, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onEnd);
    canvas.addEventListener('mousedown', onStart);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onEnd);
    canvas.addEventListener('mouseleave', onEnd);

    return () => {
      canvas.removeEventListener('touchstart', onStart);
      canvas.removeEventListener('touchmove', onMove);
      canvas.removeEventListener('touchend', onEnd);
      canvas.removeEventListener('mousedown', onStart);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseup', onEnd);
      canvas.removeEventListener('mouseleave', onEnd);
    };
  }, [status]);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    hasStrokesRef.current = false;
  };

  const sendSignature = () => {
    const canvas = canvasRef.current;
    const conn = connRef.current;
    if (!canvas || !conn) return;
    // Crop to bounding box of drawn content so the transparent PNG is tight
    const dataUrl = cropSignature(canvas);
    // Send as object — PeerJS binary serialization delivers it as a parsed object on the receiver
    conn.send({ type: 'signature', dataUrl });
    setStatus('sent');
    // Do NOT destroy the peer here — conn.send() only queues the data;
    // destroying immediately drops it before WebRTC can flush the buffer.
    // The PDF editor destroys its peer after receiving, which closes this
    // connection naturally. The useEffect cleanup handles the rest on tab close.
  };

  // Crops canvas to the tightest bounding box around actual ink pixels
  function cropSignature(canvas: HTMLCanvasElement): string {
    const ctx = canvas.getContext('2d')!;
    const { width, height } = canvas;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    // Nothing drawn — return full canvas
    if (minX > maxX || minY > maxY) return canvas.toDataURL('image/png');
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = cropW; out.height = cropH;
    out.getContext('2d')!.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
    return out.toDataURL('image/png');
  }

  // ── Screens ────────────────────────────────────────────────────────────────

  const centerScreen = (children: React.ReactNode) => (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', padding: 24, fontFamily: 'Poppins, sans-serif' }}>
      {children}
    </div>
  );

  if (status === 'loading' || status === 'connecting') {
    return centerScreen(
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>✍</div>
        <p style={{ fontSize: 16 }}>{status === 'loading' ? 'Loading…' : 'Connecting to PDF editor…'}</p>
      </div>
    );
  }

  if (status === 'error') {
    return centerScreen(
      <p style={{ color: '#c00', fontSize: 15, textAlign: 'center' }}>Error: {error}</p>
    );
  }

  if (status === 'sent') {
    return centerScreen(
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>✓</div>
        <p style={{ fontFamily: 'DM Serif Text, serif', fontSize: 26, marginBottom: 8 }}>Signature sent!</p>
        <p style={{ fontSize: 13, color: '#555' }}>You can close this tab.</p>
      </div>
    );
  }

  // status === 'ready'
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}>
      {/* Header */}
      <div style={{ borderBottom: '3px solid #000', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff', flexShrink: 0 }}>
        <span style={{ fontFamily: 'DM Serif Text, serif', fontSize: 22 }}>Draw your signature</span>
        <span style={{ fontSize: 12, color: '#555', fontFamily: 'Poppins, sans-serif' }}>Use your finger below</span>
      </div>

      {/* Drawing guide line */}
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: 'crosshair', background: '#fafafa' }}
        />
        {/* Baseline guide */}
        <div style={{ position: 'absolute', left: 20, right: 20, bottom: '35%', borderBottom: '2px dashed #ccc', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', left: 24, bottom: 'calc(35% + 6px)', fontFamily: 'Poppins, sans-serif', fontSize: 11, color: '#ccc', pointerEvents: 'none' }}>
          Sign above this line
        </div>
      </div>

      {/* Footer buttons */}
      <div style={{ borderTop: '3px solid #000', padding: '12px 16px', display: 'flex', gap: 12, background: '#fff', flexShrink: 0 }}>
        <button style={S.btn('#fff', '#000')} onClick={clearCanvas}>Clear</button>
        <button style={S.btn('#000', '#fff')} onClick={sendSignature}>Send signature</button>
      </div>
    </div>
  );
}
