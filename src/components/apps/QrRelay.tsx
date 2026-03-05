import { useState, useRef, useEffect } from 'react';

async function loadPeer(): Promise<typeof import('peerjs').Peer> {
  const { Peer } = await import('peerjs');
  return Peer;
}

async function renderQr(text: string, canvas: HTMLCanvasElement) {
  const QRCode = (await import('qrcode')).default;
  await QRCode.toCanvas(canvas, text, { width: 200, margin: 2, color: { dark: '#000', light: '#fff' } });
}

type Status = 'idle' | 'waiting' | 'received' | 'error';

const S = {
  btn: (bg = '#000', fg = '#fff', disabled = false) => ({
    border: '3px solid #000', background: disabled ? '#ccc' : bg, color: disabled ? '#888' : fg,
    padding: '10px 18px', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: disabled ? 'none' : '3px 3px 0 #000',
  } as React.CSSProperties),
};

function isUrl(s: string) {
  try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; }
}

export default function QrRelay() {
  const [status, setStatus] = useState<Status>('idle');
  const [scanUrl, setScanUrl] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const peerRef = useRef<any>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (scanUrl && qrCanvasRef.current) {
      renderQr(scanUrl, qrCanvasRef.current).catch(() => {});
    }
  }, [scanUrl]);

  useEffect(() => {
    return () => { try { peerRef.current?.destroy(); } catch {} };
  }, []);

  const start = async () => {
    if (peerRef.current) { try { peerRef.current.destroy(); } catch {} }
    setStatus('waiting');
    setScanUrl('');
    setResult('');
    setError('');
    setCopied(false);

    try {
      const Peer = await loadPeer();
      const peer = new Peer();
      peerRef.current = peer;

      peer.on('open', (id: string) => {
        const code = btoa(JSON.stringify({ id }));
        const url = `${window.location.origin}/apps/qr-scan?c=${encodeURIComponent(code)}`;
        setScanUrl(url);
        navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => {});
      });

      peer.on('connection', (conn: any) => {
        conn.on('data', (data: any) => {
          try {
            const msg = typeof data === 'string' ? JSON.parse(data) : data;
            if (msg?.type === 'qr' && msg.text != null) {
              setResult(msg.text);
              setStatus('received');
              try { peerRef.current?.destroy(); } catch {}
              peerRef.current = null;
            }
          } catch {}
        });
      });

      peer.on('error', () => { setStatus('error'); setError('Connection failed. Try again.'); });
    } catch (e: any) {
      setStatus('error');
      setError(String(e));
    }
  };

  const copyResult = () => {
    navigator.clipboard.writeText(result).catch(() => {});
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  const card: React.CSSProperties = {
    border: '3px solid #000', background: '#fff', padding: 20,
    boxShadow: '5px 5px 0 #000', marginBottom: 16,
  };

  if (status === 'idle') {
    return (
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={card}>
          <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
            Relay a QR code from your phone to this browser — no app needed.
            Click start, open the link on your phone, point the camera at any QR code, and the result appears here instantly.
          </p>
          <button style={S.btn()} onClick={start}>Start scanning session</button>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ ...card, background: '#fff0f0' }}>
          <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 14, color: '#c00', marginBottom: 16 }}>{error}</p>
          <button style={S.btn()} onClick={start}>Try again</button>
        </div>
      </div>
    );
  }

  if (status === 'received') {
    const resultIsUrl = isUrl(result);
    return (
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ ...card, background: '#f0fff4' }}>
          <p style={{ fontFamily: 'DM Serif Text, serif', fontSize: 22, marginBottom: 12 }}>QR code scanned</p>
          <div style={{ border: '2px solid #000', background: '#fff', padding: '10px 14px', marginBottom: 14, wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 13 }}>
            {result}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {resultIsUrl && (
              <a href={result} target='_blank' rel='noopener noreferrer'
                style={{ ...S.btn('#000', '#fff'), display: 'inline-block', textDecoration: 'none' }}>
                Open in new tab →
              </a>
            )}
            <button style={S.btn('#fff', '#000')} onClick={copyResult}>Copy</button>
            <button style={S.btn('#fff', '#000')} onClick={start}>Scan another</button>
          </div>
        </div>
      </div>
    );
  }

  // status === 'waiting'
  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <div style={card}>
        <p style={{ fontFamily: 'DM Serif Text, serif', fontSize: 20, marginBottom: 14 }}>
          Open the scanner on your phone
        </p>

        {scanUrl ? (
          <>
            {/* QR code of the relay URL */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
              <div style={{ border: '3px solid #000', padding: 8, background: '#fff', boxShadow: '3px 3px 0 #000', display: 'inline-block' }}>
                <canvas ref={qrCanvasRef} />
              </div>
            </div>

            <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 12, color: '#555', textAlign: 'center', marginBottom: 10 }}>
              Scan this QR with your phone camera to open the scanner
            </p>

            <div style={{ border: '1px solid #ccc', background: '#f9f9f9', padding: '8px 12px', fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', marginBottom: 10 }}>
              {scanUrl}
            </div>

            <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 12, color: copied ? '#0a0' : '#555', marginBottom: 14 }}>
              {copied ? 'Link copied to clipboard.' : 'Copy the link and open it on your phone.'}
            </p>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13, color: '#555' }}>
                Waiting for scan…
              </span>
              <button style={{ ...S.btn('#fff', '#000'), fontSize: 12, padding: '6px 12px' }} onClick={start}>
                Restart
              </button>
            </div>
          </>
        ) : (
          <p style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13, color: '#555' }}>Generating link…</p>
        )}
      </div>
    </div>
  );
}
