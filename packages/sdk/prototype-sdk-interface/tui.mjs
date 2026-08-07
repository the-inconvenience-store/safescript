#!/usr/bin/env node
// Run: node packages/sdk/prototype-sdk-interface/tui.mjs

import { createInterface } from "node:readline"
import { initialState, reduce, scenarios } from "./model.mjs"

const bold = "\x1b[1m"
const dim = "\x1b[2m"
const reset = "\x1b[0m"
let state = initialState

function render(clear = true) {
  const scenario = scenarios[state.selected]
  if (clear && process.stdout.isTTY) console.clear()
  console.log(`${bold}SafeScript TypeScript SDK interface — PROTOTYPE${reset}`)
  console.log(`${dim}Question: does one facade hide bridge mechanics across production and tests?${reset}\n`)
  console.log(`${bold}Facade${reset}: defineContract(...) → createSafeScript(...)`)
  console.log(`${bold}Methods${reset}: check  inspect  execute  test  cancel  close`)
  console.log(`${bold}Lifecycle${reset}: ${state.lifecycle}`)
  console.log(`${bold}Active invocation${reset}: ${state.activeInvocation}`)
  console.log(`${bold}Calls${reset}: ${state.calls}`)
  console.log(`${bold}Last result${reset}: ${state.lastResult}\n`)
  console.log(`${bold}Selected: ${scenario.name}${reset}`)
  console.log(`  ${scenario.call}`)
  console.log(`  ${dim}→ ${scenario.result}${reset}\n`)
  console.log(`${bold}Controls${reset}: ${scenarios.map(item => `[${item.key}] ${item.name}`).join("  ")}`)
  console.log(`[Enter] run selected  [r] reset  [q] quit`)
}

if (process.argv.includes("--check")) {
  let checked = initialState
  for (let index = 0; index < scenarios.length; index += 1) {
    checked = reduce(checked, { type: "select", index })
    checked = reduce(checked, { type: "run" })
  }
  if (checked.lifecycle !== "closed" || checked.calls !== scenarios.length) throw new Error("prototype lifecycle changed")
  console.log("PASS candidate SDK lifecycle")
  process.exit(0)
}

render()
const input = createInterface({ input: process.stdin, output: process.stdout })
input.on("line", line => {
  const key = line.trim().toLowerCase()
  if (key === "q") return input.close()
  if (key === "r") state = initialState
  else if (/^[1-7]$/.test(key)) state = reduce(state, { type: "select", index: Number(key) - 1 })
  else state = reduce(state, { type: "run" })
  render()
})

