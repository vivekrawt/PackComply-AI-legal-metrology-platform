import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, SIDE_LABELS, type Scan, type ScanCapability } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { assetUrl } from './EvidenceViewer';
import { SideCamera } from './SideCamera';

// Capture screen. Three states, in order:
//
//   'source'  — upload a file, or use the camera
//   'capture' — one slot per package side; at least one must carry an image
//   'sending' — hand off to analysis
//
// The sides are asked for individually because a declaration missing from a face
// that was never photographed is not a missing declaration. One image is the
// floor — a small packet may carry its whole label on one face — but it is a floor,
// not the target: every extra side narrows what the assessment has to call
// 'unclear', so the screen keeps asking without ever blocking.
//
// It asks by growing. Three slots are on screen to begin with, and filling the last
// empty one puts another in its place, up to the eight images a scan can hold. An
// officer photographing a plain sachet sees three slots and is done; one working a
// carton with declarations on every panel is never sent looking for a button.

type Phase = 'source' | 'capture' | 'sending';
type Source = 'upload' | 'camera';

interface Slot {
  side: string;
  // Either a blob: URL this component minted (ownsPreview) or an asset URL served
  // by the API for an image the scan was already carrying when we arrived. Only
  // the first kind may be revoked.
  previewUrl: string | null;
  ownsPreview: boolean;
  assetId: string | null;
  uploading: boolean;
  removing: boolean;
  error: string | null;
}

const emptySlot = (side: string): Slot => ({
  side, previewUrl: null, ownsPreview: false, assetId: null,
  uploading: false, removing: false, error: null,
});

