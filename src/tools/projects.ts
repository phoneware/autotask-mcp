import { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import {
  jsonResponse,
  parseMaxRecords,
  collectClauses,
  eqClause,
  containsClause,
} from './shared.js';

/** Convenience read tools for Projects and their Tasks. */
export const projectTools: ToolDefinition[] = [
  {
    name: 'search-projects',
    description:
      'Search projects. Filters are optional and ANDed; with none, returns projects up to maxRecords. status is a numeric picklist code.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'string', description: 'Filter by company id' },
        status: { type: 'string', description: 'Numeric project status picklist code' },
        nameContains: { type: 'string', description: 'Substring match on project name' },
        maxRecords: { type: 'string', description: 'Max records to return (default 50, max 500)' },
      },
    },
    handler: async (args) => {
      const filter = collectClauses(
        eqClause('companyID', args.companyID),
        eqClause('status', args.status),
        containsClause('projectName', args.nameContains),
      );
      const query = { filter, MaxRecords: parseMaxRecords(args.maxRecords) };
      return jsonResponse(await api.query('Projects', query));
    },
  },
  {
    name: 'get-project',
    description: 'Get a single project by its numeric id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Project id' } },
      required: ['id'],
    },
    handler: async (args) => jsonResponse(await api.getById('Projects', args.id)),
  },
  {
    name: 'search-tasks',
    description:
      'Search tasks, typically within a project. Filters are optional and ANDed. status is a numeric picklist code.',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: { type: 'string', description: 'Filter by parent project id' },
        status: { type: 'string', description: 'Numeric task status picklist code' },
        assignedResourceID: { type: 'string', description: 'Assigned resource id' },
        titleContains: { type: 'string', description: 'Substring match on task title' },
        maxRecords: { type: 'string', description: 'Max records to return (default 50, max 500)' },
      },
    },
    handler: async (args) => {
      const filter = collectClauses(
        eqClause('projectID', args.projectID),
        eqClause('status', args.status),
        eqClause('assignedResourceID', args.assignedResourceID),
        containsClause('title', args.titleContains),
      );
      const query = { filter, MaxRecords: parseMaxRecords(args.maxRecords) };
      return jsonResponse(await api.query('Tasks', query));
    },
  },
  {
    name: 'get-task',
    description: 'Get a single task by its numeric id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id' } },
      required: ['id'],
    },
    handler: async (args) => jsonResponse(await api.getById('Tasks', args.id)),
  },
];
