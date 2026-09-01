import { useEffect, useState } from 'react';
import { fetchIntelEvents } from '../api';

// Raw framework slugs come straight out of the framework-intel registry and
// aren't fit for display (e.g. "nist-csf", "pcidss"). This is the only place
// that needs to know about them, so the map lives here rather than in utils/.
const FRAMEWORK_LABELS = {
  ai: 'AI (general)',
  'ai-basic-act': 'AI Basic Act (Korea)',
  aiact: 'EU AI Act',
  cbpr: 'CBPR',
  ccpa: 'CCPA',
  cmmc: 'CMMC',
  cpra: 'CPRA',
  dora: 'DORA',
  dsa: 'DSA',
  essentialeight: 'Essential Eight',
  fedramp: 'FedRAMP',
  gdpr: 'GDPR',
  'global-privacy': 'Global Privacy',
  iso27001: 'ISO 27001',
  iso42001: 'ISO 42001',
  'microsoft-dpr': 'Microsoft DPR',
  'neural-data-privacy': 'Neural Data Privacy',
  'nist-csf': 'NIST CSF',
  nydfs: 'NYDFS',
  pcidss: 'PCI DSS',
  privacy: 'Privacy (general)',
  privacyact: 'Privacy Act',
  soc2: 'SOC 2',
  sox: 'SOX',
  ukgdpr: 'UK GDPR',
  'us-state-privacy': 'US State Privacy',
};

const frameworkLabel = (slug) =>
  FRAMEWORK_LABELS[slug] || slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

// Same idea as FRAMEWORK_LABELS: registry region codes aren't display-ready
// ("south-korea", bare "us"/"uk" that should read as acronyms).
const REGION_LABELS = {
  apec: 'APEC', au: 'AU', china: 'China', eu: 'EU', fr: 'FR', global: 'Global',
  hawaii: 'Hawaii', nz: 'NZ', 'south-korea': 'South Korea', uk: 'UK', us: 'US',
};

const regionLabel = (code) =>
  REGION_LABELS[code] || code.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

const changeTypeLabel = (t) => t.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const byRecent = (a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt);

// The classifier's Claude-generated text (whatsHappening/talkingPoint/
// whoToTarget) leans on em dashes as a clause separator, which reads as a
// run-on on a card. Broken into line breaks here, at render time, rather
// than in framework-intel's classifier — so this holds for every event
// already synced *and* every future sync, with nothing to remember to do
// on that side.
function withLineBreaks(text) {
  const parts = String(text || '').split('—').map((p) => p.trim()).filter(Boolean);
  return parts.flatMap((part, i) => (i === 0 ? [part] : [<br key={`br-${i}`} />, part]));
}

function IntelCard({ event }) {
  const confirmed = event.tier === 'primary';
  return (
    <div className="intel-card">
      <div className="intel-card-tags">
        {event.frameworks.map((f) => (
          <span className="chip chip-framework" key={f}>{frameworkLabel(f)}</span>
        ))}
        {event.regions.map((r) => (
          <span className="chip chip-region" key={r}>{regionLabel(r)}</span>
        ))}
      </div>

      <p className="intel-card-body">{withLineBreaks(event.whatsHappening)}</p>

      {event.outreachWorthy && event.whoToTarget && (
        <div className="intel-callout">
          <span className="intel-callout-label">Talking point</span>
          <p>{withLineBreaks(`${event.whoToTarget} — “${event.talkingPoint}”`)}</p>
        </div>
      )}

      <div className="intel-card-meta">
        <span className={`badge ${confirmed ? 'compliant' : 'compliance-unconfirmed'}`}>
          {confirmed ? 'Confirmed' : 'Unconfirmed'}
        </span>
        <span className="intel-kicker">{changeTypeLabel(event.changeType)}</span>
      </div>

      <div className="intel-card-foot">
        <a className="company-link" href={event.sourceUrl} target="_blank" rel="noreferrer">
          {confirmed ? 'View source' : `Reported by ${event.sourceId}`} →
        </a>
        <span className="intel-foot-rest">
          {formatDate(event.fetchedAt)} · {event.confidence} confidence
        </span>
      </div>
    </div>
  );
}

export default function IntelligenceScreen() {
  const [events, setEvents] = useState(null); // null while loading, [] once fetched (possibly empty)
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [frameworkFilter, setFrameworkFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [tierFilter, setTierFilter] = useState('');

  useEffect(() => {
    fetchIntelEvents().then(setEvents).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!events) return <p className="muted">Loading…</p>;

  // Filter dropdown options come from the full dataset, not the filtered view —
  // narrowing to CCPA shouldn't make every other framework vanish from its own list.
  const allFrameworks = [...new Set(events.flatMap((e) => e.frameworks))]
    .sort((a, b) => frameworkLabel(a).localeCompare(frameworkLabel(b)));
  const allRegions = [...new Set(events.flatMap((e) => e.regions))]
    .sort((a, b) => regionLabel(a).localeCompare(regionLabel(b)));

  const q = search.trim().toLowerCase();
  const matchesSearch = (e) =>
    !q ||
    e.whatsHappening.toLowerCase().includes(q) ||
    e.talkingPoint.toLowerCase().includes(q) ||
    e.changeType.toLowerCase().includes(q) ||
    e.frameworks.some((f) => frameworkLabel(f).toLowerCase().includes(q) || f.includes(q));

  const filtered = events.filter(
    (e) =>
      matchesSearch(e) &&
      (!frameworkFilter || e.frameworks.includes(frameworkFilter)) &&
      (!regionFilter || e.regions.includes(regionFilter)) &&
      (!tierFilter || e.tier === tierFilter)
  );
  const outreachCount = filtered.filter((e) => e.outreachWorthy).length;
  const frameworkCount = new Set(filtered.flatMap((e) => e.frameworks)).size;

  const body = filtered.length === 0
    ? (
      <div className="panel empty-state">
        <p className="muted">{events.length === 0 ? 'No intel synced yet.' : 'No intel matches these filters.'}</p>
      </div>
    )
    : (
      <div className="intel-list">
        {[...filtered].sort(byRecent).map((e) => <IntelCard event={e} key={e.id} />)}
      </div>
    );

  return (
    <div>
      <div className="panel">
        <div className="stat-row">
          <div className="stat-card tone-neutral">
            <div className="dot" />
            <div>
              <div className="num">{filtered.length}</div>
              <div className="label">tracked changes</div>
            </div>
          </div>
          <div className="stat-card tone-primary">
            <div className="dot" />
            <div>
              <div className="num">{frameworkCount}</div>
              <div className="label">frameworks</div>
            </div>
          </div>
          <div className="stat-card tone-green">
            <div className="dot" />
            <div>
              <div className="num">{outreachCount}</div>
              <div className="label">outreach-worthy</div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="form-row" style={{ marginBottom: 0 }}>
          <label>
            Search
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
            />
          </label>
          <label>
            Framework
            <select value={frameworkFilter} onChange={(e) => setFrameworkFilter(e.target.value)}>
              <option value="">All</option>
              {allFrameworks.map((f) => <option key={f} value={f}>{frameworkLabel(f)}</option>)}
            </select>
          </label>
          <label>
            Region
            <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}>
              <option value="">All</option>
              {allRegions.map((r) => <option key={r} value={r}>{regionLabel(r)}</option>)}
            </select>
          </label>
          <label>
            Status
            <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
              <option value="">All</option>
              <option value="primary">Confirmed</option>
              <option value="watch">Unconfirmed</option>
            </select>
          </label>
        </div>
      </div>

      {body}
    </div>
  );
}
