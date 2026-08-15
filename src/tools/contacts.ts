import { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import {
  jsonResponse,
  searchResponse,
  parseMaxRecords,
  collectClauses,
  eqClause,
  containsClause,
  anyContainsClause,
  intArg,
} from './shared.js';

/** Convenience tools for Contacts (people attached to companies). */
export const contactTools: ToolDefinition[] = [
  {
    name: 'search-contacts',
    description:
      'Search contacts. Filters are optional and ANDed; with none, returns contacts up to maxRecords.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'string', description: 'Filter by company id' },
        nameContains: {
          type: 'string',
          description: 'Substring match on first name, last name or email address',
        },
        lastNameContains: { type: 'string', description: 'Substring match on last name' },
        emailContains: { type: 'string', description: 'Substring match on email address' },
        maxRecords: { type: 'string', description: 'Max records to return (default 50, max 500)' },
      },
    },
    handler: async (args) => {
      const filter = collectClauses(
        eqClause('companyID', args.companyID),
        anyContainsClause(['firstName', 'lastName', 'emailAddress'], args.nameContains),
        containsClause('lastName', args.lastNameContains),
        containsClause('emailAddress', args.emailContains),
      );
      const query = { filter, MaxRecords: parseMaxRecords(args.maxRecords) };
      return searchResponse(filter, await api.query('Contacts', query));
    },
  },
  {
    name: 'get-contact',
    description: 'Get a single contact by its numeric id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact id' } },
      required: ['id'],
    },
    handler: async (args) => jsonResponse(await api.getById('Contacts', args.id)),
  },
  {
    name: 'create-contact',
    description:
      'Create a contact under a company. DESTRUCTIVE (write). companyID, firstName and lastName are required. For other fields use generic create-entity.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'string', description: 'Company id the contact belongs to' },
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        emailAddress: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
      },
      required: ['companyID', 'firstName', 'lastName'],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        companyID: intArg('companyID', args.companyID),
        firstName: args.firstName,
        lastName: args.lastName,
      };
      if (args.emailAddress) body.emailAddress = args.emailAddress;
      if (args.phone) body.phone = args.phone;
      return jsonResponse(await api.create('Contacts', body));
    },
  },
  {
    name: 'update-contact',
    description:
      'Update fields on a contact. DESTRUCTIVE (write). Only supplied fields change. For fields not listed here, use generic update-entity.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact id to update' },
        firstName: { type: 'string', description: 'New first name' },
        lastName: { type: 'string', description: 'New last name' },
        emailAddress: { type: 'string', description: 'New email address' },
        phone: { type: 'string', description: 'New phone number' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = { id: intArg('id', args.id) };
      if (args.firstName) body.firstName = args.firstName;
      if (args.lastName) body.lastName = args.lastName;
      if (args.emailAddress) body.emailAddress = args.emailAddress;
      if (args.phone) body.phone = args.phone;
      return jsonResponse(await api.update('Contacts', body));
    },
  },
];
