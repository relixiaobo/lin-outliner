import { useCallback, useEffect, useRef, useState } from 'react';
import { CONFIGURATION_LINKS, type PreferenceValue, type PreferencesView, type PreferenceId } from '../../core/settingsDefinitions';
import { settingsOpenTargetFromSearch } from '../../core/settingsWindow';
import { createSerialMutationQueue } from '../../core/serialMutationQueue';
import { APP_NAME } from '../../core/brand';
import { useT } from '../i18n/I18nProvider';
import { SegmentedControl } from './primitives/SegmentedControl';
import { Button } from './primitives/Button';
import { IconButton } from './primitives/IconButton';
import { CloseIcon, SearchIcon, ICON_SIZE } from './icons';
import { PreferenceRow } from './configuration/PreferenceRow';

export function SettingsWindow() {
  const t = useT();
  const copy = t.settings.discovery;
  const [query, setQuery] = useState(() => settingsOpenTargetFromSearch(window.location.search).settingId ?? '');
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
      if (target.settingId) { setQuery(target.settingId); setFilter('all'); search.current?.focus(); }
    });
    return () => { mounted.current = false; epoch.current += 1; off?.(); offTarget?.(); window.removeEventListener('focus', scheduleRefresh); };
  }, [refresh]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
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
        if (operation === 'reset' && filter === 'modified') requestAnimationFrame(() => {
          if (mounted.current && focused && !focused.isConnected && document.activeElement === document.body) search.current?.focus();
        });
      } catch (caught) { await refresh(); throw caught; }
    });
  }
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...parts: string[]) => terms.every((term) => parts.join(' ').toLocaleLowerCase().includes(term));
  const entries = view?.entries.filter((entry) => {
    const text = copy.fields[entry.id];
    return (filter === 'all' || entry.modified) && matches(entry.id, text.label, text.description, text.aliases);
  }) ?? [];
  const links = CONFIGURATION_LINKS.filter(({ destination, paths }) => (
    (filter === 'all' || paths.some((path) => view?.structuredOverrides.includes(path))
      || view?.sources?.some((source) => source.destination === destination && source.modified))
    && matches(copy.destinations[destination], copy.descriptions[destination], ...paths)
  ));
  return <main className="configuration-window" aria-labelledby="configuration-title">
    <header className="configuration-toolbar">
      <h1 id="configuration-title">{t.window.settingsTitle({ app: APP_NAME })}</h1>
      <div className="configuration-search" role="search">
        <SearchIcon size={ICON_SIZE.menu} aria-hidden />
        <input ref={search} type="search" aria-label={copy.search} placeholder={copy.search} value={query}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (!event.nativeEvent.isComposing && event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
          }} />
        <IconButton icon={CloseIcon} label={copy.clearSearch} variant="chrome" disabled={!query}
          onClick={() => { setQuery(''); search.current?.focus(); }} />
      </div>
    </header>
    <div className="configuration-content">
      <div className="configuration-filter">
        <SegmentedControl label={copy.filter} value={filter} options={[{ value: 'all', label: copy.all }, { value: 'modified', label: copy.modified }]}
          onChange={setFilter} />
        <Button size="sm" variant="ghost" onClick={() => void window.lin?.preferences.openFile().catch((caught) => setError(String(caught)))}>{copy.openFile}</Button>
      </div>
      {error || view?.source.error || view?.source.recoveryError ? <div className="configuration-source-error" role="alert">
        {view?.source.status === 'rejected' ? <p>{copy.retained}</p> : null}
        <p>{error ?? view?.source.error ?? view?.source.recoveryError}</p>
        <Button size="sm" variant="secondary" onClick={() => void refresh()}>{copy.refresh}</Button>
      </div> : null}
      {view?.sources?.filter((source) => source.error).map((source) => <div className="configuration-source-error" key={source.path} role="alert">
        <p>{copy.destinations[source.destination]}: {source.error}</p>
        <Button size="sm" variant="secondary" onClick={() => void window.lin?.preferences.openSource(source.sourceId).catch((caught) => setError(String(caught)))}>{copy.openSource}</Button>
      </div>)}
      {view?.application.status === 'failed' ? <p role="status">{copy.applyFailed} {view.application.error}</p>
        : view?.application.status === 'pending' ? <p role="status">{copy.applyPending}</p> : null}
      {!view ? <p role="status">{copy.loading}</p> : null}
      {entries.length ? <section aria-label={copy.preferences}>
        <h2 className="configuration-group-title">{copy.preferences}</h2>
        <div className="preference-list" role="list">{entries.map((entry) => <PreferenceRow key={entry.id} entry={entry}
          sourceDigest={view!.source.digest} disabled={view?.source.status === 'rejected'} edit={(operation, value, expectedDigest) => edit(entry.id, operation, value, expectedDigest)} />)}</div>
      </section> : null}
      {links.length ? <section aria-label={copy.managers}>
        <h2 className="configuration-group-title">{copy.managers}</h2>
        <div className="preference-list" role="list">{links.map(({ destination }) => <div className="preference-row" key={destination} role="listitem">
          <div className="preference-copy"><div className="preference-label">{copy.destinations[destination]}</div><p>{copy.descriptions[destination]}</p></div>
          <Button size="sm" variant="secondary" aria-label={`${copy.open} ${copy.destinations[destination]}`}
            onClick={() => void window.lin?.openSettings({ destination })}>{copy.open}</Button>
        </div>)}</div>
      </section> : null}
      {view && !entries.length && !links.length ? <div className="configuration-empty">
        <p role="status">{copy.noResults}</p>
        {query ? <Button variant="secondary" onClick={() => { setQuery(''); search.current?.focus(); }}>{copy.clearSearch}</Button> : null}
        {filter === 'modified' ? <Button variant="secondary" onClick={() => setFilter('all')}>{copy.showAll}</Button> : null}
      </div> : null}
    </div>
  </main>;
}
