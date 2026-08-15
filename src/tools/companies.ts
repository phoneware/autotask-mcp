import { ToolDefinition } from '../types.js';
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
} from './shared.js';

/** Convenience tools for Companies (Autotask accounts). */
export const companyTools: ToolDefinition[] = [
  {
    name: 'search-companies',
    description:
      'Search companies (accounts). Filters are optional and ANDed; with none, returns companies up to maxRecords. companyType/isActive are picklist/boolean codes (see describe-entity-fields("Companies")).',
    inputSchema: {
      type: 'object',
      properties: {
        nameContains: { type: 'string', description: 'Substring match on company name' },
        companyType: { type: 'string', description: 'Numeric company type picklist code' },
        isActive: { type: 'string', description: 'true/false active flag (use "true"/"false")' },
        maxRecords: { type: 'string', description: 'Max records to return (default 50, max 500)' },
      },
    },
    handler: async (args) => {
      const isActive =
        args.isActive === 'true' || args.isActive === 'false'
          ? { op: 'eq', field: 'isActive', value: args.isActive === 'true' }
          : null;
      const filter = collectClauses(
        containsClause('companyName', args.nameContains),
        eqClause('companyType', args.companyType),
        isActive,
      );
      const query = { filter, MaxRecords: parseMaxRecords(args.maxRecords) };
      return searchResponse(filter, await api.query('Companies', query));
    },
  },
  {
    name: 'get-company',
    description: 'Get a single company by its numeric id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Company id' } },
      required: ['id'],
    },
    handler: async (args) => jsonResponse(await api.getById('Companies', args.id)),
  },
  {
    name: 'create-company',
    description:
      'Create a company. DESTRUCTIVE (write). companyName, companyType, ownerResourceID and phone are commonly required by Autotask; verify with describe-entity-fields("Companies"). For other fields use generic create-entity.',
    inputSchema: {
      type: 'object',
      properties: {
        companyName: { type: 'string', description: 'Company name' },
        companyType: { type: 'string', description: 'Numeric company type picklist code' },
        ownerResourceID: { type: 'string', description: 'Owner resource id' },
        phone: { type: 'string', description: 'Phone number' },
      },
      required: ['companyName', 'companyType'],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        companyName: args.companyName,
        companyType: intArg('companyType', args.companyType),
      };
      const ownerResourceID = optionalIntArg('ownerResourceID', args.ownerResourceID);
      if (ownerResourceID !== undefined) body.ownerResourceID = ownerResourceID;
      if (args.phone) body.phone = args.phone;
      return jsonResponse(await api.create('Companies', body));
    },
  },
  {
    name: 'update-company',
    description:
      'Update fields on a company. DESTRUCTIVE (write). Only supplied fields change. For fields not listed here, use generic update-entity.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Company id to update' },
        companyName: { type: 'string', description: 'New company name' },
        phone: { type: 'string', description: 'New phone number' },
        isActive: { type: 'string', description: 'true/false active flag' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = { id: intArg('id', args.id) };
      if (args.companyName) body.companyName = args.companyName;
      if (args.phone) body.phone = args.phone;
      if (args.isActive === 'true' || args.isActive === 'false') {
        body.isActive = args.isActive === 'true';
      }
      return jsonResponse(await api.update('Companies', body));
    },
  },
];
