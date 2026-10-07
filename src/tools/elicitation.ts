/**
 * Elicitation gate for destructive tool calls.
 *
 * When MCP_CONFIRM_DESTRUCTIVE=true, destructive operations elicit confirmation
 * from the client before execution. If the client does not support elicitation,
 * MCP_CONFIRM_FALLBACK controls behavior:
 *   - "fail" (default): refuse the call with a clear error
 *   - "allow": proceed as if confirmed (operator opt-in)
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

let activeServer: Server | null = null;

export function setActiveServer(server: Server | null): void {
  activeServer = server;
}

export function confirmDestructiveEnabled(): boolean {
  return process.env.MCP_CONFIRM_DESTRUCTIVE === 'true';
}

function fallbackPolicy(): 'fail' | 'allow' {
  const v = (process.env.MCP_CONFIRM_FALLBACK || '').toLowerCase();
  return v === 'allow' ? 'allow' : 'fail';
}

function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return '(no arguments)';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const trimmed = s.length > 60 ? s.slice(0, 60) + '...' : s;
    parts.push(`${k}=${trimmed}`);
    if (parts.length >= 5) {
      parts.push('...');
      break;
    }
  }
  return parts.join(', ');
}

export async function elicitConfirmation(
  toolName: string,
  args: Record<string, unknown> | undefined,
  serverOverride?: Server,
): Promise<boolean> {
  const server = serverOverride || activeServer;
  if (!server || typeof server.elicitInput !== 'function') {
    const policy = fallbackPolicy();
    if (policy === 'allow') return true;
    throw new McpError(
      ErrorCode.InvalidParams,
      `Tool '${toolName}' is destructive and the connected client does not support confirmation prompts. ` +
        `Set MCP_CONFIRM_FALLBACK=allow to bypass on such clients, or use a client that supports MCP elicitation.`,
    );
  }

  const getCaps = (
    server as unknown as {
      getClientCapabilities?: () => { elicitation?: { form?: boolean } } | undefined;
    }
  ).getClientCapabilities;
  if (typeof getCaps === 'function') {
    const caps = getCaps.call(server);
    if (caps && !caps.elicitation?.form) {
      const policy = fallbackPolicy();
      if (policy === 'allow') return true;
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool '${toolName}' is destructive and the connected client does not support confirmation prompts. ` +
          `Set MCP_CONFIRM_FALLBACK=allow to bypass on such clients, or use a client that supports MCP elicitation.`,
      );
    }
  }
  const summary = summarizeArgs(args);
  const message =
    `This tool can change or remove data and the operator has required confirmation.\n\n` +
    `Tool: ${toolName}\n` +
    `Arguments: ${summary}\n\n` +
    `Proceed?`;

  try {
    const result = await server.elicitInput({
      mode: 'form',
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'string',
            title: 'Confirm',
            description: 'Choose "yes" to execute this destructive operation.',
            enum: ['yes', 'no'],
            enumNames: ['Yes: execute', 'No: cancel'],
          },
        },
        required: ['confirm'],
      },
    });

    if (result.action === 'accept') {
      const confirm = (result.content as Record<string, unknown> | undefined)?.confirm;
      if (confirm === 'yes') return true;
      throw new McpError(
        ErrorCode.InvalidParams,
        `User declined to confirm destructive operation '${toolName}'`,
      );
    }

    throw new McpError(
      ErrorCode.InvalidParams,
      `User ${result.action === 'decline' ? 'declined' : 'cancelled'} the destructive operation '${toolName}'`,
    );
  } catch (err: unknown) {
    if (err instanceof McpError && err.code === ErrorCode.InvalidParams) {
      if (err.message.includes('declined') || err.message.includes('cancelled')) {
        throw err;
      }
    }
    const isUnsupported =
      (err instanceof Error && err.message.includes('does not support form elicitation')) ||
      (err instanceof McpError && err.code !== ErrorCode.InvalidParams);

    if (isUnsupported) {
      const policy = fallbackPolicy();
      if (policy === 'allow') return true;
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool '${toolName}' is destructive and the connected client does not support confirmation prompts. ` +
          `Set MCP_CONFIRM_FALLBACK=allow to bypass on such clients, or use a client that supports MCP elicitation.`,
      );
    }
    throw err;
  }
}
