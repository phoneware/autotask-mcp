#!/usr/bin/env tsx

/**
 * Autotask PSA OpenAPI to MCP Registry Generator
 *
 * Reads the Autotask PSA REST API specification (Swagger 2.0) and generates:
 * 1. src/generated/types.ts: Type definitions for operations and child collections
 * 2. src/generated/registry.ts: Full typed registry of all 3,014 reachable operations
 * 3. docs/api-coverage.html: Coverage and parity report across operations
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = join(rootDir, 'spec', 'autotask-swagger-v1.json');
const generatedDir = join(rootDir, 'src', 'generated');
const docsDir = join(rootDir, 'docs');

/**
 * Generation-time exclusion list for credential and infrastructure operations.
 *
 * 1. AuthenticateApiIntegration_QueryAuthenticate (/V1.0/Authenticate):
 *    Credential test/verification endpoint. The MCP server manages credentials
 *    via environment variables and secret stores; exposing this to AI clients
 *    creates credential confusion and security risks.
 * 2. ZoneInformationApiIntegration_QueryZoneInformation (/V1.0/ZoneInformation):
 *    Internal datacenter zone discovery endpoint. Used internally by the REST client
 *    to resolve the correct base URL during initialization; not an application entity.
 * 3. ApiVersion_ApiVersionInformation (/VersionInformation):
 *    Unversioned root version endpoint redundant with /V1.0/Version.
 */
export const EXCLUDED_OPERATIONS: Record<string, true> = {
 AuthenticateApiIntegration_QueryAuthenticate: true,
 ZoneInformationApiIntegration_QueryZoneInformation: true,
 ApiVersion_ApiVersionInformation: true,
};

/**
 * Authentication headers injected by the client rather than the tool caller.
 * Stripped from every generated parameter schema.
 */
export const AUTH_HEADER_PARAMS: Record<string, true> = {
 ApiIntegrationCode: true,
 UserName: true,
 Secret: true,
 ImpersonationResourceId: true,
};

interface SwaggerParam {
 name: string;
 in: 'path' | 'query' | 'header' | 'body';
 description?: string;
 required?: boolean;
 type?: string;
 format?: string;
 schema?: {
  $ref?: string;
  type?: string;
  properties?: Record<string, unknown>;
 };
}

interface SwaggerOperation {
 operationId: string;
 summary?: string;
 description?: string;
 tags?: string[];
 parameters?: SwaggerParam[];
 responses?: Record<string, { description?: string; schema?: { $ref?: string; type?: string } }>;
}

interface SwaggerSpec {
 swagger: string;
 info: { title: string; version: string };
 paths: Record<string, Record<string, SwaggerOperation>>;
 definitions: Record<
  string,
  {
   type?: string;
   properties?: Record<
    string,
    {
     type?: string;
     format?: string;
     description?: string;
     $ref?: string;
     readOnly?: boolean;
    }
   >;
  }
 >;
}

export interface GeneratedParam {
 name: string;
 in: 'path' | 'query' | 'body';
 required: boolean;
 type: string;
 description?: string;
 schemaRef?: string;
}

export interface GeneratedOperation {
 operationId: string;
 method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
 pathTemplate: string;
 entity: string;
 parentEntity?: string;
 childAlias?: string;
 parentFkField?: string;
 parameters: GeneratedParam[];
 requestModelRef?: string;
 classification: 'read' | 'write';
 destructive: boolean;
 tag?: string;
 summary?: string;
 description?: string;
}

export interface GeneratedChildCollection {
 parentEntity: string;
 childAlias: string;
 entity: string;
 parentFkField?: string;
 childModel?: string;
 methods: string[];
}

function loadSpec(): SwaggerSpec {
 const content = readFileSync(specPath, 'utf8');
 return JSON.parse(content) as SwaggerSpec;
}

/**
 * Extract model name from a schema reference or response object.
 */
function extractModelName(schema?: { $ref?: string; type?: string }): string | undefined {
 if (!schema?.$ref) return undefined;
 const ref = schema.$ref.replace('#/definitions/', '');
 const matchQuery = ref.match(/QueryActionResult\[([^,\]]+)/);
 if (matchQuery) return matchQuery[1];
 if (ref.endsWith('Model')) return ref;
 return ref;
}

/**
 * Derive parent foreign key field on a child model from the spec.
 */
