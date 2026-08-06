import { getCompanyHref } from '../utils/companyLink';
import { complianceBadge } from '../utils/compliance';

const VERDICT_LABELS = { qualified: 'Qualified', nei: 'Not enough information', disqualified: 'Disqualified' };

function Signal({ label, value }) {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return null;
  return (
    <div className="signal">
      <div className="k">{label}</div>
      <div className="v">{Array.isArray(value) ? value.join(', ') : String(value)}</div>
    </div>
  );
}

export default function LeadCard({ lead }) {
  const q = lead.qualification || {};
  const domain = lead.website?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const companyHref = getCompanyHref(lead.website);
  const compliance = complianceBadge(q);

  return (
    <div className="lead-card">
      <h2>{companyHref ? <a className="company-link" href={companyHref} target="_blank" rel="noreferrer">{lead.companyName}</a> : lead.companyName}</h2>
      <div className="lead-card-header">
        {lead.website && (
          <a href={lead.website} target="_blank" rel="noreferrer">{domain}</a>
        )}
        <span className={`badge ${lead.status}`}>{VERDICT_LABELS[lead.status] || lead.status}</span>
        <span className={`badge ${compliance.compliant ? 'compliant' : 'compliance-unconfirmed'}`}>{compliance.label}</span>
      </div>

      {q.reasoning && <div className="reasoning">{q.reasoning}</div>}
      {lead.disqualifyReason && !q.reasoning && <div className="reasoning">{lead.disqualifyReason}</div>}

      <div className="signals">
        <Signal label="Industry" value={lead.industry} />
        <Signal label="Employees" value={lead.employees} />
        <Signal label="Location" value={[lead.city, lead.country].filter(Boolean).join(', ')} />
        <Signal label="Founded" value={lead.foundedYear} />
        <Signal label="Funding" value={[lead.totalFunding, lead.latestFundingStage].filter(Boolean).join(' · ')} />
        <Signal label="Product" value={q.productDescription} />
        <Signal label="Target persona" value={q.targetPersona} />
        <Signal label="B2B / SaaS" value={q.isB2B && `B2B: ${q.isB2B} · SaaS: ${q.isSaaS}`} />
        <Signal label="Compliance language" value={q.complianceLanguage} />
        <Signal label="Integrations" value={q.integrations} />
        <Signal label="Notable customers" value={q.customers} />
        <Signal label="Keywords" value={lead.keywords?.slice(0, 10)} />
        <Signal label="Technologies" value={lead.technologies?.slice(0, 10)} />
      </div>

      {lead.companyLinkedinUrl && (
        <a href={lead.companyLinkedinUrl} target="_blank" rel="noreferrer">LinkedIn profile</a>
      )}
    </div>
  );
}
