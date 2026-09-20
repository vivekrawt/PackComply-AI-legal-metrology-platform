import React from 'react';
import { SIDE_LABELS, type ComplianceCheck, type ScanImage, type ScanOcrImage } from '../api';
import { IconArrowLeft, IconClose } from '../components/icons';
import { STATUS_META, declarationLabel } from './ChecksView';

// The evidence viewer: the officer's own photographs, with the text the
// recogniser actually read drawn where it was read from.
//
// This is what makes a verdict checkable rather than merely stated. A declaration
// reported MISSING can be confirmed genuinely absent instead of simply unread; one
// reported MET can be seen on the package. When a check is open, the boxes whose
// text matches what the model quoted are highlighted and the rest recede — so the
// question "is it actually there?" is answered by looking, not by trusting.
//
// It takes the whole screen. The question it settles is answered by examining a
// photograph, and a photograph examined inside a dialog the size of a card is a
// photograph nobody examines.
//
// Boxes are fractions of the ORIGINAL photograph (the OCR sidecar maps them back
// out of its prepared image), so they land correctly on the picture as taken.

export const assetUrl = (assetId: string) => `/api/v1/assets/${assetId}/content`;

const sideLabel = (im: ScanImage | undefined) =>
  (im ? SIDE_LABELS[im.side ?? ''] ?? im.side ?? 'Unlabelled' : 'Unlabelled');

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
  // Reading confidence for the scan as a whole, shown as provenance — never as a
  // degree of legal compliance.
  confidence?: number | null;
  onClose: () => void;
}

export function EvidenceViewer({ images, ocr, startAt, highlight, confidence, onClose }: ViewerProps) {
  const [index, setIndex] = React.useState(startAt);
  const [showBoxes, setShowBoxes] = React.useState(true);
  const [hovered, setHovered] = React.useState<number | null>(null);

  const image = images[index];
  const page = ocr?.find((o) => o.assetId === image?.id) ?? null;
  const blocks = page?.blocks ?? [];
  const check = highlight?.check ?? null;
  const observed = check?.observedText ?? '';
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
  const m = check ? STATUS_META[check.status] ?? { label: check.status, tone: 'neutral', icon: '·' } : null;

  return (
    <div className="ev-backdrop" role="dialog" aria-modal="true" aria-label="Package image evidence">
      <div className="ev-shell">
        <header className="ev-head">
          <div>
            <h2>Package evidence</h2>
            <div className="ev-head-meta">
              <button className="link-btn" onClick={onClose}><IconArrowLeft />Back</button>
              <span aria-hidden="true">·</span>
              <span>Image {index + 1} of {images.length} — {sideLabel(image)}</span>
            </div>
          </div>
          <button className="ev-close" onClick={onClose} aria-label="Close the image viewer"><IconClose /></button>
        </header>

        <div className="ev-cols">
          <div>
            <div className="ev-stage">
              <div className="ev-frame">
                <img src={assetUrl(image.id)} alt={`${sideLabel(image)} face of the package`} />
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

            {images.length > 1 && (
              <div className="ev-thumbs">
                <button className="ev-nav-btn" disabled={index === 0} onClick={() => setIndex((i) => i - 1)} aria-label="Previous image">‹</button>
                <ul className="ev-strip">
                  {images.map((im, i) => (
                    <li key={im.id}>
                      <button
                        type="button" className={i === index ? 'on' : ''}
                        onClick={() => setIndex(i)} aria-current={i === index}
                      >
                        <img src={assetUrl(im.id)} alt={`${sideLabel(im)} face`} loading="lazy" />
                      </button>
                    </li>
                  ))}
                </ul>
                <button className="ev-nav-btn" disabled={index >= images.length - 1} onClick={() => setIndex((i) => i + 1)} aria-label="Next image">›</button>
              </div>
            )}
          </div>

          <aside className="ev-side">
            {check && m ? (
              <>
                <h3>{declarationLabel(check.parameter)}</h3>
                <span className={`chip pill ${m.tone}`}>
                  <span className="ico" aria-hidden="true">{m.icon}</span>{m.label}
                </span>
                {check.ruleReference && <p className="rule">{check.ruleReference}</p>}

                <h4>Recognised text</h4>
                {observed ? (
                  <>
                    <p className="ev-read">&ldquo;{observed}&rdquo;</p>
                    <p className="caveat">
                      {hits.size > 0
                        ? `Highlighted on the photograph — ${hits.size} matching text region${hits.size === 1 ? '' : 's'} on this image.`
                        : 'The quoted text was not located on this image. Check the other captured sides.'}
                    </p>
                  </>
                ) : (
                  <p className="caveat">
                    Nothing was quoted for this requirement — it was not found in the text read from
                    any image. Look for it on the package yourself: it may sit on a face that was not
                    captured, or in text the recogniser could not read.
                  </p>
                )}
              </>
            ) : (
              <>
                <h3>{sideLabel(image)}</h3>
                <p className="caveat">
                  {page === null
                    ? 'Text regions are still being read for this image.'
                    : !page.processed
                      ? 'This image was not read by the recogniser, so nothing is marked on it — and nothing on this face was available to the assessment.'
                      : blocks.length === 0
                        ? 'The recogniser read this image and found no legible text on it.'
                        : 'Every box marks text the recogniser read. Select one to see what it read.'}
                </p>
              </>
            )}

            <label className="ev-toggle">
              <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />
              <span>
                Show recognised text regions
                <small>{blocks.length} text region{blocks.length === 1 ? '' : 's'}</small>
              </span>
            </label>

            <div className="ev-prov">
              <h4>Evidence &amp; provenance</h4>
              <div className="ev-prov-row">
                <span>Reading confidence</span>
                <b>{confidence != null ? `${Math.round(confidence * 100)}%` : 'not reported'}</b>
              </div>
              <p className="caveat">Confidence reflects text legibility, not legal compliance.</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// The package as photographed: the face being read, and every other face under it.
//
// The assessment was made from these images and nothing else, so they sit beside
// the findings rather than below them — a declaration and the face it should be on
// are read together or not really read at all.
export function PackageFigure({ images, ocr, onOpen }: {
  images: ScanImage[];
  ocr: ScanOcrImage[] | null;
  onOpen: (index: number) => void;
}) {
  const [at, setAt] = React.useState(0);
  if (images.length === 0) {
    return (
      <div className="result-figure">
        <div className="empty">No images were captured for this package.</div>
      </div>
    );
  }
  const current = images[Math.min(at, images.length - 1)];
  return (
    <div className="result-figure">
      <button
        type="button" className="result-figure-main"
        onClick={() => onOpen(at)} aria-label={`Open the ${sideLabel(current)} face full size`}
      >
        <img src={assetUrl(current.id)} alt={`${sideLabel(current)} face of the package`} />
      </button>
      <ul className="ev-strip">
        {images.map((im, i) => {
          const page = ocr?.find((o) => o.assetId === im.id);
          const count = page?.blocks.length ?? null;
          return (
            <li key={im.id}>
              <button
                type="button" className={i === at ? 'on' : ''} onClick={() => setAt(i)}
                aria-current={i === at}
                title={count === null ? 'reading…' : count === 0 ? 'no text found' : `${count} text regions`}
              >
                <img src={assetUrl(im.id)} alt={`${sideLabel(im)} face`} loading="lazy" />
                <span className="ev-strip-cap">{sideLabel(im)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
