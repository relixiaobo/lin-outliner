import { useCallback, useEffect, useRef, useState } from 'react';
import { CONFIGURATION_LINKS, type PreferenceValue, type PreferencesView, type PreferenceId } from '../../core/settingsDefinitions';
import { SETTINGS_PANES, settingsOpenTargetFromSearch, type SettingsPane } from '../../core/settingsWindow';
import { createSerialMutationQueue } from '../../core/serialMutationQueue';
import { APP_NAME } from '../../core/brand';
import { useT } from '../i18n/I18nProvider';
import { SegmentedControl } from './primitives/SegmentedControl';
import { Button } from './primitives/Button';
import { IconButton } from './primitives/IconButton';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, SearchIcon, SettingsIcon, AgentIcon, SkillIcon, PasswordIcon, DatabaseIcon, CommandIcon, OptionsIcon, AppWindowIcon, RecentsIcon, ICON_SIZE } from './icons';
import { PreferenceRow } from './configuration/PreferenceRow';
import { ConfigurationPane } from './configuration/ManagerWindow';

const PANE_ICONS = { settings: SettingsIcon, models: AppWindowIcon, agents: AgentIcon, skills: SkillIcon, memory: RecentsIcon, access: PasswordIcon, data: DatabaseIcon, shortcuts: CommandIcon, diagnostics: OptionsIcon };
function initialPane(): SettingsPane {
  const destination = settingsOpenTargetFromSearch(window.location.search).destination;
  return destination && destination !== 'about' ? destination : 'settings';
}
function replacePaneUrl(pane: SettingsPane) {
  const url = new URL(window.location.href);
  url.searchParams.set('destination', pane);
  url.searchParams.delete('setting');
  window.history.replaceState(null, '', url);
}

