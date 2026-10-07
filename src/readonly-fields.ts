import { getChildCollectionMeta } from './generated/registry.js';

export interface FieldMeta {
  name: string;
  isReadOnly: boolean;
  isRequired?: boolean;
}

export interface EntityMetadata {
  fields: Map<string, FieldMeta>;
  udfs: Map<string, FieldMeta>;
  entityName: string;
}

export interface EntityFieldsClient {
  entityFields(entity: string): Promise<unknown>;
  entityUserDefinedFields(entity: string): Promise<unknown>;
}

export interface RouteInfo {
  cacheKey: string;
  aliasCacheKey?: string;
  fetchRoute: string;
  entityName: string;
}

/**
 * Parse an entity route or path into a normalized cache key, fetch route, and entity display name.
 * Handles:
 * - Direct entities: "Tickets", "TicketCharges", "Companies"
 * - Child routes: "Tickets/23836/Charges", "Companies/123/Contacts"
 * - Wildcard/placeholder routes: "Tickets/{parentId}/Charges", "Tickets/{id}/Charges"
 * - Prefixed routes: "/V1.0/Tickets/23836/Charges"
 */
export function parseRouteInfo(routeOrEntity: string): RouteInfo {
  const clean = routeOrEntity
    .replace(/^\/?(v1\.0\/)?/i, '')
    .split('?')[0]
    .replace(/\/+$/, '');
  const segments = clean.split('/');

  if (segments.length === 3) {
    const [parent, parentId, childAlias] = segments;
    const childMeta = getChildCollectionMeta(childAlias, parent);
    const entityName = childMeta?.entity || `${parent}/${childAlias}`;
    const cacheKey = `${parent.toLowerCase()}/*/${childAlias.toLowerCase()}`;
    const aliasCacheKey = childMeta?.entity ? childMeta.entity.toLowerCase() : undefined;
    const isWildcard = parentId === '*' || parentId.toLowerCase() === '{parentid}';
    const fetchRoute = isWildcard ? `${parent}/0/${childAlias}` : clean;

    return {
      cacheKey,
      aliasCacheKey,
      fetchRoute,
      entityName,
    };
  }

  if (segments.length === 1) {
    const entity = segments[0];
    const childMeta = getChildCollectionMeta(entity);
    const entityName = childMeta?.entity || entity;
    const cacheKey = entity.toLowerCase();
    const aliasCacheKey = childMeta
      ? `${childMeta.parentEntity.toLowerCase()}/*/${childMeta.childAlias.toLowerCase()}`
      : undefined;

    return {
      cacheKey,
      aliasCacheKey,
      fetchRoute: entity,
      entityName,
    };
  }

  return {
    cacheKey: clean.toLowerCase(),
    fetchRoute: clean,
    entityName: clean,
  };
}

/**
 * Process-wide in-memory cache for entity field and UDF metadata.
 */
const metadataCache = new Map<string, Promise<EntityMetadata>>();

/**
 * Reset all cached entity metadata. Useful in tests for clean state.
 */
export function clearMetadataCache(): void {
  metadataCache.clear();
}

/**
 * Pre-seed the cache with known field metadata for an entity or route.
 */
export function primeMetadataCache(
  routeOrEntity: string,
  fields: Array<{ name: string; isReadOnly: boolean; isRequired?: boolean }>,
  udfs: Array<{ name: string; isReadOnly: boolean; isRequired?: boolean }> = [],
  entityNameOverride?: string,
): void {
  const routeInfo = parseRouteInfo(routeOrEntity);
  const fieldsMap = new Map<string, FieldMeta>();
  for (const f of fields) {
    fieldsMap.set(f.name.toLowerCase(), {
      name: f.name,
      isReadOnly: Boolean(f.isReadOnly),
      isRequired: Boolean(f.isRequired),
    });
  }

  const udfsMap = new Map<string, FieldMeta>();
  for (const u of udfs) {
    udfsMap.set(u.name.toLowerCase(), {
      name: u.name,
      isReadOnly: Boolean(u.isReadOnly),
      isRequired: Boolean(u.isRequired),
    });
  }

  const meta: EntityMetadata = {
    fields: fieldsMap,
    udfs: udfsMap,
    entityName: entityNameOverride || routeInfo.entityName,
  };

  const promise = Promise.resolve(meta);
  metadataCache.set(routeInfo.cacheKey, promise);
  if (routeInfo.aliasCacheKey) {
    metadataCache.set(routeInfo.aliasCacheKey, promise);
  }
}

/**
 * Fetch and cache field and user-defined field metadata for an entity or child route.
 * Budgeted through the governor like any API call.
 */
