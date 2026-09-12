import { scheduleInputSchema } from './schemas';
export const SCHEDULE_PROTOCOL_VERSION = 1;
export const SCHEDULE_COMMANDS = {
  list: { target: false, mutation: false, summary: 'List saved assignments.' },
  show: { target: true, mutation: false, summary: 'Read one saved assignment and its timing.' },
  create: { target: false, mutation: true, summary: 'Save one assignment and its time plan.' },
  update: { target: true, mutation: true, summary: 'Save a deliberate revision of an assignment.' },
  pause: { target: true, mutation: true, summary: 'Pause future automatic work.' },
  resume: { target: true, mutation: true, summary: 'Schedule future occurrences from now.' },
  run: { target: true, mutation: true, summary: 'Request a manual invocation without changing timing.' },
  skip: { target: true, mutation: true, summary: 'Skip the exact unresolved one-off time.' },
  stop: { target: true, mutation: true, summary: 'Stop the addressed run through its execution owner.' },
  acknowledge: { target: true, mutation: true, summary: 'Acknowledge the addressed terminal issue.' },
  archive: { target: true, mutation: true, summary: 'Archive after active owned work settles.' },
  restore: { target: true, mutation: true, summary: 'Restore with timing paused.' },
  runs: { target: true, mutation: false, summary: 'Page canonical run associations.' },
  processes: { target: true, mutation: false, summary: 'Inspect the run-owned background processes.' },
  result: { target: true, mutation: false, summary: 'Read the actual result and canonical record reference.' },
} as const;
export type ScheduleOperation = keyof typeof SCHEDULE_COMMANDS;
export interface ScheduleCommand {
  readonly name: 'schedule';
  readonly operation: ScheduleOperation;
  readonly target?: string;
  readonly before?: string;
  readonly output: 'json';
}
export function scheduleArgv(command: ScheduleCommand): readonly string[] {
  return [command.operation, ...(command.target ? [command.target] : []),
    ...(command.before ? ['--before', command.before] : []),
    ...(SCHEDULE_COMMANDS[command.operation].mutation ? ['--input', '-'] : []), '--output', 'json'];
}
export function parseScheduleCommand(args: readonly string[]): ScheduleCommand {
  const operation = args[0] as ScheduleOperation;
  const spec = SCHEDULE_COMMANDS[operation];
  if (!Object.hasOwn(SCHEDULE_COMMANDS, operation)) throw new Error('Unknown schedule command; use schedule schema for the public contract.');
  let position = 1;
  const target = spec.target ? args[position++] : undefined;
  if (spec.target && (!target || !/^[0-9a-f-]{36}$/i.test(target))) throw new Error('A task or run UUID is required.');
  const before = args[position] === '--before' ? args[position + 1] : undefined;
  if (before !== undefined) {
    if (!['runs', 'list'].includes(operation) || !/^[0-9a-f-]{36}$/i.test(before)) throw new Error('Only list and runs accept a valid --before cursor.');
    position += 2;
  }
  const command: ScheduleCommand = { name: 'schedule', operation, ...(target ? { target } : {}), ...(before ? { before } : {}), output: 'json' };
  if (JSON.stringify(scheduleArgv(command)) !== JSON.stringify(args)) throw new Error(`Use: schedule ${scheduleArgv(command).join(' ')}`);
  return command;
}
export function decodeScheduleCommand(value: unknown): ScheduleCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid schedule command');
  const row = value as ScheduleCommand;
  if (row.name !== 'schedule' || row.output !== 'json' || !Object.hasOwn(SCHEDULE_COMMANDS, row.operation)
    || Object.keys(row).some((key) => !['name', 'operation', 'target', 'before', 'output'].includes(key))) throw new Error('Invalid schedule command');
  return parseScheduleCommand(scheduleArgv(row));
}
export function scheduleSchema() {
  return { version: SCHEDULE_PROTOCOL_VERSION, executable: 'schedule',
    commands: Object.fromEntries(Object.entries(SCHEDULE_COMMANDS).map(([operation, spec]) => [operation, {
      ...spec, inputSchema: scheduleInputSchema(operation as ScheduleOperation),
    }])),
    source: 'Receipts distinguish saved definitions, requested execution and canonical outcomes. Read complete output through the returned canonical record reference.',
  };
}
