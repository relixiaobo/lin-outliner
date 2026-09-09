import { SettingsFeedback, type SettingsFeedbackState } from '../configuration/SettingsFeedback';
import type { DelegationSettingsView } from '../../../core/delegationSettings';
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

export function DelegationPreferences({
  settings,
  runtime,
  onChange,
  readError,
  modelError,
}: {
  readError?: string | null;
  modelError?: string | null;
  settings: AgentProviderSettingsView | null;
  runtime: DelegationSettingsView | null;
  onChange: (input: AgentDelegationSettingsInput) => Promise<void>;
}) {
  const t = useT();
  const [feedback, setFeedback] = useState<Record<string, SettingsFeedbackState>>({});
  function report(key: string, value: SettingsFeedbackState = {}) { setFeedback((current) => ({ ...current, [key]: value })); }
  const [saving, setSaving] = useState(false);
  const pendingMutations = useRef(0);
  const mutationQueue = useRef(createSerialMutationQueue());
  const delegation = runtime?.delegation;
  const internal = delegation?.runners.internal;
  const selectedRunnerId = delegation?.defaultRunnerId ?? 'internal';
  const discoveredRunners = runtime?.runners ?? [];
  const delegationRunners = discoveredRunners.length > 0
    ? discoveredRunners
    : [{
      id: 'internal',
      version: '1',
      detected: true,
      ready: true,
      enabled: internal?.enabled !== false,
      diagnostic: null,
    } satisfies DelegationRunnerReadiness];
  const selectedRunner = delegationRunners.find((runner) => runner.id === selectedRunnerId);
  const selectedRunnerSettings = delegation?.runners[selectedRunnerId];
  const selectedRunnerEnabled = selectedRunnerSettings?.enabled ?? selectedRunner?.enabled ?? false;
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
    const runner = Object.entries(input.runners ?? {})[0];
    const key = runner ? `runners.${runner[0]}.${Object.keys(runner[1])[0]}` : Object.keys(input)[0]!;
    report(key, { notice: t.common.loading });
    pendingMutations.current += 1;
    setSaving(true);
    try {
      await mutationQueue.current.run(() => onChange(input));
      report(key);
    } catch (cause) {
      report(key, { error: cause instanceof Error ? cause.message : String(cause) });
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
  return (
    <>
      <InsetGroup headerFeedback={<SettingsFeedback feedback={{ error: readError }} />} ariaLabel={t.settings.agent.delegation.ariaLabel} label={t.settings.agent.delegation.label}>
        <InsetRow
          feedback={<SettingsFeedback feedback={feedback.enabled} />}
          label={t.settings.agent.delegation.experimental}
          sublabel={t.settings.discovery.fields['agent.delegation.enabled'].description}
          wrap
          trailing={(
            <SwitchControl
              checked={enabled}
              disabled={saving || !runtime}
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
              feedback={<SettingsFeedback feedback={feedback.defaultRunnerId} />}
              label={t.settings.agent.delegation.defaultRunner}
              sublabel={t.settings.agent.delegation.runnerOptionsHint({ runner: runnerLabel(selectedRunnerId, t) })}
              wrap
              trailing={(
                <SelectControl
                  disabled={saving || !runtime}
                  label={t.settings.agent.delegation.defaultRunner}
                  onChange={(event) => {
                    void update({ defaultRunnerId: event.target.value });
                  }}
                  value={selectedRunnerId}
                  variant="popup"
                >
                  {delegationRunners.map((runner) => (
                    <option
                      key={runner.id}
                      disabled={runner.id !== selectedRunnerId && (!runner.ready || !runner.enabled)}
                      value={runner.id}
                    >
                      {runnerLabel(runner.id, t)}
                    </option>
                  ))}
                </SelectControl>
              )}
            />
            {delegationRunners.map((runner) => {
              const runnerSettings = delegation?.runners[runner.id];
              const isEnabled = runnerSettings?.enabled ?? runner.enabled;
              const status = runner.id === 'internal'
                ? isEnabled ? t.settings.agent.delegation.runnerReady : t.settings.agent.delegation.runnerDisabled
                : runner.ready
                  ? t.settings.agent.delegation.launcherReady
                  : runner.detected
                    ? t.settings.agent.delegation.launcherDetected
                    : t.settings.agent.delegation.launcherUnavailable;
              return (
                <InsetRow
                  feedback={<SettingsFeedback feedback={feedback[`runners.${runner.id}.enabled`]} />}
                  key={runner.id}
                  label={runnerLabel(runner.id, t)}
                  sublabel={status}
                  trailing={<SwitchControl checked={isEnabled}
                    disabled={saving || !runtime || (!runner.ready && runner.id !== 'internal')}
                    label={`${runnerLabel(runner.id, t)} ${t.settings.agent.delegation.runnerEnabled}`}
                    onCheckedChange={(checked) => { void update({ runners: { [runner.id]: { enabled: checked } } }); }}><SwitchMark checked={isEnabled} /></SwitchControl>}
                />
              );
            })}
            <InsetRow
              feedback={<SettingsFeedback feedback={modelError ? { error: modelError } : feedback['runners.internal.model']} />}
              label={t.settings.agent.delegation.model}
              sublabel={selectedRunnerId === 'internal'
                ? selectedModelUnavailable ? t.settings.agent.delegation.modelUnavailable : undefined
                : t.settings.agent.delegation.nativeLauncherModel}
              trailing={(
                <SelectControl
                  disabled={saving || !runtime || !selectedRunnerEnabled || selectedRunnerId !== 'internal'}
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
              feedback={<SettingsFeedback feedback={feedback['runners.internal.effort']} />}
              label={t.settings.agent.delegation.reasoning}
              trailing={(
                <SelectControl
                  disabled={saving || !runtime || !selectedRunnerEnabled || selectedRunnerId !== 'internal'}
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
              feedback={<SettingsFeedback feedback={feedback[`runners.${selectedRunnerId}.maximumAccess`]} />}
              label={t.settings.agent.delegation.maximumAccess}
              trailing={(
                <SelectControl
                  disabled={saving || !runtime || !selectedRunnerEnabled}
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
              feedback={<SettingsFeedback feedback={feedback[`runners.${selectedRunnerId}.timeoutMs`]} />}
              label={t.settings.agent.delegation.turnDuration}
              trailing={(
                <BoundedNumberSelect
                  disabled={saving || !runtime || !selectedRunnerEnabled}
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
        <details className="settings-disclosure">
          <summary>{t.settings.agent.delegation.advanced}</summary>
        <InsetGroup ariaLabel={t.settings.agent.delegation.advanced}>
          <LimitRow
            disabled={saving || !runtime}
            feedback={feedback.maxConcurrentGlobal}
            label={t.settings.agent.delegation.globalConcurrent}
            onChange={(maxConcurrentGlobal) => update({ maxConcurrentGlobal })}
            value={delegation?.maxConcurrentGlobal ?? 8}
          />
          <LimitRow
            disabled={saving || !runtime}
            feedback={feedback.maxConcurrentThread}
            label={t.settings.agent.delegation.threadConcurrent}
            onChange={(maxConcurrentThread) => update({ maxConcurrentThread })}
            value={delegation?.maxConcurrentThread ?? 4}
          />
          <LimitRow
            disabled={saving || !runtime}
            feedback={feedback[`runners.${selectedRunnerId}.maxConcurrent`]}
            label={t.settings.agent.delegation.runnerConcurrent}
            onChange={(maxConcurrent) => updateSelectedRunner({ maxConcurrent })}
            value={selectedRunnerSettings?.maxConcurrent ?? 4}
          />
          <LimitRow
            disabled={saving || !runtime}
            feedback={feedback[`runners.${selectedRunnerId}.maxConcurrentPool`]}
            label={t.settings.agent.delegation.poolConcurrent}
            onChange={(maxConcurrentPool) => updateSelectedRunner({ maxConcurrentPool })}
            value={selectedRunnerSettings?.maxConcurrentPool ?? 4}
          />
          <LimitRow
            disabled={saving || !runtime}
            feedback={feedback.maxQueuedGlobal}
            label={t.settings.agent.delegation.globalQueue}
            onChange={(maxQueuedGlobal) => update({ maxQueuedGlobal })}
            options={[8, 16, 32, 64, 128, 256, 512, 1_024]}
            value={delegation?.maxQueuedGlobal ?? 32}
          />
          <LimitRow
            disabled={saving || !runtime}
            feedback={feedback.maxQueuedThread}
            label={t.settings.agent.delegation.threadQueue}
            onChange={(maxQueuedThread) => update({ maxQueuedThread })}
            options={[2, 4, 8, 16, 32, 64, 128]}
            value={delegation?.maxQueuedThread ?? 8}
          />
        </InsetGroup>
        </details>
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

function runnerLabel(id: string, t: ReturnType<typeof useT>): string {
  if (id === 'internal') return t.settings.agent.delegation.internalRunner;
  if (id === 'codex') return t.settings.agent.delegation.codexRunner;
  if (id === 'claude') return t.settings.agent.delegation.claudeRunner;
  if (id === 'openclaw') return t.settings.agent.delegation.openclawRunner;
  return id;
}

function LimitRow({
  feedback,
  disabled,
  label,
  onChange,
  value,
  options = [1, 2, 4, 8, 16, 32, 64],
}: {
  feedback?: SettingsFeedbackState;
  disabled: boolean;
  label: string;
  onChange: (value: number) => Promise<void>;
  value: number;
  options?: readonly number[];
}) {
  return (
    <InsetRow
      feedback={<SettingsFeedback feedback={feedback} />}
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
