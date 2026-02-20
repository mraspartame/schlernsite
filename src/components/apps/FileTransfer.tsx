import { useState, useRef, useEffect, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = 'choose' | 'send' | 'receive';
type ConnectionState = 'idle' | 'waiting' | 'connecting' | 'connected' | 'transferring' | 'done' | 'error';

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  card: { border: '3px solid #000', background: '#fff', padding: '20px', marginBottom: '16px', boxShadow: '5px 5px 0 #000' } as React.CSSProperties,
  h1: { fontFamily: 'DM Serif Text, serif', fontSize: 34, marginBottom: 6 } as React.CSSProperties,
  h2: { fontFamily: 'DM Serif Text, serif', fontSize: 22, marginBottom: 10 } as React.CSSProperties,
  label: { display: 'block', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 13, marginBottom: 4 } as React.CSSProperties,
  p: { fontFamily: 'Poppins, sans-serif', fontSize: 14, marginBottom: 8 } as React.CSSProperties,
  code: { fontFamily: 'monospace', background: '#f0f0f0', border: '1px solid #ccc', padding: '12px 16px', display: 'block', fontSize: 13, wordBreak: 'break-all' as const, whiteSpace: 'pre-wrap' as const, maxHeight: 200, overflowY: 'auto' as const } as React.CSSProperties,
  input: { border: '2px solid #000', padding: '8px 12px', fontFamily: 'Poppins, sans-serif', fontSize: 14, width: '100%', boxSizing: 'border-box' as const, marginBottom: 8 },
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

// ── Send side ─────────────────────────────────────────────────────────────────

function Sender({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<ConnectionState>('idle');
  const [myId, setMyId] = useState('');
  const [offer, setOffer] = useState('');
  const [receiveCode, setReceiveCode] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const peerRef = useRef<any>(null);
  const connRef = useRef<any>(null);

  const start = useCallback(async () => {
    setState('waiting');
    setError('');
    try {
      const Peer = await loadPeer();
      const peer = new Peer();
      peerRef.current = peer;
      peer.on('open', (id: string) => {
        setMyId(id);
        // Encode the full connection info as a compact code
        setOffer(btoa(JSON.stringify({ id, type: 'send' })));
      });
      peer.on('error', (e: any) => setError(String(e)));
    } catch (e: any) {
      setError(String(e));
      setState('error');
    }
  }, []);

  const connectToReceiver = async () => {
    if (!peerRef.current || !receiveCode.trim()) return;
    setState('connecting');
    try {
      const info = JSON.parse(atob(receiveCode.trim()));
      const conn = peerRef.current.connect(info.id, { reliable: true });
      connRef.current = conn;
      conn.on('open', () => setState('connected'));
      conn.on('error', (e: any) => { setError(String(e)); setState('error'); });
    } catch (e: any) {
      setError('Invalid code: ' + String(e));
      setState('error');
    }
  };

  const sendFile = async () => {
    if (!file || !connRef.current) return;
    setState('transferring');
    const CHUNK = 64 * 1024; // 64 KB chunks
    const buf = await file.arrayBuffer();
    const total = buf.byteLength;

    // Send metadata first
    connRef.current.send(JSON.stringify({ type: 'meta', name: file.name, size: total, mime: file.type }));

    // Send chunks
    for (let offset = 0; offset < total; offset += CHUNK) {
      connRef.current.send(buf.slice(offset, offset + CHUNK));
      setProgress(Math.min(100, Math.round(((offset + CHUNK) / total) * 100)));
      await new Promise((r) => setTimeout(r, 1));
    }

    connRef.current.send(JSON.stringify({ type: 'done' }));
    setState('done');
  };

  const copyCode = () => navigator.clipboard.writeText(offer);

  return (
    <div>
      <button style={S.btn('#fff', '#000')} onClick={onBack}>← Back</button>
      <h2 style={S.h2}>📤 Send a File</h2>

      {state === 'idle' && (
        <button style={S.btn()} onClick={start}>Start (generate your code)</button>
      )}

      {(state === 'waiting' || state === 'connecting' || state === 'connected') && offer && (
        <div style={S.card}>
          <p style={S.label}>Step 1: Share your code with the receiver</p>
          <code style={S.code}>{offer}</code>
          <button style={S.btn()} onClick={copyCode}>Copy code</button>
        </div>
      )}

      {state === 'waiting' && (
        <div style={S.card}>
          <p style={S.label}>Step 2: Paste the receiver's code here</p>
          <textarea
            style={S.textarea}
            value={receiveCode}
            onChange={(e) => setReceiveCode(e.target.value)}
            placeholder='Paste the code the receiver gave you…'
          />
          <button style={S.btn()} onClick={connectToReceiver} disabled={!receiveCode.trim()}>
            Connect
          </button>
        </div>
      )}

      {state === 'connecting' && <p style={S.p}>Connecting…</p>}

      {state === 'connected' && (
        <div style={S.card}>
          <p style={{ ...S.p, color: '#0a0', fontWeight: 700 }}>✓ Connected!</p>
          <p style={S.label}>Step 3: Select the file to send</p>
          <input type='file' onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ marginBottom: 10 }} />
          {file && <p style={S.p}>{file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB</p>}
          <button style={S.btn()} onClick={sendFile} disabled={!file}>
            Send file
          </button>
        </div>
      )}

      {state === 'transferring' && (
        <div style={S.card}>
          <p style={S.p}>Sending… {progress}%</p>
          <div style={{ border: '2px solid #000', height: 24, background: '#eee', position: 'relative' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${progress}%`, background: '#000', transition: 'width 0.2s' }} />
          </div>
        </div>
      )}

      {state === 'done' && <p style={{ ...S.p, color: '#0a0', fontWeight: 700 }}>✓ File sent successfully!</p>}
      {error && <p style={{ ...S.p, color: '#c00' }}>Error: {error}</p>}
    </div>
  );
}

// ── Receive side ──────────────────────────────────────────────────────────────

function Receiver({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<ConnectionState>('idle');
  const [myCode, setMyCode] = useState('');
  const [senderCode, setSenderCode] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [received, setReceived] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [error, setError] = useState('');

  const peerRef = useRef<any>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const metaRef = useRef<{ name: string; size: number; mime: string } | null>(null);

  const start = useCallback(async () => {
    setState('waiting');
    setError('');
    try {
      const Peer = await loadPeer();
      const peer = new Peer();
      peerRef.current = peer;
      peer.on('open', (id: string) => {
        setMyCode(btoa(JSON.stringify({ id, type: 'receive' })));
      });
      peer.on('error', (e: any) => { setError(String(e)); setState('error'); });
    } catch (e: any) {
      setError(String(e));
      setState('error');
    }
  }, []);

  const connectToSender = async () => {
    if (!peerRef.current || !senderCode.trim()) return;
    setState('connecting');
    try {
      const info = JSON.parse(atob(senderCode.trim()));
      const conn = peerRef.current.connect(info.id, { reliable: true });
      conn.on('open', () => setState('connected'));
      conn.on('data', (data: any) => {
        if (typeof data === 'string') {
          const msg = JSON.parse(data);
          if (msg.type === 'meta') {
            metaRef.current = { name: msg.name, size: msg.size, mime: msg.mime };
            setFileName(msg.name);
            setFileSize(msg.size);
            chunksRef.current = [];
            setReceived(0);
            setState('transferring');
          } else if (msg.type === 'done') {
            const blob = new Blob(chunksRef.current, { type: metaRef.current?.mime ?? 'application/octet-stream' });
            setDownloadUrl(URL.createObjectURL(blob));
            setState('done');
          }
        } else if (data instanceof ArrayBuffer) {
          chunksRef.current.push(data);
          const totalReceived = chunksRef.current.reduce((s, c) => s + c.byteLength, 0);
          setReceived(totalReceived);
        }
      });
      conn.on('error', (e: any) => { setError(String(e)); setState('error'); });
    } catch (e: any) {
      setError('Invalid code: ' + String(e));
      setState('error');
    }
  };

  const copyCode = () => navigator.clipboard.writeText(myCode);
  const progress = fileSize > 0 ? Math.min(100, Math.round((received / fileSize) * 100)) : 0;

  return (
    <div>
      <button style={S.btn('#fff', '#000')} onClick={onBack}>← Back</button>
      <h2 style={S.h2}>📥 Receive a File</h2>

      {state === 'idle' && (
        <button style={S.btn()} onClick={start}>Start (generate your code)</button>
      )}

      {(state === 'waiting' || state === 'connecting' || state === 'connected') && myCode && (
        <div style={S.card}>
          <p style={S.label}>Step 1: Share your code with the sender</p>
          <code style={S.code}>{myCode}</code>
          <button style={S.btn()} onClick={copyCode}>Copy code</button>
        </div>
      )}

      {state === 'waiting' && (
        <div style={S.card}>
          <p style={S.label}>Step 2: Paste the sender's code here</p>
          <textarea
            style={S.textarea}
            value={senderCode}
            onChange={(e) => setSenderCode(e.target.value)}
            placeholder='Paste the code the sender gave you…'
          />
          <button style={S.btn()} onClick={connectToSender} disabled={!senderCode.trim()}>
            Connect
          </button>
        </div>
      )}

      {state === 'connecting' && <p style={S.p}>Connecting…</p>}
      {state === 'connected' && <p style={{ ...S.p, color: '#0a0', fontWeight: 700 }}>✓ Connected! Waiting for sender to start…</p>}

      {state === 'transferring' && (
        <div style={S.card}>
          <p style={S.p}>Receiving {fileName}… {progress}% ({(received / 1024 / 1024).toFixed(2)} / {(fileSize / 1024 / 1024).toFixed(2)} MB)</p>
          <div style={{ border: '2px solid #000', height: 24, background: '#eee', position: 'relative' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${progress}%`, background: '#000', transition: 'width 0.2s' }} />
          </div>
        </div>
      )}

      {state === 'done' && (
        <div style={S.card}>
          <p style={{ ...S.p, color: '#0a0', fontWeight: 700 }}>✓ Transfer complete!</p>
          <a href={downloadUrl} download={fileName} style={{ ...S.btn('#000', '#fff'), textDecoration: 'none', display: 'inline-block' }}>
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
          <strong>How it works:</strong> Both sides generate a short code. Exchange codes (via chat, call, etc.), and a direct peer-to-peer connection is established. Then the sender picks a file and sends it.
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
