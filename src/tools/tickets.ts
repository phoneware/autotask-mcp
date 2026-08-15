import { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import {
  jsonResponse,
  searchResponse,
  parseMaxRecords,
  eqClause,
  containsClause,
  ensureFilter,
  resolveClosedStatusIds,
  boolFlag,
  intArg,
  optionalIntArg,
  type FilterClause,
} from './shared.js';

/**
 * Convenience tools for Tickets — the most-used Autotask entity. They wrap the
 * generic query/create/update layer with named, LLM-friendly parameters and
 * real Autotask field names so the agent does not have to hand-build filters.
 * Status / priority / queue values are numeric picklist codes; use
 * describe-entity-fields("Tickets") to discover them.
 */
export const ticketTools: ToolDefinition[] = [
  {
    name: 'search-tickets',
    description:
      'Search tickets by common fields. All filters are optional and combined with AND; with none, returns the most recent tickets up to maxRecords. ' +
      'For triage use the semantic flags rather than enumerating statuses yourself: set openOnly=true to exclude closed tickets (by denylist, so no open status is ever missed) and unassigned=true to return only tickets with no assigned resource. ' +
      'status/priority/queueID are numeric picklist codes (see describe-entity-fields).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketNumber: { type: 'string', description: 'Exact ticket number, e.g. T20240101.0001' },
        companyID: { type: 'string', description: 'Filter by company id' },
        status: { type: 'string', description: 'Numeric status picklist code (exact match)' },
        priority: { type: 'string', description: 'Numeric priority picklist code' },
        queueID: { type: 'string', description: 'Numeric queue id' },
        assignedResourceID: { type: 'string', description: 'Assigned resource id' },
        titleContains: { type: 'string', description: 'Substring match on ticket title' },
        unassigned: {
          type: 'string',
          description: 'Set "true" to return only tickets with no assigned resource',
        },
        openOnly: {
          type: 'string',
          description:
            'Set "true" to exclude closed tickets (status not in closedStatusIds). Use this instead of guessing which statuses are "open".',
        },
        closedStatusIds: {
          type: 'string',
          description:
            'Comma-separated status codes treated as closed when openOnly=true. Defaults to env AUTOTASK_CLOSED_STATUS_IDS or "5,16".',
        },
        maxRecords: { type: 'string', description: 'Max records to return (default 50, max 500)' },
      },
    },
    handler: async (args) => {
      const clauses: FilterClause[] = [];
      for (const c of [
        eqClause('ticketNumber', args.ticketNumber),
        eqClause('companyID', args.companyID),
        eqClause('status', args.status),
        eqClause('priority', args.priority),
        eqClause('queueID', args.queueID),
        eqClause('assignedResourceID', args.assignedResourceID),
        containsClause('title', args.titleContains),
      ]) {
        if (c) clauses.push(c);
      }

      // unassigned: use notExist (more reliable than `eq null` for empty fields).
      if (boolFlag(args.unassigned)) {
        clauses.push({ op: 'notExist', field: 'assignedResourceID' });
      }

      // openOnly: exclude closed statuses by denylist so no open status is ever
      // missed (avoids the fragile per-status allowlist fan-out).
      if (boolFlag(args.openOnly)) {
        for (const id of resolveClosedStatusIds(args.closedStatusIds)) {
          clauses.push({ op: 'noteq', field: 'status', value: id });
        }
      }

      const filter = ensureFilter(clauses);
      const query = { filter, MaxRecords: parseMaxRecords(args.maxRecords) };
      return searchResponse(filter, await api.query('Tickets', query));
    },
  },
  {
    name: 'get-ticket',
    description: 'Get a single ticket by its numeric id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Ticket id' } },
      required: ['id'],
    },
    handler: async (args) => jsonResponse(await api.getById('Tickets', args.id)),
  },
  {
    name: 'create-ticket',
    description:
      'Create a ticket. DESTRUCTIVE (write). title and companyID are required; status/priority/queueID are numeric picklist codes. For fields not listed here, use the generic create-entity tool.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Ticket title' },
        companyID: { type: 'string', description: 'Company id the ticket belongs to' },
        description: { type: 'string', description: 'Ticket description / details' },
        status: { type: 'string', description: 'Numeric status picklist code' },
        priority: { type: 'string', description: 'Numeric priority picklist code' },
        queueID: { type: 'string', description: 'Numeric queue id' },
        assignedResourceID: { type: 'string', description: 'Resource id to assign' },
      },
      required: ['title', 'companyID'],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        title: args.title,
        companyID: intArg('companyID', args.companyID),
      };
      if (args.description) body.description = args.description;
      const status = optionalIntArg('status', args.status);
      if (status !== undefined) body.status = status;
      const priority = optionalIntArg('priority', args.priority);
      if (priority !== undefined) body.priority = priority;
      const queueID = optionalIntArg('queueID', args.queueID);
      if (queueID !== undefined) body.queueID = queueID;
      const assignedResourceID = optionalIntArg('assignedResourceID', args.assignedResourceID);
      if (assignedResourceID !== undefined) body.assignedResourceID = assignedResourceID;
      return jsonResponse(await api.create('Tickets', body));
    },
  },
  {
    name: 'update-ticket',
    description:
      'Update fields on an existing ticket. DESTRUCTIVE (write). Only the supplied fields change. For fields not listed here, use the generic update-entity tool.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ticket id to update' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        status: { type: 'string', description: 'New numeric status picklist code' },
        priority: { type: 'string', description: 'New numeric priority picklist code' },
        queueID: { type: 'string', description: 'New numeric queue id' },
        assignedResourceID: { type: 'string', description: 'New assigned resource id' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = { id: intArg('id', args.id) };
      if (args.title) body.title = args.title;
      if (args.description) body.description = args.description;
      const status = optionalIntArg('status', args.status);
      if (status !== undefined) body.status = status;
      const priority = optionalIntArg('priority', args.priority);
      if (priority !== undefined) body.priority = priority;
      const queueID = optionalIntArg('queueID', args.queueID);
      if (queueID !== undefined) body.queueID = queueID;
      const assignedResourceID = optionalIntArg('assignedResourceID', args.assignedResourceID);
      if (assignedResourceID !== undefined) body.assignedResourceID = assignedResourceID;
      return jsonResponse(await api.update('Tickets', body));
    },
  },
  {
    name: 'create-ticket-note',
    description:
      'Add a note to a ticket. DESTRUCTIVE (write). noteType is a numeric picklist code; publish controls visibility (1 = internal, 2 = all Autotask users — verify via describe-entity-fields("TicketNotes")).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'string', description: 'Ticket id to attach the note to' },
        title: { type: 'string', description: 'Note title' },
        description: { type: 'string', description: 'Note body text' },
        noteType: { type: 'string', description: 'Numeric note type picklist code' },
        publish: { type: 'string', description: 'Numeric publish/visibility picklist code' },
      },
      required: ['ticketID', 'description'],
    },
    handler: async (args) => {
      const ticketID = intArg('ticketID', args.ticketID);
      const body: Record<string, unknown> = {
        ticketID,
        description: args.description,
      };
      if (args.title) body.title = args.title;
      const noteType = optionalIntArg('noteType', args.noteType);
      if (noteType !== undefined) body.noteType = noteType;
      const publish = optionalIntArg('publish', args.publish);
      if (publish !== undefined) body.publish = publish;
      // TicketNotes are created under the parent ticket's child collection.
      return jsonResponse(await api.create(`Tickets/${ticketID}/Notes`, body));
    },
  },
];
