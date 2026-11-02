import http from 'node:http';
import { AddressInfo } from 'node:net';

export interface MirrorTicket {
  id: number;
  ticketNumber?: string;
  title?: string;
  description?: string;
  resolution?: string;
  companyID?: number;
  status?: number;
  [key: string]: unknown;
}

export interface MirrorChecklistItem {
  id: number;
  ticketID: number;
  itemName: string;
  isCompleted: boolean;
  position?: number | null;
  completedDateTime?: string | null;
  completedByResourceID?: number | null;
  [key: string]: unknown;
}

export interface MirrorAttachment {
  id: number;
  ticketID: number;
  title: string;
  contentType: string;
  fileSize?: number;
  data: string; // base64
  attachmentType?: string;
  [key: string]: unknown;
}

export interface MirrorNote {
  id: number;
  ticketID: number;
  title: string;
  description: string;
  noteType?: number;
  publish?: number;
  [key: string]: unknown;
}

/**
 * Grounded stateful HTTP vendor mirror for Autotask REST API (V1.0).
 * Speaks the real wire format, maintains isolated state, and validates
 * parent ticket scoping and auth headers.
 */
export class AutotaskMirror {
  public server: http.Server | null = null;
  public port = 0;
  public baseUrl = '';

  public tickets = new Map<number, MirrorTicket>();
  public checklistItems = new Map<number, MirrorChecklistItem>();
  public attachments = new Map<number, MirrorAttachment>();
  public notes = new Map<number, MirrorNote>();

