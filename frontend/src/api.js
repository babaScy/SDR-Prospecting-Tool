const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const startPull = (profile, region, count) =>
  request('/api/pull', { method: 'POST', body: JSON.stringify({ profile, region, count }) });

export const fetchLists = () => request('/api/lists');
export const fetchList = (id) => request(`/api/lists/${id}`);
export const fetchLeads = (id, bucket) => request(`/api/lists/${id}/leads?bucket=${bucket}`);

export const sendDecision = (leadId, decision) =>
  request(`/api/leads/${leadId}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
