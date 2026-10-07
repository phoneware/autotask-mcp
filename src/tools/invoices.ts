import type { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import { assertSafeNumericId } from '../security.js';
import {
  jsonResponse,
  searchResponse,
  collectClauses,
  parseMaxRecords,
  optionalIntArg,
} from './shared.js';

export const invoiceTools: ToolDefinition[] = [
  {
    name: 'search-invoices',
    title: 'Search Invoices',
    description:
      'Search customer invoices in Autotask. Filter by company ID, date range, or paid status.',
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
        fromInvoiceDate: {
          type: 'string',
          description: 'Filter invoices on or after this date (YYYY-MM-DD)',
        },
        toInvoiceDate: {
          type: 'string',
          description: 'Filter invoices on or before this date (YYYY-MM-DD)',
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
        args.fromInvoiceDate
          ? { op: 'gte', field: 'invoiceDateTime', value: args.fromInvoiceDate }
          : null,
        args.toInvoiceDate
          ? { op: 'lte', field: 'invoiceDateTime', value: args.toInvoiceDate }
          : null,
      );
      const limit = parseMaxRecords(args.maxRecords);
      const result = await api.query('Invoices', { filter, MaxRecords: limit });
      return searchResponse(filter, result);
    },
  },
  {
    name: 'get-invoice',
    title: 'Get Invoice',
    description: 'Fetch full details of an invoice by its numeric invoice ID.',
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
          description: 'Numeric invoice ID',
        },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = assertSafeNumericId(args.id, 'id');
      return jsonResponse(await api.getById('Invoices', id));
    },
  },
];
