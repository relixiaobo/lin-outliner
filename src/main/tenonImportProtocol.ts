export const TENON_IMPORT_CAUSATION_TOKEN_ENV = 'TENON_IMPORT_CAUSATION_TOKEN';
export const TENON_IMPORT_CAUSATION_TOKEN_HEADER = 'x-tenon-import-causation-token';

export function isTenonImportCommitCommand(command: string): boolean {
  return shellCommandSegments(command).some((segment) => {
    const words = parseShellWords(segment);
    let commandIndex = 0;
    while (isEnvironmentAssignment(words[commandIndex])) commandIndex += 1;
    if (commandName(words[commandIndex]) === 'env') {
      commandIndex += 1;
      while (words[commandIndex]?.startsWith('-') || isEnvironmentAssignment(words[commandIndex])) {
        commandIndex += 1;
      }
    }
    if (commandName(words[commandIndex]) === 'command' || commandName(words[commandIndex]) === 'exec') {
      commandIndex += 1;
    }
    return commandName(words[commandIndex]) === 'tenon-import'
      && words[commandIndex + 1]?.toLowerCase() === 'commit';
  });
}

function shellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let heredocEnd: string | null = null;
  for (const line of command.split(/\r?\n/)) {
    if (heredocEnd) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (heredoc?.[1]) heredocEnd = heredoc[1];
    segments.push(...splitShellLine(line));
  }
  return segments;
}

function splitShellLine(line: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1];
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"' && next) {
        current += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s|[;&|]/.test(line[index - 1]!))) break;
    if (char === ';' || char === '|' || char === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if (next === char) index += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function parseShellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s;&|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["\\])/g, '$1'));
  }
  return words;
}

function commandName(word: string | undefined): string {
  if (!word) return '';
  return word.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
}

function isEnvironmentAssignment(word: string | undefined): boolean {
  return typeof word === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}
