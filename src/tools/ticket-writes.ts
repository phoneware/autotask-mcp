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

export const CONCURRENCY_NOTICE =
  'LIMITATION: Autotask PATCH /V1.0/Tickets does not provide native atomic compare-and-swap (CAS). ' +
  'Cooperating appenders are serialized via ticket lock in durable/shared storage, but uncoordinated ' +
  'external writes to Autotask directly can still cause conflicts.';

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

/**
 * In-memory / durable coordinating lock to serialize cooperating appenders on a ticket.
 * Prevents race conditions among cooperating agents within the environment.
 */
export class TicketLock {
  private static locks = new Map<
    string,
    { owner: string; expiresAt: number; waiters: Array<() => void> }
  >();

  static async withLock<T>(
    ticketId: string,
    owner: string,
    action: () => Promise<T>,
    timeoutMs = 15000,
  ): Promise<T> {
    const start = Date.now();
    while (true) {
      const now = Date.now();
      const existing = this.locks.get(ticketId);
      if (!existing || existing.expiresAt <= now) {
        this.locks.set(ticketId, { owner, expiresAt: now + timeoutMs, waiters: [] });
        try {
          return await action();
        } finally {
          const current = this.locks.get(ticketId);
          if (current && current.owner === owner) {
            this.locks.delete(ticketId);
            const next = current.waiters.shift();
            if (next) next();
          }
        }
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Conflict: timeout acquiring ticket lock for ticket ${ticketId} (held by ${existing.owner}); write refused`,
        );
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      existing.waiters.push(resolve);
      setTimeout(resolve, 50);
      await promise;
    }
  }

  static isLocked(ticketId: string): boolean {
    const existing = this.locks.get(ticketId);
    if (!existing) return false;
    if (existing.expiresAt <= Date.now()) {
      this.locks.delete(ticketId);
      return false;
    }
    return true;
  }

  static clear(): void {
    this.locks.clear();
  }
}

/**
 * Find if a resolution line already records this logical operation, even if
 * the clock has advanced or a prior attempt recorded a different timestamp.
 */
export function findMatchingResolutionLine(
  currentResolution: string,
  targetText: string,
  operationId?: string,
): string | null {
  if (!currentResolution) return null;
  const lines = currentResolution.split(/\r?\n/);
  const cleanTarget = targetText.trim();
  const cleanOpId = (operationId || '').trim();

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // 1. If operationId is provided, check if line contains op:<opId>
    if (cleanOpId) {
      const opMatch = trimmedLine.match(/\[.*?,\s*op:([^\s,\]]+).*?\]$/);
      if (opMatch && opMatch[1] === cleanOpId) {
        return trimmedLine;
      }
    }

    // 2. Check if line's logical text matches targetText across timestamp/author changes
    const match = trimmedLine.match(/^(.*?)\s*\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC[^\]]*\]$/);
    if (match) {
      const lineLogicalText = match[1].trim();
      if (lineLogicalText === cleanTarget) {
        // If an operationId was given on this call, verify that the line does not carry a different operationId
        if (cleanOpId) {
          const opMatch = trimmedLine.match(/\[.*?,\s*op:([^\s,\]]+).*?\]$/);
          if (opMatch && opMatch[1] !== cleanOpId) {
            continue;
          }
        }
        return trimmedLine;
      }
    }

    // 3. Exact line match without bracketed metadata
    if (trimmedLine === cleanTarget) {
      return trimmedLine;
    }
  }
  return null;
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
        operationId: {
          type: 'string',
          description:
            'Optional stable operation identifier for idempotent retries across clock changes',
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

      const caller = currentCaller();
      const author = caller?.email ?? 'autotask-mcp';
      const opId = (args.operationId || '').trim();

      return TicketLock.withLock(ticketId, author, async () => {
        // Read 1: check ticket and expectedResolutionSha256
        const ticketRes1 = await api.getById('Tickets', ticketId);
        const ticket1 = unwrapRecord<TicketModel>(ticketRes1);
        if (!ticket1 || Object.keys(ticket1).length === 0) {
          throw new Error(`Ticket ${ticketId} not found`);
        }

        const currentResolution = typeof ticket1.resolution === 'string' ? ticket1.resolution : '';
        const currentSha = crypto.createHash('sha256').update(currentResolution).digest('hex');

        // Check if exact line or logical operation is already present before SHA check
        // to ensure clock-advanced retries gracefully reconcile prior evidence.
        const priorLine = findMatchingResolutionLine(currentResolution, args.text, opId);
        if (priorLine) {
          return jsonResponse({
            ticketID: Number(ticketId),
            written: false,
            already_present: true,
            reconciled_from_prior_evidence: true,
            operationId: opId || null,
            appended_line: priorLine,
            resolution_length_before: currentResolution.length,
            resolution_length_after: currentResolution.length,
            concurrency_notice: CONCURRENCY_NOTICE,
            verified: true,
          });
        }

        if (args.expectedResolutionSha256) {
          const expected = args.expectedResolutionSha256.trim().toLowerCase();
          if (expected !== currentSha.toLowerCase()) {
            throw new Error(
              `Conflict: expectedResolutionSha256 mismatch (expected: ${args.expectedResolutionSha256}, actual: ${currentSha})`,
            );
          }
        }

        const timestamp = formatUtcTimestamp();
        const appendedLine = opId
          ? `${args.text} [${timestamp}, ${author}, op:${opId}]`
          : `${args.text} [${timestamp}, ${author}]`;

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
          reconciled_from_prior_evidence: false,
          operationId: opId || null,
          appended_line: appendedLine,
          resolution_length_before: currentResolution.length,
          resolution_length_after: read3Resolution.length,
          concurrency_notice: CONCURRENCY_NOTICE,
          verified: true,
        });
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
        evidenceNoteID: {
          type: 'string',
          description: 'Optional Autotask ticket note ID containing the verification evidence',
        },
        evidenceAttachmentID: {
          type: 'string',
          description:
            'Optional Autotask ticket attachment ID containing the document/verification evidence',
        },
        requireEvidence: {
          type: 'string',
          description:
            'Optional "true" | "false". When "true", completing an item requires observed evidence on the parent ticket',
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
      let evidenceNoteIdNum: number | null = null;
      let evidenceAttachmentIdNum: number | null = null;

      // Validate evidence requirements when marking complete
      if (targetCompleted) {
        const requireEvidence = (args.requireEvidence || '').trim().toLowerCase() === 'true';
        if (requireEvidence && !args.evidenceNoteID && !args.evidenceAttachmentID) {
          throw new Error(
            `Refused: checklist item completion requires observed evidence (evidenceNoteID or evidenceAttachmentID on ticket ${ticketId})`,
          );
        }

        if (args.evidenceNoteID) {
          const evidenceNoteId = assertSafeNumericId(args.evidenceNoteID, 'evidenceNoteID');
          evidenceNoteIdNum = Number(evidenceNoteId);
          const noteRes = await api.getById('TicketNotes', evidenceNoteId);
          const note = unwrapRecord<Record<string, unknown>>(noteRes);
          if (!note || Object.keys(note).length === 0) {
            throw new Error(
              `Evidence note ${evidenceNoteId} not found on ticket ${ticketId}; checklist completion refused`,
            );
          }
          if (
            note.ticketID !== undefined &&
            note.ticketID !== null &&
            String(note.ticketID) !== ticketId
          ) {
            throw new Error(
              `Parent mismatch: evidence note ${evidenceNoteId} belongs to ticketID ${note.ticketID}, not ${ticketId}; checklist completion refused`,
            );
          }
        }

        if (args.evidenceAttachmentID) {
          const evidenceAttachmentId = assertSafeNumericId(
            args.evidenceAttachmentID,
            'evidenceAttachmentID',
          );
          evidenceAttachmentIdNum = Number(evidenceAttachmentId);
          const attRes = await api.request(
            'GET',
            `V1.0/Tickets/${encodeURIComponent(ticketId)}/Attachments/${encodeURIComponent(evidenceAttachmentId)}`,
          );
          const att = unwrapRecord<Record<string, unknown>>(attRes);
          if (!att || Object.keys(att).length === 0) {
            throw new Error(
              `Evidence attachment ${evidenceAttachmentId} not found on ticket ${ticketId}; checklist completion refused`,
            );
          }
          if (
            att.ticketID !== undefined &&
            att.ticketID !== null &&
            String(att.ticketID) !== ticketId
          ) {
            throw new Error(
              `Parent mismatch: evidence attachment ${evidenceAttachmentId} belongs to ticketID ${att.ticketID}, not ${ticketId}; checklist completion refused`,
            );
          }
        }
      }
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
          evidenceVerified: Boolean(evidenceNoteIdNum || evidenceAttachmentIdNum),
          evidenceNoteID: evidenceNoteIdNum,
          evidenceAttachmentID: evidenceAttachmentIdNum,
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
        evidenceVerified: Boolean(evidenceNoteIdNum || evidenceAttachmentIdNum),
        evidenceNoteID: evidenceNoteIdNum,
        evidenceAttachmentID: evidenceAttachmentIdNum,
      });
    },
  },
  {
    name: 'record-ticket-evidence',
    title: 'Record Ticket Evidence',
    description:
      'Record immutable verification evidence on an Autotask ticket as a TicketNote. ' +
      'DESTRUCTIVE (write): requires confirm token RECORD_TICKET_EVIDENCE. ' +
      'Idempotent across retries: uses operationId or logical content to reconcile prior evidence and prevent duplicate notes.',
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
        title: { type: 'string', description: 'Evidence note title' },
        description: { type: 'string', description: 'Evidence note content (1..32000 characters)' },
        operationId: {
          type: 'string',
          description:
            'Stable operation identity for idempotent retry deduplication across clock changes',
        },
        noteType: {
          type: 'string',
          description: 'Optional numeric note type picklist code (default 1)',
        },
        publish: {
          type: 'string',
          description: 'Optional publish code: 1 = internal (default), 2 = all users',
        },
      },
      required: ['ticketID', 'title', 'description'],
    },
    handler: async (args) => {
      const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');

      if (!args.title || args.title.trim().length === 0 || args.title.length > 250) {
        throw new Error('Evidence note title must be between 1 and 250 characters');
      }

      if (
        !args.description ||
        args.description.trim().length === 0 ||
        args.description.length > 32000
      ) {
        throw new Error('Evidence note description must be between 1 and 32000 characters');
      }

      if (SECRET_PATTERN.test(args.title) || SECRET_PATTERN.test(args.description)) {
        throw new Error('Refused: evidence note contains sensitive credential pattern');
      }

      // Check ticket exists
      const ticketRes = await api.getById('Tickets', ticketId);
      const ticket = unwrapRecord<TicketModel>(ticketRes);
      if (!ticket || Object.keys(ticket).length === 0) {
        throw new Error(`Ticket ${ticketId} not found`);
      }

      const opId = (args.operationId || '').trim();

      // Check existing notes on ticket to reconcile prior evidence
      let existingNotes: Array<Record<string, unknown>> = [];
      try {
        const queryRes = (await api.query('TicketNotes', {
          filter: [{ op: 'eq', field: 'ticketID', value: Number(ticketId) }],
          MaxRecords: 100,
        })) as { items?: Array<Record<string, unknown>> };
        if (queryRes && Array.isArray(queryRes.items)) {
          existingNotes = queryRes.items;
        }
      } catch {
        // Proceed to creation if query returns empty or fails
      }

      for (const note of existingNotes) {
        const noteDesc = typeof note.description === 'string' ? note.description : '';
        const noteTitle = typeof note.title === 'string' ? note.title : '';

        if (opId) {
          if (noteDesc.includes(`[op:${opId}]`) || noteTitle.includes(`[op:${opId}]`)) {
            return jsonResponse({
              ticketID: Number(ticketId),
              noteID: Number(note.id),
              title: noteTitle,
              created: false,
              already_present: true,
              reconciled_from_prior_evidence: true,
              operationId: opId,
              verified: true,
            });
          }
        } else if (
          noteTitle.trim() === args.title.trim() &&
          noteDesc.trim() === args.description.trim()
        ) {
          return jsonResponse({
            ticketID: Number(ticketId),
            noteID: Number(note.id),
            title: noteTitle,
            created: false,
            already_present: true,
            reconciled_from_prior_evidence: true,
            operationId: null,
            verified: true,
          });
        }
      }

      const finalDescription = opId ? `${args.description}\n[op:${opId}]` : args.description;
      const noteType = args.noteType ? Number(args.noteType) : 1;
      const publish = args.publish ? Number(args.publish) : 1;

      const body: Record<string, unknown> = {
        ticketID: Number(ticketId),
        title: args.title,
        description: finalDescription,
        noteType,
        publish,
      };

      const createdRes = (await api.create(`Tickets/${ticketId}/Notes`, body)) as {
        id?: number | string;
        item?: { id?: number | string };
      };
      const createdId = createdRes?.item?.id ?? createdRes?.id;

      if (!createdId) {
        throw new Error('Failed to create evidence note: no ID returned from Autotask');
      }

      return jsonResponse({
        ticketID: Number(ticketId),
        noteID: Number(createdId),
        title: args.title,
        created: true,
        already_present: false,
        reconciled_from_prior_evidence: false,
        operationId: opId || null,
        verified: true,
      });
    },
  },
];
