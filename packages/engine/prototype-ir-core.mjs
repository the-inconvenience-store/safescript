// THROWAWAY PROTOTYPE for safescript-buy.7.
// Question: does a typed register-and-basic-block IR make control flow,
// suspension, errors, and semantic charges explicit without exposing VM state?

const UNIT = { kind: "unit" };

export const program = {
  irVersion: { major: 1, minor: 0 },
  entry: "symbol:handler",
  functions: [{
    symbolId: "symbol:handler",
    params: [{ register: "event", type: "type:crm.deal-updated" }],
    result: "type:result-unit-task-error",
    entry: "before",
    blocks: {
      before: block([
        op("field", "beforeStage", "type:crm.stage", { from: "event", path: ["before", "stage"] }),
        op("const", "won1", "type:string", { value: "won" }),
        op("equal", "wasWon", "type:boolean", { left: "beforeStage", right: "won1" }),
      ], { kind: "branch", condition: "wasWon", then: "noAction", else: "after" }),
      after: block([
        op("field", "afterStage", "type:crm.stage", { from: "event", path: ["after", "stage"] }),
        op("const", "won2", "type:string", { value: "won" }),
        op("equal", "isWon", "type:boolean", { left: "afterStage", right: "won2" }),
      ], { kind: "branch", condition: "isWon", then: "currency", else: "noAction" }),
      currency: block([
        op("field", "currency", "type:currency", { from: "event", path: ["after", "amount", "currency"] }),
        op("const", "aud", "type:string", { value: "AUD" }),
        op("equal", "isAud", "type:boolean", { left: "currency", right: "aud" }),
      ], { kind: "branch", condition: "isAud", then: "amount", else: "noAction" }),
      amount: block([
        op("field", "minorUnits", "type:int64", { from: "event", path: ["after", "amount", "minorUnits"] }),
        op("const", "threshold", "type:int64", { value: 2_000_000n }),
        op("less", "below", "type:boolean", { left: "minorUnits", right: "threshold" }),
      ], { kind: "branch", condition: "below", then: "noAction", else: "prepare" }),
      prepare: block([
        op("field", "workspaceId", "type:crm.workspace-id", { from: "event", path: ["after", "workspaceId"] }),
        op("field", "dealId", "type:crm.deal-id", { from: "event", path: ["after", "id"] }),
        op("field", "name", "type:string", { from: "event", path: ["after", "name"] }),
        op("template", "title", "type:string", { parts: ["Onboard ", { register: "name" }], maxUtf8Bytes: 264 }),
        op("record", "actionInput", "type:tasks.create-input", {
          fields: [["workspaceId", "workspaceId"], ["relatedDealId", "dealId"], ["title", "title"]],
        }),
      ], {
        kind: "action",
        operationId: "operation:tasks.create",
        effectId: "effect:tasks.create",
        capabilityId: "capability:tasks.write",
        actionSiteId: "action-site:fixture",
        input: "actionInput",
        resultType: "type:result-task-task-error",
        result: "actionResult",
        resume: "afterAction",
      }),
      afterAction: block([], {
        kind: "switch",
        value: "actionResult",
        cases: [
          { tag: "ok", target: "success" },
          { tag: "error", payload: "taskError", target: "failure" },
        ],
      }),
      noAction: block([
        op("const", "unit1", "type:unit", { value: UNIT }),
        op("variant", "ok1", "type:result-unit-task-error", { tag: "ok", payload: "unit1" }),
      ], { kind: "return", value: "ok1" }),
      success: block([
        op("const", "unit2", "type:unit", { value: UNIT }),
        op("variant", "ok2", "type:result-unit-task-error", { tag: "ok", payload: "unit2" }),
      ], { kind: "return", value: "ok2" }),
      failure: block([
        op("variant", "errorResult", "type:result-unit-task-error", { tag: "error", payload: "taskError" }),
      ], { kind: "return", value: "errorResult" }),
    },
  }],
};

function op(kind, dest, type, rest) {
  return { kind, dest, type, ...rest };
}

function block(ops, end) {
  return { ops, end };
}

export function begin(input, limits = {}) {
  return {
    phase: "running",
    function: program.entry,
    block: "before",
    instruction: 0,
    registers: { event: input },
    resources: { fuel: 0, allocations: 0, memoryBytes: 0, hostCalls: 0 },
    limits: {
      fuel: limits.fuel ?? 100,
      allocations: limits.allocations ?? 20,
      memoryBytes: limits.memoryBytes ?? 4_096,
      hostCalls: limits.hostCalls ?? 1,
    },
    invocationId: limits.invocationId ?? "invocation:prototype",
    nextRequest: 0,
    actionRecords: [],
  };
}

