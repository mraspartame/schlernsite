import { useState, useRef, useEffect, useCallback } from 'react';

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  card: { border: '3px solid #000', background: '#fff', padding: '20px', marginBottom: '16px', boxShadow: '5px 5px 0 #000' } as React.CSSProperties,
  h1: { fontFamily: 'DM Serif Text, serif', fontSize: 36, marginBottom: 8 } as React.CSSProperties,
  h2: { fontFamily: 'DM Serif Text, serif', fontSize: 24, marginBottom: 12 } as React.CSSProperties,
  label: { display: 'block', fontFamily: 'Poppins, sans-serif', fontWeight: 700, fontSize: 13, marginBottom: 4 } as React.CSSProperties,
  p: { fontFamily: 'Poppins, sans-serif', fontSize: 14 } as React.CSSProperties,
  tab: (active: boolean) => ({
    border: '2px solid #000',
    borderBottom: active ? '2px solid #fff' : '2px solid #000',
    background: active ? '#fff' : '#eee',
    padding: '8px 18px',
    fontFamily: 'Poppins, sans-serif',
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
    marginRight: 4,
    marginBottom: active ? -2 : 0,
    position: 'relative' as const,
    zIndex: active ? 1 : 0,
  }),
  btn: (bg = '#000', fg = '#fff', disabled = false) => ({
    border: '2px solid #000',
    background: disabled ? '#ccc' : bg,
    color: disabled ? '#999' : fg,
    padding: '9px 18px',
    fontFamily: 'Poppins, sans-serif',
    fontWeight: 700,
    fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer',
    boxShadow: disabled ? 'none' : '3px 3px 0 #000',
    marginRight: 8,
    userSelect: 'none' as const,
  }),
};

// ── Waveform canvas helper ────────────────────────────────────────────────────

function drawWaveform(canvas: HTMLCanvasElement, buffer: AudioBuffer, startSec = 0, endSec?: number) {
  const ctx = canvas.getContext('2d')!;
  const data = buffer.getChannelData(0);
  const dur = buffer.duration;
  const s = Math.floor((startSec / dur) * data.length);
  const e = Math.floor(((endSec ?? dur) / dur) * data.length);
  const slice = data.slice(s, e);

  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(0, 0, W, H);

  const step = Math.ceil(slice.length / W);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < W; i++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const v = slice[i * step + j] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const yMin = ((min + 1) / 2) * H;
    const yMax = ((max + 1) / 2) * H;
    ctx.moveTo(i, yMin);
    ctx.lineTo(i, yMax);
  }
  ctx.stroke();
}

// ── Mic Tester ────────────────────────────────────────────────────────────────

