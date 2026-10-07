import type { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import {
  jsonResponse,
  searchResponse,
  parseMaxRecords,
  collectClauses,
  eqClause,
  intArg,
  numberArg,
} from './shared.js';

/** Convenience tools for TimeEntries (labor logged against tickets/tasks). */
export const timeEntryTools: ToolDefinition[] = [
  {
    name: 'search-time-entries',
    title: 'Search Time Entries',
    description:
      'Search time entries. Filters are optional and ANDed; with none, returns entries up to maxRecords. Provide ticketID or taskID to scope to a work item.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'string', description: 'Filter by ticket id' },
        taskID: { type: 'string', description: 'Filter by task id' },
        resourceID: { type: 'string', description: 'Filter by resource id' },
        maxRecords: { type: 'string', description: 'Max records to return (default 50, max 500)' },
      },
    },
    handler: async (args) => {
      const filter = collectClauses(
        eqClause('ticketID', args.ticketID),
        eqClause('taskID', args.taskID),
        eqClause('resourceID', args.resourceID),
      );
      const query = { filter, MaxRecords: parseMaxRecords(args.maxRecords) };
      return searchResponse(filter, await api.query('TimeEntries', query));
    },
  },
  {
    name: 'create-time-entry',
    title: 'Create Time Entry',
    description:
      'Log a time entry against a ticket or task. DESTRUCTIVE (write). Provide exactly one of ticketID or taskID. hoursWorked is required; dateWorked is ISO 8601 (defaults to now if omitted by Autotask). For other fields use generic create-entity.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'string', description: 'Ticket id to log against (or use taskID)' },
        taskID: { type: 'string', description: 'Task id to log against (or use ticketID)' },
        resourceID: { type: 'string', description: 'Resource id performing the work' },
        hoursWorked: { type: 'string', description: 'Hours worked, e.g. "1.5"' },
        summaryNotes: { type: 'string', description: 'Description of the work performed' },
        dateWorked: { type: 'string', description: 'ISO 8601 date/time the work was done' },
      },
      required: ['hoursWorked'],
    },
    handler: async (args) => {
      if ((args.ticketID && args.taskID) || (!args.ticketID && !args.taskID)) {
        throw new Error('Provide exactly one of ticketID or taskID');
      }
      const body: Record<string, unknown> = {
        hoursWorked: numberArg('hoursWorked', args.hoursWorked),
      };
      if (args.ticketID) body.ticketID = intArg('ticketID', args.ticketID);
      if (args.taskID) body.taskID = intArg('taskID', args.taskID);
      if (args.resourceID) body.resourceID = intArg('resourceID', args.resourceID);
      if (args.summaryNotes) body.summaryNotes = args.summaryNotes;
      if (args.dateWorked) body.dateWorked = args.dateWorked;
      return jsonResponse(await api.create('TimeEntries', body));
    },
  },
];
