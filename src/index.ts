#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { allTools } from './tools/index.js';
import { staticResources, resourceTemplates, handleResource } from './resources.js';
import {
  DESTRUCTIVE_TOOLS,
  CONFIRM_REQUIRED_TOOLS,
  confirmTokenFor,
  isReadonly,
} from './security.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'),
) as { version: string };

/** Build a fully configured MCP server (tools + resources + guards). */
function buildServer(): { server: McpServer; registeredCount: number; skipped: number } {
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

    server.tool(tool.name, tool.description, shape, async (args: Record<string, unknown>) => {
      try {
        const stringArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined) stringArgs[k] = String(v);
        }

        if (confirmToken) {
          const given = stringArgs.confirm;
          if (given !== confirmToken) {
            throw new Error(
              `Destructive tool "${tool.name}" requires confirm: "${confirmToken}" (got: ${
                given ? `"${given}"` : 'missing'
              })`,
            );
          }
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

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function runStdio() {
  const { server, registeredCount, skipped } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = isReadonly() ? 'READONLY' : 'full';
  console.error(
    `[autotask-mcp] running (stdio, mode: ${mode}, ${registeredCount} tools, ${skipped} write tools skipped)`,
  );
}

async function runHttp() {
  const httpToken = process.env.AUTOTASK_HTTP_TOKEN;
  if (!httpToken || httpToken.length < 16) {
    console.error(
      '[autotask-mcp] AUTOTASK_TRANSPORT=http requires AUTOTASK_HTTP_TOKEN (>= 16 chars). ' +
        'Aborting — refusing to expose /mcp without auth.',
    );
    process.exit(1);
  }
  const host = process.env.AUTOTASK_HTTP_HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);

  const { StreamableHTTPServerTransport } =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const http = await import('node:http');

  const { server, registeredCount, skipped } = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url.startsWith('/mcp')) {
      const auth = req.headers['authorization'];
      const presented =
        typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (!presented || !tokensMatch(presented, httpToken)) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Bearer realm="autotask-mcp"');
        res.end();
        return;
      }
      void transport.handleRequest(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  httpServer.listen(port, host, () => {
    const mode = isReadonly() ? 'READONLY' : 'full';
    console.error(
      `[autotask-mcp] HTTP transport on ${host}:${port} (mode: ${mode}, ${registeredCount} tools, ${skipped} write tools skipped)`,
    );
  });
}

async function main() {
  if ((process.env.AUTOTASK_TRANSPORT || '').toLowerCase() === 'http') {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error('[autotask-mcp] fatal:', err);
  process.exit(1);
});
