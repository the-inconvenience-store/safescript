# Edit capabilities are an independent inspection view

The compiler exposes a separately versioned and bounded `semantic_edit_capabilities` inspection view rather than embedding edit metadata in the semantic graph. Tagged view requests select whole-program or target-filtered scope and carry per-view schema and limits; manifests reference the same semantic revision and graph IDs and contain enough structured applicability, precondition, fragment, type, anchor, action-schema, binding, and comment-policy facts for generic editors without prescribing presentation or replacing final checking.
