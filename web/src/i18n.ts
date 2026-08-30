// Localization scaffold (NFR-LOC-01): UI strings live here, not in components.
// English complete; Hindi PARTIAL (key operational labels) — extend per glossary approval.
type Dict = Record<string, string>;

const en: Dict = {
  'app.name': 'PackComply AI',
  'app.tagline': 'Legal Metrology compliance inspection — decision support',
  'nav.dashboard': 'Dashboard',
  'nav.inspections': 'Inspections',
  'nav.newInspection': 'New Inspection',
  'nav.repository': 'Repository / Search',
  'nav.rules': 'Legal Rule Library',
  'nav.audit': 'Audit Log',
  'nav.users': 'User Administration',
  'nav.analytics': 'Analytics',
  'nav.logout': 'Sign out',
  'login.title': 'Officer sign-in',
  'login.email': 'Official e-mail',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'status.draft': 'Draft', 'status.capturing': 'Capturing', 'status.processing': 'Processing',
  'status.review': 'In review', 'status.pending_approval': 'Pending approval',
  'status.finalized': 'Finalized', 'status.closed': 'Closed',
  'common.confidenceNote': 'Model confidence is assistive only — it is never a legal compliance score.',
  'demo.banner': 'DEMO PROVIDERS ACTIVE — image quality, OCR and extraction results come from deterministic mock providers, not production AI.',
};

const hi: Dict = {
  'app.name': 'PackComply AI',
  'app.tagline': 'विधिक माप विज्ञान अनुपालन निरीक्षण — निर्णय सहायता',
  'nav.dashboard': 'डैशबोर्ड',
  'nav.inspections': 'निरीक्षण',
  'nav.newInspection': 'नया निरीक्षण',
  'nav.repository': 'भंडार / खोज',
  'nav.rules': 'विधिक नियम पुस्तकालय',
  'nav.audit': 'लेखा-परीक्षा लॉग',
  'nav.users': 'उपयोगकर्ता प्रशासन',
  'nav.analytics': 'विश्लेषण',
  'nav.logout': 'साइन आउट',
  'login.title': 'अधिकारी साइन-इन',
  'login.email': 'आधिकारिक ई-मेल',
  'login.password': 'पासवर्ड',
  'login.submit': 'साइन इन',
};

const dicts: Record<string, Dict> = { en, hi };
let current = localStorage.getItem('packcomply.lang') ?? 'en';

export function setLang(lang: string) {
  current = dicts[lang] ? lang : 'en';
  localStorage.setItem('packcomply.lang', current);
}
export function getLang() { return current; }
export function t(key: string): string {
  return dicts[current]?.[key] ?? en[key] ?? key;
}
