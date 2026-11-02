import crypto from 'node:crypto';
import type { ToolDefinition, ToolResponse } from '../types.js';
import { api } from '../autotask-api.js';
import { resolveActorOrThrow } from '../auth/context.js';
import { assertSafeNumericId } from '../security.js';
import { jsonResponse } from './shared.js';
import {
  TicketCoordinatorSession,
  withTicketOperation,
} from '../provisioning/ticket-coordinator.js';
import { getOperationStore } from '../provisioning/operation-store.js';
import {
  getRequirementsStore,
  computeItemSemanticFingerprint,
  type ChecklistTaskRequirement,
} from '../provisioning/requirements.js';
import { computeBodyDigest } from '../provisioning/dispatch.js';
import type {
  ResolutionAppendReceipt,
  EvidenceNoteReceipt,
  ChecklistSetReceipt,
  ArchiveReceipt,
} from '../provisioning/contracts.js';
import { DriveArchiveProvider } from '../archive/drive.js';
import { assertAuthorizedArchiveBinding } from '../archive/bindings.js';

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
    const rec = raw as Record<string, unknown>;
    if ('item' in rec && rec.item && typeof rec.item === 'object') {
      return rec.item as T;
    }
    return rec as T;
  }
  return {} as T;
}

export const SECRET_PATTERN =
  /password|passwd|passphrase|pre-?shared|\bpsk\b|\bpin\b\s*[:=]|LPA:1\$/i;

export const CONCURRENCY_NOTICE =
  'LIMITATION: Autotask PATCH /V1.0/Tickets does not provide native atomic compare-and-swap (CAS). ' +
  'Cooperating appenders serialize via a durable coordinator lease and sticky dispatch barrier. ' +
  'External uncoordinated writes to Autotask directly can still cause conflicts.';

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
 * Find if a resolution line already records this logical operation.
 */
export function findMatchingResolutionLine(
  currentResolution: string,
  targetText: string,
  operationId: string,
  ticketId?: string,
): string | null {
  if (!currentResolution) return null;
  const lines = currentResolution.split(/\r?\n/);
  const cleanTarget = targetText.trim();
  const cleanOpId = operationId.trim();

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const opMatch = trimmedLine.match(/\[.*?,\s*op:([^\s,\]]+).*?\]$/);
    const lineOpId = opMatch ? opMatch[1] : null;

    const textMatch = trimmedLine.match(
      /^(.*?)\s*\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC[^\]]*\]$/,
    );
    const lineLogicalText = textMatch ? textMatch[1].trim() : trimmedLine;

    if (lineOpId === cleanOpId) {
      if (lineLogicalText !== cleanTarget) {
        throw new Error(
          `Conflict: operationId "${cleanOpId}" was previously recorded with different text on ticket ${
            ticketId ?? ''
          }: "${lineLogicalText}" vs requested "${cleanTarget}"`,
        );
      }
      return trimmedLine;
    }
  }
  return null;
}

