import { useEffect, useState } from 'react';
import type { AppUpdateView } from '../../../core/appUpdate';
import { AboutContent } from '../agent/AboutContent';
import { ManagerFeedback } from './ManagerFeedback';
export function AboutManager() {
  const [appUpdate, setAppUpdate] = useState<AppUpdateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const off = window.lin?.appUpdate.onChanged((view) => { receivedEvent = true; if (active) setAppUpdate(view); });
    void window.lin?.appUpdate.get().then((view) => { if (active && !receivedEvent) setAppUpdate(view); }).catch((caught) => { if (active) setError(String(caught)); });
    return () => { active = false; off?.(); };
  }, []);
  return <>
    <AboutContent appUpdate={appUpdate} onAppUpdateChange={setAppUpdate} onError={setError} onNotice={setNotice} />
    <ManagerFeedback error={error} notice={notice} />
  </>;
}
