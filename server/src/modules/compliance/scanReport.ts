import PDFDocument from 'pdfkit';
import type { DB } from '../../db/index.js';
import { now } from '../../db/index.js';
import { notFound, unprocessable } from '../../core/errors.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import type { SessionUser } from '../auth/service.js';
import { getInspection } from '../inspections/service.js';
import { listInspectionAssets } from '../evidence/service.js';
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

export async function scanReportPdf(report: ReturnType<typeof buildScanReport>): Promise<Buffer> {
  const a = report.assessment;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Model-authored strings can carry Devanagari (the model quotes what OCR read),
    // so everything variable goes through the encoder before it reaches the page.
    const safe = (v: unknown) => toWinAnsi(String(v ?? '')).text;
    const h = (t: string) => doc.moveDown(0.7).fontSize(13).fillColor('#12233d').text(t).moveDown(0.2).fontSize(9.5).fillColor('#222');
    const kv = (k: string, v: unknown) => { if (v != null && v !== '') doc.text(`${k}: ${safe(v)}`); };
    const tone = a.overall === 'compliant' ? '#0e7f74' : a.overall === 'non_compliant' ? '#b3261e' : '#8a5800';

    doc.fontSize(18).fillColor('#12233d').text('Package Compliance Scan Report');
    doc.moveDown(0.3).fontSize(15).fillColor(tone).text(STATUS_LABEL[a.overall] ?? a.overall);
    doc.moveDown(0.3).fontSize(9).fillColor('#555').text(report.disclaimer, { align: 'left' });

    if (a.judgedBy.isMock) {
      doc.moveDown(0.3).fillColor('#8a5800').text(
        'NOTICE: no language model was configured on this server. The assessment below comes from a '
        + 'deterministic pattern matcher and is NOT a reading of the Legal Metrology Rules.',
      );
    }
    if (a.judgeError) {
      doc.moveDown(0.3).fillColor('#b3261e').text(`ASSESSMENT ERROR: ${safe(a.judgeError)}`);
    }
    doc.fillColor('#222');

    h('1. Scan');
    kv('Scan reference', report.scan.scanId);
    kv('Scanned at', report.scan.scannedAt);
    kv('Date governing rule selection', report.scan.eventDate);
    kv('Location', report.scan.location);
    kv('Officer', `${report.scan.officer.name} <${report.scan.officer.email}>`);
    kv('Report generated at', report.scan.generatedAt);

    h('2. Product');
    const p = report.product as any;
    if (p) {
      kv('Brand', p.brand); kv('Common / generic name', p.genericName);
      kv('Category', p.category); kv('Pack size', p.packSize); kv('Import status', p.importStatus);
    } else {
      doc.text('No product details were recorded by the officer.');
    }

    h('3. Assessment');
    kv('Outcome', STATUS_LABEL[a.overall] ?? a.overall);
    if (a.summary) doc.moveDown(0.2).text(safe(a.summary));

    const group = (title: string, status: string, colour: string) => {
      const items = a.checks.filter((c: any) => c.status === status);
      if (items.length === 0) return;
      doc.moveDown(0.5).fontSize(10.5).fillColor(colour).text(`${title} (${items.length})`).fontSize(9.5).fillColor('#222');
      for (const c of items) {
        doc.moveDown(0.25).fillColor(colour).text(`• ${safe(c.parameter)}`, { continued: true })
          .fillColor('#555').text(c.ruleReference ? `  — ${safe(c.ruleReference)}` : '');
        doc.fillColor('#222');
        // For a satisfied check this is the declaration; for a failed one it is
        // only related text, which is a different claim.
        if (c.observedText) {
          const label = c.status === 'present' ? 'Found on the package' : 'Related text on the package';
          doc.text(`   ${label}: "${safe(c.observedText)}"`);
        }
        if (c.issue) doc.text(`   ${safe(c.issue)}`);
        if (c.remedy) doc.fillColor('#0e7f74').text(`   To fix: ${safe(c.remedy)}`).fillColor('#222');
      }
    };
    group('Missing for compliance', 'missing', '#b3261e');
    group('Could not be determined from the images', 'unclear', '#8a5800');
    group('Compliance requirements met', 'present', '#0e7f74');

    h('4. Evidence');
    for (const e of report.evidence) {
      doc.text(`• [${safe(e.side ?? 'unlabelled')}] ${safe(e.originalName ?? e.assetId)} — SHA-256 ${e.sha256.slice(0, 24)}… (${safe(e.source)}, ${e.receivedAt})`);
    }
    if (report.evidence.length === 0) doc.text('No images are attached to this scan.');

    h('5. Provenance');
    kv('Assessed by', `${a.judgedBy.provider} · ${a.judgedBy.modelVersion}${a.judgedBy.isMock ? ' (not an AI assessment)' : ''}`);
    kv('Statutory text applied', a.statutoryText.sources.join(', ') || 'none');
    kv('Statutory text SHA-256', a.statutoryText.sha256 ?? 'n/a');
    kv('Assessed at', a.assessedAt);
    kv('Reading confidence', a.confidence != null ? `${Math.round(a.confidence * 100)}% (OCR legibility, not a degree of legal compliance)` : 'not reported');
    kv('Report SHA-256', report.sha256);

    h('6. Text read from the package (OCR)');
    // pdfkit's built-in fonts are WinAnsi: Devanagari and other non-Latin scripts
    // are silently dropped rather than rendered. OCR runs eng+hin, so this section
    // can legitimately contain Hindi. Say so instead of printing a gap — the JSON
    // report carries the text in full either way.
    const ocr = a.ocrTextRead || '(no text was recovered)';
    const { text: renderable, dropped } = toWinAnsi(ocr);
    if (dropped > 0) {
      doc.fillColor('#8a5800').text(
        `Note: ${dropped} character(s) in Devanagari or another non-Latin script cannot be rendered in `
        + 'this document and are omitted below. The JSON scan report carries the complete OCR text.',
      ).fillColor('#222');
    }
    doc.fontSize(8).fillColor('#444').text(renderable.trim() || '(no Latin-script text was recovered)');
    doc.fontSize(9.5).fillColor('#222');

    const cross = report.ruleEngineCrossCheck;
    if (cross.findings.length > 0) {
      h('7. Rule-engine cross-check');
      doc.fillColor('#555').text(cross.note).fillColor('#222').moveDown(0.2);
      for (const f of cross.findings) {
        doc.text(`• [${safe(f.outcome)}] ${safe(f.title)} (${safe(f.ruleKey)}) — ${safe(f.citation)}`);
      }
    }

    doc.end();
  });
}

export function requireScanReport(db: DB, inspectionId: string, user: SessionUser) {
  const insp = db.prepare('SELECT id FROM inspections WHERE id = ? AND deleted_at IS NULL').get(inspectionId);
  if (!insp) throw notFound('Scan not found');
  return buildScanReport(db, inspectionId, user);
}