export async function recordTicketEvidenceHandler(args: {
  ticketID: string;
  title: string;
  description: string;
  operationId: string;
  noteType?: string | number;
  publish?: string | number;
}): Promise<ToolResponse> {
  const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');
  const opId = String(args.operationId || '').trim();

  if (!opId) {
    throw new Error('operationId is required for evidence recording');
  }

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

  const actor = resolveActorOrThrow();
  const noteType = args.noteType !== undefined && args.noteType !== '' ? Number(args.noteType) : 1;
  const publish = args.publish !== undefined && args.publish !== '' ? Number(args.publish) : 1;

  return withTicketOperation(
    {
      ticketId,
      actor,
      operationId: opId,
      kind: 'evidence_note',
      payload: {
        ticketID: ticketId,
        title: args.title.trim(),
        description: args.description.trim(),
        noteType,
        publish,
      },
    },
    async (session) => {
      const op = session.getOperation();
      if (op?.phase === 'verified') {
        return jsonResponse(
          op.receipt ?? { ticketID: Number(ticketId), status: 'verified', operationId: opId },
        );
      }

      // Verify parent ticket exists
      const ticketRes = await api.getById('Tickets', ticketId);
      const ticket = unwrapRecord<TicketModel>(ticketRes);
      if (!ticket || Object.keys(ticket).length === 0) {
        throw new Error(`Ticket ${ticketId} not found`);
      }

      // Follow complete pagination chain with envelope validation
      const matchingNotes: Array<Record<string, unknown>> = [];
      const originalQuery = {
        filter: [{ op: 'eq', field: 'ticketID', value: Number(ticketId) }],
        MaxRecords: 100,
      };

      let pageResult: unknown;
      try {
        pageResult = await api.query('TicketNotes', originalQuery);
      } catch (err) {
        throw new Error(`Incomplete note scan on ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      const visitedUrls = new Set<string>();

      while (pageResult && typeof pageResult === 'object') {
        const pageRec = pageResult as {
          items?: unknown;
          pageDetails?: { nextPageUrl?: string };
        };

        if (!Array.isArray(pageRec.items)) {
          throw new Error(`Incomplete note scan on ticket ${ticketId}: malformed items envelope`);
        }

        for (const rawNote of pageRec.items) {
          if (!rawNote || typeof rawNote !== 'object') continue;
          const note = rawNote as Record<string, unknown>;
          const noteDesc = typeof note.description === 'string' ? note.description : '';
          const noteTitle = typeof note.title === 'string' ? note.title : '';
          const match =
            noteDesc.match(/\[op:([^\s,\]]+)\]/) || noteTitle.match(/\[op:([^\s,\]]+)\]/);
          if (match && match[1] === opId) {
            matchingNotes.push(note);
          }
        }

        const nextUrl = pageRec.pageDetails?.nextPageUrl;
        if (nextUrl) {
          if (visitedUrls.has(nextUrl)) {
            throw new Error(`Cycle detected in note pagination for ticket ${ticketId}`);
          }
          visitedUrls.add(nextUrl);
          try {
            pageResult = await api.getPage(nextUrl, originalQuery);
          } catch (err) {
            throw new Error(`Incomplete note scan on continuation page: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          break;
        }
      }

      if (matchingNotes.length > 1) {
        throw new Error(
          `Conflict: multiple notes on ticket ${ticketId} match operationId "${opId}"; evidence is ambiguous`,
        );
      }

      if (matchingNotes.length === 1) {
        const note = matchingNotes[0];
        const noteDesc = typeof note.description === 'string' ? note.description : '';
        const logicalDesc = noteDesc.replace(/\n?\[op:[^\]]+\]/, '').trim();
        if (logicalDesc !== args.description.trim()) {
          throw new Error(
            `Conflict: operationId "${opId}" was previously recorded with different description on ticket ${ticketId}`,
          );
        }

        const markerCount = (noteDesc.match(new RegExp(`\\[op:${opId}\\]`, 'g')) || []).length;
        if (markerCount !== 1) {
          throw new Error(`Conflict: note contains multiple marker occurrences for operation "${opId}"`);
        }

        const receipt: EvidenceNoteReceipt = {
          ticketID: Number(ticketId),
          noteID: Number(note.id),
          title: typeof note.title === 'string' ? note.title : args.title,
          operationId: opId,
          status: 'verified',
          kind: 'evidence_note',
          created: false,
          already_present: true,
          contentHash: crypto.createHash('sha256').update(noteDesc).digest('hex'),
          noteType: Number(note.noteType ?? noteType),
          publish: Number(note.publish ?? publish),
          markerCount,
          attribution: actor.email,
          observedAt: new Date().toISOString(),
        };
        await session.markVerified(receipt);
        return jsonResponse(receipt);
      }

      // If in recovery mode and note was not verified, DO NOT send a POST!
      const isRecovery = session.getClaim()?.mode === 'reconciling';
      if (isRecovery) {
        throw new Error(
          `Conflict: operation "${opId}" has an uncertain dispatch and note was not verified in Autotask; read-only reconciliation required`,
        );
      }

      const finalDescription = `${args.description}\n[op:${opId}]`;
      const body: Record<string, unknown> = {
        ticketID: Number(ticketId),
        title: args.title,
        description: finalDescription,
        noteType,
        publish,
      };

      // Commit preparation before arming
      await session.commitPreparation({
        frozenDescription: finalDescription,
        title: args.title.trim(),
        noteType,
        publish,
        expectedAttribution: actor.email,
      });

      const noteRoute = `V1.0/Tickets/${ticketId}/Notes`;
      const armRes = await session.armDispatch({
        provider: 'autotask',
        canonicalRoute: noteRoute,
        method: 'POST',
        exactBodyDigest: computeBodyDigest(body),
      });

      let createdRes: unknown;
      try {
        createdRes = await api.singleDispatchMutation(
          'POST',
          noteRoute,
          body,
          { permitToken: armRes.permitToken },
        );
      } catch (err: unknown) {
        if (session.isArmed()) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await session.markUncertain(errMsg);
        }
        throw err;
      }

      const createdRec = (createdRes as Record<string, unknown>) || {};
      const itemSub = createdRec.item && typeof createdRec.item === 'object'
        ? (createdRec.item as Record<string, unknown>)
        : undefined;
      const createdId = createdRec.itemId ?? createdRec.id ?? itemSub?.id;

      if (!createdId) {
        throw new Error('Failed to create evidence note: no ID returned from Autotask');
      }

      // Authoritative readback verification
      const verifyRes = await api.request(
        'GET',
        `V1.0/Tickets/${encodeURIComponent(ticketId)}/Notes/${encodeURIComponent(String(createdId))}`,
      );
      const verifiedNote = unwrapRecord<Record<string, unknown>>(verifyRes);
      if (!verifiedNote || Object.keys(verifiedNote).length === 0) {
        throw new Error(`Verification failed: created note ${createdId} not found on ticket ${ticketId}`);
      }

      if (
        String(verifiedNote.id) !== String(createdId) ||
        String(verifiedNote.ticketID) !== ticketId
      ) {
        throw new Error(
          `Verification failed: readback note id/ticketID mismatch for note ${createdId}`,
        );
      }

      const verifiedDesc =
        typeof verifiedNote.description === 'string' ? verifiedNote.description : '';
      if (!verifiedDesc.includes(`[op:${opId}]`)) {
        throw new Error(`Verification failed: readback note missing operation marker [op:${opId}]`);
      }

      const markerCount = (verifiedDesc.match(new RegExp(`\\[op:${opId}\\]`, 'g')) || []).length;
      if (markerCount !== 1) {
        throw new Error(`Verification failed: note has invalid marker multiplicity (${markerCount})`);
      }

      const receipt: EvidenceNoteReceipt = {
        ticketID: Number(ticketId),
        noteID: Number(createdId),
        title: args.title,
        operationId: opId,
        status: 'verified',
        kind: 'evidence_note',
        created: true,
        already_present: false,
        contentHash: crypto.createHash('sha256').update(verifiedDesc).digest('hex'),
        noteType,
        publish,
        markerCount,
        attribution: actor.email,
        observedAt: new Date().toISOString(),
      };

      await session.markVerified(receipt);
      return jsonResponse(receipt);
    },
  );
}

