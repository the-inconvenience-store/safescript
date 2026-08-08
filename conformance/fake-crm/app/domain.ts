export type CrmMutationKind =
  'deal-stage' | 'contact-tag' | 'task' | 'note' | 'owner' | 'notification' | 'followup' | 'audit';

export interface CrmMutation {
  readonly kind: CrmMutationKind;
  readonly workspaceId: string;
  readonly entityId: string;
  readonly value: string;
}

export interface CrmWorkspace {
  readonly id: string;
  readonly name: string;
}

export interface CrmDeal {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly contactId: string;
  readonly ownerId: string;
  readonly stage: string;
  readonly source: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly inactivityDays: number;
}

export interface CrmContact {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly email: string;
  readonly tags: readonly string[];
}

export interface CrmOwner {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly role: string;
}

export interface CrmEventRecord {
  readonly automationId: string;
  readonly dealId: string;
  readonly contactId: string;
  readonly previousStage: string;
  readonly stage: string;
  readonly source: string;
}

export interface CrmState {
  readonly workspace: CrmWorkspace;
  readonly deals: Readonly<Record<string, CrmDeal>>;
  readonly contacts: Readonly<Record<string, CrmContact>>;
  readonly owners: Readonly<Record<string, CrmOwner>>;
  readonly recentEvents: readonly CrmEventRecord[];
  readonly tasks: readonly CrmMutation[];
  readonly notes: readonly CrmMutation[];
  readonly notifications: readonly CrmMutation[];
  readonly followups: readonly CrmMutation[];
  readonly audit: readonly CrmMutation[];
}

/** A coherent CRM baseline shared by every fixture automation and restored by reset. */
export function createBaseCrmState(): CrmState {
  return Object.freeze({
    workspace: Object.freeze({ id: 'workspace-acme', name: 'Acme Research' }),
    deals: Object.freeze({
      'deal-100': Object.freeze({
        id: 'deal-100',
        workspaceId: 'workspace-acme',
        name: 'Analytical Engine rollout',
        contactId: 'contact-100',
        ownerId: 'owner-riley',
        stage: 'qualified',
        source: 'web',
        currency: 'AUD',
        amountMinor: 2_500_000,
        inactivityDays: 45,
      }),
    }),
    contacts: Object.freeze({
      'contact-100': Object.freeze({
        id: 'contact-100',
        workspaceId: 'workspace-acme',
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        tags: Object.freeze(['prospect']),
      }),
    }),
    owners: Object.freeze({
      'owner-alex': Object.freeze({
        id: 'owner-alex',
        workspaceId: 'workspace-acme',
        name: 'Alex Morgan',
        role: 'Account executive',
      }),
      'owner-riley': Object.freeze({
        id: 'owner-riley',
        workspaceId: 'workspace-acme',
        name: 'Riley Chen',
        role: 'Inbound queue',
      }),
    }),
    recentEvents: Object.freeze([]),
    tasks: Object.freeze([]),
    notes: Object.freeze([]),
    notifications: Object.freeze([]),
    followups: Object.freeze([]),
    audit: Object.freeze([]),
  });
}

/** Tiny in-memory CRM used as the trusted application behind the SafeScript gateway. */
export class FakeCrmStore {
  private readonly workspace: CrmWorkspace;
  private readonly deals: Map<string, CrmDeal>;
  private readonly contacts: Map<string, CrmContact>;
  private readonly owners: Map<string, CrmOwner>;
  private readonly tasks: CrmMutation[];
  private readonly recentEvents: CrmEventRecord[];
  private readonly notes: CrmMutation[];
  private readonly notifications: CrmMutation[];
  private readonly followups: CrmMutation[];
  private readonly audit: CrmMutation[];
  private appliedEffects = 0;

  constructor(seed: CrmState = createBaseCrmState()) {
    this.workspace = { ...seed.workspace };
    this.deals = new Map(Object.entries(seed.deals).map(([id, deal]) => [id, { ...deal }]));
    this.contacts = new Map(
      Object.entries(seed.contacts).map(([id, contact]) => [id, { ...contact, tags: [...contact.tags] }]),
    );
    this.owners = new Map(Object.entries(seed.owners).map(([id, owner]) => [id, { ...owner }]));
    this.recentEvents = [...seed.recentEvents];
    this.tasks = [...seed.tasks];
    this.notes = [...seed.notes];
    this.notifications = [...seed.notifications];
    this.followups = [...seed.followups];
    this.audit = [...seed.audit];
  }

