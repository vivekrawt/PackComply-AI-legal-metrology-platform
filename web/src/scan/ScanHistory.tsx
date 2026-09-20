import React from 'react';
import { Link } from 'react-router-dom';
import { api, type ScanSummary } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { ScanTable } from './ScanTable';

// Every product this officer has scanned. Scope is enforced server-side; this
// list only renders what the API already decided the officer may see.
//
// Each filter carries its own count, so the shape of the officer's own casework is
// legible before anything is clicked — and an empty filter is visibly empty rather
// than a table that turns out to have nothing in it.

type Filter = 'all' | 'compliant' | 'non_compliant' | 'needs_review' | 'unanalysed';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'compliant', label: 'Ready' },
  { key: 'non_compliant', label: 'Not ready' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'unanalysed', label: 'Not analysed' },
];

const match = (s: ScanSummary, f: Filter) =>
  (f === 'all' ? true : f === 'unanalysed' ? s.verdict == null : s.verdict === f);

export function ScanHistory() {
  const [filter, setFilter] = React.useState<Filter>('all');
  const { data, error, loading } = useAsync(() => api.get<{ scans: ScanSummary[] }>('/scans?limit=200'), []);
  const all = data?.scans ?? [];
  const scans = all.filter((s) => match(s, filter));

  return (
    <div className="field-page">
      <h1>Scan history</h1>
      <p className="page-sub">{all.length} product{all.length === 1 ? '' : 's'} scanned</p>

      <div className="pc-filters" role="group" aria-label="Filter scans by assessment">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-chip ${filter === f.key ? 'on' : ''}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label} ({all.filter((s) => match(s, f.key)).length})
          </button>
        ))}
      </div>

      <ErrorText error={error} />
      {loading && <p className="muted">Loading…</p>}

      {!loading && scans.length === 0 && (
        <div className="scan-empty">
          <b>{all.length === 0 ? 'No scans yet' : 'Nothing under this filter'}</b>
          <p>
            {all.length === 0
              ? <>Scan your first product and it will appear here. <Link to="/app/scan/new">Scan a product</Link>.</>
              : 'Choose another filter to see the rest of your scans.'}
          </p>
        </div>
      )}

      {scans.length > 0 && <ScanTable scans={scans} />}

      <p className="disclaimer">Decision support for authorised officers.</p>
    </div>
  );
}
