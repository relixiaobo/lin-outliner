import { useMemo } from 'react';
import { buildConfigIndexFromMap } from '../../../core/configProjection';
import type { ProjectedFieldConfig, ProjectedTagConfig } from '../../../core/configSchema';
import { api } from '../../api/client';
import type {
  FieldConfigPatch,
  FieldType,
  HideFieldMode,
  NodeId,
  NodeProjection,
  TagConfigPatch,
} from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import {
  CheckboxIcon,
  ColorIcon,
  HashIcon,
  HideIcon,
  ICON_SIZE,
  OptionsIcon,
  SettingsIcon,
  SupertagIcon,
} from '../icons';
import { FieldTypeIcon } from '../outliner/fieldTypePresentation';
import { useT } from '../../i18n/I18nProvider';
import type { CommandRunner } from '../shared';
import { textOf } from '../shared';
import { isNodeInTrash } from '../interactions/nodeLocation';
import { resolveTagColor } from '../tags/tagColors';
import {
  definitionConfigItems,
  hideFieldOptions,
  type DefinitionConfigItem,
  type DefinitionConfigLabels,
} from './definitionConfig';
import {
  DefinitionColorControl,
  DefinitionAutoInitializeControl,
  DefinitionDoneMappingControl,
  DefinitionFieldTypeSelect,
  DefinitionHideFieldSelect,
  DefinitionNumberControl,
  DefinitionSwitchControl,
  DefinitionTagSelect,
  type TagOption,
} from './DefinitionConfigControls';
import { DefinitionConfigRowShell } from './DefinitionConfigRowShell';

interface DefinitionConfigPanelProps {
  node: NodeProjection;
  index: DocumentIndex;
  run: CommandRunner;
}

/** The `definition.*` label bag shaped for the pure config-item builders. */
export function definitionConfigLabels(t: ReturnType<typeof useT>): DefinitionConfigLabels {
  return {
    tagConfig: t.definition.tagConfig,
    fieldConfig: t.definition.fieldConfig,
    hideFieldOptions: t.definition.hideFieldOptions,
    outliner: t.definition.outliner,
  };
}