export function SettingsWindow() {
  const t = useT();
  const copy = t.settings.discovery;
  const [query, setQuery] = useState(() => settingsOpenTargetFromSearch(window.location.search).settingId ?? '');
  const [navigation, setNavigation] = useState(() => ({ panes: [initialPane()], index: 0 }));
  const pane = navigation.panes[navigation.index];
  const [visited, setVisited] = useState<Set<SettingsPane>>(() => new Set([initialPane()]));
  const navigate = useCallback((next: SettingsPane) => {
    setQuery('');
    setNavigation((previous) => {
      if (previous.panes[previous.index] === next) return previous;
      const panes = [...previous.panes.slice(0, previous.index + 1).slice(-49), next];
      return { panes, index: panes.length - 1 };
    });
    setVisited((previous) => previous.has(next) ? previous : new Set([...previous, next]));
    replacePaneUrl(next);
  }, []);
  const searching = query.trim().length > 0;
  function traverse(direction: -1 | 1) {
    if (searching) { if (direction === -1) setQuery(''); return; }
    const index = navigation.index + direction;
    if (index < 0 || index >= navigation.panes.length) return;
    setNavigation({ ...navigation, index });
    replacePaneUrl(navigation.panes[index]);
  }
  const [filter, setFilter] = useState<'all' | 'modified'>('all');
  const [view, setView] = useState<PreferencesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = useRef<PreferencesView | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const queue = useRef(createSerialMutationQueue());
  const accept = useCallback((next: PreferencesView) => { current.current = next; if (mounted.current) setView(next); }, []);
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    try {
      const next = await window.lin?.preferences.get();
      if (mounted.current && request === epoch.current && next) { accept(next); setError(null); }
    } catch (caught) { if (mounted.current && request === epoch.current) setError(String(caught)); }
  }, [accept]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    let queued = false;
    const scheduleRefresh = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (mounted.current) void queue.current.run(refresh); });
    };
    const off = window.lin?.onConfigurationChanged('preferences', scheduleRefresh);
    window.addEventListener('focus', scheduleRefresh);
    const offTarget = window.lin?.onSettingsNavigate((target) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (target.destination && target.destination !== 'about') navigate(target.destination);
      if (target.settingId) { setQuery(target.settingId); setFilter('all'); search.current?.focus(); }
    });
    return () => { mounted.current = false; epoch.current += 1; off?.(); offTarget?.(); window.removeEventListener('focus', scheduleRefresh); };
  }, [refresh, navigate]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault(); search.current?.focus(); search.current?.select();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  function edit(id: PreferenceId, operation: 'set' | 'reset', value?: PreferenceValue, expectedDigest?: string | null): Promise<void> {
    return queue.current.run(async () => {
      const observed = current.current;
      if (!observed || !window.lin) throw new Error(copy.sourceError);
      epoch.current += 1;
      try {
        const next = await window.lin.preferences.edit({ id, operation, value, expectedDigest: expectedDigest === undefined ? observed.source.digest : expectedDigest });
        const focused = document.activeElement;
        accept(next);
        if (operation === 'reset' && filter === 'modified' && !query) requestAnimationFrame(() => {
          if (mounted.current && focused && !focused.isConnected && document.activeElement === document.body) search.current?.focus();
        });
      } catch (caught) { await refresh(); throw caught; }
    });
  }
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...parts: string[]) => terms.every((term) => parts.join(' ').toLocaleLowerCase().includes(term));
  const entries = view?.entries.filter((entry) => {
    const text = copy.fields[entry.id];
    return matches(entry.id, text.label, text.description, text.aliases);
  }) ?? [];
  const links = CONFIGURATION_LINKS.filter(({ destination, paths }) => matches(copy.destinations[destination], copy.descriptions[destination], ...paths));
  const rows = (ids: readonly PreferenceId[]) => <div className="preference-list" role="list">{view?.entries.filter((entry) => ids.includes(entry.id)).map((entry) => <PreferenceRow key={entry.id} entry={entry}
    sourceDigest={view.source.digest} disabled={view.source.status === 'rejected'} edit={(operation, value, expectedDigest) => edit(entry.id, operation, value, expectedDigest)} />)}</div>;
  const openFile = () => void window.lin?.preferences.openFile().catch((caught) => setError(String(caught)));
  const sourceFeedback = <>
    {error || view?.source.error || view?.source.recoveryError ? <div className="configuration-source-error" role="alert">
      {view?.source.status === 'rejected' ? <p>{copy.retained}</p> : null}
      <p>{error ?? view?.source.error ?? view?.source.recoveryError}</p>
      <Button size="sm" variant="secondary" onClick={() => void refresh()}>{copy.refresh}</Button>
      <Button size="sm" variant="ghost" onClick={openFile}>{copy.openFile}</Button>
    </div> : null}
    {view?.sources?.filter((source) => source.error).map((source) => <div className="configuration-source-error" key={source.path} role="alert">
      <p>{copy.destinations[source.destination]}: {source.error}</p>
      <Button size="sm" variant="secondary" onClick={() => void window.lin?.preferences.openSource(source.sourceId).catch((caught) => setError(String(caught)))}>{copy.openSource}</Button>
    </div>)}
    {view?.application.status === 'failed' ? <p role="status">{copy.applyFailed} {view.application.error}</p>
      : view?.application.status === 'pending' ? <p role="status">{copy.applyPending}</p> : null}
    {!view ? <p role="status">{copy.loading}</p> : null}
  </>;
  return <main className="configuration-window settings-window" aria-label={t.window.settingsTitle({ app: APP_NAME })}>
    <div className="settings-layout">
      <aside className="settings-rail">
        <div className="settings-rail-chrome" aria-hidden="true" />
        <div className="configuration-search" role="search">
          <SearchIcon size={ICON_SIZE.menu} aria-hidden />
          <input ref={search} type="search" aria-label={copy.search} placeholder={copy.search} value={query}
            onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (!event.nativeEvent.isComposing && event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
            }} />
          {query ? <IconButton icon={CloseIcon} label={copy.clearSearch} variant="chrome"
            onClick={() => { setQuery(''); search.current?.focus(); }} /> : null}
        </div>
        <div className="settings-sidebar" role="tablist" aria-label={copy.navigation} aria-orientation="vertical">
          {SETTINGS_PANES.map((destination, index) => {
            const Icon = PANE_ICONS[destination];
            return <button type="button" key={destination} role="tab" id={`settings-tab-${destination}`}
              aria-selected={!searching && pane === destination} aria-controls={`settings-pane-${destination}`} tabIndex={pane === destination ? 0 : -1}
              onClick={() => navigate(destination)} onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                const next = event.key === 'ArrowDown' ? (index + 1) % SETTINGS_PANES.length
                  : event.key === 'ArrowUp' ? (index - 1 + SETTINGS_PANES.length) % SETTINGS_PANES.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? SETTINGS_PANES.length - 1 : null;
                if (next === null) return;
                event.preventDefault(); navigate(SETTINGS_PANES[next]);
                document.getElementById(`settings-tab-${SETTINGS_PANES[next]}`)?.focus();
              }}><Icon size={ICON_SIZE.menu} aria-hidden /><span>{copy.destinations[destination]}</span></button>;
          })}
        </div>
      </aside>
      <div className="settings-column">
        <header className="configuration-toolbar">
          <div className="settings-history">
            <IconButton icon={ChevronLeftIcon} iconSize={ICON_SIZE.large} label={t.settings.navigation.back} variant="chrome"
              disabled={!searching && navigation.index === 0} onClick={() => traverse(-1)} />
            <span className="settings-history-separator" aria-hidden="true" />
            <IconButton icon={ChevronRightIcon} iconSize={ICON_SIZE.large} label={t.settings.navigation.forward} variant="chrome"
              disabled={searching || navigation.index === navigation.panes.length - 1} onClick={() => traverse(1)} />
          </div>
          <h1 id="configuration-title">{searching ? copy.searchResults : copy.destinations[pane]}</h1>
        </header>
        <div className="settings-body">
          <div className="settings-feedback">{sourceFeedback}</div>
          <section className="configuration-content settings-pane" hidden={!searching} aria-label={copy.searchResults}>
            {searching ? <>
              {entries.length ? rows(entries.map((entry) => entry.id)) : null}
              {links.length ? <section aria-label={copy.managers}>
                <h2 className="configuration-group-title">{copy.managers}</h2>
                <div className="preference-list" role="list">{links.map(({ destination }) => <div className="preference-row" key={destination} role="listitem">
                  <div className="preference-copy"><div className="preference-label">{copy.destinations[destination]}</div><p>{copy.descriptions[destination]}</p></div>
                  <Button size="sm" variant="secondary" aria-label={`${copy.open} ${copy.destinations[destination]}`} onClick={() => {
                    navigate(destination);
                    requestAnimationFrame(() => document.getElementById(`settings-pane-${destination}`)?.focus());
                  }}>{copy.open}</Button>
                </div>)}</div>
              </section> : null}
              {view && !entries.length && !links.length ? <p role="status">{copy.noResults}</p> : null}
            </> : null}
          </section>
          {SETTINGS_PANES.map((destination) => <section key={destination} id={`settings-pane-${destination}`} role="tabpanel"
            className="configuration-content settings-pane" aria-labelledby={`settings-tab-${destination}`} tabIndex={0} hidden={searching || pane !== destination}>
            {visited.has(destination) ? destination === 'settings' ? <>
              <section aria-label={copy.appearanceGroup}>{rows(['appearance.theme', 'appearance.language'])}</section>
              <section aria-label={copy.updatesGroup}><h2 className="configuration-group-title">{copy.updatesGroup}</h2>{rows(['updates.checkAutomatically'])}</section>
            </> : <>
              <ConfigurationPane destination={destination} active={!searching && pane === destination} />
              {destination === 'models' ? <details className="settings-disclosure"><summary>{copy.requestOptions}</summary>
                {rows(['agent.provider.timeoutMs', 'agent.provider.maxRetries', 'agent.provider.maxRetryDelayMs', 'agent.provider.cacheRetention'])}
              </details> : null}
              {destination === 'diagnostics' ? <>
                <section aria-label={copy.sourceOptions}><h2 className="configuration-group-title">{copy.sourceOptions}</h2>
                  <Button size="sm" variant="secondary" onClick={openFile}>{copy.openFile}</Button>
                  {view?.sources?.length ? <div className="preference-list settings-source-list" role="list">{view.sources.map((source) => <div className="preference-row" role="listitem" key={source.sourceId}>
                    <div className="preference-copy"><div className="preference-label">{copy.destinations[source.destination]}{source.modified ? ` · ${copy.modified}` : ''}</div><p>{source.path}</p></div>
                    <Button size="sm" variant="secondary" onClick={() => void window.lin?.preferences.openSource(source.sourceId).catch((caught) => setError(String(caught)))}>{copy.openSource}</Button>
                  </div>)}</div> : null}
                </section>
                <details className="settings-disclosure"><summary>{copy.customizedOptions}</summary>
                  <div className="configuration-filter"><SegmentedControl label={copy.filter} value={filter}
                    options={[{ value: 'all', label: copy.all }, { value: 'modified', label: copy.modified }]} onChange={setFilter} /></div>
                  {rows((view?.entries.filter((entry) => filter === 'all' || entry.modified) ?? []).map((entry) => entry.id))}
                  {filter === 'modified' && !view?.entries.some((entry) => entry.modified) ? <p role="status">{copy.noResults}</p> : null}
                </details>
              </> : null}
            </> : null}
          </section>)}
        </div>
      </div>
    </div>
  </main>;
}
