import { useId, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';

export function AppearancePicker({ value, disabled, pending, descriptionId, onChange }: {
  value: string;
  disabled: boolean;
  pending: boolean;
  descriptionId: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const name = useId();
  const [requested, setRequested] = useState(value);
  const selected = pending ? requested : value;
  const options = [
    { value: 'system', label: t.settings.general.themeSystem },
    { value: 'light', label: t.settings.general.themeLight },
    { value: 'dark', label: t.settings.general.themeDark },
  ];
  return <div className="appearance-picker" role="radiogroup"
    aria-label={t.settings.discovery.fields['appearance.theme'].label} aria-describedby={descriptionId}>
    {options.map((option) => <label className="appearance-choice" key={option.value}>
      <input type="radio" name={name} value={option.value} checked={selected === option.value}
        disabled={disabled} aria-disabled={disabled || pending} aria-describedby={descriptionId}
        onClick={(event) => { if (pending) event.preventDefault(); }}
        onKeyDown={(event) => {
          if (pending && (event.key.startsWith('Arrow') || event.key === ' ')) event.preventDefault();
        }}
        onChange={() => {
          if (!pending && option.value !== value) {
            setRequested(option.value);
            onChange(option.value);
          }
        }} />
      <span className={`appearance-preview appearance-preview-${option.value}`} aria-hidden="true">
        {option.value !== 'dark' ? <WindowPreview appearance="light" /> : null}
        {option.value !== 'light' ? <WindowPreview appearance="dark" /> : null}
      </span>
      <span className="appearance-choice-label">{option.label}</span>
    </label>)}
  </div>;
}

// Decorative miniatures show both palettes independently of the active OS theme.
// They never mount another renderer or change the application's theme mechanism.
function WindowPreview({ appearance }: { appearance: 'light' | 'dark' }) {
  return <span className={`appearance-preview-window appearance-preview-window-${appearance}`}>
    <span className="appearance-preview-rail">
      <span className="appearance-preview-lights"><i /><i /><i /></span>
      <span className="appearance-preview-selection" />
      <span className="appearance-preview-rail-line" />
      <span className="appearance-preview-rail-line" />
    </span>
    <span className="appearance-preview-content">
      <span className="appearance-preview-title" />
      <span className="appearance-preview-line" />
      <span className="appearance-preview-line" />
      <span className="appearance-preview-line" />
    </span>
    <span className="appearance-preview-thread"><span /><span /><span /></span>
  </span>;
}