function findParentFk(
 spec: SwaggerSpec,
 modelName: string | undefined,
 parentEntity: string,
): string | undefined {
 if (!modelName || !spec.definitions[modelName]?.properties) return undefined;
 const props = Object.keys(spec.definitions[modelName].properties || {});
 const parentLower = parentEntity.toLowerCase();
 const singularParent = parentLower.endsWith('ies')
  ? parentLower.slice(0, -3) + 'y'
  : parentLower.endsWith('s')
   ? parentLower.slice(0, -1)
   : parentLower;

 // Exact matches: ticketID, companyID, contractID, projectID
 for (const pr of props) {
  const prLower = pr.toLowerCase();
  if (prLower === parentLower + 'id' || prLower === singularParent + 'id') {
   return pr;
  }
 }

 // Suffix matches: articleCategoryID for KnowledgeBaseCategories, webhookID for Webhooks
 for (const pr of props) {
  const prLower = pr.toLowerCase();
  if (prLower.endsWith(parentLower + 'id') || prLower.endsWith(singularParent + 'id')) {
   return pr;
  }
 }

 // Irregular Autotask entity names
 for (const pr of props) {
  const prLower = pr.toLowerCase();
  if (parentLower === 'expenses' && prLower === 'expensereportid') return pr;
  if (parentLower === 'purchaseorders' && prLower === 'orderid') return pr;
  if (parentLower === 'knowledgebasearticles' && prLower === 'articleid') return pr;
  if (parentLower === 'knowledgebasecategories' && prLower === 'articlecategoryid') return pr;
  if (parentLower.endsWith('webhooks') && prLower === 'webhookid') return pr;
 }

 return undefined;
}

