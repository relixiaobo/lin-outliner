/** Read-only Git queries must not opt into repository-provided executables. */
export const GIT_INSPECTION_ARGS = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
export const GIT_FILTER_CONFIG_ARGS = ['config', '--null', '--get-regexp', '^filter\\..*\\.(clean|process)$'];

export function assertNoExecutableGitFilters(output: string): void {
  // `git config --null --get-regexp` separates the key/value with a newline
  // and records with NUL. Values can themselves contain newlines.
  if (output.split('\0').some((entry) => entry.slice(entry.indexOf('\n') + 1).trim())) {
    throw new Error('Executable Git filters are configured; use ordinary Bash for this repository');
  }
}
