import crypto from 'node:crypto';
import type { ToolDefinition } from '../types.js';
import { api } from '../autotask-api.js';
import { currentCaller } from '../auth/context.js';
import { assertSafeNumericId } from '../security.js';
import { jsonResponse } from './shared.js';

interface TicketModel {
  id?: number | string;
  resolution?: string;
  [key: string]: unknown;
}

interface TicketChecklistItemModel {
  id?: number | string;
  ticketID?: number | string;
  isCompleted?: boolean;
  itemName?: string;
  position?: number | null;
  completedDateTime?: string | null;
  completedByResourceID?: number | null;
  [key: string]: unknown;
}

function unwrapRecord<T extends Record<string, unknown>>(raw: unknown): T {
  if (raw && typeof raw === 'object') {
    if ('item' in raw && raw.item && typeof raw.item === 'object') {
      return raw.item as T;
    }
    return raw as T;
  }
  return {} as T;
}

export const SECRET_PATTERN =
  /password|passwd|passphrase|pre-?shared|\bpsk\b|\bpin\b\s*[:=]|LPA:1\$/i;

/** Format a Date into UTC YYYY-MM-DD HH:MM UTC */
export function formatUtcTimestamp(date: Date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

/** Mask credential values following password/passphrase/psk tokens */
export function maskSecretTokens(text: string): string {
  return text.replace(
    /(password|passwd|passphrase|pre-?shared|\bpsk\b)([\s:=]+)(\S+)/gi,
    (_match, prefix, sep, _val) => `${prefix}${sep}[REDACTED]`,
  );
}

export const ticketWriteTools: ToolDefinition[] = [
  {
    name: 'append-ticket-resolution',
    title: 'Append Ticket Resolution',
    description:
      'Append a timestamped line to a ticket resolution without rewriting existing text. ' +
      'DESTRUCTIVE (write): requires confirm token APPEND_TICKET_RESOLUTION. ' +
      'Refuses secret-looking text (passwords, PINs, PSKs, LPA activation codes) and concurrent edits.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'string', description: 'Autotask ticket id' },
        text: { type: 'string', description: 'Resolution text to append (1..2000 characters)' },
        expectedResolutionSha256: {
          type: 'string',
          description: 'Optional SHA256 hex of current resolution text as a concurrency guard',
        },
      },
      required: ['ticketID', 'text'],
    },
    handler: async (args) => {
      const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');

      if (!args.text || args.text.length < 1 || args.text.length > 2000) {
        throw new Error('Resolution text must be between 1 and 2000 characters');
      }

      if (SECRET_PATTERN.test(args.text)) {
        throw new Error('Refused: resolution text contains sensitive credential pattern');
      }

      // Read 1: check ticket and expectedResolutionSha256
      const ticketRes1 = await api.getById('Tickets', ticketId);
      const ticket1 = unwrapRecord<TicketModel>(ticketRes1);
      if (!ticket1 || Object.keys(ticket1).length === 0) {
        throw new Error(`Ticket ${ticketId} not found`);
      }

      const currentResolution = typeof ticket1.resolution === 'string' ? ticket1.resolution : '';
      const currentSha = crypto.createHash('sha256').update(currentResolution).digest('hex');

      if (args.expectedResolutionSha256) {
        const expected = args.expectedResolutionSha256.trim().toLowerCase();
        if (expected !== currentSha.toLowerCase()) {
          throw new Error(
            `Conflict: expectedResolutionSha256 mismatch (expected: ${args.expectedResolutionSha256}, actual: ${currentSha})`,
          );
        }
      }

      const timestamp = formatUtcTimestamp();
      const caller = currentCaller();
      const author = caller?.email ?? 'autotask-mcp';
      const appendedLine = `${args.text} [${timestamp}, ${author}]`;

      // Check if exact line is already present
      const lines = currentResolution.split(/\r?\n/);
      if (lines.includes(appendedLine) || currentResolution.includes(appendedLine)) {
        return jsonResponse({
          ticketID: Number(ticketId),
          written: false,
          already_present: true,
          appended_line: appendedLine,
          resolution_length_before: currentResolution.length,
          resolution_length_after: currentResolution.length,
          verified: true,
        });
      }

      // Appends with a single \n separator, never rewriting existing text
      const newResolution =
        currentResolution.length === 0
          ? appendedLine
          : currentResolution.endsWith('\n')
            ? `${currentResolution}${appendedLine}`
            : `${currentResolution}\n${appendedLine}`;

      // Max length validation from entityFields('Tickets') resolution.length
      try {
        const rawFields = (await api.entityFields('Tickets')) as
          | { fields?: Array<{ name?: string; length?: number }> }
          | undefined;
        if (rawFields && Array.isArray(rawFields.fields)) {
          const resField = rawFields.fields.find(
            (f) => f && typeof f.name === 'string' && f.name.toLowerCase() === 'resolution',
          );
          if (resField && typeof resField.length === 'number' && resField.length > 0) {
            if (newResolution.length > resField.length) {
              throw new Error(
                `Resolution too long: resulting length ${newResolution.length} exceeds maximum allowed length of ${resField.length}`,
              );
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith('Resolution too long:')) {
          throw err;
        }
      }

      // Read 2: immediate pre-write check to detect concurrent resolution changes
      const ticketRes2 = await api.getById('Tickets', ticketId);
      const ticket2 = unwrapRecord<TicketModel>(ticketRes2);
      const read2Resolution = typeof ticket2.resolution === 'string' ? ticket2.resolution : '';
      if (read2Resolution !== currentResolution) {
        throw new Error(
          'Conflict: ticket resolution was modified concurrently between reads; write refused',
        );
      }

      // Write update
      await api.update('Tickets', { id: Number(ticketId), resolution: newResolution });

      // Read 3: verify written resolution normalizing \r\n
      const ticketRes3 = await api.getById('Tickets', ticketId);
      const ticket3 = unwrapRecord<TicketModel>(ticketRes3);
      const read3Resolution = typeof ticket3.resolution === 'string' ? ticket3.resolution : '';

      if (read3Resolution.replace(/\r\n/g, '\n') !== newResolution.replace(/\r\n/g, '\n')) {
        throw new Error(
          'Verification failed: written resolution does not match read-back resolution',
        );
      }

      return jsonResponse({
        ticketID: Number(ticketId),
        written: true,
        already_present: false,
        appended_line: appendedLine,
        resolution_length_before: currentResolution.length,
        resolution_length_after: read3Resolution.length,
        verified: true,
      });
    },
  },
  {
    name: 'set-ticket-checklist-item',
    title: 'Set Ticket Checklist Item',
    description:
      'Set completion status of a checklist item on an Autotask ticket. ' +
      'DESTRUCTIVE (write): requires confirm token SET_TICKET_CHECKLIST_ITEM. ' +
      'Verifies parent ticket relationship and idempotently no-ops if already in requested state.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'string', description: 'Autotask ticket id' },
        checklistItemID: { type: 'string', description: 'Checklist item id to update' },
        completed: {
          type: 'string',
          description: 'Target completion state ("true" or "false")',
        },
      },
      required: ['ticketID', 'checklistItemID', 'completed'],
    },
    handler: async (args) => {
      const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');
      const itemId = assertSafeNumericId(args.checklistItemID, 'checklistItemID');

      const completedLower = (args.completed || '').trim().toLowerCase();
      if (completedLower !== 'true' && completedLower !== 'false') {
        throw new Error('completed must be "true" or "false"');
      }
      const targetCompleted = completedLower === 'true';

      // Read 1: GET V1.0/Tickets/{ticketId}/ChecklistItems/{itemId}
      const itemRes = await api.request(
        'GET',
        `V1.0/Tickets/${encodeURIComponent(ticketId)}/ChecklistItems/${encodeURIComponent(itemId)}`,
      );
      const item = unwrapRecord<TicketChecklistItemModel>(itemRes);

      if (!item || Object.keys(item).length === 0) {
        throw new Error(`Checklist item ${itemId} not found on ticket ${ticketId}`);
      }

      if (
        item.ticketID === undefined ||
        item.ticketID === null ||
        String(item.ticketID) !== ticketId
      ) {
        throw new Error(
          `Parent mismatch: checklist item ${itemId} belongs to ticketID ${item.ticketID}, not ${ticketId}; write refused`,
        );
      }

      const currentCompleted = Boolean(item.isCompleted);
      const safeItemName = maskSecretTokens(String(item.itemName ?? '')).slice(0, 120);

      // No-op if already in requested state
      if (currentCompleted === targetCompleted) {
        return jsonResponse({
          ticketID: Number(ticketId),
          checklistItemID: Number(itemId),
          isCompleted: targetCompleted,
          position: item.position ?? null,
          completedDateTime: item.completedDateTime ?? null,
          completedByResourceID: item.completedByResourceID ?? null,
          itemName: safeItemName,
          already_in_state: true,
          updated: false,
        });
      }

      // Write update: PATCH /V1.0/Tickets/{t}/ChecklistItems with {id, isCompleted} only
      await api.update(
        'TicketChecklistItems',
        { id: Number(itemId), isCompleted: targetCompleted },
        'Tickets',
        ticketId,
      );

      // Read-back verification
      const verifyRes = await api.request(
        'GET',
        `V1.0/Tickets/${encodeURIComponent(ticketId)}/ChecklistItems/${encodeURIComponent(itemId)}`,
      );
      const verifyItem = unwrapRecord<TicketChecklistItemModel>(verifyRes);

      if (!verifyItem || Boolean(verifyItem.isCompleted) !== targetCompleted) {
        throw new Error(
          `Verification failed: checklist item ${itemId} isCompleted did not match requested state ${targetCompleted}`,
        );
      }

      const updatedItemName = maskSecretTokens(
        String(verifyItem.itemName ?? item.itemName ?? ''),
      ).slice(0, 120);

      return jsonResponse({
        ticketID: Number(ticketId),
        checklistItemID: Number(itemId),
        isCompleted: targetCompleted,
        position: verifyItem.position ?? item.position ?? null,
        completedDateTime: verifyItem.completedDateTime ?? null,
        completedByResourceID: verifyItem.completedByResourceID ?? null,
        itemName: updatedItemName,
        already_in_state: false,
        updated: true,
      });
    },
  },
];
