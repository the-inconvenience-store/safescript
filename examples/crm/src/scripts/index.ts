/**
 * Canonical restricted TypeScript bodies executed by SafeScript.
 *
 * Action inputs are deliberately written out in full so readers can see exactly
 * what crosses the host boundary. These strings are wrapped in a typed `run`
 * function by the automation catalog.
 */
export const scripts = {
  wonOnboardingTask: `if (event.previousStage === "won" || event.stage !== "won" || event.currency !== "AUD" || event.amountMinor < 2_000_000) return Ok()
  const result = await ctx.tasks.create({
    workspaceId: event.workspaceId,
    entityId: event.dealId,
    value: \`Onboard \${event.name}\`,
  })
  if (result.tag === "error") return Err(result.value)
  return Ok()`,

  vipContactTag: `if (event.amountMinor < 2_000_000) return Ok()
  const result = await ctx.contacts.tag({
    workspaceId: event.workspaceId,
    entityId: event.contactId,
    value: "vip",
  })
  if (result.tag === "error") return Err(result.value)
  return Ok()`,

  inboundOwnerAssignment: `if (event.source !== "web") return Ok()
  const result = await ctx.owners.assign({
    workspaceId: event.workspaceId,
    entityId: event.dealId,
    value: event.ownerId,
  })
  if (result.tag === "error") return Err(result.value)
  return Ok()`,

  staleFollowup: `if (event.inactivityDays < 30) return Ok()
  const result = await ctx.followups.schedule({
    workspaceId: event.workspaceId,
    entityId: event.dealId,
    value: \`Follow up after \${event.inactivityDays} days\`,
  })
  if (result.tag === "error") return Err(result.value)
  return Ok()`,

  lostDealNote: `if (event.stage !== "lost") return Ok()
  const result = await ctx.notes.create({
    workspaceId: event.workspaceId,
    entityId: event.dealId,
    value: \`Lost deal: \${event.name}\`,
  })
  if (result.tag === "error") return Err(result.value)
  return Ok()`,

  welcomeNotification: `if (event.stage !== "won") return Ok()
  const result = await ctx.notifications.send({
    workspaceId: event.workspaceId,
    entityId: event.contactId,
    value: \`Welcome \${event.email}\`,
  })
  if (result.tag === "error") return Err(result.value)
  return Ok()`,

  normalizeStage: `if (event.stage !== "pending") return Ok()
  const result = await ctx.deals.stage({
    workspaceId: event.workspaceId,
    entityId: event.dealId,
    value: "qualified",
  })
  if (result.tag === "error") return Err(result.value)
  return Ok()`,

  stageAudit: `if (event.previousStage === event.stage) return Ok()
  const result = await ctx.audit.record({
    workspaceId: event.workspaceId,
    entityId: event.dealId,
    value: \`\${event.previousStage} -> \${event.stage}\`,
  })
  if (result.tag === "error") return Err(result.value)
  return Ok()`,

  highValueEscalation: `if (event.amountMinor < 2_000_000) return Ok()
  const task = await ctx.tasks.create({
    workspaceId: event.workspaceId,
    entityId: event.dealId,
    value: \`Review \${event.name}\`,
  })
  if (task.tag === "error") return Err(task.value)
  const notice = await ctx.notifications.send({
    workspaceId: event.workspaceId,
    entityId: event.ownerId,
    value: \`High value: \${event.name}\`,
  })
  if (notice.tag === "error") return Err(notice.value)
  return Ok()`,

  nurtureSequence: `if (event.stage !== "new") return Ok()
  const tag = await ctx.contacts.tag({
    workspaceId: event.workspaceId,
    entityId: event.contactId,
    value: "nurture",
  })
  if (tag.tag === "error") return Err(tag.value)
  const followup = await ctx.followups.schedule({
    workspaceId: event.workspaceId,
    entityId: event.dealId,
    value: "Nurture day 3",
  })
  if (followup.tag === "error") return Err(followup.value)
  return Ok()`,
} as const;
