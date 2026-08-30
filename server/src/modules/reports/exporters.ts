// Report export providers (RPT-02). All exporters render EXCLUSIVELY from the
// stored immutable report snapshot — never from live data.
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } from 'docx';

export interface ReportBundle {
  reportId: string; inspectionId: string; version: number; sha256: string; snapshot: any;
}

const OUTCOME_LABEL: Record<string, string> = {
  passed: 'Compliant', failed: 'Non-compliant', needs_review: 'Needs Review',
  not_applicable: 'Not Applicable', not_assessable: 'Not Assessable',
};

export function exportJson(r: ReportBundle): Buffer {
  return Buffer.from(JSON.stringify({
    reportId: r.reportId, inspectionId: r.inspectionId, version: r.version, sha256: r.sha256,
    snapshot: r.snapshot,
  }, null, 2), 'utf-8');
}

export function exportManifest(r: ReportBundle): Buffer {
  const s = r.snapshot;
  return Buffer.from(JSON.stringify({
    reportId: r.reportId, reportVersion: r.version, reportSha256: r.sha256,
    inspectionId: r.inspectionId,
    files: s.evidenceManifest.assets.map((a: any) => ({
      assetId: a.id, kind: a.kind, faceLabel: a.faceLabel, sha256: a.sha256, mime: a.mime,
      originalName: a.originalName, source: a.source, capturedAt: a.capturedAt, receivedAt: a.receivedAt,
    })),
    calibrations: s.evidenceManifest.calibrations,
    annotations: s.evidenceManifest.annotations,
    ruleVersions: s.appliedLegalContext.ruleVersions,
    modelVersions: s.appliedLegalContext.modelVersions,
    engineVersion: s.appliedLegalContext.engineVersion,
  }, null, 2), 'utf-8');
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(r: ReportBundle): Buffer {
  const s = r.snapshot;
  const rows: string[][] = [[
    'report_id', 'report_version', 'inspection_id', 'record_type', 'key', 'verbatim_or_title',
    'outcome', 'severity', 'confidence', 'citation', 'explanation',
  ]];
  for (const d of s.declarationResults) {
    rows.push([r.reportId, String(r.version), r.inspectionId, 'declaration', d.declType,
      d.verbatim, '', '', d.confidence != null ? String(d.confidence) : '', '', '']);
  }
  for (const f of s.officerConclusion.findings) {
    const v = s.violationsAndObservations.find((x: any) => x.ruleKey === f.ruleKey);
    rows.push([r.reportId, String(r.version), r.inspectionId, 'finding', f.ruleKey,
      v?.ruleTitle ?? f.ruleKey, f.effectiveOutcome, v?.severity ?? '', '', v?.citation ?? '', v?.explanation ?? '']);
  }
  return Buffer.from('﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n'), 'utf-8');
}

export async function exportPdf(r: ReportBundle): Promise<Buffer> {
  const s = r.snapshot;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const h = (t: string) => doc.moveDown(0.6).fontSize(13).fillColor('#12233d').text(t).moveDown(0.2).fontSize(9.5).fillColor('#222');
    const kv = (k: string, v: unknown) => { if (v != null && v !== '') doc.text(`${k}: ${v}`); };

    doc.fontSize(18).fillColor('#12233d').text('Legal Metrology Compliance Report');
    doc.fontSize(9).fillColor('#555')
      .text(`Report ${r.reportId} · version ${r.version} · SHA-256 ${r.sha256.slice(0, 24)}…`)
      .text('Decision-support output. The authorized officer remains responsible for the final finding.');
    if (s.appliedLegalContext.usesMockProviders) {
      doc.fillColor('#8a5800').text('DEMO NOTICE: declaration extraction used a MOCK/DEMO provider and is not benchmarked.');
    }
    doc.fillColor('#222');

    h('1. Identification');
    kv('Inspection', s.identification.inspectionId);
    kv('Type', s.identification.inspectionType);
    kv('Event date', s.identification.eventDate);
    kv('Location', s.identification.location);
    kv('Jurisdiction', [s.identification.jurisdiction.state, s.identification.jurisdiction.district, s.identification.jurisdiction.office].filter(Boolean).join(' / '));
    kv('Generated at', s.identification.generatedAt);

    h('2. Product and parties');
    const p = s.productAndParties.product;
    if (p) { kv('Brand', p.brand); kv('Product', p.genericName); kv('Category', p.category); kv('GTIN', p.gtin); kv('Pack size', p.packSize); kv('Import status', p.importStatus); }
    kv('Seller', s.productAndParties.seller?.name);

    h('3. Evidence manifest');
    for (const a of s.evidenceManifest.assets) {
      doc.text(`• [${a.faceLabel ?? a.kind}] ${a.originalName ?? a.url ?? a.id} — SHA-256 ${a.sha256?.slice(0, 20) ?? 'n/a'}… (${a.source}, received ${a.receivedAt})`);
    }
    for (const c of s.evidenceManifest.calibrations) {
      doc.text(`• Calibration: ${c.method}, ${c.mmPerPx} mm/px${c.uncertaintyPct != null ? ` ±${c.uncertaintyPct}%` : ''}`);
    }

    h('4. Applied legal context');
    kv('Event date for rule selection', s.appliedLegalContext.eventDate);
    kv('Engine version', s.appliedLegalContext.engineVersion);
    kv('Model versions', JSON.stringify(s.appliedLegalContext.modelVersions));
    for (const rv of s.appliedLegalContext.ruleVersions) {
      doc.text(`• ${rv.ruleKey} v${rv.version} — ${rv.title} (${rv.citation})${rv.legalStatus === 'REQUIRES_LEGAL_APPROVAL' ? ' [REQUIRES LEGAL APPROVAL]' : ''}`);
    }
    for (const ex of s.appliedLegalContext.exclusions ?? []) {
      doc.text(`• Excluded: ${ex.ruleKey} — ${ex.reason}`);
    }

    h('5. Declaration results');
    for (const d of s.declarationResults) {
      doc.text(`• ${d.declType} [${d.sourceChannel}] — "${d.verbatim}" (model confidence ${d.confidence ?? 'n/a'}; confidence is not a legal status)`);
      for (const c of d.corrections) doc.fillColor('#555').text(`   corrected ${c.field}: "${c.original}" → "${c.corrected}" (${c.reason})`).fillColor('#222');
    }

    h('6. Violations / observations');
    const v = s.violationsAndObservations;
    if (v.length === 0) doc.text('No open violations or observations.');
    for (const f of v) {
      doc.fillColor(f.outcome === 'failed' ? '#8f1f1f' : '#8a5800')
        .text(`• [${OUTCOME_LABEL[f.outcome] ?? f.outcome}${f.severity ? ', severity ' + f.severity : ''}] ${f.ruleTitle} (rule ${f.ruleKey} v${f.ruleVersion})`);
      doc.fillColor('#222').text(`   ${f.explanation}`);
      doc.fillColor('#555').text(`   Citation: ${f.citation}`).fillColor('#222');
    }

    h('7. Officer conclusion');
    kv('Overall status', OUTCOME_LABEL[s.officerConclusion.overallStatus] ?? s.officerConclusion.overallStatus);
    for (const f of s.officerConclusion.findings) {
      doc.text(`• ${f.ruleKey}: system ${OUTCOME_LABEL[f.evaluationOutcome] ?? f.evaluationOutcome} → officer ${OUTCOME_LABEL[f.effectiveOutcome] ?? f.effectiveOutcome} (${f.status})`);
      for (const o of f.overrides) doc.fillColor('#555').text(`   override: ${o.reason}${o.approvedBy ? ` (approved by ${o.approvedBy})` : ''}`).fillColor('#222');
    }
    if (s.officerConclusion.notes) kv('Notes', s.officerConclusion.notes);

    h('8. Audit and verification');
    kv('Report SHA-256', r.sha256);
    kv('Generated', s.auditAndVerification.generatedAt);
    doc.text(`Evidence hashes: ${s.auditAndVerification.evidenceHashes.map((x: string) => x.slice(0, 16) + '…').join(', ')}`);
    doc.text('Verify via GET /api/v1/reports/:id/verify');

    doc.end();
  });
}

