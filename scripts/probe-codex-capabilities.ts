import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SUPPORTED_VERSION = 'codex-cli 0.153.4';
const MAX_BYTES = 4 * 1024 * 1024;
const CANARY = 'TENON_CODEX_SKILL_CANARY';

/** Exercises the installed CLI against a loopback fixture, never a paid provider. */
async function main(): Promise<void> {
  const executable = process.argv[2];
  if (!executable || !executable.startsWith('/')) {
    throw new Error('Usage: bun scripts/probe-codex-capabilities.ts /absolute/path/to/codex');
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-codex-capabilities-')));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const cwd = join(root, 'workspace');
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: join(root, 'tmp'),
    LANG: 'en_US.UTF-8',
  };
  const requests: { tools: string[]; skillCanary: boolean; toolResults: unknown[] }[] = [];
  const patchTarget = join(cwd, 'sandbox-canary.txt');
  let forceTools = false;
  let step = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > MAX_BYTES) throw new Error('Fixture request exceeds its limit');
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        tools?: { name?: string; type?: string }[];
        input?: { type?: string; output?: unknown }[];
      };
      requests.push({
        tools: (body.tools ?? []).map((tool) => tool.name ?? tool.type ?? 'unknown'),
        skillCanary: JSON.stringify(body.input ?? null).includes(CANARY),
        toolResults: (body.input ?? []).filter((item) => item.type?.endsWith('_call_output'))
          .map((item) => item.output),
      });
      const message: Record<string, unknown> = forceTools && step === 0 ? {
        id: `fc_${requests.length}`,
        type: 'custom_tool_call',
        call_id: `call_${requests.length}`,
        name: 'apply_patch',
        input: `*** Begin Patch\n*** Add File: ${patchTarget}\n+sandbox canary\n*** End Patch`,
      } : forceTools && step === 1 ? {
        id: `fc_${requests.length}`,
        type: 'function_call',
        call_id: `call_${requests.length}`,
        name: 'request_user_input',
        arguments: JSON.stringify({ questions: [{
          id: 'canary', header: 'Canary', question: 'Synthetic fixture question?',
          options: [
            { label: 'First', description: 'First fixture option.' },
            { label: 'Second', description: 'Second fixture option.' },
          ],
        }] }),
      } : {
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'PROBE_OK', annotations: [] }],
      };
      step += 1;
      const events = [
        { type: 'response.created', response: { id: `resp_${requests.length}`, status: 'in_progress', output: [] } },
        {
          type: 'response.output_item.added', output_index: 0,
          item: message.type === 'message' ? { ...message, status: 'in_progress', content: [] } : message,
        },
        ...(message.type === 'message' ? [
          { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'PROBE_OK' },
        ] : []),
        { type: 'response.output_item.done', output_index: 0, item: message },
        {
          type: 'response.completed',
          response: {
            id: `resp_${requests.length}`,
            status: 'completed',
            output: [message],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } catch {
      response.writeHead(400);
      response.end('Invalid fixture request');
    }
  });
  try {
    for (const directory of [codexHome, cwd, env.TMPDIR, join(home, '.agents', 'skills', 'canary')]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(home, '.agents', 'skills', 'canary', 'SKILL.md'),
      `---\nname: canary\ndescription: ${CANARY}\n---\n${CANARY}\n`);
    const version = (await execFileAsync(executable, ['--version'], {
      env, cwd, timeout: 10_000, maxBuffer: MAX_BYTES,
    })).stdout.trim();
    if (version !== SUPPORTED_VERSION) throw new Error(`Unsupported probe version: ${version}`);
    const featureOutput = (await execFileAsync(executable, ['features', 'list'], {
      env, cwd, timeout: 10_000, maxBuffer: MAX_BYTES,
    })).stdout;
    const features = featureOutput.trim().split('\n')
      .filter((line) => !/\s(removed|deprecated)\s/.test(line))
      .map((line) => line.trim().split(/\s+/)[0]);
    if (!features.includes('skip_host_skill_discovery')) throw new Error('Missing skill isolation control');
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const config = [
      'model_provider="tenon_fixture"',
      'model="gpt-5.2"',
      'model_providers.tenon_fixture.name="Tenon fixture"',
      `model_providers.tenon_fixture.base_url="http://127.0.0.1:${address.port}/v1"`,
      'model_providers.tenon_fixture.wire_api="responses"',
      'model_providers.tenon_fixture.requires_openai_auth=false',
      'model_providers.tenon_fixture.request_max_retries=0',
      'model_providers.tenon_fixture.stream_max_retries=0',
      'model_providers.tenon_fixture.supports_websockets=false',
      'approval_policy="never"',
      'web_search="disabled"',
      'history.persistence="none"',
      'shell_environment_policy.inherit="none"',
      ...features.map((feature) => `features.${feature}=${feature === 'skip_host_skill_discovery'}`),
    ];
    const common = [
      '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json',
      ...config.flatMap((value) => ['--config', value]),
    ];
    const flagsOnly = await run(executable, [
      'exec', ...common, '--sandbox', 'read-only', '--cd', cwd, '--color', 'never', '-',
    ], { env, cwd });
    const flagsOnlyRequest = requests[0];
    common.push('--config', `skills.config=[{path=${JSON.stringify(join(home, '.agents', 'skills', 'canary', 'SKILL.md'))},enabled=false}]`);
    forceTools = true;
    step = 0;
    const firstRequestIndex = requests.length;
    const first = await run(executable, [
      'exec', ...common, '--sandbox', 'read-only', '--cd', cwd, '--color', 'never', '-',
    ], { env, cwd });
    const firstCanWrite = await access(patchTarget).then(() => true, () => false);
    const started = first.events.find((event) => event.type === 'thread.started');
    const sessionId = started?.thread_id;
    step = 0;
    const second = typeof sessionId === 'string'
      ? await run(executable, [
          'exec', 'resume', ...common, '--config', 'sandbox_mode="read-only"', sessionId, '-',
        ], { env, cwd })
      : null;
    const secondCanWrite = await access(patchTarget).then(() => true, () => false);
    step = 0;
    const changedSandbox = typeof sessionId === 'string'
      ? await run(executable, [
          'exec', 'resume', ...common, '--config', 'sandbox_mode="workspace-write"', sessionId, '-',
        ], { env, cwd })
      : null;
    const changedSandboxCanWrite = await access(patchTarget).then(() => true, () => false);
    const terminal = (execution: typeof first | null) => execution?.events.find((event) => event.type === 'turn.completed');
    const continuedId = (execution: typeof first | null) => execution?.events.find((event) => event.type === 'thread.started')?.thread_id;
    const closedRequests = requests.slice(firstRequestIndex);
    const checks = {
      flagsOnlyRetainsSkill: flagsOnlyRequest?.skillCanary === true,
      explicitSkillFileDisableWorks: closedRequests.length > 0 && closedRequests.every((request) => !request.skillCanary),
      expectedToolCatalog: requests.length === 10 && requests.every((request) => (
        request.tools.join(',') === 'request_user_input,apply_patch'
      )),
      readOnlyBlocksWrite: !firstCanWrite && !secondCanWrite
        && first.stderr.includes('writing is blocked by read-only sandbox')
        && second?.stderr.includes('writing is blocked by read-only sandbox') === true,
      nonInteractiveRejectsQuestion: [first, second, changedSandbox].every((execution) => (
        execution?.stderr.includes('request_user_input is unavailable in Default mode')
      )),
      resumeConfigCanChangeSandbox: changedSandboxCanWrite,
      exactSessionResume: typeof sessionId === 'string'
        && continuedId(second) === sessionId && continuedId(changedSandbox) === sessionId,
      terminalSuccess: [flagsOnly, first, second, changedSandbox].every((execution) => (
        execution?.code === 0 && terminal(execution) !== undefined
      )),
      cumulativeUsage: [first, second, changedSandbox].every((execution, index) => {
        const usage = terminal(execution)?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        return usage?.input_tokens === (index + 1) * 30 && usage?.output_tokens === (index + 1) * 6;
      }),
    };
    console.log(JSON.stringify({
      version,
      checks,
      flagsOnly,
      flagsOnlyRequest,
      first,
      firstCanWrite,
      second,
      secondCanWrite,
      changedSandbox,
      changedSandboxCanWrite,
      requests,
      disabledFeatureCount: features.length - 1,
      realUserCredentialsSupplied: false,
      paidProviderRequests: 0,
    }, null, 2));
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failed.length > 0) throw new Error(`Capability probe failed: ${failed.join(', ')}`);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((accept) => server.close(() => accept()));
    await rm(root, { recursive: true, force: true });
  }
}

function run(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<{ code: number | null; events: Record<string, unknown>[]; stderr: string }> {
  return new Promise((accept, reject) => {
    const child = spawn(resolve(executable), args, { ...options, stdio: 'pipe', shell: false });
    const output: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const capture = (target: Buffer[], bytes: Buffer) => {
      size += bytes.byteLength;
      if (size > MAX_BYTES) child.kill('SIGKILL');
      else target.push(bytes);
    };
    child.stdout.on('data', (bytes: Buffer) => capture(output, bytes));
    child.stderr.on('data', (bytes: Buffer) => capture(diagnostics, bytes));
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      try {
        const text = Buffer.concat(output).toString('utf8').trim();
        accept({
          code,
          events: text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : [],
          stderr: Buffer.concat(diagnostics).toString('utf8').slice(0, 12_000),
        });
      } catch (error) { reject(error); }
    });
    child.stdin.end('Return PROBE_OK.');
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
