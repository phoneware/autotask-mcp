import type { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import {
  parseJsonBody,
  querySchema,
  recordBodySchema,
  updateBodySchema,
  assertSafeNumericId,
} from '../security.js';
import { jsonResponse } from './shared.js';
import { resolveEntity, resolveWritePath } from './entity-resolver.js';

export { resolveEntity, resolveWritePath };

const PARENT_PROPS = {
  parentEntity: {
    type: 'string',
    description: 'Optional parent entity for child collections, e.g. "Tickets"',
  },
  parentId: {
    type: 'string',
    description: 'Optional parent record id (required if parentEntity is set)',
  },
};

/**
 * Generic tools that work against ANY Autotask entity by name (Tickets,
 * Companies, Contacts, Projects, Contracts, ConfigurationItems, etc.). This is
 * the foundation layer: it gives the agent full read/write coverage of the
 * REST API without a hand-written tool per entity.
 */
export const genericTools: ToolDefinition[] = [
  {
    name: 'list-known-entities',
    title: 'List Known Entities',
    description:
      'List commonly used Autotask entity names you can pass to the generic query/get/create/update/delete tools. Not exhaustive: Autotask exposes 180+ entities. Use describe-entity-fields to inspect any entity.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const entities = [
        'Tickets',
        'TicketNotes',
        'TicketCharges',
        'Companies',
        'Contacts',
        'Projects',
        'Tasks',
        'TimeEntries',
        'Resources',
        'Contracts',
        'ContractServices',
        'Services',
        'ConfigurationItems',
        'Opportunities',
        'Quotes',
        'Invoices',
        'Expenses',
        'BillingItems',
        'ServiceCalls',
        'Appointments',
      ];
      return jsonResponse({ entities });
    },
  },
  {
    name: 'describe-entity-fields',
    title: 'Describe Entity Fields',
    description:
      "Describe an entity's fields: names, data types, whether required, and picklist values (e.g. ticket status codes). Call this before building filters or create/update bodies so you use real field names and valid picklist values.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets" or "Companies"' },
      },
      required: ['entity'],
    },
    handler: async (args) => jsonResponse(await api.entityFields(resolveEntity(args.entity))),
  },
  {
    name: 'query-entity',
    title: 'Query Entity',
    description:
      'Query any Autotask entity using the REST query syntax. Pass `query` as a JSON string: {"filter":[{"op":"eq","field":"status","value":1}],"MaxRecords":50}. Supported ops include eq, noteq, gt, gte, lt, lte, contains, beginsWith, endsWith, in, notIn, exist, notExist. AND/OR groups use {"op":"and","items":[...]}.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets"' },
        query: {
          type: 'string',
          description:
            'JSON query object: {"filter":[{"op":"eq","field":"id","value":123}],"MaxRecords":50,"IncludeFields":["id","title"]}',
        },
        ...PARENT_PROPS,
      },
      required: ['entity', 'query'],
    },
    handler: async (args) => {
      const query = parseJsonBody(args.query, querySchema, 'query');
      const entity = resolveEntity(args.entity, args.parentEntity, args.parentId);
      return jsonResponse(await api.query(entity, query));
    },
  },
  {
    name: 'count-entity',
    title: 'Count Entity',
    description:
      'Count how many records match a query, without fetching them. Use before a large fan-out query to check the result size against the rate threshold. `query` uses the same JSON syntax as query-entity.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets"' },
        query: { type: 'string', description: 'JSON query object with a "filter" array' },
        ...PARENT_PROPS,
      },
      required: ['entity', 'query'],
    },
    handler: async (args) => {
      const query = parseJsonBody(args.query, querySchema, 'query');
      const entity = resolveEntity(args.entity, args.parentEntity, args.parentId);
      return jsonResponse(await api.queryCount(entity, query));
    },
  },
  {
    name: 'get-next-page',
    title: 'Get Next Page',
    description:
      'Fetch the next page of a previous query. Pass the "nextPageUrl" from that response\'s pageDetails plus the SAME query you sent originally: Autotask carries only the page position in the URL and still requires the query model in the body, and changing filter/MaxRecords/IncludeFields between pages breaks the cursor. Every search-* tool echoes the `filter` it applied so you can pass it straight back. A null nextPageUrl means there are no more pages. Autotask caps a single query at 500 records, so this is the only way to read past that.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        nextPageUrl: {
          type: 'string',
          description: 'pageDetails.nextPageUrl copied verbatim from a prior query response',
        },
        query: {
          type: 'string',
          description:
            'The same JSON query object the previous page was fetched with, e.g. {"filter":[{"op":"contains","field":"companyName","value":"Zucker"}],"MaxRecords":50}',
        },
      },
      required: ['nextPageUrl', 'query'],
    },
    handler: async (args) => {
      const query = parseJsonBody(args.query, querySchema, 'query');
      return jsonResponse(await api.getPage(args.nextPageUrl, query));
    },
  },
  {
    name: 'get-entity',
    title: 'Get Entity',
    description: 'Fetch a single record of any entity by its numeric id.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets"' },
        id: { type: 'string', description: 'Numeric record id' },
        ...PARENT_PROPS,
      },
      required: ['entity', 'id'],
    },
    handler: async (args) =>
      jsonResponse(
        await api.getById(
          resolveEntity(args.entity, args.parentEntity, args.parentId),
          assertSafeNumericId(args.id, 'id'),
        ),
      ),
  },
  {
    name: 'create-entity',
    title: 'Create Entity',
    description:
      'Create a record of any entity. DESTRUCTIVE: requires a confirm token. Pass `fields` as a JSON string of the record body, e.g. {"title":"...","companyID":123}. Use describe-entity-fields first to learn required fields.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets"' },
        fields: { type: 'string', description: 'JSON object of field values to set' },
        ...PARENT_PROPS,
      },
      required: ['entity', 'fields'],
    },
    handler: async (args) => {
      const body = parseJsonBody(args.fields, recordBodySchema, 'fields');
      const entity = await resolveWritePath(
        args.entity,
        'POST',
        args.parentEntity,
        args.parentId,
        undefined,
        body,
        (e, id) => api.getById(e, id),
      );
      return jsonResponse(await api.create(entity, body));
    },
  },
  {
    name: 'update-entity',
    title: 'Update Entity',
    description:
      'Partially update a record of any entity. DESTRUCTIVE: requires a confirm token. Pass `fields` as a JSON string that MUST include "id", e.g. {"id":123,"status":5}. Only the supplied fields are changed.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets"' },
        fields: {
          type: 'string',
          description: 'JSON object of field values to update; must include "id"',
        },
        ...PARENT_PROPS,
      },
      required: ['entity', 'fields'],
    },
    handler: async (args) => {
      const body = parseJsonBody(args.fields, updateBodySchema, 'fields');
      const entity = await resolveWritePath(
        args.entity,
        'PATCH',
        args.parentEntity,
        args.parentId,
        String(body.id),
        body,
        (e, id) => api.getById(e, id),
      );
      return jsonResponse(await api.update(entity, body));
    },
  },
  {
    name: 'delete-entity',
    title: 'Delete Entity',
    description:
      'Delete a record of any entity by id. DESTRUCTIVE and irreversible: requires a confirm token. Not all entities support deletion.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets"' },
        id: { type: 'string', description: 'Numeric record id to delete' },
        ...PARENT_PROPS,
      },
      required: ['entity', 'id'],
    },
    handler: async (args) => {
      const safeId = assertSafeNumericId(args.id, 'id');
      const entity = await resolveWritePath(
        args.entity,
        'DELETE',
        args.parentEntity,
        args.parentId,
        safeId,
        undefined,
        (e, id) => api.getById(e, id),
      );
      return jsonResponse(await api.deleteById(entity, safeId));
    },
  },
  {
    name: 'get-threshold-information',
    title: 'Get Threshold Information',
    description:
      'Get current API usage against the integration code rate threshold (external request count and limit). Use to check headroom before fan-out queries.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: { type: 'object', properties: {} },
    handler: async () => jsonResponse(await api.thresholdInformation()),
  },
  {
    name: 'get-version',
    title: 'Get API Version',
    description: 'Get the Autotask REST API version. Cheap connectivity/diagnostic check.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: { type: 'object', properties: {} },
    handler: async () => jsonResponse(await api.version()),
  },
];
