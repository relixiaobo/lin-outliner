import { useEffect, useMemo, useState } from 'react';
import type { SourceAvailability, SourceResolutionReason } from '../../../core/source';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import type { DocumentIndex } from '../../state/document';
import {
  AddIcon,
  CheckIcon,
  CopyIcon,
  HideIcon,
  MoveDownIcon,
  MoveUpIcon,
  ShowIcon,
  TrashIcon,
} from '../icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Input } from '../primitives/Input';
import type { CommandRunner } from '../shared';
import { FilePreviewBody } from './FilePreviewBody';
import { dispatchPreviewTargetOpen } from './previewEvents';
import {
  applyHostSourceResolution,
  nodeSourceValues,
  type NodeSourceDescriptor,
} from './nodeSources';
import { useNodeSourceViewState } from './sourceViewState';

interface NodeSourcesSectionProps {
  index: DocumentIndex;
  ownerId: NodeId;
  run: CommandRunner;
}

export function NodeSourcesSection({ index, ownerId, run }: NodeSourcesSectionProps) {
  const labels = useT().nodePanel.sources;
  const values = useMemo(
    () => nodeSourceValues(ownerId, index.byId),
    [index.byId, index.revision, ownerId],
  );
  const valueIds = useMemo(() => values.map((value) => value.sourceValueId), [values]);
  const view = useNodeSourceViewState(ownerId, valueIds);
  const [resolutionGeneration, setResolutionGeneration] = useState(0);
  const resolvedValues = useResolvedNodeSources(values, resolutionGeneration);
  const selected = resolvedValues.find((value) => value.sourceValueId === view.selectedValueId)
    ?? resolvedValues[0]
    ?? null;
  const [newSourceText, setNewSourceText] = useState('');

  const add = () => {
    if (!newSourceText) return;
    const sourceText = newSourceText;
    setNewSourceText('');
    void run(() => api.addSource(ownerId, sourceText));
  };

  return (
    <section className="node-sources" aria-labelledby={`node-sources-title-${ownerId}`}>
      <div className="node-sources-header">
        <h2 id={`node-sources-title-${ownerId}`}>{labels.title}</h2>
        <div className="node-sources-header-actions">
          {values.length > 0 ? (
            <IconButton
              icon={view.previewVisible ? HideIcon : ShowIcon}
              label={view.previewVisible ? labels.hidePreview : labels.showPreview}
              onClick={() => view.setPreviewVisible(!view.previewVisible)}
              variant="panel"
            />
          ) : null}
          {values.length > 1 ? (
            <Button size="sm" variant="ghost" onClick={() => void run(() => api.clearSources(ownerId))}>
              {labels.clear}
            </Button>
          ) : null}
        </div>
      </div>

      {values.length > 0 ? (
        <div className="node-source-list" role="list">
          {resolvedValues.map((value, index) => (
            <SourceRow
              key={value.sourceValueId}
              index={index}
              labels={labels}
              ownerId={ownerId}
              run={run}
              selected={value.sourceValueId === selected?.sourceValueId}
              total={values.length}
              value={value}
              values={resolvedValues}
              onSelect={() => view.select(value.sourceValueId)}
              onResolutionChanged={() => setResolutionGeneration((current) => current + 1)}
            />
          ))}
        </div>
      ) : null}

      <form
        className="node-source-add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          label={labels.addPlaceholder}
          onChange={(event) => setNewSourceText(event.currentTarget.value)}
          placeholder={labels.addPlaceholder}
          spellCheck={false}
          value={newSourceText}
        />
        <IconButton
          disabled={!newSourceText}
          icon={AddIcon}
          label={labels.add}
          type="submit"
          variant="panel"
        />
      </form>

      {selected && view.previewVisible ? (
        selected.availability === 'ready' && selected.previewTarget ? (
          <div
            key={`${selected.sourceValueId}:${resolutionGeneration}`}
            className="node-source-preview"
            data-source-value-id={selected.sourceValueId}
          >
            <FilePreviewBody
              ownerId={ownerId}
              target={selected.previewTarget}
              onOpenTarget={(target, options) => dispatchPreviewTargetOpen({
                target,
                newPane: options?.newPane,
                nodeId: options?.nodeId,
                presentation: options?.presentation,
              })}
            />
          </div>
        ) : (
          <div className="node-source-message" role="status">
            {sourceReasonLabel(selected, labels)}
          </div>
        )
      ) : null}
    </section>
  );
}

