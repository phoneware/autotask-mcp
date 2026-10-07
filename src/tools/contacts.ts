import type { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import {
  jsonResponse,
  searchResponse,
  parseMaxRecords,
  collectClauses,
  eqClause,
  anyContainsClause,
  intArg,
} from './shared.js';

/** Convenience tools for Contacts (people attached to companies). */
export const contactTools: ToolDefinition[] = [
  {
    name: 'search-contacts',
    title: 'Search Contacts',
    description:
      'Search contacts. Filters are optional and ANDed; with none, returns contacts up to maxRecords.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'string', description: 'Filter by parent company id' },
        nameContains: {
          type: 'string',
          description: 'Search first name, last name, or email for a substring',
        },
        firstName: { type: 'string', description: 'Exact first name match' },
        lastName: { type: 'string', description: 'Exact last name match' },
        emailAddress: { type: 'string', description: 'Exact email address match' },
        maxRecords: { type: 'string', description: 'Max records to return (default 50, max 500)' },
      },
    },
    handler: async (args) => {
      const filter = collectClauses(
        eqClause('companyID', args.companyID),
        anyContainsClause(['firstName', 'lastName', 'emailAddress'], args.nameContains),
        eqClause('firstName', args.firstName),
        eqClause('lastName', args.lastName),
        eqClause('emailAddress', args.emailAddress),
      );
      const query = { filter, MaxRecords: parseMaxRecords(args.maxRecords) };
      return searchResponse(filter, await api.query('Contacts', query));
    },
  },
  {
    name: 'get-contact',
    title: 'Get Contact',
    description: 'Get a single contact by its numeric id.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact id' } },
      required: ['id'],
    },
    handler: async (args) => jsonResponse(await api.getById('Contacts', args.id)),
  },
  {
    name: 'create-contact',
    title: 'Create Contact',
    description:
      'Create a contact under a company. DESTRUCTIVE (write). companyID, firstName and lastName are required. For other fields use generic create-entity.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'string', description: 'Parent company id' },
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        emailAddress: { type: 'string', description: 'Primary email address' },
        phone: { type: 'string', description: 'Phone number' },
        mobilePhone: { type: 'string', description: 'Mobile phone number' },
        title: { type: 'string', description: 'Job title' },
      },
      required: ['companyID', 'firstName', 'lastName'],
    },
    handler: async (args) => {
      const companyID = intArg('companyID', args.companyID);
      const body: Record<string, unknown> = {
        companyID,
        firstName: args.firstName,
        lastName: args.lastName,
      };
      if (args.emailAddress) body.emailAddress = args.emailAddress;
      if (args.phone) body.phone = args.phone;
      if (args.mobilePhone) body.mobilePhone = args.mobilePhone;
      if (args.title) body.title = args.title;
      // Contacts must be created under a company in Autotask REST.
      return jsonResponse(await api.create(`Companies/${companyID}/Contacts`, body));
    },
  },
  {
    name: 'update-contact',
    title: 'Update Contact',
    description:
      'Update fields on a contact. DESTRUCTIVE (write). Only supplied fields change. For fields not listed here, use generic update-entity.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact id to update' },
        companyID: {
          type: 'string',
          description:
            'Parent company id. If omitted, it will be fetched from the contact before updating.',
        },
        firstName: { type: 'string', description: 'New first name' },
        lastName: { type: 'string', description: 'New last name' },
        emailAddress: { type: 'string', description: 'New email address' },
        phone: { type: 'string', description: 'New phone number' },
        mobilePhone: { type: 'string', description: 'New mobile phone' },
        title: { type: 'string', description: 'New job title' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      let companyID: number | undefined;
      if (args.companyID) {
        companyID = intArg('companyID', args.companyID);
      } else {
        const existing = (await api.getById('Contacts', args.id)) as {
          item?: { companyID?: number };
        };
        companyID = existing?.item?.companyID;
        if (companyID === undefined) {
          throw new Error(`Could not determine companyID for contact ${args.id}`);
        }
      }

      const body: Record<string, unknown> = { id: intArg('id', args.id) };
      if (args.firstName) body.firstName = args.firstName;
      if (args.lastName) body.lastName = args.lastName;
      if (args.emailAddress) body.emailAddress = args.emailAddress;
      if (args.phone) body.phone = args.phone;
      if (args.mobilePhone) body.mobilePhone = args.mobilePhone;
      if (args.title) body.title = args.title;

      return jsonResponse(await api.update(`Companies/${companyID}/Contacts`, body));
    },
  },
];
