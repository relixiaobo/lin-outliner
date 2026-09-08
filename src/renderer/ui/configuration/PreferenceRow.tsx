import { useEffect, useId, useRef, useState } from 'react';
import { preferenceDefinition, preferenceDefault, validatePreference, type PreferenceObservation, type PreferenceValue } from '../../../core/settingsDefinitions';
import { useT } from '../../i18n/I18nProvider';
import { AppearancePicker } from './AppearancePicker';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { Button } from '../primitives/Button';

export function PreferenceRow({ entry, sourceDigest, disabled, edit }: {
  entry: PreferenceObservation;
  sourceDigest: string | null;
  disabled: boolean;
  edit: (operation: 'set' | 'reset', value?: PreferenceValue, expectedDigest?: string | null) => Promise<void>;
}) {
  const t = useT();
  const copy = t.settings.discovery;
  const text = copy.fields[entry.id];
  const definition = preferenceDefinition(entry.id)!;
  const descriptionId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(String(entry.value ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = useRef(false);
  const draftDigest = useRef<string | null | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => { if (!dirty.current) setDraft(String(entry.value ?? '')); }, [entry.value]);

  async function commit(operation: 'set' | 'reset', value?: PreferenceValue, expectedDigest?: string | null) {
    if (busy.current) return;
    busy.current = true;
    setPending(true); setError(null);
    try {
      await edit(operation, value, expectedDigest);
      dirty.current = false;
      if (operation === 'reset') setDraft(String(preferenceDefault(entry.id) ?? ''));
    } catch (caught) {
      draftDigest.current = undefined;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { busy.current = false; setPending(false); }
  }
  function commitNumber() {
    if (!dirty.current || busy.current) return;
    const value = definition.nullable && draft.trim() === '' ? null : Number(draft);
    try {
      if (draft.trim() === '' && !definition.nullable) throw new Error(copy.invalidInteger);
      validatePreference(definition, value);
    } catch { setError(copy.invalidInteger); return; }
    void commit('set', value, draftDigest.current);
  }
  const unavailable = disabled || pending;
  const rangeHint = definition.kind === 'integer' && definition.minimum !== undefined
    ? definition.maximum === undefined ? copy.minimumValue({ minimum: definition.minimum })
      : copy.valueRange({ minimum: definition.minimum, maximum: definition.maximum })
    : null;
  const choiceLabel = (value: PreferenceValue) => {
    if (entry.id === 'appearance.language') return value === null ? copy.system : value === 'en' ? 'English' : '简体中文';
    return value === 'none' ? copy.none : value === 'short' ? copy.short : copy.long;
  };
  return <div className="preference-row" data-preference-id={entry.id} role="listitem" aria-busy={pending || undefined}>
    <div className="preference-copy"><div className="preference-label">{text.label}</div>
      <p id={descriptionId} hidden={entry.id === 'appearance.theme'}>{text.description}{rangeHint ? ` ${rangeHint}` : ''}</p>
    </div>
    <div className="preference-controls">
      {definition.kind === 'boolean' ? <SwitchControl checked={entry.value === true} disabled={unavailable}
        label={text.label} aria-describedby={descriptionId} onCheckedChange={(value) => void commit('set', value)}>
        <SwitchMark checked={entry.value === true} />
      </SwitchControl> : definition.kind === 'choice' ? entry.id === 'appearance.theme' ? (
        <AppearancePicker value={String(entry.value)} disabled={disabled} pending={pending} descriptionId={descriptionId}
          onChange={(value) => void commit('set', value)} />
      ) : <SelectControl label={text.label} value={String(entry.value ?? '')} disabled={unavailable}
        aria-describedby={descriptionId} variant="popup" onChange={(event) => void commit('set', event.target.value || null)}>
        {definition.choices!.map((value) => <option value={String(value ?? '')} key={String(value)}>{choiceLabel(value)}</option>)}
      </SelectControl> : <input className="input-control input-boxed input-sm preference-number" type="text" inputMode="numeric"
        aria-label={text.label} aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ''}`} aria-invalid={Boolean(error)}
        placeholder={definition.nullable ? copy.automatic : undefined} value={draft} disabled={unavailable}
        onChange={(event) => { if (!dirty.current) draftDigest.current = sourceDigest; dirty.current = true; setDraft(event.target.value); }} onBlur={commitNumber}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); commitNumber(); }
          if (event.key === 'Escape') {
            event.stopPropagation(); event.preventDefault(); dirty.current = false;
            setDraft(String(entry.value ?? '')); setError(null);
          }
        }} />}
      {entry.modified ? <Button size="sm" variant="ghost" className="preference-reset" aria-label={`${copy.resetLabel} ${text.label}`}
        disabled={unavailable} onClick={() => void commit('reset')}>{copy.reset}</Button> : null}
    </div>
    {entry.application?.status === 'failed' ? <p className="preference-error" role="status">{copy.applyFailed} {entry.application.error}</p> : null}
    {error ? <p id={errorId} className="preference-error" role="alert">{error}</p> : null}
  </div>;
}
