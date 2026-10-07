import {
 getChildCollectionMeta,
 getValidRoutesForEntity,
 resolveEntityRoute,
} from '../generated/registry.js';
import { assertSafeEntityName, assertSafeNumericId } from '../security.js';

/**
 * Basic entity path resolution for read queries (query, count, fields).
 * If parentEntity and parentId are provided, formats as Parent/parentId/Child.
 */
export function resolveEntity(entity: string, parentEntity?: string, parentId?: string): string {
 const safeEntity = assertSafeEntityName(entity, 'entity');

 if (parentEntity && parentId) {
  const safeParentEntity = assertSafeEntityName(parentEntity, 'parentEntity');
  const safeParentId = assertSafeNumericId(parentId, 'parentId');
  const childMeta = getChildCollectionMeta(safeEntity, safeParentEntity);
  const childAlias = childMeta?.childAlias || safeEntity;
  const parent = childMeta?.parentEntity || safeParentEntity;
  return `${parent}/${safeParentId}/${childAlias}`;
 }
 if (parentEntity || parentId) {
  throw new Error('parentEntity and parentId must be provided together');
 }

 return safeEntity;
}

/**
 * Spec-driven write route resolver for create, update, and delete.
 * Resolves (entity, method, parentEntity?, parentId?) to a real Autotask route.
 *
 * 1. If entity already contains slashes (e.g. "Companies/123/Contacts"), use directly.
 * 2. If parentEntity and parentId are supplied, resolve to the child route.
 * 3. If no parent was given:
 *    - If a direct flat route exists for (entity, method), use it.
 *    - If the entity only has parent-scoped write routes:
 *      - Derive the parent FK field from the spec model (e.g. companyID, ticketID).
 *      - If fields contains the FK, use it.
 *      - For update/delete without FK in fields, fetch the record on its flat route
 *        and extract the parent FK.
 *      - If none can be found, return a descriptive error naming the parent and FK.
 * 4. If no route exists for (entity, method), return an error naming all valid routes.
 */
export async function resolveWritePath(
 entity: string,
 method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
 parentEntity?: string,
 parentId?: string,
 id?: string,
 fields?: Record<string, unknown>,
 getRecordById?: (entity: string, id: string) => Promise<unknown>,
): Promise<string> {
 // If already a resolved path like "Companies/123/Contacts"
 if (entity.includes('/')) {
  return entity;
 }

 if (parentEntity || parentId) {
  if (!parentEntity || !parentId) {
   throw new Error('parentEntity and parentId must be provided together');
  }
  const safeEntity = assertSafeEntityName(entity, 'entity');
  const safeParentEntity = assertSafeEntityName(parentEntity, 'parentEntity');
  const safeParentId = assertSafeNumericId(parentId, 'parentId');

  const routeCheck = resolveEntityRoute(safeEntity, method, safeParentEntity, safeParentId);
  if (routeCheck.error) {
   throw new Error(routeCheck.error);
  }
  const childMeta = getChildCollectionMeta(safeEntity, safeParentEntity);
  const childAlias = childMeta?.childAlias || safeEntity;
  const parent = childMeta?.parentEntity || safeParentEntity;
  return `${parent}/${safeParentId}/${childAlias}`;
 }

 const safeEntity = assertSafeEntityName(entity, 'entity');

 // Check route resolution without parent
 const routeCheck = resolveEntityRoute(safeEntity, method);
 if (routeCheck.resolved && !routeCheck.resolved.isChild) {
  // Direct flat route exists (e.g. POST /Tickets or PATCH /Tickets)
  return safeEntity;
 }

 // Check if this is a child collection that requires a parent
 const childMeta = getChildCollectionMeta(safeEntity);
 if (childMeta) {
  const fkField = childMeta.parentFkField;

  // 1. Try to read FK from fields
  let resolvedParentId: string | undefined;
  if (fields && fkField) {
   const val = fields[fkField] ?? fields[fkField.toLowerCase()] ?? fields.parentId ?? fields.parentID;
   if (typeof val === 'number' || (typeof val === 'string' && /^\d+$/.test(val))) {
    resolvedParentId = String(val);
   }
  }

  // 2. For update or delete without parentId in fields, look up record if getRecordById provided
  if (!resolvedParentId && (method === 'PATCH' || method === 'PUT' || method === 'DELETE') && getRecordById) {
   const recordId = id || (fields?.id !== undefined ? String(fields.id) : undefined);
   if (recordId && /^\d+$/.test(recordId)) {
    try {
     const rec = (await getRecordById(childMeta.entity || safeEntity, recordId)) as {
      item?: Record<string, unknown>;
     };
     const item = rec?.item || (rec as Record<string, unknown>);
     if (fkField && item) {
      const val = item[fkField] ?? item[fkField.toLowerCase()];
      if (val !== undefined && val !== null) {
       resolvedParentId = String(val);
      }
     }
    } catch {
     // Record lookup failed: fall through to error
    }
   }
  }

  if (resolvedParentId) {
   assertSafeNumericId(resolvedParentId, 'parentId');
   return `${childMeta.parentEntity}/${resolvedParentId}/${childMeta.childAlias}`;
  }

  // If still missing, throw descriptive error
  const parentLabel = childMeta.parentEntity
   .toLowerCase()
   .replace(/ies$/, 'y')
   .replace(/s$/, '');

  const fkHint = fkField || 'parentId';
  throw new Error(
   `${safeEntity} in Autotask must be created under a ${parentLabel}. Specify parentEntity: "${childMeta.parentEntity}" and parentId: "<${fkHint}>", or include "${fkHint}" in fields.`,
  );
 }

 // No route found
 if (routeCheck.error) {
  throw new Error(routeCheck.error);
 }
 const validRoutes = getValidRoutesForEntity(safeEntity);
 if (validRoutes.length > 0) {
  throw new Error(
   `No ${method} route exists for entity "${safeEntity}". Valid routes for ${safeEntity}: ${validRoutes.join(', ')}`,
  );
 }
 throw new Error(`Unknown Autotask entity "${safeEntity}".`);
}
