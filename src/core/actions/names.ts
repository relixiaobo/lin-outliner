// Every static name the surface renders or searches, resolved in BOTH locales.
//
// D8: in a menu, position and icon carry meaning; in a searchable list only the
// name does. So names are part of the contract, they are reviewed as a set, and
// search matches both locales at once regardless of the active UI language —
// this user thinks in English command names and runs a Chinese interface.

import { getMessages, type Messages } from '../i18n';
import { SUPPORTED_LOCALES, type Locale } from '../locale';
import type { ActionId, LocalizedNames } from './types';

type ActionMessages = Messages['actions'];

const LOCALES: readonly Locale[] = SUPPORTED_LOCALES.map((entry) => entry.code);

/** Resolve one message across every supported locale. */
export function localizedNames(select: (messages: ActionMessages) => string): LocalizedNames {
  const result = {} as Record<Locale, string>;
  for (const locale of LOCALES) result[locale] = select(getMessages(locale).actions);
  return result;
}

/** Prefix a resolved name in every locale (the shipped batch-count prefix). */
export function withBatchPrefix(names: LocalizedNames, count: number): LocalizedNames {
  if (count <= 1) return names;
  const result = {} as Record<Locale, string>;
  for (const locale of LOCALES) {
    result[locale] = `${getMessages(locale).actions.batchPrefix({ count })}${names[locale]}`;
  }
  return result;
}

export function actionName(key: keyof ActionMessages['names']): LocalizedNames {
  return localizedNames((messages) => messages.names[key]);
}

export function objectName(key: keyof ActionMessages['objects']): LocalizedNames {
  return localizedNames((messages) => messages.objects[key]);
}

export function objectTypeLabel(key: keyof ActionMessages['objectTypes']): LocalizedNames {
  return localizedNames((messages) => messages.objectTypes[key]);
}

export function rejectionName(key: keyof ActionMessages['rejections']): LocalizedNames {
  return localizedNames((messages) => messages.rejections[key]);
}

export function confirmName(
  select: (confirm: ActionMessages['confirm']) => string,
): LocalizedNames {
  return localizedNames((messages) => select(messages.confirm));
}

export function createTagCandidateName(name: string): LocalizedNames {
  return localizedNames((messages) => messages.parameters.createTag({ name }));
}

/**
 * The family name, for surfaces that render a family header rather than one of
 * its resolved variants — the `View as` submenu parent, and the parameter
 * pickers' titles. Static, so the renderer imports it directly.
 */
export const ACTION_FAMILY_NAMES: Record<ActionId, LocalizedNames> = {
  open: actionName('open'),
  openInSplitPane: actionName('openInSplitPane'),
  setPinned: actionName('pin'),
  sendToAgent: actionName('sendToAgent'),
  duplicate: actionName('duplicate'),
  move: actionName('moveTo'),
  setDone: actionName('markDone'),
  addTag: actionName('addTag'),
  setViewMode: actionName('viewAs'),
  setViewToolbarVisible: actionName('showViewToolbar'),
  editViewSection: actionName('editFilters'),
  editDescription: actionName('editDescription'),
  copy: actionName('copyText'),
  remove: actionName('moveToTrash'),
  restore: actionName('restore'),
  deleteForever: actionName('deleteForever'),
  emptyTrash: actionName('emptyTrash'),
  capture: actionName('capture'),
  create: actionName('createNode'),
};

/** Pick the display string for a resolved name in the active locale. */
export function nameFor(names: LocalizedNames, locale: Locale): string {
  return names[locale] ?? names.en;
}