export function ScanCapture() {
  const nav = useNavigate();
  const cap = useAsync(() => api.get<ScanCapability>('/scans/capability'), []);
  const [params] = useSearchParams();
  // ?scan=<id> adds faces to a scan that already exists — the route back in when a
  // reviewer sends a package back for re-photographing, rather than making the
  // auditor start a second record for the same product.
  const addingTo = params.get('scan');
  // What that scan is already carrying. Without it the screen would offer a full
  // set of empty slots for a package that already has images on file, and the
  // officer would meet the ceiling as a server error instead of as a full grid.
  const existing = useAsync<Scan | null>(
    () => (addingTo ? api.get<Scan>(`/scans/${addingTo}`) : Promise.resolve(null)),
    [addingTo],
  );
  const [phase, setPhase] = React.useState<Phase>('source');
  const [source, setSource] = React.useState<Source>('upload');
  const [slots, setSlots] = React.useState<Slot[]>([]);
  const [scanId, setScanId] = React.useState<string | null>(addingTo);
  const [cameraFor, setCameraFor] = React.useState<string | null>(null);
  const [brand, setBrand] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);
  const fileInputs = React.useRef<Record<string, HTMLInputElement | null>>({});

  const minImages = cap.data?.minImages ?? 1;
  const maxImages = cap.data?.maxImages ?? 8;
  // Every face the server will accept, in the order to offer them: the ones laid
  // out on arrival first, then the rest as room is made for them.
  const allSides = React.useMemo(
    () => [...(cap.data?.sides ?? []), ...(cap.data?.extraSides ?? [])],
    [cap.data],
  );

  // Seed the opening slots once the server has said which faces it wants — and,
  // on a re-photograph, once we know which of them the scan already holds.
  React.useEffect(() => {
    if (!cap.data || slots.length > 0) return;
    if (addingTo && existing.loading) return;
    const seeded: Slot[] = [];
    const used = new Set<string>();
    for (const img of existing.data?.images ?? []) {
      if (!img.side || used.has(img.side) || seeded.length >= maxImages) continue;
      seeded.push({ ...emptySlot(img.side), assetId: img.id, previewUrl: assetUrl(img.id) });
      used.add(img.side);
    }
    for (const side of cap.data.sides) {
      if (seeded.length >= maxImages) break;
      if (used.has(side)) continue;
      seeded.push(emptySlot(side));
      used.add(side);
    }
    setSlots(seeded);
  }, [cap.data, existing.data, existing.loading, addingTo, slots.length, maxImages]);

  const nextUnusedSide = React.useCallback((current: Slot[]) => {
    const used = new Set(current.map((s) => s.side));
    return allSides.find((s) => !used.has(s)) ?? null;
  }, [allSides]);

  // The growth itself: no empty slot left and room below the ceiling means another
  // face goes up, so the officer's next photograph always has somewhere to land.
  React.useEffect(() => {
    if (slots.length === 0 || slots.length >= maxImages) return;
    if (slots.some((s) => !s.assetId)) return;
    const next = nextUnusedSide(slots);
    if (next) setSlots((prev) => [...prev, emptySlot(next)]);
  }, [slots, maxImages, nextUnusedSide]);

  React.useEffect(() => () => {
    slots.forEach((s) => { if (s.previewUrl && s.ownsPreview) URL.revokeObjectURL(s.previewUrl); });
    // Cleanup on unmount only; slots is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const captured = slots.filter((s) => s.assetId !== null).length;
  const busy = slots.some((s) => s.uploading || s.removing);
  const canAnalyze = captured >= minImages && !busy;
  const roomLeft = slots.length < maxImages;

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
      if (s.previewUrl && s.ownsPreview) URL.revokeObjectURL(s.previewUrl);
      return { ...s, previewUrl, ownsPreview: true, uploading: true, error: null, assetId: null };
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

  // Removing is a real deletion, not just a cleared tile: an image left on the scan
  // would still be read by the recogniser and still count against the ceiling, so a
  // slot the officer emptied has to be a slot the package got back.
  const clearSlot = async (side: string) => {
    const slot = slots.find((s) => s.side === side);
    if (!slot || slot.uploading || slot.removing) return;
    if (slot.assetId && scanId) {
      patch(side, { removing: true, error: null });
      try {
        await api.del(`/scans/${scanId}/images/${slot.assetId}`);
      } catch (err) {
        patch(side, {
          removing: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    setSlots((prev) => prev.map((s) => {
      if (s.side !== side) return s;
      if (s.previewUrl && s.ownsPreview) URL.revokeObjectURL(s.previewUrl);
      return emptySlot(side);
    }));
  };

  // The manual way in, for the officer who cannot photograph a face that is on
  // screen — a carton wedged on a shelf, a panel under a price sticker — and wants
  // a different one rather than being held at three until they fake it.
  const addAnotherSide = () => {
    setSlots((prev) => {
      if (prev.length >= maxImages) return prev;
      const next = nextUnusedSide(prev);
      return next ? [...prev, emptySlot(next)] : prev;
    });
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
        <h1>{addingTo ? 'Photograph this package again' : 'Scan the product'}</h1>
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
        Add a photo for each side you can see. <b>At least {minImages} image
        {minImages === 1 ? ' is' : 's are'} required</b>, but every extra side helps: a declaration
        on a face that was never photographed cannot be assessed. Fill the slots on screen and
        another one appears, up to {maxImages} images for this package.
      </p>

      <label className="field">Product or brand name <span className="optional">(optional)</span>
        <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Helps identify the scan later" />
      </label>

      <div className="side-grid">
        {slots.map((slot) => (
          <div key={slot.side} className={`side-slot ${slot.assetId ? 'filled' : ''} ${slot.error ? 'errored' : ''}`}>
            <div className="side-slot-head">
              <b>{SIDE_LABELS[slot.side] ?? slot.side}</b>
              {slot.assetId && !slot.removing && (
                <span className="chip passed"><span className="ico" aria-hidden="true">✓</span>Added</span>
              )}
              {slot.uploading && <span className="chip neutral">Uploading…</span>}
              {slot.removing && <span className="chip neutral">Removing…</span>}
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
                <button className="secondary" onClick={() => setCameraFor(slot.side)} disabled={slot.uploading || slot.removing}>
                  {slot.assetId ? 'Retake' : 'Take photo'}
                </button>
              ) : (
                <button className="secondary" onClick={() => fileInputs.current[slot.side]?.click()} disabled={slot.uploading || slot.removing}>
                  {slot.assetId ? 'Replace' : 'Choose image'}
                </button>
              )}
              {(slot.assetId || slot.error) && (
                <button className="quiet" onClick={() => clearSlot(slot.side)} disabled={slot.uploading || slot.removing}>Remove</button>
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

      {roomLeft && (
        <button className="secondary wide" onClick={addAnotherSide}>+ Add another side image</button>
      )}

      <div className={`capture-status ${captured >= minImages ? 'ok' : ''}`} role="status">
        {captured === 0
          ? `Add at least ${minImages} image to analyse this package.`
          : captured < minImages
            ? `${captured} of ${minImages} required images captured.`
            : captured >= maxImages
              ? `${captured} images captured — the most one package can carry. Ready to analyse.`
              : captured === 1
                ? '1 image captured — ready to analyse. Adding more sides gives a fuller assessment.'
                : `${captured} of ${maxImages} images captured — ready to analyse.`}
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
