const axios = require('axios');
const { ICP1_FILTERS, ICP2_FILTERS, ICP3_FILTERS, REGIONS, REGION_KEYWORD_EXCLUDES } = require('../config/filters');

const PROFILE_FILTERS = { icp1: ICP1_FILTERS, icp2: ICP2_FILTERS, icp3: ICP3_FILTERS };

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';
const APOLLO_ENRICH_URL = 'https://api.apollo.io/api/v1/organizations';

const apolloHeaders = () => ({
  'X-Api-Key': process.env.APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
});

const buildSearchBody = (profile, region, page, perPage) => {
  const baseFilters = PROFILE_FILTERS[profile];
  if (!baseFilters) throw new Error(`Unknown profile: ${profile}`);
  const locations = REGIONS[region];
  if (!locations) throw new Error(`Unknown region: ${region}`);
  const regionExcludes = REGION_KEYWORD_EXCLUDES[region] || [];
  return {
    page, per_page: perPage, ...baseFilters,
    organization_locations: locations,
    q_not_organization_keyword_tags: [...baseFilters.q_not_organization_keyword_tags, ...regionExcludes],
  };
};

const searchCompaniesPage = async (profile, region, page, perPage = 25) => {
  const response = await axios.post(
    APOLLO_SEARCH_URL,
    buildSearchBody(profile, region, page, perPage),
    { headers: apolloHeaders(), timeout: 60000 }
  );
  return {
    organizations: response.data.organizations || [],
    pagination: {
      page: response.data.pagination?.page || page,
      totalPages: response.data.pagination?.total_pages,
      totalEntries: response.data.pagination?.total_entries,
    },
  };
};

const enrichOrganization = async (id) => {
  const response = await axios.get(`${APOLLO_ENRICH_URL}/${id}`, {
    headers: apolloHeaders(),
    timeout: 30000,
  });
  return response.data.organization || null;
};

const mapOrganization = (org) => ({
  apolloAccountId: org.id,
  companyName: org.name,
  // Only synthesise a URL when there is a domain to synthesise it from —
  // otherwise this stored the literal string "https://null".
  website: org.website_url || (org.primary_domain ? `https://${org.primary_domain}` : undefined),
  industry: org.industry,
  employees: org.estimated_num_employees,
  annualRevenue: org.organization_revenue_printed || org.annual_revenue_printed,
  country: org.country,
  city: org.city,
  foundedYear: org.founded_year,
  shortDescription: org.short_description,
  keywords: org.keywords || [],
  technologies: org.technology_names || [],
  totalFunding: org.total_funding_printed,
  latestFundingStage: org.latest_funding_stage,
  latestFundingDate: org.latest_funding_round_date || null,
  companyLinkedinUrl: org.linkedin_url || null,
});

module.exports = { buildSearchBody, searchCompaniesPage, enrichOrganization, mapOrganization };