export async function exportDocx(r: ReportBundle): Promise<Buffer> {
  const s = r.snapshot;
  const para = (t: string) => new Paragraph({ children: [new TextRun({ text: t, size: 20 })] });
  const heading = (t: string) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2 });
  const children: any[] = [
    new Paragraph({ text: 'Legal Metrology Compliance Report', heading: HeadingLevel.HEADING_1 }),
    para(`Report ${r.reportId} · version ${r.version} · SHA-256 ${r.sha256}`),
    para('Decision-support output. The authorized officer remains responsible for the final finding.'),
  ];
  if (s.appliedLegalContext.usesMockProviders) {
    children.push(para('DEMO NOTICE: declaration extraction used a MOCK/DEMO provider and is not benchmarked.'));
  }
  children.push(heading('1. Identification'),
    para(`Inspection ${s.identification.inspectionId} · ${s.identification.inspectionType} · event date ${s.identification.eventDate} · ${s.identification.location ?? ''}`));
  const p = s.productAndParties.product;
  children.push(heading('2. Product and parties'),
    para(p ? `${p.brand ?? ''} ${p.genericName ?? ''} · category ${p.category ?? '-'} · GTIN ${p.gtin ?? '-'} · ${p.importStatus ?? ''}` : 'No product context recorded'));
  children.push(heading('3. Evidence manifest'));
  for (const a of s.evidenceManifest.assets) children.push(para(`[${a.faceLabel ?? a.kind}] ${a.originalName ?? a.url ?? a.id} — SHA-256 ${a.sha256 ?? 'n/a'}`));
  children.push(heading('4. Applied legal context'));
  for (const rv of s.appliedLegalContext.ruleVersions) {
    children.push(para(`${rv.ruleKey} v${rv.version} — ${rv.title} (${rv.citation})${rv.legalStatus === 'REQUIRES_LEGAL_APPROVAL' ? ' [REQUIRES LEGAL APPROVAL]' : ''}`));
  }
  children.push(heading('5. Declaration results'));
  const declRows = [
    new TableRow({ children: ['Type', 'Channel', 'Verbatim', 'Confidence'].map((t) =>
      new TableCell({ children: [para(t)] })) }),
    ...s.declarationResults.map((d: any) => new TableRow({
      children: [d.declType, d.sourceChannel, d.verbatim, String(d.confidence ?? '')].map((t) =>
        new TableCell({ children: [para(String(t))] })),
    })),
  ];
  children.push(new Table({ rows: declRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  children.push(heading('6. Violations / observations'));
  for (const f of s.violationsAndObservations) {
    children.push(para(`[${OUTCOME_LABEL[f.outcome] ?? f.outcome}${f.severity ? ', ' + f.severity : ''}] ${f.ruleTitle}: ${f.explanation} — ${f.citation}`));
  }
  children.push(heading('7. Officer conclusion'),
    para(`Overall: ${OUTCOME_LABEL[s.officerConclusion.overallStatus] ?? s.officerConclusion.overallStatus}`));
  children.push(heading('8. Audit and verification'), para(`Report SHA-256: ${r.sha256}`));

  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
