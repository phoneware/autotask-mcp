import type { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import { assertSafeNumericId } from '../security.js';
import {
  jsonResponse,
  searchResponse,
  containsClause,
  eqClause,
  collectClauses,
  parseMaxRecords,
  optionalIntArg,
} from './shared.js';

export const contractTools: ToolDefinition[] = [
  {
    name: 'search-contracts',
    title: 'Search Contracts',
    description:
      'Search customer contracts in Autotask (service agreements, recurring billing, block hour contracts). Contracts serve as the source of truth for customer service entitlements.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'string',
          description: 'Filter by Autotask company ID',
        },
        contractNameContains: {
          type: 'string',
          description: 'Search string inside contract name',
        },
        contractType: {
          type: 'string',
          description: 'Filter by contract type code',
        },
        status: {
          type: 'string',
          description: 'Filter by contract status code (e.g. 1=Active)',
        },
        maxRecords: {
          type: 'string',
          description: 'Max records to return (1-500, default 50)',
        },
      },
    },
    handler: async (args) => {
      const companyId = optionalIntArg('companyId', args.companyId);
      const filter = collectClauses(
        companyId !== undefined ? { op: 'eq', field: 'companyID', value: companyId } : null,
        containsClause('contractName', args.contractNameContains),
        eqClause('contractType', args.contractType),
        eqClause('status', args.status),
      );
      const limit = parseMaxRecords(args.maxRecords);
      const result = await api.query('Contracts', { filter, MaxRecords: limit });
      return searchResponse(filter, result);
    },
  },
  {
    name: 'get-contract',
    title: 'Get Contract',
    description: 'Fetch full details of a single Autotask contract by its numeric ID.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Numeric contract ID',
        },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = assertSafeNumericId(args.id, 'id');
      return jsonResponse(await api.getById('Contracts', id));
    },
  },
  {
    name: 'search-contract-services',
    title: 'Search Contract Services',
    description:
      'Search line item services attached to Autotask contracts (phone seats, internet connections, license bundles). Primary source for customer subscription service counts and pricing.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        contractId: {
          type: 'string',
          description: 'Filter by Autotask contract ID',
        },
        serviceId: {
          type: 'string',
          description: 'Filter by Autotask service ID',
        },
        maxRecords: {
          type: 'string',
          description: 'Max records to return (1-500, default 50)',
        },
      },
    },
    handler: async (args) => {
      const contractId = optionalIntArg('contractId', args.contractId);
      const serviceId = optionalIntArg('serviceId', args.serviceId);
      const filter = collectClauses(
        contractId !== undefined ? { op: 'eq', field: 'contractID', value: contractId } : null,
        serviceId !== undefined ? { op: 'eq', field: 'serviceID', value: serviceId } : null,
      );
      const limit = parseMaxRecords(args.maxRecords);
      const result = await api.query('ContractServices', { filter, MaxRecords: limit });
      return searchResponse(filter, result);
    },
  },
  {
    name: 'get-contract-service',
    title: 'Get Contract Service',
    description:
      'Fetch details of a single service line item on a contract by numeric contract service ID.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Numeric contract service ID',
        },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = assertSafeNumericId(args.id, 'id');
      return jsonResponse(await api.getById('ContractServices', id));
    },
  },
  {
    name: 'search-services',
    title: 'Search Services Catalog',
    description:
      'Search catalog service definitions in Autotask (standard recurring service packages, seat types, add-on definitions).',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        nameContains: {
          type: 'string',
          description: 'Search string inside service name',
        },
        maxRecords: {
          type: 'string',
          description: 'Max records to return (1-500, default 50)',
        },
      },
    },
    handler: async (args) => {
      const filter = collectClauses(containsClause('name', args.nameContains));
      const limit = parseMaxRecords(args.maxRecords);
      const result = await api.query('Services', { filter, MaxRecords: limit });
      return searchResponse(filter, result);
    },
  },
  {
    name: 'get-service',
    title: 'Get Service',
    description: 'Fetch details of a single catalog service by numeric service ID.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Numeric service ID',
        },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = assertSafeNumericId(args.id, 'id');
      return jsonResponse(await api.getById('Services', id));
    },
  },
];
