const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

// Identity lives in an httpOnly session cookie the browser holds and JavaScript
// cannot read, so it travels via credentials rather than a header we set.
async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new Event('prospector:unauthorized'));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const login = (email, password) =>
  request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const changePassword = (currentPassword, newPassword) =>
  request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });

export const adminResetPassword = (email) =>
  request('/api/auth/admin/reset-password', { method: 'POST', body: JSON.stringify({ email }) });

// Resolves to the signed-in user, or null when there is no valid session.
export const fetchMe = async () => {
  try {
    return await request('/api/auth/me');
  } catch {
    return null;
  }
};

export const logout = () =>
  fetch(`${API}/api/auth/logout`, { method: 'POST', credentials: 'include' });

export const startPull = (profile, region, count, assignedTo) =>
  request('/api/pull', { method: 'POST', body: JSON.stringify({ profile, region, count, assignedTo }) });

export const startSdrPull = (region, profile) =>
  request('/api/pull', { method: 'POST', body: JSON.stringify({ region, profile }) });

export const fetchQuota = () => request('/api/pull/quota');

export const fetchQualificationMode = () => request('/api/settings/qualification-mode');
export const setQualificationMode = (mode) =>
  request('/api/settings/qualification-mode', { method: 'PUT', body: JSON.stringify({ mode }) });

export const fetchLists = () => request('/api/lists');
export const fetchList = (id) => request(`/api/lists/${id}`);
export const fetchLeads = (id, bucket) =>
  request(`/api/lists/${id}/leads${bucket ? `?bucket=${bucket}` : ''}`);

export const confirmReview = (id) => request(`/api/lists/${id}/confirm-review`, { method: 'POST' });
export const fetchContacts = (id) => request(`/api/lists/${id}/contacts`);

export const sendDecision = (leadId, decision, comment) =>
  request(`/api/leads/${leadId}/decision`, { method: 'POST', body: JSON.stringify({ decision, comment }) });

export const pushContactToHubspot = (contactId) =>
  request(`/api/contacts/${contactId}/hubspot`, { method: 'POST' });

export const pushCompanyToHubspot = (companyId) =>
  request(`/api/leads/${companyId}/hubspot`, { method: 'POST' });

export const fetchObjectionFeedback = () => request('/api/objection-feedback');

export const postObjectionFeedback = (objection, text) =>
  request('/api/objection-feedback', { method: 'POST', body: JSON.stringify({ objection, text }) });

export const fetchObjectionResponses = () => request('/api/objection-responses');

export const starObjectionResponse = (objection, boxTitle) =>
  request('/api/objection-responses/star', { method: 'POST', body: JSON.stringify({ objection, boxTitle }) });

export const voteObjectionResponse = (objection, boxTitle, value) =>
  request('/api/objection-responses/vote', { method: 'POST', body: JSON.stringify({ objection, boxTitle, value }) });
