import React from 'react';
import { api } from '../api';
import { ErrorText } from './common';

// Guided camera capture (INS-05). Frames are sampled locally in the browser to
// give the officer live framing/focus/lighting feedback BEFORE an image is
// committed as evidence. Nothing is uploaded until Capture is pressed.
//
// These are CAPTURE-ASSIST heuristics only — they are not the server-side image
// quality assessment, and they are never a legal or compliance judgement.

const FACES = ['front', 'back', 'side', 'top', 'bottom', 'closeup'];

// Tunable capture-guidance thresholds (not legal parameters).
const FOCUS_GOOD = 90, FOCUS_FAIR = 35;
const GLARE_WARN = 0.03;          // fraction of near-saturated pixels
const DARK_WARN = 60, BRIGHT_WARN = 225;  // mean luminance 0..255

type Level = 'good' | 'fair' | 'poor';
interface Metrics { focus: number; glare: number; brightness: number }

function levelFor(m: Metrics) {
  const focus: Level = m.focus >= FOCUS_GOOD ? 'good' : m.focus >= FOCUS_FAIR ? 'fair' : 'poor';
  const glare: Level = m.glare <= GLARE_WARN ? 'good' : m.glare <= GLARE_WARN * 2.5 ? 'fair' : 'poor';
  const light: Level =
    m.brightness < DARK_WARN || m.brightness > BRIGHT_WARN ? 'poor'
      : m.brightness < DARK_WARN * 1.4 || m.brightness > BRIGHT_WARN - 20 ? 'fair' : 'good';
  return { focus, glare, light };
}

export function CameraCapture({ inspectionId, onCaptured, onClose }: {
  inspectionId: string;
  onCaptured: () => void;
  onClose: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const sampleRef = React.useRef<HTMLCanvasElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const [faceLabel, setFaceLabel] = React.useState('front');
  const [withMarker, setWithMarker] = React.useState(false);
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices?.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }).then((stream) => {
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      setReady(true);
    }).catch((e) => setError(new Error(
      `Camera unavailable: ${e instanceof Error ? e.message : String(e)}. ` +
      'Grant camera permission, or use the file upload panel instead.',
    )));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Sample frames a few times a second and compute framing metrics.
  React.useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      const video = videoRef.current, canvas = sampleRef.current;
      if (!video || !canvas || video.videoWidth === 0) return;
      const W = 160, H = Math.round((video.videoHeight / video.videoWidth) * 160) || 120;
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, W, H);
      const { data } = ctx.getImageData(0, 0, W, H);

      const gray = new Float32Array(W * H);
      let sum = 0, saturated = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        gray[p] = y; sum += y;
        if (y > 245) saturated++;
      }
      // Laplacian variance — a standard focus proxy: sharp edges raise it.
      let lapSum = 0, lapSqSum = 0, n = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W];
          lapSum += lap; lapSqSum += lap * lap; n++;
        }
      }
      const mean = lapSum / Math.max(n, 1);
      setMetrics({
        focus: Math.round(lapSqSum / Math.max(n, 1) - mean * mean),
        glare: saturated / (W * H),
        brightness: Math.round(sum / (W * H)),
      });
    }, 350);
    return () => clearInterval(id);
  }, [ready]);

  const capture = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    setBusy(true); setError(null);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      const blob: Blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the captured frame'))), 'image/jpeg', 0.92));

      const form = new FormData();
      form.append('files', new File([blob], `${faceLabel}-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      form.append('faceLabel', faceLabel);
      form.append('source', 'camera');
      form.append('capturedAt', new Date().toISOString());
      form.append('device', JSON.stringify({
        userAgent: navigator.userAgent,
        capture: { width: canvas.width, height: canvas.height, guidance: metrics ?? null, scaleReferenceIncluded: withMarker },
      }));
      await api.postForm(`/inspections/${inspectionId}/evidence`, form);
      onCaptured();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const lv = metrics ? levelFor(metrics) : null;
  const chip = (label: string, level: Level | undefined, hint: string) => (
    <span className={`chip ${level === 'good' ? 'passed' : level === 'fair' ? 'needs_review' : 'failed'}`} title={hint}>
      <span className="ico" aria-hidden="true">{level === 'good' ? '✓' : level === 'fair' ? '~' : '!'}</span>
      {label}
    </span>
  );

  return (
    <div className="card" style={{ background: '#f8fafc' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Guided camera capture</h2>
        <button className="quiet" onClick={onClose}>Close camera</button>
      </div>

      <div className="capture-stage">
        <video ref={videoRef} playsInline muted aria-label="Live camera preview" />
        <div className="capture-guide" aria-hidden="true">
          <span className="c tl" /><span className="c tr" /><span className="c bl" /><span className="c br" />
        </div>
        {withMarker && <div className="capture-marker" aria-hidden="true">place scale reference here</div>}
      </div>
      <canvas ref={sampleRef} style={{ display: 'none' }} />

      <div className="btn-row" style={{ marginTop: 10 }} role="status" aria-live="polite">
        {lv ? (
          <>
            {chip('Focus', lv.focus, `Sharpness score ${metrics!.focus} — hold steady and let the camera focus on the label`)}
            {chip('Glare', lv.glare, `${(metrics!.glare * 100).toFixed(1)}% of the frame is blown out — tilt the pack away from direct light`)}
            {chip('Lighting', lv.light, `Mean brightness ${metrics!.brightness} of 255`)}
          </>
        ) : <span className="muted">Starting camera…</span>}
      </div>
      {lv && (lv.focus !== 'good' || lv.glare !== 'good' || lv.light !== 'good') && (
        <p className="warn-box">
          {lv.focus !== 'good' && 'Hold the device steady and move slightly closer until the text is crisp. '}
          {lv.glare !== 'good' && 'Tilt the package away from the light source to remove glare on the label. '}
          {lv.light !== 'good' && (metrics!.brightness < DARK_WARN * 1.4 ? 'Add more light on the package face. ' : 'Reduce direct light or move out of harsh sunlight. ')}
          You can still capture — the officer decides what evidence to record.
        </p>
      )}

      <div className="btn-row" style={{ marginTop: 10 }}>
        <label className="field" style={{ margin: 0 }}>Package face
          <select value={faceLabel} onChange={(e) => setFaceLabel(e.target.value)}>
            {FACES.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label className="field" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'end' }}>
          <input type="checkbox" checked={withMarker} onChange={(e) => setWithMarker(e.target.checked)} style={{ width: 'auto', margin: 0 }} />
          Including a scale reference
        </label>
        <button className="primary" onClick={capture} disabled={busy || !ready} style={{ alignSelf: 'end' }}>
          {busy ? 'Capturing…' : '◉ Capture evidence'}
        </button>
      </div>
      <p className="muted">
        Capture guidance is assistive only. Image quality is assessed server-side after upload, and physical
        character-size checks still require a recorded calibration — a scale reference in frame does not by itself
        establish millimetres.
      </p>
      <ErrorText error={error} />
    </div>
  );
}
