import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  ticketWriteTools,
  formatUtcTimestamp,
  maskSecretTokens,
} from '../src/tools/ticket-writes.js';
import { buildServer } from '../src/server.js';
import { DESTRUCTIVE_TOOLS, CONFIRM_REQUIRED_TOOLS, confirmTokenFor } from '../src/security.js';
import { withCaller } from '../src/auth/context.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  setOperationStore,
  MemoryOperationStore,
  deriveAccountKey,
} from '../src/provisioning/operation-store.js';
import {
  setRequirementsStore,
  MemoryRequirementsStore,
  computeItemSemanticFingerprint,
} from '../src/provisioning/requirements.js';

const {
  getById,
  update,
  request,
  entityFields,
  create,
  query,
  getPage,
  singleDispatchMutation,
  getEffectiveZoneUrl,
  preflightMutationPrerequisites,
} = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  request: vi.fn(),
  entityFields: vi.fn(),
  create: vi.fn(),
  query: vi.fn(),
  getPage: vi.fn(),
  getEffectiveZoneUrl: vi.fn().mockResolvedValue('https://webservices2.autotask.net/atservicesrest/'),
  preflightMutationPrerequisites: vi.fn().mockResolvedValue(undefined),
  singleDispatchMutation: vi.fn(async (method: string, path: string, body: unknown) => {
    if (method === 'PATCH' && path === 'V1.0/Tickets') {
      return update('Tickets', body);
    }
    if (method === 'PATCH' && path.includes('ChecklistItems')) {
      const match = path.match(/Tickets\/(\d+)\/ChecklistItems/);
      await update('TicketChecklistItems', body, 'Tickets', match ? match[1] : undefined);
      const b = body as { id?: number };
      return { itemId: Number(b?.id ?? 501) };
    }
    if (method === 'POST') {
      return create(path.replace(/^V1\.0\//, ''), body);
    }
    return { success: true };
  }),
}));

vi.mock('../src/autotask-api.js', () => ({
  api: {
    getById,
    update,
    request,
    entityFields,
    create,
    query,
    getPage,
    getEffectiveZoneUrl,
    preflightMutationPrerequisites,
    singleDispatchMutation,
  },
}));

describe('ticket-writes helpers', () => {
  it('formatUtcTimestamp formats a UTC date correctly', () => {
    const d = new Date(Date.UTC(2026, 9, 31, 14, 5, 0));
    expect(formatUtcTimestamp(d)).toBe('2026-10-31 14:05 UTC');
  });

  it('maskSecretTokens masks tokens following password, passphrase, psk, pin', () => {
    expect(maskSecretTokens('Wi-Fi password: secret123 on AP')).toBe(
      'Wi-Fi password: [REDACTED] on AP',
    );
    expect(maskSecretTokens('Set PSK=MySecretKey here')).toBe('Set PSK=[REDACTED] here');
    expect(maskSecretTokens('Enter passphrase TopSecret now')).toBe(
      'Enter passphrase [REDACTED] now',
    );
    expect(maskSecretTokens('Normal checklist item with no secret')).toBe(
      'Normal checklist item with no secret',
    );
  });
});

