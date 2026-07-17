import { describe, expect, test } from 'bun:test';
import {
  ManagedSkillGitHubClient,
  ManagedSkillNetworkError,
  parseGitHubUrl,
  validateGitHubTrackingRef,
} from '../../src/main/managedSkillGitHub';

describe('managed skill GitHub client', () => {
  test('accepts slash branch names and rejects unsafe Git ref forms', () => {
    expect(validateGitHubTrackingRef('feature/managed-skills')).toBe('feature/managed-skills');
    for (const ref of ['@', '.hidden', 'refs//heads/main', 'main.lock', 'release@{1}', 'trailing.']) {
      expect(() => validateGitHubTrackingRef(ref)).toThrow(ManagedSkillNetworkError);
    }
  });

  test('resolves a branch to a commit and discovers every SKILL.md folder without downloading execution bytes', async () => {
    const fixture = githubFixture();
    const client = new ManagedSkillGitHubClient({ fetchImpl: fixture.fetch });

    const discovery = await client.discover({
      sourceUrl: 'https://github.com/public/repo',
      appVersion: '0.1.0',
    });

    expect(discovery.origin).toMatchObject({
      repository: 'https://github.com/public/repo',
      trackingRef: 'main',
      commit: 'a'.repeat(40),
    });
    expect(discovery.candidates.map((candidate) => candidate.view.name)).toEqual(['alpha-skill', 'beta-skill']);
    expect(fixture.requestedRawPaths).toEqual([
      '/public/repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/alpha/SKILL.md',
      '/public/repo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/beta/SKILL.md',
    ]);

    const installed = await client.downloadCandidate({
      origin: discovery.origin,
      candidate: discovery.candidates[0]!,
      appVersion: '0.1.0',
    });
    expect(installed.name).toBe('alpha-skill');
    expect(installed.files.map((file) => file.relativePath)).toEqual(['SKILL.md', 'scripts/run.py']);
    expect(fixture.requestedRawPaths.some((requested) => requested.endsWith('/skills/alpha/scripts/run.py'))).toBe(true);
  });

  test('rejects duplicate declared names with both repository subdirectories', async () => {
    const fixture = githubFixture({ duplicateName: true });
    const client = new ManagedSkillGitHubClient({ fetchImpl: fixture.fetch });

    await expect(client.discover({
      sourceUrl: 'https://github.com/public/repo',
      appVersion: '0.1.0',
    })).rejects.toMatchObject({
      code: 'duplicate_skill_name',
      detail: 'alpha-skill @ skills/alpha | skills/beta',
    });
  });

  test('resolves slash-named tree refs while retaining the remaining subdirectory', async () => {
    const skill = skillMarkdown('alpha-skill', 'Alpha skill.');
    const commit = 'b'.repeat(40);
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(requestUrl(input));
      if (url.hostname === 'api.github.com' && url.pathname === '/repos/public/repo') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (url.hostname === 'api.github.com' && url.pathname.endsWith('/git/matching-refs/heads/feature')) {
        return jsonResponse([{ ref: 'refs/heads/feature/one', object: { type: 'commit', sha: commit } }]);
      }
      if (url.hostname === 'api.github.com' && url.pathname.endsWith('/git/matching-refs/tags/feature')) {
        return jsonResponse([]);
      }
      if (url.hostname === 'api.github.com' && url.pathname.includes('/git/trees/')) {
        return jsonResponse({ truncated: false, tree: [treeEntry('skills/alpha/SKILL.md', skill)] });
      }
      if (url.hostname === 'raw.githubusercontent.com') return bytesResponse(skill);
      return jsonResponse({ message: 'not found' }, 404);
    };
    const client = new ManagedSkillGitHubClient({ fetchImpl });

    const discovery = await client.discover({
      sourceUrl: 'https://github.com/public/repo/tree/feature/one/skills/alpha',
      appVersion: '0.1.0',
    });

    expect(discovery.origin).toMatchObject({
      trackingRef: 'feature/one',
      subdirectory: 'skills/alpha',
      commit,
    });
    expect(discovery.candidates).toHaveLength(1);
  });

  test('resolves a default-branch tree URL with a fixed API request count', async () => {
    const skill = skillMarkdown('default-skill', 'Default branch skill.');
    const commit = '9'.repeat(40);
    const requestedApiPaths: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(requestUrl(input));
      if (url.hostname === 'api.github.com') requestedApiPaths.push(url.pathname);
      if (url.hostname === 'api.github.com' && url.pathname === '/repos/public/repo') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (url.hostname === 'api.github.com' && url.pathname.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { type: 'commit', sha: commit } });
      }
      if (url.hostname === 'api.github.com' && url.pathname.endsWith(`/git/trees/${commit}`)) {
        return jsonResponse({ truncated: false, tree: [treeEntry('skills/default/SKILL.md', skill)] });
      }
      if (url.hostname === 'raw.githubusercontent.com') return bytesResponse(skill);
      return jsonResponse({ message: 'not found' }, 404);
    };
    const client = new ManagedSkillGitHubClient({ fetchImpl });

    const discovery = await client.discover({
      sourceUrl: 'https://github.com/public/repo/tree/main/skills/default',
      appVersion: '0.1.0',
    });

    expect(discovery.origin).toMatchObject({ trackingRef: 'main', subdirectory: 'skills/default', commit });
    expect(requestedApiPaths).toEqual([
      '/repos/public/repo',
      '/repos/public/repo/git/ref/heads/main',
      `/repos/public/repo/git/trees/${commit}`,
    ]);
  });

  test('resolves an annotated tag to its pinned commit', async () => {
    const skill = skillMarkdown('tagged-skill', 'Tagged skill.');
    const tagObject = 'c'.repeat(40);
    const commit = 'd'.repeat(40);
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(requestUrl(input));
      if (url.hostname === 'api.github.com' && url.pathname === '/repos/public/repo') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (url.hostname === 'api.github.com' && url.pathname.endsWith('/git/matching-refs/heads/v1.0.0')) {
        return jsonResponse([]);
      }
      if (url.hostname === 'api.github.com' && url.pathname.endsWith('/git/matching-refs/tags/v1.0.0')) {
        return jsonResponse([{ ref: 'refs/tags/v1.0.0', object: { type: 'tag', sha: tagObject } }]);
      }
      if (url.hostname === 'api.github.com' && url.pathname.endsWith(`/git/tags/${tagObject}`)) {
        return jsonResponse({ object: { type: 'commit', sha: commit } });
      }
      if (url.hostname === 'api.github.com' && url.pathname.includes('/git/trees/')) {
        return jsonResponse({ truncated: false, tree: [treeEntry('skills/tagged/SKILL.md', skill)] });
      }
      if (url.hostname === 'raw.githubusercontent.com') return bytesResponse(skill);
      return jsonResponse({ message: 'not found' }, 404);
    };
    const client = new ManagedSkillGitHubClient({ fetchImpl });

    const discovery = await client.discover({
      sourceUrl: 'https://github.com/public/repo/tree/v1.0.0/skills/tagged',
      appVersion: '0.1.0',
    });

    expect(discovery.origin).toMatchObject({ trackingRef: 'v1.0.0', commit });
  });

  test('rejects an excessive matching-ref response', async () => {
    const refs = Array.from({ length: 101 }, (_, index) => ({
      ref: `refs/heads/feature/${index}`,
      object: { type: 'commit', sha: 'a'.repeat(40) },
    }));
    const client = new ManagedSkillGitHubClient({
      fetchImpl: async (input) => {
        const url = new URL(requestUrl(input));
        if (url.pathname === '/repos/public/repo') return jsonResponse({ default_branch: 'main' });
        if (url.pathname.endsWith('/git/matching-refs/heads/feature')) return jsonResponse(refs);
        if (url.pathname.endsWith('/git/matching-refs/tags/feature')) return jsonResponse([]);
        return jsonResponse({ message: 'not found' }, 404);
      },
    });

    await expect(client.discover({
      sourceUrl: 'https://github.com/public/repo/tree/feature/one/skills/demo',
      appVersion: '0.1.0',
    })).rejects.toMatchObject({ code: 'too_many_matching_refs' });
  });

  test('verifies a full commit SHA through the bounded Git object endpoint', async () => {
    const skill = skillMarkdown('commit-skill', 'Commit skill.');
    const commit = 'e'.repeat(40);
    const requestedApiPaths: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(requestUrl(input));
      if (url.hostname === 'api.github.com') requestedApiPaths.push(url.pathname);
      if (url.hostname === 'api.github.com' && url.pathname.endsWith(`/git/commits/${commit}`)) {
        return jsonResponse({ sha: commit });
      }
      if (url.hostname === 'api.github.com' && url.pathname.includes('/git/trees/')) {
        return jsonResponse({ truncated: false, tree: [treeEntry('skills/commit/SKILL.md', skill)] });
      }
      if (url.hostname === 'raw.githubusercontent.com') return bytesResponse(skill);
      return jsonResponse({ message: 'not found' }, 404);
    };
    const client = new ManagedSkillGitHubClient({ fetchImpl });

    const discovery = await client.discover({
      sourceUrl: `https://github.com/public/repo/tree/${commit}/skills/commit`,
      appVersion: '0.1.0',
    });

    expect(discovery.origin).toMatchObject({ trackingRef: commit, commit });
    expect(requestedApiPaths).toContain(`/repos/public/repo/git/commits/${commit}`);
    expect(requestedApiPaths.some((requestPath) => requestPath.startsWith('/repos/public/repo/commits/'))).toBe(false);
  });

  test('discovers safe candidates even when another subtree has executable support files', async () => {
    const safeSkill = skillMarkdown('safe-skill', 'Safe skill.');
    const unsafeSkill = skillMarkdown('unsafe-skill', 'Unsafe skill.');
    const script = new TextEncoder().encode('print("unsafe")\n');
    const commit = 'f'.repeat(40);
    const tree = [
      treeEntry('skills/safe/SKILL.md', safeSkill),
      treeEntry('skills/unsafe/SKILL.md', unsafeSkill),
      { ...treeEntry('skills/unsafe/scripts/run.py', script), mode: '100755' },
    ];
    const raw = new Map<string, Uint8Array>([
      [`/public/repo/${commit}/skills/safe/SKILL.md`, safeSkill],
      [`/public/repo/${commit}/skills/unsafe/SKILL.md`, unsafeSkill],
      [`/public/repo/${commit}/skills/unsafe/scripts/run.py`, script],
    ]);
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(requestUrl(input));
      if (url.hostname === 'api.github.com' && url.pathname === '/repos/public/repo') {
        return jsonResponse({ default_branch: 'main' });
      }
      if (url.hostname === 'api.github.com' && url.pathname.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { type: 'commit', sha: commit } });
      }
      if (url.hostname === 'api.github.com' && url.pathname.includes('/git/trees/')) {
        return jsonResponse({ truncated: false, tree });
      }
      if (url.hostname === 'raw.githubusercontent.com') {
        const bytes = raw.get(url.pathname);
        return bytes ? bytesResponse(bytes) : jsonResponse({ message: 'not found' }, 404);
      }
      return jsonResponse({ message: 'not found' }, 404);
    };
    const client = new ManagedSkillGitHubClient({ fetchImpl });

    const discovery = await client.discover({
      sourceUrl: 'https://github.com/public/repo',
      appVersion: '0.1.0',
    });
    expect(discovery.candidates.map((candidate) => candidate.view.name)).toEqual(['safe-skill', 'unsafe-skill']);

    const installed = await client.downloadCandidate({
      origin: discovery.origin,
      candidate: discovery.candidates[0]!,
      appVersion: '0.1.0',
    });
    expect(installed.name).toBe('safe-skill');
    await expect(client.downloadCandidate({
      origin: discovery.origin,
      candidate: discovery.candidates[1]!,
      appVersion: '0.1.0',
    })).rejects.toMatchObject({ code: 'executable_file', detail: 'scripts/run.py' });
  });

  test('rejects credentials, non-GitHub hosts, cross-host redirects, and oversized responses', async () => {
    expect(() => parseGitHubUrl('https://token@github.com/owner/repo')).toThrow(ManagedSkillNetworkError);
    expect(() => parseGitHubUrl('https://gitlab.com/owner/repo')).toThrow(ManagedSkillNetworkError);

    const redirecting = new ManagedSkillGitHubClient({
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/catalog.json' } }),
    });
    await expect(redirecting.fetchJsonFromRaw(
      'https://raw.githubusercontent.com/owner/repo/main/catalog.json',
      100,
    )).rejects.toMatchObject({ code: 'invalid_github_url' });

    const oversized = new ManagedSkillGitHubClient({
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': '101' } }),
    });
    await expect(oversized.fetchJsonFromRaw(
      'https://raw.githubusercontent.com/owner/repo/main/catalog.json',
      100,
    )).rejects.toMatchObject({ code: 'github_response_too_large' });
  });

  test('applies the request timeout while reading a slow response body', async () => {
    const client = new ManagedSkillGitHubClient({
      timeoutMs: 10,
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        return new Response(new ReadableStream({
          start(controller) {
            signal?.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          },
        }), { status: 200 });
      },
    });

    await expect(client.fetchJsonFromRaw(
      'https://raw.githubusercontent.com/owner/repo/main/catalog.json',
      100,
    )).rejects.toMatchObject({ code: 'github_timeout' });
  });
});

