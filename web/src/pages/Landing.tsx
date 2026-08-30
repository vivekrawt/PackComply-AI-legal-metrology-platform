import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getLang, setLang } from '../i18n';

// Landing page per PRD Appendix A concept: trustworthy government-enterprise
// visual language, three promises, primary CTA, realistic workbench preview,
// feature proof points. Decision-support positioning — never "replaces officers".

const Shield = ({ size = 22, color = '#fff' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3l7 2.5v5.2c0 4.5-3 8.2-7 9.8-4-1.6-7-5.3-7-9.8V5.5L12 3z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M9 11.6l2.1 2.1L15.3 9.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Ico = ({ d, color }: { d: string; color: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d={d} stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function Landing() {
  const nav = useNavigate();
  const lang = getLang();
  const switchLang = (l: string) => { setLang(l); window.location.reload(); };

  return (
    <div className="lp">
      {/* ---- Top navigation ---- */}
      <header className="lp-nav">
        <div className="lp-brand">
          <span className="lp-logo"><Shield /></span>
          <b>PackComply</b>
          <span className="lp-ai-pill">AI</span>
        </div>
        <nav className="lp-links" aria-label="Landing navigation">
          <a href="#platform">Platform</a>
          <a href="#how">How it works</a>
          <Link to="/login">Rule library</Link>
          <a href="#security">Security</a>
        </nav>
        <div className="lp-nav-right">
          <span className="lp-lang">
            <button className={lang === 'en' ? 'on' : ''} onClick={() => switchLang('en')}>EN</button>
            <span aria-hidden="true">|</span>
            <button className={lang === 'hi' ? 'on' : ''} onClick={() => switchLang('hi')} lang="hi">हिन्दी</button>
          </span>
          <Link className="lp-signin" to="/login">Sign in</Link>
          <Link className="btn primary lp-cta" to="/login">Start inspection</Link>
        </div>
      </header>

      {/* ---- Hero ---- */}
      <main className="lp-hero" id="platform">
        <div className="lp-hero-copy">
          <span className="lp-badge"><Shield size={15} color="#1d5bbf" /> BUILT FOR LEGAL METROLOGY ENFORCEMENT</span>
          <h1>Scan every label.<br />Verify every declaration.<br />Act with confidence.</h1>
          <p className="lp-sub">
            AI-assisted inspection for packaged commodities across retail stores,
            warehouses and e-commerce listings.
          </p>
          <div className="lp-hero-ctas">
            <Link className="btn primary lp-big-btn" to="/login">
              <Ico color="#fff" d="M12 16V5m0 0l-4 4m4-4l4 4M5 19h14" /> Upload product images
            </Link>
            <button className="lp-ghost-btn" onClick={() => nav('/login')}>
              <Ico color="#1c2733" d="M8 4h6l4 4v12H8zM14 4v4h4M10 13h6M10 16h6" /> View sample report
            </button>
          </div>
          <dl className="lp-stats">
            <div><dt>12+</dt><dd>declarations checked</dd></div>
            <div><dt>&lt;60 sec</dt><dd>first result target</dd></div>
            <div><dt className="teal">100%</dt><dd>audit-traceable evidence</dd></div>
          </dl>
        </div>

        {/* ---- Workbench preview (illustrative concept, mirrors the live app) ---- */}
        <div className="lp-mock" id="how" aria-label="Inspection workbench preview (illustrative)">
          <div className="lp-mock-chrome">
            <span className="dot r" /><span className="dot y" /><span className="dot g" />
            <span className="lp-mock-url">app.packcomply.gov.example/inspection/PC-240821</span>
            <Shield size={16} color="#1d5bbf" />
          </div>
          <div className="lp-mock-head">
            <b>Inspection #PC-240821</b>
            <span className="chip needs_review" style={{ letterSpacing: '.04em' }}>REVIEW</span>
            <span className="lp-mock-spacer" />
            <span className="muted">Save draft</span>
            <span className="btn primary lp-mini-btn">Create report</span>
          </div>
          <div className="lp-mock-body">
            <section className="lp-pane">
              <h3>Package view</h3>
              <div className="lp-pack">
                <div className="lp-pack-face">
                  <span className="lp-pack-brand">NUTRIBITES</span>
                  <span className="lp-pack-name">OAT &amp; NUT<br />ENERGY BAR</span>
                  <span className="lp-pack-decl">Net Qty. 180 g<br />MRP ₹199 incl. taxes</span>
                </div>
                <div className="lp-bbox" aria-hidden="true" />
              </div>
              <div className="lp-quality">Image quality: Good&nbsp;&nbsp;•&nbsp;&nbsp;Scale calibrated</div>
            </section>
            <section className="lp-pane">
              <h3>Compliance summary</h3>
              <div className="lp-score">
                <div><b>92%</b><span>confidence</span></div>
                <div><b className="amber">2</b><span>violations</span></div>
                <div><span>Rule set</span><b style={{ fontSize: '1rem' }}>2026.07</b></div>
              </div>
              <ul className="lp-results">
                <li className="ok"><span className="mark">✓</span><div><b>Manufacturer / packer details</b><small>Detected</small></div></li>
                <li className="ok"><span className="mark">✓</span><div><b>Net quantity</b><small>180 g</small></div></li>
                <li className="bad"><span className="mark">⚠</span><div><b>MRP format</b><small>Tax-inclusive wording missing</small></div></li>
                <li className="bad"><span className="mark">⚠</span><div><b>Consumer care email</b><small>Not detected</small></div></li>
              </ul>
              <div className="lp-evidence">📄 Evidence package ready <span aria-hidden="true">→</span></div>
            </section>
          </div>
        </div>
      </main>

      {/* ---- Proof points ---- */}
      <section className="lp-features" id="security">
        <div className="lp-feature">
          <span className="lp-fico blue"><Ico color="#1d5bbf" d="M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.4 3.8 5.6 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.6-3.8-9S9.5 5.4 12 3z" /></span>
          <div>
            <h2>Multilingual OCR</h2>
            <p>Extract English, Hindi and Indian-script declarations from curved, glossy and low-light packs.</p>
          </div>
        </div>
        <div className="lp-feature">
          <span className="lp-fico teal"><Ico color="#0e7f74" d="M12 3l9 5-9 5-9-5 9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5" /></span>
          <div>
            <h2>Rule-versioned validation</h2>
            <p>Apply the correct legal rule set by commodity, channel, jurisdiction and effective date.</p>
          </div>
        </div>
        <div className="lp-feature">
          <span className="lp-fico amber"><Ico color="#8a5800" d="M8 3h6l4 4v14H8zM14 3v4h4M11 12h6M11 15h6M11 18h4" /></span>
          <div>
            <h2>Evidence-ready reports</h2>
            <p>Preserve images, bounding boxes, extracted text, officer decisions and a tamper-evident audit trail.</p>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        Decision-support software for authorized enforcement officials — it does not replace the officer,
        the notice process, or judicial determination.
        <span>Concept UI · PackComply AI · Product Requirements Document v1.0</span>
      </footer>
    </div>
  );
}