describe('append-ticket-resolution tool', () => {
  const appendTool = ticketWriteTools.find((t) => t.name === 'append-ticket-resolution')!;

  beforeEach(() => {
    vi.resetAllMocks();
    setOperationStore(new MemoryOperationStore());
  });

  afterEach(() => {
    setOperationStore(null);
  });

  it('is registered as destructive and confirm-required with correct token', () => {
    expect(DESTRUCTIVE_TOOLS.has('append-ticket-resolution')).toBe(true);
    expect(CONFIRM_REQUIRED_TOOLS.has('append-ticket-resolution')).toBe(true);
    expect(confirmTokenFor('append-ticket-resolution')).toBe('APPEND_TICKET_RESOLUTION');
  });

  it('appends exact line with single newline separator and caller byline', async () => {
    const initialTicket = {
      id: 12345,
      resolution: 'Initial provisioning completed.',
    };

    let readCount = 0;
    getById.mockImplementation(async () => {
      readCount++;
      if (readCount === 1) return { item: { ...initialTicket } };
      if (readCount === 2) return { item: { ...initialTicket } };
      // Read 3 (verification): return updated resolution
      return {
        item: {
          id: 12345,
          resolution: update.mock.calls[0][1].resolution,
        },
      };
    });

    update.mockResolvedValue({ id: 12345 });
    entityFields.mockResolvedValue({
      fields: [{ name: 'resolution', length: 5000 }],
    });

    const caller = {
      email: 'tech@phoneware.us',
      resourceId: 77,
      userType: 14,
      capabilities: ['read', 'create', 'update', 'delete'] as const,
    };

    const res = await withCaller(caller, () =>
      appendTool.handler({
        ticketID: '12345',
        text: 'Installed Frontier eSIM into slot A.',
        operationId: 'esim-slot-a',
      }),
    );

    expect(getById).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('Tickets', {
      id: 12345,
      resolution: expect.stringMatching(
        /^Initial provisioning completed\.\nInstalled Frontier eSIM into slot A\. \[\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, tech@phoneware\.us, op:esim-slot-a\]$/,
      ),
    });

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.written).toBe(true);
    expect(parsed.already_present).toBe(false);
    expect(parsed.verified).toBe(true);
    expect(parsed.ticketID).toBe(12345);
    expect(parsed.appended_line).toMatch(
      /^Installed Frontier eSIM into slot A\. \[\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, tech@phoneware\.us, op:esim-slot-a\]$/,
    );
  });

  it('refuses when caller has no verified actor', async () => {
    await expect(
      appendTool.handler({
        ticketID: '10',
        text: 'First line on clean ticket.',
        operationId: 'op-anon-1',
      }),
    ).rejects.toThrow(/authenticated caller with a verified email/);
  });

  it('no-ops when exact line is already present', async () => {
    const existingTimestamp = formatUtcTimestamp();
    const existingLine = `Step 50 verified [${existingTimestamp}, autotask-mcp]`;
    const existingResolution = `Step 49 verified\n${existingLine}\nOther notes`;

    getById.mockResolvedValue({
      item: { id: 12345, resolution: existingResolution },
    });

    const res = await appendTool.handler({
      ticketID: '12345',
      text: 'Step 50 verified',
    });

    expect(update).not.toHaveBeenCalled();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.written).toBe(false);
    expect(parsed.already_present).toBe(true);
    expect(parsed.verified).toBe(true);
    expect(parsed.appended_line).toBe(existingLine);
    expect(parsed.resolution_length_before).toBe(existingResolution.length);
    expect(parsed.resolution_length_after).toBe(existingResolution.length);
  });

  it('refuses secret-looking text per regex', async () => {
    const secretSamples = [
      'Configured Wi-Fi password: superSecretKey1',
      'device passwd is admin',
      'Router passphrase = MySecret',
      'Used pre-shared key for IPsec',
      'preshared key setup',
      'WAN psk is 12345678',
      'Set pin: 1234 on device',
      'Set pin = 5678 on device',
      'eSIM matching code LPA:1$smdp.io$CONF-1234',
    ];

    for (const secretText of secretSamples) {
      await expect(
        appendTool.handler({
          ticketID: '123',
          text: secretText,
        }),
      ).rejects.toThrow(/sensitive credential pattern/i);
    }

    expect(getById).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when text length is outside 1..2000 characters', async () => {
    await expect(
      appendTool.handler({
        ticketID: '123',
        text: '',
      }),
    ).rejects.toThrow(/between 1 and 2000 characters/);

    await expect(
      appendTool.handler({
        ticketID: '123',
        text: 'a'.repeat(2001),
      }),
    ).rejects.toThrow(/between 1 and 2000 characters/);
  });

  it('refuses when expectedResolutionSha256 does not match', async () => {
    const currentRes = 'Current resolution text';
    getById.mockResolvedValue({
      item: { id: 123, resolution: currentRes },
    });

    await expect(
      appendTool.handler({
        ticketID: '123',
        text: 'Some update',
        expectedResolutionSha256:
          'deadbeef00000000000000000000000000000000000000000000000000000000',
      }),
    ).rejects.toThrow(/expectedResolutionSha256 mismatch/);

    expect(update).not.toHaveBeenCalled();
  });

  it('accepts matching expectedResolutionSha256', async () => {
    const currentRes = 'Current resolution text';
    const currentSha = crypto.createHash('sha256').update(currentRes).digest('hex');

    let readCount = 0;
    getById.mockImplementation(async () => {
      readCount++;
      if (readCount <= 2) return { item: { id: 123, resolution: currentRes } };
      return { item: { id: 123, resolution: update.mock.calls[0][1].resolution } };
    });
    update.mockResolvedValue({ id: 123 });

    const res = await appendTool.handler({
      ticketID: '123',
      text: 'Some update',
      expectedResolutionSha256: currentSha,
    });

    expect(update).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.written).toBe(true);
  });

  it('refuses when resolution changed between read 1 and read 2 (concurrent write)', async () => {
    getById
      .mockResolvedValueOnce({
        item: { id: 123, resolution: 'Resolution at read 1' },
      })
      .mockResolvedValueOnce({
        item: { id: 123, resolution: 'Resolution altered by someone else' },
      });

    await expect(
      appendTool.handler({
        ticketID: '123',
        text: 'My append',
      }),
    ).rejects.toThrow(/modified concurrently between reads/);

    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when resulting resolution exceeds field maxLength', async () => {
    getById.mockResolvedValue({
      item: { id: 123, resolution: 'Initial text that is already twenty chars' },
    });

    entityFields.mockResolvedValue({
      fields: [{ name: 'resolution', length: 50 }],
    });

    await expect(
      appendTool.handler({
        ticketID: '123',
        text: 'This line is definitely going to push total length over 50 chars',
      }),
    ).rejects.toThrow(/exceeds maximum allowed length/);

    expect(update).not.toHaveBeenCalled();
  });

  it('normalizes CRLF on read 3 verification', async () => {
    let readCount = 0;
    getById.mockImplementation(async () => {
      readCount++;
      if (readCount <= 2) return { item: { id: 123, resolution: 'Line 1' } };
      // Autotask returns CRLF on read 3
      const written = update.mock.calls[0][1].resolution as string;
      return {
        item: {
          id: 123,
          resolution: written.replace(/\n/g, '\r\n'),
        },
      };
    });

    update.mockResolvedValue({ id: 123 });

    const res = await appendTool.handler({
      ticketID: '123',
      text: 'Line 2',
    });

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.verified).toBe(true);
  });
});

