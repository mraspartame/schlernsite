import { useState, useRef, useEffect } from 'react';

async function loadPeer(): Promise<typeof import('peerjs').Peer> {
  const { Peer } = await import('peerjs');
  return Peer;
}

type Status = 'loading' | 'connecting' | 'scanning' | 'sent' | 'error' | 'unsupported';

const S = {
  btn: (bg = '#000', fg = '#fff') => ({
    border: '3px solid #000', background: bg, color: fg,
    padding: '14px 20px', fontFamily: 'Poppins, sans-serif',
    fontWeight: 700, fontSize: 16, cursor: 'pointer',
    boxShadow: '4px 4px 0 #000',
  } as React.CSSProperties),
};

export default function QrScanner() {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<any>(null);
  const connRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const sentRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const c = params.get('c');
    if (!c) { setError('No connection code in URL.'); setStatus('error'); return; }

    let info: { id: string };
    try { info = JSON.parse(atob(c)); } catch {
      setError('Invalid connection code.'); setStatus('error'); return;
    }

    if (!('BarcodeDetector' in window)) {
      setStatus('unsupported'); return;
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
          conn.on('open', () => startScanning());
          conn.on('error', (e: any) => { setError(String(e)); setStatus('error'); });
        });
        peer.on('error', (e: any) => { setError(String(e)); setStatus('error'); });
      } catch (e: any) {
        setError(String(e)); setStatus('error');
      }
    })();

    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try { peerRef.current?.destroy(); } catch {}
    };
  }, []);

  const startScanning = async () => {
    setStatus('scanning');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });

      const scan = async () => {
        if (sentRef.current) return;
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            const text = barcodes[0].rawValue;
            sentRef.current = true;
            connRef.current?.send({ type: 'qr', text });
            setStatus('sent');
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
        } catch {}
        rafRef.current = requestAnimationFrame(scan);
      };

      rafRef.current = requestAnimationFrame(scan);
    } catch (e: any) {
      setError('Camera access denied. Please allow camera permissions and try again.');
      setStatus('error');
    }
  };

  // ── Screens ──────────────────────────────────────────────────────────────────

  const centerScreen = (children: React.ReactNode) => (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', padding: 24, fontFamily: 'Poppins, sans-serif' }}>
      {children}
    </div>
  );

  if (status === 'loading' || status === 'connecting') {
    return centerScreen(
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>📷</div>
        <p style={{ fontSize: 16 }}>{status === 'loading' ? 'Loading…' : 'Connecting…'}</p>
      </div>
    );
  }

  if (status === 'unsupported') {
    return centerScreen(
      <div style={{ textAlign: 'center', maxWidth: 320 }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
        <p style={{ fontFamily: 'DM Serif Text, serif', fontSize: 22, marginBottom: 10 }}>Browser not supported</p>
        <p style={{ fontSize: 14, color: '#555', lineHeight: 1.6 }}>
          QR scanning requires Chrome or Safari on iOS 17+. Please open this link in a supported browser.
        </p>
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
        <p style={{ fontFamily: 'DM Serif Text, serif', fontSize: 26, marginBottom: 8 }}>Sent!</p>
        <p style={{ fontSize: 13, color: '#555' }}>The QR code was relayed to your desktop. You can close this tab.</p>
      </div>
    );
  }

  // status === 'scanning'
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#000' }}>
      {/* Camera feed */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        {/* Targeting overlay */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ width: 220, height: 220, position: 'relative' }}>
            {/* Corner brackets */}
            {[
              { top: 0, left: 0, borderTop: '4px solid #fff', borderLeft: '4px solid #fff' },
              { top: 0, right: 0, borderTop: '4px solid #fff', borderRight: '4px solid #fff' },
              { bottom: 0, left: 0, borderBottom: '4px solid #fff', borderLeft: '4px solid #fff' },
              { bottom: 0, right: 0, borderBottom: '4px solid #fff', borderRight: '4px solid #fff' },
            ].map((style, i) => (
              <div key={i} style={{ position: 'absolute', width: 30, height: 30, ...style }} />
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '16px 20px', background: '#000', borderTop: '3px solid #fff', textAlign: 'center' }}>
        <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 14, color: '#fff', margin: 0 }}>
          Point at a QR code to scan
        </p>
      </div>
    </div>
  );
}
