import type { AutomationEvent } from '../contract.js';
import {
  createInitialCrmState,
  type CrmContact,
  type CrmDeal,
  type CrmEventRecord,
  type CrmMutation,
  type CrmMutationKind,
  type CrmOwner,
  type CrmState,
  type CrmWorkspace,
} from './model.js';

/** Trusted in-memory CRM behind the SafeScript action gateway. */
export class CrmStore {
  private readonly workspace: CrmWorkspace;
  private readonly deals: Map<string, CrmDeal>;
  private readonly contacts: Map<string, CrmContact>;
  private readonly owners: Map<string, CrmOwner>;
  private readonly recentEvents: CrmEventRecord[];
  private readonly relatedRecords: Record<'tasks' | 'notes' | 'notifications' | 'followups' | 'audit', CrmMutation[]>;
  private appliedEffects = 0;

  constructor(seed: CrmState = createInitialCrmState()) {
    this.workspace = { ...seed.workspace };
    this.deals = new Map(Object.entries(seed.deals).map(([id, deal]) => [id, { ...deal }]));
    this.contacts = new Map(
      Object.entries(seed.contacts).map(([id, contact]) => [id, { ...contact, tags: [...contact.tags] }]),
    );
    this.owners = new Map(Object.entries(seed.owners).map(([id, owner]) => [id, { ...owner }]));
    this.recentEvents = [...seed.recentEvents];
    this.relatedRecords = {
      tasks: [...seed.tasks],
      notes: [...seed.notes],
      notifications: [...seed.notifications],
      followups: [...seed.followups],
      audit: [...seed.audit],
    };
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

  /** Executes one trusted host action after the application's configured gateway checks. */
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
      case 'owner':
        this.requireOwner(mutation.value);
        this.deals.set(mutation.entityId, { ...this.requireDeal(mutation.entityId), ownerId: mutation.value });
        break;
      case 'notification':
        this.requireNotificationRecipient(mutation.entityId);
        this.relatedRecords.notifications.push(record);
        break;
      case 'task':
      case 'note':
      case 'followup':
      case 'audit':
        this.requireDeal(mutation.entityId);
        this.relatedRecords[this.collectionFor(kind)].push(record);
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
      tasks: Object.freeze([...this.relatedRecords.tasks]),
      notes: Object.freeze([...this.relatedRecords.notes]),
      notifications: Object.freeze([...this.relatedRecords.notifications]),
      followups: Object.freeze([...this.relatedRecords.followups]),
      audit: Object.freeze([...this.relatedRecords.audit]),
    });
  }

  private collectionFor(kind: 'task' | 'note' | 'followup' | 'audit'): 'tasks' | 'notes' | 'followups' | 'audit' {
    const collections = {
      task: 'tasks',
      note: 'notes',
      followup: 'followups',
      audit: 'audit',
    } as const;
    return collections[kind];
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

  private requireNotificationRecipient(id: string): void {
    if (!this.contacts.has(id) && !this.owners.has(id)) throw new Error(`unknown notification recipient ${id}`);
  }
}
