import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  PACKAGED_AGENT_LOCAL_ROOT_DIR,
  hasExplicitAgentLocalRoot,
  resolveAgentLocalFileRoot,
} from '../../src/main/agentLocalRoot';

describe('agent local root resolution', () => {
  test('packaged fallback uses a dedicated userData directory instead of cwd', () => {
    const userDataPath = path.join(path.parse(process.cwd()).root, 'Users', 'tester', 'Library', 'Application Support', 'Tenon');
    const resolved = resolveAgentLocalFileRoot({
      envLocalRoot: undefined,
      cwd: path.parse(process.cwd()).root,
      isPackaged: true,
      userDataPath,
    });

    expect(resolved).toBe(path.join(userDataPath, PACKAGED_AGENT_LOCAL_ROOT_DIR));
    expect(resolved).not.toBe(path.parse(process.cwd()).root);
  });

  test('explicit environment root wins in packaged and development runs', () => {
    const envRoot = path.join(path.parse(process.cwd()).root, 'tmp', 'lin-agent-root');
    const input = {
      envLocalRoot: `  ${envRoot}  `,
      cwd: path.join(path.parse(process.cwd()).root, 'repo'),
      userDataPath: path.join(path.parse(process.cwd()).root, 'userdata'),
    };

    expect(resolveAgentLocalFileRoot({ ...input, isPackaged: true })).toBe(path.resolve(envRoot));
    expect(resolveAgentLocalFileRoot({ ...input, isPackaged: false })).toBe(path.resolve(envRoot));
  });

  test('development fallback remains the current working directory', () => {
    const cwd = path.join(path.parse(process.cwd()).root, 'Users', 'tester', 'Coding', 'lin-outliner-codex');

    expect(resolveAgentLocalFileRoot({
      envLocalRoot: undefined,
      cwd,
      isPackaged: false,
      userDataPath: path.join(path.parse(process.cwd()).root, 'userdata'),
    })).toBe(path.resolve(cwd));
  });

  test('blank environment root is treated as unset', () => {
    expect(hasExplicitAgentLocalRoot('')).toBe(false);
    expect(hasExplicitAgentLocalRoot('   ')).toBe(false);

    const userDataPath = path.join(path.parse(process.cwd()).root, 'userdata');
    expect(resolveAgentLocalFileRoot({
      envLocalRoot: '   ',
      cwd: path.parse(process.cwd()).root,
      isPackaged: true,
      userDataPath,
    })).toBe(path.join(userDataPath, PACKAGED_AGENT_LOCAL_ROOT_DIR));
  });
});