export function step(previous) {
  if (previous.phase !== "running") return previous;
  const state = structuredClone(previous);
  const fn = program.functions[0];
  const current = fn.blocks[state.block];
  const instruction = current.ops[state.instruction];
  if (instruction) {
    if (!charge(state, { fuel: 1, allocations: allocating(instruction) ? 1 : 0, memoryBytes: allocationBytes(instruction, state) })) return state;
    try {
      state.registers[instruction.dest] = evaluate(instruction, state.registers);
      state.instruction++;
    } catch (error) {
      fail(state, "SS_EXECUTION_INVALID_IR", error.message);
    }
    return state;
  }
  return terminate(state, current.end);
}

export function runToBoundary(state) {
  while (state.phase === "running") state = step(state);
  return state;
}

export function resume(previous, outcome) {
  if (previous.phase !== "suspended") return previous;
  const state = structuredClone(previous);
  if (outcome.requestId !== state.pending.request.requestId) {
    fail(state, "SS_ACTION_OUTCOME_MISMATCH", "request ID does not match pending action");
    return state;
  }
  state.actionRecords.push({ phase: "completed", requestId: outcome.requestId, status: outcome.status });
  if (outcome.status === "succeeded" && outcome.value?.tag && ["ok", "error"].includes(outcome.value.tag)) {
    state.registers[state.pending.result] = outcome.value;
    state.block = state.pending.resume;
    state.instruction = 0;
    state.phase = "running";
    delete state.pending;
  } else if (outcome.status === "rejected" && outcome.error?.tag === "policy") {
    state.registers[state.pending.result] = { tag: "error", value: outcome.error };
    state.block = state.pending.resume;
    state.instruction = 0;
    state.phase = "running";
    delete state.pending;
  } else {
    fail(state, "SS_ACTION_OUTCOME_INVALID", "outcome does not match the registered operation schema");
  }
  return state;
}

function terminate(state, end) {
  if (!charge(state, { fuel: 1, hostCalls: end.kind === "action" ? 1 : 0 })) return state;
  switch (end.kind) {
    case "branch":
      return enter(state, state.registers[end.condition] ? end.then : end.else);
    case "switch": {
      const value = state.registers[end.value];
      const selected = end.cases.find((item) => item.tag === value?.tag);
      if (!selected) return fail(state, "SS_EXECUTION_INVALID_VARIANT", "no matching closed-union case");
      if (selected.payload) state.registers[selected.payload] = value.value;
      return enter(state, selected.target);
    }
    case "action": {
      const sequence = state.nextRequest++;
      const request = {
        requestId: `request:${state.invocationId}:${sequence}`,
        operationId: end.operationId,
        effectId: end.effectId,
        capabilityId: end.capabilityId,
        actionSiteId: end.actionSiteId,
        input: state.registers[end.input],
      };
      state.actionRecords.push({ phase: "requested", request });
      state.pending = { request, result: end.result, resultType: end.resultType, resume: end.resume };
      state.phase = "suspended";
      return state;
    }
    case "return":
      state.phase = "completed";
      state.result = state.registers[end.value];
      return state;
    default:
      return fail(state, "SS_EXECUTION_INVALID_IR", `unknown terminator ${end.kind}`);
  }
}

function enter(state, target) {
  state.block = target;
  state.instruction = 0;
  return state;
}

function evaluate(instruction, registers) {
  switch (instruction.kind) {
    case "const": return instruction.value;
    case "field": return instruction.path.reduce((value, key) => value[key], registers[instruction.from]);
    case "equal": return deepEqual(registers[instruction.left], registers[instruction.right]);
    case "less": return registers[instruction.left] < registers[instruction.right];
    case "template": return instruction.parts.map((part) => typeof part === "string" ? part : registers[part.register]).join("");
    case "record": return Object.fromEntries(instruction.fields.map(([name, register]) => [name, registers[register]]));
    case "variant": return { tag: instruction.tag, value: registers[instruction.payload] };
    default: throw new Error(`unknown instruction ${instruction.kind}`);
  }
}

function deepEqual(left, right) {
  return typeof left === "object" ? JSON.stringify(left) === JSON.stringify(right) : left === right;
}

function allocating(instruction) {
  return ["template", "record", "variant"].includes(instruction.kind);
}

function allocationBytes(instruction, state) {
  if (instruction.kind === "template") return instruction.parts.reduce((size, part) => size + Buffer.byteLength(typeof part === "string" ? part : String(state.registers[part.register])), 0);
  if (instruction.kind === "record") return instruction.fields.length * 16;
  if (instruction.kind === "variant") return 16;
  return 0;
}

function charge(state, delta) {
  for (const resource of ["fuel", "allocations", "memoryBytes", "hostCalls"]) {
    const next = state.resources[resource] + (delta[resource] ?? 0);
    if (next > state.limits[resource]) {
      fail(state, "SS_RESOURCE_LIMIT", resource);
      return false;
    }
    state.resources[resource] = next;
  }
  return true;
}

function fail(state, code, detail) {
  state.phase = "failed";
  state.error = { code, detail, block: state.block, instruction: state.instruction };
  delete state.pending;
  return state;
}

