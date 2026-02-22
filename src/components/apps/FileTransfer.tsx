import { useState, useRef, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = 'choose' | 'send' | 'receive';
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'transferring' | 'done' | 'error';

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  card: { border: '3px solid #000', background: '#fff', padding: '20px', marginBottom: '16px', boxShadow: '5px 5px 0 #000' } as React.CSSProperties,
  h1: { fontFamily: 'DM Serif Text, serif', fontSize: 34, marginBottom: 6 } as React.CSSProperties,
  h2: { fontFamily: 'DM Serif Text, serif', fontSize: 22, marginBottom: 10 } as React.CSSProperties,
  label: { display: 'block', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 13, marginBottom: 4 } as React.CSSProperties,
  p: { fontFamily: 'Poppins, sans-serif', fontSize: 14, marginBottom: 8 } as React.CSSProperties,
  code: { fontFamily: 'monospace', background: '#f0f0f0', border: '1px solid #ccc', padding: '12px 16px', display: 'block', fontSize: 13, wordBreak: 'break-all' as const, whiteSpace: 'pre-wrap' as const, maxHeight: 200, overflowY: 'auto' as const } as React.CSSProperties,
  textarea: { border: '2px solid #000', padding: '8px 12px', fontFamily: 'monospace', fontSize: 12, width: '100%', boxSizing: 'border-box' as const, height: 100, marginBottom: 8, resize: 'vertical' as const },
  btn: (bg = '#000', fg = '#fff', disabled = false) => ({
    border: '2px solid #000', background: disabled ? '#ccc' : bg, color: disabled ? '#888' : fg,
    padding: '9px 18px', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: disabled ? 'none' : '3px 3px 0 #000', marginRight: 8, marginBottom: 8,
  } as React.CSSProperties),
  bigBtn: (bg = '#000', fg = '#fff') => ({
    border: '3px solid #000', background: bg, color: fg, padding: '20px 32px',
    fontFamily: 'DM Serif Text, serif', fontSize: 24, cursor: 'pointer',
    boxShadow: '5px 5px 0 #000', display: 'block', width: '100%', textAlign: 'center' as const, marginBottom: 12,
  }),
};

// ── PeerJS loader ─────────────────────────────────────────────────────────────

async function loadPeer(): Promise<typeof import('peerjs').Peer> {
  const { Peer } = await import('peerjs');
  return Peer;
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{ border: '2px solid #000', height: 24, background: '#eee', position: 'relative', marginTop: 8 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: '#000', transition: 'width 0.2s' }} />
    </div>
  );
}

// ── Send side ─────────────────────────────────────────────────────────────────
// Flow: paste receiver's code → connect → pick file → send

