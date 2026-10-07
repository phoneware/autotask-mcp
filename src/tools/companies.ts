import type { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import {
  jsonResponse,
  searchResponse,
  parseMaxRecords,
  collectClauses,
  eqClause,
  containsClause,
  intArg,
  optionalIntArg,
  optionalBoolArg,
} from './shared.js';
/** Convenience tools for Companies (Autotask accounts). */
export const companyTools: ToolDefinition[] = [
  {
    name: 'search-companies',
    title: 'Search Companies',
    description:
      'Search companies (accounts). Filters are optional and ANDed; with none, returns companies up to maxRecords. companyType/isActive are picklist/boolean codes (see describe-entity-fields("Companies")).',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        companyNameContains: { type: 'string', description: 'Substring match on company name' },
        companyType: { type: 'string', description: 'Numeric company type picklist code' },
        ownerResourceID: { type: 'string', description: 'Owner resource id' },
        phone: { type: 'string', description: 'Exact phone number match' },
        isActive: { type: 'string', description: 'Filter by active status ("true" or "false")' },
        maxRecords: { type: 'string', description: 'Max records to return (default 50, max 500)' },
      },
    },
    handler: async (args) => {
      const filter = collectClauses(
        containsClause('companyName', args.companyNameContains),
        eqClause('companyType', args.companyType),
        eqClause('ownerResourceID', args.ownerResourceID),
        eqClause('phone', args.phone),
        (() => {
          const active = optionalBoolArg('isActive', args.isActive);
          return active !== undefined ? { op: 'eq', field: 'isActive', value: active } : null;
        })(),
      );
      const query = { filter, MaxRecords: parseMaxRecords(args.maxRecords) };
      return searchResponse(filter, await api.query('Companies', query));
    },
  },
  {
    name: 'get-company',
    title: 'Get Company',
    description: 'Get a single company by its numeric id.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Company id' } },
      required: ['id'],
    },
    handler: async (args) => jsonResponse(await api.getById('Companies', args.id)),
  },
  {
    name: 'create-company',
    title: 'Create Company',
    description:
      'Create a company. DESTRUCTIVE (write). companyName, companyType, ownerResourceID and phone are commonly required by Autotask; verify with describe-entity-fields("Companies"). For other fields use generic create-entity.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        companyName: { type: 'string', description: 'Company name' },
        companyType: { type: 'string', description: 'Numeric company type picklist code' },
        ownerResourceID: { type: 'string', description: 'Owner resource id' },
        phone: { type: 'string', description: 'Primary phone number' },
        address1: { type: 'string', description: 'Address line 1' },
        city: { type: 'string', description: 'City' },
        state: { type: 'string', description: 'State / province' },
        postalCode: { type: 'string', description: 'Postal / zip code' },
      },
      required: ['companyName', 'companyType'],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        companyName: args.companyName,
        companyType: intArg('companyType', args.companyType),
      };
      if (args.ownerResourceID)
        body.ownerResourceID = intArg('ownerResourceID', args.ownerResourceID);
      if (args.phone) body.phone = args.phone;
      if (args.address1) body.address1 = args.address1;
      if (args.city) body.city = args.city;
      if (args.state) body.state = args.state;
      if (args.postalCode) body.postalCode = args.postalCode;
      return jsonResponse(await api.create('Companies', body));
    },
  },
  {
    name: 'update-company',
    title: 'Update Company',
    description:
      'Update fields on a company. DESTRUCTIVE (write). Only supplied fields change. For fields not listed here, use generic update-entity.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Company id to update' },
        companyName: { type: 'string', description: 'New company name' },
        companyType: { type: 'string', description: 'New numeric company type picklist code' },
        ownerResourceID: { type: 'string', description: 'New owner resource id' },
        phone: { type: 'string', description: 'New phone number' },
        isActive: { type: 'string', description: 'Active status ("true" or "false")' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = { id: intArg('id', args.id) };
      if (args.companyName) body.companyName = args.companyName;
      const type = optionalIntArg('companyType', args.companyType);
      if (type !== undefined) body.companyType = type;
      const owner = optionalIntArg('ownerResourceID', args.ownerResourceID);
      if (owner !== undefined) body.ownerResourceID = owner;
      if (args.phone) body.phone = args.phone;
      const active = optionalBoolArg('isActive', args.isActive);
      if (active !== undefined) body.isActive = active;
      return jsonResponse(await api.update('Companies', body));
    },
  },
];
