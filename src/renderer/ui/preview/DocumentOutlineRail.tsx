import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { useT } from '../../i18n/I18nProvider';

export type DocumentOutlineItem = {
  id: string;
  level: number;
  target: unknown;
  title: string;
};

type DocumentOutlineMarker = DocumentOutlineItem & {
  ratio: number;
  top: number;
};

export function DocumentOutlineRail({
  items,
  layoutVersion,
  resolveItemTop,
  scrollRootRef,
}: {
  items: DocumentOutlineItem[];
  layoutVersion?: number | string;
  resolveItemTop: (item: DocumentOutlineItem, scrollRoot: HTMLElement) => number | null;
  scrollRootRef: RefObject<HTMLElement | null>;
}) {
  const labels = useT().shell.filePreview;
  const [markers, setMarkers] = useState<DocumentOutlineMarker[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const markersRef = useRef<DocumentOutlineMarker[]>([]);
  const activeFrameRef = useRef<number | null>(null);
  const measureFrameRef = useRef<number | null>(null);

  const syncActiveIndex = useCallback((nextMarkers = markersRef.current) => {
    const scrollRoot = scrollRootRef.current;
    if (!scrollRoot || nextMarkers.length === 0) {
      setActiveIndex((current) => current === -1 ? current : -1);
      return;
    }

    const activeTop = scrollRoot.scrollTop + 1;
    let nextActiveIndex = 0;
    for (let index = 0; index < nextMarkers.length; index += 1) {
      if (nextMarkers[index]!.top <= activeTop) nextActiveIndex = index;
    }
    setActiveIndex((current) => current === nextActiveIndex ? current : nextActiveIndex);
  }, [scrollRootRef]);

  const scheduleActiveIndex = useCallback(() => {
    if (activeFrameRef.current !== null) return;
    activeFrameRef.current = window.requestAnimationFrame(() => {
      activeFrameRef.current = null;
      syncActiveIndex();
    });
  }, [syncActiveIndex]);

  const measureMarkers = useCallback(() => {
    const scrollRoot = scrollRootRef.current;
    if (!scrollRoot || items.length === 0) {
      markersRef.current = [];
      setMarkers((current) => current.length === 0 ? current : []);
      syncActiveIndex([]);
      return;
    }

    const maxScrollTop = Math.max(1, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    const nextMarkers = items.flatMap((item) => {
      const top = resolveItemTop(item, scrollRoot);
      if (top === null || !Number.isFinite(top)) return [];
      return [{
        ...item,
        ratio: Math.max(0, Math.min(1, top / maxScrollTop)),
        top: Math.max(0, top),
      }];
    });

    markersRef.current = nextMarkers;
    setMarkers((current) => outlineMarkersEqual(current, nextMarkers) ? current : nextMarkers);
    syncActiveIndex(nextMarkers);
  }, [items, resolveItemTop, scrollRootRef, syncActiveIndex]);

  const scheduleMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) return;
    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measureMarkers();
    });
  }, [measureMarkers]);

  useEffect(() => {
    const scrollRoot = scrollRootRef.current;
    if (!scrollRoot) return undefined;

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scrollRoot);
    for (const child of Array.from(scrollRoot.children)) observer.observe(child);
    scrollRoot.addEventListener('scroll', scheduleActiveIndex, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    scheduleMeasure();

    return () => {
      if (activeFrameRef.current !== null) window.cancelAnimationFrame(activeFrameRef.current);
      if (measureFrameRef.current !== null) window.cancelAnimationFrame(measureFrameRef.current);
      activeFrameRef.current = null;
      measureFrameRef.current = null;
      observer.disconnect();
      scrollRoot.removeEventListener('scroll', scheduleActiveIndex);
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [layoutVersion, scheduleActiveIndex, scheduleMeasure, scrollRootRef]);

  if (markers.length === 0) return null;

  const jumpToMarker = (index: number) => {
    const marker = markersRef.current[index];
    const scrollRoot = scrollRootRef.current;
    if (!marker || !scrollRoot) return;
    scrollRoot.scrollTo({ top: marker.top, behavior: 'smooth' });
  };

  return (
    <nav
      aria-label={labels.documentOutline}
      className="document-outline-rail"
      data-document-outline-rail
    >
      <div className="document-outline-rail-track">
        {markers.map((marker, index) => (
          <button
            aria-label={labels.documentOutlineJump({ title: marker.title })}
            className={`document-outline-rail-marker ${index === activeIndex ? 'active' : ''}`}
            key={marker.id}
            onClick={() => jumpToMarker(index)}
            style={{ top: `${marker.ratio * 100}%` }}
            title={marker.title}
            type="button"
          />
        ))}
      </div>
      <div className="document-outline-popover">
        {markers.map((marker, index) => (
          <button
            className={`document-outline-item ${index === activeIndex ? 'active' : ''}`}
            key={`${marker.id}:label`}
            onClick={() => jumpToMarker(index)}
            style={{ '--document-outline-level': marker.level } as CSSProperties}
            title={marker.title}
            type="button"
          >
            <span className="document-outline-item-title">{marker.title}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function outlineMarkersEqual(left: DocumentOutlineMarker[], right: DocumentOutlineMarker[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((marker, index) => {
    const other = right[index];
    return Boolean(other)
      && marker.id === other.id
      && marker.title === other.title
      && marker.level === other.level
      && Math.abs(marker.top - other.top) < 1
      && Math.abs(marker.ratio - other.ratio) < 0.001;
  });
}
