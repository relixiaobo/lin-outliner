import { useId, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { CheckboxControl } from '../primitives/CheckboxControl';
import { Input } from '../primitives/Input';
import { SelectControl } from '../primitives/SelectControl';

/** A profile restriction chooses members; it never enables library content. */
export function AgentCapabilityPicker({ all, label, defaultLabel, custom, onCustomChange, selected, onChange, describe, hint, status }: {
  readonly all: readonly string[];
  readonly label: string;
  readonly defaultLabel: string;
  readonly custom: boolean;
  readonly onCustomChange: (custom: boolean) => void;
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
  readonly describe?: (key: string) => string;
  readonly hint?: string;
  readonly status?: (key: string) => string | undefined;
}) {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState('');
  const filter = query.trim().toLocaleLowerCase();
  const visible = all.filter((key) => `${key} ${describe?.(key) ?? ''}`.toLocaleLowerCase().includes(filter));
  return <div className="agent-capability-setting" role="listitem">
    <div className="settings-sheet-row agent-capability-heading">
      <span>{label}</span>
      <SelectControl label={label} value={custom ? 'custom' : 'default'} variant="popup"
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onCustomChange(event.target.value === 'custom')}>
        <option value="default">{defaultLabel}</option>
        <option value="custom">{t.settings.agents.customSelection}</option>
      </SelectControl>
    </div>
    {hint ? <p className="agent-capability-hint" id={`${id}-hint`}>{hint}</p> : null}
    {custom ? <div className="agent-capability-custom">
      {all.length > 8 ? <Input type="search" label={t.settings.agents.searchCapabilities({ name: label })}
        placeholder={t.settings.agents.searchCapabilities({ name: label })} value={query}
        onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
        onChange={(event) => setQuery(event.target.value)} /> : null}
      <div className="agent-capability-toolbar">
        <span className="agent-capability-count" role="status">
          {t.settings.agents.capabilityCount({ selected: selected.size, total: all.length })}
        </span>
        <Button size="sm" variant="ghost" disabled={selected.size === all.length}
          onClick={() => onChange(new Set(all))}>{t.settings.agents.selectAll}</Button>
        <Button size="sm" variant="ghost" disabled={selected.size === 0}
          onClick={() => onChange(new Set())}>{t.settings.agents.deselectAll}</Button>
      </div>
      <div className="agent-capability-list" role="group" aria-label={label}>
        {visible.map((key) => <CheckboxControl key={key} className="agent-capability-item"
          checked={selected.has(key)} aria-label={key} title={describe?.(key) || undefined}
          onCheckedChange={(checked) => {
            const next = new Set(selected);
            if (checked) next.add(key); else next.delete(key);
            onChange(next);
          }}>
          <span className="agent-capability-name">{key}
            {status?.(key) ? <span className="agent-capability-status">{status(key)}</span> : null}
          </span>
        </CheckboxControl>)}
        {visible.length === 0 ? <p className="agent-editor-hint">{t.settings.agents.noCapabilities}</p> : null}
      </div>
    </div> : null}
  </div>;
}
