import PDFDocument from 'pdfkit';
import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { notFound, unprocessable } from '../../core/errors.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import type { SessionUser } from '../auth/service.js';
import { getInspection } from '../inspections/service.js';
import { getAssetContent, listInspectionAssets } from '../evidence/service.js';
import { listFindings } from '../findings/service.js';
import { listEvaluations } from '../evaluation/service.js';
import { latestVerdict } from './service.js';

// The scan report: what a field officer takes away from a scan.
//
// It is deliberately NOT the finalized enforcement report. Finalization is a
// legal act gated on every material finding having been reviewed by an officer
// (finalizationBlockers), and a field officer scanning a shelf has reviewed
// nothing yet. Producing this document does not finalize the inspection, does
// not mutate any record, and says on its face that it is decision support.
//
// It is still evidence-grade: it carries the SHA-256 of every image, the hash of
// the statutory text the model read, the model version, and the OCR text the
// verdict was formed from — enough to reproduce or challenge the assessment.

// Face labels in the officer's words. The scan flow's vocabulary lives in the web
// client; the report is generated server-side and has to say the same thing.
const SIDE_LABEL: Record<string, string> = {
  top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right',
  front: 'Front', back: 'Back', closeup: 'Close-up', other: 'Other side',
};

const STATUS_LABEL: Record<string, string> = {
  compliant: 'COMPLIANCE READY',
  non_compliant: 'NOT COMPLIANCE READY',
  needs_review: 'NEEDS REVIEW',
};

// pdfkit's built-in fonts use WinAnsi encoding, so anything outside it (notably
// Devanagari, which the eng+hin OCR does produce) is dropped from the page with no
// trace. Map the few characters that have a faithful Latin equivalent, drop the
// rest, and let the caller tell the reader that something was omitted — a silent
// gap in an evidence document is worse than an ugly one.
const WINANSI_EQUIV: Record<string, string> = { '₹': 'Rs.', ' ': ' ' };
const WINANSI_OK = /[\t\n\r\x20-\x7e¡-ÿ–—‘’“”•…]/;

export function toWinAnsi(s: string): { text: string; dropped: number } {
  let out = '';
  let dropped = 0;
  for (const ch of s) {
    if (WINANSI_EQUIV[ch] !== undefined) out += WINANSI_EQUIV[ch];
    else if (WINANSI_OK.test(ch)) out += ch;
    else dropped++;
  }
  return { text: out, dropped };
}

export function buildScanReport(db: DB, inspectionId: string, generatedBy: SessionUser) {
  const insp = getInspection(db, inspectionId);
  const verdict = latestVerdict(db, inspectionId);
  if (!verdict) {
    throw unprocessable('This scan has not been analysed yet, so there is nothing to report.');
  }
  const assets = listInspectionAssets(db, inspectionId).filter((a: any) => a.kind === 'image');
  const { evaluations } = listEvaluations(db, inspectionId);

  const model = {
    documentType: 'scan_report',
    disclaimer:
      'Decision-support output produced from photographs of a package. It is not a finalized '
      + 'enforcement report and carries no determination: the authorised officer remains '
      + 'responsible for any finding, notice or prosecution.',
    scan: {
      scanId: insp.id,
      scannedAt: insp.createdAt,
      eventDate: insp.eventDate,
      location: insp.location,
      officer: { id: generatedBy.id, name: generatedBy.name, email: generatedBy.email },
      generatedAt: now(),
    },
    product: insp.product,
    evidence: assets.map((a: any) => ({
      assetId: a.id, side: a.faceLabel, originalName: a.originalName,
      sha256: a.sha256, sizeBytes: a.sizeBytes, source: a.source,
      capturedAt: a.capturedAt, receivedAt: a.receivedAt,
    })),
    assessment: {
      overall: verdict.overall,
      summary: verdict.summary,
      confidence: verdict.confidence,
      checks: verdict.checks,
      // Provenance: without these three the verdict is unreproducible.
      judgedBy: { provider: verdict.provider, modelVersion: verdict.modelVersion, isMock: verdict.isMock },
      statutoryText: { sources: verdict.rulesSources, sha256: verdict.rulesSha256 },
      ocrTextRead: verdict.ocrText,
      judgeError: verdict.error,
      assessedAt: verdict.createdAt,
    },
    ruleEngineCrossCheck: {
      note: 'Deterministic pattern-matching engine, run separately from the AI assessment. '
        + 'Shown for comparison; the two assessments are not merged.',
      engineVersion: evaluations[0]?.engineVersion ?? null,
      findings: listFindings(db, inspectionId).map((f: any) => ({
        ruleKey: f.ruleKey, title: f.ruleTitle, outcome: f.effectiveOutcome,
        severity: f.severity, explanation: f.explanation, citation: f.citation,
      })),
    },
  };

  return { ...model, sha256: sha256Hex(canonicalJson(model)) };
}

