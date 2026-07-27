const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
export const USER_STORAGE_KEY = 'prospectorUser';

async function request(path, options = {}) {
  const email = localStorage.getItem(USER_STORAGE_KEY);
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(email ? { 'X-User-Email': email } : {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem(USER_STORAGE_KEY);
    window.dispatchEvent(new Event('prospector:unauthorized'));
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const startPull = (profile, region, count, assignedTo) =>
  request('/api/pull', { method: 'POST', body: JSON.stringify({ profile, region, count, assignedTo }) });

export const startSdrPull = (region, profile) =>
  request('/api/pull', { method: 'POST', body: JSON.stringify({ region, profile }) });

export const fetchQuota = () => request('/api/pull/quota');

export const fetchLists = () => request('/api/lists');
export const fetchList = (id) => request(`/api/lists/${id}`);
export const fetchLeads = (id, bucket) =>
  request(`/api/lists/${id}/leads${bucket ? `?bucket=${bucket}` : ''}`);

export const sendDecision = (leadId, decision) =>
  request(`/api/leads/${leadId}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