interface ResolvedSourceState {
  sourceText: string;
  descriptor: NodeSourceDescriptor;
}

export function useResolvedNodeSources(
  values: readonly NodeSourceDescriptor[],
  generation: number,
): Array<NodeSourceDescriptor & { resolving?: boolean }> {
  const [resolvedById, setResolvedById] = useState<ReadonlyMap<NodeId, ResolvedSourceState>>(
    () => new Map(),
  );
  const resolutionKey = values
    .map((value) => `${value.sourceValueId}\0${value.sourceText}`)
    .join('\x01');

  useEffect(() => {
    let cancelled = false;
    const resolvable = values.filter((value) => value.previewTarget);
    if (resolvable.length === 0) {
      setResolvedById(new Map());
      return () => {
        cancelled = true;
      };
    }
    void Promise.all(resolvable.map(async (value): Promise<[NodeId, ResolvedSourceState]> => {
      try {
        const result = await api.resolvePreviewSource(value.previewTarget!);
        return [value.sourceValueId, {
          sourceText: value.sourceText,
          descriptor: applyHostSourceResolution(value, result),
        }];
      } catch {
        return [value.sourceValueId, {
          sourceText: value.sourceText,
          descriptor: applyHostSourceResolution(value, { source: null }),
        }];
      }
    })).then((entries) => {
      if (!cancelled) setResolvedById(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [generation, resolutionKey]);

  return values.map((value) => {
    if (!value.previewTarget) return value;
    const resolved = resolvedById.get(value.sourceValueId);
    return resolved?.sourceText === value.sourceText
      ? resolved.descriptor
      : { ...value, resolving: true };
  });
}

function SourceRow({
  index,
  labels,
  ownerId,
  run,
  selected,
  total,
  value,
  values,
  onSelect,
  onResolutionChanged,
}: {
  index: number;
  labels: ReturnType<typeof useT>['nodePanel']['sources'];
  ownerId: NodeId;
  run: CommandRunner;
  selected: boolean;
  total: number;
  value: NodeSourceDescriptor & { resolving?: boolean };
  values: readonly NodeSourceDescriptor[];
  onSelect: () => void;
  onResolutionChanged: () => void;
}) {
  const [draft, setDraft] = useState(value.sourceText);
  const [sourceActionPending, setSourceActionPending] = useState(false);
  const [sourceActionError, setSourceActionError] = useState<string | null>(null);
  useEffect(() => setDraft(value.sourceText), [value.sourceText]);
  const changed = draft !== value.sourceText;
  const save = () => {
    if (!changed) return;
    void run(() => api.replaceSource(ownerId, value.sourceValueId, draft));
  };
  const linkedFileTarget = value.previewTarget?.kind === 'linked-file'
    ? value.previewTarget
    : null;
  const authorize = async () => {
    if (!linkedFileTarget || sourceActionPending) return;
    setSourceActionPending(true);
    setSourceActionError(null);
    try {
      const result = await api.authorizeLinkedFile(linkedFileTarget);
      if (result.authorized) onResolutionChanged();
      else if (!result.canceled) {
        setSourceActionError(result.error === 'different-file'
          ? labels.differentFile
          : labels.authorizationFailed);
      }
    } catch {
      setSourceActionError(labels.authorizationFailed);
    } finally {
      setSourceActionPending(false);
    }
  };
  const forget = async () => {
    if (!linkedFileTarget || sourceActionPending) return;
    setSourceActionPending(true);
    setSourceActionError(null);
    try {
      await api.forgetLinkedFile(linkedFileTarget);
      onResolutionChanged();
    } catch {
      setSourceActionError(labels.forgetFailed);
    } finally {
      setSourceActionPending(false);
    }
  };

  return (
    <div
      className={`node-source-row${selected ? ' is-selected' : ''}`}
      data-availability={value.availability}
      role="listitem"
      onFocusCapture={onSelect}
      onMouseDown={onSelect}
    >
      <div className="node-source-main">
        <Input
          label={labels.edit}
          size="sm"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              save();
            }
            if (event.key === 'Escape') setDraft(value.sourceText);
          }}
          spellCheck={false}
          value={draft}
        />
        <div className="node-source-status">
          <span>{value.resolving ? labels.loading : availabilityLabel(value.availability, labels)}</span>
          {value.reason ? <span>{sourceReasonLabel(value, labels)}</span> : null}
          {sourceActionError ? <span role="alert">{sourceActionError}</span> : null}
        </div>
      </div>
      <div className="node-source-actions">
        {linkedFileTarget && value.availability !== 'ready' ? (
          <Button disabled={sourceActionPending} size="sm" variant="ghost" onClick={() => void authorize()}>
            {value.availability === 'unavailable' ? labels.relink : labels.chooseFile}
          </Button>
        ) : null}
        {linkedFileTarget && value.availability === 'ready' ? (
          <Button disabled={sourceActionPending} size="sm" variant="ghost" onClick={() => void forget()}>
            {labels.forgetAccess}
          </Button>
        ) : null}
        {value.actions.includes('retry') && value.availability !== 'ready' ? (
          <Button
            disabled={sourceActionPending || value.resolving}
            size="sm"
            variant="ghost"
            onClick={onResolutionChanged}
          >
            {labels.retry}
          </Button>
        ) : null}
        <IconButton
          disabled={!changed}
          icon={CheckIcon}
          label={labels.save}
          onClick={save}
          variant="panel"
        />
        <IconButton
          icon={CopyIcon}
          label={labels.copyUri}
          onClick={() => void navigator.clipboard.writeText(value.sourceText)}
          variant="panel"
        />
        <IconButton
          disabled={index === 0}
          icon={MoveUpIcon}
          label={labels.moveUp}
          onClick={() => void run(() => api.reorderSource(
            ownerId,
            value.sourceValueId,
            index > 1 ? values[index - 2].sourceValueId : null,
          ))}
          variant="panel"
        />
        <IconButton
          disabled={index === total - 1}
          icon={MoveDownIcon}
          label={labels.moveDown}
          onClick={() => void run(() => api.reorderSource(ownerId, value.sourceValueId, values[index + 1].sourceValueId))}
          variant="panel"
        />
        <IconButton
          icon={TrashIcon}
          label={labels.remove}
          onClick={() => void run(() => api.removeSource(ownerId, value.sourceValueId))}
          variant="panel"
        />
      </div>
    </div>
  );
}

function availabilityLabel(
  availability: SourceAvailability,
  labels: ReturnType<typeof useT>['nodePanel']['sources'],
): string {
  return labels[availability];
}

function sourceReasonLabel(
  source: Pick<NodeSourceDescriptor, 'availability' | 'reason'>,
  labels: ReturnType<typeof useT>['nodePanel']['sources'],
): string {
  const reasonLabels: Record<SourceResolutionReason, string> = {
    'malformed-uri': labels.malformedUri,
    'unsupported-scheme': labels.unsupportedScheme,
    'asset-unavailable': labels.assetUnavailable,
    'file-access-denied': labels.fileAccessDenied,
    'file-unavailable': labels.fileUnavailable,
    'network-unavailable': labels.networkUnavailable,
  };
  return source.reason ? reasonLabels[source.reason] : availabilityLabel(source.availability, labels);
}
