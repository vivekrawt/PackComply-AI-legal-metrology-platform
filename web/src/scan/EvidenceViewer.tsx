import React from 'react';
import { SIDE_LABELS, type ComplianceCheck, type ScanImage, type ScanOcrImage } from '../api';

// The evidence viewer: the officer's own photographs, with the text the
// recogniser actually read drawn where it was read from.
//
// This is what makes a verdict checkable rather than merely stated. A declaration
// reported MISSING can be confirmed genuinely absent instead of simply unread; one
// reported MET can be seen on the package. When a check is open, the boxes whose
// text matches what the model quoted are highlighted and the rest recede — so the
// question "is it actually there?" is answered by looking, not by trusting.
//
// Boxes are fractions of the ORIGINAL photograph (the OCR sidecar maps them back
// out of its prepared image), so they land correctly on the picture as taken.

export const assetUrl = (assetId: string) => `/api/v1/assets/${assetId}/content`;

// Loose containment match. OCR splits a declaration across lines as often as not,
// so a block counts as a hit when either side contains the other once both are
// reduced to bare alphanumerics — close enough to point at, and it never invents
// a hit out of punctuation alone.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, '');

export function matchingBlocks(blocks: { text: string }[], observed: string): Set<number> {
  const target = norm(observed);
  const hits = new Set<number>();
  if (target.length < 3) return hits;
  blocks.forEach((b, i) => {
    const t = norm(b.text);
    if (t.length < 3) return;
    if (target.includes(t) || t.includes(target)) hits.add(i);
  });
  return hits;
}

interface ViewerProps {
  images: ScanImage[];
  ocr: ScanOcrImage[] | null;
  startAt: number;
  // When the viewer is opened from a finding, the text that finding quoted.
  highlight?: { check: ComplianceCheck } | null;
  onClose: () => void;
}

export function EvidenceViewer({ images, ocr, startAt, highlight, onClose }: ViewerProps) {
  const [index, setIndex] = React.useState(startAt);
  const [showBoxes, setShowBoxes] = React.useState(true);
  const [hovered, setHovered] = React.useState<number | null>(null);

  const image = images[index];
  const page = ocr?.find((o) => o.assetId === image?.id) ?? null;
  const blocks = page?.blocks ?? [];
  const observed = highlight?.check.observedText ?? '';
  const hits = React.useMemo(
    () => (observed ? matchingBlocks(blocks, observed) : new Set<number>()),
    [blocks, observed],
  );

  // Opened from a finding: land on the face that actually carries the quoted text
  // rather than making the officer hunt for it.
  React.useEffect(() => {
    if (!observed || !ocr) return;
    const found = ocr.findIndex((o) => matchingBlocks(o.blocks, observed).size > 0);
    if (found >= 0) {
      const target = images.findIndex((im) => im.id === ocr[found].assetId);
      if (target >= 0) setIndex(target);
    }
    // Only when the viewer opens on a new finding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observed, ocr]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, images.length - 1));
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, onClose]);

  if (!image) return null;

  return (
    <div className="ev-backdrop" role="dialog" aria-modal="true" aria-label="Package image evidence" onClick={onClose}>
      <div className="ev-shell" onClick={(e) => e.stopPropagation()}>
        <header className="ev-head">
          <div>
            <b>{SIDE_LABELS[image.side ?? ''] ?? image.side ?? 'Unlabelled side'}</b>
            <small>Image {index + 1} of {images.length}</small>
          </div>
          <div className="ev-head-actions">
            <label className="ev-toggle">
              <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />
              Show text found ({blocks.length})
            </label>
            <button className="ev-close" onClick={onClose} aria-label="Close the image viewer">✕</button>
          </div>
        </header>

        {highlight && (
          <div className={`ev-check ${highlight.check.status}`}>
            <b>{highlight.check.parameter}</b>
            {observed ? (
              <p>
                {hits.size > 0
                  ? `Highlighted below — ${hits.size} matching text region${hits.size === 1 ? '' : 's'} on this image.`
                  : 'The quoted text was not located on this image. Check the other captured sides.'}
                <span className="ev-quote">“{observed}”</span>
              </p>
            ) : (
              <p>
                Nothing was quoted for this requirement — it was not found in the text read from any
                image. Look for it on the package yourself: it may sit on a face that was not captured,
                or in text the recogniser could not read.
              </p>
            )}
          </div>
        )}

        <div className="ev-stage">
          <div className="ev-frame">
            <img src={assetUrl(image.id)} alt={`${SIDE_LABELS[image.side ?? ''] ?? 'Package'} face of the package`} />
            {showBoxes && blocks.map((b, i) => (
              <button
                key={i}
                type="button"
                className={`ev-box ${hits.has(i) ? 'hit' : ''} ${hovered === i ? 'on' : ''} ${observed && hits.size > 0 && !hits.has(i) ? 'dim' : ''}`}
                style={{
                  left: `${b.bbox.x * 100}%`, top: `${b.bbox.y * 100}%`,
                  width: `${b.bbox.w * 100}%`, height: `${b.bbox.h * 100}%`,
                }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered(null)}
                title={b.text}
                aria-label={`Text read here: ${b.text}`}
              >
                <span className="ev-box-tip">{b.text}</span>
              </button>
            ))}
          </div>
        </div>

        <footer className="ev-foot">
          <button className="secondary" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>← Previous</button>
          <p className="ev-note">
            {page === null
              ? 'Text regions are still being read for this image.'
              : !page.processed
                ? 'This image was not read by the recogniser, so nothing is marked on it.'
                : blocks.length === 0
                  ? 'The recogniser read this image and found no legible text on it.'
                  : 'Boxes mark the text the recogniser read. Hover or tap one to see what it read.'}
          </p>
          <button className="secondary" disabled={index >= images.length - 1} onClick={() => setIndex((i) => i + 1)}>Next →</button>
        </footer>
      </div>
    </div>
  );
}

// Thumbnail strip under the verdict. Every image the assessment saw, with how much
// text came off each — a face that yielded nothing is the usual reason a
// requirement lands in "could not be determined".
export function EvidenceStrip({ images, ocr, onOpen }: {
  images: ScanImage[];
  ocr: ScanOcrImage[] | null;
  onOpen: (index: number) => void;
}) {
  if (images.length === 0) return null;
  return (
    <section className="field-panel ev-panel">
      <div className="field-panel-head">
        <h2>Images this assessment read</h2>
        <small className="muted">Tap an image to see the text found on it</small>
      </div>
      <ul className="ev-strip">
        {images.map((im, i) => {
          const page = ocr?.find((o) => o.assetId === im.id);
          const count = page?.blocks.length ?? null;
          return (
            <li key={im.id}>
              <button type="button" onClick={() => onOpen(i)}>
                <img src={assetUrl(im.id)} alt={`${SIDE_LABELS[im.side ?? ''] ?? 'Package'} face`} loading="lazy" />
                <span className="ev-strip-cap">
                  <b>{SIDE_LABELS[im.side ?? ''] ?? im.side ?? 'Unlabelled'}</b>
                  <small>
                    {count === null ? 'reading…'
                      : count === 0 ? 'no text found'
                        : `${count} text region${count === 1 ? '' : 's'}`}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
