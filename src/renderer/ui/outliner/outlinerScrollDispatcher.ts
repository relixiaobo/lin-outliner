type ScrollRegistration = {
  readonly resolveScroller: () => HTMLElement | null;
  readonly onScroll: () => void;
};

const registrations = new Set<ScrollRegistration>();
let listening = false;

function isViewportTarget(target: EventTarget | null): boolean {
  return target === window
    || target === document
    || target === document.documentElement
    || target === document.body;
}

function dispatchScroll(event: Event): void {
  const target = event.target;
  for (const registration of registrations) {
    const scroller = registration.resolveScroller();
    if (!scroller) continue;
    if (isViewportTarget(target) || target === scroller) {
      registration.onScroll();
      continue;
    }
    if (target instanceof Node && scroller.contains(target)) registration.onScroll();
  }
}

function startListening(): void {
  if (listening) return;
  window.addEventListener('scroll', dispatchScroll, { capture: true, passive: true });
  listening = true;
}

function stopListening(): void {
  if (!listening || registrations.size > 0) return;
  window.removeEventListener('scroll', dispatchScroll, true);
  listening = false;
}

export function registerOutlinerScrollListener(
  resolveScroller: () => HTMLElement | null,
  onScroll: () => void,
): () => void {
  const registration = { resolveScroller, onScroll };
  registrations.add(registration);
  startListening();
  return () => {
    registrations.delete(registration);
    stopListening();
  };
}