export const ticketWriteTools: ToolDefinition[] = [
  {
    name: 'append-ticket-resolution',
    title: 'Append Ticket Resolution',
    description:
      'Append a timestamped line to a ticket resolution without rewriting existing text. ' +
      'DESTRUCTIVE (write): requires confirm token APPEND_TICKET_RESOLUTION. ' +
      'Refuses secret-looking text (passwords, PINs, PSKs, LPA activation codes) and concurrent edits. ' +
      'Coordinates mutations via a durable coordinator lease and sticky dispatch barrier.',
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
        operationId: {
          type: 'string',
          description:
            'Stable operation identifier for idempotent retries and durable dispatch coordination across clock changes',
        },
        expectedResolutionSha256: {
          type: 'string',
          description: 'Optional SHA256 hex of current resolution text as a concurrency guard',
        },
      },
      required: ['ticketID', 'text', 'operationId'],
    },
    handler: async (args) => {
      const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');
      const opId = String(args.operationId || '').trim();

      if (!opId) {
        throw new Error('operationId is required for append-ticket-resolution');
      }

      if (!args.text || args.text.length < 1 || args.text.length > 2000) {
        throw new Error('Resolution text must be between 1 and 2000 characters');
      }

      if (SECRET_PATTERN.test(args.text)) {
        throw new Error('Refused: resolution text contains sensitive credential pattern');
      }

      const actor = resolveActorOrThrow();

      return withTicketOperation(
        {
          ticketId,
          actor,
          operationId: opId,
          kind: 'resolution_append',
          payload: {
            ticketID: ticketId,
            text: args.text.trim(),
            expectedResolutionSha256: args.expectedResolutionSha256 ?? null,
          },
        },
        async (session) => {
          const op = session.getOperation();
          if (op?.phase === 'verified') {
            const priorLine = (op.receipt as ResolutionAppendReceipt)?.appended_line || args.text;
            return jsonResponse({
              ticketID: Number(ticketId),
              operationId: opId,
              status: 'verified',
              written: false,
              already_present: true,
              reconciled_from_prior_evidence: true,
              appended_line: priorLine,
              concurrency_notice: CONCURRENCY_NOTICE,
              verified: true,
            });
          }

          // Read 1: check ticket and expectedResolutionSha256
          const ticketRes1 = await api.getById('Tickets', ticketId);
          const ticket1 = unwrapRecord<TicketModel>(ticketRes1);
          if (!ticket1 || Object.keys(ticket1).length === 0) {
            throw new Error(`Ticket ${ticketId} not found`);
          }

          const currentResolution = typeof ticket1.resolution === 'string' ? ticket1.resolution : '';
          const currentSha = crypto.createHash('sha256').update(currentResolution).digest('hex');

          // Check if exact line or logical operation is already present
          const priorLine = findMatchingResolutionLine(
            currentResolution,
            args.text,
            opId,
            ticketId,
          );

          if (priorLine) {
            const prepared = op?.preparedState;
            if (prepared?.observedResolutionBefore !== undefined) {
              const expectedPrefix = String(prepared.observedResolutionBefore);
              if (!currentResolution.startsWith(expectedPrefix)) {
                throw new Error(
                  `Conflict: operation "${opId}" marker exists but original resolution prefix was destroyed; reconciliation refused`,
                );
              }
            }

            const markerCount = (currentResolution.match(new RegExp(`\\[op:${opId}\\]`, 'g')) || []).length;
            if (markerCount !== 1) {
              throw new Error(`Conflict: resolution contains multiple markers for operation "${opId}"`);
            }

            const receipt: ResolutionAppendReceipt = {
              ticketID: Number(ticketId),
              operationId: opId,
              status: 'verified',
              kind: 'resolution_append',
              written: false,
              already_present: true,
              originalPrefixSha256: currentSha,
              appended_line: priorLine,
              resolution_length_before: currentResolution.length,
              resolution_length_after: currentResolution.length,
              markerCount,
              observedAt: new Date().toISOString(),
            };
            await session.markVerified(receipt);
            return jsonResponse({
              ...receipt,
              reconciled_from_prior_evidence: true,
              concurrency_notice: CONCURRENCY_NOTICE,
              verified: true,
            });
          }

          // If in recovery but priorLine was NOT found, do NOT redispatch! Must remain uncertain
          const isRecovery = session.getClaim()?.mode === 'reconciling';
          if (isRecovery) {
            throw new Error(
              `Conflict: operation "${opId}" has an uncertain dispatch and line was not verified in Autotask; read-only reconciliation required`,
            );
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
          const appendedLine = `${args.text} [${timestamp}, ${actor.email}, op:${opId}]`;

          const newResolution =
            currentResolution.length === 0
              ? appendedLine
              : currentResolution.endsWith('\n')
                ? `${currentResolution}${appendedLine}`
                : `${currentResolution}\n${appendedLine}`;

          // Save prepared state transactionally before arming
          await session.commitPreparation({
            observedResolutionBefore: currentResolution,
            originalPrefixSha256: currentSha,
            frozenTimestamp: timestamp,
            appendedLine,
            composedResolution: newResolution,
          });

          // Pre-write concurrency read
          const ticketRes2 = await api.getById('Tickets', ticketId);
          const ticket2 = unwrapRecord<TicketModel>(ticketRes2);
          const read2Resolution = typeof ticket2.resolution === 'string' ? ticket2.resolution : '';
          if (read2Resolution !== currentResolution) {
            throw new Error(
              'Conflict: ticket resolution was modified concurrently between reads; write refused',
            );
          }

          const patchRoute = 'V1.0/Tickets';
          const patchBody = { id: Number(ticketId), resolution: newResolution };
          const armRes = await session.armDispatch({
            provider: 'autotask',
            canonicalRoute: patchRoute,
            method: 'PATCH',
            exactBodyDigest: computeBodyDigest(patchBody),
          });

          try {
            await api.singleDispatchMutation(
              'PATCH',
              patchRoute,
              patchBody,
              { permitToken: armRes.permitToken },
            );
          } catch (err: unknown) {
            if (session.isArmed()) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await session.markUncertain(errMsg);
            }
            throw err;
          }

          // Authoritative readback
          const verifyTicketRes = await api.getById('Tickets', ticketId);
          const verifyTicket = unwrapRecord<TicketModel>(verifyTicketRes);
          const finalRes = typeof verifyTicket.resolution === 'string' ? verifyTicket.resolution : '';
          if (!finalRes.includes(`[op:${opId}]`)) {
            throw new Error(`Verification failed: resolution missing operation marker [op:${opId}]`);
          }

          const receipt: ResolutionAppendReceipt = {
            ticketID: Number(ticketId),
            operationId: opId,
            status: 'verified',
            kind: 'resolution_append',
            written: true,
            already_present: false,
            originalPrefixSha256: currentSha,
            appended_line: appendedLine,
            resolution_length_before: currentResolution.length,
            resolution_length_after: finalRes.length,
            markerCount: 1,
            observedAt: new Date().toISOString(),
          };

          await session.markVerified(receipt);
          return jsonResponse({
            ...receipt,
            concurrency_notice: CONCURRENCY_NOTICE,
            verified: true,
          });
        },
      );
    },
  },
  {
    name: 'record-ticket-evidence',
    title: 'Record Ticket Evidence',
    description:
      'Record evidence note on an Autotask ticket with durable operationId coordination. ' +
      'Guarantees idempotent single-dispatch execution and verified readback.',
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
        title: { type: 'string', description: 'Note title (1..250 chars)' },
        description: { type: 'string', description: 'Note body text' },
        operationId: {
          type: 'string',
          description: 'Stable operation identifier for idempotent retries',
        },
        noteType: { type: 'string', description: 'Optional numeric note type code (default 1)' },
        publish: { type: 'string', description: 'Optional numeric publish code (default 1)' },
      },
      required: ['ticketID', 'title', 'description', 'operationId'],
    },
    handler: async (args) => {
      return recordTicketEvidenceHandler({
        ticketID: args.ticketID,
        title: args.title,
        description: args.description,
        operationId: args.operationId,
        noteType: args.noteType,
        publish: args.publish,
      });
    },
  },
  {
    name: 'set-ticket-checklist-item',
    title: 'Set Ticket Checklist Item',
    description:
      'Mark a ticket checklist item completed or uncompleted. ' +
      'DESTRUCTIVE (write): requires confirm token SET_TICKET_CHECKLIST_ITEM. ' +
      'Completion requires verified evidence (evidenceOperationId) and an enabled server-owned checklist requirement.',
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
        completed: { type: 'string', description: 'Target state: "true" for completed, "false" for uncompleted' },
        isCompleted: { type: 'string', description: 'Alias for completed' },
        operationId: { type: 'string', description: 'Stable operation identifier' },
        evidenceOperationId: {
          type: 'string',
          description: 'OperationId of verified evidence required for completion',
        },
        evidenceNoteID: {
          type: 'string',
          description: 'Obsolete: raw evidence note ID is removed. Use evidenceOperationId.',
        },
      },
      required: ['ticketID', 'checklistItemID', 'operationId'],
    },
    handler: async (args) => {
      if (args.evidenceNoteID) {
        throw new Error(
          'Obsolete argument: evidenceNoteID is removed; supply evidenceOperationId referencing a verified operation.',
        );
      }

      const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');
      const itemId = assertSafeNumericId(args.checklistItemID, 'checklistItemID');
      const opId = String(args.operationId || '').trim();

      if (!opId) {
        throw new Error('operationId is required for checklist operations');
      }

      const rawCompleted = args.completed !== undefined ? args.completed : args.isCompleted;
      if (rawCompleted === undefined || rawCompleted === '') {
        throw new Error('completed or isCompleted is required (must be "true" or "false")');
      }

      const targetCompleted =
        typeof rawCompleted === 'boolean'
          ? rawCompleted
          : String(rawCompleted).toLowerCase().trim() === 'true';

      const actor = resolveActorOrThrow();
      let evidenceOpId = '';

      return withTicketOperation(
        {
          ticketId,
          actor,
          operationId: opId,
          kind: 'checklist_set',
          payload: {
            ticketID: ticketId,
            checklistItemID: itemId,
            completed: targetCompleted,
            evidenceOperationId: args.evidenceOperationId ? String(args.evidenceOperationId).trim() : null,
          },
        },
        async (session) => {
          const op = session.getOperation();
          if (op?.phase === 'verified') {
            return jsonResponse(op.receipt ?? { ticketID: Number(ticketId), checklistItemID: Number(itemId), status: 'verified', isCompleted: targetCompleted });
          }

          let req: ChecklistTaskRequirement | null = null;
          if (targetCompleted) {
            if (!args.evidenceOperationId) {
              throw new Error(
                `Refused: checklist item completion requires observed evidence (evidenceOperationId on ticket ${ticketId})`,
              );
            }
            evidenceOpId = String(args.evidenceOperationId).trim();

            // 1. Mandatory server-owned requirement check: MUST exist and be enabled!
            req = await getRequirementsStore().get(session.accountKey, ticketId, itemId);
            if (!req || req.disabled) {
              throw new Error(
                `Refused: checklist item ${itemId} on ticket ${ticketId} has no enabled server-owned requirement configured; completion refused`,
              );
            }

            // 2. Fetch and validate evidence operation
            const evidenceOp = await getOperationStore().getOperation(session.accountKey, evidenceOpId);
            if (!evidenceOp || evidenceOp.phase !== 'verified') {
              throw new Error(
                `Evidence operation "${evidenceOpId}" is not verified (current phase: ${
                  evidenceOp?.phase ?? 'missing'
                }); checklist completion refused`,
              );
            }

            if (evidenceOp.ticketId !== ticketId) {
              throw new Error(
                `Parent mismatch: evidence operation "${evidenceOpId}" belongs to ticket ${evidenceOp.ticketId}, not ${ticketId}; checklist completion refused`,
              );
            }

            if (evidenceOp.kind !== req.requiredKind) {
              throw new Error(
                `Requirement mismatch: checklist item ${itemId} requires operation kind "${req.requiredKind}", but evidence operation "${evidenceOpId}" is "${evidenceOp.kind}"`,
              );
            }

            // 3. Kind-specific evidence verification
            if (req.requiredKind === 'attachment_archive') {
              const archiveReceipt = evidenceOp.receipt as ArchiveReceipt | undefined;
              if (!archiveReceipt || archiveReceipt.status !== 'verified') {
                throw new Error('Evidence operation is missing verified ArchiveReceipt');
              }

              if (req.expectedCompanyId && archiveReceipt.source.companyId !== req.expectedCompanyId) {
                throw new Error(
                  `Requirement mismatch: expected company ${req.expectedCompanyId}, got ${archiveReceipt.source.companyId}`,
                );
              }

              if (req.expectedSourceDigest) {
                if (archiveReceipt.source.sha256.toLowerCase() !== req.expectedSourceDigest.toLowerCase()) {
                  throw new Error(
                    `Requirement mismatch: expected digest ${req.expectedSourceDigest}, got ${archiveReceipt.source.sha256}`,
                  );
                }
              }

              // Re-verify that archived file still exists in Drive and binding is active
              const binding = await assertAuthorizedArchiveBinding({
                accountKey: session.accountKey,
                companyId: archiveReceipt.source.companyId,
                actorResourceId: actor.resourceId,
              });

              const driveProvider = new DriveArchiveProvider();
              await driveProvider.reconcileStoredArchive({
                operationId: evidenceOpId,
                sourceMetadata: archiveReceipt.source,
                binding,
                fileId: archiveReceipt.destination.fileId,
              });
            } else if (req.requiredKind === 'evidence_note') {
              const noteReceipt = evidenceOp.receipt as EvidenceNoteReceipt | undefined;
              if (!noteReceipt || noteReceipt.status !== 'verified') {
                throw new Error('Evidence operation is missing verified EvidenceNoteReceipt');
              }

              // Re-read note to verify it still exists on ticket
              const noteRes = await api.getById('TicketNotes', String(noteReceipt.noteID));
              const noteData = unwrapRecord<Record<string, unknown>>(noteRes);
              if (!noteData || Object.keys(noteData).length === 0 || String(noteData.ticketID) !== ticketId) {
                throw new Error(`Evidence note ${noteReceipt.noteID} is no longer present on ticket ${ticketId}`);
              }
            }
          }

          // Read current item state from Autotask
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
          const semanticFingerprint = computeItemSemanticFingerprint(ticketId, itemId, safeItemName);

          if (req && req.semanticFingerprint && req.semanticFingerprint !== semanticFingerprint) {
            throw new Error(
              `Requirement mismatch: checklist item ${itemId} semantic fingerprint mismatch`,
            );
          }

          // Already in target state: observation-only path!
          if (currentCompleted === targetCompleted) {
            const receipt: ChecklistSetReceipt = {
              ticketID: Number(ticketId),
              checklistItemID: Number(itemId),
              operationId: opId,
              status: 'verified',
              kind: 'checklist_set',
              isCompleted: targetCompleted,
              semanticFingerprint,
              requirementVersion: req?.version,
              evidenceOperationId: evidenceOpId || undefined,
              evidenceVerified: Boolean(evidenceOpId),
              mutationSent: false,
              finalityBasis: 'observation_only',
              position: item.position ?? null,
              completedDateTime: item.completedDateTime ?? null,
              completedByResourceID: item.completedByResourceID ?? null,
              itemName: safeItemName,
              already_in_state: true,
              updated: false,
              observedAt: new Date().toISOString(),
            };
            await session.markObservationOnly(receipt);
            return jsonResponse(receipt);
          }

          // Commit preparation before arming dispatch (Fixes finding A1.4 / R.1)
          await session.commitPreparation({
            ticketId,
            checklistItemId: itemId,
            targetCompleted,
            semanticFingerprint,
            requirementVersion: req?.version,
            evidenceOperationId: evidenceOpId || null,
          });

          const patchRoute = `V1.0/Tickets/${ticketId}/ChecklistItems`;
          const patchBody = { id: Number(itemId), isCompleted: targetCompleted };
          const armRes = await session.armDispatch({
            provider: 'autotask',
            canonicalRoute: patchRoute,
            method: 'PATCH',
            exactBodyDigest: computeBodyDigest(patchBody),
          });

          try {
            await api.singleDispatchMutation(
              'PATCH',
              patchRoute,
              patchBody,
              { permitToken: armRes.permitToken },
            );
          } catch (err: unknown) {
            if (session.isArmed()) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await session.markUncertain(errMsg);
            }
            throw err;
          }

          // Authoritative readback verification
          const readbackRes = await api.request(
            'GET',
            `V1.0/Tickets/${encodeURIComponent(ticketId)}/ChecklistItems/${encodeURIComponent(itemId)}`,
          );
          const readbackItem = unwrapRecord<TicketChecklistItemModel>(readbackRes);
          if (Boolean(readbackItem.isCompleted) !== targetCompleted) {
            throw new Error(`Verification failed: checklist item ${itemId} isCompleted is not ${targetCompleted}`);
          }

          const receipt: ChecklistSetReceipt = {
            ticketID: Number(ticketId),
            checklistItemID: Number(itemId),
            operationId: opId,
            status: 'verified',
            kind: 'checklist_set',
            isCompleted: targetCompleted,
            semanticFingerprint,
            requirementVersion: req?.version,
            evidenceOperationId: evidenceOpId || undefined,
            evidenceVerified: Boolean(evidenceOpId),
            mutationSent: true,
            finalityBasis: 'settled_original_mutation',
            position: readbackItem.position ?? null,
            completedDateTime: readbackItem.completedDateTime ?? null,
            completedByResourceID: readbackItem.completedByResourceID ?? null,
            itemName: safeItemName,
            already_in_state: false,
            updated: true,
            observedAt: new Date().toISOString(),
          };

          await session.markVerified(receipt);
          return jsonResponse(receipt);
        },
      );
    },
  },
];
