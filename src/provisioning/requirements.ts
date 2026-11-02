import crypto from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';

export interface BaseRequirement {
  accountKey: string;
  ticketId: string;
  checklistItemId: string;
  semanticFingerprint: string;
  sourceReference: string;
  disabled: boolean;
  version: number;
}

export interface ArchivedPdfRequirement extends BaseRequirement {
  requiredKind: 'attachment_archive';
  expectedCompanyId: string;
  expectedAttachmentId?: string;
  expectedSourceDigest?: string;
  requiredBindingId?: string;
}

export interface RecordedNoteRequirement extends BaseRequirement {
  requiredKind: 'evidence_note';
  requiredNoteType?: number;
  requiredPublish?: number;
  requiredTitle?: string;
  requiredContentDigest?: string;
}

export type ChecklistTaskRequirement = ArchivedPdfRequirement | RecordedNoteRequirement;

export const REQUIREMENTS_COLLECTION = 'autotask_mcp_checklist_requirements';

export function computeItemSemanticFingerprint(
  ticketId: string,
  checklistItemId: string,
  itemName: string,
  taskSourceIdentity = '1',
): string {
  const normName = itemName.trim().toLowerCase();
  return crypto
    .createHash('sha256')
    .update(`${ticketId}:${checklistItemId}:${normName}:${taskSourceIdentity}`)
    .digest('hex');
}

export interface RequirementsStore {
  get(
    accountKey: string,
    ticketId: string,
    checklistItemId: string,
  ): Promise<ChecklistTaskRequirement | null>;
  set(requirement: ChecklistTaskRequirement): Promise<void>;
  setWithCas(
    requirement: Omit<ChecklistTaskRequirement, 'version'>,
    expectedVersion: number,
  ): Promise<ChecklistTaskRequirement>;
}

export class MemoryRequirementsStore implements RequirementsStore {
  private readonly requirements = new Map<string, ChecklistTaskRequirement>();

  async get(
    accountKey: string,
    ticketId: string,
    checklistItemId: string,
  ): Promise<ChecklistTaskRequirement | null> {
    const key = `${accountKey}:${ticketId}:${checklistItemId}`;
    const r = this.requirements.get(key);
    return r ? ({ ...r } as ChecklistTaskRequirement) : null;
  }

  async set(requirement: ChecklistTaskRequirement): Promise<void> {
    const key = `${requirement.accountKey}:${requirement.ticketId}:${requirement.checklistItemId}`;
    this.requirements.set(key, { ...requirement });
  }

  async setWithCas(
    params: Omit<ChecklistTaskRequirement, 'version'>,
    expectedVersion: number,
  ): Promise<ChecklistTaskRequirement> {
    const key = `${params.accountKey}:${params.ticketId}:${params.checklistItemId}`;
    const existing = this.requirements.get(key);
    const currentVersion = existing?.version ?? 0;

    if (currentVersion !== expectedVersion) {
      throw new Error(
        `CAS mismatch: expected requirement version ${expectedVersion}, but current version is ${currentVersion}`,
      );
    }

    const nextVersion = currentVersion + 1;
    const finalReq = {
      ...params,
      version: nextVersion,
    } as ChecklistTaskRequirement;

    this.requirements.set(key, { ...finalReq });
    return { ...finalReq };
  }

  clear(): void {
    this.requirements.clear();
  }
}

export class FirestoreRequirementsStore implements RequirementsStore {
  constructor(private readonly firestore: Firestore) {}

  async get(
    accountKey: string,
    ticketId: string,
    checklistItemId: string,
  ): Promise<ChecklistTaskRequirement | null> {
    const docId = `${accountKey}_${ticketId}_${checklistItemId}`;
    const snap = await this.firestore.collection(REQUIREMENTS_COLLECTION).doc(docId).get();
    if (!snap.exists) return null;
    return (snap.data() as ChecklistTaskRequirement) ?? null;
  }

  async set(requirement: ChecklistTaskRequirement): Promise<void> {
    const docId = `${requirement.accountKey}_${requirement.ticketId}_${requirement.checklistItemId}`;
    await this.firestore.collection(REQUIREMENTS_COLLECTION).doc(docId).set(requirement);
  }

  async setWithCas(
    params: Omit<ChecklistTaskRequirement, 'version'>,
    expectedVersion: number,
  ): Promise<ChecklistTaskRequirement> {
    const docId = `${params.accountKey}_${params.ticketId}_${params.checklistItemId}`;
    const docRef = this.firestore.collection(REQUIREMENTS_COLLECTION).doc(docId);

    return this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      const existing = snap.exists ? (snap.data() as ChecklistTaskRequirement) : null;
      const currentVersion = existing?.version ?? 0;

      if (currentVersion !== expectedVersion) {
        throw new Error(
          `CAS mismatch: expected requirement version ${expectedVersion}, but current version is ${currentVersion}`,
        );
      }

      const nextVersion = currentVersion + 1;
      const finalReq = {
        ...params,
        version: nextVersion,
      } as ChecklistTaskRequirement;

      txn.set(docRef, finalReq);
      return finalReq;
    });
  }
}

let activeRequirementsStore: RequirementsStore | null = null;

export function getRequirementsStore(): RequirementsStore {
  if (activeRequirementsStore) return activeRequirementsStore;
  try {
    const projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    const fs = new Firestore({ projectId, ignoreUndefinedProperties: true });
    activeRequirementsStore = new FirestoreRequirementsStore(fs);
    return activeRequirementsStore;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to initialize Firestore requirements store: ${msg}`);
  }
}

export function setRequirementsStore(store: RequirementsStore | null): void {
  activeRequirementsStore = store;
}
