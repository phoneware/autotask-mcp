import crypto from 'node:crypto';
import type { ToolDefinition, ToolResponse } from '../types.js';
import { api } from '../autotask-api.js';
import { currentCaller } from '../auth/context.js';
import { assertSafeNumericId } from '../security.js';
import { jsonResponse } from './shared.js';
import { TicketCoordinatorSession } from '../provisioning/ticket-coordinator.js';
import { deriveAccountKey, getOperationStore } from '../provisioning/operation-store.js';
import { getRequirementsStore } from '../provisioning/requirements.js';

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
 * Guards against operationId text mismatch, and prevents distinct operation IDs
 * from deduplicating based merely on identical text.
 */
export function findMatchingResolutionLine(
  currentResolution: string,
  targetText: string,
  operationId?: string,
  ticketId?: string,
): string | null {
  if (!currentResolution) return null;
  const lines = currentResolution.split(/\r?\n/);
  const cleanTarget = targetText.trim();
  const cleanOpId = (operationId || '').trim();

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Parse line for [..., op:<opId>]
    const opMatch = trimmedLine.match(/\[.*?,\s*op:([^\s,\]]+).*?\]$/);
    const lineOpId = opMatch ? opMatch[1] : null;

    // Parse line for logical text before bracketed timestamp metadata
    const textMatch = trimmedLine.match(
      /^(.*?)\s*\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC[^\]]*\]$/,
    );
    const lineLogicalText = textMatch ? textMatch[1].trim() : trimmedLine;

    // Case 1: Caller provided an operationId
    if (cleanOpId) {
      if (lineOpId) {
        if (lineOpId === cleanOpId) {
          // Guard against text mismatch with same operationId
          if (lineLogicalText !== cleanTarget) {
            throw new Error(
              `Conflict: operationId "${cleanOpId}" was previously recorded with different text on ticket ${
                ticketId ?? ''
              }: "${lineLogicalText}" vs requested "${cleanTarget}"`,
            );
          }
          return trimmedLine; // Exact operation identity match
        }
        // Different operationId: distinct operation, do NOT deduplicate even if text is identical
        continue;
      }
      // Line has no operationId: do NOT match with an explicit operationId
      continue;
    }

    // Case 2: Caller did NOT provide an operationId (anonymous call)
    // If the line has an operationId, it belongs to an explicit operation, so do not match it
    if (lineOpId) {
      continue;
    }

    // Match if logical text matches
    if (lineLogicalText === cleanTarget) {
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

  if (SECRET_PATTERN.test(args.title) || SECRET_PATTERN.test(args.description)) {
    throw new Error('Refused: evidence note contains sensitive credential pattern');
  }

  const caller = currentCaller();
  const author = caller?.email ?? 'autotask-mcp';
  const actorResourceId = caller?.resourceId ?? 0;

  const noteType = args.noteType !== undefined && args.noteType !== '' ? Number(args.noteType) : 1;
  const publish = args.publish !== undefined && args.publish !== '' ? Number(args.publish) : 1;

  // Bind noteType and publish into immutable intent
  const session = new TicketCoordinatorSession({
    ticketId,
    actor: { email: author, resourceId: actorResourceId },
    operationId: opId,
    kind: 'evidence_note',
    payload: {
      ticketID: ticketId,
      title: args.title.trim(),
      description: args.description.trim(),
      noteType,
      publish,
    },
  });

  const { alreadyVerified } = await session.prepareAndAcquire();
  if (alreadyVerified) {
    const op = session.getOperation();
    return jsonResponse(
      op?.receipt ?? { ticketID: Number(ticketId), verified: true, operationId: opId },
    );
  }

  try {
    // Read ticket to verify parent exists
    const ticketRes = await api.getById('Tickets', ticketId);
    const ticket = unwrapRecord<TicketModel>(ticketRes);
    if (!ticket || Object.keys(ticket).length === 0) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    // Follow complete pagination chain using getPage(nextPageUrl, originalQuery)
    const matchingNotes: Array<Record<string, unknown>> = [];
    const originalQuery = {
      filter: [{ op: 'eq', field: 'ticketID', value: Number(ticketId) }],
      MaxRecords: 100,
    };
    let pageResult = (await api.query('TicketNotes', originalQuery)) as {
      items?: Array<Record<string, unknown>>;
      pageDetails?: { nextPageUrl?: string };
    };

    const visitedUrls = new Set<string>();
    while (pageResult && Array.isArray(pageResult.items)) {
      for (const note of pageResult.items) {
        const noteDesc = typeof note.description === 'string' ? note.description : '';
        const noteTitle = typeof note.title === 'string' ? note.title : '';
        const match =
          noteDesc.match(/\[op:([^\s,\]]+)\]/) || noteTitle.match(/\[op:([^\s,\]]+)\]/);
        if (match && match[1] === opId) {
          matchingNotes.push(note);
        }
      }
      const nextUrl = pageResult.pageDetails?.nextPageUrl;
      if (nextUrl) {
        if (visitedUrls.has(nextUrl)) {
          throw new Error('Cycle detected in note pagination');
        }
        visitedUrls.add(nextUrl);
        pageResult = (await api.getPage(nextUrl, originalQuery)) as typeof pageResult;
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
      const receipt = {
        ticketID: Number(ticketId),
        noteID: Number(note.id),
        title: typeof note.title === 'string' ? note.title : args.title,
        operationId: opId,
        status: 'verified',
        created: false,
        already_present: true,
        observedAt: new Date().toISOString(),
      };
      await session.markVerified(receipt);
      return jsonResponse(receipt);
    }

    const finalDescription = `${args.description}\n[op:${opId}]`;

    // Commit preparation before arming
    await session.commitPreparation({
      frozenDescription: finalDescription,
      title: args.title.trim(),
      noteType,
      publish,
    });

    const body: Record<string, unknown> = {
      ticketID: Number(ticketId),
      title: args.title,
      description: finalDescription,
      noteType,
      publish,
    };

    // Single dispatch mutation: armed exactly once inside callback immediately before fetch
    const createdRes = (await api.singleDispatchMutation(
      'POST',
      `V1.0/Tickets/${ticketId}/Notes`,
      body,
      {
        armBeforeFetch: async () => {
          await session.armDispatch();
        },
      },
    )) as {
      itemId?: number | string;
      id?: number | string;
      item?: { id?: number | string };
    };
    const createdId = createdRes?.itemId ?? createdRes?.id ?? createdRes?.item?.id;

    if (!createdId) {
      throw new Error('Failed to create evidence note: no ID returned from Autotask');
    }

    // Readback verification through parent route comparing complete content
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

    const receipt = {
      ticketID: Number(ticketId),
      noteID: Number(createdId),
      title: args.title,
      operationId: opId,
      status: 'verified',
      created: true,
      already_present: false,
      observedAt: new Date().toISOString(),
    };

    await session.markVerified(receipt);
    return jsonResponse(receipt);
  } catch (err: unknown) {
    if (session.isArmed()) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await session.markUncertain(errMsg);
    }
    throw err;
  } finally {
    await session.release();
  }
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

      const callerProvidedOpId = Boolean(args.operationId && String(args.operationId).trim());
      const opId = callerProvidedOpId
        ? String(args.operationId).trim()
        : `anon-${crypto.createHash('sha256').update(args.text.trim()).digest('hex').slice(0, 16)}`;

      const caller = currentCaller();
      const author = caller?.email ?? 'autotask-mcp';
      const actorResourceId = caller?.resourceId ?? 0;

      const session = new TicketCoordinatorSession({
        ticketId,
        actor: { email: author, resourceId: actorResourceId },
        operationId: opId,
        kind: 'resolution_append',
        payload: {
          ticketID: ticketId,
          text: args.text.trim(),
          expectedResolutionSha256: args.expectedResolutionSha256 ?? null,
        },
      });

      const { alreadyVerified, isRecovery } = await session.prepareAndAcquire();
      if (alreadyVerified) {
        const op = session.getOperation();
        const priorLine = (op?.receipt?.appended_line as string) || args.text;
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

      try {
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
          callerProvidedOpId ? opId : undefined,
          ticketId,
        );

        if (priorLine) {
          const prepared = session.getOperation()?.preparedState;
          // Reliability 6: If prepared original resolution exists, verify it was preserved!
          if (prepared?.observedResolutionBefore !== undefined) {
            const expectedPrefix = String(prepared.observedResolutionBefore);
            if (!currentResolution.startsWith(expectedPrefix)) {
              throw new Error(
                `Conflict: operation "${opId}" marker exists but original resolution prefix was destroyed; reconciliation refused`,
              );
            }
          }

          const receipt = {
            ticketID: Number(ticketId),
            operationId: opId,
            status: 'verified',
            written: false,
            already_present: true,
            appended_line: priorLine,
            resolution_length_before: currentResolution.length,
            resolution_length_after: currentResolution.length,
            observedAt: new Date().toISOString(),
          };
          await session.markVerified(receipt);
          return jsonResponse({
            ...receipt,
            operationId: callerProvidedOpId ? opId : null,
            reconciled_from_prior_evidence: true,
            concurrency_notice: CONCURRENCY_NOTICE,
            verified: true,
          });
        }

        // If in recovery but priorLine was NOT found, do NOT redispatch! Must remain uncertain
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
        const appendedLine = callerProvidedOpId
          ? `${args.text} [${timestamp}, ${author}, op:${opId}]`
          : `${args.text} [${timestamp}, ${author}]`;

        // Appends with a single \n separator, never rewriting existing text
        const newResolution =
          currentResolution.length === 0
            ? appendedLine
            : currentResolution.endsWith('\n')
              ? `${currentResolution}${appendedLine}`
              : `${currentResolution}\n${appendedLine}`;

        // Save prepared state transactionally before arming
        await session.commitPreparation({
          observedResolutionBefore: currentResolution,
          frozenTimestamp: timestamp,
          appendedLine,
        });

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

        // Fencing check before pre-write read
        if (!session.isFencedAndValid()) {
          throw new Error('Conflict: ticket lease expired before write; write refused');
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

        // Single dispatch mutation with immediate armBeforeFetch hook
        await api.singleDispatchMutation(
          'PATCH',
          'V1.0/Tickets',
          { id: Number(ticketId), resolution: newResolution },
          {
            armBeforeFetch: async () => {
              await session.armDispatch();
            },
          },
        );

        // Read 3: verify written resolution normalizing \r\n
        const ticketRes3 = await api.getById('Tickets', ticketId);
        const ticket3 = unwrapRecord<TicketModel>(ticketRes3);
        const read3Resolution = typeof ticket3.resolution === 'string' ? ticket3.resolution : '';

        if (read3Resolution.replace(/\r\n/g, '\n') !== newResolution.replace(/\r\n/g, '\n')) {
          throw new Error(
            'Verification failed: written resolution does not match read-back resolution',
          );
        }

        const receipt = {
          ticketID: Number(ticketId),
          operationId: opId,
          status: 'verified',
          written: true,
          already_present: false,
          appended_line: appendedLine,
          resolution_length_before: currentResolution.length,
          resolution_length_after: read3Resolution.length,
          observedAt: new Date().toISOString(),
        };

        await session.markVerified(receipt);

        return jsonResponse({
          ...receipt,
          operationId: callerProvidedOpId ? opId : null,
          reconciled_from_prior_evidence: false,
          concurrency_notice: CONCURRENCY_NOTICE,
          verified: true,
        });
      } catch (err: unknown) {
        if (session.isArmed()) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await session.markUncertain(errMsg);
        }
        throw err;
      } finally {
        await session.release();
      }
    },
  },
  {
    name: 'record-ticket-evidence',
    title: 'Record Ticket Evidence',
    description:
      'Record verification evidence on an Autotask ticket as a TicketNote. ' +
      'DESTRUCTIVE (write): requires confirm token RECORD_TICKET_EVIDENCE. ' +
      'Idempotent across retries: uses operationId to reconcile prior evidence, checks itemId in response, and verifies note on readback.',
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
          description: 'Stable operation identifier for idempotent retries and dispatch coordination',
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
      required: ['ticketID', 'title', 'description', 'operationId'],
    },
    handler: (args) =>
      recordTicketEvidenceHandler({
        ticketID: String(args.ticketID ?? ''),
        title: String(args.title ?? ''),
        description: String(args.description ?? ''),
        operationId: String(args.operationId ?? ''),
        noteType: args.noteType !== undefined ? String(args.noteType) : undefined,
        publish: args.publish !== undefined ? String(args.publish) : undefined,
      }),
  },
  {
    name: 'set-ticket-checklist-item',
    title: 'Set Ticket Checklist Item',
    description:
      'Set completion status of a checklist item on an Autotask ticket. ' +
      'DESTRUCTIVE (write): requires confirm token SET_TICKET_CHECKLIST_ITEM. ' +
      'Verifies parent ticket relationship and server-owned task requirements before reporting complete.',
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
        operationId: {
          type: 'string',
          description: 'Stable operation identifier for coordinated checklist completion',
        },
        evidenceOperationId: {
          type: 'string',
          description: 'Required when completing: operation ID of verified evidence note or archive operation',
        },
        evidenceNoteID: {
          type: 'string',
          description: 'Optional Autotask ticket note ID containing the verification evidence',
        },
      },
      required: ['ticketID', 'checklistItemID', 'completed'],
    },
    handler: async (args) => {
      const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');
      const itemId = assertSafeNumericId(args.checklistItemID, 'checklistItemID');

      if ('requireEvidence' in args || 'evidenceAttachmentID' in args) {
        throw new Error(
          'Obsolete argument supplied: checklist completion requires server-owned requirement verification via evidenceOperationId; raw attachment/policy switches rejected',
        );
      }

      const completedLower = (args.completed || '').trim().toLowerCase();
      if (completedLower !== 'true' && completedLower !== 'false') {
        throw new Error('completed must be "true" or "false"');
      }
      const targetCompleted = completedLower === 'true';

      const caller = currentCaller();
      const author = caller?.email ?? 'autotask-mcp';
      const actorResourceId = caller?.resourceId ?? 0;

      const opId =
        (args.operationId && String(args.operationId).trim()) ||
        `chk-${ticketId}-${itemId}-${targetCompleted ? 'done' : 'reopen'}`;

      let evidenceNoteIdNum: number | null = null;
      let evidenceOpId: string | null = null;

      // Validate evidence requirements when marking complete (enforced server-side)
      if (targetCompleted) {
        if (!args.evidenceNoteID && !args.evidenceOperationId) {
          throw new Error(
            `Refused: checklist item completion requires observed evidence (evidenceOperationId or evidenceNoteID on ticket ${ticketId})`,
          );
        }

        if (args.evidenceOperationId) {
          evidenceOpId = String(args.evidenceOperationId).trim();
          const accountKey = deriveAccountKey();
          const op = await getOperationStore().getOperation(accountKey, evidenceOpId);
          if (!op || op.phase !== 'verified') {
            throw new Error(
              `Evidence operation "${evidenceOpId}" is not verified (current phase: ${
                op?.phase ?? 'missing'
              }); checklist completion refused`,
            );
          }
          if (op.ticketId !== ticketId) {
            throw new Error(
              `Parent mismatch: evidence operation "${evidenceOpId}" belongs to ticketID ${op.ticketId}, not ${ticketId}; checklist completion refused`,
            );
          }

          // Check server-owned requirement if one is configured for this checklist item
          const req = await getRequirementsStore().get(accountKey, ticketId, itemId);
          if (req && !req.disabled) {
            if (op.kind !== req.requiredKind) {
              throw new Error(
                `Requirement mismatch: checklist item ${itemId} requires operation kind "${req.requiredKind}", but evidence operation "${evidenceOpId}" is "${op.kind}"`,
              );
            }
            if (req.expectedSourceDigest) {
              const actualDigest =
                (op.receipt?.source as { sha256?: string })?.sha256 ||
                (op.payload?.expectedSha256 as string);
              if (actualDigest && actualDigest.toLowerCase() !== req.expectedSourceDigest.toLowerCase()) {
                throw new Error(
                  `Requirement mismatch: expected source digest "${req.expectedSourceDigest}", got "${actualDigest}"`,
                );
              }
            }
          }
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
          operationId: opId,
          status: 'verified',
          isCompleted: targetCompleted,
          position: item.position ?? null,
          completedDateTime: item.completedDateTime ?? null,
          completedByResourceID: item.completedByResourceID ?? null,
          itemName: safeItemName,
          already_in_state: true,
          updated: false,
          evidenceVerified: Boolean(evidenceNoteIdNum || evidenceOpId),
          evidenceNoteID: evidenceNoteIdNum,
          evidenceOperationId: evidenceOpId,
          observedAt: new Date().toISOString(),
        });
      }

      // Coordinate mutation through TicketCoordinatorSession
      const session = new TicketCoordinatorSession({
        ticketId,
        actor: { email: author, resourceId: actorResourceId },
        operationId: opId,
        kind: 'checklist_set',
        payload: {
          ticketID: ticketId,
          checklistItemID: itemId,
          completed: targetCompleted,
          evidenceOperationId: evidenceOpId,
        },
      });

      await session.prepareAndAcquire();

      try {
        // Write update via singleDispatchMutation
        await api.singleDispatchMutation(
          'PATCH',
          `V1.0/Tickets/${ticketId}/ChecklistItems`,
          { id: Number(itemId), isCompleted: targetCompleted },
          {
            armBeforeFetch: async () => {
              await session.armDispatch();
            },
          },
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

        const receipt = {
          ticketID: Number(ticketId),
          checklistItemID: Number(itemId),
          operationId: opId,
          status: 'verified',
          isCompleted: targetCompleted,
          position: verifyItem.position ?? item.position ?? null,
          completedDateTime: verifyItem.completedDateTime ?? null,
          completedByResourceID: verifyItem.completedByResourceID ?? null,
          itemName: updatedItemName,
          already_in_state: false,
          updated: true,
          evidenceVerified: Boolean(evidenceNoteIdNum || evidenceOpId),
          evidenceNoteID: evidenceNoteIdNum,
          evidenceOperationId: evidenceOpId,
          observedAt: new Date().toISOString(),
        };

        await session.markVerified(receipt);
        return jsonResponse(receipt);
      } catch (err: unknown) {
        if (session.isArmed()) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await session.markUncertain(errMsg);
        }
        throw err;
      } finally {
        await session.release();
      }
    },
  },
];
