import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { allTools } from './tools/index.js';
import { staticResources, resourceTemplates, handleResource } from './resources.js';
import {
  DESTRUCTIVE_TOOLS,
  CONFIRM_REQUIRED_TOOLS,
  confirmTokenFor,
  assertConfirmToken,
  assertCapability,
  capabilityForTool,
  isReadonly,
} from './security.js';
import { permits, type Capability } from './auth/capabilities.js';
import { currentCaller } from './auth/context.js';
import {
  setActiveServer,
  elicitConfirmation,
  confirmDestructiveEnabled,
} from './tools/elicitation.js';
import { findOperation } from './generated/registry.js';
import { callApiTool } from './tools/meta.js';
import { getPromotedToolNames } from './tools/promotion/index.js';
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'),
) as { version: string };

/**
 * Build a fully configured MCP server (tools + resources + guards).
 *
 * `capabilities` is what the signed-in person may do. Tools beyond it are not
 * registered at all, which is the same stance read-only mode already takes: a
 * tool that does not exist cannot be called by a confused agent, and the model
 * is not tempted by a capability it will only be refused. Omitting the argument
 * builds the full surface, which is what stdio (a single trusted local
 * operator, no sign-in) and the tool-count tests want.
 */
export function buildServer(
  capabilities?: readonly Capability[],
  promotedTools?: readonly string[],
): {
  server: McpServer;
  registeredCount: number;
  skipped: number;
} {
  const server = new McpServer({ name: 'autotask-mcp-server', version: pkg.version });
  setActiveServer(server.server);
  const readonly = isReadonly();
  let registeredCount = 0;
  let skipped = 0;

  for (const tool of allTools) {
    const isDestructive = DESTRUCTIVE_TOOLS.has(tool.name);
    const requiresConfirm = CONFIRM_REQUIRED_TOOLS.has(tool.name);
    if (readonly && isDestructive) {
      skipped++;
      continue;
    }
    if (capabilities && !permits(capabilities, capabilityForTool(tool.name))) {
      skipped++;
      continue;
    }

    const confirmToken = requiresConfirm ? confirmTokenFor(tool.name) : null;

    const shape: Record<string, z.ZodTypeAny> = {};
    if (confirmToken) {
      shape.confirm = z
        .string()
        .describe(
          `Required confirmation token. Must equal "${confirmToken}" to authorize this destructive action.`,
        );
    }
    const required = tool.inputSchema.required || [];
    for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
      let zodType: z.ZodTypeAny = z.string().describe(prop.description);
      if (!required.includes(key)) zodType = zodType.optional();
      shape[key] = zodType;
    }

    const inputSchema = z.object(shape).strict() as z.ZodType<Record<string, unknown>>;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema,
        annotations: tool.annotations,
      },
      async (args) => {
        try {
          const stringArgs: Record<string, string> = {};
          for (const [k, v] of Object.entries(args)) {
            if (v !== undefined) stringArgs[k] = String(v);
          }

          const caller = currentCaller();
          if (caller) {
            assertCapability(tool.name, caller.capabilities, caller.email);
          }

          if (confirmToken) {
            assertConfirmToken(tool.name, confirmToken, stringArgs.confirm);
            delete stringArgs.confirm;
          }

          if (isDestructive && confirmDestructiveEnabled()) {
            await elicitConfirmation(tool.name, stringArgs, server.server);
          }

          const result = await tool.handler(stringArgs, { server: server.server });
          return {
            ...result,
            structuredContent: result.structuredContent,
          } as {
            content: Array<{ type: 'text'; text: string }>;
            structuredContent?: Record<string, unknown>;
            isError?: boolean;
            [key: string]: unknown;
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          } as {
            content: Array<{ type: 'text'; text: string }>;
            isError: boolean;
            [key: string]: unknown;
          };
        }
      },
    );
    registeredCount++;
  }

  // Register promoted tools for this user if provided
  if (promotedTools && promotedTools.length > 0) {
    const seenNames = new Set(allTools.map((t) => t.name));
    for (const opId of promotedTools) {
      if (seenNames.has(opId)) continue;
      const op = findOperation(opId);
      if (!op) continue;
      if (readonly && op.destructive) continue;
      const neededCap: Capability =
        op.classification === 'read'
          ? 'read'
          : op.method === 'POST'
            ? 'create'
            : op.method === 'DELETE'
              ? 'delete'
              : 'update';
      if (capabilities && !permits(capabilities, neededCap)) continue;

      const shape: Record<string, z.ZodTypeAny> = {};
      const opConfirmToken = op.destructive ? confirmTokenFor(op.operationId) : null;
      if (opConfirmToken) {
        shape.confirm = z
          .string()
          .describe(
            `Required confirmation token. Must equal "${opConfirmToken}" to authorize this action.`,
          );
      }
      for (const p of op.parameters) {
        let zodType: z.ZodTypeAny = z.string().describe(p.description || p.name);
        if (!p.required) zodType = zodType.optional();
        shape[p.name] = zodType;
      }
      const inputSchema = z.object(shape).passthrough() as z.ZodType<Record<string, unknown>>;
      const exposedName = `promoted_${op.operationId}`;
      seenNames.add(exposedName);

      server.registerTool(
        exposedName,
        {
          title: `[Promoted] ${op.summary || op.operationId}`,
          description: `[promoted] ${op.description || op.summary || op.pathTemplate} [${op.method} ${op.pathTemplate}]`,
          inputSchema,
          annotations: {
            readOnlyHint: op.classification === 'read',
            destructiveHint: op.destructive,
            idempotentHint: op.method === 'GET' || op.method === 'DELETE',
            openWorldHint: true,
          },
        },
        async (args) => {
          const confirmVal = args.confirm as string | undefined;
          const innerArgs: Record<string, unknown> = { ...args };
          delete innerArgs.confirm;
          const callArgs: Record<string, string> = {
            tool_name: op.operationId,
            args: JSON.stringify(innerArgs),
          };
          if (confirmVal !== undefined) callArgs.confirm = confirmVal;
          const res = await callApiTool.handler(callArgs, { server: server.server });
          return {
            ...res,
            structuredContent: res.structuredContent,
          } as {
            content: Array<{ type: 'text'; text: string }>;
            structuredContent?: Record<string, unknown>;
            isError?: boolean;
            [key: string]: unknown;
          };
        },
      );
      registeredCount++;
    }
  }

  for (const res of staticResources) {
    server.resource(
      res.name,
      res.uri,
      { description: res.description, mimeType: res.mimeType },
      async (uri) => {
        const text = await handleResource(uri.href);
        return { contents: [{ uri: uri.href, mimeType: res.mimeType, text }] };
      },
    );
  }

  for (const tpl of resourceTemplates) {
    server.resource(
      tpl.name,
      tpl.uriTemplate,
      { description: tpl.description, mimeType: tpl.mimeType },
      async (uri) => {
        const text = await handleResource(uri.href);
        return { contents: [{ uri: uri.href, mimeType: tpl.mimeType, text }] };
      },
    );
  }

  return { server, registeredCount, skipped };
}

export async function runStdio(): Promise<void> {
  const promoted = await getPromotedToolNames('stdio');
  const { server, registeredCount, skipped } = buildServer(undefined, promoted);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = isReadonly() ? 'READONLY' : 'full';
  console.error(
    `[autotask-mcp] running (stdio, mode: ${mode}, ${registeredCount} tools, ${skipped} write tools skipped)`,
  );
}