function MicTester() {
  const [status, setStatus] = useState<'idle' | 'recording' | 'playback'>('idle');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [maxSecs] = useState(30);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animRef.current) cancelAnimationFrame(animRef.current);
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setStatus('idle');
    setLevel(0);
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Volume meter via Web Audio API
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const tick = () => {
        const buf = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buf);
        // Compute RMS of the waveform (each sample is 0–255, centre is 128)
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        // Map to 0–1 using a dB scale: -60 dB = 0, 0 dB = 1
        const db = rms > 0.0001 ? 20 * Math.log10(rms) : -100;
        setLevel(Math.max(0, Math.min(1, (db + 60) / 60)));
        animRef.current = requestAnimationFrame(tick);
      };
      tick();

      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setStatus('playback');
        ctx.close();
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setStatus('recording');
      setSeconds(0);

      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= maxSecs) stopRecording();
          return s + 1;
        });
      }, 1000);
    } catch (e: any) {
      setError('Could not access microphone: ' + (e.message ?? e));
    }
  }, [audioUrl, maxSecs, stopRecording]);

  useEffect(() => () => { stopRecording(); }, [stopRecording]);

  return (
    <div>
      <h2 style={S.h2}>🎙️ Mic Tester</h2>
      <p style={{ ...S.p, marginBottom: 16 }}>
        Hold the button to record up to 30 seconds. Release (or click again) to stop, then play back.
      </p>

      {error && (
        <div style={{ border: '2px solid #c00', background: '#fff0f0', padding: 10, marginBottom: 12, fontFamily: 'Poppins, sans-serif', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Volume meter */}
      <div style={{ marginBottom: 16 }}>
        <label style={S.label}>Input level</label>
        <div style={{ border: '2px solid #000', height: 20, width: '100%', background: '#eee', position: 'relative' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${level * 100}%`, background: level > 0.92 ? '#f00' : level > 0.78 ? '#fa0' : '#0a0', transition: 'width 0.05s' }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        {status !== 'recording' ? (
          <button
            style={S.btn('#c00', '#fff')}
            onMouseDown={startRecording}
          >
            ⏺ Hold to Record
          </button>
        ) : (
          <button
            style={{ ...S.btn('#000', '#fff'), background: '#c00' }}
            onMouseUp={stopRecording}
            onTouchEnd={stopRecording}
          >
            ⏹ Recording… {seconds}s / {maxSecs}s
          </button>
        )}
      </div>

      {audioUrl && status !== 'recording' && (
        <div style={{ border: '2px solid #000', padding: 16, background: '#f9f9f9' }}>
          <p style={{ ...S.p, fontWeight: 700, marginBottom: 8 }}>Playback</p>
          <audio ref={audioRef} controls src={audioUrl} style={{ width: '100%' }} />
          <div style={{ marginTop: 10 }}>
            <a
              href={audioUrl}
              download='mic-test.webm'
              style={{ ...S.btn('#fff', '#000'), textDecoration: 'none', display: 'inline-block' }}
            >
              ⬇ Download Recording
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Audio Trimmer ─────────────────────────────────────────────────────────────

function AudioTrimmer() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [trimmedUrl, setTrimmedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);

  const loadFile = async (f: File) => {
    setFile(f);
    setError(null);
    setLoading(true);
    setTrimmedUrl(null);
    try {
      const arrayBuffer = await f.arrayBuffer();
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(arrayBuffer);
      setBuffer(buf);
      setDuration(buf.duration);
      setStartSec(0);
      setEndSec(buf.duration);
      ctx.close();
    } catch (e: any) {
      setError('Could not decode audio: ' + (e.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (buffer && waveRef.current) {
      waveRef.current.width = waveRef.current.offsetWidth || 600;
      waveRef.current.height = 80;
      drawWaveform(waveRef.current, buffer);
    }
  }, [buffer]);

  const trim = async () => {
    if (!buffer) return;
    setLoading(true);
    try {
      const sampleRate = buffer.sampleRate;
      const channels = buffer.numberOfChannels;
      const startSample = Math.floor(startSec * sampleRate);
      const endSample = Math.floor(endSec * sampleRate);
      const length = endSample - startSample;

      const ctx = new OfflineAudioContext(channels, length, sampleRate);
      const source = ctx.createBufferSource();

      const newBuf = ctx.createBuffer(channels, length, sampleRate);
      for (let c = 0; c < channels; c++) {
        newBuf.copyToChannel(buffer.getChannelData(c).slice(startSample, endSample), c);
      }
      source.buffer = newBuf;
      source.connect(ctx.destination);
      source.start(0);

      const rendered = await ctx.startRendering();
      const wav = audioBufferToWav(rendered);
      if (trimmedUrl) URL.revokeObjectURL(trimmedUrl);
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      setTrimmedUrl(url);
    } catch (e: any) {
      setError('Trim failed: ' + (e.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <div>
      <h2 style={S.h2}>✂️ Audio Trimmer</h2>
      <p style={{ ...S.p, marginBottom: 16 }}>Load an audio file, set start and end points, export as WAV.</p>

      <input
        type='file'
        accept='audio/*,.webm,video/webm'
        style={{ display: 'none' }}
        id='audio-input'
        onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
      />
      <button style={S.btn()} onClick={() => document.getElementById('audio-input')?.click()}>
        📂 Load Audio File
      </button>

      {file && <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 13, marginLeft: 10 }}>{file.name}</span>}

      {error && <div style={{ border: '2px solid #c00', padding: 10, marginTop: 12, fontFamily: 'Poppins, sans-serif', fontSize: 13, color: '#c00' }}>{error}</div>}
      {loading && <p style={{ ...S.p, marginTop: 12 }}>Loading…</p>}

      {buffer && (
        <div style={{ marginTop: 16 }}>
          {/* Waveform */}
          <canvas ref={waveRef} style={{ width: '100%', height: 80, border: '2px solid #000', display: 'block', marginBottom: 12 }} />

          {/* Range controls */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={S.label}>Start: {fmt(startSec)}</label>
              <input
                type='range'
                min={0}
                max={duration}
                step={0.01}
                value={startSec}
                onChange={(e) => setStartSec(Math.min(parseFloat(e.target.value), endSec - 0.1))}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={S.label}>End: {fmt(endSec)}</label>
              <input
                type='range'
                min={0}
                max={duration}
                step={0.01}
                value={endSec}
                onChange={(e) => setEndSec(Math.max(parseFloat(e.target.value), startSec + 0.1))}
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <p style={{ ...S.p, fontSize: 13, color: '#555', marginBottom: 12 }}>
            Selection: {fmt(startSec)} → {fmt(endSec)} ({(endSec - startSec).toFixed(1)}s of {fmt(duration)})
          </p>

          <div style={{ display: 'flex', gap: 8 }}>
            <button style={S.btn()} onClick={trim} disabled={loading}>
              {loading ? 'Processing…' : '✂️ Trim & Export'}
            </button>
            {trimmedUrl && (
              <a href={trimmedUrl} download={`trimmed-${file?.name ?? 'audio'}.wav`}
                style={{ ...S.btn('#fff', '#000'), textDecoration: 'none', display: 'inline-block' }}>
                ⬇ Download WAV
              </a>
            )}
          </div>

          {trimmedUrl && (
            <div style={{ marginTop: 12, border: '2px solid #000', padding: 12, background: '#f9f9f9' }}>
              <p style={{ ...S.p, fontWeight: 700, marginBottom: 8 }}>Preview Trimmed Audio</p>
              <audio controls src={trimmedUrl} style={{ width: '100%' }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── WAV encoder (float32 PCM → WAV) ──────────────────────────────────────────

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const numSamples = buffer.length;
  const dataSize = numSamples * blockAlign;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  const u32 = (off: number, v: number) => view.setUint32(off, v, true);
  const u16 = (off: number, v: number) => view.setUint16(off, v, true);

  str(0, 'RIFF');
  u32(4, 36 + dataSize);
  str(8, 'WAVE');
  str(12, 'fmt ');
  u32(16, 16);
  u16(20, format);
  u16(22, numChannels);
  u32(24, sampleRate);
  u32(28, sampleRate * blockAlign);
  u16(32, blockAlign);
  u16(34, bitDepth);
  str(36, 'data');
  u32(40, dataSize);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return arrayBuffer;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function AudioTools() {
  const [tab, setTab] = useState<'mic' | 'trim'>('mic');

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div style={S.card}>
        <h1 style={S.h1}>🎙️ Audio Tools</h1>
        <p style={S.p}>Mic tester and audio file trimmer — everything runs locally in your browser.</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', marginBottom: -2, position: 'relative' }}>
        <button style={S.tab(tab === 'mic')} onClick={() => setTab('mic')}>Mic Tester</button>
        <button style={S.tab(tab === 'trim')} onClick={() => setTab('trim')}>Audio Trimmer</button>
      </div>
      <div style={{ border: '3px solid #000', background: '#fff', padding: 20, boxShadow: '5px 5px 0 #000', position: 'relative', zIndex: 0 }}>
        {tab === 'mic' ? <MicTester /> : <AudioTrimmer />}
      </div>
    </div>
  );
}