// ---- PDF ---------------------------------------------------------------------
// The document an officer files or forwards. It is read on a phone in a shop and
// printed into a case folder, so it is laid out rather than dumped: a verdict
// callout that is legible at arm's length, findings grouped by what the officer
// must DO about them, and the package images reproduced with the reading taken
// from each — a claim about a package that does not show the package is hard to
// act on and harder to challenge.

const PAGE = { width: 595.28, height: 841.89 };
const M = 48;                                   // page margin
const CONTENT_W = PAGE.width - M * 2;           // 499.28
const FOOT_Y = PAGE.height - 42;                // footer baseline
const BOTTOM = FOOT_Y - 16;                     // last y a section may occupy

const INK = '#1c2733';
const SOFT = '#51606f';
const LINE = '#d8dee8';
const NAVY = '#12233d';

// Status → colour + words. Colour is never the only carrier: every pill and
// heading also states its status in text, which survives greyscale printing and
// colour-blind readers alike.
const TONE: Record<string, { fg: string; bg: string; label: string }> = {
  present: { fg: '#0e7f74', bg: '#e2f4f1', label: 'MET' },
  missing: { fg: '#b3261e', bg: '#fbe9e7', label: 'MISSING' },
  unclear: { fg: '#8a5800', bg: '#fdf1dc', label: 'UNCLEAR' },
};
const OVERALL_TONE: Record<string, { fg: string; bg: string; border: string }> = {
  compliant: { fg: '#0e7f74', bg: '#e2f4f1', border: '#9fd6cf' },
  non_compliant: { fg: '#b3261e', bg: '#fbe9e7', border: '#e8b3ae' },
  needs_review: { fg: '#8a5800', bg: '#fdf1dc', border: '#e8cf9b' },
};

// Images the PDF can actually embed. pdfkit handles JPEG and PNG only; anything
// else (HEIC, PDF pages) is listed in the evidence table but not reproduced, and
// the document says so rather than leaving a silent gap.
export interface ReportImage {
  assetId: string;
  side: string | null;
  originalName: string | null;
  sha256: string;
  mime: string;
  source: string | null;
  buf: Buffer | null;
  blocks: number;
}

export function loadScanImages(db: DB, inspectionId: string): ReportImage[] {
  const assets = listInspectionAssets(db, inspectionId).filter((a: any) => a.kind === 'image');
  return assets.map((a: any) => {
    const embeddable = a.mime === 'image/jpeg' || a.mime === 'image/png';
    let buf: Buffer | null = null;
    if (embeddable) {
      // A missing blob must not take the whole report down: the evidence table
      // still cites the hash, and the plate says the image could not be read.
      try { buf = getAssetContent(db, a.id).buf; } catch { buf = null; }
    }
    const blocks = (db.prepare('SELECT COUNT(*) AS c FROM ocr_blocks WHERE asset_id = ?')
      .get(a.id) as any).c as number;
    return {
      assetId: a.id, side: a.faceLabel, originalName: a.originalName, sha256: a.sha256,
      mime: a.mime, source: a.source, buf, blocks,
    };
  });
}

