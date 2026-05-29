import { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import { parseJsonBody, querySchema, recordBodySchema, updateBodySchema } from '../security.js';
import { jsonResponse } from './shared.js';

/**
 * Resolve the entity path, supporting parent-scoped child collections such as
 * Tickets/{id}/Notes or Companies/{id}/Attachments. Many Autotask child
 * entities can only be queried/created under their parent.
 */
function resolveEntity(entity: string, parentEntity?: string, parentId?: string): string {
  if (parentEntity && parentId) {
    return `${parentEntity}/${parentId}/${entity}`;
  }
  if (parentEntity || parentId) {
    throw new Error('parentEntity and parentId must be provided together');
  }
  return entity;
}

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
 * Companies, Contacts, Projects, Contracts, ConfigurationItems, …). This is
 * the foundation layer: it gives the agent full read/write coverage of the
 * REST API without a hand-written tool per entity.
 */
export const genericTools: ToolDefinition[] = [
  {
    name: 'list-known-entities',
    description:
      'List commonly used Autotask entity names you can pass to the generic query/get/create/update/delete tools. Not exhaustive — Autotask exposes 180+ entities. Use describe-entity-fields to inspect any entity.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const entities = [
        'Tickets',
        'TicketNotes',
        'Companies',
        'Contacts',
        'Projects',
        'Tasks',
        'TimeEntries',
        'Resources',
        'Contracts',
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
    description:
      "Describe an entity's fields: names, data types, whether required, and picklist values (e.g. ticket status codes). Call this before building filters or create/update bodies so you use real field names and valid picklist values.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets" or "Companies"' },
      },
      required: ['entity'],
    },
    handler: async (args) => jsonResponse(await api.entityFields(args.entity)),
  },
  {
    name: 'query-entity',
    description:
      'Query any Autotask entity using the REST query syntax. Pass `query` as a JSON string: {"filter":[{"op":"eq","field":"status","value":1}],"MaxRecords":50}. Supported ops include eq, noteq, gt, gte, lt, lte, contains, beginsWith, endsWith, in, notIn, exist, notExist. AND/OR groups use {"op":"and","items":[...]}.',
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
    description:
      'Count how many records match a query, without fetching them. Use before a large fan-out query to check the result size against the rate threshold. `query` uses the same JSON syntax as query-entity.',
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
    name: 'get-entity',
    description: 'Fetch a single record of any entity by its numeric id.',
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
        await api.getById(resolveEntity(args.entity, args.parentEntity, args.parentId), args.id),
      ),
  },
  {
    name: 'create-entity',
    description:
      'Create a record of any entity. DESTRUCTIVE: requires a confirm token. Pass `fields` as a JSON string of the record body, e.g. {"title":"...","companyID":123}. Use describe-entity-fields first to learn required fields.',
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
      const entity = resolveEntity(args.entity, args.parentEntity, args.parentId);
      return jsonResponse(await api.create(entity, body));
    },
  },
  {
    name: 'update-entity',
    description:
      'Partially update a record of any entity. DESTRUCTIVE: requires a confirm token. Pass `fields` as a JSON string that MUST include "id", e.g. {"id":123,"status":5}. Only the supplied fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets"' },
        fields: {
          type: 'string',
          description: 'JSON object of field values to update; must include "id"',
        },
      },
      required: ['entity', 'fields'],
    },
    handler: async (args) => {
      const body = parseJsonBody(args.fields, updateBodySchema, 'fields');
      return jsonResponse(await api.update(args.entity, body));
    },
  },
  {
    name: 'delete-entity',
    description:
      'Delete a record of any entity by id. DESTRUCTIVE and irreversible: requires a confirm token. Not all entities support deletion.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name, e.g. "Tickets"' },
        id: { type: 'string', description: 'Numeric record id to delete' },
      },
      required: ['entity', 'id'],
    },
    handler: async (args) => jsonResponse(await api.deleteById(args.entity, args.id)),
  },
  {
    name: 'get-threshold-information',
    description:
      'Get current API usage against the integration code rate threshold (external request count and limit). Use to check headroom before fan-out queries.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => jsonResponse(await api.thresholdInformation()),
  },
  {
    name: 'get-version',
    description: 'Get the Autotask REST API version. Cheap connectivity/diagnostic check.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => jsonResponse(await api.version()),
  },
];