describe('set-ticket-checklist-item tool', () => {
  const setChecklistTool = ticketWriteTools.find((t) => t.name === 'set-ticket-checklist-item')!;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is registered as destructive and confirm-required with correct token', () => {
    expect(DESTRUCTIVE_TOOLS.has('set-ticket-checklist-item')).toBe(true);
    expect(CONFIRM_REQUIRED_TOOLS.has('set-ticket-checklist-item')).toBe(true);
    expect(confirmTokenFor('set-ticket-checklist-item')).toBe('SET_TICKET_CHECKLIST_ITEM');
  });

  it('sends PATCH with body {id, isCompleted} only and masks sensitive token in itemName', async () => {
    const existingItem = {
      id: 501,
      ticketID: 1001,
      isCompleted: true,
      itemName: 'Set AP mesh passphrase: SuperSecretPassphrase123 on all APs',
      position: 12,
      completedDateTime: '2026-10-31T15:00:00Z',
      completedByResourceID: 77,
    };

    let readCount = 0;
    request.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === 'V1.0/Tickets/1001/ChecklistItems/501') {
        readCount++;
        if (readCount === 1) return { item: existingItem };
        return {
          item: {
            ...existingItem,
            isCompleted: false,
            completedDateTime: null,
            completedByResourceID: null,
          },
        };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });

    update.mockResolvedValue({ id: 501 });

    const res = await setChecklistTool.handler({
      ticketID: '1001',
      checklistItemID: '501',
      completed: 'false',
      operationId: 'op-chk-501',
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      'TicketChecklistItems',
      { id: 501, isCompleted: false },
      'Tickets',
      '1001',
    );

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.updated).toBe(true);
    expect(parsed.already_in_state).toBe(false);
    expect(parsed.isCompleted).toBe(false);
    expect(parsed.ticketID).toBe(1001);
    expect(parsed.checklistItemID).toBe(501);
    expect(parsed.position).toBe(12);
    expect(parsed.itemName).toBe('Set AP mesh passphrase: [REDACTED] on all APs');
  });

  it('no-ops when item is already in requested state', async () => {
    request.mockResolvedValue({
      item: {
        id: 502,
        ticketID: 1001,
        isCompleted: true,
        itemName: 'Verify DHCP pool',
        position: 5,
        completedDateTime: '2026-10-30T10:00:00Z',
        completedByResourceID: 42,
      },
    });

    const res = await setChecklistTool.handler({
      ticketID: '1001',
      checklistItemID: '502',
      completed: 'true',
      operationId: 'op-chk-502',
    });

    expect(update).not.toHaveBeenCalled();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.already_in_state).toBe(true);
    expect(parsed.updated).toBe(false);
    expect(parsed.isCompleted).toBe(true);
    expect(parsed.itemName).toBe('Verify DHCP pool');
  });

  it('refuses when checklist item belongs to a different ticket (parent mismatch)', async () => {
    request.mockResolvedValue({
      item: {
        id: 503,
        ticketID: 9999, // Belongs to ticket 9999
        isCompleted: false,
        itemName: 'Some other ticket item',
      },
    });

    await expect(
      setChecklistTool.handler({
        ticketID: '1001', // Request specifies ticket 1001
        checklistItemID: '503',
        completed: 'false',
        operationId: 'op-chk-503',
      }),
    ).rejects.toThrow(/Parent mismatch: checklist item 503 belongs to ticketID 9999, not 1001/);

    expect(update).not.toHaveBeenCalled();
  });

  it('refuses invalid completed argument', async () => {
    await expect(
      setChecklistTool.handler({
        ticketID: '1001',
        checklistItemID: '503',
        completed: 'yes',
        operationId: 'op-chk-bad',
      }),
    ).rejects.toThrow(/completed must be "true" or "false"/);
  });

  it('reconciles prior evidence on clock-advanced retry with operationId without duplicate write', async () => {
    const existingResolution =
      'Initial provisioning completed.\nInstalled Frontier eSIM into slot A. [2026-10-31 14:05 UTC, tech@phoneware.us, op:esim-slot-a]';

    getById.mockResolvedValue({
      item: {
        id: 12345,
        resolution: existingResolution,
      },
    });

    const appendTool = ticketWriteTools.find((t) => t.name === 'append-ticket-resolution')!;

    // Retry 10 minutes later (clock has advanced)
    const res = await appendTool.handler({
      ticketID: '12345',
      text: 'Installed Frontier eSIM into slot A.',
      operationId: 'esim-slot-a',
    });

    expect(update).not.toHaveBeenCalled();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.written).toBe(false);
    expect(parsed.already_present).toBe(true);
    expect(parsed.reconciled_from_prior_evidence).toBe(true);
    expect(parsed.verified).toBe(true);
    expect(parsed.operationId).toBe('esim-slot-a');
    expect(parsed.appended_line).toBe(
      'Installed Frontier eSIM into slot A. [2026-10-31 14:05 UTC, tech@phoneware.us, op:esim-slot-a]',
    );
  });

  it('does not deduplicate distinct operations based merely on identical text when distinct operation IDs are supplied', async () => {
    const existingResolution =
      'Initial provisioning completed.\nRebooted router. [2026-10-31 14:05 UTC, tech@phoneware.us, op:phase-1-reboot]';

    let readCount = 0;
    getById.mockImplementation(async () => {
      readCount++;
      if (readCount === 1 || readCount === 2) {
        return { item: { id: 12345, resolution: existingResolution } };
      }
      return {
        item: {
          id: 12345,
          resolution: `${existingResolution}\nRebooted router. [2026-10-31 14:15 UTC, tech@phoneware.us, op:phase-2-reboot]`,
        },
      };
    });
    update.mockResolvedValue({ id: 12345 });
    entityFields.mockResolvedValue({ fields: [{ name: 'resolution', length: 5000 }] });

    const appendTool = ticketWriteTools.find((t) => t.name === 'append-ticket-resolution')!;

    const res = await appendTool.handler({
      ticketID: '12345',
      text: 'Rebooted router.',
      operationId: 'phase-2-reboot',
    });

    // Because operation IDs differ (phase-1-reboot vs phase-2-reboot), it is NOT deduplicated!
    expect(update).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.written).toBe(true);
    expect(parsed.already_present).toBe(false);
    expect(parsed.operationId).toBe('phase-2-reboot');
  });

  it('guards operationId against text mismatch', async () => {
    const existingResolution =
      'Initial provisioning completed.\nOriginal check. [2026-10-31 14:05 UTC, tech@phoneware.us, op:op-verify-1]';

    getById.mockResolvedValue({
      item: {
        id: 12345,
        resolution: existingResolution,
      },
    });

    const appendTool = ticketWriteTools.find((t) => t.name === 'append-ticket-resolution')!;

    // Attempting to reuse op-verify-1 with different text must throw
    await expect(
      appendTool.handler({
        ticketID: '12345',
        text: 'Completely different check text.',
        operationId: 'op-verify-1',
      }),
    ).rejects.toThrow(/Conflict: operationId "op-verify-1" was previously recorded with different text/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when requireEvidence is true but no evidence is supplied', async () => {
    await expect(
      setChecklistTool.handler({
        ticketID: '1001',
        checklistItemID: '501',
        completed: 'true',
        operationId: 'op-check-evidence',
        requireEvidence: 'true',
      }),
    ).rejects.toThrow(/Obsolete argument supplied: checklist completion requires server-owned requirement verification/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when evidence note argument is supplied', async () => {
    await expect(
      setChecklistTool.handler({
        ticketID: '1001',
        checklistItemID: '501',
        completed: 'true',
        operationId: 'op-check-note',
        evidenceNoteID: '888',
      }),
    ).rejects.toThrow(/Obsolete argument: evidenceNoteID is removed/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when evidence attachment argument is supplied', async () => {
    await expect(
      setChecklistTool.handler({
        ticketID: '1001',
        checklistItemID: '501',
        completed: 'true',
        operationId: 'op-check-att',
        evidenceAttachmentID: '777',
      }),
    ).rejects.toThrow(/Obsolete argument supplied: checklist completion requires server-owned requirement verification/);
    expect(update).not.toHaveBeenCalled();
  });

  it('successfully completes checklist item when valid evidence note is verified', async () => {
    const memoryOpStore = new MemoryOperationStore();
    setOperationStore(memoryOpStore);
    const memoryReqStore = new MemoryRequirementsStore();
    setRequirementsStore(memoryReqStore);

    const accountKey = deriveAccountKey();
    const itemName = 'Configure mesh backhaul';
    const semanticFingerprint = computeItemSemanticFingerprint('1001', '501', itemName);

    // Seed verified evidence operation in operation store
    const evidenceOpId = 'op-note-888';
    await memoryOpStore.prepareOperation({
      accountKey,
      operationId: evidenceOpId,
      actor: { email: 'tech@phoneware.us', resourceId: 77 },
      kind: 'evidence_note',
      ticketId: '1001',
      intentSha256: 'some-sha',
      payload: {},
    });
    const claimRes = await memoryOpStore.acquireCoordinatorLease(
      accountKey,
      '1001',
      'attempt-1',
      'tech@phoneware.us',
      15000,
      evidenceOpId,
    );
    await memoryOpStore.savePreparedState({
      accountKey,
      ticketId: '1001',
      operationId: evidenceOpId,
      claim: claimRes.claim,
      preparedState: {},
    });
    await memoryOpStore.armDispatch(accountKey, '1001', 'attempt-1', evidenceOpId, 'some-sha');
    await memoryOpStore.markVerified(
      accountKey,
      '1001',
      'attempt-1',
      evidenceOpId,
      {
        status: 'verified',
        kind: 'evidence_note',
        noteID: 888,
        ticketID: 1001,
        observedAt: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    );
    await memoryOpStore.releaseLease(accountKey, '1001', 'attempt-1');

    // Seed requirement in requirements store
    await memoryReqStore.set({
      accountKey,
      ticketId: '1001',
      checklistItemId: '501',
      requiredKind: 'evidence_note',
      semanticFingerprint,
      sourceReference: 'spec',
      disabled: false,
      version: 1,
    });

    getById.mockImplementation(async (_entity: string, id: string | number) => {
      if (String(id) === '888') {
        return {
          item: {
            id: 888,
            ticketID: 1001,
            title: 'Verified mesh backhaul',
            description: 'Link confirmed active',
          },
        };
      }
      throw new Error(`Unexpected getById for ${id}`);
    });

    let readCount = 0;
    request.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === 'V1.0/Tickets/1001/ChecklistItems/501') {
        readCount++;
        if (readCount === 1) {
          return {
            item: {
              id: 501,
              ticketID: 1001,
              isCompleted: false,
              itemName: 'Configure mesh backhaul',
            },
          };
        }
        return {
          item: {
            id: 501,
            ticketID: 1001,
            isCompleted: true,
            itemName: 'Configure mesh backhaul',
          },
        };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });

    update.mockResolvedValue({ id: 501 });

    const res = await setChecklistTool.handler({
      ticketID: '1001',
      checklistItemID: '501',
      completed: 'true',
      operationId: 'op-chk-501-done',
      evidenceOperationId: evidenceOpId,
    });

    expect(update).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.updated).toBe(true);
    expect(parsed.isCompleted).toBe(true);
    expect(parsed.evidenceVerified).toBe(true);
    expect(parsed.evidenceOperationId).toBe(evidenceOpId);

    setOperationStore(null);
    setRequirementsStore(null);
  });
});

