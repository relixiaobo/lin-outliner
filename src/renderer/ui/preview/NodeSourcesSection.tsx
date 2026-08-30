import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SourceAvailability, SourceResolutionReason } from '../../../core/source';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import type { DocumentIndex } from '../../state/document';
import {
  AttachmentIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  HideIcon,
  MoreIcon,
  ShowIcon,
  TrashIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';
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
  accessibleName?: string;
  index: DocumentIndex;
  ownerId: NodeId;
  run: CommandRunner;
}

/** Preview-first presentation for the selected URI of an ordinary Node. */
export function NodeSourcesSection({ accessibleName, index, ownerId, run }: NodeSourcesSectionProps) {
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

  if (!selected || !view.previewVisible) return null;

  return (
    <section className="node-source-preview-region" aria-label={labels.previewRegion}>
      <div className="node-source-preview-toolbar">
        <SourceSwitcher
          labels={labels}
          selected={selected}
          values={resolvedValues}
          onSelect={(valueId) => view.show(valueId)}
        />
        <div className="node-source-preview-toolbar-actions">
          <SourceActionsMenu
            labels={labels}
            ownerId={ownerId}
            run={run}
            selected={selected}
            total={resolvedValues.length}
            onResolutionChanged={() => setResolutionGeneration((current) => current + 1)}
          />
          <IconButton
            icon={HideIcon}
            label={labels.hidePreview}
            onClick={() => view.setPreviewVisible(false)}
            variant="panel"
          />
        </div>
      </div>
      {selected.availability === 'ready' && selected.previewTarget ? (
        <div
          key={`${selected.sourceValueId}:${resolutionGeneration}`}
          className="node-source-preview"
          data-source-value-id={selected.sourceValueId}
        >
          <FilePreviewBody
            accessibleName={accessibleName}
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
          {selected.resolving ? labels.loading : sourceReasonLabel(selected, labels)}
        </div>
      )}
    </section>
  );
}

export function SourcePreviewAffordance({
  index,
  ownerId,
  valueId,
}: {
  index: DocumentIndex;
  ownerId: NodeId;
  valueId: NodeId;
}) {
  const labels = useT().nodePanel.sources;
  const values = useMemo(
    () => nodeSourceValues(ownerId, index.byId),
    [index.byId, index.revision, ownerId],
  );
  const valueIds = useMemo(() => values.map((value) => value.sourceValueId), [values]);
  const view = useNodeSourceViewState(ownerId, valueIds);
  const selected = view.selectedValueId === valueId;
  if (selected && view.previewVisible) return null;
  const label = selected ? labels.showPreview : labels.previewThisSource;
  return (
    <ButtonControl
      aria-label={label}
      className="field-value-affordance source-preview-affordance"
      data-preserve-selection
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => view.show(valueId)}
      title={label}
    >
      <ShowIcon size={13} strokeWidth={1.8} />
    </ButtonControl>
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

function SourceSwitcher({
  labels,
  selected,
  values,
  onSelect,
}: {
  labels: ReturnType<typeof useT>['nodePanel']['sources'];
  selected: NodeSourceDescriptor & { resolving?: boolean };
  values: Array<NodeSourceDescriptor & { resolving?: boolean }>;
  onSelect: (valueId: NodeId) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open,
    layoutKey: values.map((value) => value.sourceValueId).join(':'),
    maxHeight: 360,
    placement: 'bottom-start',
    width: 320,
  });
  useDismissibleOverlay(menuRef, () => setOpen(false), {
    disabled: !open,
    escape: false,
    ignoreRefs: [anchorRef],
  });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose: () => setOpen(false),
    kind: 'menu',
  });
  const selectedLabel = sourceDisplayLabel(selected);

  if (values.length === 1) {
    return (
      <span className="node-source-preview-label" title={selected.sourceText}>
        {selectedLabel}
      </span>
    );
  }

  return (
    <>
      <ButtonControl
        ref={anchorRef}
        aria-expanded={open}
        aria-haspopup="menu"
        className="node-source-switcher"
        onClick={() => setOpen((current) => !current)}
        title={labels.switchSource}
      >
        <span>{selectedLabel}</span>
        <ChevronDownIcon aria-hidden="true" size={13} />
      </ButtonControl>
      {open ? createPortal(
        <MenuSurface
          ref={menuRef}
          aria-label={labels.switchSource}
          className="node-source-menu"
          role="menu"
          style={style}
          onKeyDown={onKeyDown}
        >
          {values.map((value) => (
            <MenuItem
              key={value.sourceValueId}
              active={value.sourceValueId === selected.sourceValueId}
              className="node-source-menu-item"
              icon={value.sourceValueId === selected.sourceValueId ? <CheckIcon size={14} /> : null}
              label={sourceDisplayLabel(value)}
              labelClassName="node-source-menu-label"
              meta={value.resolving ? labels.loading : availabilityLabel(value.availability, labels)}
              metaClassName="node-source-menu-meta"
              role="menuitem"
              onClick={() => {
                onSelect(value.sourceValueId);
                setOpen(false);
              }}
            />
          ))}
        </MenuSurface>,
        document.body,
      ) : null}
    </>
  );
}

