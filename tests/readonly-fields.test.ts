import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});
import { AutotaskApi, clearMetadataCache, primeMetadataCache } from '../src/autotask-api.js';
import { ticketChargeTools } from '../src/tools/ticket-charges.js';
import { callApiTool } from '../src/tools/meta.js';
import { governor } from '../src/governor.js';

async function primeGovernor(): Promise<void> {
  governor.reset();
  await governor.assertBudget(async () => ({
    externalRequestThreshold: 10_000,
    currentTimeframeRequestCount: 0,
  }));
}

// Recorded real field metadata for TicketCharges (captured from live Autotask on 2026-10-07)
const RECORDED_TICKET_CHARGES_FIELDS = [
  { name: 'id', isReadOnly: true, isRequired: false },
  { name: 'ticketID', isReadOnly: false, isRequired: true },
  { name: 'chargeType', isReadOnly: false, isRequired: true },
  { name: 'name', isReadOnly: false, isRequired: true },
  { name: 'description', isReadOnly: false, isRequired: false },
  { name: 'datePurchased', isReadOnly: false, isRequired: false },
  { name: 'unitCost', isReadOnly: false, isRequired: false },
  { name: 'unitPrice', isReadOnly: false, isRequired: false },
  { name: 'unitQuantity', isReadOnly: false, isRequired: false },
  { name: 'productID', isReadOnly: false, isRequired: false },
  { name: 'billingCodeID', isReadOnly: false, isRequired: false },
  { name: 'status', isReadOnly: true, isRequired: false },
  { name: 'billableAmount', isReadOnly: true, isRequired: false },
  { name: 'extendedCost', isReadOnly: true, isRequired: false },
  { name: 'createDate', isReadOnly: true, isRequired: false },
  { name: 'creatorResourceID', isReadOnly: true, isRequired: false },
  { name: 'isBilled', isReadOnly: true, isRequired: false },
  { name: 'statusLastModifiedBy', isReadOnly: true, isRequired: false },
  { name: 'statusLastModifiedDate', isReadOnly: true, isRequired: false },
];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
describe('readonly fields validation', () => {
  let fetchMock: Mock;
  let api: AutotaskApi;
  beforeEach(async () => {
    clearMetadataCache();
    await primeGovernor();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    api = new AutotaskApi();
  });

  it('update with status is refused before any request is sent (no PATCH on wire)', async () => {
    primeMetadataCache('Tickets/23836/Charges', RECORDED_TICKET_CHARGES_FIELDS);

    const updateTool = ticketChargeTools.find((t) => t.name === 'update-ticket-charge')!;

    await expect(
      updateTool.handler({
        id: '2711',
        ticketId: '23836',
        fields: JSON.stringify({ id: 2711, status: 8 }),
      }),
    ).rejects.toThrow(
      'Cannot update read-only field(s) on TicketCharges: status. Autotask accepts the request but ignores those fields, so the change has to be made in the Autotask UI.',
    );

    // Verify NO PATCH request was sent on the wire
    const patchCalls = fetchMock.mock.calls.filter(
      ([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writable-only update goes through (PATCH sent on wire)', async () => {
    primeMetadataCache('Tickets/23836/Charges', RECORDED_TICKET_CHARGES_FIELDS);
    fetchMock.mockResolvedValueOnce(jsonResponse({ itemId: 2711 }));

    const updateTool = ticketChargeTools.find((t) => t.name === 'update-ticket-charge')!;

    const res = await updateTool.handler({
      id: '2711',
      ticketId: '23836',
      fields: JSON.stringify({ id: 2711, unitPrice: 75.5 }),
    });

    const patchCalls = fetchMock.mock.calls.filter(
      ([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(1);
    const [url, opts] = patchCalls[0];
    expect(url).toContain('/V1.0/Tickets/23836/Charges');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      id: 2711,
      unitPrice: 75.5,
    });
    expect(JSON.parse(res.content[0].text)).toEqual({ itemId: 2711 });
  });

  it('call_api TicketChargesChild_PatchEntity with status is refused the same way', async () => {
    primeMetadataCache('Tickets/23836/Charges', RECORDED_TICKET_CHARGES_FIELDS);

    await expect(
      callApiTool.handler({
        tool_name: 'TicketChargesChild_PatchEntity',
        args: JSON.stringify({
          parentId: '23836',
          id: '2711',
          status: '8',
        }),
        confirm: 'TICKETCHARGESCHILD_PATCHENTITY',
      }),
    ).rejects.toThrow(
      'Cannot update read-only field(s) on TicketCharges: status. Autotask accepts the request but ignores those fields, so the change has to be made in the Autotask UI.',
    );

    // Verify NO PATCH request was sent on the wire
    const patchCalls = fetchMock.mock.calls.filter(
      ([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('id-only addressing is not refused on update', async () => {
    primeMetadataCache('Tickets/23836/Charges', RECORDED_TICKET_CHARGES_FIELDS);
    fetchMock.mockResolvedValueOnce(jsonResponse({ itemId: 2711 }));

    const updateTool = ticketChargeTools.find((t) => t.name === 'update-ticket-charge')!;

    const res = await updateTool.handler({
      id: '2711',
      ticketId: '23836',
      fields: JSON.stringify({ id: 2711 }),
    });

    const patchCalls = fetchMock.mock.calls.filter(
      ([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(1);
    expect(JSON.parse(res.content[0].text)).toEqual({ itemId: 2711 });
  });

  it('create with read-only field is refused before sending request', async () => {
    primeMetadataCache('Tickets/23836/Charges', RECORDED_TICKET_CHARGES_FIELDS);

    await expect(
      api.create('Tickets/23836/Charges', {
        id: 2711,
        name: 'Labor',
        chargeType: 2,
      }),
    ).rejects.toThrow(
      'Cannot set read-only field(s) on TicketCharges: id. Autotask accepts the request but ignores those fields, so the change has to be made in the Autotask UI.',
    );

    const postCalls = fetchMock.mock.calls.filter(
      ([, opts]) => (opts as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCalls).toHaveLength(0);
  });

  it('fetches metadata on wire when unprimed, then caches for subsequent calls', async () => {
    // 1. Mock entityInformation/fields response
    fetchMock.mockResolvedValueOnce(jsonResponse({ fields: RECORDED_TICKET_CHARGES_FIELDS }));
    // 2. Mock entityInformation/userDefinedFields response
    fetchMock.mockResolvedValueOnce(jsonResponse({ fields: [] }));
    // 3. Mock PATCH response
    fetchMock.mockResolvedValueOnce(jsonResponse({ itemId: 2711 }));

    // First call: unprimed cache -> fetches metadata from wire
    await api.update('Tickets/23836/Charges', { id: 2711, unitPrice: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain(
      '/V1.0/Tickets/23836/Charges/entityInformation/fields',
    );
    expect(fetchMock.mock.calls[1][0]).toContain(
      '/V1.0/Tickets/23836/Charges/entityInformation/userDefinedFields',
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://webservices2.autotask.net/atservicesrest/V1.0/Tickets/23836/Charges',
    );

    // Second call: cached -> makes NO metadata fetch requests, only the PATCH
    fetchMock.mockResolvedValueOnce(jsonResponse({ itemId: 2712 }));
    await api.update('Tickets/23836/Charges', { id: 2712, unitPrice: 120 });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][0]).toBe(
      'https://webservices2.autotask.net/atservicesrest/V1.0/Tickets/23836/Charges',
    );
  });

  it('refuses read-only user-defined fields', async () => {
    primeMetadataCache(
      'Tickets',
      [
        { name: 'id', isReadOnly: true },
        { name: 'title', isReadOnly: false },
      ],
      [{ name: 'CustomApproval', isReadOnly: true }],
    );

    await expect(
      api.update('Tickets', {
        id: 100,
        userDefinedFields: [{ name: 'CustomApproval', value: 'Approved' }],
      }),
    ).rejects.toThrow(
      'Cannot update read-only field(s) on Tickets: CustomApproval. Autotask accepts the request but ignores those fields, so the change has to be made in the Autotask UI.',
    );

    const patchCalls = fetchMock.mock.calls.filter(
      ([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(0);
  });
});