describe('record-ticket-evidence tool', () => {
  const recordEvidenceTool = ticketWriteTools.find((t) => t.name === 'record-ticket-evidence')!;

  beforeEach(() => {
    vi.resetAllMocks();
    setOperationStore(new MemoryOperationStore());
  });

  afterEach(() => {
    setOperationStore(null);
  });

  it('is registered as destructive and confirm-required with RECORD_TICKET_EVIDENCE', () => {
    expect(DESTRUCTIVE_TOOLS.has('record-ticket-evidence')).toBe(true);
    expect(CONFIRM_REQUIRED_TOOLS.has('record-ticket-evidence')).toBe(true);
    expect(confirmTokenFor('record-ticket-evidence')).toBe('RECORD_TICKET_EVIDENCE');
  });

  it('creates an evidence note, handles { itemId } response, and verifies on readback', async () => {
    getById.mockResolvedValue({ item: { id: 1001, title: 'Test Ticket' } });
    query.mockResolvedValue({ items: [] });
    create.mockResolvedValue({ itemId: 991 });
    request.mockResolvedValue({
      item: {
        id: 991,
        ticketID: 1001,
        title: 'eSIM profile download evidence',
        description: 'Profile ICCID 8901260000000000000 installed.\n[op:esim-claim-1001]',
      },
    });

    const res = await recordEvidenceTool.handler({
      ticketID: '1001',
      title: 'eSIM profile download evidence',
      description: 'Profile ICCID 8901260000000000000 installed.',
      operationId: 'esim-claim-1001',
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('GET', 'V1.0/Tickets/1001/Notes/991');

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.created).toBe(true);
    expect(parsed.noteID).toBe(991);
    expect(parsed.verified).toBe(true);
  });

  it('reconciles prior evidence on retry with same operationId (idempotent)', async () => {
    getById.mockResolvedValue({ item: { id: 1001, title: 'Test Ticket' } });
    query.mockResolvedValue({
      items: [
        {
          id: 991,
          ticketID: 1001,
          title: 'eSIM profile download evidence',
          description: 'Profile ICCID 8901260000000000000 installed.\n[op:esim-claim-1001]',
        },
      ],
    });

    const res = await recordEvidenceTool.handler({
      ticketID: '1001',
      title: 'eSIM profile download evidence',
      description: 'Profile ICCID 8901260000000000000 installed.',
      operationId: 'esim-claim-1001',
    });

    expect(create).not.toHaveBeenCalled();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.created).toBe(false);
    expect(parsed.already_present).toBe(true);
    expect(parsed.reconciled_from_prior_evidence).toBe(true);
    expect(parsed.noteID).toBe(991);
    expect(parsed.verified).toBe(true);
  });

  it('refuses secret credential patterns in evidence note title or description', async () => {
    await expect(
      recordEvidenceTool.handler({
        ticketID: '1001',
        title: 'Wi-Fi password: secret123',
        description: 'Clean description',
        operationId: 'secret-test-1',
      }),
    ).rejects.toThrow(/sensitive credential pattern/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('server integration: permissions and readonly mode', () => {
  it('unregisters write tools in read-only mode', () => {
    process.env.AUTOTASK_READ_ONLY = 'true';
    const server = buildServer();
    process.env.AUTOTASK_READ_ONLY = 'false';

    // In read-only mode, skipped must count them and registered tools omit them
    expect(server.skipped).toBe(17);
  });
  it('withholds write tools from a Service Desk user session (read + create only)', async () => {
    const serviceDeskCapabilities = ['read', 'create'] as const;
    const { server } = buildServer(serviceDeskCapabilities);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'sd-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('append-ticket-resolution');
    expect(names).not.toContain('set-ticket-checklist-item');
    expect(names).toContain('get-ticket-attachment');
    expect(names).toContain('create-ticket');

    await client.close();
  });
});
