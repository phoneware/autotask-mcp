import type { ToolDefinition } from '../types.js';
import { genericTools } from './generic.js';
import { ticketTools } from './tickets.js';
import { ticketChargeTools } from './ticket-charges.js';
import { companyTools } from './companies.js';
import { contactTools } from './contacts.js';
import { projectTools } from './projects.js';
import { timeEntryTools } from './timeentries.js';
import { contractTools } from './contracts.js';
import { invoiceTools } from './invoices.js';
import { identityTools } from './identity.js';
import { metaTools } from './meta.js';

export const allTools: ToolDefinition[] = [
  ...identityTools,
  ...metaTools,
  ...genericTools,
  ...ticketTools,
  ...ticketChargeTools,
  ...companyTools,
  ...contactTools,
  ...projectTools,
  ...timeEntryTools,
  ...contractTools,
  ...invoiceTools,
];
