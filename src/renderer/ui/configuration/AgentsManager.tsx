import { useEffect, useRef, useState } from 'react';
import type { AgentProviderSettingsView, AgentDelegationSettingsInput } from '../../api/types';
import type { DelegationSettingsView } from '../../../core/delegationSettings';
import { createSerialMutationQueue } from '../../../core/serialMutationQueue';
import { api } from '../../api/client';
import { AgentConfigurationEditor } from '../agent/AgentConfigurationEditor';
import { DelegationPreferences } from '../agent/DelegationPreferences';

export function AgentsManager() {
  const [models, setModels] = useState<AgentProviderSettingsView | null>(null);
  const [runtime, setRuntime] = useState<DelegationSettingsView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const mounted = useRef(false);
  const queue = useRef(createSerialMutationQueue());
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let modelsGeneration = 0;
    const refreshModels = () => {
      const request = ++modelsGeneration;
      void api.agentGetProviderSettings().then((view) => {
        if (active && request === modelsGeneration) { setModels(view); setModelError(null); }
      }).catch((caught) => { if (active && request === modelsGeneration) setModelError(String(caught)); });
    };
    const refresh = () => {
      void queue.current.run(async () => {
        try {
          const view = await window.lin?.getDelegationSettings();
          if (active && view) { setRuntime(view); setReadError(null); }
        } catch (caught) { if (active) setReadError(String(caught)); }
      });
    };
    refresh(); refreshModels();
    const off = window.lin?.onConfigurationChanged('agents', refresh);
    const offModels = window.lin?.onConfigurationChanged('models', refreshModels);
    return () => { active = false; mounted.current = false; off?.(); offModels?.(); };
  }, []);
  function update(input: AgentDelegationSettingsInput): Promise<void> {
    return queue.current.run(async () => {
      const next = await api.agentUpdateRuntimeSettings({ delegation: input });
      if (mounted.current) setRuntime(next);
    });
  }
  return <>
    <AgentConfigurationEditor />
    <DelegationPreferences readError={readError} modelError={modelError} settings={models} runtime={runtime} onChange={update} />
  </>;
}
