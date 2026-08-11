# Semantic edit batches are atomic, preconditioned, and deterministic

`applySemanticEdits` accepts a non-empty ordered batch whose request-local operation IDs, targets, anchors, and mandatory semantic preconditions resolve against one accepted semantic revision. A versioned conflict matrix rejects incompatible overlaps instead of applying later-edit-wins; fragments bind in the complete final revision, rejected batches expose no candidate or partial products, and identical bounded inputs produce byte-identical results across direct and process bridges.
