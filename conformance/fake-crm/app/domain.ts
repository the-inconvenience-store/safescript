export type CrmMutationKind =
  'deal-stage' | 'contact-tag' | 'task' | 'note' | 'owner' | 'notification' | 'followup' | 'audit';

export interface CrmMutation {
  readonly kind: CrmMutationKind;
  readonly workspaceId: string;
  readonly entityId: string;
  readonly value: string;
}

export interface CrmState {
  readonly dealStages: Readonly<Record<string, string>>;
  readonly contactTags: Readonly<Record<string, readonly string[]>>;
  readonly tasks: readonly CrmMutation[];
  readonly notes: readonly CrmMutation[];
  readonly owners: Readonly<Record<string, string>>;
  readonly notifications: readonly CrmMutation[];
  readonly followups: readonly CrmMutation[];
  readonly audit: readonly CrmMutation[];
}

/** Tiny in-memory CRM used as the trusted application behind the SafeScript gateway. */
export class FakeCrmStore {
  private readonly dealStages = new Map<string, string>();
  private readonly contactTags = new Map<string, string[]>();
  private readonly owners = new Map<string, string>();
  private readonly tasks: CrmMutation[] = [];
  private readonly notes: CrmMutation[] = [];
  private readonly notifications: CrmMutation[] = [];
  private readonly followups: CrmMutation[] = [];
  private readonly audit: CrmMutation[] = [];

  apply(kind: CrmMutationKind, mutation: Omit<CrmMutation, 'kind'>): string {
    const record = Object.freeze({ kind, ...mutation });
    switch (kind) {
      case 'deal-stage':
        this.dealStages.set(mutation.entityId, mutation.value);
        break;
      case 'contact-tag': {
        const tags = this.contactTags.get(mutation.entityId) ?? [];
        if (!tags.includes(mutation.value)) tags.push(mutation.value);
        this.contactTags.set(mutation.entityId, tags);
        break;
      }
      case 'task':
        this.tasks.push(record);
        break;
      case 'note':
        this.notes.push(record);
        break;
      case 'owner':
        this.owners.set(mutation.entityId, mutation.value);
        break;
      case 'notification':
        this.notifications.push(record);
        break;
      case 'followup':
        this.followups.push(record);
        break;
      case 'audit':
        this.audit.push(record);
        break;
    }
    return `${kind}-${this.effectCount()}`;
  }

  effectCount(): number {
    return (
      this.dealStages.size +
      [...this.contactTags.values()].reduce((count, tags) => count + tags.length, 0) +
      this.tasks.length +
      this.notes.length +
      this.owners.size +
      this.notifications.length +
      this.followups.length +
      this.audit.length
    );
  }

  snapshot(): CrmState {
    return Object.freeze({
      dealStages: Object.freeze(Object.fromEntries(this.dealStages)),
      contactTags: Object.freeze(
        Object.fromEntries([...this.contactTags].map(([id, tags]) => [id, Object.freeze([...tags])])),
      ),
      tasks: Object.freeze([...this.tasks]),
      notes: Object.freeze([...this.notes]),
      owners: Object.freeze(Object.fromEntries(this.owners)),
      notifications: Object.freeze([...this.notifications]),
      followups: Object.freeze([...this.followups]),
      audit: Object.freeze([...this.audit]),
    });
  }
}
