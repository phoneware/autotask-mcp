import type { ToolDefinition, ToolContext } from '../types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RegistryOperation } from '../generated/types.js';
import { OPERATIONS, findOperation, OPERATION_REGISTRY } from '../generated/registry.js';
import { api } from '../autotask-api.js';
import { currentCaller } from '../auth/context.js';
import { permits, type Capability } from '../auth/capabilities.js';
import { confirmTokenFor, isReadonly, assertSafeNumericId } from '../security.js';
import { jsonResponse } from './shared.js';
import { recordCallApiInvocation } from './promotion/index.js';
import { elicitConfirmation, confirmDestructiveEnabled } from './elicitation.js';

/**
 * Determine the capability required to invoke a registry operation.
 */
export function capabilityForOperation(op: RegistryOperation): Capability {
  if (op.classification === 'read') return 'read';
  if (op.method === 'POST') return 'create';
  if (op.method === 'PATCH' || op.method === 'PUT') return 'update';
  if (op.method === 'DELETE') return 'delete';
  return 'read';
}

/**
 * Check if an operation is visible/permitted for the current context.
 */
export function isOperationVisible(
  op: RegistryOperation,
  callerCapabilities?: readonly Capability[],
): boolean {
  if (isReadonly() && op.destructive) {
    return false;
  }
  if (callerCapabilities) {
    const needed = capabilityForOperation(op);
    if (!permits(callerCapabilities, needed)) {
      return false;
    }
  }
  return true;
}

/**
 * Keyword search across all 3,014 Autotask REST API operations.
 */
export const searchApiTool: ToolDefinition = {
  name: 'search_api',
  title: 'Search API Registry',
  description:
    'Search the full Autotask PSA REST API (3,014 operations) by keyword. Matches operationId, entity, path, summary, and description. Returns operation names to invoke with call_api.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search terms separated by space, e.g. "ticket charge" or "company contact".',
      },
      limit: {
        type: 'string',
        description: 'Maximum results to return (default 15, max 50).',
      },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const q = String(args.query || '')
      .trim()
      .toLowerCase();
    if (!q) {
      return jsonResponse({ query: q, total: 0, matches: [] });
    }

    const limit = Math.min(Math.max(1, parseInt(args.limit || '15', 10) || 15), 50);
    const terms = q.split(/\s+/).filter(Boolean);
    const caller = currentCaller();
    const callerCapabilities = caller?.capabilities;

    interface ScoredOp {
      op: RegistryOperation;
      score: number;
    }

    const scored: ScoredOp[] = [];

    // Deduplicate operations so aliases sharing the same operationId are scored once
    const seenOpIds = new Set<string>();

    for (const op of OPERATIONS) {
      if (seenOpIds.has(op.operationId)) continue;
      seenOpIds.add(op.operationId);

      if (!isOperationVisible(op, callerCapabilities)) continue;

      const opId = op.operationId.toLowerCase();
      const entity = op.entity.toLowerCase();
      const parent = (op.parentEntity || '').toLowerCase();
      const child = (op.childAlias || '').toLowerCase();
      const path = op.pathTemplate.toLowerCase();
      const summary = (op.summary || '').toLowerCase();
      const desc = (op.description || '').toLowerCase();
      const tag = (op.tag || '').toLowerCase();
      const method = op.method.toLowerCase();

      let matchCount = 0;
      let totalScore = 0;

      for (const t of terms) {
        let termMatched = false;
        if (opId.includes(t)) {
          termMatched = true;
          totalScore += 10;
        }
        if (entity.includes(t) || child.includes(t)) {
          termMatched = true;
          totalScore += 8;
        }
        if (parent.includes(t)) {
          termMatched = true;
          totalScore += 6;
        }
        if (path.includes(t)) {
          termMatched = true;
          totalScore += 5;
        }
        if (tag.includes(t) || summary.includes(t)) {
          termMatched = true;
          totalScore += 3;
        }
        if (desc.includes(t)) {
          termMatched = true;
          totalScore += 1;
        }
        if (method === t) {
          termMatched = true;
          totalScore += 2;
        }

        if (termMatched) {
          matchCount++;
        }
      }

      // Require all search terms to match somewhere
      if (matchCount === terms.length) {
        scored.push({ op, score: totalScore });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.op.operationId.localeCompare(b.op.operationId));

    const matches = scored.slice(0, limit).map(({ op }) => ({
      operationId: op.operationId,
      method: op.method,
      pathTemplate: op.pathTemplate,
      entity: op.entity,
      parentEntity: op.parentEntity,
      childAlias: op.childAlias,
      classification: op.classification,
      destructive: op.destructive,
      summary: op.summary || undefined,
      description: op.description || undefined,
      parameters: op.parameters,
    }));

    return jsonResponse({
      query: q,
      total: scored.length,
      matches,
    });
  },
};

