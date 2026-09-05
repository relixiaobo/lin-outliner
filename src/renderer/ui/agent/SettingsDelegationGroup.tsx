import { useMemo, useRef, useState } from 'react';
import { AGENT_REASONING_LADDER } from '../../../core/types';
import { createSerialMutationQueue } from '../../../core/serialMutationQueue';
import type {
  AgentDelegationSettingsInput,
  AgentProviderSettingsView,
} from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { buildModelChoices, flattenModelChoices, modelChoiceAvailable } from './modelChoices';

export function SettingsDelegationGroup({
  settings,
  onChange,
}: {
  settings: AgentProviderSettingsView | null;
  onChange: (input: AgentDelegationSettingsInput) => Promise<void>;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const pendingMutations = useRef(0);
  const mutationQueue = useRef(createSerialMutationQueue());
  const delegation = settings?.agent.delegation;
  const internal = delegation?.runners.internal;
  const selectedRunnerId = delegation?.defaultRunnerId ?? 'internal';
  const selectedRunner = (settings as (AgentProviderSettingsView & {
    delegationRunners?: readonly DelegationRunnerReadiness[];
  }) | null)?.delegationRunners?.find((runner) => runner.id === selectedRunnerId);
  const selectedRunnerSettings = delegation?.runners[selectedRunnerId];
  const selectedRunnerEnabled = selectedRunnerSettings?.enabled !== false;
  const modelChoices = useMemo(() => buildModelChoices(settings, {
    modelProvider: settings?.activeProviderId ?? '',
    model: internal?.model ?? '',
  }), [internal?.model, settings]);
  const models = flattenModelChoices(modelChoices);
  const selectedModel = internal?.model
    ? models.find((choice) => choice.value === internal.model)
    : undefined;
  const selectedModelUnavailable = Boolean(internal?.model && (
    !selectedModel || !modelChoiceAvailable(selectedModel, settings)
  ));
  const supportedEfforts = selectedModel?.option.supportedThinkingLevels ?? AGENT_REASONING_LADDER;
  const effortOptions = internal?.effort && !supportedEfforts.includes(internal.effort)
    ? [internal.effort, ...supportedEfforts]
    : supportedEfforts;

  async function update(input: AgentDelegationSettingsInput): Promise<void> {
    pendingMutations.current += 1;
    setSaving(true);
    try {
      await mutationQueue.current.run(() => onChange(input));
    } finally {
      pendingMutations.current -= 1;
      if (pendingMutations.current === 0) setSaving(false);
    }
  }

  async function updateInternal(
    input: NonNullable<AgentDelegationSettingsInput['runners']>[string],
  ): Promise<void> {
    await update({ runners: { internal: input } });
  }

  async function updateSelectedRunner(
    input: NonNullable<AgentDelegationSettingsInput['runners']>[string],
  ): Promise<void> {
    await update({ runners: { [selectedRunnerId]: input } });
  }

  const enabled = delegation?.enabled === true;
  const runnerEnabled = internal?.enabled !== false;

  return (
    <>
      <InsetGroup ariaLabel={t.settings.agent.delegation.ariaLabel} label={t.settings.agent.delegation.label}>
        <InsetRow
          label={t.settings.agent.delegation.experimental}
          trailing={(
            <SwitchControl
              checked={enabled}
              disabled={saving}
              label={t.settings.agent.delegation.experimental}
              onCheckedChange={(checked) => { void update({ enabled: checked }); }}
            >
              <SwitchMark checked={enabled} />
            </SwitchControl>
          )}
        />
        {enabled ? (
          <>
            <InsetRow
              label={t.settings.agent.delegation.runner}
              sublabel={selectedRunnerId === 'codex'
                ? selectedRunner?.ready
                  ? t.settings.agent.delegation.codexReady
                  : selectedRunner?.detected
                    ? t.settings.agent.delegation.codexDetected
                    : t.settings.agent.delegation.codexUnavailable
                : runnerEnabled
                  ? t.settings.agent.delegation.runnerReady
                  : t.settings.agent.delegation.runnerDisabled}
              trailing={(
                <SelectControl
                  disabled={saving}
                  label={t.settings.agent.delegation.runner}
                  onChange={(event) => {
                    const runnerId = event.target.value;
                    void update({
                      defaultRunnerId: runnerId,
                      runners: runnerId === 'codex' ? { codex: { enabled: true, model: null } } : undefined,
                    });
                  }}
                  value={selectedRunnerId}
                  variant="popup"
                >
                  <option value="internal">{t.settings.agent.delegation.internalRunner}</option>
                  <option value="codex">{t.settings.agent.delegation.codexRunner}</option>
                </SelectControl>
              )}
            />
            <InsetRow
              label={t.settings.agent.delegation.runnerEnabled}
              trailing={(
                <SwitchControl
                  checked={selectedRunnerEnabled}
                  disabled={saving}
                  label={t.settings.agent.delegation.runnerEnabled}
                  onCheckedChange={(checked) => {
                    void update({ runners: { [selectedRunnerId]: { enabled: checked } } });
                  }}
                >
                  <SwitchMark checked={selectedRunnerEnabled} />
                </SwitchControl>
              )}
            />
            <InsetRow
              label={t.settings.agent.delegation.model}
              sublabel={selectedModelUnavailable ? t.settings.agent.delegation.modelUnavailable : undefined}
              trailing={(
                <SelectControl
                  disabled={saving || !selectedRunnerEnabled || selectedRunnerId !== 'internal'}
                  label={t.settings.agent.delegation.model}
                  onChange={(event) => {
                    const model = event.target.value || null;
                    const option = models.find((choice) => choice.value === model)?.option;
                    const effort = internal?.effort;
                    void updateInternal({
                      model,
                      ...(effort && option && !option.supportedThinkingLevels.includes(effort)
                        ? { effort: null }
                        : {}),
                    });
                  }}
                  value={internal?.model ?? ''}
                  variant="popup"
                >
                  <option value="">{t.settings.agent.delegation.inheritParent}</option>
                  {models.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.option.name}{modelChoices.showProviderLabel ? ` (${choice.providerId})` : ''}
                      {choice.value === internal?.model && selectedModelUnavailable
                        ? ` - ${t.settings.agent.delegation.unavailable}`
                        : ''}
                    </option>
                  ))}
                </SelectControl>
              )}
              wrap
            />
            <InsetRow
              label={t.settings.agent.delegation.reasoning}
              trailing={(
                <SelectControl
                  disabled={saving || !selectedRunnerEnabled || selectedRunnerId !== 'internal'}
                  label={t.settings.agent.delegation.reasoning}
                  onChange={(event) => {
                    void updateInternal({ effort: event.target.value === '' ? null : event.target.value as never });
                  }}
                  value={internal?.effort ?? ''}
                  variant="popup"
                >
                  <option value="">{t.settings.agent.delegation.inheritParent}</option>
                  {effortOptions.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}{supportedEfforts.includes(effort) ? '' : ` - ${t.settings.agent.delegation.unavailable}`}
                    </option>
                  ))}
                </SelectControl>
              )}
            />
            <InsetRow
              label={t.settings.agent.delegation.maximumAccess}
              trailing={(
                <SelectControl
                  disabled={saving || !selectedRunnerEnabled}
                  label={t.settings.agent.delegation.maximumAccess}
                  onChange={(event) => {
                    void updateSelectedRunner({ maximumAccess: event.target.value as 'read-only' | 'workspace-write' });
                  }}
                  value={selectedRunnerSettings?.maximumAccess ?? 'workspace-write'}
                  variant="popup"
                >
                  <option value="read-only">{t.settings.agent.delegation.readOnly}</option>
                  <option value="workspace-write">{t.settings.agent.delegation.workspaceWrite}</option>
                </SelectControl>
              )}
            />
            <InsetRow
              label={t.settings.agent.delegation.turnDuration}
              trailing={(
                <BoundedNumberSelect
                  disabled={saving || !selectedRunnerEnabled}
                  label={t.settings.agent.delegation.turnDuration}
                  onChange={(timeoutMs) => { void updateSelectedRunner({ timeoutMs }); }}
                  options={[900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000]}
                  value={selectedRunnerSettings?.timeoutMs ?? 3_600_000}
                  valueLabel={(value) => t.settings.agent.delegation.minutes({ count: value / 60_000 })}
                />
              )}
            />
          </>
        ) : null}
      </InsetGroup>

      {enabled ? (
        <InsetGroup ariaLabel={t.settings.agent.delegation.advanced} label={t.settings.agent.delegation.advanced}>
          <LimitRow
            disabled={saving}
            label={t.settings.agent.delegation.globalConcurrent}
            onChange={(maxConcurrentGlobal) => update({ maxConcurrentGlobal })}
            value={delegation?.maxConcurrentGlobal ?? 8}
          />
          <LimitRow
            disabled={saving}
            label={t.settings.agent.delegation.threadConcurrent}
            onChange={(maxConcurrentThread) => update({ maxConcurrentThread })}
            value={delegation?.maxConcurrentThread ?? 4}
          />
          <LimitRow
            disabled={saving}
            label={t.settings.agent.delegation.runnerConcurrent}
            onChange={(maxConcurrent) => updateSelectedRunner({ maxConcurrent })}
            value={selectedRunnerSettings?.maxConcurrent ?? 4}
          />
          <LimitRow
            disabled={saving}
            label={t.settings.agent.delegation.poolConcurrent}
            onChange={(maxConcurrentPool) => updateSelectedRunner({ maxConcurrentPool })}
            value={selectedRunnerSettings?.maxConcurrentPool ?? 4}
          />
          <LimitRow
            disabled={saving}
            label={t.settings.agent.delegation.globalQueue}
            onChange={(maxQueuedGlobal) => update({ maxQueuedGlobal })}
            options={[8, 16, 32, 64, 128, 256, 512, 1_024]}
            value={delegation?.maxQueuedGlobal ?? 32}
          />
          <LimitRow
            disabled={saving}
            label={t.settings.agent.delegation.threadQueue}
            onChange={(maxQueuedThread) => update({ maxQueuedThread })}
            options={[2, 4, 8, 16, 32, 64, 128]}
            value={delegation?.maxQueuedThread ?? 8}
          />
        </InsetGroup>
      ) : null}
    </>
  );
}