export async function scanReportPdf(
  report: ReturnType<typeof buildScanReport>,
  images: ReportImage[] = [],
): Promise<Buffer> {
  const a = report.assessment;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: M, size: 'A4', bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Model-authored strings can carry Devanagari (the model quotes what OCR
    // read), so everything variable goes through the encoder before the page.
    const safe = (v: unknown) => toWinAnsi(String(v ?? '')).text;

    // --- primitives ----------------------------------------------------------
    const need = (h: number) => { if (doc.y + h > BOTTOM) doc.addPage(); };
    const body = (size = 9.5, colour = INK) => doc.font('Helvetica').fontSize(size).fillColor(colour);

    // Section rule: a numbered heading with a hairline under it, so the eye can
    // find a section without reading it.
    let sectionNo = 0;
    const section = (title: string) => {
      sectionNo += 1;
      need(46);
      doc.moveDown(0.9);
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(NAVY).text(`${sectionNo}. ${title}`, M, y);
      doc.moveTo(M, doc.y + 3).lineTo(M + CONTENT_W, doc.y + 3).lineWidth(0.8).strokeColor(LINE).stroke();
      doc.y += 10;
      body();
    };

    // Two-column key/value rows. Values wrap under their own column rather than
    // running back under the label, which is what made the old layout hard to scan.
    const KEY_W = 150;
    const kv = (k: string, v: unknown) => {
      if (v == null || v === '') return;
      const text = safe(v);
      const h = doc.font('Helvetica').fontSize(9).heightOfString(text, { width: CONTENT_W - KEY_W });
      need(h + 6);
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor(SOFT).text(`${k}`, M, y, { width: KEY_W - 8 });
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(text, M + KEY_W, y, { width: CONTENT_W - KEY_W });
      doc.y = Math.max(doc.y, y + h) + 3;
    };

    // A small filled pill. Returns its width so a caller can lay text beside it.
    const pill = (text: string, x: number, y: number, fg: string, bg: string) => {
      doc.font('Helvetica-Bold').fontSize(7.2);
      const w = doc.widthOfString(text) + 12;
      doc.roundedRect(x, y, w, 13, 6.5).fillColor(bg).fill();
      doc.fillColor(fg).text(text, x + 6, y + 3.4, { lineBreak: false });
      return w;
    };

    // --- cover ---------------------------------------------------------------
    doc.rect(0, 0, PAGE.width, 96).fillColor(NAVY).fill();
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#ffffff')
      .text('Package Compliance Scan Report', M, 30, { width: CONTENT_W - 150 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#9db2cc')
      .text(`Scan ${safe(report.scan.scanId)}`, M, 58, { width: CONTENT_W - 150 });
    doc.font('Helvetica').fontSize(7.6).fillColor('#9db2cc')
      .text('DECISION SUPPORT — NOT A FINALIZED ENFORCEMENT REPORT', M, 74, { width: CONTENT_W });
    doc.y = 118;

    // Verdict callout — the one thing that must be readable across a desk.
    const ot = OVERALL_TONE[a.overall] ?? OVERALL_TONE.needs_review;
    const label = STATUS_LABEL[a.overall] ?? a.overall;
    const summaryText = a.summary ? safe(a.summary) : '';
    doc.font('Helvetica').fontSize(9);
    const sumH = summaryText ? doc.heightOfString(summaryText, { width: CONTENT_W - 36 }) : 0;
    const calloutH = 46 + (sumH ? sumH + 8 : 0);
    const calloutY = doc.y;
    doc.roundedRect(M, calloutY, CONTENT_W, calloutH, 10).fillColor(ot.bg).fill();
    doc.roundedRect(M, calloutY, CONTENT_W, calloutH, 10).lineWidth(1).strokeColor(ot.border).stroke();
    doc.font('Helvetica-Bold').fontSize(15).fillColor(ot.fg).text(label, M + 18, calloutY + 15);
    if (summaryText) {
      doc.font('Helvetica').fontSize(9).fillColor(INK)
        .text(summaryText, M + 18, calloutY + 42, { width: CONTENT_W - 36 });
    }
    doc.y = calloutY + calloutH + 14;

    // Tally strip: three counts, the shape of the result before any reading.
    const met = a.checks.filter((c: any) => c.status === 'present').length;
    const miss = a.checks.filter((c: any) => c.status === 'missing').length;
    const unc = a.checks.filter((c: any) => c.status === 'unclear').length;
    const cells: [string, number, string][] = [
      ['REQUIREMENTS MET', met, TONE.present.fg],
      ['MISSING', miss, TONE.missing.fg],
      ['COULD NOT DETERMINE', unc, TONE.unclear.fg],
    ];
    const cw = (CONTENT_W - 16) / 3;
    const ty = doc.y;
    cells.forEach(([caption, n, colour], i) => {
      const x = M + i * (cw + 8);
      doc.roundedRect(x, ty, cw, 46, 8).fillColor('#f5f7fa').fill();
      doc.roundedRect(x, ty, cw, 46, 8).lineWidth(0.8).strokeColor(LINE).stroke();
      doc.font('Helvetica-Bold').fontSize(17).fillColor(colour)
        .text(String(n), x, ty + 8, { width: cw, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(6.4).fillColor(SOFT)
        .text(caption, x + 4, ty + 31, { width: cw - 8, align: 'center' });
    });
    doc.y = ty + 46;

    if (a.judgedBy.isMock) {
      need(46);
      doc.moveDown(0.6);
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.4);
      const noticeText = 'NOTICE: no language model was configured on this server. The assessment below comes '
        + 'from a deterministic pattern matcher and is NOT a reading of the Legal Metrology Rules.';
      const nh = doc.heightOfString(noticeText, { width: CONTENT_W - 24 }) + 16;
      doc.roundedRect(M, y, CONTENT_W, nh, 8).fillColor('#fdf1dc').fill();
      doc.fillColor('#8a5800').text(noticeText, M + 12, y + 8, { width: CONTENT_W - 24 });
      doc.y = y + nh;
    }
    if (a.judgeError) {
      need(46);
      doc.moveDown(0.6);
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.4);
      const errText = `ASSESSMENT ERROR: ${safe(a.judgeError)}`;
      const eh = doc.heightOfString(errText, { width: CONTENT_W - 24 }) + 16;
      doc.roundedRect(M, y, CONTENT_W, eh, 8).fillColor('#fbe9e7').fill();
      doc.fillColor('#b3261e').text(errText, M + 12, y + 8, { width: CONTENT_W - 24 });
      doc.y = y + eh;
    }

    // --- 1. Scan and product -------------------------------------------------
    section('Scan and product');
    kv('Scan reference', report.scan.scanId);
    kv('Scanned at', report.scan.scannedAt);
    kv('Date governing rules', report.scan.eventDate);
    kv('Location', report.scan.location);
    kv('Officer', `${report.scan.officer.name} <${report.scan.officer.email}>`);
    kv('Report generated at', report.scan.generatedAt);
    const p = report.product as any;
    if (p && (p.brand || p.genericName || p.category || p.packSize || p.importStatus)) {
      kv('Brand', p.brand);
      kv('Common / generic name', p.genericName);
      kv('Category', p.category);
      kv('Pack size', p.packSize);
      kv('Import status', p.importStatus);
    } else {
      kv('Product details', 'None recorded by the officer.');
    }

    // --- 2. Findings ---------------------------------------------------------
    section('Findings');
    body(9, SOFT).text(
      'Every mandatory declaration the assessment considered, grouped by what it requires of you. '
      + '"Could not be determined" is not a pass: it marks evidence the images do not settle.',
      M, doc.y, { width: CONTENT_W },
    );
    doc.moveDown(0.4);

    const group = (title: string, status: string, hint: string) => {
      const items = a.checks.filter((c: any) => c.status === status);
      if (items.length === 0) return;
      const t = TONE[status];
      need(52);
      doc.moveDown(0.5);
      const hy = doc.y;
      doc.rect(M, hy, 3, 15).fillColor(t.fg).fill();
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(t.fg)
        .text(`${title} (${items.length})`, M + 10, hy + 1.5);
      doc.font('Helvetica').fontSize(8).fillColor(SOFT).text(hint, M + 10, doc.y + 1, { width: CONTENT_W - 10 });
      doc.y += 6;

      for (const c of items) {
        // Measure the whole card first so a finding is never split across pages
        // with its remedy orphaned on the next one.
        const parts: { text: string; size: number; font: string; colour: string }[] = [];
        if (c.observedText) {
          const lbl = c.status === 'present' ? 'Found on the package' : 'Related text on the package';
          parts.push({ text: `${lbl}: "${safe(c.observedText)}"`, size: 8.4, font: 'Helvetica-Oblique', colour: SOFT });
        }
        if (c.issue) parts.push({ text: safe(c.issue), size: 8.8, font: 'Helvetica', colour: INK });
        if (c.remedy) parts.push({ text: `To fix: ${safe(c.remedy)}`, size: 8.8, font: 'Helvetica-Bold', colour: '#0e7f74' });

        let h = 26;
        for (const part of parts) {
          doc.font(part.font).fontSize(part.size);
          h += doc.heightOfString(part.text, { width: CONTENT_W - 36 }) + 3;
        }
        need(h + 10);

        const cy = doc.y;
        doc.roundedRect(M, cy, CONTENT_W, h, 7).fillColor('#ffffff').fill();
        doc.roundedRect(M, cy, CONTENT_W, h, 7).lineWidth(0.8).strokeColor(LINE).stroke();
        doc.rect(M, cy + 6, 2.5, h - 12).fillColor(t.fg).fill();

        const pw = pill(t.label, M + 12, cy + 7, t.fg, t.bg);
        if (c.ruleReference) {
          doc.font('Helvetica').fontSize(7.6).fillColor(SOFT)
            .text(safe(c.ruleReference), M + 12, cy + 9, { width: CONTENT_W - 24, align: 'right', lineBreak: false });
        }
        doc.font('Helvetica-Bold').fontSize(9.4).fillColor(NAVY)
          .text(safe(c.parameter), M + 12 + pw + 8, cy + 8.4, { width: CONTENT_W - 120 - pw, lineBreak: false });
        let py = cy + 24;
        for (const part of parts) {
          doc.font(part.font).fontSize(part.size).fillColor(part.colour)
            .text(part.text, M + 24, py, { width: CONTENT_W - 36 });
          py = doc.y + 3;
        }
        doc.y = cy + h + 6;
      }
    };
    group('Missing for compliance', 'missing',
      'Required by the Rules and not found on the package. These are what a notice would cite.');
    group('Could not be determined from the images', 'unclear',
      'The images do not settle these. Re-photograph the relevant face before drawing any conclusion.');
    group('Compliance requirements met', 'present',
      'Found on the package. Recorded so the assessment can be checked in both directions.');
    if (a.checks.length === 0) {
      body().text('The assessment returned no individual checks.', M, doc.y, { width: CONTENT_W });
    }

    // --- 3. Package images ---------------------------------------------------
    section('Package images');
    body(9, SOFT).text(
      'The photographs the assessment was formed from. Each is identified by the SHA-256 of the '
      + 'exact bytes held in the evidence store, so a plate here can be tied to the register below.',
      M, doc.y, { width: CONTENT_W },
    );
    doc.moveDown(0.5);

    if (images.length === 0) {
      body().text('No images are attached to this scan.', M, doc.y, { width: CONTENT_W });
    }
    // Two plates per row: large enough to read a label on paper, small enough
    // that a four-face scan does not run to four pages.
    const plateW = (CONTENT_W - 14) / 2;
    const plateH = 150;
    let col = 0;
    let rowTop = doc.y;
    for (const img of images) {
      if (col === 0) { need(plateH + 40); rowTop = doc.y; }
      const x = M + col * (plateW + 14);
      doc.roundedRect(x, rowTop, plateW, plateH + 30, 8).fillColor('#f5f7fa').fill();
      doc.roundedRect(x, rowTop, plateW, plateH + 30, 8).lineWidth(0.8).strokeColor(LINE).stroke();
      if (img.buf) {
        try {
          doc.image(img.buf, x + 8, rowTop + 8, { fit: [plateW - 16, plateH - 8], align: 'center', valign: 'center' });
        } catch {
          doc.font('Helvetica').fontSize(8).fillColor(SOFT)
            .text('(this image could not be rendered)', x + 8, rowTop + plateH / 2, { width: plateW - 16, align: 'center' });
        }
      } else {
        doc.font('Helvetica').fontSize(8).fillColor(SOFT).text(
          img.mime === 'image/jpeg' || img.mime === 'image/png'
            ? '(image bytes unavailable)'
            : `(${safe(img.mime)} cannot be reproduced in a PDF)`,
          x + 8, rowTop + plateH / 2 - 6, { width: plateW - 16, align: 'center' },
        );
      }
      doc.font('Helvetica-Bold').fontSize(8.4).fillColor(NAVY)
        .text(safe(SIDE_LABEL[img.side ?? ''] ?? img.side ?? 'Unlabelled side'), x + 8, rowTop + plateH + 4,
          { width: plateW - 16, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(SOFT).text(
        `SHA-256 ${img.sha256.slice(0, 20)}…  ·  ${img.blocks} text region${img.blocks === 1 ? '' : 's'} read`,
        x + 8, rowTop + plateH + 15, { width: plateW - 16, lineBreak: false },
      );
      col += 1;
      if (col === 2) { col = 0; doc.y = rowTop + plateH + 38; }
    }
    if (col === 1) doc.y = rowTop + plateH + 38;

    // --- 4. Evidence register ------------------------------------------------
    section('Evidence register');
    const colW = [74, 150, 60, 215.28];
    const headRow = ['Side', 'File', 'Source', 'SHA-256'];
    need(24);
    let ry = doc.y;
    doc.rect(M, ry, CONTENT_W, 16).fillColor('#eef1f6').fill();
    let cx = M;
    headRow.forEach((label2, i) => {
      doc.font('Helvetica-Bold').fontSize(7.4).fillColor(SOFT)
        .text(label2, cx + 6, ry + 4.6, { width: colW[i] - 8, lineBreak: false });
      cx += colW[i];
    });
    doc.y = ry + 16;
    for (const e of report.evidence) {
      need(20);
      ry = doc.y;
      const row = [
        safe(SIDE_LABEL[e.side ?? ''] ?? e.side ?? 'unlabelled'),
        safe(e.originalName ?? e.assetId),
        safe(e.source ?? '-'),
        e.sha256,
      ];
      cx = M;
      row.forEach((text, i) => {
        doc.font(i === 3 ? 'Courier' : 'Helvetica').fontSize(i === 3 ? 6.4 : 7.6).fillColor(INK)
          .text(text, cx + 6, ry + 4, { width: colW[i] - 8, height: 12, ellipsis: true, lineBreak: false });
        cx += colW[i];
      });
      doc.moveTo(M, ry + 15).lineTo(M + CONTENT_W, ry + 15).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.y = ry + 16;
    }
    if (report.evidence.length === 0) {
      body().text('No images are attached to this scan.', M, doc.y + 4, { width: CONTENT_W });
    }

    // --- 5. Provenance -------------------------------------------------------
    section('Provenance');
    body(9, SOFT).text(
      'What produced this assessment, and against which text. Without these an assessment '
      + 'cannot be reproduced or challenged.', M, doc.y, { width: CONTENT_W });
    doc.moveDown(0.4);
    kv('Assessed by', `${a.judgedBy.provider} · ${a.judgedBy.modelVersion}${a.judgedBy.isMock ? ' (not an AI assessment)' : ''}`);
    kv('Statutory text applied', a.statutoryText.sources.join(', ') || 'none');
    kv('Statutory text SHA-256', a.statutoryText.sha256 ?? 'n/a');
    kv('Assessed at', a.assessedAt);
    kv('Reading confidence', a.confidence != null
      ? `${Math.round(a.confidence * 100)}% — reflects OCR legibility, not a degree of legal compliance`
      : 'not reported');
    kv('Report SHA-256', report.sha256);

    // --- 6. Rule-engine cross-check -----------------------------------------
    const cross = report.ruleEngineCrossCheck;
    if (cross.findings.length > 0) {
      section('Rule-engine cross-check');
      body(9, SOFT).text(cross.note, M, doc.y, { width: CONTENT_W });
      doc.moveDown(0.4);
      for (const f of cross.findings) {
        const outcome = String(f.outcome ?? '');
        const t = outcome === 'pass' ? TONE.present : outcome === 'fail' ? TONE.missing : TONE.unclear;
        const expl = f.explanation ? safe(f.explanation) : '';
        doc.font('Helvetica').fontSize(7.6);
        const eh = expl ? doc.heightOfString(expl, { width: CONTENT_W - 24 }) : 0;
        const h = 30 + (eh ? eh + 2 : 0);
        need(h + 6);
        const cy = doc.y;
        doc.roundedRect(M, cy, CONTENT_W, h, 6).fillColor('#ffffff').fill();
        doc.roundedRect(M, cy, CONTENT_W, h, 6).lineWidth(0.7).strokeColor(LINE).stroke();
        const pw = pill(safe(outcome.replace(/_/g, ' ').toUpperCase()), M + 10, cy + 7, t.fg, t.bg);
        doc.font('Helvetica-Bold').fontSize(8.6).fillColor(NAVY)
          .text(safe(f.title), M + 10 + pw + 8, cy + 8, { width: CONTENT_W - 28 - pw, lineBreak: false });
        doc.font('Helvetica').fontSize(6.8).fillColor(SOFT)
          .text(`${safe(f.ruleKey)} · ${safe(f.citation)}`, M + 10, cy + 20, { width: CONTENT_W - 20, lineBreak: false });
        if (expl) {
          doc.font('Helvetica').fontSize(7.6).fillColor(INK)
            .text(expl, M + 12, cy + 30, { width: CONTENT_W - 24 });
        }
        doc.y = cy + h + 5;
      }
    }

    // --- 7. OCR text ---------------------------------------------------------
    section('Text read from the package (OCR)');
    // pdfkit's built-in fonts are WinAnsi: Devanagari and other non-Latin scripts
    // are silently dropped rather than rendered. OCR runs eng+hin, so this section
    // can legitimately contain Hindi. Say so instead of printing a gap — the JSON
    // report carries the text in full either way.
    const ocr = a.ocrTextRead || '(no text was recovered)';
    const { text: renderable, dropped } = toWinAnsi(ocr);
    if (dropped > 0) {
      body(8, '#8a5800').text(
        `Note: ${dropped} character(s) in Devanagari or another non-Latin script cannot be rendered in `
        + 'this document and are omitted below. The JSON scan report carries the complete OCR text.',
        M, doc.y, { width: CONTENT_W },
      );
      doc.moveDown(0.3);
    }
    doc.font('Courier').fontSize(7.6).fillColor('#444')
      .text(renderable.trim() || '(no Latin-script text was recovered)', M, doc.y, { width: CONTENT_W });

    // --- footers -------------------------------------------------------------
    // Written last, across every buffered page: an extracted page still says what
    // it belongs to and that it is not a determination.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // The footer sits below the bottom margin. pdfkit treats text written past
      // that margin as overflow and starts a continuation page for it — which
      // silently doubled the page count. Drop the margin for the write, restore
      // it after, so the footer lands on the page it belongs to and nothing else
      // follows it.
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(M, FOOT_Y - 8).lineTo(M + CONTENT_W, FOOT_Y - 8).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.6).fillColor(SOFT).text(
        `${safe(report.scan.scanId)} · decision support only; the authorised officer decides`,
        M, FOOT_Y, { width: CONTENT_W - 60, lineBreak: false },
      );
      doc.font('Helvetica').fontSize(6.6).fillColor(SOFT).text(
        `Page ${i + 1} of ${range.count}`, M + CONTENT_W - 60, FOOT_Y, { width: 60, align: 'right', lineBreak: false },
      );
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}

export function requireScanReport(db: DB, inspectionId: string, user: SessionUser) {
  const insp = db.prepare('SELECT id FROM inspections WHERE id = ? AND deleted_at IS NULL').get(inspectionId);
  if (!insp) throw notFound('Scan not found');
  return buildScanReport(db, inspectionId, user);
}
