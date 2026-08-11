import { useState } from 'react';

import type { BuildingStepTemplate } from '../../editor/composer.js';
import type { SemanticIntent } from '../../editor/operations.js';

export function ComposerToolbar({
  templates,
  busy,
  onEdit,
}: Readonly<{
  templates: readonly BuildingStepTemplate[];
  busy: boolean;
  onEdit: (intent: SemanticIntent) => void;
}>) {
  const [open, setOpen] = useState(false);
  if (templates.length === 0) return null;
  return (
    <div className="composer-toolbar">
      <button
        className="button--primary add-step-button"
        type="button"
        aria-expanded={open}
        aria-controls="add-step-menu"
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">＋</span> Add step
      </button>
      {open && (
        <div id="add-step-menu" className="add-step-menu" role="menu" aria-label="Add automation step">
          <span className="eyebrow">New automation step</span>
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                onEdit(template.intent);
                setOpen(false);
              }}
            >
              <strong>{template.label}</strong>
              <small>{template.description}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
