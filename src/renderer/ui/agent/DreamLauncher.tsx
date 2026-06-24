import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { BrainIcon, CalendarIcon, ICON_SIZE, LoaderIcon } from '../icons';
import { Button } from '../primitives/Button';

interface DreamLauncherProps {
  isStreaming: boolean;
}

export function DreamLauncher({ isStreaming }: DreamLauncherProps) {
  const t = useT();
  const [startDate, setStartDate] = useState(() => todayInputValue());
  const [endDate, setEndDate] = useState(() => todayInputValue());
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = todayInputValue();

  useEffect(() => {
    let cancelled = false;
    api.agentDreamReadiness()
      .then((readiness) => {
        if (cancelled || !readiness.window) return;
        setStartDate(readiness.window.start);
        setEndDate(readiness.window.end);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function runDream() {
    if (busy || isStreaming) return;
    setBusy(true);
    setError(null);
    try {
      await api.agentRunDreamNow({
        startDate,
        endDate,
        guidance,
        limit: 50,
      });
      setGuidance('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy
    || isStreaming
    || !startDate
    || !endDate
    || startDate > endDate
    || startDate > today
    || endDate > today;

  return (
    <section className="dream-launcher" aria-label={t.agent.chat.dreamLauncherAriaLabel}>
      <div className="dream-launcher-row">
        <label className="dream-launcher-field">
          <span><CalendarIcon size={ICON_SIZE.menu} />{t.agent.chat.dreamStartDate}</span>
          <input
            className="dream-launcher-input"
            type="date"
            max={today}
            value={startDate}
            onChange={(event) => setStartDate(event.currentTarget.value)}
          />
        </label>
        <label className="dream-launcher-field">
          <span><CalendarIcon size={ICON_SIZE.menu} />{t.agent.chat.dreamEndDate}</span>
          <input
            className="dream-launcher-input"
            type="date"
            max={today}
            value={endDate}
            onChange={(event) => setEndDate(event.currentTarget.value)}
          />
        </label>
      </div>
      <textarea
        className="dream-launcher-guidance"
        value={guidance}
        onChange={(event) => setGuidance(event.currentTarget.value)}
        placeholder={t.agent.chat.dreamGuidancePlaceholder}
        rows={2}
      />
      {error ? <div className="dream-launcher-error" role="status">{error}</div> : null}
      <div className="dream-launcher-actions">
        <Button disabled={disabled} onClick={() => void runDream()} size="sm" variant="primary">
          {busy ? <LoaderIcon size={ICON_SIZE.menu} /> : <BrainIcon size={ICON_SIZE.menu} />}
          <span>{busy ? t.agent.chat.dreamLauncherBusy : t.agent.chat.dreamLauncherButton}</span>
        </Button>
      </div>
    </section>
  );
}

function todayInputValue(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
