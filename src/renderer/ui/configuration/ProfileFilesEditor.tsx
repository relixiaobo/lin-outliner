import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ProfileFileView, ProfileSourceView } from '../../../core/agent/profileFiles';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { InsetGroup, InsetRow } from '../agent/SettingsInsetList';
import { Button } from '../primitives/Button';
import { Dialog } from '../primitives/Dialog';
import { Textarea } from '../primitives/Textarea';
import { SettingsFeedback } from './SettingsFeedback';

export function ProfileFilesEditor() {
  const t = useT();
  const labels = t.settings.agents;
  const [files, setFiles] = useState<readonly ProfileFileView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProfileFileView | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const catalog = await api.agentIdentityCatalog();
      const result = await api.memoryInspect({ operation: 'profile', profileName: catalog.profile.name });
      if (request !== generation.current || result.operation !== 'profile') return;
      setFiles(result.files);
      setError(null);
    } catch (caught) { if (request === generation.current) setError(errorText(caught)); }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    const off = window.lin?.onMemoryChanged?.(onFocus);
    window.addEventListener('focus', onFocus);
    return () => { generation.current++; off?.(); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  const title = (file: ProfileFileView) => file.kind === 'identity' ? labels.profileIdentity : file.kind === 'style' ? labels.profileStyle : labels.profileUser;
  const status = (file: ProfileFileView) => file.activationError || file.state === 'rejected' ? labels.profileRejected : file.state === 'accepted' ? file.effective?.digest === file.acceptedDigest ? labels.profileSelected : labels.profileAccepted
    : file.state === 'pending' ? labels.profilePending : labels.profileMissing;
  return <>
    <InsetGroup label={labels.profileFiles} ariaLabel={labels.profileFiles} footnote={labels.profileFilesHint}
      headerFeedback={<SettingsFeedback feedback={{ error }} />}>
      {files.map((file) => <InsetRow key={file.kind} label={title(file)} sublabel={status(file)}
        onSelect={() => setEditing(file)} trailing={<Button size="sm" variant="secondary" onClick={() => setEditing(file)}>{labels.editAction}</Button>} />)}
    </InsetGroup>
    {editing && <ProfileFileDialog file={editing} title={title(editing)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
  </>;
}

function ProfileFileDialog({ file, title, onClose, onSaved }: {
  file: ProfileFileView; title: string; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const labels = t.settings.agents;
  const heading = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(file.content || (file.kind === 'user' ? '# User\n' : ''));
  const [observation, setObservation] = useState(file);
  const [error, setError] = useState<string | null>(file.error ?? file.activationError);
  const [source, setSource] = useState<ProfileSourceView | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const refresh = async () => {
    try {
      const result = await api.memoryInspect({ operation: 'profile', profileName: file.profileName });
      if (result.operation !== 'profile') return;
      const next = result.files.find((item) => item.kind === file.kind)!;
      setObservation(next);
      setError(next.error ?? next.activationError);
    } catch (caught) { setError(errorText(caught)); }
  };
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await api.memoryManage({ operation: 'edit_profile_file', kind: file.kind, profileName: file.profileName,
        expectedDigest: observation.savedDigest, content: draft });
      onSaved();
    } catch (caught) { setError(errorText(caught)); }
    finally { saving.current = false; setBusy(false); }
  };
  const openSource = async (key: string, originItemId: string) => {
    try {
      const result = await api.memoryInspect({ operation: 'profile_source', key, originItemId });
      if (result.operation === 'profile_source') setSource(result.source);
    } catch (caught) { setError(errorText(caught)); }
  };
  const close = () => { if (!saving.current) onClose(); };
  return <Dialog backdropClassName="confirm-dialog-backdrop" surfaceClassName="confirm-dialog agent-editor-dialog"
    labelledBy={heading} initialFocus={() => input.current} onEscapeKeyDown={close} onBackdropMouseDown={close}>
    <form className="agent-editor-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <header className="agent-editor-heading"><h2 id={heading} className="confirm-dialog-title">{title}</h2></header>
      <div className="agent-editor-body">
        <p className="agent-editor-hint">{labels.profileFilesHint}</p>
        <Textarea ref={input} label={title} value={draft} rows={10} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
        {file.kind === 'user' && <p className="agent-editor-hint">{labels.profileEntryHelp}</p>}
        <details><summary>{labels.profileSource}</summary>
          <p className="agent-editor-hint">{file.path}</p>
          <p className="agent-editor-hint">{labels.profileRevisions({ accepted: observation.revision, selected: observation.effective?.revision ?? null })}</p>
          {observation.entries.map((entry) => <div key={entry.key}>
            <p>{entry.scope} · {entry.authorship === 'manual' ? labels.profileManual : entry.authorship === 'agent' ? labels.profileAgent : labels.profileLearned}</p>
            {entry.sources.map((item) => <Button key={item.originItemId} size="sm" variant="ghost" onClick={() => void openSource(entry.key, item.originItemId)}>{item.sourceDate}</Button>)}
          </div>)}
          {source && (source.state === 'available' ? <>
            <pre className="profile-source-preview">{source.content}</pre>
            {source.truncated && <p className="agent-editor-hint">{labels.profileTruncated}</p>}
          </> : <p role="status">{labels.profileUnavailable}</p>)}
        </details>
      </div>
      <footer className="agent-editor-footer">
        {error && <p className="agent-editor-conflict" role="alert">{error}</p>}
        <div className="confirm-dialog-actions agent-editor-actions">
          <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>{labels.profileRefresh}</Button>
          <Button variant="ghost" disabled={busy} onClick={close}>{t.dialog.cancel}</Button>
          <Button type="submit" variant="primary" tone="subtle" disabled={busy}>{busy ? labels.saving : labels.save}</Button>
        </div>
      </footer>
    </form>
  </Dialog>;
}
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': /, '')
    .replace(/^(?:Error|ProfileConflictError): /, '');
}
