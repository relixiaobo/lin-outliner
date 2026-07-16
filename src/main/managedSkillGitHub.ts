import { createHash } from 'node:crypto';
import type { ManagedSkillDiscoveryCandidateView } from '../core/types';
import {
  MANAGED_SKILL_LIMITS,
  ManagedSkillValidationError,
  normalizeRepositorySubdirectory,
  parseManagedSkillFrontmatter,
  selectManagedSkillEntries,
  validateManagedSkillFiles,
  type ManagedSkillFile,
  type ManagedSkillSelectedEntry,
  type ManagedSkillTreeEntry,
  type ValidatedManagedSkill,
} from './managedSkillValidation';

const GITHUB_HOST = 'github.com';
const GITHUB_API_HOST = 'api.github.com';
const GITHUB_RAW_HOST = 'raw.githubusercontent.com';
const API_JSON_LIMIT = 512 * 1024;
const MAX_REDIRECTS = 2;
const MAX_TREE_URL_PARTS = 20;
const MAX_TAG_PEELS = 4;
const DOWNLOAD_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 12_000;

export type ManagedSkillNetworkErrorCode =
  | 'invalid_github_url'
  | 'unsupported_github_url'
  | 'github_not_found'
  | 'github_rate_limited'
  | 'github_unavailable'
  | 'github_response_too_large'
  | 'github_invalid_response'
  | 'github_redirect_rejected'
  | 'github_timeout'
  | 'github_tree_truncated'
  | 'too_many_tree_entries'
  | 'too_many_skill_candidates'
  | 'duplicate_skill_name';

export class ManagedSkillNetworkError extends Error {
  constructor(
    readonly code: ManagedSkillNetworkErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ManagedSkillNetworkError';
  }
}

export interface ManagedSkillGitHubOrigin {
  owner: string;
  repo: string;
  repository: string;
  subdirectory: string;
  trackingRef: string;
  commit: string;
}

export interface ManagedSkillGitHubCandidate {
  view: ManagedSkillDiscoveryCandidateView;
  repositoryTree: readonly ManagedSkillTreeEntry[];
}

export interface ManagedSkillGitHubDiscovery {
  origin: ManagedSkillGitHubOrigin;
  candidates: ManagedSkillGitHubCandidate[];
}

interface GitHubRepositoryResponse {
  default_branch?: unknown;
}

interface GitHubCommitObjectResponse {
  sha?: unknown;
}

interface GitHubRefResponse {
  object?: unknown;
}

interface GitHubTagResponse {
  object?: unknown;
}

interface GitHubObjectReference {
  type: 'commit' | 'tag';
  sha: string;
}

interface GitHubTreeResponse {
  truncated?: unknown;
  tree?: unknown;
}

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  tail: string[];
  kind: 'repository' | 'tree' | 'blob';
}

