/**
 * Who am I acting as?
 *
 * Everything this server writes to Autotask is attributed to a specific person,
 * and what it will let you write depends on that person's Autotask security
 * level. Both of those were previously invisible: you could not tell which
 * Google account a session had latched onto, nor why a tool was missing. This
 * makes the answer askable.
 */

import { ToolDefinition } from '../types.js';
import { jsonResponse } from './shared.js';
import { currentCaller } from '../auth/context.js';
import { ALL_CAPABILITIES, labelForUserType } from '../auth/capabilities.js';
import { capabilityForTool, TOOL_CAPABILITY } from '../security.js';

export const identityTools: ToolDefinition[] = [
  {
    name: 'whoami',
    title: 'Who Am I',
    description:
      'Report which Autotask person this session is acting as, the Autotask security level ' +
      'behind that, and which operations are permitted. Use this to explain why a write was ' +
      'refused or a tool is unavailable.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const caller = currentCaller();
      if (!caller) {
        return jsonResponse({
          authenticated: false,
          note:
            'This session carries no signed-in identity. Over stdio that is expected: the ' +
            'process runs as its operator and writes are attributed to the Autotask API user.',
        });
      }

      const granted = ALL_CAPABILITIES.filter((c) => caller.capabilities.includes(c));
      const withheld = ALL_CAPABILITIES.filter((c) => !caller.capabilities.includes(c));

      return jsonResponse({
        authenticated: true,
        email: caller.email,
        autotaskResourceId: caller.resourceId,
        autotaskSecurityLevel: labelForUserType(caller.userType),
        capabilities: granted,
        withheld,
        unavailableTools: [...TOOL_CAPABILITY.keys()]
          .filter((name) => !caller.capabilities.includes(capabilityForTool(name)))
          .sort(),
        note:
          'Capabilities come from your Autotask security level. The Autotask REST API only ' +
          'authenticates as a single API user, so this server enforces your rights itself; ' +
          'Autotask cannot do it for us. An Autotask administrator changes your security level.',
      });
    },
  },
];