export function buildDefinitionTagOptions(
  index: DocumentIndex,
  excludedTagId: NodeId,
  untitledLabel: string,
): TagOption[] {
  return index.projection.nodes
    .filter((candidate) => (
      candidate.type === 'tagDef'
      && candidate.id !== excludedTagId
      && !isNodeInTrash(index, candidate.id)
    ))
    .map((candidate) => ({
      color: resolveTagColor(candidate, index.byId).text,
      id: candidate.id,
      label: textOf(candidate) || untitledLabel,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
}

export function DefinitionConfigPanel({ node, index, run }: DefinitionConfigPanelProps) {
  const t = useT();
  // config-as-nodes: definition config is read from the defConfig subtree via
  // the projected accessor, not flat Node fields.
  const byId = index.byId;
  const configIndex = useMemo(() => buildConfigIndexFromMap(byId), [byId]);
  const tagConfig = configIndex.tag(node.id);
  const fieldConfig = configIndex.field(node.id);
  const items = definitionConfigItems(node, {
    fieldType: fieldConfig?.fieldType,
    showCheckbox: tagConfig?.showCheckbox,
    doneStateEnabled: tagConfig?.doneStateEnabled,
  }, definitionConfigLabels(t));
  const tagOptions = useMemo(
    () => buildDefinitionTagOptions(index, node.id, t.common.untitled),
    [index, node.id, t.common.untitled],
  );

  const updateTag = (patch: TagConfigPatch) => {
    void run(() => api.setTagConfig(node.id, patch));
  };
  const updateField = (patch: FieldConfigPatch) => {
    void run(() => api.setFieldConfig(node.id, patch));
  };

  return (
    <section className="definition-config-panel" aria-label={t.definition.panel.ariaLabel}>
      {items.map((item, index) => (
        <DefinitionConfigRow
          key={item.key}
          isLast={index === items.length - 1}
          item={item}
          node={node}
          byId={byId}
          tagConfig={tagConfig}
          fieldConfig={fieldConfig}
          tagOptions={tagOptions}
          updateTag={updateTag}
          updateField={updateField}
        />
      ))}
    </section>
  );
}

function DefinitionConfigRow(props: {
  isLast: boolean;
  item: DefinitionConfigItem;
  node: NodeProjection;
  byId: Map<NodeId, NodeProjection>;
  tagConfig: ProjectedTagConfig | undefined;
  fieldConfig: ProjectedFieldConfig | undefined;
  tagOptions: TagOption[];
  updateTag: (patch: TagConfigPatch) => void;
  updateField: (patch: FieldConfigPatch) => void;
}) {
  return (
    <DefinitionConfigRowShell
      configKey={props.item.key}
      control={<ConfigControl {...props} />}
      icon={<ConfigIcon item={props.item} fieldType={props.fieldConfig?.fieldType} />}
      isLast={props.isLast}
      label={props.item.label}
    />
  );
}

function ConfigIcon({ item, fieldType }: { item: DefinitionConfigItem; fieldType: FieldType | undefined }) {
  if (item.key === 'fieldType') return <FieldTypeIcon fieldType={fieldType} size={ICON_SIZE.rowGlyph} />;
  if (item.key === 'color') return <ColorIcon size={ICON_SIZE.rowGlyph} />;
  if (item.key === 'extends' || item.key === 'childSupertag' || item.key === 'sourceSupertag') {
    return <SupertagIcon size={ICON_SIZE.rowGlyph} />;
  }
  if (item.key === 'showCheckbox' || item.key === 'doneStateEnabled' || item.key === 'required') {
    return <CheckboxIcon size={ICON_SIZE.rowGlyph} />;
  }
  if (item.key === 'autocollectOptions') return <OptionsIcon size={ICON_SIZE.rowGlyph} />;
  if (item.key === 'autoInitialize') return <SettingsIcon size={ICON_SIZE.rowGlyph} />;
  if (item.key === 'hideField') return <HideIcon size={ICON_SIZE.rowGlyph} />;
  if (item.key === 'minValue' || item.key === 'maxValue') {
    return <HashIcon size={ICON_SIZE.rowGlyph} />;
  }
  return <SettingsIcon size={ICON_SIZE.rowGlyph} />;
}

function ConfigControl(props: {
  item: DefinitionConfigItem;
  node: NodeProjection;
  byId: Map<NodeId, NodeProjection>;
  tagConfig: ProjectedTagConfig | undefined;
  fieldConfig: ProjectedFieldConfig | undefined;
  tagOptions: TagOption[];
  updateTag: (patch: TagConfigPatch) => void;
  updateField: (patch: FieldConfigPatch) => void;
}) {
  const { item, node, byId, tagConfig, fieldConfig, tagOptions, updateTag, updateField } = props;
  const t = useT();

  switch (item.key) {
    case 'color':
      return (
        <DefinitionColorControl
          label={item.label}
          value={tagConfig?.color}
          onCommit={(color) => updateTag({ color })}
        />
      );
    case 'extends':
      return (
        <DefinitionTagSelect
          label={item.label}
          value={tagConfig?.extends}
          options={tagOptions}
          onChange={(tagId) => updateTag({ extends: tagId })}
        />
      );
    case 'childSupertag':
      return (
        <DefinitionTagSelect
          label={item.label}
          value={tagConfig?.childSupertag}
          options={tagOptions}
          onChange={(tagId) => updateTag({ childSupertag: tagId })}
        />
      );
    case 'showCheckbox':
      return (
        <DefinitionSwitchControl
          label={item.label}
          checked={tagConfig?.showCheckbox ?? false}
          onChange={(showCheckbox) => updateTag({ showCheckbox })}
        />
      );
    case 'doneStateEnabled':
      return (
        <DefinitionSwitchControl
          label={item.label}
          checked={tagConfig?.doneStateEnabled ?? false}
          onChange={(doneStateEnabled) => updateTag({ doneStateEnabled })}
        />
      );
    case 'doneMapChecked':
    case 'doneMapUnchecked':
      return (
        <DefinitionDoneMappingControl
          label={item.label}
          byId={byId}
          tagDefId={node.id}
          value={item.key === 'doneMapChecked' ? (tagConfig?.doneMapChecked ?? []) : (tagConfig?.doneMapUnchecked ?? [])}
          onChange={(optionIds) => updateTag(
            item.key === 'doneMapChecked' ? { doneMapChecked: optionIds } : { doneMapUnchecked: optionIds },
          )}
        />
      );
    case 'fieldType':
      return (
        <DefinitionFieldTypeSelect
          label={item.label}
          value={fieldConfig?.fieldType ?? 'plain'}
          onChange={(fieldType) => updateField({ fieldType })}
        />
      );
    case 'sourceSupertag':
      return (
        <DefinitionTagSelect
          label={item.label}
          value={fieldConfig?.sourceSupertag}
          options={tagOptions}
          onChange={(sourceSupertag) => updateField({ sourceSupertag })}
        />
      );
    case 'autocollectOptions':
      return (
        <DefinitionSwitchControl
          label={item.label}
          checked={fieldConfig?.autocollectOptions ?? false}
          onChange={(autocollectOptions) => updateField({ autocollectOptions })}
        />
      );
    case 'autoInitialize':
      return (
        <DefinitionAutoInitializeControl
          label={item.label}
          fieldType={fieldConfig?.fieldType ?? 'plain'}
          value={(fieldConfig?.autoInitialize ?? []).join(',')}
          onChange={(autoInitialize) => updateField({ autoInitialize })}
        />
      );
    case 'required':
      return (
        <DefinitionSwitchControl
          label={item.label}
          checked={fieldConfig?.nullable === false}
          onChange={(required) => updateField({ nullable: required ? false : true })}
        />
      );
    case 'hideField':
      return (
        <DefinitionHideFieldSelect
          label={item.label}
          options={hideFieldOptions(t.definition.hideFieldOptions)}
          value={(fieldConfig?.hideField as HideFieldMode | undefined) ?? 'never'}
          onChange={(hideField) => updateField({ hideField: hideField === 'never' ? null : hideField })}
        />
      );
    case 'minValue':
      return (
        <DefinitionNumberControl
          label={item.label}
          value={fieldConfig?.minValue}
          onCommit={(minValue) => updateField({ minValue })}
        />
      );
    case 'maxValue':
      return (
        <DefinitionNumberControl
          label={item.label}
          value={fieldConfig?.maxValue}
          onCommit={(maxValue) => updateField({ maxValue })}
        />
      );
    default:
      return null;
  }
}
