import type { Messages } from './messages/en';

// A locale file may translate any subset of the canonical English tree; whatever it
// omits falls back to English at resolution time. DeepPartial keeps every node
// optional while preserving the original leaf types — a translated string must stay
// a string, and an interpolation function must keep the same parameter signature
// (so a typo'd param is a compile error, not a runtime surprise).
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export type PartialMessages = DeepPartial<Messages>;

export type { Messages };