  public arrivalJournal: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body?: unknown;
    receivedAt: number;
  }> = [];

  public appliedJournal: Array<{
    method: string;
    entity: string;
    id: number;
    details: Record<string, unknown>;
    appliedAt: number;
  }> = [];

  public idCounter = 1000;

  // Fault injection hooks
  public simulateConcurrentResolutionModification: string | null = null;
  public simulate500OnWrite = false;
  public simulateNetworkDropOnWrite = false;
  public simulateHeldBeforeApplyMs = 0;

  constructor() {}

  seedTicket(ticket: MirrorTicket): void {
    this.tickets.set(Number(ticket.id), { ...ticket });
  }

  seedChecklistItem(item: MirrorChecklistItem): void {
    this.checklistItems.set(Number(item.id), { ...item });
  }

  seedAttachment(attachment: MirrorAttachment): void {
    this.attachments.set(Number(attachment.id), { ...attachment });
  }

  seedNote(note: MirrorNote): void {
    this.notes.set(Number(note.id), { ...note });
  }

  reset(): void {
    this.tickets.clear();
    this.checklistItems.clear();
    this.attachments.clear();
    this.notes.clear();
    this.arrivalJournal = [];
    this.appliedJournal = [];
    this.simulateConcurrentResolutionModification = null;
    this.simulate500OnWrite = false;
    this.simulateNetworkDropOnWrite = false;
    this.simulateHeldBeforeApplyMs = 0;
  }

  async start(): Promise<{ url: string; port: number }> {
    const { promise, resolve, reject } = Promise.withResolvers<{
      url: string;
      port: number;
    }>();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.on('error', reject);

    this.server.listen(0, '127.0.0.1', () => {
      const addr = this.server?.address() as AddressInfo;
      this.port = addr.port;
      this.baseUrl = `http://127.0.0.1:${this.port}/atservicesrest/`;
      resolve({ url: this.baseUrl, port: this.port });
    });

    return promise;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.close(() => {
      this.server = null;
      resolve();
    });
    return promise;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const bodyRaw = Buffer.concat(chunks).toString('utf-8');
      let body: unknown;
      if (bodyRaw) {
        try {
          body = JSON.parse(bodyRaw);
        } catch {
          body = bodyRaw;
        }
      }

      this.arrivalJournal.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
        body,
        receivedAt: Date.now(),
      });

      if (this.simulateHeldBeforeApplyMs > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, this.simulateHeldBeforeApplyMs);
        await promise;
      }

      this.route(req, res, body as Record<string, unknown> | undefined);
    });
  }

  private route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, unknown> | undefined,
  ): void {
    const url = req.url || '/';
    const method = req.method?.toUpperCase() || 'GET';

    const sendJson = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    // 1. Zone Information
    if (url.includes('/V1.0/zoneInformation')) {
      sendJson(200, { zoneName: 'mirror-zone', url: this.baseUrl });
      return;
    }

    // Verify auth headers
    const hasAuth =
      Boolean(req.headers['apiintegrationcode']) &&
      Boolean(req.headers['username']) &&
      Boolean(req.headers['secret']);
    if (!hasAuth) {
      sendJson(401, { message: 'Missing Autotask API authentication headers' });
      return;
    }

    if (this.simulate500OnWrite && (method === 'PATCH' || method === 'POST')) {
      sendJson(500, { message: 'Internal Server Error (simulated)' });
      return;
    }

    if (this.simulateNetworkDropOnWrite && (method === 'PATCH' || method === 'POST')) {
      req.socket.destroy();
      return;
    }

    // 2. Threshold Information
    if (url.includes('/V1.0/ThresholdInformation')) {
      sendJson(200, {
        item: {
          externalRequestCountLimit: 10000,
          externalRequestCountRemaining: 9999,
          clientHourStart: new Date().toISOString(),
        },
      });
      return;
    }

    // 3. Field definitions
    if (url.includes('/V1.0/Tickets/entityInformation/fields')) {
      sendJson(200, {
        fields: [
          { name: 'resolution', length: 5000, isRequired: false },
          { name: 'title', length: 255, isRequired: true },
        ],
      });
      return;
    }

    if (url.includes('/V1.0/TicketNotes/entityInformation/fields')) {
      sendJson(200, {
        fields: [
          { name: 'title', length: 250, isRequired: false },
          { name: 'description', length: 32000, isRequired: true },
        ],
      });
      return;
    }

    // 4. Ticket Checklist Items
    const checklistItemMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/ChecklistItems\/(\d+)/);
    if (checklistItemMatch && method === 'GET') {
      const ticketId = Number(checklistItemMatch[1]);
      const itemId = Number(checklistItemMatch[2]);
      const item = this.checklistItems.get(itemId);
      if (!item || item.ticketID !== ticketId) {
        sendJson(404, { message: `ChecklistItem ${itemId} not found on ticket ${ticketId}` });
        return;
      }
      sendJson(200, { item });
      return;
    }

    // PATCH /V1.0/Tickets/:ticketId/ChecklistItems
    const checklistPatchMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/ChecklistItems/);
    if (checklistPatchMatch && method === 'PATCH') {
      const ticketId = Number(checklistPatchMatch[1]);
      const itemId = Number(body?.id);
      const item = this.checklistItems.get(itemId);
      if (!item || item.ticketID !== ticketId) {
        sendJson(404, { message: `ChecklistItem ${itemId} not found on ticket ${ticketId}` });
        return;
      }

      if (body?.isCompleted !== undefined) {
        item.isCompleted = Boolean(body.isCompleted);
      }

      this.appliedJournal.push({
        method: 'PATCH',
        entity: 'ChecklistItem',
        id: itemId,
        details: { isCompleted: item.isCompleted },
        appliedAt: Date.now(),
      });

      sendJson(200, { itemId, item });
      return;
    }

    // 5. Ticket Attachments
    const attachmentGetMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/Attachments\/(\d+)/);
    if (attachmentGetMatch && method === 'GET') {
      const ticketId = Number(attachmentGetMatch[1]);
      const attId = Number(attachmentGetMatch[2]);
      const att = this.attachments.get(attId);
      if (!att || att.ticketID !== ticketId) {
        sendJson(404, { message: `Attachment ${attId} not found on ticket ${ticketId}` });
        return;
      }
      sendJson(200, { item: att });
      return;
    }

    // 6. Ticket Notes query
    if (url.includes('/V1.0/TicketNotes/query') && method === 'POST') {
      const filter = (body as { filter?: Array<{ field?: string; value?: unknown }> })?.filter;
      const ticketFilter = filter?.find((f) => f.field === 'ticketID');
      const ticketId = ticketFilter ? Number(ticketFilter.value) : null;

      const matchingNotes: MirrorNote[] = [];
      for (const note of this.notes.values()) {
        if (ticketId === null || note.ticketID === ticketId) {
          matchingNotes.push(note);
        }
      }

      sendJson(200, {
        items: matchingNotes,
        pageDetails: { count: matchingNotes.length },
      });
      return;
    }

    // GET /V1.0/Tickets/:ticketId/Notes/:noteId
    const noteGetMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/Notes\/(\d+)/);
    if (noteGetMatch && method === 'GET') {
      const ticketId = Number(noteGetMatch[1]);
      const noteId = Number(noteGetMatch[2]);
      const note = this.notes.get(noteId);
      if (!note || note.ticketID !== ticketId) {
        sendJson(404, { message: `Note ${noteId} not found on ticket ${ticketId}` });
        return;
      }
      sendJson(200, { item: note });
      return;
    }

    // POST /V1.0/Tickets/:ticketId/Notes
    const notePostMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/Notes/);
    if (notePostMatch && method === 'POST') {
      const ticketId = Number(notePostMatch[1]);
      const noteId = ++this.idCounter;
      const note: MirrorNote = {
        id: noteId,
        ticketID: ticketId,
        title: String(body?.title || 'Note'),
        description: String(body?.description || ''),
        noteType: Number(body?.noteType || 1),
        publish: Number(body?.publish || 1),
      };
      this.notes.set(noteId, note);

      this.appliedJournal.push({
        method: 'POST',
        entity: 'TicketNote',
        id: noteId,
        details: { ...note },
        appliedAt: Date.now(),
      });

      sendJson(200, { itemId: noteId, item: note });
      return;
    }

    // 7. Tickets CRUD & Resolution
    const ticketGetMatch = url.match(/\/V1\.0\/Tickets\/(\d+)/);
    if (ticketGetMatch && method === 'GET') {
      const ticketId = Number(ticketGetMatch[1]);
      const ticket = this.tickets.get(ticketId);
      if (!ticket) {
        sendJson(404, { message: `Ticket ${ticketId} not found` });
        return;
      }

      if (this.simulateConcurrentResolutionModification) {
        ticket.resolution = `${ticket.resolution || ''}\n${this.simulateConcurrentResolutionModification}`;
        this.simulateConcurrentResolutionModification = null;
      }

      sendJson(200, { item: ticket });
      return;
    }

    // PATCH /V1.0/Tickets
    if (url.includes('/V1.0/Tickets') && method === 'PATCH') {
      const ticketId = Number(body?.id);
      const ticket = this.tickets.get(ticketId);
      if (!ticket) {
        sendJson(404, { message: `Ticket ${ticketId} not found` });
        return;
      }

      if (body?.resolution !== undefined) {
        ticket.resolution = String(body.resolution);
      }

      this.appliedJournal.push({
        method: 'PATCH',
        entity: 'Ticket',
        id: ticketId,
        details: { resolution: ticket.resolution },
        appliedAt: Date.now(),
      });

      sendJson(200, { itemId: ticketId, item: ticket });
      return;
    }

    sendJson(404, { message: `Endpoint not found: ${method} ${url}` });
  }
}
