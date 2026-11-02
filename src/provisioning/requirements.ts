import { Firestore } from '@google-cloud/firestore';

export interface ChecklistTaskRequirement {
  accountKey: string;
  ticketId: string;
  checklistItemId: string;
  requiredKind: 'attachment_archive' | 'evidence_note';
  semanticFingerprint: string;
  expectedSourceDigest?: string;
  expectedDocumentName?: string;
  sourceReference: string;
  disabled: boolean;
  version: number;
}

export const REQUIREMENTS_COLLECTION = 'autotask_mcp_checklist_requirements';

export interface RequirementsStore {
  get(accountKey: string, ticketId: string, checklistItemId: string): Promise<ChecklistTaskRequirement | null>;
  set(requirement: ChecklistTaskRequirement): Promise<void>;
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
    return r ? { ...r } : null;
  }

  async set(requirement: ChecklistTaskRequirement): Promise<void> {
    const key = `${requirement.accountKey}:${requirement.ticketId}:${requirement.checklistItemId}`;
    this.requirements.set(key, { ...requirement });
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
