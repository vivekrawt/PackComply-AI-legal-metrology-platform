import React from 'react';
import { SIDE_LABELS } from '../api';
import { ErrorText } from '../components/common';

// Camera capture for one package side. It hands the caller a File and nothing
// else — uploading is the capture screen's job, so a photo the officer rejects
// never becomes evidence.

export function SideCamera({ side, onCapture, onClose }: {
  side: string;
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [shot, setShot] = React.useState<{ url: string; file: File } | null>(null);

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
      `Camera unavailable: ${e instanceof Error ? e.message : String(e)}. `
      + 'Grant camera permission, or choose "Upload image" instead.',
    )));
    return () => { cancelled = true; streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, []);

  // Revoke the object URL for a discarded preview rather than leaking it.
  React.useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  const take = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the captured frame'))), 'image/jpeg', 0.92));
    const file = new File([blob], `${side}-${Date.now()}.jpg`, { type: 'image/jpeg' });
    setShot({ url: URL.createObjectURL(blob), file });
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={`Photograph the ${SIDE_LABELS[side] ?? side} of the package`}>
      <div className="sheet-card">
        <div className="sheet-head">
          <h2>Photograph the {(SIDE_LABELS[side] ?? side).toLowerCase()}</h2>
          <button className="quiet" onClick={onClose}>Cancel</button>
        </div>

        {shot ? (
          <>
            <img className="shot-preview" src={shot.url} alt={`Captured ${side} of the package`} />
            <div className="sheet-actions">
              <button className="secondary" onClick={() => setShot(null)}>Retake</button>
              <button className="primary" onClick={() => onCapture(shot.file)}>Use this photo</button>
            </div>
          </>
        ) : (
          <>
            <div className="capture-stage">
              <video ref={videoRef} playsInline muted aria-label="Live camera preview" />
              <div className="capture-guide" aria-hidden="true">
                <span className="c tl" /><span className="c tr" /><span className="c bl" /><span className="c br" />
              </div>
            </div>
            <p className="muted">Fill the frame with the label and hold steady until the text is sharp.</p>
            <div className="sheet-actions">
              <button className="primary" onClick={take} disabled={!ready}>
                {ready ? '◉ Capture' : 'Starting camera…'}
              </button>
            </div>
          </>
        )}
        <ErrorText error={error} />
      </div>
    </div>
  );
}
