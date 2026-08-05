import type { Messages } from '../../../core/i18n';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { InsetGroup, InsetRow } from './SettingsInsetList';

interface SettingsSecuritySectionProps {
  blocks: readonly string[];
  blockErrors: ReadonlyMap<string, string>;
  onRemoveBlock: (rule: string) => void;
}

/**
 * The Security category. Each removal commits immediately in the parent, so this
 * component only renders the current rules and their row-owned failure state.
 */
export function SettingsSecuritySection({ blocks, blockErrors, onRemoveBlock }: SettingsSecuritySectionProps) {
  const t = useT();

  function renderCapabilityRuleRows(
    rules: readonly string[],
    emptyLabel: string,
    actionLabel: string,
  ) {
    if (rules.length === 0) return <InsetRow empty label={emptyLabel} />;
    return rules.map((rule) => (
      <InsetRow
        feedback={blockErrors.get(rule) ? <span role="alert">{blockErrors.get(rule)}</span> : undefined}
        key={rule}
        label={capabilityRuleLabel(rule, t)}
        sublabel={<span className="inset-row-code">{rule}</span>}
        trailing={(
          <Button
            onClick={() => onRemoveBlock(rule)}
            size="sm"
            variant="ghost"
          >
            {actionLabel}
          </Button>
        )}
        wrap
      />
    ));
  }

  return (
    <section className="agent-settings-section settings-security-section" aria-label={t.settings.security.sectionAriaLabel}>
      {/* The boundary is a FOOTNOTE, not a group. It was a section header over a
          row whose label named a thing you cannot set and whose sublabel was a
          paragraph — settings furniture wrapped around prose. It explains what
          Full Access means, so it belongs under the row that says Full Access. */}
      <InsetGroup
        ariaLabel={t.settings.security.accessAriaLabel}
        footnote={t.settings.security.fullAccessBoundaryNote}
        id="agent-access"
        label={t.settings.security.accessGroup}
      >
        <InsetRow
          label={t.settings.security.accessModeLabel}
          sublabel={t.settings.security.fullAccessSublabel}
          trailing={<span className="inset-row-value">{t.settings.security.fullAccessLabel}</span>}
          wrap
        />
      </InsetGroup>

      <InsetGroup
        ariaLabel={t.settings.security.blocksAriaLabel}
        id="blocks"
        label={t.settings.security.blocksGroup}
      >
        {renderCapabilityRuleRows(
          blocks,
          t.settings.security.noBlocks,
          t.settings.security.removeRule,
        )}
      </InsetGroup>

    </section>
  );
}

// Module-level helper (can't call useT) — the component passes `t` in.
function capabilityRuleLabel(rule: string, t: Messages): string {
  if (rule.startsWith('Command(')) return t.settings.security.commandBlockLabel;
  if (rule.startsWith('Action(')) return t.settings.security.actionBlockLabel;
  return t.settings.security.unknownBlockLabel;
}
