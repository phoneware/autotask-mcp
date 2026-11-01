// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/test-support/fake-firestore.ts at 998685a9dd5843a89e6eb1f3659223e7f9e31fc5). Edit the canonical file, then re-copy.
export class FirestoreError extends Error {
  readonly code: number | string;

  constructor(message: string, code: number | string) {
    super(message);
    this.name = 'FirestoreError';
    this.code = code;
  }
}

function deepClone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T;
  if (typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      copy[k] = deepClone(v);
    }
    return copy as T;
  }
  return value;
}

function checkUndefined(value: unknown, path: string = ''): void {
  if (value === undefined) {
    throw new Error(`Cannot use "undefined" as a Firestore value (found in field "${path}")`);
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkUndefined(item, `${path}[${index}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const fieldPath = path ? `${path}.${k}` : k;
    checkUndefined(v, fieldPath);
  }
}

export class FakeDocumentSnapshot {
  readonly id: string;
  readonly ref: FakeDocumentReference;
  private readonly rawData?: Record<string, unknown>;

  constructor(ref: FakeDocumentReference, data?: Record<string, unknown>) {
    this.ref = ref;
    this.id = ref.id;
    this.rawData = data !== undefined ? deepClone(data) : undefined;
  }

  get exists(): boolean {
    return this.rawData !== undefined;
  }

  data(): Record<string, unknown> | undefined {
    return this.rawData !== undefined ? deepClone(this.rawData) : undefined;
  }
}

export class FakeQuerySnapshot {
  readonly docs: FakeDocumentSnapshot[];

  constructor(docs: FakeDocumentSnapshot[]) {
    this.docs = docs;
  }

  get empty(): boolean {
    return this.docs.length === 0;
  }

  get size(): number {
    return this.docs.length;
  }
}

export class FakeQuery {
  protected readonly firestore: FakeFirestore;
  protected readonly collectionPath: string;
  protected readonly filters: Array<{ field: string; op: string; value: unknown }>;
  protected readonly limitCount?: number;

  constructor(
    firestore: FakeFirestore,
    collectionPath: string,
    filters: Array<{ field: string; op: string; value: unknown }> = [],
    limitCount?: number,
  ) {
    this.firestore = firestore;
    this.collectionPath = collectionPath;
    this.filters = filters;
    this.limitCount = limitCount;
  }

  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(
      this.firestore,
      this.collectionPath,
      [...this.filters, { field, op, value }],
      this.limitCount,
    );
  }

  limit(count: number): FakeQuery {
    return new FakeQuery(this.firestore, this.collectionPath, this.filters, count);
  }

  async get(): Promise<FakeQuerySnapshot> {
    this.firestore.checkOutage();
    const map = this.firestore.getCollectionMap(this.collectionPath);
    let matched: FakeDocumentSnapshot[] = [];

    for (const [id, data] of map.entries()) {
      let matchesAll = true;
      for (const filter of this.filters) {
        const val = data[filter.field];
        if (filter.op === '==') {
          if (val !== filter.value) matchesAll = false;
        } else if (filter.op === 'array-contains') {
          if (!Array.isArray(val) || !val.includes(filter.value)) matchesAll = false;
        }
      }
      if (matchesAll) {
        const docRef = new FakeDocumentReference(this.firestore, this.collectionPath, id);
        matched.push(new FakeDocumentSnapshot(docRef, data));
      }
    }

    if (this.limitCount !== undefined) {
      matched = matched.slice(0, this.limitCount);
    }

    return new FakeQuerySnapshot(matched);
  }
}

export class FakeDocumentReference {
  readonly firestore: FakeFirestore;
  readonly parentPath: string;
  readonly id: string;

  constructor(firestore: FakeFirestore, parentPath: string, id: string) {
    this.firestore = firestore;
    this.parentPath = parentPath;
    this.id = id;
  }

  get path(): string {
    return `${this.parentPath}/${this.id}`;
  }

  async get(): Promise<FakeDocumentSnapshot> {
    this.firestore.checkOutage();
    const map = this.firestore.getCollectionMap(this.parentPath);
    const data = map.get(this.id);
    return new FakeDocumentSnapshot(this, data);
  }

  async set(
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<void> {
    this.firestore.checkOutage();
    this.firestore.validatePayload(data);
    const map = this.firestore.getCollectionMap(this.parentPath);
    if (options?.merge && map.has(this.id)) {
      const existing = map.get(this.id)!;
      map.set(this.id, deepClone({ ...existing, ...data }));
    } else {
      map.set(this.id, deepClone(data));
    }
  }

  async update(data: Record<string, unknown>): Promise<void> {
    this.firestore.checkOutage();
    this.firestore.validatePayload(data);
    const map = this.firestore.getCollectionMap(this.parentPath);
    if (!map.has(this.id)) {
      throw new FirestoreError(`Document ${this.path} not found`, 5);
    }
    const existing = map.get(this.id)!;
    map.set(this.id, deepClone({ ...existing, ...data }));
  }

  async create(data: Record<string, unknown>): Promise<void> {
    this.firestore.checkOutage();
    this.firestore.validatePayload(data);
    const map = this.firestore.getCollectionMap(this.parentPath);
    if (map.has(this.id)) {
      throw new FirestoreError(`Document ${this.path} already exists`, 6);
    }
    map.set(this.id, deepClone(data));
  }

  async delete(): Promise<void> {
    this.firestore.checkOutage();
    const map = this.firestore.getCollectionMap(this.parentPath);
    map.delete(this.id);
  }
}

export class FakeCollectionReference extends FakeQuery {
  readonly id: string;

  constructor(firestore: FakeFirestore, collectionPath: string) {
    super(firestore, collectionPath);
    this.id = collectionPath.split('/').pop()!;
  }

  doc(id?: string): FakeDocumentReference {
    const docId = id ?? Math.random().toString(36).slice(2);
    return new FakeDocumentReference(this.firestore, this.collectionPath, docId);
  }
}

type StagedWrite =
  | { type: 'set'; ref: FakeDocumentReference; data: Record<string, unknown>; merge?: boolean }
  | { type: 'update'; ref: FakeDocumentReference; data: Record<string, unknown> }
  | { type: 'delete'; ref: FakeDocumentReference };

export class FakeWriteBatch {
  private readonly firestore: FakeFirestore;
  private readonly operations: StagedWrite[] = [];

  constructor(firestore: FakeFirestore) {
    this.firestore = firestore;
  }

  set(
    ref: FakeDocumentReference,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): this {
    this.firestore.validatePayload(data);
    this.operations.push({
      type: 'set',
      ref,
      data: deepClone(data),
      merge: options?.merge,
    });
    return this;
  }

  update(ref: FakeDocumentReference, data: Record<string, unknown>): this {
    this.firestore.validatePayload(data);
    this.operations.push({
      type: 'update',
      ref,
      data: deepClone(data),
    });
    return this;
  }

  delete(ref: FakeDocumentReference): this {
    this.operations.push({ type: 'delete', ref });
    return this;
  }

  async commit(): Promise<void> {
    this.firestore.checkOutage();
    for (const op of this.operations) {
      if (op.type === 'set') {
        await op.ref.set(op.data, { merge: op.merge });
      } else if (op.type === 'update') {
        await op.ref.update(op.data);
      } else if (op.type === 'delete') {
        await op.ref.delete();
      }
    }
    this.operations.length = 0;
  }
}

export class FakeTransaction {
  private readonly firestore: FakeFirestore;
  private readonly staged: StagedWrite[] = [];

  constructor(firestore: FakeFirestore) {
    this.firestore = firestore;
  }

  async get(ref: FakeDocumentReference): Promise<FakeDocumentSnapshot> {
    this.firestore.checkOutage();
    // Check staged operations first
    for (let i = this.staged.length - 1; i >= 0; i--) {
      const op = this.staged[i]!;
      if (op.ref.path === ref.path) {
        if (op.type === 'delete') {
          return new FakeDocumentSnapshot(ref, undefined);
        }
        if (op.type === 'set' && !op.merge) {
          return new FakeDocumentSnapshot(ref, op.data);
        }
      }
    }
    return ref.get();
  }

  set(
    ref: FakeDocumentReference,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): this {
    this.firestore.validatePayload(data);
    this.staged.push({
      type: 'set',
      ref,
      data: deepClone(data),
      merge: options?.merge,
    });
    return this;
  }

  update(ref: FakeDocumentReference, data: Record<string, unknown>): this {
    this.firestore.validatePayload(data);
    this.staged.push({
      type: 'update',
      ref,
      data: deepClone(data),
    });
    return this;
  }

  delete(ref: FakeDocumentReference): this {
    this.staged.push({ type: 'delete', ref });
    return this;
  }

  async commit(): Promise<void> {
    this.firestore.checkOutage();
    for (const op of this.staged) {
      if (op.type === 'set') {
        await op.ref.set(op.data, { merge: op.merge });
      } else if (op.type === 'update') {
        await op.ref.update(op.data);
      } else if (op.type === 'delete') {
        await op.ref.delete();
      }
    }
    this.staged.length = 0;
  }
}

export class FakeFirestore {
  readonly ignoreUndefinedProperties: boolean;
  private readonly collections = new Map<string, Map<string, Record<string, unknown>>>();
  private isOutageActive = false;
  private transactionLock = Promise.resolve();

  constructor(opts?: { ignoreUndefinedProperties?: boolean; projectId?: string }) {
    this.ignoreUndefinedProperties = opts?.ignoreUndefinedProperties ?? false;
  }

  collection(collectionPath: string): FakeCollectionReference {
    return new FakeCollectionReference(this, collectionPath);
  }

  batch(): FakeWriteBatch {
    return new FakeWriteBatch(this);
  }

  async runTransaction<R>(updateFunction: (transaction: FakeTransaction) => Promise<R>): Promise<R> {
    this.checkOutage();
    // Serialize transactions
    const prior = this.transactionLock;
    let releaseLock: () => void = () => {};
    this.transactionLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prior;
      this.checkOutage();
      const transaction = new FakeTransaction(this);
      const result = await updateFunction(transaction);
      await transaction.commit();
      return result;
    } finally {
      releaseLock();
    }
  }

  setOutage(active: boolean): void {
    this.isOutageActive = active;
  }

  simulateOutage(active: boolean): void {
    this.isOutageActive = active;
  }

  checkOutage(): void {
    if (this.isOutageActive) {
      throw new FirestoreError('14 UNAVAILABLE: Firestore backend unavailable', 14);
    }
  }

  validatePayload(data: unknown): void {
    if (!this.ignoreUndefinedProperties) {
      checkUndefined(data);
    }
  }

  getCollectionMap(collectionPath: string): Map<string, Record<string, unknown>> {
    let map = this.collections.get(collectionPath);
    if (!map) {
      map = new Map<string, Record<string, unknown>>();
      this.collections.set(collectionPath, map);
    }
    return map;
  }

  clear(): void {
    this.collections.clear();
  }
}