interface DelegationRunnerReadiness {
  readonly id: string;
  readonly version: string | null;
  readonly detected: boolean;
  readonly ready: boolean;
  readonly enabled: boolean;
  readonly diagnostic: string | null;
}

function LimitRow({
  disabled,
  label,
  onChange,
  value,
  options = [1, 2, 4, 8, 16, 32, 64],
}: {
  disabled: boolean;
  label: string;
  onChange: (value: number) => Promise<void>;
  value: number;
  options?: readonly number[];
}) {
  return (
    <InsetRow
      label={label}
      trailing={(
        <BoundedNumberSelect
          disabled={disabled}
          label={label}
          onChange={(next) => { void onChange(next); }}
          options={options}
          value={value}
          valueLabel={String}
        />
      )}
    />
  );
}

function BoundedNumberSelect({
  disabled,
  label,
  onChange,
  options,
  value,
  valueLabel,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: number) => void;
  options: readonly number[];
  value: number;
  valueLabel: (value: number) => string;
}) {
  const values = options.includes(value) ? options : [...options, value].sort((left, right) => left - right);
  return (
    <SelectControl
      disabled={disabled}
      label={label}
      onChange={(event) => onChange(Number(event.target.value))}
      value={value}
      variant="popup"
    >
      {values.map((option) => <option key={option} value={option}>{valueLabel(option)}</option>)}
    </SelectControl>
  );
}
