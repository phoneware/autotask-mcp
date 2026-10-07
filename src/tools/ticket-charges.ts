import type { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import { assertSafeNumericId, parseJsonBody, updateBodySchema } from '../security.js';
import { jsonResponse, intArg, optionalIntArg, optionalNumberArg } from './shared.js';
export const ticketChargeTools: ToolDefinition[] = [
  {
    name: 'list-ticket-charges',
    title: 'List Ticket Charges',
    description:
      'List all charges associated with an Autotask ticket by ticket ID. Shows charge names, descriptions, unit costs, unit prices, status codes, and product IDs (useful for identifying product-less labor vs hardware charges).',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'string',
          description: 'Numeric ticket ID, e.g. "23836"',
        },
      },
      required: ['ticketId'],
    },
    handler: async (args) => {
      const ticketId = assertSafeNumericId(args.ticketId, 'ticketId');
      const result = await api.request('GET', `V1.0/Tickets/${ticketId}/Charges`);
      return jsonResponse(result);
    },
  },
  {
    name: 'get-ticket-charge',
    title: 'Get Ticket Charge',
    description: 'Fetch details of a single ticket charge by numeric charge ID.',
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
          description: 'Numeric charge ID',
        },
        ticketId: {
          type: 'string',
          description: 'Optional parent ticket ID',
        },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = assertSafeNumericId(args.id, 'id');
      if (args.ticketId) {
        const ticketId = assertSafeNumericId(args.ticketId, 'ticketId');
        return jsonResponse(await api.request('GET', `V1.0/Tickets/${ticketId}/Charges/${id}`));
      }
      return jsonResponse(await api.getById('TicketCharges', id));
    },
  },
  {
    name: 'create-ticket-charge',
    title: 'Create Ticket Charge',
    description:
      'Create a new charge on an Autotask ticket. DESTRUCTIVE: requires a confirm token. Set chargeType (1=Material/Product, 2=Labor, 3=Expense), name, unitCost, unitPrice, and unitQuantity.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'string',
          description: 'Numeric ticket ID',
        },
        name: {
          type: 'string',
          description: 'Charge name or line item title',
        },
        chargeType: {
          type: 'string',
          description: 'Charge type code: 1 (Material/Product), 2 (Labor), 3 (Expense). Default: 1',
        },
        unitPrice: {
          type: 'string',
          description: 'Unit selling price',
        },
        unitCost: {
          type: 'string',
          description: 'Unit cost',
        },
        unitQuantity: {
          type: 'string',
          description: 'Quantity',
        },
        productID: {
          type: 'string',
          description: 'Optional Autotask product ID for catalog products',
        },
        billingCodeID: {
          type: 'string',
          description: 'Optional billing code ID',
        },
        description: {
          type: 'string',
          description: 'Optional charge description',
        },
        datePurchased: {
          type: 'string',
          description: 'Purchase date in ISO or YYYY-MM-DD format',
        },
      },
      required: ['ticketId', 'name'],
    },
    handler: async (args) => {
      const ticketId = assertSafeNumericId(args.ticketId, 'ticketId');
      const chargeType = optionalIntArg('chargeType', args.chargeType) ?? 1;
      const body: Record<string, unknown> = {
        name: args.name,
        ticketID: intArg('ticketId', ticketId),
        chargeType,
      };

      const unitPrice = optionalNumberArg('unitPrice', args.unitPrice);
      if (unitPrice !== undefined) body.unitPrice = unitPrice;

      const unitCost = optionalNumberArg('unitCost', args.unitCost);
      if (unitCost !== undefined) body.unitCost = unitCost;

      const unitQuantity = optionalNumberArg('unitQuantity', args.unitQuantity);
      if (unitQuantity !== undefined) body.unitQuantity = unitQuantity;

      const productID = optionalIntArg('productID', args.productID);
      if (productID !== undefined) body.productID = productID;

      const billingCodeID = optionalIntArg('billingCodeID', args.billingCodeID);
      if (billingCodeID !== undefined) body.billingCodeID = billingCodeID;

      if (args.description !== undefined && args.description !== '')
        body.description = args.description;
      if (args.datePurchased !== undefined && args.datePurchased !== '')
        body.datePurchased = args.datePurchased;
      const result = await api.create(`Tickets/${ticketId}/Charges`, body);
      return jsonResponse(result);
    },
  },
  {
    name: 'update-ticket-charge',
    title: 'Update Ticket Charge',
    description:
      'Partially update a charge on an Autotask ticket. DESTRUCTIVE: requires a confirm token. Pass `fields` as a JSON string with "id" and fields to update.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Numeric charge ID to update',
        },
        ticketId: {
          type: 'string',
          description: 'Optional parent ticket ID (auto-resolved from charge if omitted)',
        },
        fields: {
          type: 'string',
          description: 'JSON object of fields to update, e.g. {"id":2712,"unitPrice":50}',
        },
      },
      required: ['id', 'fields'],
    },
    handler: async (args) => {
      const id = assertSafeNumericId(args.id, 'id');
      const body = parseJsonBody(args.fields, updateBodySchema, 'fields');
      body.id = Number(id);

      let ticketId = args.ticketId;
      if (!ticketId) {
        const existing = (await api.getById('TicketCharges', id)) as {
          item?: { ticketID?: number };
        };
        const resolvedId = existing?.item?.ticketID;
        if (resolvedId) ticketId = String(resolvedId);
      }

      const entity = ticketId
        ? `Tickets/${assertSafeNumericId(ticketId, 'ticketId')}/Charges`
        : 'TicketCharges';

      await api.assertWritableFields(entity, body, true);
      const result = await api.update(entity, body);
      return jsonResponse(result);
    },
  },
];
