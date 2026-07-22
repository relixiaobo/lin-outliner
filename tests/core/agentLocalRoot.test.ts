import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  AGENT_SCRATCH_DIR,
  AGENT_WORKDIR_DIR,
  hasExplicitAgentLocalRoot,
  resolveAgentScratchRoot,
  resolveAgentWorkdir,
} from '../../src/main/agent/capabilities/agentLocalRoot';

const FS_ROOT = path.parse(process.cwd()).root;

describe('agent workdir resolution', () => {
  test('default workdir is a dedicated userData directory in both dev and packaged', () => {
    const userDataPath = path.join(FS_ROOT, 'Users', 'tester', 'Library', 'Application Support', 'Tenon');

    const resolved = resolveAgentWorkdir({ envLocalRoot: undefined, userDataPath });

    expect(resolved).toBe(path.join(userDataPath, AGENT_WORKDIR_DIR));
    // Never the process cwd — that is the source of stray agent files in dev clones.
    expect(resolved).not.toBe(path.resolve(process.cwd()));
  });

  test('explicit environment root wins and is the opt-in to point at a real directory', () => {
    const envRoot = path.join(FS_ROOT, 'tmp', 'lin-agent-root');
    const userDataPath = path.join(FS_ROOT, 'userdata');

    expect(resolveAgentWorkdir({ envLocalRoot: `  ${envRoot}  `, userDataPath })).toBe(path.resolve(envRoot));
  });

  test('blank environment root is treated as unset and falls back to the default workdir', () => {
    expect(hasExplicitAgentLocalRoot('')).toBe(false);
    expect(hasExplicitAgentLocalRoot('   ')).toBe(false);

    const userDataPath = path.join(FS_ROOT, 'userdata');
    expect(resolveAgentWorkdir({ envLocalRoot: '   ', userDataPath })).toBe(path.join(userDataPath, AGENT_WORKDIR_DIR));
  });
});

describe('agent scratch resolution', () => {
  test('scratch is always an app-owned userData sibling, independent of the workdir', () => {
    const userDataPath = path.join(FS_ROOT, 'userdata');
    const scratch = resolveAgentScratchRoot({ userDataPath });

    expect(scratch).toBe(path.join(userDataPath, AGENT_SCRATCH_DIR));
    // Even when the workdir is an env-pointed repo, scratch stays under userData so the repo
    // never accumulates ephemeral files.
    const workdir = resolveAgentWorkdir({ envLocalRoot: path.join(FS_ROOT, 'repo'), userDataPath });
    expect(scratch.startsWith(workdir)).toBe(false);
  });
});
