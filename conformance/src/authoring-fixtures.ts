import { ids } from '@safescript/contracts';

import type { ReferenceIntegration } from './references.js';

/** Exact sources produced by the isolated blind-agent authoring runs. */
export const blindApplicationExtensionReference: ReferenceIntegration = Object.freeze({
  name: 'application-extension',
  moduleId: ids.module('module:authoring/application-extension'),
  expectedOperations: ['operation:tasks.create', 'operation:notifications.send'],
  source: `import { Err, Ok, type Result } from "safescript:prelude"
import {
  type Context,
  type ReferenceActionError,
  type ReferenceActionInput,
  type ReferenceEvent,
} from "host:api"

type Contact =
  | Readonly<{ tag: "email"; value: string }>
  | Readonly<{ tag: "unavailable" }>

interface Stakeholder {
  readonly name: string
  readonly contact: Contact
  readonly children: readonly Stakeholder[]
}

function collectEmails(stakeholder: Stakeholder): readonly string[] {
  const ownEmails: readonly string[] =
    stakeholder.contact.tag === "email"
      ? [stakeholder.contact.value]
      : []

  return stakeholder.children.reduce(
    (emails: readonly string[], child: Stakeholder) =>
      emails.concat(collectEmails(child)),
    ownEmails,
  )
}

export async function run(
  event: ReferenceEvent,
  ctx: Context,
): Promise<Result<void, ReferenceActionError>> {
  if (event.after.stage !== "won") {
    return Ok()
  }

  const taskInput: ReferenceActionInput = {
    workspaceId: event.after.workspaceId,
    relatedDealId: event.after.id,
    title: \`Onboard \${event.after.name}\`,
  }

  const taskResult = await ctx.tasks.create(taskInput)
  switch (taskResult.tag) {
    case "error":
      return Err(taskResult.value)
    case "ok":
      break
  }

  const stakeholders: Stakeholder = {
    name: event.after.name,
    contact: { tag: "unavailable" },
    children: [
      {
        name: "Executive sponsor",
        contact: { tag: "email", value: "sponsor@example.com" },
        children: [],
      },
      {
        name: "Implementation team",
        contact: { tag: "unavailable" },
        children: [
          {
            name: "Project lead",
            contact: { tag: "email", value: "project@example.com" },
            children: [],
          },
          {
            name: "Technical lead",
            contact: { tag: "unavailable" },
            children: [],
          },
        ],
      },
    ],
  }

  const emails = collectEmails(stakeholders)
  const recipients = emails.join(", ")

  const internalNotification: ReferenceActionInput = {
    workspaceId: event.after.workspaceId,
    relatedDealId: event.after.id,
    title: \`Won deal: \${event.after.name}; onboarding task \${taskResult.value.id}\`,
  }

  const stakeholderNotification: ReferenceActionInput = {
    workspaceId: event.after.workspaceId,
    relatedDealId: event.after.id,
    title: \`Onboarding contacts for \${event.after.name}: \${recipients}\`,
  }

  const notificationResults = await Promise.all([
    ctx.notifications.send(internalNotification),
    ctx.notifications.send(stakeholderNotification),
  ])

  const internalResult = notificationResults[0]
  switch (internalResult.tag) {
    case "error":
      return Err(internalResult.value)
    case "ok":
      break
  }

  const stakeholderResult = notificationResults[1]
  switch (stakeholderResult.tag) {
    case "error":
      return Err(stakeholderResult.value)
    case "ok":
      return Ok()
  }
}`,
});

export const blindDeviceRuleReference: ReferenceIntegration = Object.freeze({
  name: 'device-rule',
  moduleId: ids.module('module:authoring/device-rule'),
  expectedOperations: ['operation:actuator.set'],
  source: `import { Err, Ok, type Result } from "safescript:prelude"
import {
  type Context,
  type ReferenceActionError,
  type ReferenceDealId,
  type ReferenceEvent,
} from "host:api"

type DeviceNode =
  | Readonly<{
      tag: "device"
      name: string
      dealId: ReferenceDealId
    }>
  | Readonly<{
      tag: "group"
      name: string
      children: readonly DeviceNode[]
    }>

interface Trace {
  readonly header: number
  readonly enabled: boolean
  readonly armed: boolean
  readonly dealFound: boolean
  readonly observedAt: string
  readonly sample: number
  readonly traceValue: number
}

function containsDeal(node: DeviceNode, wanted: ReferenceDealId): boolean {
  switch (node.tag) {
    case "device":
      return node.dealId === wanted
    case "group":
      return node.children.some((child) => containsDeal(child, wanted))
  }
}

export async function run(
  event: ReferenceEvent,
  ctx: Context,
): Promise<Result<void, ReferenceActionError>> {
  const packet = Bytes.fromHex("a503")
  const header = packet[0]
  const flags = packet[1]
  const enabled = flags % 2 === 1
  const armed = Math.floor(flags / 2) % 2 === 1

  const tree: DeviceNode = {
    tag: "group",
    name: "actuators",
    children: [
      {
        tag: "group",
        name: "primary",
        children: [
          {
            tag: "device",
            name: "deal-actuator",
            dealId: event.after.id,
          },
        ],
      },
      {
        tag: "device",
        name: "previous-deal-monitor",
        dealId: event.before.id,
      },
    ],
  }

  const dealFound = containsDeal(tree, event.after.id)
  const observedAt = Temporal.Now.instant().toString()
  const sample = Math.random()
  const traceValue = Math.floor(
    Math.abs(event.after.amount.minorUnits) * sample,
  )
  const trace: Trace = {
    header: header,
    enabled: enabled,
    armed: armed,
    dealFound: dealFound,
    observedAt: observedAt,
    sample: sample,
    traceValue: traceValue,
  }
  console.info("device-rule", trace)

  const qualifies =
    header === 165 &&
    enabled &&
    armed &&
    dealFound &&
    event.before.stage !== event.after.stage &&
    event.after.stage === "closed_won"

  if (!qualifies) {
    return Ok()
  }

  const action = await ctx.actuator.set({
    workspaceId: event.after.workspaceId,
    relatedDealId: event.after.id,
    title: \`activate:\${event.after.name}:\${traceValue}\`,
  })

  switch (action.tag) {
    case "ok":
      return Ok()
    case "error":
      return Err(action.value)
  }
}`,
});
