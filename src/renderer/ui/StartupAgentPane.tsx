import type { KeyboardEvent, PointerEvent } from 'react';
import { useT } from '../i18n/I18nProvider';
import { ResizeHandle } from './primitives/ResizeHandle';
import { StartupFailure } from './StartupFailure';
import type { useStartupState } from './useStartupState';

export function StartupAgentPane(props: {
  readonly startup: ReturnType<typeof useStartupState>;
  readonly open: boolean;
  readonly onContinue: () => void;
  readonly onResizeKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onResizeReset: () => void;
  readonly onResizeStart: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const t = useT();
  const { startup, open } = props;
  const railState = open ? 'open' : 'collapsed';
  return <aside className={`agent-dock agent-dock-${railState}`} data-rail-state={railState}
    aria-label={t.shell.agentDock.ariaLabel} inert={open ? undefined : true}>
    <div className="thread-dock startup-agent-pane">
      {startup.failure ? <StartupFailure failure={startup.failure} issue={startup.issue} issues={startup.state.issues} threads={startup.state.threads}
        actionError={startup.actionError} retrying={startup.retrying} onRetry={() => void startup.retry()}
        onQuit={startup.quit} onContinue={props.onContinue} />
        : <p className="thread-empty-copy" role="status">{t.startup.agentStarting}</p>}
    </div>
    <ResizeHandle className="dock-resize-handle agent-resize-handle" disabled={!open}
      label={t.shell.agentDock.resizeLabel} title={t.shell.agentDock.resizeTitle}
      onDoubleClick={props.onResizeReset} onKeyDown={props.onResizeKeyDown} onPointerDown={props.onResizeStart} />
  </aside>;
}