/**
 * Invoke any operation from the full 3,014 Autotask REST API registry.
 */
export const callApiTool: ToolDefinition = {
  name: 'call_api',
  title: 'Call API Operation',
  description:
    'Invoke any operation from the full Autotask PSA REST API registry by operationId. Supports all endpoints with automatic path parameter interpolation, query string formatting, and body handling. Write operations require confirm token.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description:
          'The exact operationId (e.g. "TicketChargesChild_Query" or "TicketChargesChild_PatchEntity") as returned by search_api.',
      },
      args: {
        type: 'string',
        description:
          'JSON object of arguments for the operation, including path parameters (parentId, id), query parameters, and fields or restModelInput.',
      },
      confirm: {
        type: 'string',
        description:
          'Required confirmation token for write/destructive operations. Must equal the uppercase operationId.',
      },
    },
    required: ['tool_name'],
  },
  handler: async (rawArgs, context?: ToolContext) => {
    const toolName = String(rawArgs.tool_name || '').trim();
    if (!toolName) {
      throw new Error('tool_name is required');
    }

    const op = findOperation(toolName);
    if (!op) {
      throw new Error(
        `Operation "${toolName}" not found in Autotask API registry (${OPERATION_REGISTRY.size} total). Use search_api to find valid operations.`,
      );
    }

    // 1. Parse args
    let parsedArgs: Record<string, unknown> = {};
    if (rawArgs.args) {
      try {
        parsedArgs =
          typeof rawArgs.args === 'string'
            ? JSON.parse(rawArgs.args)
            : (rawArgs.args as Record<string, unknown>);
      } catch (err: unknown) {
        throw new Error(`Invalid JSON in args: ${(err as Error).message}`);
      }
    }
    // 2. Validate top-level argument keys against declared parameters
    const declaredPathParams = new Set(
      op.parameters.filter((p) => p.in === 'path').map((p) => p.name.toLowerCase()),
    );
    const declaredQueryParams = new Set(
      op.parameters.filter((p) => p.in === 'query').map((p) => p.name.toLowerCase()),
    );
    const hasBody =
      op.parameters.some((p) => p.in === 'body') || (op.method !== 'GET' && op.method !== 'DELETE');
    const bodyWrappers = hasBody
      ? new Set(['restmodelinput', 'querymodel', 'model', 'body', 'fields'])
      : new Set<string>();
    const allowedBodyFieldSet = hasBody
      ? new Set((op.allowedBodyFields || []).map((f) => f.toLowerCase()))
      : new Set<string>();

    const acceptedTopLevel = [
      ...op.parameters.filter((p) => p.in === 'path').map((p) => p.name),
      ...op.parameters.filter((p) => p.in === 'query').map((p) => p.name),
      ...(hasBody ? ['restModelInput', 'queryModel', 'model', 'body', 'fields'] : []),
      ...(hasBody ? op.allowedBodyFields || [] : []),
      ...(op.destructive ? ['confirm'] : []),
    ];

    for (const key of Object.keys(parsedArgs)) {
      const keyLower = key.toLowerCase();
      const isPath = declaredPathParams.has(keyLower);
      const isQuery = declaredQueryParams.has(keyLower);
      const isWrapper = bodyWrappers.has(keyLower);
      const isBodyField = allowedBodyFieldSet.has(keyLower);
      const isConfirm = op.destructive && keyLower === 'confirm';

      if (!isPath && !isQuery && !isWrapper && !isBodyField && !isConfirm) {
        throw new Error(
          `Unknown argument "${key}" for operation "${op.operationId}". Accepted arguments: ${acceptedTopLevel.join(', ')}`,
        );
      }
    }

    // 3. Read-only check
    if (isReadonly() && op.destructive) {
      throw new Error(`Tool "${toolName}" is not permitted in read-only mode`);
    }
    // 3. Capability authorization check
    const caller = currentCaller();
    if (caller) {
      const needed = capabilityForOperation(op);
      if (!permits(caller.capabilities, needed)) {
        throw new Error(
          `"${toolName}" requires the "${needed}" capability, which ${caller.email} does not have.`,
        );
      }
    }

    // 4. Confirm token and elicitation check for write/destructive operations
    if (op.destructive) {
      const expectedToken = confirmTokenFor(op.operationId);
      const givenToken = rawArgs.confirm || (parsedArgs.confirm as string | undefined);

      if (givenToken !== expectedToken) {
        throw new Error(
          `Destructive tool "${op.operationId}" requires confirm: "${expectedToken}" (got: ${
            givenToken ? `"${givenToken}"` : 'missing'
          })`,
        );
      }

      // Elicitation confirmation if enabled
      if (confirmDestructiveEnabled()) {
        await elicitConfirmation(op.operationId, parsedArgs, context?.server as Server | undefined);
      }
    }
    // 5. Build path by replacing placeholders
    let resolvedPath = op.pathTemplate;
    const consumedKeys = new Set<string>();

    // Autotask paths use {parentId}, {id}, {contactId}, etc.
    const pathPlaceholders = op.pathTemplate.match(/\{([A-Za-z0-9_]+)\}/g) || [];
    for (const ph of pathPlaceholders) {
      const paramName = ph.slice(1, -1);
      const val = parsedArgs[paramName] ?? parsedArgs[paramName.toLowerCase()];
      if (val === undefined || val === null || val === '') {
        throw new Error(
          `Missing required path parameter "${paramName}" for operation "${op.operationId}" (${op.pathTemplate})`,
        );
      }
      assertSafeNumericId(String(val), paramName);
      resolvedPath = resolvedPath.replace(ph, encodeURIComponent(String(val)));
      consumedKeys.add(paramName);
      consumedKeys.add(paramName.toLowerCase());
    }

    // 6. Build query parameters
    const queryParams: Record<string, string> = {};
    for (const p of op.parameters) {
      if (p.in === 'query') {
        const val = parsedArgs[p.name] ?? parsedArgs[p.name.toLowerCase()];
        if (val !== undefined && val !== null) {
          queryParams[p.name] = String(val);
          consumedKeys.add(p.name);
          consumedKeys.add(p.name.toLowerCase());
        }
      }
    }

    const queryString = new URLSearchParams(queryParams).toString();
    const finalPath = queryString ? `${resolvedPath}?${queryString}` : resolvedPath;

    // 7. Build body for non-GET/DELETE methods
    let body: unknown;
    if (op.method !== 'GET' && op.method !== 'DELETE') {
      if (parsedArgs.restModelInput !== undefined) {
        body = parsedArgs.restModelInput;
      } else if (parsedArgs.queryModel !== undefined) {
        body = parsedArgs.queryModel;
      } else if (parsedArgs.model !== undefined) {
        body = parsedArgs.model;
      } else if (parsedArgs.body !== undefined) {
        body = parsedArgs.body;
      } else if (parsedArgs.fields !== undefined) {
        body =
          typeof parsedArgs.fields === 'string' ? JSON.parse(parsedArgs.fields) : parsedArgs.fields;
      } else {
        // Collect remaining non-consumed parameters
        const remaining: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parsedArgs)) {
          if (!consumedKeys.has(k) && k !== 'confirm') {
            remaining[k] = v;
          }
        }
        if (Object.keys(remaining).length > 0) {
          body = remaining;
        }
      }

      // Validate body fields against request model if defined
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        op.allowedBodyFields &&
        op.allowedBodyFields.length > 0
      ) {
        const allowedKeys = new Set(op.allowedBodyFields.map((f) => f.toLowerCase()));
        for (const bKey of Object.keys(body as Record<string, unknown>)) {
          if (!allowedKeys.has(bKey.toLowerCase())) {
            throw new Error(
              `Unknown body field "${bKey}" for operation "${op.operationId}" (model: ${op.requestModelRef || 'body'}). Accepted fields: ${op.allowedBodyFields.join(', ')}`,
            );
          }
        }
      }
    }
    // 8. Validate writable fields on create/update operations before sending request
    if (
      body &&
      typeof body === 'object' &&
      op.classification === 'write' &&
      (op.method === 'POST' || op.method === 'PATCH' || op.method === 'PUT')
    ) {
      const route = resolvedPath.replace(/^\/?(v1\.0\/)?/i, '');
      await api.assertWritableFields(route, body, op.method !== 'POST');
    }

    // 9. Execute via AutotaskApi (which runs through budget governor and auth headers)
    const result = await api.request(op.method, finalPath, body);

    // 9. Record call for tool promotion (best effort)
    const userKey = caller?.email ?? 'stdio';
    const { promoted } = await recordCallApiInvocation(userKey, op.operationId);
    if (promoted && context?.server) {
      try {
        const s = context.server as { sendToolListChanged?: () => Promise<void> };
        if (typeof s.sendToolListChanged === 'function') {
          await s.sendToolListChanged();
        }
      } catch {
        // Notification is best-effort
      }
    }
    return jsonResponse(result);
  },
};

export const metaTools: ToolDefinition[] = [searchApiTool, callApiTool];
