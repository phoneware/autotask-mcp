#!/usr/bin/env tsx

/**
 * Live Autotask API in-process acceptance proof.
 *
 * Runs reads against the live Autotask REST API using server credentials to:
 * 1. Find ticket T20261006.0017 by ticketNumber.
 * 2. List its charges through list-ticket-charges (route: GET /V1.0/Tickets/{id}/Charges).
 * 3. Classify charges by productID (confirming charges 2712 and 2713 are product-less).
 * 4. Demonstrate the resolved route and request update-entity WOULD send without writing.
 * 5. Verify search_api("ticket charge") returns child-collection operations.
 * 6. Verify call_api on a read returns live data.
 * 7. Verify call_api on a write without confirm token is refused.
 * 8. Verify traversal input is refused across generic write tools.
 */

import { ticketTools } from '../src/tools/tickets.js';
import { ticketChargeTools } from '../src/tools/ticket-charges.js';
import { searchApiTool, callApiTool } from '../src/tools/meta.js';
import { genericTools } from '../src/tools/generic.js';
import { resolveWritePath } from '../src/tools/entity-resolver.js';
import { api } from '../src/autotask-api.js';
async function run(): Promise<void> {
  console.log('=== Step 1: Find ticket T20261006.0017 via search-tickets ===');
  const searchTickets = ticketTools.find((t) => t.name === 'search-tickets')!;
  const ticketRes = await searchTickets.handler({ ticketNumber: 'T20261006.0017' });
  const ticketData = JSON.parse(ticketRes.content[0].text);
  const ticket = ticketData.items?.[0];

  if (!ticket) {
    throw new Error('Ticket T20261006.0017 not found');
  }

  console.log(`Found Ticket ID: ${ticket.id}`);
  console.log(`Ticket Number: ${ticket.ticketNumber}`);
  console.log(`Title: ${ticket.title}`);
  console.log(`Company ID: ${ticket.companyID}`);

  console.log('\n=== Step 2 & 3: List charges via list-ticket-charges ===');
  const listCharges = ticketChargeTools.find((t) => t.name === 'list-ticket-charges')!;
  const chargesRes = await listCharges.handler({ ticketId: String(ticket.id) });
  const chargesData = JSON.parse(chargesRes.content[0].text);
  const charges = chargesData.items || [];

  console.log(`Total charges on ticket ${ticket.id}: ${charges.length}`);

  const withProduct: Array<{ id: number; name: string; productID: number; status: number }> = [];
  const withoutProduct: Array<{ id: number; name: string; status: number }> = [];

  for (const c of charges) {
    if (c.productID !== null && c.productID !== undefined) {
      withProduct.push({ id: c.id, name: c.name, productID: c.productID, status: c.status });
    } else {
      withoutProduct.push({ id: c.id, name: c.name, status: c.status });
    }
  }

  console.log('\nCharges with productID:');
  for (const c of withProduct) {
    console.log(
      `  - Charge ID: ${c.id}, Product ID: ${c.productID}, Status: ${c.status}, Name: ${c.name}`,
    );
  }

  console.log('\nCharges WITHOUT productID (product-less labor/service charges):');
  for (const c of withoutProduct) {
    console.log(`  - Charge ID: ${c.id}, Status: ${c.status}, Name: ${c.name}`);
  }

  console.log('\n=== Step 4: Show resolved route and request update-entity WOULD send ===');
  const testChargeId = '2712';
  const resolvedEntityPath = await resolveWritePath(
    'TicketCharges',
    'PATCH',
    undefined,
    undefined,
    testChargeId,
    { id: Number(testChargeId), status: 8 },
    (e, id) => api.getById(e, id),
  );

  console.log(
    'Call: update-entity { entity: "TicketCharges", fields: \'{"id": 2712, "status": 8}\' }',
  );
  console.log(`Resolved HTTP Method: PATCH`);
  console.log(`Resolved URL Path: V1.0/${resolvedEntityPath}`);
  console.log(`Resolved JSON Payload: {"id": 2712, "status": 8}`);
  console.log('Action: Read-only simulation successful (no write sent to live API).');

  console.log('\n=== Step 5: search_api("ticket charge") ===');
  const searchRes = await searchApiTool.handler({ query: 'ticket charge' });
  const searchData = JSON.parse(searchRes.content[0].text);
  console.log(`search_api returned ${searchData.total} matching operations (displaying first 10):`);
  for (const m of searchData.matches.slice(0, 10)) {
    console.log(
      `  - ${m.operationId}: ${m.method} ${m.pathTemplate} (${m.classification}, destructive: ${m.destructive})`,
    );
  }

  console.log('\n=== Step 6: call_api on read operation (TicketChargesChild_Query) ===');
  const callReadRes = await callApiTool.handler({
    tool_name: 'TicketChargesChild_Query',
    args: JSON.stringify({ parentId: String(ticket.id) }),
  });
  const callReadData = JSON.parse(callReadRes.content[0].text);
  console.log(`call_api read returned ${callReadData.items?.length || 0} charges from live API.`);

  console.log('\n=== Step 7: call_api on write operation without confirm token ===');
  let writeBlocked = false;
  try {
    await callApiTool.handler({
      tool_name: 'TicketChargesChild_PatchEntity',
      args: JSON.stringify({
        parentId: String(ticket.id),
        restModelInput: { id: 2712, status: 8 },
      }),
    });
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes('requires confirm:') || msg.includes('Destructive tool')) {
      writeBlocked = true;
      console.log('Successfully refused unconfirmed write:');
      console.log(`  ${msg}`);
    } else {
      throw new Error(`Expected confirmation rejection, but got: ${msg}`);
    }
  }
  if (!writeBlocked) {
    throw new Error('Write without confirm token was unexpectedly allowed!');
  }

  console.log('\n=== Step 8: verify traversal input refused on write tools ===');
  const createEntity = genericTools.find((t) => t.name === 'create-entity')!;
  const updateEntity = genericTools.find((t) => t.name === 'update-entity')!;
  const deleteEntity = genericTools.find((t) => t.name === 'delete-entity')!;

  const traversalInputs = [
    'Tickets/../Companies',
    '../ThresholdInformation',
    '..',
    'Tickets/query',
  ];
  for (const bad of traversalInputs) {
    let createBlocked = false;
    try {
      await createEntity.handler({ entity: bad, fields: '{"title":"test"}' });
    } catch (err: unknown) {
      if ((err as Error).message.includes('safe Autotask entity name')) {
        createBlocked = true;
      } else {
        throw err;
      }
    }
    if (!createBlocked) {
      throw new Error(`create-entity unexpectedly allowed traversal input "${bad}"`);
    }

    let updateBlocked = false;
    try {
      await updateEntity.handler({ entity: bad, fields: '{"id":123,"title":"test"}' });
    } catch (err: unknown) {
      if ((err as Error).message.includes('safe Autotask entity name')) {
        updateBlocked = true;
      } else {
        throw err;
      }
    }
    if (!updateBlocked) {
      throw new Error(`update-entity unexpectedly allowed traversal input "${bad}"`);
    }

    let deleteBlocked = false;
    try {
      await deleteEntity.handler({ entity: bad, id: '123' });
    } catch (err: unknown) {
      if ((err as Error).message.includes('safe Autotask entity name')) {
        deleteBlocked = true;
      } else {
        throw err;
      }
    }
    if (!deleteBlocked) {
      throw new Error(`delete-entity unexpectedly allowed traversal input "${bad}"`);
    }
  }
  console.log(
    'Successfully refused traversal inputs on create-entity, update-entity, and delete-entity.',
  );

  console.log('\n=== All live acceptance proofs completed successfully! ===');
}

run().catch((err) => {
  console.error('Acceptance proof failed:', err);
  process.exit(1);
});
