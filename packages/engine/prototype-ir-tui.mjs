// Run: node packages/engine/prototype-ir-tui.mjs
// Check: node packages/engine/prototype-ir-tui.mjs --check

import assert from "node:assert/strict";
import readline from "node:readline";
import { begin, program, resume, runToBoundary, step } from "./prototype-ir-core.mjs";

const deal = (overrides = {}) => ({
  before: { stage: "open" },
  after: {
    stage: "won",
    amount: { currency: "AUD", minorUnits: 2_000_000n },
    workspaceId: "workspace:1",
    id: "deal:1",
    name: "Acme",
    ...overrides,
  },
});

let state = begin(deal());

function reset(kind) {
  if (kind === "qualifying") state = begin(deal());
  if (kind === "below") state = begin(deal({ amount: { currency: "AUD", minorUnits: 1_999_999n } }));
  if (kind === "fuel") state = begin(deal(), { fuel: 4 });
}

function outcome(status) {
  const requestId = state.pending?.request.requestId;
  if (status === "success") return { requestId, status: "succeeded", value: { tag: "ok", value: { id: "task:1" } } };
  if (status === "rejected") return { requestId, status: "rejected", error: { tag: "policy", value: { reason: "denied" } } };
  return { requestId: "request:wrong", status: "succeeded", value: { nope: true } };
}

function currentInstruction() {
  if (state.phase !== "running") return null;
  const fn = program.functions[0];
  const block = fn.blocks[state.block];
  return block.ops[state.instruction] ?? block.end;
}

function render() {
  console.clear();
  console.log("\x1b[1mSafeScript typed IR prototype\x1b[0m");
  console.log("\x1b[2mQuestion: can a typed basic-block machine expose suspension and charges without leaking VM internals?\x1b[0m\n");
  console.log(JSON.stringify({
    phase: state.phase,
    location: state.phase === "running" ? `${state.block}:${state.instruction}` : state.block,
    next: currentInstruction(),
    resources: state.resources,
    pending: state.pending,
    result: state.result,
    error: state.error,
    actionRecords: state.actionRecords,
  }, (_, value) => typeof value === "bigint" ? `${value}n` : value, 2));
  console.log("\n[1] qualifying  [2] below threshold  [3] low fuel  [n] step  [r] run to boundary");
  console.log("[s] successful outcome  [p] policy rejection  [m] malformed outcome  [q] quit");
}

function check() {
  let qualifying = runToBoundary(begin(deal()));
  assert.equal(qualifying.phase, "suspended");
  assert.equal(qualifying.actionRecords.length, 1);
  qualifying = runToBoundary(resume(qualifying, {
    requestId: qualifying.pending.request.requestId,
    status: "succeeded",
    value: { tag: "ok", value: { id: "task:1" } },
  }));
  assert.deepEqual(qualifying.result, { tag: "ok", value: { kind: "unit" } });
  let rejected = runToBoundary(begin(deal()));
  rejected = runToBoundary(resume(rejected, {
    requestId: rejected.pending.request.requestId,
    status: "rejected",
    error: { tag: "policy", value: { reason: "denied" } },
  }));
  assert.equal(rejected.result.tag, "error");
  let malformed = runToBoundary(begin(deal()));
  malformed = resume(malformed, { requestId: "request:wrong", status: "succeeded", value: { tag: "ok" } });
  assert.equal(malformed.error.code, "SS_ACTION_OUTCOME_MISMATCH");
  assert.equal(runToBoundary(begin(deal({ amount: { currency: "AUD", minorUnits: 1n } }))).actionRecords.length, 0);
  assert.equal(runToBoundary(begin(deal(), { fuel: 1 })).error.code, "SS_RESOURCE_LIMIT");
  console.log("prototype checks passed");
}

if (process.argv.includes("--check")) {
  check();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  render();
  rl.on("line", (line) => {
    const key = line.trim().toLowerCase();
    if (key === "q") return rl.close();
    if (key === "1") reset("qualifying");
    else if (key === "2") reset("below");
    else if (key === "3") reset("fuel");
    else if (key === "n") state = step(state);
    else if (key === "r") state = runToBoundary(state);
    else if (key === "s") state = resume(state, outcome("success"));
    else if (key === "p") state = resume(state, outcome("rejected"));
    else if (key === "m") state = resume(state, outcome("malformed"));
    render();
  });
}
