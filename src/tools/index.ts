import { ToolDefinition } from '../types.js';
import { genericTools } from './generic.js';
import { ticketTools } from './tickets.js';
import { companyTools } from './companies.js';
import { contactTools } from './contacts.js';
import { projectTools } from './projects.js';
import { timeEntryTools } from './timeentries.js';
import { identityTools } from './identity.js';

export const allTools: ToolDefinition[] = [
  ...identityTools,
  ...genericTools,
  ...ticketTools,
  ...companyTools,
  ...contactTools,
  ...projectTools,
  ...timeEntryTools,
];
