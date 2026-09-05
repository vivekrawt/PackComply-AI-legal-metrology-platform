import React from 'react';
import { Link } from 'react-router-dom';
import { api, type ScanSummary } from '../api';
import { ErrorText, useAsync } from '../components/common';
import { ScanRow } from './ScanHome';

// Every product this officer has scanned. Scope is enforced server-side; this
// list only renders what the API already decided the officer may see.

type Filter = 'all' | 'compliant' | 'non_compliant' | 'needs_review';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'compliant', label: 'Compliance ready' },
  { key: 'non_compliant', label: 'Not ready' },
  { key: 'needs_review', label: 'Needs review' },
];

export function ScanHistory() {
  const [filter, setFilter] = React.useState<Filter>('all');
  const { data, error, loading } = useAsync(() => api.get<{ scans: ScanSummary[] }>('/scans?limit=200'), []);
  const all = data?.scans ?? [];
  const scans = filter === 'all' ? all : all.filter((s) => s.verdict === filter);

  return (
    <div className="field-page">
      <h1>Scan history</h1>
      <p className="muted">{all.length} product{all.length === 1 ? '' : 's'} scanned.</p>

      <div className="filter-row" role="group" aria-label="Filter scans by outcome">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-chip ${filter === f.key ? 'on' : ''}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key !== 'all' && ` (${all.filter((s) => s.verdict === f.key).length})`}
          </button>
        ))}
      </div>

      <ErrorText error={error} />
      {loading && <p className="muted">Loading…</p>}
      {!loading && scans.length === 0 && (
        <p className="muted">
          {all.length === 0
            ? <>No scans yet. <Link to="/app/scan/new">Scan your first product</Link>.</>
            : 'No scans match this filter.'}
        </p>
      )}

      <ul className="scan-list">
        {scans.map((s) => <ScanRow key={s.scanId} scan={s} />)}
      </ul>
    </div>
  );
}