  /** Applies the host application's already-observed event before extension logic runs. */
  receiveEvent(automationId: string, event: AutomationEvent): void {
    const deal = this.requireDeal(event.dealId);
    const contact = this.requireContact(event.contactId);
    this.deals.set(deal.id, {
      ...deal,
      contactId: event.contactId,
      stage: event.stage,
      source: event.source,
      currency: event.currency,
      amountMinor: Number(event.amountMinor),
      inactivityDays: Number(event.inactivityDays),
    });
    this.contacts.set(contact.id, { ...contact, name: event.name, email: event.email });
    this.recentEvents.unshift(
      Object.freeze({
        automationId,
        dealId: event.dealId,
        contactId: event.contactId,
        previousStage: event.previousStage,
        stage: event.stage,
        source: event.source,
      }),
    );
  }

  apply(kind: CrmMutationKind, mutation: Omit<CrmMutation, 'kind'>): string {
    const record = Object.freeze({ kind, ...mutation });
    switch (kind) {
      case 'deal-stage': {
        const deal = this.requireDeal(mutation.entityId);
        this.deals.set(deal.id, { ...deal, stage: mutation.value });
        break;
      }
      case 'contact-tag': {
        const contact = this.requireContact(mutation.entityId);
        const tags = contact.tags.includes(mutation.value) ? contact.tags : [...contact.tags, mutation.value];
        this.contacts.set(contact.id, { ...contact, tags });
        break;
      }
      case 'task':
        this.requireDeal(mutation.entityId);
        this.tasks.push(record);
        break;
      case 'note':
        this.requireDeal(mutation.entityId);
        this.notes.push(record);
        break;
      case 'owner':
        this.requireOwner(mutation.value);
        this.deals.set(mutation.entityId, { ...this.requireDeal(mutation.entityId), ownerId: mutation.value });
        break;
      case 'notification':
        if (!this.contacts.has(mutation.entityId) && !this.owners.has(mutation.entityId)) {
          throw new Error(`unknown notification recipient ${mutation.entityId}`);
        }
        this.notifications.push(record);
        break;
      case 'followup':
        this.requireDeal(mutation.entityId);
        this.followups.push(record);
        break;
      case 'audit':
        this.requireDeal(mutation.entityId);
        this.audit.push(record);
        break;
    }
    this.appliedEffects += 1;
    return `${kind}-${this.appliedEffects}`;
  }

  effectCount(): number {
    return this.appliedEffects;
  }

  snapshot(): CrmState {
    return Object.freeze({
      workspace: Object.freeze({ ...this.workspace }),
      deals: Object.freeze(Object.fromEntries([...this.deals].map(([id, deal]) => [id, Object.freeze({ ...deal })]))),
      contacts: Object.freeze(
        Object.fromEntries(
          [...this.contacts].map(([id, contact]) => [
            id,
            Object.freeze({ ...contact, tags: Object.freeze([...contact.tags]) }),
          ]),
        ),
      ),
      owners: Object.freeze(
        Object.fromEntries([...this.owners].map(([id, owner]) => [id, Object.freeze({ ...owner })])),
      ),
      recentEvents: Object.freeze([...this.recentEvents]),
      tasks: Object.freeze([...this.tasks]),
      notes: Object.freeze([...this.notes]),
      notifications: Object.freeze([...this.notifications]),
      followups: Object.freeze([...this.followups]),
      audit: Object.freeze([...this.audit]),
    });
  }

  private requireDeal(id: string): CrmDeal {
    const deal = this.deals.get(id);
    if (!deal) throw new Error(`unknown deal ${id}`);
    return deal;
  }

  private requireContact(id: string): CrmContact {
    const contact = this.contacts.get(id);
    if (!contact) throw new Error(`unknown contact ${id}`);
    return contact;
  }

  private requireOwner(id: string): CrmOwner {
    const owner = this.owners.get(id);
    if (!owner) throw new Error(`unknown owner ${id}`);
    return owner;
  }
}
import type { AutomationEvent } from './contract.js';
