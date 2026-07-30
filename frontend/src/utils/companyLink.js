// Apollo stores companies with no known domain as "https://null", which is not a real domain.
export function hasUsableDomain(website) {
  if (!website) return false;
  try {
    const host = new URL(website).hostname.replace(/^www\./, '').toLowerCase();
    return host !== 'null' && host !== 'undefined' && host.includes('.');
  } catch {
    return false;
  }
}

export function getCompanyHref(website) {
  return hasUsableDomain(website) ? website : null;
}
