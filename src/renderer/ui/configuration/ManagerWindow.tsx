import { lazy, Suspense, useState } from 'react';
import type { SettingsPane } from '../../../core/settingsWindow';
import { useT } from '../../i18n/I18nProvider';
import { ManagerFeedback } from './ManagerFeedback';

const Models = lazy(() => import('./ModelsManager').then((m) => ({ default: m.ModelsManager })));
const Agents = lazy(() => import('./AgentsManager').then((m) => ({ default: m.AgentsManager })));
const Skills = lazy(() => import('./SkillsManager').then((m) => ({ default: m.SkillsManager })));
const Access = lazy(() => import('./AccessManager').then((m) => ({ default: m.AccessManager })));
const Memory = lazy(() => import('../agent/MemoryManager').then((m) => ({ default: m.MemoryManager })));
const Data = lazy(() => import('../agent/PreviewDataPanel').then((m) => ({ default: m.PreviewDataPanel })));
const Shortcuts = lazy(() => import('../agent/ShortcutManager').then((m) => ({ default: m.ShortcutManager })));
const About = lazy(() => import('./AboutManager').then((m) => ({ default: m.AboutManager })));
const Diagnostics = lazy(() => import('./DiagnosticsManager').then((m) => ({ default: m.DiagnosticsManager })));

/** Each visited pane stays mounted so navigation does not discard drafts or accepted work. */
export function ConfigurationPane({ destination, active, toolbarTarget }: {
  destination: Exclude<SettingsPane, 'settings'>;
  active: boolean;
  toolbarTarget: HTMLElement | null;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return <>
    <Suspense fallback={<p role="status">{t.settings.discovery.loading}</p>}>
      {destination === 'models' ? <Models /> : destination === 'agents' ? <Agents /> : destination === 'skills' ? <Skills />
        : destination === 'memory' ? <Memory /> : destination === 'access' ? <Access /> : destination === 'data' ? <Data />
          : destination === 'shortcuts' ? <Shortcuts active={active} toolbarTarget={toolbarTarget} onError={setError} onNotice={setNotice} /> : <Diagnostics />}
    </Suspense>
    <ManagerFeedback error={error} notice={notice} />
  </>;
}

export function AboutWindow() {
  const t = useT();
  return <main className="configuration-window" aria-labelledby="configuration-title">
    <header className="configuration-toolbar"><h1 id="configuration-title">{t.settings.discovery.destinations.about}</h1></header>
    <div className="configuration-content">
      <Suspense fallback={<p role="status">{t.settings.discovery.loading}</p>}><About /></Suspense>
    </div>
  </main>;
}