function SourceActionsMenu({
  labels,
  ownerId,
  run,
  selected,
  total,
  onResolutionChanged,
}: {
  labels: ReturnType<typeof useT>['nodePanel']['sources'];
  ownerId: NodeId;
  run: CommandRunner;
  selected: NodeSourceDescriptor & { resolving?: boolean };
  total: number;
  onResolutionChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open,
    layoutKey: `${selected.sourceValueId}:${selected.availability}:${total}`,
    maxHeight: 420,
    placement: 'bottom-end',
    width: 240,
  });
  useDismissibleOverlay(menuRef, () => setOpen(false), {
    disabled: !open,
    escape: false,
    ignoreRefs: [anchorRef],
  });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose: () => setOpen(false),
    kind: 'menu',
  });
  const linkedFileTarget = selected.previewTarget?.kind === 'linked-file'
    ? selected.previewTarget
    : null;
  const runHostAction = async (action: () => Promise<void>, failure: string) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : failure);
    } finally {
      setPending(false);
      setOpen(false);
    }
  };
  const authorize = () => runHostAction(async () => {
    if (!linkedFileTarget) return;
    const result = await api.authorizeLinkedFile(linkedFileTarget);
    if (result.authorized) onResolutionChanged();
    else if (!result.canceled) {
      throw new Error(result.error === 'different-file' ? labels.differentFile : labels.authorizationFailed);
    }
  }, labels.authorizationFailed);

  return (
    <>
      <IconButton
        ref={anchorRef}
        disabled={pending}
        icon={MoreIcon}
        label={labels.moreActions}
        onClick={() => setOpen((current) => !current)}
        variant="panel"
      />
      {open ? createPortal(
        <MenuSurface
          ref={menuRef}
          aria-label={labels.moreActions}
          className="node-source-menu"
          role="menu"
          style={style}
          onKeyDown={onKeyDown}
        >
          <MenuItem
            className="node-source-menu-item"
            icon={<AttachmentIcon size={14} />}
            label={labels.linkFile}
            role="menuitem"
            onClick={() => void runHostAction(async () => {
              await run(() => api.linkFileSource(ownerId));
            }, labels.authorizationFailed)}
          />
          <MenuItem
            className="node-source-menu-item"
            icon={<AttachmentIcon size={14} />}
            label={labels.replaceWithFile}
            role="menuitem"
            onClick={() => void runHostAction(async () => {
              const result = await run(() => api.replaceSourceWithFile(ownerId, selected.sourceValueId));
              if (result) onResolutionChanged();
            }, labels.authorizationFailed)}
          />
          {linkedFileTarget && selected.availability !== 'ready' ? (
            <MenuItem
              className="node-source-menu-item"
              label={selected.availability === 'unavailable' ? labels.relink : labels.chooseFile}
              role="menuitem"
              onClick={() => void authorize()}
            />
          ) : null}
          {linkedFileTarget && selected.availability === 'ready' ? (
            <MenuItem
              className="node-source-menu-item"
              label={labels.forgetAccess}
              role="menuitem"
              onClick={() => void runHostAction(async () => {
                await api.forgetLinkedFile(linkedFileTarget);
                onResolutionChanged();
              }, labels.forgetFailed)}
            />
          ) : null}
          {selected.actions.includes('retry') && selected.availability !== 'ready' ? (
            <MenuItem
              className="node-source-menu-item"
              disabled={selected.resolving}
              label={labels.retry}
              role="menuitem"
              onClick={() => {
                onResolutionChanged();
                setOpen(false);
              }}
            />
          ) : null}
          <MenuItem
            className="node-source-menu-item"
            icon={<CopyIcon size={14} />}
            label={labels.copyUri}
            role="menuitem"
            onClick={() => {
              void navigator.clipboard.writeText(selected.sourceText);
              setOpen(false);
            }}
          />
          {total > 1 ? (
            <MenuItem
              className="node-source-menu-item"
              label={labels.clear}
              role="menuitem"
              onClick={() => void runHostAction(async () => {
                await run(() => api.clearSources(ownerId));
              }, labels.sourceActionFailed)}
            />
          ) : null}
          <MenuItem
            className="node-source-menu-item is-destructive"
            icon={<TrashIcon size={14} />}
            label={labels.remove}
            role="menuitem"
            onClick={() => void runHostAction(async () => {
              await run(() => api.removeSource(ownerId, selected.sourceValueId));
            }, labels.sourceActionFailed)}
          />
        </MenuSurface>,
        document.body,
      ) : null}
      {error ? <span className="node-source-action-error" role="alert">{error}</span> : null}
    </>
  );
}

function sourceDisplayLabel(source: NodeSourceDescriptor): string {
  return source.label.trim() || source.sourceText;
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
