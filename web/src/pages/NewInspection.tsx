import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ErrorText, Section } from '../components/common';
import { saveDraft, addDraftEvidence } from '../offline';

const TYPES = [
  { v: 'physical_retail', label: 'Physical retail', views: 'front + back views required' },
  { v: 'warehouse_import', label: 'Warehouse / import', views: 'front + back + side views required' },
  { v: 'back_office', label: 'Back-office review', views: 'front + back views required' },
  { v: 'complaint', label: 'Complaint-driven', views: 'front view required' },
  { v: 'ecommerce', label: 'E-commerce listing', views: 'listing evidence required' },
];
const CATEGORIES = ['packaged_food', 'edible_oil', 'pan_masala', 'medical_devices', 'cosmetics', 'seeds', 'other'];

export function NewInspection() {
  const nav = useNavigate();
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const [f, setF] = React.useState<any>({
    type: 'physical_retail', eventDate: new Date().toISOString().slice(0, 10),
    location: '', sellerName: '', notes: '',
    product: { brand: '', genericName: '', category: 'packaged_food', gtin: '', packSize: '', importStatus: 'domestic', presentationMode: 'printed' },
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const setP = (k: string, v: any) => setF((p: any) => ({ ...p, product: { ...p.product, [k]: v } }));
  const typeInfo = TYPES.find((tp) => tp.v === f.type)!;
  const [offline, setOffline] = React.useState(!navigator.onLine);
  const [photos, setPhotos] = React.useState<{ file: File; faceLabel: string }[]>([]);
  const [photoFace, setPhotoFace] = React.useState('front');
  React.useEffect(() => {
    const on = () => setOffline(false); const off = () => setOffline(true);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const buildBody = () => {
    const product = Object.fromEntries(Object.entries(f.product).filter(([, v]) => v !== ''));
    return { ...f, product, location: f.location || undefined, sellerName: f.sellerName || undefined, notes: f.notes || undefined };
  };

  const saveLocally = async () => {
    const localId = await saveDraft(buildBody() as any);
    for (const p of photos) await addDraftEvidence(localId, p.file, p.faceLabel);
    nav('/app/offline');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (offline) {
        await saveLocally(); // encrypted local draft; syncs when connectivity returns
        return;
      }
      const created = await api.post<any>('/inspections', buildBody());
      nav(`/app/inspections/${created.id}`);
    } catch (err) {
      // Network failure mid-save (fetch throws TypeError): keep the officer's work.
      if (err instanceof TypeError) {
        try { await saveLocally(); return; } catch (e2) { setError(e2); }
      } else setError(err);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="topbar"><h1>New inspection</h1></div>
      <div className="content">
        <form onSubmit={submit}>
          <Section title="Context">
            <div className="grid2">
              <label className="field">Inspection type
                <select value={f.type} onChange={(e) => set('type', e.target.value)}>
                  {TYPES.map((tp) => <option key={tp.v} value={tp.v}>{tp.label}</option>)}
                </select>
              </label>
              <label className="field">Event date (used for legal rule-version selection)
                <input type="date" value={f.eventDate} onChange={(e) => set('eventDate', e.target.value)} required />
              </label>
              <label className="field">Location / premises
                <input value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Store, warehouse or marketplace" />
              </label>
              <label className="field">Seller / entity name
                <input value={f.sellerName} onChange={(e) => set('sellerName', e.target.value)} />
              </label>
            </div>
            <p className="warn-box">Required evidence for this type: <b>{typeInfo.views}</b>. Missing views must be captured or waived with a reason before findings can rely on absence.</p>
          </Section>

          <Section title="Product context">
            <div className="grid2">
              <label className="field">Brand<input value={f.product.brand} onChange={(e) => setP('brand', e.target.value)} /></label>
              <label className="field">Common / generic name<input value={f.product.genericName} onChange={(e) => setP('genericName', e.target.value)} /></label>
              <label className="field">Category (drives overlays / specialist routing)
                <select value={f.product.category} onChange={(e) => setP('category', e.target.value)}>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label className="field">Barcode / GTIN<input value={f.product.gtin} onChange={(e) => setP('gtin', e.target.value)} /></label>
              <label className="field">Declared pack size<input value={f.product.packSize} onChange={(e) => setP('packSize', e.target.value)} placeholder="e.g. 500 g" /></label>
              <label className="field">Import status
                <select value={f.product.importStatus} onChange={(e) => setP('importStatus', e.target.value)}>
                  <option value="domestic">domestic</option><option value="imported">imported</option>
                </select>
              </label>
              <label className="field">Presentation mode
                <select value={f.product.presentationMode} onChange={(e) => setP('presentationMode', e.target.value)}>
                  <option value="printed">printed</option>
                  <option value="molded_embossed_perforated">molded / embossed / perforated</option>
                </select>
              </label>
            </div>
          </Section>

          {offline && (
            <Section title="⛁ Offline capture (encrypted local draft)">
              <p className="warn-box">You are offline. This draft and any photos below will be AES-GCM encrypted on this
                device and synced automatically when connectivity returns — nothing is lost, nothing uploads yet.</p>
              <div className="btn-row">
                <select value={photoFace} onChange={(e) => setPhotoFace(e.target.value)} aria-label="Package face for photo">
                  {['front', 'back', 'side', 'top', 'bottom', 'closeup'].map((fc) => <option key={fc}>{fc}</option>)}
                </select>
                <input type="file" accept="image/jpeg,image/png" capture="environment" aria-label="Queue evidence photo"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setPhotos((p) => [...p, { file, faceLabel: photoFace }]);
                    e.target.value = '';
                  }} />
              </div>
              {photos.length > 0 && (
                <ul>{photos.map((p, i) => (
                  <li key={i}>{p.faceLabel}: {p.file.name} ({Math.round(p.file.size / 1024)} KB)
                    <button type="button" className="quiet" style={{ marginLeft: 8 }}
                      onClick={() => setPhotos((ph) => ph.filter((_, j) => j !== i))}>remove</button>
                  </li>
                ))}</ul>
              )}
            </Section>
          )}
          <ErrorText error={error} />
          <button className="primary" disabled={busy}>
            {offline ? '⛁ Save encrypted offline draft' : 'Create inspection draft'}
          </button>
        </form>
      </div>
    </>
  );
}
