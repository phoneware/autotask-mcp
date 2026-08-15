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
export function buildServer(capabilities?: readonly Capability[]): {
  server: McpServer;
  registeredCount: number;
  skipped: number;
} {
  const server = new McpServer({ name: 'autotask-mcp-server', version: pkg.version });
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

    // A ZodRawShape becomes a default (key-stripping) z.object, which silently
    // discards an argument the agent got wrong and leaves the handler with no
    // filters at all. Strict turns that into an error naming the bad key, and
    // publishes additionalProperties:false in tools/list so clients see it too.
    const inputSchema = z.object(shape).strict() as z.ZodType<Record<string, unknown>>;

    server.registerTool(tool.name, { description: tool.description, inputSchema }, async (args) => {
      try {
        const stringArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined) stringArgs[k] = String(v);
        }

        // Re-check rights at call time, not just at registration. Identity is
        // bound per request while a session outlives one, so the person making
        // this call is not necessarily the one the session was built for.
        // Skipped when there is no caller at all: that is stdio, where the
        // operator is the process owner and there is no sign-in to derive
        // rights from.
        const caller = currentCaller();
        if (caller) {
          assertCapability(tool.name, caller.capabilities, caller.email);
        }

        if (confirmToken) {
          assertConfirmToken(tool.name, confirmToken, stringArgs.confirm);
          delete stringArgs.confirm;
        }

        const result = await tool.handler(stringArgs);
        return { ...result } as {
          content: Array<{ type: 'text'; text: string }>;
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
    });
    registeredCount++;
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
  const { server, registeredCount, skipped } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = isReadonly() ? 'READONLY' : 'full';
  console.error(
    `[autotask-mcp] running (stdio, mode: ${mode}, ${registeredCount} tools, ${skipped} write tools skipped)`,
  );
}
