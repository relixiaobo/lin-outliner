import { useMemo } from 'react';
import { buildConfigIndexFromMap } from '../../../core/configProjection';
import type { ProjectedFieldConfig, ProjectedTagConfig } from '../../../core/configSchema';
import { api } from '../../api/client';
import type {
  FieldConfigPatch,
  HideFieldMode,
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
import type { CommandRunner } from '../shared';
import { textOf } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import {
  definitionConfigItems,
  type DefinitionConfigItem,
} from './definitionConfig';
import {
  DefinitionColorControl,
  DefinitionAutoInitializeControl,
  DefinitionCardinalitySelect,
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

export function DefinitionConfigPanel({ node, index, run }: DefinitionConfigPanelProps) {
  const items = definitionConfigItems(node);
  // config-as-nodes: definition config is read from the defConfig subtree via
  // the projected accessor, not flat Node fields.
  const configIndex = useMemo(() => buildConfigIndexFromMap(index.byId), [index.byId]);
  const tagConfig = configIndex.tag(node.id);
  const fieldConfig = configIndex.field(node.id);
  const tagOptions = useMemo(
    () => index.projection.nodes
      .filter((candidate) => candidate.type === 'tagDef' && candidate.id !== node.id)
      .map((candidate) => ({
        color: resolveTagColor(candidate).text,
        id: candidate.id,
        label: textOf(candidate),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })),
    [index.projection.nodes, node.id],
  );

  const updateTag = (patch: TagConfigPatch) => {
    void run(() => api.setTagConfig(node.id, patch));
  };
  const updateField = (patch: FieldConfigPatch) => {
    void run(() => api.setFieldConfig(node.id, patch));
  };

  return (
    <section className="definition-config-panel" aria-label="Definition configuration">
      {items.map((item, index) => (
        <DefinitionConfigRow
          key={item.key}
          isLast={index === items.length - 1}
          item={item}
          node={node}
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
      icon={<ConfigIcon item={props.item} node={props.node} />}
      isLast={props.isLast}
      label={props.item.label}
    />
  );
}

function ConfigIcon({ item, node }: { item: DefinitionConfigItem; node: NodeProjection }) {
  if (item.key === 'fieldType') return <FieldTypeIcon fieldType={node.fieldType} size={ICON_SIZE.rowGlyph} />;
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
  if (item.key === 'cardinality' || item.key === 'minValue' || item.key === 'maxValue') {
    return <HashIcon size={ICON_SIZE.rowGlyph} />;
  }
  return <SettingsIcon size={ICON_SIZE.rowGlyph} />;
}

function ConfigControl(props: {
  item: DefinitionConfigItem;
  node: NodeProjection;
  tagConfig: ProjectedTagConfig | undefined;
  fieldConfig: ProjectedFieldConfig | undefined;
  tagOptions: TagOption[];
  updateTag: (patch: TagConfigPatch) => void;
  updateField: (patch: FieldConfigPatch) => void;
}) {
  const { item, node, tagConfig, fieldConfig, tagOptions, updateTag, updateField } = props;

  switch (item.key) {
    case 'color':
      return (
        <DefinitionColorControl
          label={item.label}
          value={node.color}
          swatch={resolveTagColor(node).text}
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
          checked={node.showCheckbox}
          onChange={(showCheckbox) => updateTag({ showCheckbox })}
        />
      );
    case 'doneStateEnabled':
      return (
        <DefinitionSwitchControl
          label={item.label}
          checked={node.doneStateEnabled}
          onChange={(doneStateEnabled) => updateTag({ doneStateEnabled })}
        />
      );
    case 'fieldType':
      return (
        <DefinitionFieldTypeSelect
          label={item.label}
          value={node.fieldType ?? 'plain'}
          onChange={(fieldType) => updateField({ fieldType })}
        />
      );
    case 'cardinality':
      return (
        <DefinitionCardinalitySelect
          label={item.label}
          value={node.cardinality ?? 'single'}
          onChange={(cardinality) => updateField({ cardinality })}
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
          checked={node.autocollectOptions}
          onChange={(autocollectOptions) => updateField({ autocollectOptions })}
        />
      );
    case 'autoInitialize':
      return (
        <DefinitionAutoInitializeControl
          label={item.label}
          fieldType={node.fieldType ?? 'plain'}
          value={node.autoInitialize}
          onChange={(autoInitialize) => updateField({ autoInitialize })}
        />
      );
    case 'required':
      return (
        <DefinitionSwitchControl
          label={item.label}
          checked={node.nullable === false}
          onChange={(required) => updateField({ nullable: required ? false : true })}
        />
      );
    case 'hideField':
      return (
        <DefinitionHideFieldSelect
          label={item.label}
          value={(node.hideField as HideFieldMode | undefined) ?? 'never'}
          onChange={(hideField) => updateField({ hideField: hideField === 'never' ? null : hideField })}
        />
      );
    case 'minValue':
      return (
        <DefinitionNumberControl
          label={item.label}
          value={node.minValue}
          onCommit={(minValue) => updateField({ minValue })}
        />
      );
    case 'maxValue':
      return (
        <DefinitionNumberControl
          label={item.label}
          value={node.maxValue}
          onCommit={(maxValue) => updateField({ maxValue })}
        />
      );
    default:
      return null;
  }
}
