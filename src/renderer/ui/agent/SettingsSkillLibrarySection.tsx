import { useEffect, useRef, useState } from 'react';
import type { SkillDefinition } from '../../api/types';
import { api } from '../../api/client';
import { LoaderIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/FeedbackState';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { SettingsRowMenu, type RowMenuAction } from './SettingsRowMenu';
import { ManagedSkillsSettings } from './ManagedSkillsSettings';

interface SettingsSkillLibrarySectionProps {
  disabledSkills: readonly string[];
  onToggleSkill: (skillName: string) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onApplied: () => Promise<void>;
}

/**
 * The Skill library category. The skill list is loaded and mutated here, so this
 * component owns it; the enable toggles are a draft the footer Save commits, so
 * that state stays with the parent and arrives as props.
 */
export function SettingsSkillLibrarySection({
  disabledSkills,
  onToggleSkill,
  onError,
  onNotice,
  onApplied,
}: SettingsSkillLibrarySectionProps) {
  const t = useT();
  const [allSkills, setAllSkills] = useState<SkillDefinition[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  // Skill trust actions (accept / revoke / undo) round-trip through main and return
  // the refreshed skill list; one shared busy flag keeps the row controls quiet
  // while a mutation is in flight.
  const [skillTrustBusy, setSkillTrustBusy] = useState(false);
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const sectionRequestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sectionRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    sectionRequestRef.current += 1;
    const id = sectionRequestRef.current;
    const isCurrent = () => mountedRef.current && id === sectionRequestRef.current;
    setLoadingSkills(true);
    onError(null);
    onNotice(null);
    api.agentListAllSkills()
      .then((skills) => {
        if (isCurrent()) setAllSkills(skills);
      })
      .catch((caught) => {
        if (isCurrent()) onError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (isCurrent()) setLoadingSkills(false);
      });
    // Mounting this component IS entering the category, so this runs once per
    // visit — the same trigger the category-keyed effect had before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSkillTrustAction = (action: () => Promise<SkillDefinition[]>) => {
    setSkillTrustBusy(true);
    onError(null);
    void action()
      .then((skills) => setAllSkills(skills))
      .catch((cause) => onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSkillTrustBusy(false));
  };

  const isSkillDisabled = (skillName: string) => disabledSkills.includes(skillName);

  return (
    <section className="agent-settings-section settings-skills-section" aria-label={t.settings.skills.sectionAriaLabel}>
      <ManagedSkillsSettings onApplied={onApplied} />

      {loadingSkills ? (
        <EmptyState className="agent-settings-empty" icon={LoaderIcon} loading role="status" size="inline" title={t.settings.skills.loadingInstalled} />
      ) : allSkills.filter((skill) => skill.source !== 'managed').length === 0 ? (
        <EmptyState className="agent-settings-empty" size="inline" title={t.settings.skills.noneInstalled} />
      ) : (
        <InsetGroup ariaLabel={t.settings.skills.installedAriaLabel} label={t.settings.skills.installedGroup}>
          {allSkills.filter((skill) => skill.source !== 'managed').map((skill) => {
            const disabled = isSkillDisabled(skill.name);
            // Trust state is derived in main. Mutable skills are model-usable
            // by default; acceptedHash is only a retained management fact.
            const pending = !skill.ratified;
            const trustActions: RowMenuAction[] = [];
            if (skill.accepted) {
              trustActions.push({
                label: t.settings.skills.revokeAcceptance,
                disabled: skillTrustBusy,
                onSelect: () => runSkillTrustAction(() => api.agentRevokeSkillAcceptance(skill.name)),
              });
            }
            if (skill.canUndoLastAgentEdit) {
              trustActions.push({
                label: t.settings.skills.undoAgentEdit,
                disabled: skillTrustBusy,
                onSelect: () => runSkillTrustAction(() => api.agentUndoSkillAgentEdit(skill.name)),
              });
            }
            return (
              <InsetRow
                disabled={disabled}
                key={skill.name}
                label={(
                  <>
                    /{skill.displayName || skill.name}
                    <span className="settings-chip">{skill.source}</span>
                    {pending ? (
                      <span className="settings-chip">
                        {skill.source === 'project'
                          ? t.settings.skills.pendingWorkspaceChip
                          : t.settings.skills.pendingChip}
                      </span>
                    ) : skill.accepted ? (
                      <span className="settings-chip">{t.settings.skills.acceptedChip}</span>
                    ) : null}
                  </>
                )}
                sublabel={skill.description}
                trailing={(
                  <>
                    {pending ? (
                      <Button
                        aria-label={t.settings.skills.acceptSkill({ name: skill.name })}
                        className="settings-skill-accept"
                        disabled={skillTrustBusy}
                        onClick={() => runSkillTrustAction(() => api.agentAcceptSkill(skill.name, skill.contentHash ?? ''))}
                        size="sm"
                        variant="secondary"
                      >
                        {t.settings.skills.acceptButton}
                      </Button>
                    ) : null}
                    {trustActions.length > 0 ? (
                      <SettingsRowMenu
                        actions={trustActions}
                        ariaLabel={t.settings.skills.rowActionsAriaLabel({ name: skill.name })}
                        onOpenChange={(open) => setOpenRowMenu(open ? `skill:${skill.name}` : null)}
                        open={openRowMenu === `skill:${skill.name}`}
                      />
                    ) : null}
                    <SwitchControl
                      checked={!disabled}
                      onCheckedChange={() => onToggleSkill(skill.name)}
                      label={t.settings.skills.toggleSkill({ name: skill.name })}
                    >
                      <SwitchMark checked={!disabled} />
                    </SwitchControl>
                  </>
                )}
                wrap
              />
            );
          })}
        </InsetGroup>
      )}
    </section>
  );
}
