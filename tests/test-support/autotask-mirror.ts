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

  public requestLog: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body?: unknown;
  }> = [];
  public idCounter = 1000;

  // Fault injection hooks
  public simulateConcurrentResolutionModification: string | null = null;
  public simulate500OnWrite = false;

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
    this.requestLog = [];
    this.simulateConcurrentResolutionModification = null;
    this.simulate500OnWrite = false;
  }

  async start(): Promise<{ url: string; port: number }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ url: string; port: number }>();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.on('error', (err) => {
      reject(err);
    });

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
    req.on('end', () => {
      const bodyRaw = Buffer.concat(chunks).toString('utf-8');
      let body: unknown;
      if (bodyRaw) {
        try {
          body = JSON.parse(bodyRaw);
        } catch {
          body = bodyRaw;
        }
      }

      this.requestLog.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
        body,
      });

      this.route(req, res, body);
    });
  }
  private route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, unknown> | undefined,
  ): void {
    const url = req.url || '/';
    const method = req.method?.toUpperCase() || 'GET';
    // Helper to send json
    const sendJson = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    // 1. Zone Information (public/unauthenticated probe)
    if (url.includes('/V1.0/zoneInformation')) {
      sendJson(200, { zoneName: 'mirror-zone', url: this.baseUrl });
      return;
    }

    // Verify auth headers on all other endpoints
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

    // 2. Threshold Information (governor budget probe)
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
    // GET /V1.0/Tickets/:ticketId/ChecklistItems/:itemId
    const checklistItemMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/ChecklistItems\/(\d+)/);
    if (checklistItemMatch && method === 'GET') {
      const itemId = Number(checklistItemMatch[2]);
      const item = this.checklistItems.get(itemId);
      if (!item) {
        sendJson(404, { message: `Checklist item ${itemId} not found` });
        return;
      }
      sendJson(200, { item });
      return;
    }

    // PATCH /V1.0/Tickets/:ticketId/ChecklistItems
    const checklistChildMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/ChecklistItems$/);
    if (checklistChildMatch && method === 'PATCH') {
      const ticketId = Number(checklistChildMatch[1]);
      const itemId = Number(body?.id);
      const existing = this.checklistItems.get(itemId);
      if (!existing) {
        sendJson(404, { message: `Checklist item ${itemId} not found` });
        return;
      }
      if (existing.ticketID !== ticketId) {
        sendJson(400, {
          message: `Item ${itemId} belongs to ticket ${existing.ticketID}, not ${ticketId}`,
        });
        return;
      }
      if (body?.isCompleted !== undefined) {
        existing.isCompleted = Boolean(body.isCompleted);
        existing.completedDateTime = existing.isCompleted ? new Date().toISOString() : null;
      }
      sendJson(200, { item: existing });
      return;
    }

    // 5. Ticket Attachments
    // GET /V1.0/Tickets/:ticketId/Attachments/:attachmentId
    const attachmentItemMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/Attachments\/(\d+)/);
    if (attachmentItemMatch && method === 'GET') {
      const attachmentId = Number(attachmentItemMatch[2]);
      const att = this.attachments.get(attachmentId);
      if (!att) {
        sendJson(404, { message: `Attachment ${attachmentId} not found` });
        return;
      }
      sendJson(200, { item: att });
      return;
    }

    // POST /V1.0/Tickets/:ticketId/Attachments
    if (url.match(/\/V1\.0\/Tickets\/(\d+)\/Attachments$/) && method === 'POST') {
      const tMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/Attachments$/)!;
      const ticketId = Number(tMatch[1]);
      const newId = ++this.idCounter;
      const title = typeof body?.title === 'string' ? body.title : 'attachment';
      const contentType =
        typeof body?.contentType === 'string' ? body.contentType : 'application/octet-stream';
      const data = typeof body?.data === 'string' ? body.data : '';
      const newAtt: MirrorAttachment = {
        id: newId,
        ticketID: ticketId,
        title,
        contentType,
        fileSize: data ? Buffer.byteLength(data, 'base64') : 0,
        data,
      };
      this.attachments.set(newId, newAtt);
      sendJson(200, { item: newAtt, itemId: newId });
      return;
    }

    // 6. Ticket Notes
    // GET /V1.0/Tickets/:ticketId/Notes/:noteId or GET /V1.0/TicketNotes/:noteId
    const noteMatch = url.match(/\/V1\.0\/(?:Tickets\/\d+\/Notes|TicketNotes)\/(\d+)/);
    if (noteMatch && method === 'GET') {
      const noteId = Number(noteMatch[1]);
      const note = this.notes.get(noteId);
      if (!note) {
        sendJson(404, { message: `Note ${noteId} not found` });
        return;
      }
      sendJson(200, { item: note });
      return;
    }

    // POST /V1.0/Tickets/:ticketId/Notes
    if (url.match(/\/V1\.0\/Tickets\/(\d+)\/Notes$/) && method === 'POST') {
      const tMatch = url.match(/\/V1\.0\/Tickets\/(\d+)\/Notes$/)!;
      const ticketId = Number(tMatch[1]);
      const title = typeof body?.title === 'string' ? body.title : 'Note';
      const description = typeof body?.description === 'string' ? body.description : '';
      const noteType = typeof body?.noteType === 'number' ? body.noteType : 1;
      const publish = typeof body?.publish === 'number' ? body.publish : 1;
      const newNote: MirrorNote = {
        id: newId,
        ticketID: ticketId,
        title,
        description,
        noteType,
        publish,
      };
      sendJson(200, { item: newNote, itemId: newId });
      return;
    }

    // POST /V1.0/TicketNotes/query
    if (url.includes('/V1.0/TicketNotes/query') && method === 'POST') {
      let filteredNotes = Array.from(this.notes.values());
      const filter = Array.isArray(body?.filter) ? body.filter : [];
      const ticketClause = filter.find(
        (c): c is { op?: string; field?: unknown; value?: unknown } => {
          if (c && typeof c === 'object' && 'field' in c) {
            return c.field === 'ticketID';
          }
          return false;
        },
      );
      if (ticketClause && ticketClause.value !== undefined) {
        filteredNotes = filteredNotes.filter((n) => n.ticketID === Number(ticketClause.value));
      }
      sendJson(200, { items: filteredNotes, pageDetails: { count: filteredNotes.length } });
      return;
    }

    // 7. Tickets
    // GET /V1.0/Tickets/:id
    const ticketMatch = url.match(/\/V1\.0\/Tickets\/(\d+)$/);
    if (ticketMatch && method === 'GET') {
      const ticketId = Number(ticketMatch[1]);
      const ticket = this.tickets.get(ticketId);
      if (!ticket) {
        sendJson(404, { message: `Ticket ${ticketId} not found` });
        return;
      }
      sendJson(200, { item: ticket });
      return;
    }

    // PATCH /V1.0/Tickets
    if (url.match(/\/V1\.0\/Tickets$/) && method === 'PATCH') {
      const ticketId = Number(body?.id);
      const ticket = this.tickets.get(ticketId);
      if (!ticket) {
        sendJson(404, { message: `Ticket ${ticketId} not found` });
        return;
      }

      // If concurrent modification simulation is active
      if (this.simulateConcurrentResolutionModification !== null) {
        ticket.resolution = this.simulateConcurrentResolutionModification;
      }

      if (typeof body?.resolution === 'string') {
        ticket.resolution = body.resolution;
      }
      return;
    }

    sendJson(404, { message: `Not found in mirror: ${method} ${url}` });
  }
}