function githubFixture(options: { duplicateName?: boolean } = {}): { fetch: typeof fetch; requestedRawPaths: string[] } {
  const alphaSkill = skillMarkdown('alpha-skill', 'Alpha managed skill.');
  const betaSkill = skillMarkdown(options.duplicateName ? 'alpha-skill' : 'beta-skill', 'Beta managed skill.');
  const script = new TextEncoder().encode('print("alpha")\n');
  const commit = 'a'.repeat(40);
  const tree = [
    treeEntry('skills/alpha/SKILL.md', alphaSkill),
    treeEntry('skills/alpha/scripts/run.py', script),
    treeEntry('skills/beta/SKILL.md', betaSkill),
  ];
  const raw = new Map<string, Uint8Array>([
    [`/public/repo/${commit}/skills/alpha/SKILL.md`, alphaSkill],
    [`/public/repo/${commit}/skills/alpha/scripts/run.py`, script],
    [`/public/repo/${commit}/skills/beta/SKILL.md`, betaSkill],
  ]);
  const requestedRawPaths: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(requestUrl(input));
    if (url.hostname === 'api.github.com' && url.pathname === '/repos/public/repo') {
      return jsonResponse({ default_branch: 'main' });
    }
    if (url.hostname === 'api.github.com' && url.pathname === '/repos/public/repo/git/ref/heads/main') {
      return jsonResponse({ object: { type: 'commit', sha: commit } });
    }
    if (url.hostname === 'api.github.com' && url.pathname === `/repos/public/repo/git/trees/${commit}`) {
      return jsonResponse({ truncated: false, tree });
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      requestedRawPaths.push(url.pathname);
      const bytes = raw.get(url.pathname);
      return bytes ? bytesResponse(bytes) : jsonResponse({ message: 'not found' }, 404);
    }
    return jsonResponse({ message: 'not found' }, 404);
  };
  return { fetch: fetchImpl, requestedRawPaths };
}

function skillMarkdown(name: string, description: string): Uint8Array {
  return new TextEncoder().encode(['---', `name: ${name}`, `description: ${description}`, '---', `# ${name}`].join('\n'));
}

function treeEntry(path: string, bytes: Uint8Array) {
  return { path, mode: '100644', type: 'blob', sha: 'c'.repeat(40), size: bytes.byteLength };
}

function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  return new Response(body, { status, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } });
}

function bytesResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}
