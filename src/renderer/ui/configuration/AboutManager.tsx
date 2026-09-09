import { useEffect, useState } from 'react';
import type { AppUpdateView } from '../../../core/appUpdate';
import { AboutContent } from '../agent/AboutContent';
export function AboutManager() {
  const [appUpdate, setAppUpdate] = useState<AppUpdateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const off = window.lin?.appUpdate.onChanged((view) => { receivedEvent = true; if (active) { setAppUpdate(view); setError(null); } });
    void window.lin?.appUpdate.get().then((view) => { if (active && !receivedEvent) { setAppUpdate(view); setError(null); } }).catch((caught) => { if (active && !receivedEvent) setError(String(caught)); });
    return () => { active = false; off?.(); };
  }, []);
  return <>
    <AboutContent appUpdate={appUpdate} onAppUpdateChange={setAppUpdate} readError={error} />
  </>;
}
