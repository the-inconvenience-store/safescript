# Semantic editing transforms canonical source

SafeScript exposes semantic editing as a stateless, compiler-owned `RuntimeBridge` operation over one complete accepted `SourceProgram`. Requests use a closed, independently versioned algebra of serialisable typed operations rather than graph mutation, callbacks, raw text patches, or document sessions; the result is a checked candidate source revision, and the host retains ownership of storage, history, collaboration, layout, acceptance, and execution.