export interface ManagedSkillGitHubClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ManagedSkillGitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ManagedSkillGitHubClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async discover(input: {
    sourceUrl: string;
    appVersion: string;
    trackingRef?: string;
    subdirectory?: string;
    catalogCompatibilityRange?: string;
  }): Promise<ManagedSkillGitHubDiscovery> {
    const parsed = parseGitHubUrl(input.sourceUrl);
    const resolved = await this.resolveSource(parsed, input.trackingRef, input.subdirectory);
    const tree = await this.readTree(resolved.owner, resolved.repo, resolved.commit);
    const scope = resolved.subdirectory;
    const candidateDirectories = candidateDirectoriesFromTree(tree, scope);
    if (candidateDirectories.length === 0) {
      throw new ManagedSkillValidationError('missing_skill_file', `No SKILL.md was found under ${scope || resolved.repository}.`);
    }
    if (candidateDirectories.length > MANAGED_SKILL_LIMITS.candidateCount) {
      throw new ManagedSkillNetworkError('too_many_skill_candidates', `The repository contains more than ${MANAGED_SKILL_LIMITS.candidateCount} candidate skills.`);
    }

    const candidates: ManagedSkillGitHubCandidate[] = [];
    for (const subdirectory of candidateDirectories) {
      const skillEntries = selectManagedSkillEntries(
        tree.filter((entry) => entry.path === `${subdirectory ? `${subdirectory}/` : ''}SKILL.md`),
        subdirectory,
      );
      const skillEntry = skillEntries.find((entry) => entry.relativePath === 'SKILL.md');
      if (!skillEntry) throw new ManagedSkillValidationError('missing_skill_file', `No SKILL.md exists directly under ${subdirectory || 'the repository root'}.`);
      const skillBytes = await this.readRawFile(resolved.owner, resolved.repo, resolved.commit, skillEntry);
      const skillContent = decodeUtf8(skillBytes, skillEntry.path);
      const summary = parseManagedSkillFrontmatter({
        skillContent,
        selectedDirectoryName: subdirectory || resolved.repo,
        appVersion: input.appVersion,
        catalogCompatibilityRange: input.catalogCompatibilityRange,
      });
      candidates.push({
        view: {
          id: candidateId(subdirectory),
          name: summary.name,
          description: summary.description,
          subdirectory,
          ...(summary.version ? { version: summary.version } : {}),
          compatibility: summary.compatibility,
          scripts: candidateScriptPaths(tree, subdirectory),
        },
        repositoryTree: tree,
      });
    }
    rejectDuplicateCandidateNames(candidates);
    return {
      origin: resolved,
      candidates: candidates.sort((left, right) => left.view.subdirectory.localeCompare(right.view.subdirectory)),
    };
  }

  async downloadCandidate(input: {
    origin: ManagedSkillGitHubOrigin;
    candidate: ManagedSkillGitHubCandidate;
    appVersion: string;
    catalogCompatibilityRange?: string;
  }): Promise<ValidatedManagedSkill> {
    const entries = selectManagedSkillEntries(input.candidate.repositoryTree, input.candidate.view.subdirectory);
    const files: ManagedSkillFile[] = [];
    for (let index = 0; index < entries.length; index += DOWNLOAD_CONCURRENCY) {
      const batch = entries.slice(index, index + DOWNLOAD_CONCURRENCY);
      const downloaded = await Promise.all(batch.map(async (entry): Promise<ManagedSkillFile> => ({
        relativePath: entry.relativePath,
        bytes: await this.readRawFile(input.origin.owner, input.origin.repo, input.origin.commit, entry),
      })));
      files.push(...downloaded);
    }
    return validateManagedSkillFiles({
      files,
      selectedDirectoryName: input.candidate.view.subdirectory || input.origin.repo,
      appVersion: input.appVersion,
      catalogCompatibilityRange: input.catalogCompatibilityRange,
    });
  }

  async resolveTrackingCommit(origin: Pick<ManagedSkillGitHubOrigin, 'owner' | 'repo' | 'trackingRef'>): Promise<string> {
    return this.resolveCommit(origin.owner, origin.repo, origin.trackingRef);
  }

  async fetchJsonFromRaw(url: string, maxBytes: number): Promise<unknown> {
    const parsed = validateHttpsUrl(url, new Set([GITHUB_RAW_HOST]));
    const bytes = await this.fetchBytes(parsed, maxBytes, new Set([GITHUB_RAW_HOST]));
    try {
      return JSON.parse(TEXT_DECODER.decode(bytes));
    } catch (error) {
      throw new ManagedSkillNetworkError('github_invalid_response', `GitHub returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  private async resolveSource(
    parsed: ParsedGitHubUrl,
    trackingRefOverride?: string,
    subdirectoryOverride?: string,
  ): Promise<ManagedSkillGitHubOrigin> {
    const repository = `https://${GITHUB_HOST}/${parsed.owner}/${parsed.repo}`;
    if (trackingRefOverride?.trim()) {
      const trackingRef = validateGitHubTrackingRef(trackingRefOverride);
      const commit = await this.resolveCommit(parsed.owner, parsed.repo, trackingRef);
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        repository,
        subdirectory: normalizeRepositorySubdirectory(subdirectoryOverride ?? ''),
        trackingRef,
        commit,
      };
    }
    if (parsed.kind === 'repository') {
      const response = await this.apiJson(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`) as GitHubRepositoryResponse;
      const trackingRef = typeof response.default_branch === 'string' ? validateGitHubTrackingRef(response.default_branch) : '';
      if (!trackingRef) throw new ManagedSkillNetworkError('github_invalid_response', 'GitHub did not return a default branch for this repository.');
      const commit = await this.resolveCommit(parsed.owner, parsed.repo, trackingRef);
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        repository,
        subdirectory: normalizeRepositorySubdirectory(subdirectoryOverride ?? ''),
        trackingRef,
        commit,
      };
    }
    if (parsed.tail.length === 0 || parsed.tail.length > MAX_TREE_URL_PARTS) {
      throw new ManagedSkillNetworkError('unsupported_github_url', 'GitHub tree URLs must include a bounded branch, tag, or commit path.');
    }
    const boundary = await this.resolveTreeRefBoundary(parsed.owner, parsed.repo, parsed.tail);
    let subdirectory = parsed.tail.slice(boundary.parts).join('/');
    if (parsed.kind === 'blob') {
      if (parsed.tail.at(-1) !== 'SKILL.md') {
        throw new ManagedSkillNetworkError('unsupported_github_url', 'Only GitHub blob URLs ending in SKILL.md are accepted.');
      }
      subdirectory = subdirectory.split('/').slice(0, -1).join('/');
    }
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      repository,
      subdirectory: normalizeRepositorySubdirectory(subdirectoryOverride ?? subdirectory),
      trackingRef: boundary.ref,
      commit: boundary.commit,
    };
  }

  private async resolveTreeRefBoundary(
    owner: string,
    repo: string,
    tail: readonly string[],
  ): Promise<{ parts: number; ref: string; commit: string }> {
    if (/^[0-9a-f]{40}$/i.test(tail[0] ?? '')) {
      const ref = (tail[0] ?? '').toLowerCase();
      return { parts: 1, ref, commit: await this.resolveCommit(owner, repo, ref) };
    }
    for (let parts = tail.length; parts >= 1; parts -= 1) {
      const ref = tail.slice(0, parts).join('/');
      const commit = await this.tryResolveCommit(owner, repo, ref);
      if (commit) return { parts, ref, commit };
    }
    throw new ManagedSkillNetworkError('github_not_found', 'The branch, tag, or commit in this GitHub URL could not be resolved.');
  }

  private async resolveCommit(owner: string, repo: string, ref: string): Promise<string> {
    const commit = await this.tryResolveCommit(owner, repo, ref);
    if (!commit) throw new ManagedSkillNetworkError('github_not_found', `GitHub ref "${ref}" was not found.`);
    return commit;
  }

  private async tryResolveCommit(owner: string, repo: string, ref: string): Promise<string | null> {
    if (/^[0-9a-f]{40}$/i.test(ref)) return this.readCommitObject(owner, repo, ref);

    const branch = await this.tryReadRef(owner, repo, 'heads', ref);
    if (branch) return this.peelToCommit(owner, repo, branch);
    const tag = await this.tryReadRef(owner, repo, 'tags', ref);
    return tag ? this.peelToCommit(owner, repo, tag) : null;
  }

  private async readCommitObject(owner: string, repo: string, sha: string): Promise<string> {
    const response = await this.apiJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${sha.toLowerCase()}`,
    ) as GitHubCommitObjectResponse;
    return parseCommitSha(response.sha, 'GitHub returned an invalid commit object.');
  }

  private async tryReadRef(
    owner: string,
    repo: string,
    namespace: 'heads' | 'tags',
    ref: string,
  ): Promise<GitHubObjectReference | null> {
    try {
      const response = await this.apiJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${namespace}/${encodeRefPath(ref)}`,
      ) as GitHubRefResponse;
      return parseGitHubObjectReference(response.object, `GitHub returned an invalid ${namespace === 'heads' ? 'branch' : 'tag'} ref.`);
    } catch (error) {
      if (error instanceof ManagedSkillNetworkError && error.code === 'github_not_found') return null;
      throw error;
    }
  }

  private async peelToCommit(
    owner: string,
    repo: string,
    initial: GitHubObjectReference,
  ): Promise<string> {
    let object = initial;
    const visited = new Set<string>();
    for (let depth = 0; depth <= MAX_TAG_PEELS; depth += 1) {
      if (object.type === 'commit') return object.sha;
      if (visited.has(object.sha) || depth === MAX_TAG_PEELS) {
        throw new ManagedSkillNetworkError('github_invalid_response', 'GitHub tag indirection is cyclic or too deep.');
      }
      visited.add(object.sha);
      const response = await this.apiJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/tags/${object.sha}`,
      ) as GitHubTagResponse;
      object = parseGitHubObjectReference(response.object, 'GitHub returned an invalid annotated tag object.');
    }
    throw new ManagedSkillNetworkError('github_invalid_response', 'GitHub tag did not resolve to a commit.');
  }

  private async readTree(owner: string, repo: string, commit: string): Promise<ManagedSkillTreeEntry[]> {
    const response = await this.apiJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${commit}?recursive=1`,
      MANAGED_SKILL_LIMITS.treeBytes,
    ) as GitHubTreeResponse;
    if (response.truncated === true) {
      throw new ManagedSkillNetworkError('github_tree_truncated', 'The GitHub tree is too large to validate safely.');
    }
    if (!Array.isArray(response.tree)) {
      throw new ManagedSkillNetworkError('github_invalid_response', 'GitHub returned an invalid repository tree.');
    }
    if (response.tree.length > MANAGED_SKILL_LIMITS.treeEntries) {
      throw new ManagedSkillNetworkError('too_many_tree_entries', `The repository exceeds the ${MANAGED_SKILL_LIMITS.treeEntries}-entry discovery limit.`);
    }
    return response.tree.map(parseTreeEntry);
  }

  private async readRawFile(
    owner: string,
    repo: string,
    commit: string,
    entry: Pick<ManagedSkillSelectedEntry, 'path' | 'size'>,
  ): Promise<Uint8Array> {
    const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`https://${GITHUB_RAW_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commit}/${encodedPath}`);
    const bytes = await this.fetchBytes(url, MANAGED_SKILL_LIMITS.fileBytes, new Set([GITHUB_RAW_HOST]));
    if (bytes.byteLength !== entry.size) {
      throw new ManagedSkillNetworkError('github_invalid_response', `GitHub returned an unexpected byte length for ${entry.path}.`, entry.path);
    }
    return bytes;
  }

  private async apiJson(pathname: string, maxBytes = API_JSON_LIMIT): Promise<unknown> {
    const url = new URL(`https://${GITHUB_API_HOST}${pathname}`);
    const bytes = await this.fetchBytes(url, maxBytes, new Set([GITHUB_API_HOST]), {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    try {
      return JSON.parse(TEXT_DECODER.decode(bytes));
    } catch (error) {
      throw new ManagedSkillNetworkError('github_invalid_response', `GitHub returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  private async fetchBytes(
    initialUrl: URL,
    maxBytes: number,
    acceptedHosts: ReadonlySet<string>,
    headers: Record<string, string> = {},
  ): Promise<Uint8Array> {
    let url = initialUrl;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      validateHttpsUrl(url.toString(), acceptedHosts);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': 'Tenon-Managed-Skills', ...headers },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirect === MAX_REDIRECTS) {
            throw new ManagedSkillNetworkError('github_redirect_rejected', 'GitHub returned too many or invalid redirects.');
          }
          url = validateHttpsUrl(new URL(location, url).toString(), acceptedHosts);
          continue;
        }
        if (!response.ok) throw githubStatusError(response, url);
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          throw new ManagedSkillNetworkError('github_response_too_large', `GitHub response exceeds the ${maxBytes}-byte limit.`);
        }
        return await readBoundedBody(response, maxBytes);
      } catch (error) {
        if (error instanceof ManagedSkillNetworkError) throw error;
        if (controller.signal.aborted) {
          throw new ManagedSkillNetworkError('github_timeout', `GitHub did not respond within ${this.timeoutMs} ms.`);
        }
        throw new ManagedSkillNetworkError('github_unavailable', `GitHub request failed: ${error instanceof Error ? error.message : String(error)}.`);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new ManagedSkillNetworkError('github_redirect_rejected', 'GitHub redirect policy rejected the request.');
  }
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

export function parseGitHubUrl(input: string): ParsedGitHubUrl {
  const url = validateHttpsUrl(input, new Set([GITHUB_HOST]));
  if (url.search || url.hash) {
    throw new ManagedSkillNetworkError('invalid_github_url', 'GitHub skill URLs cannot contain query parameters or fragments.');
  }
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new ManagedSkillNetworkError('invalid_github_url', 'GitHub URL contains invalid path encoding.');
    }
  });
  if (segments.length < 2) {
    throw new ManagedSkillNetworkError('invalid_github_url', 'Use a public GitHub repository or tree URL.');
  }
  const owner = segments[0] ?? '';
  const repo = (segments[1] ?? '').replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new ManagedSkillNetworkError('invalid_github_url', 'GitHub owner or repository name is invalid.');
  }
  if (segments.length === 2) return { owner, repo, kind: 'repository', tail: [] };
  const kind = segments[2];
  if ((kind !== 'tree' && kind !== 'blob') || segments.length < 4) {
    throw new ManagedSkillNetworkError('unsupported_github_url', 'Only GitHub repository, tree, or SKILL.md blob URLs are supported.');
  }
  return { owner, repo, kind, tail: segments.slice(3) };
}

function validateHttpsUrl(input: string, acceptedHosts: ReadonlySet<string>): URL {
  if (input.length > 2_048) throw new ManagedSkillNetworkError('invalid_github_url', 'GitHub URL is too long.');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ManagedSkillNetworkError('invalid_github_url', 'Enter a complete public GitHub HTTPS URL.');
  }
  if (
    url.protocol !== 'https:'
    || !acceptedHosts.has(url.hostname.toLowerCase())
    || url.username
    || url.password
    || url.port
  ) {
    throw new ManagedSkillNetworkError('invalid_github_url', `Only HTTPS requests to ${[...acceptedHosts].join(', ')} are allowed.`);
  }
  return url;
}

export function validateGitHubTrackingRef(input: string): string {
  const ref = input.trim();
  const components = ref.split('/');
  if (
    !ref
    || ref.length > 255
    || ref === '@'
    || ref.startsWith('/')
    || ref.endsWith('/')
    || ref.endsWith('.')
    || ref.includes('..')
    || ref.includes('//')
    || ref.includes('@{')
    || /[\0-\x20~^:?*[\\]/.test(ref)
    || components.some((component) => component.startsWith('.') || component.endsWith('.lock'))
  ) {
    throw new ManagedSkillNetworkError('invalid_github_url', `Invalid Git tracking ref "${input}".`);
  }
  return ref;
}

function encodeRefPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function parseCommitSha(value: unknown, message: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new ManagedSkillNetworkError('github_invalid_response', message);
  }
  return value.toLowerCase();
}

function parseGitHubObjectReference(value: unknown, message: string): GitHubObjectReference {
  if (!isRecord(value) || (value.type !== 'commit' && value.type !== 'tag')) {
    throw new ManagedSkillNetworkError('github_invalid_response', message);
  }
  return { type: value.type, sha: parseCommitSha(value.sha, message) };
}

function candidateDirectoriesFromTree(tree: readonly ManagedSkillTreeEntry[], scope: string): string[] {
  const normalizedScope = normalizeRepositorySubdirectory(scope);
  const prefix = normalizedScope ? `${normalizedScope}/` : '';
  const candidates = new Set<string>();
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (entry.path !== 'SKILL.md' && !entry.path.endsWith('/SKILL.md')) continue;
    if (normalizedScope && entry.path !== `${normalizedScope}/SKILL.md` && !entry.path.startsWith(prefix)) continue;
    candidates.add(entry.path === 'SKILL.md' ? '' : entry.path.slice(0, -'/SKILL.md'.length));
  }
  return [...candidates].sort();
}

function candidateScriptPaths(
  tree: readonly ManagedSkillTreeEntry[],
  subdirectoryInput: string,
): string[] {
  const subdirectory = normalizeRepositorySubdirectory(subdirectoryInput);
  const prefix = subdirectory ? `${subdirectory}/` : '';
  const scripts: string[] = [];
  for (const entry of tree) {
    if (subdirectory && !entry.path.startsWith(prefix)) continue;
    const relativePath = subdirectory ? entry.path.slice(prefix.length) : entry.path;
    if (
      relativePath
      && entry.type === 'blob'
      && /\.(?:bash|cjs|js|mjs|py|sh|ts|zsh)$/i.test(relativePath)
    ) {
      scripts.push(relativePath);
      if (scripts.length >= MANAGED_SKILL_LIMITS.fileCount) break;
    }
  }
  return scripts;
}

function candidateId(subdirectory: string): string {
  return createHash('sha256').update(subdirectory || '.').digest('hex').slice(0, 20);
}

function rejectDuplicateCandidateNames(candidates: readonly ManagedSkillGitHubCandidate[]): void {
  const byName = new Map<string, string>();
  for (const candidate of candidates) {
    const previous = byName.get(candidate.view.name);
    if (previous !== undefined) {
      throw new ManagedSkillNetworkError(
        'duplicate_skill_name',
        `Repository candidates ${previous || '(root)'} and ${candidate.view.subdirectory || '(root)'} both declare skill name "${candidate.view.name}".`,
        candidate.view.name,
      );
    }
    byName.set(candidate.view.name, candidate.view.subdirectory);
  }
}

function parseTreeEntry(value: unknown): ManagedSkillTreeEntry {
  if (!isRecord(value)) throw new ManagedSkillNetworkError('github_invalid_response', 'GitHub tree contains an invalid entry.');
  const entry: ManagedSkillTreeEntry = {
    path: typeof value.path === 'string' ? value.path : '',
    mode: typeof value.mode === 'string' ? value.mode : '',
    type: typeof value.type === 'string' ? value.type : '',
    sha: typeof value.sha === 'string' ? value.sha : '',
    ...(typeof value.size === 'number' ? { size: value.size } : {}),
  };
  if (!entry.path || !/^[0-9a-f]{40}$/i.test(entry.sha)) {
    throw new ManagedSkillNetworkError('github_invalid_response', 'GitHub tree contains an invalid path or object SHA.');
  }
  return entry;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ManagedSkillNetworkError('github_response_too_large', `GitHub response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function githubStatusError(response: Response, url: URL): ManagedSkillNetworkError {
  if (response.status === 404 || response.status === 422) {
    return new ManagedSkillNetworkError('github_not_found', `GitHub resource was not found: ${url.pathname}`);
  }
  if (response.status === 403 || response.status === 429) {
    const reset = response.headers.get('x-ratelimit-reset');
    const suffix = reset && /^\d+$/.test(reset)
      ? ` Try again after ${new Date(Number(reset) * 1_000).toLocaleTimeString()}.`
      : '';
    return new ManagedSkillNetworkError('github_rate_limited', `GitHub rate limit reached.${suffix}`);
  }
  return new ManagedSkillNetworkError('github_unavailable', `GitHub request failed with HTTP ${response.status}.`);
}

function decodeUtf8(bytes: Uint8Array, relativePath: string): string {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    throw new ManagedSkillValidationError('invalid_text', `Managed SKILL.md must be valid UTF-8: ${relativePath}`, relativePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
