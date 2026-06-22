export const INLINE_CHAT_SOURCE_ICON_CLASS = 'inline-ref-chat-icon';
export const INLINE_CHAT_SOURCE_LABEL_CLASS = 'inline-ref-chat-label';

export function inlineChatSourceDomChildren(
  label: string,
): Array<[string, Record<string, string>] | [string, Record<string, string>, string]> {
  return [
    ['span', { class: INLINE_CHAT_SOURCE_ICON_CLASS, 'aria-hidden': 'true' }],
    ['span', { class: INLINE_CHAT_SOURCE_LABEL_CLASS }, label],
  ];
}
