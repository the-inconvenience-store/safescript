#!/usr/bin/env node
// Run: node packages/engine/prototype-resource-calibration/tui.mjs

import { createInterface } from "node:readline"
import { evaluateAll, profiles, schedule, workloads } from "./model.mjs"

const bold = "\x1b[1m"
const dim = "\x1b[2m"
const reset = "\x1b[0m"
const profileNames = Object.keys(profiles)
let profileIndex = 1
let workloadIndex = 0

const number = value => new Intl.NumberFormat("en-AU").format(value)
const percent = ratio => `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`

function render(clear = true) {
  const profileName = profileNames[profileIndex]
  const result = evaluateAll(profileName)[workloadIndex]
  if (clear && process.stdout.isTTY) console.clear()
  console.log(`${bold}SafeScript semantic resource calibration — PROTOTYPE${reset}`)
  console.log(`${dim}Question: does one schedule plus a standard profile fit useful V1 work and stop abuse?${reset}\n`)
  console.log(`${bold}Workload${reset}: ${result.workload.name}`)
  console.log(`${dim}${result.workload.note}${reset}`)
  console.log(`${bold}Profile${reset}: ${profileName}    ${bold}Verdict${reset}: ${result.passes ? "PASS" : "LIMITED"}\n`)
  console.log(`${bold}Limit ledger${reset}`)
  for (const [name, check] of Object.entries(result.checks)) {
    const marker = check.passes ? " " : "!"
    console.log(`${marker} ${name.padEnd(19)} ${number(check.value).padStart(12)} / ${number(check.limit).padEnd(12)} ${percent(check.ratio).padStart(7)}`)
  }
  console.log(`\n${bold}Fuel composition${reset}`)
  for (const [name, value] of Object.entries(result.fuelParts).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${name.padEnd(19)} ${number(value).padStart(12)}`)
  }
  console.log(`\n${bold}Controls${reset}: ${workloads.map((_, index) => `[${index + 1}]`).join(" ")} workload  [p] profile  [s] schedule  [q] quit`)
}

function printSchedule() {
  if (process.stdout.isTTY) console.clear()
  console.log(`${bold}Candidate charge schedule${reset}`)
  for (const [name, weight] of Object.entries(schedule)) console.log(`${name.padEnd(24)} ${weight}`)
  console.log(`\n${dim}Press Enter to return.${reset}`)
}

if (process.argv.includes("--check")) {
  const standard = evaluateAll("standard")
  const expected = [true, true, true, true, false]
  if (standard.some((result, index) => result.passes !== expected[index])) throw new Error("standard profile verdict changed")
  for (const result of standard) console.log(`${result.passes ? "PASS" : "LIMITED"} ${result.workload.name}: fuel ${number(result.usage.fuel)}`)
  process.exit(0)
}

render()
const input = createInterface({ input: process.stdin, output: process.stdout })
input.on("line", line => {
  const key = line.trim().toLowerCase()
  if (key === "q") return input.close()
  if (key === "p") profileIndex = (profileIndex + 1) % profileNames.length
  if (/^[1-5]$/.test(key)) workloadIndex = Number(key) - 1
  if (key === "s") {
    printSchedule()
    return
  }
  render()
})

