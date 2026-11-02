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
import { getOperationStore, operationKey } from '../provisioning/operation-store.js';
import {
  getRequirementsStore,
  computeItemSemanticFingerprint,
  requirementDocId,
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
import { assertAuthorizedArchiveBinding, bindingDocId } from '../archive/bindings.js';

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
 * Count occurrences of an operationId marker in resolution text.
 * Matches unified format [op:id], composite [..., op:id], or (op:id).
 */
export function countResolutionMarkers(resolution: string, operationId: string): number {
  if (!resolution) return 0;
  const cleanOpId = operationId.trim();
  const escaped = cleanOpId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `(?:\\[op:${escaped}\\]|\\[[^\\]]*?[,\\s]op:${escaped}[^\\]]*?\\]|\\(op:${escaped}\\))`,
    'g',
  );
  return (resolution.match(regex) || []).length;
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
  const cleanOpId = operationId.trim();
  const cleanTarget = targetText.trim();
  const lines = currentResolution.split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    if (countResolutionMarkers(trimmedLine, cleanOpId) > 0) {
      if (!trimmedLine.startsWith(cleanTarget)) {
        throw new Error(
          `Conflict: operationId "${cleanOpId}" was previously recorded with different text on ticket ${
            ticketId ?? ''
          }: "${trimmedLine}" vs requested "${cleanTarget}"`,
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
  const effectiveZoneUrl = await api.getEffectiveZoneUrl();

  return withTicketOperation(
    {
      ticketId,
      actor,
      operationId: opId,
      kind: 'evidence_note',
      effectiveZoneUrl,
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
          op.receipt ?? {
            ticketID: Number(ticketId),
            noteID: 0,
            title: args.title.trim(),
            status: 'verified',
            kind: 'evidence_note',
            operationId: opId,
            created: false,
            already_present: true,
            attribution: actor.email,
            observedAt: new Date().toISOString(),
          },
        );
      }

      const noteRoute = `V1.0/Tickets/${ticketId}/Notes`;
      await api.preflightMutationPrerequisites(noteRoute);

      // Verify parent ticket exists
      const ticketRes = await api.getById('Tickets', ticketId);
      const ticket = unwrapRecord<TicketModel>(ticketRes);
      if (!ticket || Object.keys(ticket).length === 0) {
        throw new Error(`Ticket ${ticketId} not found`);
      }

      // Unique server-generated frozen dispatch nonce
      const existingPrepared = op?.preparedState;
      const dispatchNonce = (existingPrepared?.dispatchNonce as string) || crypto.randomUUID();
      const expectedMarker = `[op:${opId}:d:${dispatchNonce}]`;

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
        throw new Error(
          `Incomplete note scan on ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
        );
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
          if (noteDesc.includes(expectedMarker) || noteTitle.includes(expectedMarker)) {
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
            pageResult = await api.getPage(nextUrl, originalQuery, 'TicketNotes');
          } catch (err) {
            throw new Error(
              `Incomplete note scan on continuation page: ${err instanceof Error ? err.message : String(err)}`,
            );
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
        const markerCount = noteDesc.split(expectedMarker).length - 1;
        if (markerCount !== 1) {
          throw new Error(`Conflict: note contains multiple marker occurrences for operation "${opId}"`);
        }

        if (String(note.ticketID) !== ticketId) {
          throw new Error(`Conflict: note ticketID mismatch (${note.ticketID} vs ${ticketId})`);
        }

        const expectedTitle = args.title.trim();
        if (typeof note.title === 'string' && note.title.trim() !== expectedTitle) {
          throw new Error(`Conflict: operationId "${opId}" was previously recorded with different title`);
        }

        const expectedDesc = `${args.description.trim()}\n${expectedMarker}`;
        if (noteDesc.trim() !== expectedDesc.trim()) {
          throw new Error(
            `Conflict: operationId "${opId}" was previously recorded with different description on ticket ${ticketId}`,
          );
        }

        if (note.noteType !== undefined && Number(note.noteType) !== noteType) {
          throw new Error(`Conflict: operationId "${opId}" was previously recorded with different noteType`);
        }

        if (note.publish !== undefined && Number(note.publish) !== publish) {
          throw new Error(`Conflict: operationId "${opId}" was previously recorded with different publish setting`);
        }

        const observedAttribution = String(
          note.creatorResourceID ?? note.createdByResourceID ?? note.createdBy ?? actor.email,
        );

        const receipt: EvidenceNoteReceipt = {
          ticketID: Number(ticketId),
          noteID: Number(note.id),
          title: expectedTitle,
          operationId: opId,
          status: 'verified',
          kind: 'evidence_note',
          created: false,
          already_present: true,
          contentHash: crypto.createHash('sha256').update(noteDesc).digest('hex'),
          noteType: Number(note.noteType ?? noteType),
          publish: Number(note.publish ?? publish),
          markerCount: 1,
          attribution: observedAttribution,
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

      const finalDescription = `${args.description.trim()}\n${expectedMarker}`;
      const expectedTitle = args.title.trim();
      const body: Record<string, unknown> = {
        ticketID: Number(ticketId),
        title: expectedTitle,
        description: finalDescription,
        noteType,
        publish,
      };
      const exactBodyDigest = computeBodyDigest(body);

      // Commit preparation before arming
      await session.commitPreparation(
        {
          frozenDescription: finalDescription,
          title: expectedTitle,
          noteType,
          publish,
          dispatchNonce,
          expectedAttribution: actor.email,
        },
        {
          provider: 'autotask',
          canonicalRoute: noteRoute,
          method: 'POST',
          dispatchNonce,
          target: ticketId,
          exactBodyDigest,
          preparedSha256: exactBodyDigest,
          frozenParameters: { ...body },
        },
      );

      const armRes = await session.armDispatch({
        provider: 'autotask',
        canonicalRoute: noteRoute,
        method: 'POST',
        exactBodyDigest,
      });

      if (!armRes.permitToken) {
        throw new Error('Refused: failed to acquire dispatch permit token for note creation');
      }

      let createdRes: unknown;
      try {
        createdRes = await api.singleDispatchMutation('POST', noteRoute, body, {
          permitToken: armRes.permitToken,
        });
      } catch (err: unknown) {
        if (session.isArmed()) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await session.markUncertain(errMsg);
        }
        throw err;
      }

      const createdRec = (createdRes as Record<string, unknown>) || {};
      const itemSub =
        createdRec.item && typeof createdRec.item === 'object'
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
        throw new Error(
          `Verification failed: created note ${createdId} not found on ticket ${ticketId}`,
        );
      }

      if (
        String(verifiedNote.id) !== String(createdId) ||
        String(verifiedNote.ticketID) !== ticketId
      ) {
        throw new Error(
          `Verification failed: readback note id/ticketID mismatch for note ${createdId}`,
        );
      }

      const verifiedTitle =
        typeof verifiedNote.title === 'string' ? verifiedNote.title.trim() : '';
      if (verifiedTitle !== expectedTitle) {
        throw new Error(
          `Verification failed: readback note title mismatch ("${verifiedTitle}" vs "${expectedTitle}")`,
        );
      }

      const verifiedDesc =
        typeof verifiedNote.description === 'string' ? verifiedNote.description : '';
      if (!verifiedDesc.includes(expectedMarker)) {
        throw new Error(
          `Verification failed: readback note missing operation marker ${expectedMarker}`,
        );
      }

      const markerCount = verifiedDesc.split(expectedMarker).length - 1;
      if (markerCount !== 1) {
        throw new Error(`Verification failed: note has invalid marker multiplicity (${markerCount})`);
      }

      if (verifiedNote.noteType !== undefined && Number(verifiedNote.noteType) !== noteType) {
        throw new Error('Verification failed: readback note noteType mismatch');
      }

      if (verifiedNote.publish !== undefined && Number(verifiedNote.publish) !== publish) {
        throw new Error('Verification failed: readback note publish mismatch');
      }

      const observedAttribution = String(
        verifiedNote.creatorResourceID ??
          verifiedNote.createdByResourceID ??
          verifiedNote.createdBy ??
          actor.email,
      );

      const receipt: EvidenceNoteReceipt = {
        ticketID: Number(ticketId),
        noteID: Number(createdId),
        title: expectedTitle,
        operationId: opId,
        status: 'verified',
        kind: 'evidence_note',
        created: true,
        already_present: false,
        contentHash: crypto.createHash('sha256').update(verifiedDesc).digest('hex'),
        noteType,
        publish,
        markerCount: 1,
        attribution: observedAttribution,
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
      const effectiveZoneUrl = await api.getEffectiveZoneUrl();

      return withTicketOperation(
        {
          ticketId,
          actor,
          operationId: opId,
          kind: 'resolution_append',
          effectiveZoneUrl,
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
              kind: 'resolution_append',
              written: false,
              already_present: true,
              reconciled_from_prior_evidence: true,
              appended_line: priorLine,
              concurrency_notice: CONCURRENCY_NOTICE,
              verified: true,
            });
          }

          const patchRoute = 'V1.0/Tickets';
          await api.preflightMutationPrerequisites(patchRoute);

          // Read 1: check ticket and expectedResolutionSha256
          const ticketRes1 = await api.getById('Tickets', ticketId);
          const ticket1 = unwrapRecord<TicketModel>(ticketRes1);
          if (!ticket1 || Object.keys(ticket1).length === 0) {
            throw new Error(`Ticket ${ticketId} not found`);
          }

          const currentResolution = typeof ticket1.resolution === 'string' ? ticket1.resolution : '';
          const currentSha = crypto.createHash('sha256').update(currentResolution).digest('hex');
          const marker = `[op:${opId}]`;

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

            const markerCount = countResolutionMarkers(currentResolution, opId);
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

          const existingPrepared = op?.preparedState;
          const timestamp =
            (existingPrepared?.frozenTimestamp as string) || formatUtcTimestamp();
          const appendedLine =
            (existingPrepared?.appendedLine as string) ||
            `${args.text.trim()} [${timestamp}, ${actor.email}, op:${opId}]`;

          const newResolution =
            (existingPrepared?.composedResolution as string) ||
            (currentResolution.length === 0
              ? appendedLine
              : currentResolution.endsWith('\n')
                ? `${currentResolution}${appendedLine}`
                : `${currentResolution}\n${appendedLine}`);

          const patchBody = { id: Number(ticketId), resolution: newResolution };
          const exactBodyDigest = computeBodyDigest(patchBody);

          // Save prepared state transactionally before arming
          await session.commitPreparation(
            {
              observedResolutionBefore: currentResolution,
              originalPrefixSha256: currentSha,
              frozenTimestamp: timestamp,
              appendedLine,
              composedResolution: newResolution,
            },
            {
              provider: 'autotask',
              canonicalRoute: patchRoute,
              method: 'PATCH',
              dispatchNonce: opId,
              target: ticketId,
              exactBodyDigest,
              preparedSha256: exactBodyDigest,
              frozenParameters: patchBody,
            },
          );

          // Pre-write concurrency read
          const ticketRes2 = await api.getById('Tickets', ticketId);
          const ticket2 = unwrapRecord<TicketModel>(ticketRes2);
          const read2Resolution = typeof ticket2.resolution === 'string' ? ticket2.resolution : '';
          if (read2Resolution !== currentResolution) {
            throw new Error(
              'Conflict: ticket resolution was modified concurrently between reads; write refused',
            );
          }

          const armRes = await session.armDispatch({
            provider: 'autotask',
            canonicalRoute: patchRoute,
            method: 'PATCH',
            exactBodyDigest,
          });

          if (!armRes.permitToken) {
            throw new Error('Refused: failed to acquire dispatch permit token for resolution append');
          }

          try {
            await api.singleDispatchMutation('PATCH', patchRoute, patchBody, {
              permitToken: armRes.permitToken,
            });
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
          const finalMarkerCount = countResolutionMarkers(finalRes, opId);
          if (finalMarkerCount !== 1) {
            throw new Error(
              `Verification failed: resolution missing or has invalid marker count for operation "${opId}" (${finalMarkerCount})`,
            );
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
      const effectiveZoneUrl = await api.getEffectiveZoneUrl();

      return withTicketOperation(
        {
          ticketId,
          actor,
          operationId: opId,
          kind: 'checklist_set',
          effectiveZoneUrl,
          payload: {
            ticketID: ticketId,
            checklistItemID: itemId,
            completed: targetCompleted,
            evidenceOperationId: args.evidenceOperationId
              ? String(args.evidenceOperationId).trim()
              : null,
          },
        },
        async (session) => {
          const op = session.getOperation();
          if (op?.phase === 'verified') {
            return jsonResponse(
              op.receipt ?? {
                ticketID: Number(ticketId),
                checklistItemID: Number(itemId),
                status: 'verified',
                kind: 'checklist_set',
                isCompleted: targetCompleted,
                observedAt: new Date().toISOString(),
              },
            );
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

            // 3. Complete kind-specific evidence verification
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

              if (
                req.expectedAttachmentId &&
                archiveReceipt.source.attachmentId !== req.expectedAttachmentId
              ) {
                throw new Error(
                  `Requirement mismatch: expected attachment ${req.expectedAttachmentId}, got ${archiveReceipt.source.attachmentId}`,
                );
              }

              if (req.expectedSourceDigest) {
                if (
                  archiveReceipt.source.sha256.toLowerCase() !==
                  req.expectedSourceDigest.toLowerCase()
                ) {
                  throw new Error(
                    `Requirement mismatch: expected digest ${req.expectedSourceDigest}, got ${archiveReceipt.source.sha256}`,
                  );
                }
              }

              if (req.requiredBindingId) {
                const expectedBindingId = bindingDocId(session.accountKey, archiveReceipt.source.companyId);
                if (req.requiredBindingId !== expectedBindingId) {
                  throw new Error(
                    `Requirement mismatch: expected binding ID "${req.requiredBindingId}", got "${expectedBindingId}"`,
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

              if (req.requiredNoteType !== undefined && noteReceipt.noteType !== req.requiredNoteType) {
                throw new Error(
                  `Requirement mismatch: expected noteType ${req.requiredNoteType}, got ${noteReceipt.noteType}`,
                );
              }

              if (req.requiredPublish !== undefined && noteReceipt.publish !== req.requiredPublish) {
                throw new Error(
                  `Requirement mismatch: expected publish ${req.requiredPublish}, got ${noteReceipt.publish}`,
                );
              }

              if (req.requiredTitle && noteReceipt.title !== req.requiredTitle) {
                throw new Error(
                  `Requirement mismatch: expected title "${req.requiredTitle}", got "${noteReceipt.title}"`,
                );
              }

              if (
                req.requiredContentDigest &&
                noteReceipt.contentHash?.toLowerCase() !== req.requiredContentDigest.toLowerCase()
              ) {
                throw new Error(
                  `Requirement mismatch: expected content digest ${req.requiredContentDigest}, got ${noteReceipt.contentHash}`,
                );
              }

              // Re-read note to verify it still exists on ticket
              const noteRes = await api.getById('TicketNotes', String(noteReceipt.noteID));
              const noteData = unwrapRecord<Record<string, unknown>>(noteRes);
              if (!noteData || Object.keys(noteData).length === 0 || String(noteData.ticketID) !== ticketId) {
                throw new Error(
                  `Evidence note ${noteReceipt.noteID} is no longer present on ticket ${ticketId}`,
                );
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

          const currentCompleted = item.isCompleted === true;
          const fullItemName = String(item.itemName ?? '').trim();
          const semanticFingerprint = computeItemSemanticFingerprint(
            ticketId,
            itemId,
            fullItemName,
            req?.sourceReference,
            req?.sourceVersion,
          );

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
              itemName: fullItemName,
              already_in_state: true,
              updated: false,
              observedAt: new Date().toISOString(),
            };
            await session.markObservationOnly(receipt, {
              requiredRequirementId: req
                ? requirementDocId(session.accountKey, ticketId, itemId)
                : undefined,
              expectedRequirementRevision: req?.version,
            });
            return jsonResponse(receipt);
          }

          const patchRoute = `V1.0/Tickets/${ticketId}/ChecklistItems`;
          await api.preflightMutationPrerequisites(patchRoute);

          const patchBody = { id: Number(itemId), isCompleted: targetCompleted };
          const exactBodyDigest = computeBodyDigest(patchBody);

          // Commit preparation before arming dispatch
          await session.commitPreparation(
            {
              ticketId,
              checklistItemId: itemId,
              targetCompleted,
              semanticFingerprint,
              requirementVersion: req?.version,
              evidenceOperationId: evidenceOpId || null,
            },
            {
              provider: 'autotask',
              canonicalRoute: patchRoute,
              method: 'PATCH',
              dispatchNonce: opId,
              target: ticketId,
              exactBodyDigest,
              preparedSha256: exactBodyDigest,
              policyFingerprint: semanticFingerprint,
              policyReferences: req
                ? [requirementDocId(session.accountKey, ticketId, itemId)]
                : [],
              frozenParameters: patchBody,
            },
          );

          const armRes = await session.armDispatch({
            provider: 'autotask',
            canonicalRoute: patchRoute,
            method: 'PATCH',
            exactBodyDigest,
            policyFingerprint: semanticFingerprint,
            requiredRequirementId: req
              ? requirementDocId(session.accountKey, ticketId, itemId)
              : undefined,
            expectedRequirementRevision: req?.version,
            requiredEvidenceOpKey: evidenceOpId
              ? operationKey(session.accountKey, evidenceOpId)
              : undefined,
            requiredBindingId:
              req?.requiredKind === 'attachment_archive' && req.requiredBindingId
                ? req.requiredBindingId
                : undefined,
          });

          if (!armRes.permitToken) {
            throw new Error('Refused: failed to acquire dispatch permit token for checklist update');
          }

          let patchResRaw: unknown;
          try {
            patchResRaw = await api.singleDispatchMutation('PATCH', patchRoute, patchBody, {
              permitToken: armRes.permitToken,
            });
          } catch (err: unknown) {
            if (session.isArmed()) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await session.markUncertain(errMsg);
            }
            throw err;
          }

          const patchRes = (patchResRaw as { itemId?: number } | undefined) ?? {};
          if (typeof patchRes.itemId !== 'number' || patchRes.itemId !== Number(itemId)) {
            throw new Error(
              `Verification failed: Autotask mutation response did not return documented OperationResultModel with itemId ${itemId}`,
            );
          }

          // Authoritative readback verification
          const readbackRes = await api.request(
            'GET',
            `V1.0/Tickets/${encodeURIComponent(ticketId)}/ChecklistItems/${encodeURIComponent(itemId)}`,
          );
          const readbackItem = unwrapRecord<TicketChecklistItemModel>(readbackRes);
          if (readbackItem.isCompleted !== targetCompleted) {
            throw new Error(
              `Verification failed: checklist item ${itemId} isCompleted (${readbackItem.isCompleted}) is not ${targetCompleted}`,
            );
          }

          if (
            String(readbackItem.id) !== itemId ||
            String(readbackItem.ticketID) !== ticketId
          ) {
            throw new Error(
              `Verification failed: readback checklist item ID/ticketID mismatch (${readbackItem.id}/${readbackItem.ticketID})`,
            );
          }

          const readbackFingerprint = computeItemSemanticFingerprint(
            ticketId,
            itemId,
            String(readbackItem.itemName ?? '').trim(),
            req?.sourceReference,
            req?.sourceVersion,
          );
          if (readbackFingerprint !== semanticFingerprint) {
            throw new Error('Verification failed: readback item semantic fingerprint mismatch');
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
            itemName: fullItemName,
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
