import { ids } from '@safescript/contracts';
import type { SourceProgram } from '@safescript/sdk';

import type { BuildingSensorEvent } from './contract.js';

export const BUILDING_INPUT: BuildingSensorEvent = Object.freeze({
  buildingId: 'building-riverfront',
  zoneId: 'level-03-west',
  temperatureTenths: 268n,
  humidityPercent: 68n,
  lightLux: 72n,
  occupied: true,
});

export const BUILDING_SOURCE: SourceProgram = Object.freeze({
  moduleId: ids.module('module:example.smart-building/comfort-control'),
  source: `import { Err, Ok, type Result } from "safescript:prelude"
import { type BuildingActionError, type BuildingSensorEvent, type Context } from "host:api"

export async function run(
  event: BuildingSensorEvent,
  ctx: Context,
): Promise<Result<void, BuildingActionError>> {
  const comfortTarget = 220n
  const temperatureDelta = event.temperatureTenths - comfortTarget

  if (event.occupied && temperatureDelta > 25n) {
    const cooling = await ctx.hvac.set({
      buildingId: event.buildingId,
      zoneId: event.zoneId,
      value: "cool to 22C",
    })
    if (cooling.tag === "error") return Err(cooling.value)
  }

  if (!event.occupied && event.lightLux < 100n) {
    const lights = await ctx.lighting.set({
      buildingId: event.buildingId,
      zoneId: event.zoneId,
      value: "off",
    })
    if (lights.tag === "error") return Err(lights.value)
  }

  console.info("comfort delta", temperatureDelta)
  const audit = await ctx.audit.record({
    buildingId: event.buildingId,
    zoneId: event.zoneId,
    value: \`temperature delta: \${temperatureDelta}\`,
  })
  if (audit.tag === "error") return Err(audit.value)
  return Ok()
}
`,
});
