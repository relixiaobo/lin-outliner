import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
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
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const activeFrameRef = useRef<number | null>(null);
  const measureFrameRef = useRef<number | null>(null);

  const syncActiveIndex = useCallback((nextMarkers = markersRef.current) => {
    const scrollRoot = scrollRootRef.current;
    if (!scrollRoot || nextMarkers.length === 0) {
      setActiveIndex((current) => current === -1 ? current : -1);
      return;
    }

    const nextActiveIndex = activeOutlineIndexForScrollTop(scrollRoot.scrollTop, nextMarkers);
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

    const nextMarkers = items.flatMap((item) => {
      const top = resolveItemTop(item, scrollRoot);
      if (top === null || !Number.isFinite(top)) return [];
      return [{
        ...item,
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

  useEffect(() => {
    centerActiveOutlineItem(trackRef.current, activeIndex);
  }, [activeIndex, markers.length]);

  if (markers.length === 0) return null;

  const jumpToMarker = (index: number) => {
    const marker = markersRef.current[index];
    const scrollRoot = scrollRootRef.current;
    if (!marker || !scrollRoot) return;
    scrollRoot.scrollTo({ top: marker.top, behavior: 'smooth' });
  };
  const syncPopoverToActive = () => {
    const scrollRoot = scrollRootRef.current;
    const nextActiveIndex = scrollRoot
      ? activeOutlineIndexForScrollTop(scrollRoot.scrollTop, markersRef.current)
      : activeIndex;
    centerActiveOutlineItem(popoverRef.current, nextActiveIndex);
  };
  const syncPopoverToActiveOnFocus = (event: FocusEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Node && popoverRef.current?.contains(target)) return;
    syncPopoverToActive();
  };

  return (
    <nav
      aria-label={labels.documentOutline}
      className="document-outline-rail"
      data-document-outline-rail
      onFocus={syncPopoverToActiveOnFocus}
      onMouseEnter={syncPopoverToActive}
    >
      <div className="document-outline-rail-track" ref={trackRef}>
        {markers.map((marker, index) => (
          <button
            aria-label={labels.documentOutlineJump({ title: marker.title })}
            className={`document-outline-rail-marker ${index === activeIndex ? 'active' : ''}`}
            key={marker.id}
            onClick={() => jumpToMarker(index)}
            title={marker.title}
            type="button"
          />
        ))}
      </div>
      <div className="document-outline-popover" ref={popoverRef}>
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
      && Math.abs(marker.top - other.top) < 1;
  });
}

function centerActiveOutlineItem(container: HTMLElement | null, activeIndex: number) {
  if (activeIndex < 0 || !container) return;
  const activeItem = container.children.item(activeIndex);
  if (!(activeItem instanceof HTMLElement)) return;
  const nextTop = activeItem.offsetTop - (container.clientHeight - activeItem.offsetHeight) / 2;
  const targetTop = Math.max(0, nextTop);
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top: targetTop, behavior: 'auto' });
  } else {
    container.scrollTop = targetTop;
  }
}

function activeOutlineIndexForScrollTop(scrollTop: number, markers: DocumentOutlineMarker[]): number {
  if (markers.length === 0) return -1;
  const activeTop = scrollTop + 1;
  let activeIndex = 0;
  for (let index = 0; index < markers.length; index += 1) {
    if (markers[index]!.top <= activeTop) activeIndex = index;
  }
  return activeIndex;
}