function generate(): void {
 console.log('Loading Autotask Swagger specification...');
 const spec = loadSpec();
 console.log(`Loaded spec: ${spec.info.title} (${spec.info.version})`);

 // 1. Map flat entities to models
 const flatEntityToModel = new Map<string, string>();
 const modelToFlatEntities = new Map<string, Set<string>>();

 for (const [path, pathItem] of Object.entries(spec.paths)) {
  const matchFlat = path.match(/^\/V[0-9.]+\/([A-Za-z0-9_]+)(\/query)?$/);
  if (!matchFlat) continue;
  const entity = matchFlat[1];
  for (const m of ['post', 'get', 'patch', 'put']) {
   const op = pathItem[m];
   if (!op) continue;
   let model: string | undefined;
   for (const param of op.parameters || []) {
    if (param.in === 'body' && param.schema?.$ref) {
     model = extractModelName(param.schema);
     break;
    }
   }
   if (!model && op.responses?.['200']?.schema) {
    model = extractModelName(op.responses['200'].schema);
   }
   if (model) {
    flatEntityToModel.set(entity, model);
    if (!modelToFlatEntities.has(model)) {
     modelToFlatEntities.set(model, new Set());
    }
    modelToFlatEntities.get(model)!.add(entity);
   }
  }
 }

 // 2. Map child collections
 const childCollections = new Map<string, GeneratedChildCollection>();

 for (const [pathTemplate, pathItem] of Object.entries(spec.paths)) {
  const matchChild = pathTemplate.match(
   /^\/V[0-9.]+\/([A-Za-z0-9_]+)\/\{parentId\}\/([A-Za-z0-9_]+)/,
  );
  if (!matchChild) continue;
  const parentEntity = matchChild[1];
  const childAlias = matchChild[2];
  const pairKey = `${parentEntity}/${childAlias}`;

  let collection = childCollections.get(pairKey);
  if (!collection) {
   // Find child model
   let childModel: string | undefined;
   for (const m of ['post', 'patch', 'put', 'get', 'delete']) {
    const op = pathItem[m];
    if (!op) continue;
    for (const param of op.parameters || []) {
     if (param.in === 'body' && param.schema?.$ref) {
      childModel = extractModelName(param.schema);
      break;
     }
    }
    if (!childModel && op.responses?.['200']?.schema) {
     childModel = extractModelName(op.responses['200'].schema);
    }
    if (childModel) break;
   }

   // Check also sibling /{id} route for model
   const idRoute = `/V1.0/${parentEntity}/{parentId}/${childAlias}/{id}`;
   if (!childModel && spec.paths[idRoute]) {
    const idPathItem = spec.paths[idRoute];
    for (const m of ['get', 'delete']) {
     const op = idPathItem[m];
     if (op?.responses?.['200']?.schema) {
      childModel = extractModelName(op.responses['200'].schema);
      if (childModel) break;
     }
    }
   }

   // Resolve matching flat entity
   const matchingFlat = childModel
    ? Array.from(modelToFlatEntities.get(childModel) || [])
    : [];
   let flatEntity = matchingFlat[0];
   if (!flatEntity) {
    const tag = Object.values(pathItem)[0]?.tags?.[0] || '';
    const tagCandidate = tag.replace(/Child$/, '');
    if (flatEntityToModel.has(tagCandidate)) {
     flatEntity = tagCandidate;
    } else {
     flatEntity = childAlias;
    }
   }

   const parentFkField = findParentFk(spec, childModel, parentEntity);

   collection = {
    parentEntity,
    childAlias,
    entity: flatEntity,
    parentFkField,
    childModel,
    methods: [],
   };
   childCollections.set(pairKey, collection);
  }

  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
   if (pathItem[m] && !collection.methods.includes(m.toUpperCase())) {
    collection.methods.push(m.toUpperCase());
   }
  }
 }

 // Also include methods from /{id} subpaths in collection.methods
 for (const collection of childCollections.values()) {
  const idPath = `/V1.0/${collection.parentEntity}/{parentId}/${collection.childAlias}/{id}`;
  if (spec.paths[idPath]) {
   for (const m of ['get', 'delete']) {
    if (spec.paths[idPath][m] && !collection.methods.includes(m.toUpperCase())) {
     collection.methods.push(m.toUpperCase());
    }
   }
  }
 }

 // 3. Parse all operations
 const operations: GeneratedOperation[] = [];
 let excludedCount = 0;

 for (const [pathTemplate, pathItem] of Object.entries(spec.paths)) {
  for (const methodKey of ['get', 'post', 'put', 'patch', 'delete']) {
   const op = pathItem[methodKey];
   if (!op) continue;

   const opId = op.operationId;
   if (EXCLUDED_OPERATIONS[opId]) {
    excludedCount++;
    continue;
   }

   const method = methodKey.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
   const isQuery = method === 'POST' && /\/query(\/count)?$/i.test(pathTemplate);
   const isRead = method === 'GET' || isQuery;
   const classification = isRead ? 'read' : 'write';
   const destructive = !isRead;

   // Determine entity, parentEntity, childAlias, parentFkField
   let entity = '';
   let parentEntity: string | undefined;
   let childAlias: string | undefined;
   let parentFkField: string | undefined;

   const childMatch = pathTemplate.match(
    /^\/V[0-9.]+\/([A-Za-z0-9_]+)\/\{parentId\}\/([A-Za-z0-9_]+)/,
   );
   if (childMatch) {
    parentEntity = childMatch[1];
    childAlias = childMatch[2];
    const pairKey = `${parentEntity}/${childAlias}`;
    const coll = childCollections.get(pairKey);
    entity = coll?.entity || childAlias;
    parentFkField = coll?.parentFkField;
   } else {
    const flatMatch = pathTemplate.match(/^\/V[0-9.]+\/([A-Za-z0-9_]+)/);
    if (flatMatch) {
     entity = flatMatch[1];
    } else {
     // root path like /VersionInformation (if any kept)
     entity = pathTemplate.replace(/^\//, '').split('/')[0];
    }
   }

   // Parameters (auth headers stripped)
   const parameters: GeneratedParam[] = [];
   let requestModelRef: string | undefined;

   for (const param of op.parameters || []) {
    if (param.in === 'header' && AUTH_HEADER_PARAMS[param.name]) {
     continue;
    }

    if (param.in === 'body' && param.schema?.$ref) {
     requestModelRef = extractModelName(param.schema);
    }

    parameters.push({
     name: param.name,
     in: param.in as 'path' | 'query' | 'body',
     required: param.required ?? false,
     type: param.type || (param.schema?.$ref ? 'object' : 'string'),
     description: param.description,
     schemaRef: param.schema?.$ref,
    });
   }

   operations.push({
    operationId: opId,
    method,
    pathTemplate,
    entity,
    parentEntity,
    childAlias,
    parentFkField,
    parameters,
    requestModelRef,
    classification,
    destructive,
    tag: op.tags?.[0],
    summary: op.summary,
    description: op.description,
   });
  }
 }

 console.log(`Parsed ${operations.length} operations (${excludedCount} excluded).`);
 console.log(`Detected ${childCollections.size} child collections.`);

 mkdirSync(generatedDir, { recursive: true });
 mkdirSync(docsDir, { recursive: true });

 // 4. Write src/generated/types.ts
 const typesContent = `// Auto-generated by scripts/generate-registry.ts: DO NOT EDIT

export interface OperationParameter {
  name: string;
  in: 'path' | 'query' | 'body';
  required: boolean;
  type: string;
  description?: string;
  schemaRef?: string;
}

export interface RegistryOperation {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate: string;
  entity: string;
  parentEntity?: string;
  childAlias?: string;
  parentFkField?: string;
  parameters: OperationParameter[];
  requestModelRef?: string;
  classification: 'read' | 'write';
  destructive: boolean;
  tag?: string;
  summary?: string;
  description?: string;
}

export interface ChildCollectionMeta {
  parentEntity: string;
  childAlias: string;
  entity: string;
  parentFkField?: string;
  childModel?: string;
  methods: string[];
}

export interface ResolvedRoute {
  pathTemplate: string;
  method: string;
  isChild: boolean;
  parentEntity?: string;
  childAlias?: string;
  parentFkField?: string;
  operationId?: string;
}
`;
 writeFileSync(join(generatedDir, 'types.ts'), typesContent, 'utf8');
 console.log('Wrote src/generated/types.ts');

 // 5. Write src/generated/registry.ts
 const childCollsArray = Array.from(childCollections.values());
 const registryContent = `// Auto-generated by scripts/generate-registry.ts: DO NOT EDIT
import type { RegistryOperation, ChildCollectionMeta, ResolvedRoute } from './types.js';

export * from './types.js';

export const OPERATIONS: RegistryOperation[] = ${JSON.stringify(operations, null, 2)};

export const CHILD_COLLECTIONS: ChildCollectionMeta[] = ${JSON.stringify(childCollsArray, null, 2)};

export const OPERATION_REGISTRY = new Map<string, RegistryOperation>();

// Index operations by operationId and lowercased / snake_cased aliases
for (const op of OPERATIONS) {
  OPERATION_REGISTRY.set(op.operationId, op);
  const lower = op.operationId.toLowerCase();
  if (!OPERATION_REGISTRY.has(lower)) {
    OPERATION_REGISTRY.set(lower, op);
  }
  const snake = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!OPERATION_REGISTRY.has(snake)) {
    OPERATION_REGISTRY.set(snake, op);
  }
}

/**
 * Look up an operation by operationId or its snake_case / lower_case alias.
 */
export function findOperation(name: string): RegistryOperation | undefined {
  if (!name) return undefined;
  return (
    OPERATION_REGISTRY.get(name) ||
    OPERATION_REGISTRY.get(name.toLowerCase()) ||
    OPERATION_REGISTRY.get(name.toLowerCase().replace(/[^a-z0-9]+/g, '_'))
  );
}

/**
 * Find child collection metadata matching an entity name or child alias,
 * optionally constrained by parentEntity.
 */
export function getChildCollectionMeta(
  entityOrAlias: string,
  parentEntity?: string,
): ChildCollectionMeta | undefined {
  const norm = entityOrAlias.toLowerCase();
  const parentNorm = parentEntity?.toLowerCase();

  for (const coll of CHILD_COLLECTIONS) {
    if (parentNorm && coll.parentEntity.toLowerCase() !== parentNorm) {
      continue;
    }
    if (
      coll.entity.toLowerCase() === norm ||
      coll.childAlias.toLowerCase() === norm ||
      \`\${coll.parentEntity}\${coll.childAlias}\`.toLowerCase() === norm
    ) {
      return coll;
    }
  }
  return undefined;
}

/**
 * Get all valid routes available for an entity name (flat or child).
 */
export function getValidRoutesForEntity(entity: string): string[] {
  const norm = entity.toLowerCase();
  const routes = new Set<string>();

  for (const op of OPERATIONS) {
    if (
      op.entity.toLowerCase() === norm ||
      op.childAlias?.toLowerCase() === norm ||
      \`\${op.parentEntity}\${op.childAlias}\`.toLowerCase() === norm
    ) {
      routes.add(\`\${op.method} \${op.pathTemplate}\`);
    }
  }
  return Array.from(routes).sort();
}

/**
 * Resolve (entity, method, parentEntity?, parentId?) to a real registry route.
 * When no route exists for that method, returns null with valid routes listed.
 */
export function resolveEntityRoute(
  entity: string,
  method: string,
  parentEntity?: string,
  parentId?: string,
): { resolved?: ResolvedRoute; error?: string } {
  const m = method.toUpperCase();
  const entityNorm = entity.toLowerCase();

  // 1. If parentEntity and parentId were explicitly supplied
  if (parentEntity && parentId) {
    const childMeta = getChildCollectionMeta(entity, parentEntity);
    const childAlias = childMeta?.childAlias || entity;
    const parent = childMeta?.parentEntity || parentEntity;

    // Look for exact route in OPERATIONS
    const matching = OPERATIONS.filter(
      (op) =>
        op.method === m &&
        op.parentEntity?.toLowerCase() === parent.toLowerCase() &&
        op.childAlias?.toLowerCase() === childAlias.toLowerCase(),
    );

    if (matching.length > 0) {
      // Pick item route if method is DELETE or GET item, collection route otherwise
      const op =
        m === 'DELETE'
          ? matching.find((o) => o.pathTemplate.endsWith('/{id}')) || matching[0]
          : matching.find((o) => !o.pathTemplate.endsWith('/{id}')) || matching[0];

      return {
        resolved: {
          pathTemplate: op.pathTemplate,
          method: op.method,
          isChild: true,
          parentEntity: op.parentEntity,
          childAlias: op.childAlias,
          parentFkField: childMeta?.parentFkField,
          operationId: op.operationId,
        },
      };
    }
  }

  // 2. Check if a direct flat route exists for this entity and method
  const flatMatching = OPERATIONS.filter(
    (op) =>
      op.method === m &&
      !op.parentEntity &&
      op.entity.toLowerCase() === entityNorm,
  );

  if (flatMatching.length > 0) {
    const op =
      m === 'DELETE'
        ? flatMatching.find((o) => o.pathTemplate.endsWith('/{id}')) || flatMatching[0]
        : flatMatching.find((o) => !o.pathTemplate.endsWith('/{id}')) || flatMatching[0];

    return {
      resolved: {
        pathTemplate: op.pathTemplate,
        method: op.method,
        isChild: false,
        operationId: op.operationId,
      },
    };
  }

  // 3. Check if this is a child collection without explicit parent
  const childMeta = getChildCollectionMeta(entity);
  if (childMeta && childMeta.methods.includes(m)) {
    const matching = OPERATIONS.filter(
      (op) =>
        op.method === m &&
        op.parentEntity?.toLowerCase() === childMeta.parentEntity.toLowerCase() &&
        op.childAlias?.toLowerCase() === childMeta.childAlias.toLowerCase(),
    );

    if (matching.length > 0) {
      const op =
        m === 'DELETE'
          ? matching.find((o) => o.pathTemplate.endsWith('/{id}')) || matching[0]
          : matching.find((o) => !o.pathTemplate.endsWith('/{id}')) || matching[0];

      return {
        resolved: {
          pathTemplate: op.pathTemplate,
          method: op.method,
          isChild: true,
          parentEntity: childMeta.parentEntity,
          childAlias: childMeta.childAlias,
          parentFkField: childMeta.parentFkField,
          operationId: op.operationId,
        },
      };
    }
  }

  // 4. No matching route: return error naming all valid routes for this entity
  const validRoutes = getValidRoutesForEntity(entity);
  if (validRoutes.length > 0) {
    return {
      error: \`No \${m} route exists for entity "\${entity}". Valid routes for \${entity}: \${validRoutes.join(', ')}\`,
    };
  }
  return {
    error: \`Unknown Autotask entity "\${entity}". Use describe-entity-fields or search_api to find supported entities.\`,
  };
}
`;
 writeFileSync(join(generatedDir, 'registry.ts'), registryContent, 'utf8');
 console.log('Wrote src/generated/registry.ts');

 // 6. Generate docs/api-coverage.html
 const coverageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Autotask PSA MCP API Coverage Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; color: #1f2937; }
    h1 { margin-bottom: 8px; }
    .subtitle { color: #6b7280; margin-bottom: 24px; }
    .stats { display: flex; gap: 16px; margin-bottom: 32px; }
    .stat-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 24px; min-width: 140px; }
    .stat-val { font-size: 28px; font-weight: bold; color: #111827; }
    .stat-lbl { color: #6b7280; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; font-size: 13px; }
    th { background: #f9fafb; }
    tr:nth-child(even) { background: #fcfcfd; }
    .badge { padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .badge-get { background: #e0f2fe; color: #0369a1; }
    .badge-post { background: #dcfce7; color: #15803d; }
    .badge-patch { background: #fef3c7; color: #b45309; }
    .badge-put { background: #fae8ff; color: #86198f; }
    .badge-delete { background: #fee2e2; color: #b91c1c; }
    .badge-read { background: #f3f4f6; color: #374151; }
    .badge-write { background: #ffedd5; color: #9a3412; }
  </style>
</head>
<body>
  <h1>Autotask PSA MCP API Coverage Report</h1>
  <div class="subtitle">Generated from Datto:Autotask PSA Rest API v1 specification</div>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-val">${operations.length + excludedCount}</div>
      <div class="stat-lbl">Total Spec Operations</div>
    </div>
    <div class="stat-card">
      <div class="stat-val">${operations.length}</div>
      <div class="stat-lbl">Reachable in Registry</div>
    </div>
    <div class="stat-card">
      <div class="stat-val">${childCollections.size}</div>
      <div class="stat-lbl">Child Collections</div>
    </div>
    <div class="stat-card">
      <div class="stat-val">${excludedCount}</div>
      <div class="stat-lbl">Excluded Infra/Auth</div>
    </div>
  </div>

  <h2>Reachable Surface Architecture</h2>
  <p>
    Every one of the <strong>${operations.length}</strong> reachable operations in the Autotask REST API
    is accessible through the MCP server:
  </p>
  <ul>
    <li><strong>Curated Tools</strong>: High-frequency workflows for tickets, ticket notes, ticket charges, companies, contacts, projects, tasks, time entries, contracts, contract services, services, and invoices.</li>
    <li><strong>Full Registry Escape Hatch</strong>: <code>search_api(query, limit?)</code> and <code>call_api(tool_name, args)</code> to search and invoke any operation in the registry.</li>
    <li><strong>Spec-Driven Generic Tools</strong>: <code>query-entity</code>, <code>get-entity</code>, <code>create-entity</code>, <code>update-entity</code>, <code>delete-entity</code> auto-resolve parent-child routes and foreign keys.</li>
  </ul>

  <h2>Security and Authorization Controls</h2>
  <ul>
    <li><strong>Read-Only Mode</strong>: Mutating operations are never registered or callable when read-only mode is active.</li>
    <li><strong>Per-User Autotask Rights</strong>: Security level capabilities (read, create, update, delete) are checked per request.</li>
    <li><strong>Destructive Confirmation</strong>: Destructive operations require confirmation tokens and MCP elicitation.</li>
    <li><strong>Rate Limiting</strong>: Tenant-wide budget governor gates every call.</li>
  </ul>

  <h2>Excluded Operations</h2>
  <table>
    <thead>
      <tr><th>Operation ID</th><th>Reason</th></tr>
    </thead>
    <tbody>
      <tr><td>AuthenticateApiIntegration_QueryAuthenticate</td><td>Credential test/verification endpoint. Credentials managed server-side.</td></tr>
      <tr><td>ZoneInformationApiIntegration_QueryZoneInformation</td><td>Internal zone discovery endpoint managed by client.</td></tr>
      <tr><td>ApiVersion_ApiVersionInformation</td><td>Unversioned root endpoint redundant with /V1.0/Version.</td></tr>
    </tbody>
  </table>

  <h2>Sample Registry Operations (First 100)</h2>
  <table>
    <thead>
      <tr><th>Operation ID</th><th>Method</th><th>Path Template</th><th>Entity</th><th>Scope</th><th>Classification</th></tr>
    </thead>
    <tbody>
      ${operations
   .slice(0, 100)
   .map(
    (op) => `
        <tr>
          <td><code>${op.operationId}</code></td>
          <td><span class="badge badge-${op.method.toLowerCase()}">${op.method}</span></td>
          <td><code>${op.pathTemplate}</code></td>
          <td>${op.entity}</td>
          <td>${op.parentEntity ? `${op.parentEntity} / ${op.childAlias}` : 'Flat'}</td>
          <td><span class="badge badge-${op.classification}">${op.classification}</span></td>
        </tr>
      `,
   )
   .join('')}
    </tbody>
  </table>
</body>
</html>
`;
 writeFileSync(join(docsDir, 'api-coverage.html'), coverageHtml, 'utf8');
 console.log('Wrote docs/api-coverage.html');
 console.log('Done!');
}

generate();
