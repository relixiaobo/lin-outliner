import type {
  ThreadAttachmentContent,
  ThreadResourceReference,
} from '../../core/agent/protocol';

export interface OpaqueCurrentResourceAdapter<Attachment, Handle> {
  readonly handleOf: (attachment: Attachment) => Handle | null;
  readonly sameHandle: (left: Handle, right: Handle) => boolean;
  readonly requestDiscardIfUnlinked: (handle: Handle) => void;
}

export class ComposerHistoryResourceRegistry<Slot, Bundle, Attachment, Handle> {
  private readonly slots = new Map<Slot, Bundle>();

  constructor(
    private readonly adapter: OpaqueCurrentResourceAdapter<Attachment, Handle>,
    private readonly attachmentsOf: (bundle: Bundle) => readonly Attachment[],
  ) {}

  set(slot: Slot, bundle: Bundle): void {
    this.slots.set(slot, bundle);
  }

  get(slot: Slot): Bundle | undefined {
    return this.slots.get(slot);
  }

  take(slot: Slot): Bundle | undefined {
    const bundle = this.slots.get(slot);
    if (bundle !== undefined) this.slots.delete(slot);
    return bundle;
  }

  values(): Bundle[] {
    return [...this.slots.values()];
  }

  attachments(): Attachment[] {
    return this.values().flatMap((bundle) => [...this.attachmentsOf(bundle)]);
  }

  release(slot: Slot, visible: readonly Attachment[]): readonly Attachment[] {
    const bundle = this.slots.get(slot);
    if (bundle === undefined) return [];
    this.slots.delete(slot);
    return this.releaseUnlinked(this.attachmentsOf(bundle), visible);
  }

  releaseDetached(bundles: readonly Bundle[], visible: readonly Attachment[]): readonly Attachment[] {
    return this.releaseUnlinked(
      bundles.flatMap((bundle) => [...this.attachmentsOf(bundle)]),
      visible,
    );
  }

  releaseAll(visible: readonly Attachment[]): readonly Attachment[] {
    const released = this.attachments();
    this.slots.clear();
    return this.releaseUnlinked(released, visible);
  }

  releaseUnlinked(
    released: readonly Attachment[],
    visible: readonly Attachment[],
  ): readonly Attachment[] {
    const retainedHandles = [...visible, ...this.attachments()]
      .flatMap((attachment) => {
        const handle = this.adapter.handleOf(attachment);
        return handle === null ? [] : [handle];
      });
    const requested: Handle[] = [];
    for (const attachment of released) {
      const handle = this.adapter.handleOf(attachment);
      if (handle === null) continue;
      if (retainedHandles.some((candidate) => this.adapter.sameHandle(candidate, handle))) continue;
      if (requested.some((candidate) => this.adapter.sameHandle(candidate, handle))) continue;
      requested.push(handle);
      this.adapter.requestDiscardIfUnlinked(handle);
    }
    return released;
  }
}

export function currentThreadResourceAdapter(input: {
  readonly requestDiscardIfUnlinked: (handle: ThreadResourceReference) => void;
}): OpaqueCurrentResourceAdapter<ThreadAttachmentContent, ThreadResourceReference> {
  return {
    handleOf: (attachment) => attachment.source.kind === 'resource'
      ? attachment.source.ref
      : null,
    sameHandle: sameOpaqueValue,
    requestDiscardIfUnlinked: input.requestDiscardIfUnlinked,
  };
}

function sameOpaqueValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameOpaqueValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key)
      && sameOpaqueValue(leftRecord[key], rightRecord[key]));
}