function Sender({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<ConnectionState>('idle');
  const [receiveCode, setReceiveCode] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const peerRef = useRef<any>(null);
  const connRef = useRef<any>(null);

  const connect = async () => {
    if (!receiveCode.trim()) return;
    setState('connecting');
    setError('');
    try {
      const info = JSON.parse(atob(receiveCode.trim()));
      const Peer = await loadPeer();
      const peer = new Peer();
      peerRef.current = peer;
      peer.on('open', () => {
        const conn = peer.connect(info.id, { reliable: true, serialization: 'raw' });
        connRef.current = conn;
        conn.on('open', () => setState('connected'));
        conn.on('error', (e: any) => { setError(String(e)); setState('error'); });
      });
      peer.on('error', (e: any) => { setError(String(e)); setState('error'); });
    } catch (e: any) {
      setError('Invalid code: ' + String(e));
      setState('error');
    }
  };

  const sendFile = async () => {
    if (!file || !connRef.current) return;
    setState('transferring');
    const CHUNK       = 256 * 1024;       // 256 KB — fewer send() calls, less JS overhead
    const BUFFER_HIGH = 16 * 1024 * 1024; // pause when send buffer exceeds 16 MB
    const BUFFER_LOW  =  4 * 1024 * 1024; // resume once it drains below 4 MB
    const buf = await file.arrayBuffer();
    const total = buf.byteLength;

    connRef.current.send(JSON.stringify({ type: 'meta', name: file.name, size: total, mime: file.type }));

    // Access the underlying RTCDataChannel for backpressure control
    const dc: RTCDataChannel | undefined = connRef.current._dc;
    if (dc) dc.bufferedAmountLowThreshold = BUFFER_LOW;

    for (let offset = 0; offset < total; offset += CHUNK) {
      // Backpressure: if the send buffer is full, wait for it to drain before sending more.
      // Without this, large files overflow the buffer and chunks are silently dropped → corruption.
      if (dc && dc.bufferedAmount > BUFFER_HIGH) {
        await new Promise<void>((resolve) => {
          const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); resolve(); };
          dc.addEventListener('bufferedamountlow', onLow);
        });
      }
      connRef.current.send(buf.slice(offset, offset + CHUNK));
      // Update UI every 4 MB (not every chunk) — excessive setState calls block the main thread
      if (offset % (4 * 1024 * 1024) < CHUNK || offset + CHUNK >= total) {
        setProgress(Math.min(100, Math.round(((offset + CHUNK) / total) * 100)));
      }
      // Yield every 16 MB to keep the page responsive without adding significant latency
      if (offset % (16 * 1024 * 1024) < CHUNK) await new Promise((r) => setTimeout(r, 0));
    }

    connRef.current.send(JSON.stringify({ type: 'done' }));
    setState('done');
  };

  return (
    <div>
      <button style={S.btn('#fff', '#000')} onClick={onBack}>← Back</button>
      <h2 style={S.h2}>📤 Send a File</h2>

      {(state === 'idle' || state === 'connecting') && (
        <div style={S.card}>
          <p style={S.label}>Paste the receiver's code here</p>
          <textarea
            style={S.textarea}
            value={receiveCode}
            onChange={(e) => setReceiveCode(e.target.value)}
            placeholder='Paste the code the receiver gave you…'
            disabled={state === 'connecting'}
          />
          <button style={S.btn()} onClick={connect} disabled={!receiveCode.trim() || state === 'connecting'}>
            {state === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      )}

      {state === 'connected' && (
        <div style={S.card}>
          <p style={{ ...S.p, color: '#0a0', fontWeight: 700 }}>✓ Connected!</p>
          <p style={S.label}>Select the file to send</p>
          <input type='file' onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ marginBottom: 10 }} />
          {file && <p style={S.p}>{file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB</p>}
          <button style={S.btn()} onClick={sendFile} disabled={!file}>Send file</button>
        </div>
      )}

      {state === 'transferring' && (
        <div style={S.card}>
          <p style={S.p}>Sending… {progress}%</p>
          <ProgressBar pct={progress} />
        </div>
      )}

      {state === 'done' && <p style={{ ...S.p, color: '#0a0', fontWeight: 700 }}>✓ File sent successfully!</p>}
      {error && <p style={{ ...S.p, color: '#c00' }}>Error: {error}</p>}
    </div>
  );
}

// ── Receive side ──────────────────────────────────────────────────────────────
// Flow: start → share code → wait for sender to connect → file arrives automatically

