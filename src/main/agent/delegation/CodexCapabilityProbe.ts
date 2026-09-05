import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const CANARY = 'TENON_CODEX_SKILL_CANARY';
const REQUIRED_FEATURES = ['skip_host_skill_discovery', 'multi_agent', 'hooks', 'apps', 'browser_use', 'computer_use'];

export interface CodexCapabilityProbeResult {
  readonly ok: boolean;
  readonly diagnostic: string;
}

/** Proves the supported CLI controls against a local Responses fixture without credentials. */
export async function runCodexCapabilityProbe(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<CodexCapabilityProbeResult> {
  // Codex canonicalizes its project root before enforcing workspace boundaries.
  // Resolve the temporary directory first so fixture paths use the same spelling
  // on macOS, where the system temp path commonly has a /var -> /private/var link.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-codex-readiness-')));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const cwd = join(root, 'workspace');
  const tmp = join(root, 'tmp');
  const patchTarget = join(cwd, 'sandbox-canary.txt');
  const probeEnv: NodeJS.ProcessEnv = {
    HOME: home,
    CODEX_HOME: codexHome,
    PATH: env.PATH,
    TMPDIR: tmp,
    LANG: env.LANG ?? 'en_US.UTF-8',
  };
  let step = 0;
  let forceTools = false;
  const requests: Array<{ tools: string[]; skillCanary: boolean }> = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > MAX_BYTES) throw new Error('fixture request too large');
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        tools?: Array<{ name?: string; type?: string }>;
        input?: Array<{ type?: string; output?: unknown }>;
      };
      requests.push({
        tools: (body.tools ?? []).map((tool) => tool.name ?? tool.type ?? 'unknown'),
        skillCanary: JSON.stringify(body.input ?? null).includes(CANARY),
      });
      const message = forceTools && step === 0
        ? { type: 'custom_tool_call', id: `patch_${requests.length}`, call_id: `patch_call_${requests.length}`, name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${patchTarget}\n+canary\n*** End Patch` }
        : forceTools && step === 1
          ? { type: 'function_call', id: `question_${requests.length}`, call_id: `question_call_${requests.length}`, name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'canary', header: 'Canary', question: 'Fixture?', options: [{ label: 'A', description: 'A' }] }] }) }
          : { type: 'message', id: `message_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PROBE_OK', annotations: [] }] };
      step += 1;
      const events = [
        { type: 'response.created', response: { id: `response_${step}`, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: message },
        ...(message.type === 'message' ? [{ type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'PROBE_OK' }] : []),
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: { id: `response_${step}`, status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } catch {
      response.writeHead(400);
      response.end('invalid fixture request');
    }
  });
  try {
    await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(tmp, { recursive: true }), mkdir(join(home, '.agents', 'skills', 'canary'), { recursive: true })]);
    await writeFile(join(home, '.agents', 'skills', 'canary', 'SKILL.md'), `---\nname: canary\ndescription: ${CANARY}\n---\n${CANARY}\n`);
    const featureList = await runProcess(executable, ['features', 'list'], { cwd, env: probeEnv });
    const features = featureList.stdout.trim().split('\n')
      .filter((line) => !/\s(removed|deprecated)\s/.test(line))
      .map((line) => line.trim().split(/\s+/)[0]);
    if (featureList.code !== 0 || REQUIRED_FEATURES.some((feature) => !features.includes(feature))) {
      return { ok: false, diagnostic: 'Codex capability probe cannot establish the required control set.' };
    }
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') return { ok: false, diagnostic: 'Codex capability probe fixture failed to bind.' };
    const config = [
      '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json',
      '--config', 'model_provider="tenon_fixture"', '--config', 'model="gpt-5.2"',
      '--config', 'model_providers.tenon_fixture.name="Tenon fixture"',
      '--config', `model_providers.tenon_fixture.base_url="http://127.0.0.1:${address.port}/v1"`,
      '--config', 'model_providers.tenon_fixture.wire_api="responses"', '--config', 'model_providers.tenon_fixture.requires_openai_auth=false',
      '--config', 'approval_policy="never"', '--config', 'web_search="disabled"', '--config', 'history.persistence="none"',
      '--config', 'shell_environment_policy.inherit="none"',
      ...features.flatMap((feature) => ['--config', `features.${feature}=${feature === 'skip_host_skill_discovery'}`]),
      '--config', `skills.config=[{path=${JSON.stringify(join(home, '.agents', 'skills', 'canary', 'SKILL.md'))},enabled=false}]`,
    ];
    // Prime the CLI's skill discovery path once, then prove the explicit
    // canonical SKILL.md disablement on fresh and resumed Turns.
    await runProcess(executable, ['exec', ...config.slice(0, -2), '--sandbox', 'read-only', '--cd', cwd, '--color', 'never', '-'], { cwd, env: probeEnv });
    requests.length = 0;
    forceTools = true;
    step = 0;
    const first = await runProcess(executable, ['exec', ...config, '--sandbox', 'read-only', '--cd', cwd, '--color', 'never', '-'], { cwd, env: probeEnv });
    const firstId = first.threadId;
    const resumeConfig = config;
    const second = firstId ? await runProcess(executable, ['exec', 'resume', ...resumeConfig, '--config', 'sandbox_mode="read-only"', firstId, '-'], { cwd, env: probeEnv }) : null;
    const readOnlyCanWrite = await access(patchTarget).then(() => true, () => false);
    step = 0;
    const writable = firstId ? await runProcess(executable, ['exec', 'resume', ...resumeConfig, '--config', 'sandbox_mode="workspace-write"', firstId, '-'], { cwd, env: probeEnv }) : null;
    const closedRequests = requests;
    const expectedTools = closedRequests.length > 0 && closedRequests.every((request) => request.tools.join(',') === 'request_user_input,apply_patch');
    const skillClosed = closedRequests.length > 0 && closedRequests.every((request) => !request.skillCanary);
    const workspaceWriteCanWrite = await access(patchTarget).then(() => true, () => false);
    const readOnlyClosed = !readOnlyCanWrite && (first.stderr + (second?.stderr ?? '')).includes('writing is blocked by read-only sandbox');
    const questionClosed = [first, second, writable].some((execution) => execution?.stderr.includes('request_user_input is unavailable in Default mode'));
    const resumeStable = Boolean(firstId && second?.threadId === firstId && writable?.threadId === firstId);
    const terminalEvents = [first, second, writable].every((execution) => (
      execution?.eventTypes.includes('response.completed') || execution?.eventTypes.includes('turn.completed')
    ));
    if (first.code !== 0 || second?.code !== 0 || writable?.code !== 0 || !expectedTools || !skillClosed || !readOnlyClosed || !workspaceWriteCanWrite || !questionClosed || !resumeStable || !terminalEvents) {
      return { ok: false, diagnostic: `Codex capability probe failed (exit=${first.code}/${second?.code}/${writable?.code}, requests=${requests.length}, tools=${requests.map((request) => request.tools.join(',')).join('|')}, skill=${skillClosed}, readOnly=${readOnlyClosed}, workspaceWrite=${workspaceWriteCanWrite}, question=${questionClosed}, resume=${resumeStable}, terminal=${terminalEvents}, events=${[first, second, writable].map((execution) => execution?.eventTypes.join(',')).join('|')}, stderr=${[first, second, writable].map((execution) => execution?.stderr.slice(0, 120)).join('|')}).` };
    }
    return { ok: true, diagnostic: '' };
  } catch (error) {
    return { ok: false, diagnostic: `Codex capability probe failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((accept) => server.close(() => accept()));
    await rm(root, { recursive: true, force: true });
  }
}

function runProcess(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string; threadId: string | null; eventTypes: string[] }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(resolve(executable), args, { ...options, shell: false, stdio: 'pipe' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString('utf8');
      const events = output.split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      });
      const started = events.find((event) => event.type === 'thread.started');
      resolveProcess({ code, stdout: output, stderr: Buffer.concat(stderr).toString('utf8'), threadId: typeof started?.thread_id === 'string' ? started.thread_id : null, eventTypes: events.flatMap((event) => typeof event.type === 'string' ? [event.type] : []) });
    });
    child.stdin.end('Return PROBE_OK.');
  });
}
