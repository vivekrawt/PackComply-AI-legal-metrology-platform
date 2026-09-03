// Provider abstraction (PRD: OCR provider abstraction).
// The application depends only on these interfaces. Bundled implementations are
// deterministic MOCK/DEMO providers; every result is stamped with provider name,
// model version and isMock so mock output can never masquerade as production AI.

export interface ProviderMeta {
  provider: string;
  modelVersion: string;
  isMock: boolean;
}

export interface BBox { x: number; y: number; w: number; h: number } // fractions of image [0..1]

export interface AssetInput {
  assetId: string;
  sha256: string;
  mime: string;
  faceLabel: string | null;
  structuredJson?: unknown;          // structured listing evidence, when present
  productContext?: {
    brand?: string | null; genericName?: string | null; category?: string | null;
    importStatus?: string | null; packSize?: string | null;
  };
  // Real (non-mock) providers need the pixels: lazy loader for the ORIGINAL
  // binary (read-only; the store is content-addressed and immutable) plus the
  // parsed pixel dimensions where the format is supported.
  loadContent?: () => Buffer;
  imageSize?: { w: number; h: number } | null;
}

export interface QualityResult extends ProviderMeta {
  // blur, exposure, glare, occlusion, resolution, textScale, curvature, clipping,
  // completeness, orientation, labelVisibility (0..1, higher = better)
  scores: Record<string, number>;
  overall: number;
  // e.g. BLUR_HIGH, TOO_DARK, LABEL_NOT_VISIBLE, ORIENTATION_WRONG, FACE_INCOMPLETE.
  // Capture quality only — NEVER legal codes. DUPLICATE_IMAGE is not produced here:
  // exact duplicates are refused deterministically at upload by hash comparison.
  reasonCodes: string[];
  recapture: { recommended: boolean; guidance: string[] };
}

export interface LayoutRegion { kind: 'package_face' | 'pdp' | 'text_region' | 'declaration_cluster' | 'sticker'; bbox: BBox; confidence: number }
export interface LayoutResult extends ProviderMeta { regions: LayoutRegion[] }

export interface OcrBlock {
  text: string; bbox: BBox; readingOrder: number;
  script: 'latin' | 'devanagari' | 'mixed'; lang: 'en' | 'hi' | 'mixed'; confidence: number;
}
export interface OcrResult extends ProviderMeta { blocks: OcrBlock[] }

export interface ExtractionCandidate {
  declType: string;
  verbatimText: string;
  bbox: BBox;
  ocrBlockIndexes: number[];
  lang: string; script: string; confidence: number;
  sourceChannel: 'physical' | 'listing';
}
export interface ExtractionResult extends ProviderMeta { candidates: ExtractionCandidate[] }

export interface FontMeasurement {
  declType: string;
  charHeightPx: number;
  widthHeightRatio: number;
  lineSpacingPx: number;
  sampleChars: string;
  confidence: number;
}
export interface FontMeasurementResult extends ProviderMeta { measurements: FontMeasurement[] }

// ---- Compliance judge -------------------------------------------------------
// Reads the OCR text of a scanned package against the statutory corpus and
// returns an officer-facing verdict. This is the LLM step in the field-officer
// scan flow. Like every other provider it is stamped with provider/modelVersion/
// isMock, and the corpus it read is identified by hash on the stored verdict.

export type ComplianceStatus = 'compliant' | 'non_compliant' | 'needs_review';

export interface ComplianceCheck {
  parameter: string;        // e.g. "Net quantity"
  ruleReference: string;    // e.g. "Rule 6(1)(d), LMPC 2011"
  status: 'present' | 'missing' | 'unclear';
  observedText: string;     // verbatim span the model relied on ('' when absent)
  issue: string;            // why it fails / needs review ('' when satisfied)
  remedy: string;           // what the packer must change ('' when satisfied)
}

export interface RulesCorpus {
  text: string;
  sha256: string;
  sources: string[];
  chars: number;
}

export interface ComplianceJudgeInput {
  eventDate: string;
  ocrText: string;                                        // exactly what is sent
  faces: { faceLabel: string | null; text: string }[];
  productContext?: {
    brand?: string | null; genericName?: string | null; category?: string | null;
    importStatus?: string | null; packSize?: string | null;
  };
  // Deterministic rule-engine output for the same package. Secondary, clearly
  // labeled cross-check material — not the model's source of law.
  engineFindings: { ruleKey: string; title: string; outcome: string; explanation: string; citation: string }[];
}

export interface ComplianceVerdict extends ProviderMeta {
  overall: ComplianceStatus;
  summary: string;
  confidence: number;
  checks: ComplianceCheck[];
  raw?: unknown;
}

export interface ComplianceJudgeProvider extends ProviderMeta {
  judge(input: ComplianceJudgeInput, rules: RulesCorpus): Promise<ComplianceVerdict>;
}

export interface ImageQualityProvider extends ProviderMeta { assess(input: AssetInput): Promise<QualityResult> }
export interface LayoutProvider extends ProviderMeta { detect(input: AssetInput): Promise<LayoutResult> }
export interface OCRProvider extends ProviderMeta { recognize(input: AssetInput): Promise<OcrResult> }
export interface DeclarationExtractionProvider extends ProviderMeta {
  extract(input: AssetInput, ocr: OcrResult): Promise<ExtractionResult>;
}
export interface FontMeasurementProvider extends ProviderMeta {
  measure(input: AssetInput, candidates: ExtractionCandidate[]): Promise<FontMeasurementResult>;
}
export interface MalwareScanner {
  name: string;
  scan(buf: Buffer, filename: string): Promise<{ clean: boolean; threat?: string }>;
}