export async function getEntityMetadata(
  api: EntityFieldsClient,
  routeOrEntity: string,
): Promise<EntityMetadata> {
  const routeInfo = parseRouteInfo(routeOrEntity);

  const cached =
    metadataCache.get(routeInfo.cacheKey) ??
    (routeInfo.aliasCacheKey ? metadataCache.get(routeInfo.aliasCacheKey) : undefined);

  if (cached) {
    return cached;
  }

  const fetchPromise = (async () => {
    try {
      const [rawFields, rawUdfs] = await Promise.all([
        api.entityFields(routeInfo.fetchRoute).catch((err: unknown) => {
          if (
            err instanceof Error &&
            (err.message.includes('404') || err.message.includes('not found'))
          ) {
            return { fields: [] };
          }
          throw err;
        }),
        api.entityUserDefinedFields(routeInfo.fetchRoute).catch(() => ({ fields: [] })),
      ]);

      const fieldsMap = new Map<string, FieldMeta>();
      if (
        rawFields &&
        typeof rawFields === 'object' &&
        'fields' in rawFields &&
        Array.isArray(rawFields.fields)
      ) {
        for (const f of rawFields.fields) {
          if (f && typeof f === 'object' && 'name' in f && typeof f.name === 'string') {
            const isReadOnly = 'isReadOnly' in f ? Boolean(f.isReadOnly) : false;
            const isRequired = 'isRequired' in f ? Boolean(f.isRequired) : false;
            fieldsMap.set(f.name.toLowerCase(), {
              name: f.name,
              isReadOnly,
              isRequired,
            });
          }
        }
      }

      const udfsMap = new Map<string, FieldMeta>();
      if (
        rawUdfs &&
        typeof rawUdfs === 'object' &&
        'fields' in rawUdfs &&
        Array.isArray(rawUdfs.fields)
      ) {
        for (const u of rawUdfs.fields) {
          if (u && typeof u === 'object' && 'name' in u && typeof u.name === 'string') {
            const isReadOnly = 'isReadOnly' in u ? Boolean(u.isReadOnly) : false;
            const isRequired = 'isRequired' in u ? Boolean(u.isRequired) : false;
            udfsMap.set(u.name.toLowerCase(), {
              name: u.name,
              isReadOnly,
              isRequired,
            });
          }
        }
      }
      return {
        fields: fieldsMap,
        udfs: udfsMap,
        entityName: routeInfo.entityName,
      };
    } catch (err) {
      metadataCache.delete(routeInfo.cacheKey);
      if (routeInfo.aliasCacheKey) {
        metadataCache.delete(routeInfo.aliasCacheKey);
      }
      throw err;
    }
  })();

  metadataCache.set(routeInfo.cacheKey, fetchPromise);
  if (routeInfo.aliasCacheKey) {
    metadataCache.set(routeInfo.aliasCacheKey, fetchPromise);
  }

  return fetchPromise;
}

/**
 * Validate that a request body contains no read-only fields for the given entity or child route.
 * Refuses fields with isReadOnly: true, naming them and explaining that Autotask accepts the
 * request but ignores those fields, so changes must be made in the Autotask UI.
 *
 * Rules:
 * - On update (PATCH/PUT), "id" is permitted because it addresses the target record.
 * - On create (POST), "id" follows the metadata (refused if isReadOnly: true).
 * - User-defined fields are checked against entityInformation/userDefinedFields.
 */
export async function assertWritableFields(
  api: EntityFieldsClient,
  routeOrEntity: string,
  body: unknown,
  isUpdate: boolean,
): Promise<void> {
  if (!body || typeof body !== 'object') {
    return;
  }

  if (Array.isArray(body)) {
    for (const record of body) {
      await assertWritableFields(api, routeOrEntity, record, isUpdate);
    }
    return;
  }

  const meta = await getEntityMetadata(api, routeOrEntity);
  // If the endpoint returned no fields and no UDFs (e.g. 404 on entityInformation/fields),
  // there is no metadata to enforce.
  if (meta.fields.size === 0 && meta.udfs.size === 0) {
    return;
  }

  const readOnlyFields: string[] = [];
  const rec = body as Record<string, unknown>;

  for (const [key, value] of Object.entries(rec)) {
    const keyLower = key.toLowerCase();

    // On update, id addresses the record and is allowed.
    if (isUpdate && keyLower === 'id') {
      continue;
    }

    // User-defined fields follow entityInformation/userDefinedFields
    if (keyLower === 'userdefinedfields') {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && 'name' in item && item.name != null) {
            const udfName = String(item.name);
            const udfMeta = meta.udfs.get(udfName.toLowerCase());
            if (udfMeta?.isReadOnly) {
              readOnlyFields.push(udfMeta.name || udfName);
            }
          }
        }
      } else if (value && typeof value === 'object') {
        for (const [udfKey] of Object.entries(value)) {
          const udfMeta = meta.udfs.get(udfKey.toLowerCase());
          if (udfMeta?.isReadOnly) {
            readOnlyFields.push(udfMeta.name || udfKey);
          }
        }
      }
      continue;
    }

    // Standard field check
    const stdField = meta.fields.get(keyLower);
    if (stdField) {
      if (stdField.isReadOnly) {
        readOnlyFields.push(stdField.name);
      }
      continue;
    }

    // Direct UDF key check
    const udfField = meta.udfs.get(keyLower);
    if (udfField) {
      if (udfField.isReadOnly) {
        readOnlyFields.push(udfField.name);
      }
      continue;
    }
  }

  if (readOnlyFields.length > 0) {
    const unique = Array.from(new Set(readOnlyFields));
    throw new Error(
      `Cannot ${isUpdate ? 'update' : 'set'} read-only field(s) on ${meta.entityName}: ${unique.join(
        ', ',
      )}. Autotask accepts the request but ignores those fields, so the change has to be made in the Autotask UI.`,
    );
  }
}