function Receiver({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<ConnectionState>('idle');
  const [myCode, setMyCode] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [received, setReceived] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [error, setError] = useState('');

  const peerRef = useRef<any>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const metaRef = useRef<{ name: string; size: number; mime: string } | null>(null);
  const receivedBytesRef = useRef(0);
  const lastReportedRef = useRef(0);

  const start = useCallback(async () => {
    setState('connecting');
    setError('');
    try {
      const Peer = await loadPeer();
      const peer = new Peer();
      peerRef.current = peer;

      peer.on('open', (id: string) => {
        setMyCode(btoa(JSON.stringify({ id })));
        setState('connected'); // "connected" here means "listening / waiting for sender"
      });

      // This is the key fix: listen for the sender connecting TO us
      peer.on('connection', (conn: any) => {
        conn.on('data', (data: any) => {
          if (typeof data === 'string') {
            try {
              const msg = JSON.parse(data);
              if (msg.type === 'meta') {
                metaRef.current = { name: msg.name, size: msg.size, mime: msg.mime };
                setFileName(msg.name);
                setFileSize(msg.size);
                chunksRef.current = [];
                receivedBytesRef.current = 0;
                lastReportedRef.current = 0;
                setReceived(0);
                setState('transferring');
              } else if (msg.type === 'done') {
                const blob = new Blob(chunksRef.current, { type: metaRef.current?.mime ?? 'application/octet-stream' });
                setDownloadUrl(URL.createObjectURL(blob));
                setState('done');
              }
            } catch { /* ignore non-JSON strings */ }
          } else {
            // Binary chunk — handle both ArrayBuffer and Uint8Array
            const chunk = data instanceof ArrayBuffer ? data : (data as Uint8Array).buffer.slice(0) as ArrayBuffer;
            chunksRef.current.push(chunk);
            receivedBytesRef.current += chunk.byteLength;
            // Update UI every 4 MB to avoid re-renders throttling the transfer
            const REPORT_EVERY = 4 * 1024 * 1024;
            if (receivedBytesRef.current - lastReportedRef.current >= REPORT_EVERY ||
                receivedBytesRef.current >= (metaRef.current?.size ?? 0)) {
              lastReportedRef.current = receivedBytesRef.current;
              setReceived(receivedBytesRef.current);
            }
          }
        });
        conn.on('error', (e: any) => { setError(String(e)); setState('error'); });
      });

      peer.on('error', (e: any) => { setError(String(e)); setState('error'); });
    } catch (e: any) {
      setError(String(e));
      setState('error');
    }
  }, []);

  const copyCode = () => navigator.clipboard.writeText(myCode);
  const progress = fileSize > 0 ? Math.min(100, Math.round((received / fileSize) * 100)) : 0;

  return (
    <div>
      <button style={S.btn('#fff', '#000')} onClick={onBack}>← Back</button>
      <h2 style={S.h2}>📥 Receive a File</h2>

      {state === 'idle' && (
        <button style={S.btn()} onClick={start}>Start (generate your code)</button>
      )}

      {state === 'connecting' && <p style={S.p}>Initialising…</p>}

      {(state === 'connected' || state === 'transferring') && myCode && (
        <div style={S.card}>
          <p style={S.label}>Share this code with the sender</p>
          <code style={S.code}>{myCode}</code>
          <button style={S.btn()} onClick={copyCode}>Copy code</button>
          {state === 'connected' && (
            <p style={{ ...S.p, color: '#555', marginTop: 8, marginBottom: 0 }}>Waiting for sender to connect…</p>
          )}
        </div>
      )}

      {state === 'transferring' && (
        <div style={S.card}>
          <p style={S.p}>
            Receiving {fileName}… {progress}%
            {fileSize > 0 && ` (${(received / 1024 / 1024).toFixed(2)} / ${(fileSize / 1024 / 1024).toFixed(2)} MB)`}
          </p>
          <ProgressBar pct={progress} />
        </div>
      )}

      {state === 'done' && (
        <div style={S.card}>
          <p style={{ ...S.p, color: '#0a0', fontWeight: 700 }}>✓ Transfer complete!</p>
          <a href={downloadUrl} download={fileName}
            style={{ ...S.btn('#000', '#fff'), textDecoration: 'none', display: 'inline-block' }}>
            ⬇ Download {fileName}
          </a>
        </div>
      )}

      {error && <p style={{ ...S.p, color: '#c00' }}>Error: {error}</p>}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function FileTransfer() {
  const [mode, setMode] = useState<Mode>('choose');

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div style={S.card}>
        <h1 style={S.h1}>📡 P2P File Transfer</h1>
        <p style={S.p}>
          Transfer files directly between two browsers using WebRTC — nothing goes through a server after connection.
          Both people need this page open at the same time.
        </p>
        <p style={S.p}>
          <strong>How it works:</strong> The receiver generates a code and shares it with the sender.
          The sender pastes the code to connect, then picks a file to send.
        </p>
      </div>

      {mode === 'choose' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <button style={S.bigBtn('#000', '#fff')} onClick={() => setMode('send')}>
            📤<br />Send a file
          </button>
          <button style={S.bigBtn('#fff', '#000')} onClick={() => setMode('receive')}>
            📥<br />Receive a file
          </button>
        </div>
      )}

      {mode === 'send' && <div style={S.card}><Sender onBack={() => setMode('choose')} /></div>}
      {mode === 'receive' && <div style={S.card}><Receiver onBack={() => setMode('choose')} /></div>}
    </div>
  );
}
