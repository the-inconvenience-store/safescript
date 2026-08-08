/** The trusted CRM data model used by the example host application. */

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

/** Returns a fresh baseline so Reset CRM never shares mutable state with a previous run. */
export function createInitialCrmState(): CrmState {
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
