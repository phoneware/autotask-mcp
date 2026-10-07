export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface ToolContext {
  server?: unknown;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; [key: string]: unknown }>;
    required?: string[];
  };
  handler: (args: Record<string, string>, context?: ToolContext) => Promise<ToolResponse>;
}
export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** Autotask zoneInformation response (unauthenticated lookup). */
export interface ZoneInformation {
  zoneName: string;
  url: string;
  webUrl: string;
  ci: number;
}

/** Shape of a paginated Autotask query response. */
export interface AutotaskQueryResponse {
  items: unknown[];
  pageDetails: {
    count: number;
    requestCount: number;
    prevPageUrl: string | null;
    nextPageUrl: string | null;
  };
}
