// Deterministic normalizers (EXT-04). Every normalized value preserves the
// verbatim source text (provenance) and flags ambiguity instead of guessing.

export interface Normalized {
  value: unknown;
  unit?: string;
  ambiguous: boolean;
  notes: string[];
  provenance: { verbatim: string };
}

const UNIT_MAP: Record<string, { unit: string; factorToBase: number; base: string }> = {
  g: { unit: 'g', factorToBase: 1, base: 'g' },
  gm: { unit: 'g', factorToBase: 1, base: 'g' },
  gram: { unit: 'g', factorToBase: 1, base: 'g' },
  grams: { unit: 'g', factorToBase: 1, base: 'g' },
  'ग्राम': { unit: 'g', factorToBase: 1, base: 'g' },
  kg: { unit: 'kg', factorToBase: 1000, base: 'g' },
  'किग्रा': { unit: 'kg', factorToBase: 1000, base: 'g' },
  mg: { unit: 'mg', factorToBase: 0.001, base: 'g' },
  ml: { unit: 'ml', factorToBase: 1, base: 'ml' },
  'मिली': { unit: 'ml', factorToBase: 1, base: 'ml' },
  l: { unit: 'l', factorToBase: 1000, base: 'ml' },
  ltr: { unit: 'l', factorToBase: 1000, base: 'ml' },
  litre: { unit: 'l', factorToBase: 1000, base: 'ml' },
  n: { unit: 'N', factorToBase: 1, base: 'count' },
  pcs: { unit: 'N', factorToBase: 1, base: 'count' },
  pieces: { unit: 'N', factorToBase: 1, base: 'count' },
  m: { unit: 'm', factorToBase: 100, base: 'cm' },
  cm: { unit: 'cm', factorToBase: 1, base: 'cm' },
};

const COUNTRY_MAP: Record<string, string> = {
  india: 'India', bharat: 'India', 'भारत': 'India',
  china: 'China', 'prc': 'China',
  malaysia: 'Malaysia', vietnam: 'Vietnam', 'viet nam': 'Vietnam',
  usa: 'United States', 'united states': 'United States', 'united states of america': 'United States',
  uk: 'United Kingdom', 'united kingdom': 'United Kingdom',
  germany: 'Germany', japan: 'Japan', thailand: 'Thailand', indonesia: 'Indonesia',
  'sri lanka': 'Sri Lanka', nepal: 'Nepal', bangladesh: 'Bangladesh',
};

const DEVANAGARI_DIGITS: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
};

export function toAsciiDigits(s: string): string {
  return s.replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] ?? d);
}

export function normalizeDeclaration(declType: string, verbatim: string): Normalized {
  const base: Normalized = { value: null, ambiguous: false, notes: [], provenance: { verbatim } };
  const text = toAsciiDigits(verbatim);
  switch (declType) {
    case 'mrp':
    case 'unit_sale_price': {
      const m = text.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i) || text.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:₹|Rs\.?|INR)/i);
      if (!m) { base.ambiguous = true; base.notes.push('No Indian-currency amount recognized'); return base; }
      const amount = Number(m[1].replace(/,/g, ''));
      const inclPhrase = /incl(usive|\.)?\s*(of)?\s*all\s*taxes/i.test(text);
      base.value = { amount, currency: 'INR', taxInclusivePhrasePresent: inclPhrase };
      if (!Number.isFinite(amount)) { base.ambiguous = true; base.value = null; }
      return base;
    }
    case 'net_quantity':
    case 'dimensions': {
      const m = text.match(/([\d.]+)\s*([a-zA-Zग्रामकिमिलीि]+)/);
      if (!m) { base.ambiguous = true; base.notes.push('No value-unit pair recognized'); return base; }
      const qty = Number(m[1]);
      const rawUnit = m[2].toLowerCase();
      const u = UNIT_MAP[rawUnit];
      if (!u) { base.ambiguous = true; base.notes.push(`Unit '${m[2]}' is not in the approved unit table`); base.value = { quantity: qty, rawUnit: m[2] }; return base; }
      base.value = { quantity: qty, baseQuantity: qty * u.factorToBase, baseUnit: u.base };
      base.unit = u.unit;
      return base;
    }
    case 'mfg_date':
    case 'import_date':
    case 'expiry': {
      const parsed = parseDate(text);
      if (!parsed) { base.ambiguous = true; base.notes.push('Date format not recognized'); return base; }
      base.value = parsed;
      return base;
    }
    case 'best_before': {
      const rel = text.match(/(\d+)\s*(month|months|महीने)/i);
      if (rel) { base.value = { relativeMonths: Number(rel[1]) }; return base; }
      const parsed = parseDate(text);
      if (parsed) { base.value = parsed; return base; }
      base.ambiguous = true; base.notes.push('Neither a date nor a relative period recognized');
      return base;
    }
    case 'consumer_care': {
      const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? null;
      const phone = text.match(/(?:1800[\s-]?[\d\s-]{6,}|\+?91[\s-]?\d{10}|\b\d{10}\b)/)?.[0]?.replace(/[\s-]+/g, ' ').trim() ?? null;
      base.value = { email, phone };
      if (!email && !phone) { base.ambiguous = true; base.notes.push('No email or phone number recognized'); }
      return base;
    }
    case 'country_of_origin': {
      const m = text.match(/(?:country of origin|made in|product of)\s*[:\-]?\s*([A-Za-z .]+)/i);
      const raw = (m?.[1] ?? text).trim().toLowerCase().replace(/[^a-z ]/g, '').trim();
      const country = COUNTRY_MAP[raw] ?? null;
      base.value = { country, raw: m?.[1]?.trim() ?? text.trim() };
      if (!country) { base.ambiguous = true; base.notes.push('Country name not in the normalization table'); }
      return base;
    }
    case 'responsible_entity': {
      const roleM = text.match(/(manufactured|mfd\.?|mfg\.?|packed|imported|marketed)\s*by/i);
      const role = roleM
        ? ({ manufactured: 'manufacturer', mfd: 'manufacturer', mfg: 'manufacturer', packed: 'packer', imported: 'importer', marketed: 'brand_owner' } as Record<string, string>)[
            roleM[1].toLowerCase().replace(/\./g, '')
          ] ?? 'unknown'
        : 'unknown';
      const after = text.split(/by\s*[:\-]?\s*/i)[1] ?? '';
      const pin = after.match(/\b\d{6}\b/)?.[0] ?? null;
      base.value = { role, nameAndAddress: after.trim() || text.trim(), pinCode: pin, hasAddressStructure: !!pin };
      if (role === 'unknown') { base.ambiguous = true; base.notes.push('Entity role wording not recognized'); }
      return base;
    }
    default: {
      base.value = { text: text.replace(/^[a-z_ ]+:\s*/i, '').trim() || text.trim() };
      return base;
    }
  }
}

function parseDate(text: string): { year: number; month: number; day?: number; iso: string } | null {
  let m = text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/); // DD/MM/YYYY
  if (m) {
    const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return { year, month, day, iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
  }
  m = text.match(/\b(\d{1,2})[\/.-](\d{4})\b/); // MM/YYYY
  if (m) {
    const month = Number(m[1]), year = Number(m[2]);
    if (month >= 1 && month <= 12) return { year, month, iso: `${year}-${String(month).padStart(2, '0')}` };
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i);
  if (m) {
    const month = months.indexOf(m[1].toLowerCase()) + 1;
    return { year: Number(m[2]), month, iso: `${m[2]}-${String(month).padStart(2, '0')}` };
  }
  return null;
}
