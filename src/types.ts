export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  handler: (args: Record<string, string>) => Promise<ToolResponse>;
}

export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
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
