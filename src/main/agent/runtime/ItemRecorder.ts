import { decodeThreadItem } from '../../../core/agent/codec';
import type {
  AgentCoreNotification,
  ItemExecutionStatus,
  ItemProvenance,
  ThreadId,
  ThreadItem,
  ThreadItemDelta,
  TurnId,
} from '../../../core/agent/protocol';
import { uuidV7 } from '../uuid';

type NotificationWriter = (notification: AgentCoreNotification) => Promise<void>;

export class ItemRecorder {
  private readonly items = new Map<string, ThreadItem>();
  private readonly order: string[] = [];

  constructor(
    readonly threadId: ThreadId,
    readonly turnId: TurnId,
    initialItems: readonly ThreadItem[],
    private readonly writeNotification: NotificationWriter,
  ) {
    for (const item of initialItems) this.putInitial(item);
  }

  createItemId(): string {
    return uuidV7();
  }

  localProvenance(itemId: string): ItemProvenance {
    return {
      originThreadId: this.threadId,
      originTurnId: this.turnId,
      originItemId: itemId,
    };
  }

  async started(itemInput: ThreadItem, startedAt = Date.now()): Promise<ThreadItem> {
    const item = decodeThreadItem(itemInput);
    this.assertLocalEnvelope(item);
    if (this.items.has(item.id)) throw new Error(`Thread Item already exists: ${item.id}`);
    this.items.set(item.id, item);
    this.order.push(item.id);
    await this.writeNotification({
      type: 'item/started',
      threadId: this.threadId,
      turnId: this.turnId,
      itemId: item.id,
      item,
      startedAt,
    });
    return item;
  }

  async delta(itemId: string, delta: ThreadItemDelta): Promise<void> {
    if (!this.items.has(itemId)) throw new Error(`Thread Item not found: ${itemId}`);
    await this.writeNotification({
      type: 'item/delta',
      threadId: this.threadId,
      turnId: this.turnId,
      itemId,
      delta,
    });
  }

  async completed(itemInput: ThreadItem, completedAt = Date.now()): Promise<ThreadItem> {
    const item = decodeThreadItem(itemInput);
    this.assertLocalEnvelope(item);
    if (!this.items.has(item.id)) throw new Error(`Thread Item was not started: ${item.id}`);
    this.items.set(item.id, item);
    await this.writeNotification({
      type: 'item/completed',
      threadId: this.threadId,
      turnId: this.turnId,
      itemId: item.id,
      item,
      completedAt,
    });
    return item;
  }

  async completedImmediately(item: ThreadItem, at = Date.now()): Promise<ThreadItem> {
    await this.started(item, at);
    return this.completed(item, at);
  }

  async completeInitial(itemId: string, completedAt = Date.now()): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Initial Thread Item not found: ${itemId}`);
    await this.writeNotification({
      type: 'item/completed',
      threadId: this.threadId,
      turnId: this.turnId,
      itemId,
      item,
      completedAt,
    });
  }

  item(itemId: string): ThreadItem | null {
    return this.items.get(itemId) ?? null;
  }

  orderedItems(): readonly ThreadItem[] {
    return this.order.map((itemId) => this.items.get(itemId)!);
  }

  async finishInProgressItems(status: Extract<ItemExecutionStatus, 'failed' | 'interrupted'>): Promise<void> {
    for (const itemId of this.order) {
      const item = this.items.get(itemId)!;
      if (!hasExecutionStatus(item) || item.status !== 'inProgress') continue;
      const terminal = decodeThreadItem({ ...item, status });
      await this.completed(terminal);
    }
  }

  private putInitial(itemInput: ThreadItem): void {
    const item = decodeThreadItem(itemInput);
    this.assertLocalEnvelope(item);
    if (this.items.has(item.id)) throw new Error(`Duplicate initial Thread Item: ${item.id}`);
    this.items.set(item.id, item);
    this.order.push(item.id);
  }

  private assertLocalEnvelope(item: ThreadItem): void {
    if (item.provenance.originItemId === item.id) {
      if (
        item.provenance.originThreadId !== this.threadId
        || item.provenance.originTurnId !== this.turnId
      ) {
        throw new Error('Locally originated Item provenance must match its active Turn');
      }
    }
  }
}

function hasExecutionStatus(
  item: ThreadItem,
): item is Extract<ThreadItem, { status: ItemExecutionStatus }> {
  return 'status' in item;
}
