import { api } from './autotask-api.js';

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

// "Fetch all" filter: Autotask /query requires at least one clause.
const ALL_FILTER = { filter: [{ op: 'gte', field: 'id', value: 0 }], MaxRecords: 50 };

export const staticResources: ResourceDefinition[] = [
  {
    uri: 'autotask://threshold',
    name: 'API Threshold',
    description: 'Current API usage against the integration code rate threshold',
    mimeType: 'application/json',
  },
  {
    uri: 'autotask://companies',
    name: 'Companies',
    description: 'Recent companies (accounts), up to 50',
    mimeType: 'application/json',
  },
  {
    uri: 'autotask://tickets',
    name: 'Tickets',
    description: 'Recent tickets, up to 50',
    mimeType: 'application/json',
  },
];

export const resourceTemplates: ResourceTemplateDefinition[] = [
  {
    uriTemplate: 'autotask://companies/{id}',
    name: 'Company Details',
    description: 'A single company by id',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'autotask://tickets/{id}',
    name: 'Ticket Details',
    description: 'A single ticket by id',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'autotask://contacts/{id}',
    name: 'Contact Details',
    description: 'A single contact by id',
    mimeType: 'application/json',
  },
];

export async function handleResource(uri: string): Promise<string> {
  if (uri === 'autotask://threshold') {
    return JSON.stringify(await api.thresholdInformation(), null, 2);
  }
  if (uri === 'autotask://companies') {
    return JSON.stringify(await api.query('Companies', ALL_FILTER), null, 2);
  }
  if (uri === 'autotask://tickets') {
    return JSON.stringify(await api.query('Tickets', ALL_FILTER), null, 2);
  }

  const companyMatch = uri.match(/^autotask:\/\/companies\/([^/]+)$/);
  if (companyMatch) {
    return JSON.stringify(await api.getById('Companies', companyMatch[1]), null, 2);
  }

  const ticketMatch = uri.match(/^autotask:\/\/tickets\/([^/]+)$/);
  if (ticketMatch) {
    return JSON.stringify(await api.getById('Tickets', ticketMatch[1]), null, 2);
  }

  const contactMatch = uri.match(/^autotask:\/\/contacts\/([^/]+)$/);
  if (contactMatch) {
    return JSON.stringify(await api.getById('Contacts', contactMatch[1]), null, 2);
  }

  throw new Error(`Unknown resource: ${uri}`);
}
