import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api, SIDE_LABELS, type ScanCapability } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { SideCamera } from './SideCamera';

// Capture screen. Three states, in order:
//
//   'source'  — upload a file, or use the camera
//   'capture' — one slot per package side; at least two must carry an image
//   'sending' — hand off to analysis
//
// The four sides are asked for individually because a declaration missing from a
// face that was never photographed is not a missing declaration. Two images is
// the floor, not the target: an officer who cannot photograph a side leaves that
// slot empty and adds a different one instead.

type Phase = 'source' | 'capture' | 'sending';
type Source = 'upload' | 'camera';

interface Slot {
  side: string;
  file: File | null;
  previewUrl: string | null;
  assetId: string | null;
  uploading: boolean;
  error: string | null;
}

const emptySlot = (side: string): Slot => ({
  side, file: null, previewUrl: null, assetId: null, uploading: false, error: null,
});

export function ScanCapture() {
  const nav = useNavigate();
  const cap = useAsync(() => api.get<ScanCapability>('/scans/capability'), []);
  const [phase, setPhase] = React.useState<Phase>('source');
  const [source, setSource] = React.useState<Source>('upload');
  const [slots, setSlots] = React.useState<Slot[]>([]);
  const [scanId, setScanId] = React.useState<string | null>(null);
  const [cameraFor, setCameraFor] = React.useState<string | null>(null);
  const [brand, setBrand] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);
  const fileInputs = React.useRef<Record<string, HTMLInputElement | null>>({});

  const minImages = cap.data?.minImages ?? 2;
  const extraSides = cap.data?.extraSides ?? ['front', 'back', 'closeup', 'other'];

  // Seed the four side slots once the server has told us which sides it wants.
  React.useEffect(() => {
    if (cap.data && slots.length === 0) setSlots(cap.data.sides.map(emptySlot));
  }, [cap.data, slots.length]);

  React.useEffect(() => () => {
    slots.forEach((s) => { if (s.previewUrl) URL.revokeObjectURL(s.previewUrl); });
    // Cleanup on unmount only; slots is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const captured = slots.filter((s) => s.assetId !== null).length;
  const canAnalyze = captured >= minImages && !slots.some((s) => s.uploading);

  const patch = (side: string, p: Partial<Slot>) =>
    setSlots((prev) => prev.map((s) => (s.side === side ? { ...s, ...p } : s)));

  // The scan record is created on the first image, not on arrival: an officer who
  // opens this screen and backs out should not leave an empty draft behind.
  const ensureScan = async (): Promise<string> => {
    if (scanId) return scanId;
    const created = await api.post<{ scanId: string }>('/scans', {
      product: brand.trim() ? { brand: brand.trim() } : undefined,
    });
    setScanId(created.scanId);
    return created.scanId;
  };

  const attach = async (side: string, file: File) => {
    const previewUrl = URL.createObjectURL(file);
    setSlots((prev) => prev.map((s) => {
      if (s.side !== side) return s;
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      return { ...s, file, previewUrl, uploading: true, error: null, assetId: null };
    }));
    setError(null);
    try {
      const id = await ensureScan();
      const form = new FormData();
      form.append('file', file);
      form.append('side', side);
      form.append('source', source);
      const r = await api.postForm<{ assetId: string }>(`/scans/${id}/images`, form);
      patch(side, { assetId: r.assetId, uploading: false });
    } catch (err) {
      patch(side, {
        uploading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const clearSlot = (side: string) => {
    setSlots((prev) => prev.map((s) => {
      if (s.side !== side) return s;
      if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      return emptySlot(side);
    }));
  };

  const addAnotherSide = () => {
    const used = new Set(slots.map((s) => s.side));
    const next = extraSides.find((s) => !used.has(s));
    if (next) setSlots((prev) => [...prev, emptySlot(next)]);
  };

  const analyze = async () => {
    if (!scanId) return;
    setPhase('sending'); setError(null);
    try {
      if (brand.trim()) await api.put(`/scans/${scanId}/product`, { brand: brand.trim() });
      await api.post(`/scans/${scanId}/analyze`);
      nav(`/app/scan/${scanId}`);
    } catch (err) { setError(err); setPhase('capture'); }
  };

  // ---- Source choice --------------------------------------------------------
  if (phase === 'source') {
    return (
      <div className="field-page narrow">
        <button className="link-back" onClick={() => nav('/app')}>← Back</button>
        <h1>Scan the product</h1>
        <p className="muted">How would you like to add the package images?</p>
        <div className="source-choice">
          <button onClick={() => { setSource('upload'); setPhase('capture'); }}>
            <span className="source-ico" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path d="M12 16V4m0 0L8 8m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
                  stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <b>Upload the image</b>
            <small>Choose photos already on this device</small>
          </button>
          <button onClick={() => { setSource('camera'); setPhase('capture'); }}>
            <span className="source-ico" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path d="M4 8h3l1.4-2h7.2L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"
                  stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                <circle cx="12" cy="13" r="3.4" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </span>
            <b>Click image using the camera</b>
            <small>Photograph the package now</small>
          </button>
        </div>
      </div>
    );
  }

  // ---- Capture --------------------------------------------------------------
  return (
    <div className="field-page narrow">
      <button className="link-back" onClick={() => nav('/app')}>← Back</button>
      <h1>Capture the package</h1>
      <p className="muted">
        Add a photo for each side you can see. <b>At least {minImages} images are required.</b> If a
        side is not available, leave it empty and add a different one instead.
      </p>

      <label className="field">Product or brand name <span className="optional">(optional)</span>
        <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Helps identify the scan later" />
      </label>

      <div className="side-grid">
        {slots.map((slot) => (
          <div key={slot.side} className={`side-slot ${slot.assetId ? 'filled' : ''} ${slot.error ? 'errored' : ''}`}>
            <div className="side-slot-head">
              <b>{SIDE_LABELS[slot.side] ?? slot.side}</b>
              {slot.assetId && <span className="chip passed"><span className="ico" aria-hidden="true">✓</span>Added</span>}
              {slot.uploading && <span className="chip neutral">Uploading…</span>}
            </div>

            {slot.previewUrl ? (
              <img src={slot.previewUrl} alt={`${SIDE_LABELS[slot.side] ?? slot.side} of the package`} />
            ) : (
              <div className="side-slot-empty" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" />
                  <path d="M3 15l4.5-4.5L12 15l3-3 6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            )}

            {slot.error && <p className="slot-error" role="alert">{slot.error}</p>}

            <div className="side-slot-actions">
              {source === 'camera' ? (
                <button className="secondary" onClick={() => setCameraFor(slot.side)} disabled={slot.uploading}>
                  {slot.assetId ? 'Retake' : 'Take photo'}
                </button>
              ) : (
                <button className="secondary" onClick={() => fileInputs.current[slot.side]?.click()} disabled={slot.uploading}>
                  {slot.assetId ? 'Replace' : 'Choose image'}
                </button>
              )}
              {(slot.assetId || slot.error) && (
                <button className="quiet" onClick={() => clearSlot(slot.side)} disabled={slot.uploading}>Remove</button>
              )}
            </div>

            <input
              type="file" accept="image/jpeg,image/png" hidden
              ref={(el) => { fileInputs.current[slot.side] = el; }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) attach(slot.side, file);
                e.target.value = '';
              }}
            />
          </div>
        ))}
      </div>

      {slots.length < 4 + extraSides.length && (
        <button className="secondary wide" onClick={addAnotherSide}>+ Add another side image</button>
      )}

      <div className={`capture-status ${captured >= minImages ? 'ok' : ''}`} role="status">
        {captured >= minImages
          ? `${captured} image${captured === 1 ? '' : 's'} captured — ready to analyse.`
          : `${captured} of ${minImages} required images captured.`}
      </div>

      <ErrorText error={error} />

      <button className="primary big" disabled={!canAnalyze || phase === 'sending'} onClick={analyze}>
        {phase === 'sending' ? 'Starting analysis…' : 'Analyse for compliance'}
      </button>

      {cameraFor && (
        <SideCamera
          side={cameraFor}
          onClose={() => setCameraFor(null)}
          onCapture={(file) => { const s = cameraFor; setCameraFor(null); attach(s, file); }}
        />
      )}
    </div>
  );
}
