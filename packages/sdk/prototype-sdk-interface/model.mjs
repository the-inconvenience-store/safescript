// PROTOTYPE — pure state model for exercising the candidate SDK lifecycle.

export const scenarios = Object.freeze([
  { key: "1", name: "check", call: "safe.check({ slot, source })", result: "accepted + artifact + summary + diagnostics" },
  { key: "2", name: "inspect", call: "safe.inspect({ slot, source, views: [\"semanticGraph\"] })", result: "accepted + requested read-only views" },
  { key: "3", name: "execute source", call: "safe.execute({ slot, program: { kind: \"source\", source }, input, context, signal })", result: "completed + typed result + execution facts" },
  { key: "4", name: "execute artifact", call: "safe.execute({ slot, program: { kind: \"artifact\", bytes }, input, context })", result: "verified artifact execution; no unchecked path" },
  { key: "5", name: "deterministic test", call: "safe.test({ name, slot, program, input, actions, fixed, expect })", result: "report + mismatches + complete execution" },
  { key: "6", name: "cancel", call: "safe.cancel(invocationId) or AbortController.abort()", result: "accepted | not_active; execute reaches cancelled" },
  { key: "7", name: "close", call: "await safe.close()", result: "graceful idempotent close" },
])

export const initialState = Object.freeze({
  lifecycle: "open",
  selected: 0,
  activeInvocation: false,
  calls: 0,
  lastResult: "none",
})

export function reduce(state, action) {
  if (action.type === "select") return { ...state, selected: action.index }
  if (action.type === "run") {
    const scenario = scenarios[state.selected]
    if (state.lifecycle === "closed") return { ...state, calls: state.calls + 1, lastResult: "bridge_closed" }
    if (scenario.name === "close") return { ...state, lifecycle: "closed", activeInvocation: false, calls: state.calls + 1, lastResult: scenario.result }
    if (scenario.name === "cancel") return { ...state, activeInvocation: false, calls: state.calls + 1, lastResult: state.activeInvocation ? "accepted; execute cancelled" : "not_active" }
    return { ...state, activeInvocation: scenario.name === "execute source", calls: state.calls + 1, lastResult: scenario.result }
  }
  if (action.type === "reset") return initialState
  return state
}

