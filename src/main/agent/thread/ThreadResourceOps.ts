import { constants } from 'node:fs';
import { copyFile,lstat,realpath,rm,stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { decodeTurn } from '../../../core/agent/codec';
import { modelCallArgumentSource } from '../../../core/agent/modelCallHistory';
import type {
Thread,
ThreadAttachmentContent,
ThreadContextPayloadReference,
ThreadInternalTextPayloadReference,
ThreadContextReadRequest,
ThreadContextReadResponse,
ThreadId,
ThreadItem,
ThreadItemOutputReadRequest,
ThreadItemOutputReadResponse,
ThreadItemOutputReference,
ThreadItemArgumentsReadRequest,
ThreadItemArgumentsReadResponse,
ThreadImageArtifactReference,
ThreadResourceReference,
ThreadTurnDetailsReadRequest,
ThreadTurnDetailsReadResponse,
ThreadUserContent,
Turn,
TurnDiagnosticsPayloadReference,
} from '../../../core/agent/protocol';
import {
createManagedAttachmentObservation,
isPathInside,
type ManagedAttachmentObservation,
} from '../capabilities/agentAttachmentMaterialization';
import {
assertContextPayloadDependencies,
itemContextPayloadReferences,
itemInternalTextPayloadReferences,
itemResourceReferences,
resourceReferenceKey,
scanThreadItemResourceUsage,
} from '../context/contextDependencies';
import { assertCanonicalUserContent } from '../context/userContentIntegrity';
import type { AgentResourceStore } from '../persistence/AgentResourceStore';
import { parseReferenceMarkers } from '../../../core/referenceMarkup';
import type {
ResolvedThreadAttachmentFile,
ResolvedThreadImageArtifactFile,
ResolvedThreadResourceFile,
ThreadUserContentResolutionContext,
} from '../ThreadService';
import { projectLargeTextArgumentsForDisplay } from '../runtime/largeTextArguments';
import { ThreadCore } from './ThreadCore';

export interface ThreadStorageReferences {
  readonly resources: readonly ThreadResourceReference[];
  readonly contexts: readonly ThreadContextPayloadReference[];
  readonly internalTexts: readonly ThreadInternalTextPayloadReference[];
  readonly diagnostics: readonly TurnDiagnosticsPayloadReference[];
  readonly textOutputs: readonly ThreadItemOutputReference[];
}

export interface HistoricalResourceSelection {
  readonly ref: ThreadResourceReference;
  readonly path: string | null;
  readonly entryKind: 'file' | 'directory';
}

export class ThreadResourceOps {
  private readonly detachedResourceObservations = new Map<string, {
    readonly observation: ManagedAttachmentObservation;
    readonly path: Promise<string | null>;
  }>();
  constructor(
    private readonly core: ThreadCore,
    private readonly resources: AgentResourceStore,
    private readonly attachmentScratchRoot: string,
    private readonly resolveUserContent: (
      content: readonly ThreadUserContent[],
      context: ThreadUserContentResolutionContext,
    ) => readonly ThreadUserContent[] | Promise<readonly ThreadUserContent[]>,
  ) {}
  async readItemOutput(request: ThreadItemOutputReadRequest): Promise<ThreadItemOutputReadResponse> {
    const turn = this.core.readTurn(request.threadId, request.turnId);
    if (!turn) return { output: null };
    const item = turn.items.find((candidate) => candidate.id === request.itemId);
    if (!item || !('outputRef' in item) || !item.outputRef || item.outputRef.id !== request.outputId) {
      return { output: null };
    }
    const text = await this.core.payloads.readTextReference(request.threadId, item.outputRef);
    if (text === null) return { output: null };
    return { output: { ref: item.outputRef, text } };
  }
  async readContextPayload(request: ThreadContextReadRequest): Promise<ThreadContextReadResponse> {
    const turn = this.core.readTurn(request.threadId, request.turnId);
    if (!turn) return { context: null };
    const item = turn.items.find((candidate) => candidate.id === request.itemId);
    if (!item) return { context: null };
    if (item.type === 'contextEvidence') {
      if (item.payloadRef.id !== request.contextId) return { context: null };
      const payload = await this.core.payloads.readContext(request.threadId, item.payloadRef);
      if (!payload) return { context: null };
      assertContextPayloadDependencies(item, payload);
      return { context: { ref: item.payloadRef, payload } };
    }
    return { context: null };
  }
  async readItemArguments(request: ThreadItemArgumentsReadRequest): Promise<ThreadItemArgumentsReadResponse> {
    const turn = this.core.readTurn(request.threadId, request.turnId);
    const item = turn?.items.find((candidate) => candidate.id === request.itemId);
    if (!item || !('modelCall' in item) || item.modelCall.disposition === 'evidenceOnly') {
      return { arguments: null };
    }
    const source = modelCallArgumentSource(item.modelCall);
    if (source.storage === 'inline') return { arguments: source.value };
    const payload = await this.core.payloads.readContext(request.threadId, source.ref).catch(() => null);
    if (!payload || payload.kind !== 'toolCallArguments') return { arguments: null };
    const value = await projectLargeTextArgumentsForDisplay(
      payload,
      source.internalTextRefs,
      (ref, maxPrefixChars) => this.core.payloads.readInternalTextProjection(
        request.threadId,
        ref,
        maxPrefixChars,
      ),
    );
    return { arguments: value };
  }
  async readTurnDetails(request: ThreadTurnDetailsReadRequest): Promise<ThreadTurnDetailsReadResponse> {
    const thread = this.core.requireThread(request.threadId).thread;
    const turn = this.core.readTurn(request.threadId, request.turnId);
    if (!turn) throw new Error(`Unknown Turn: ${request.turnId}`);
    const ref = turn.execution.diagnosticsRef;
    if (!ref) return { thread, turn, diagnostics: null };
    const payload = await this.core.payloads.readTurnDiagnostics(request.threadId, ref).catch(() => null);
    if (!payload) {
      return {
        thread,
        turn: decodeTurn({ ...turn, execution: { ...turn.execution, diagnosticsRef: null } }),
        diagnostics: null,
      };
    }
    return { thread, turn, diagnostics: { ref, payload } };
  }
  async beginAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly expectedBytes: number;
    readonly mimeType: string;
    readonly fileName: string;
  }): Promise<string> {
    this.core.requireThread(input.threadId);
    return this.resources.beginUpload(input);
  }
  async appendAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly uploadId: string;
    readonly bytes: Uint8Array;
  }): Promise<void> {
    this.core.requireThread(input.threadId);
    await this.resources.appendUpload(
      input.threadId,
      input.attachmentId,
      input.uploadId,
      input.bytes,
    );
  }
  async finishAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly uploadId: string;
  }): Promise<ThreadResourceReference> {
    this.core.requireThread(input.threadId);
    return this.resources.finishUpload(input.threadId, input.attachmentId, input.uploadId);
  }
  async abortAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly uploadId: string;
  }): Promise<void> {
    await this.resources.abortUpload(input.threadId, input.attachmentId, input.uploadId);
  }
  async writeThreadResource(
    threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<ThreadResourceReference> {
    this.core.requireThread(threadId);
    return (await this.resources.writeBytes(threadId, bytes, mimeType, fileName)).ref;
  }
  async writeThreadResourceWithStatus(
    threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<{ readonly ref: ThreadResourceReference; readonly created: boolean }> {
    this.core.requireThread(threadId);
    return this.resources.writeBytes(threadId, bytes, mimeType, fileName);
  }

  async captureThreadResourcePath(
    threadId: ThreadId,
    sourcePath: string,
    mimeType: string,
    fileName: string,
  ): Promise<ThreadResourceReference> {
    this.core.requireThread(threadId);
    return (await this.resources.capturePath({
      threadId,
      sourcePath,
      mimeType,
      fileName,
    })).ref;
  }

  async useThreadResourcePath<T>(
    threadId: ThreadId,
    ref: ThreadResourceReference,
    use: (path: string) => Promise<T>,
  ): Promise<T | null> {
    this.core.requireThread(threadId);
    return this.resources.useExactPath(ref, use);
  }
  async readThreadResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<Buffer | null> {
    this.core.requireThread(threadId);
    if (!this.resources.hasThreadLink(threadId, ref)) return null;
    return this.resources.readExact(ref);
  }
  async readReferencedThreadResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<Buffer | null> {
    this.core.requireThread(threadId);
    if (!this.threadResourceReferences(threadId).some((candidate) => (
      resourceReferenceKey(candidate) === resourceReferenceKey(ref)
    ))) {
      return null;
    }
    return this.resources.readExact(ref);
  }
  linkHistoricalResource(
    currentThreadId: ThreadId,
    historicalThreadId: ThreadId,
    ref: ThreadResourceReference,
  ): boolean {
    this.core.requireThread(currentThreadId);
    this.core.requireThread(historicalThreadId);
    if (!this.threadResourceReferences(historicalThreadId).some((candidate) => (
      resourceReferenceKey(candidate) === resourceReferenceKey(ref)
    ))) return false;
    return this.resources.linkReference(currentThreadId, ref);
  }
  async selectHistoricalResource(
    currentThreadId: ThreadId,
    historicalThreadId: ThreadId,
    ref: ThreadResourceReference,
    representation: 'reveal' | 'replay' | 'edit' | 'observe',
  ): Promise<HistoricalResourceSelection | null> {
    const current = this.core.requireThread(currentThreadId).thread;
    this.core.requireThread(historicalThreadId);
    if (!this.threadResourceReferences(historicalThreadId).some((candidate) => (
      resourceReferenceKey(candidate) === resourceReferenceKey(ref)
    ))) return null;

    if (representation === 'reveal') {
      const source = await this.resources.resolve(ref, 'revealSource');
      if (source.status !== 'resolvedSource' || !this.resources.linkReference(currentThreadId, ref)) return null;
      return { ref, path: source.path, entryKind: source.entryKind };
    }
    if (representation !== 'edit') {
      const exact = await this.resources.resolve(ref, 'observeExactRevision');
      if (exact.status !== 'resolvedExactRevision' || !this.resources.linkReference(currentThreadId, ref)) return null;
      return { ref, path: null, entryKind: 'file' };
    }

    const source = await this.resources.resolve(ref, 'editSource');
    const scope = this.resources.sourceScope(ref);
    if (
      source.status === 'resolvedSource'
      && scope
      && (scope.kind === 'external' || isPathInside(current.cwd, source.path))
      && this.resources.linkReference(currentThreadId, ref)
    ) {
      return { ref, path: source.path, entryKind: source.entryKind };
    }

    const exact = await this.resources.resolve(ref, 'observeExactRevision');
    if (exact.status !== 'resolvedExactRevision') return null;
    const destination = await copyHistoricalExactRevision(exact.path, current.cwd, ref.fileName);
    const scopeId = `execution:${currentThreadId}`;
    this.resources.registerScope({
      scopeId,
      kind: current.parentThreadId ? 'managedWorktree' : 'managedWorkspace',
      rootPath: current.cwd,
      editable: true,
    });
    try {
      const sourceLocator = await this.resources.sourceLocator(scopeId, destination, 'file');
      const copied = await this.resources.capturePath({
        threadId: currentThreadId,
        sourcePath: destination,
        mimeType: ref.mimeType,
        fileName: basename(destination),
        source: sourceLocator,
      });
      return { ref: copied.ref, path: destination, entryKind: 'file' };
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  async discardUnreferencedThreadResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<boolean> {
    return this.core.threadMutex.run(threadId, async () => {
      this.core.requireThread(threadId);
      if (this.threadResourceReferences(threadId).some((candidate) => (
        resourceReferenceKey(candidate) === resourceReferenceKey(ref)
      ))) {
        return false;
      }
      return this.resources.discardThreadReference(threadId, ref);
    });
  }
  async resolveAttachmentFile(
    threadId: ThreadId,
    attachmentId: string,
  ): Promise<ResolvedThreadAttachmentFile | null> {
    this.core.requireThread(threadId);
    const matches = this.core.allTurns(threadId).flatMap((turn) => turn.items.flatMap((item) => (
      item.type === 'userMessage'
        ? item.content.flatMap((content) => (
            content.type === 'attachment' && content.id === attachmentId ? [content] : []
          ))
        : []
    )));
    if (matches.length === 0) return null;
    const attachment = matches[0]!;
    if (matches.some((candidate) => !attachmentSourcesEqual(candidate, attachment))) return null;
    const detachedIdentity = attachment.artifactRef
      ? `attachment-image:${attachmentId}`
      : `attachment:${attachmentId}`;
    const storedPath = attachment.artifactRef
      ? await this.detachedImageArtifactObservationPath(threadId, detachedIdentity, attachment.artifactRef)
      : attachment.source.kind === 'localFile'
        ? attachment.source.path
        : await this.detachedResourceObservationPath(threadId, detachedIdentity, attachment.source.ref);
    if (!storedPath) return null;
    const detached = !!attachment.artifactRef || attachment.source.kind === 'resource';
    if (detached) {
      const storedStats = await lstat(storedPath).catch(() => null);
      if (!storedStats?.isFile() || storedStats.isSymbolicLink() || storedStats.nlink !== 1) {
        await this.discardDetachedResourceObservation(threadId, detachedIdentity);
        return null;
      }
    }
    const canonicalPath = await realpath(storedPath).catch(() => null);
    if (!canonicalPath) {
      if (detached) await this.discardDetachedResourceObservation(threadId, detachedIdentity);
      return null;
    }
    if (detached && canonicalPath !== storedPath) {
      await this.discardDetachedResourceObservation(threadId, detachedIdentity);
      return null;
    }
    if (!attachment.artifactRef && attachment.source.kind === 'localFile' && canonicalPath !== attachment.source.path) {
      return null;
    }
    const fileStats = await stat(canonicalPath).catch(() => null);
    const entryKind = fileStats?.isFile() ? 'file' : fileStats?.isDirectory() ? 'directory' : null;
    if (!fileStats || !entryKind) {
      if (detached) await this.discardDetachedResourceObservation(threadId, detachedIdentity);
      return null;
    }
    // Detached copies remain available to Preview/Open/Reveal until scratch cleanup.
    return { attachment, entryKind, path: canonicalPath, stats: fileStats };
  }
  async resolveImageArtifactFile(
    threadId: ThreadId,
    artifact: ThreadImageArtifactReference,
  ): Promise<ResolvedThreadImageArtifactFile | null> {
    this.core.requireThread(threadId);
    const matches = (await this.threadImageArtifactReferences(threadId))
      .filter((candidate) => candidate.id === artifact.id);
    const canonical = matches[0];
    if (!canonical || matches.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(canonical))) return null;
    const identity = `image-artifact:${canonical.id}`;
    const storedPath = await this.detachedImageArtifactObservationPath(threadId, identity, canonical);
    if (!storedPath) return null;
    const storedStats = await lstat(storedPath).catch(() => null);
    if (!storedStats?.isFile() || storedStats.isSymbolicLink() || storedStats.nlink !== 1) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    const canonicalPath = await realpath(storedPath).catch(() => null);
    if (!canonicalPath || canonicalPath !== storedPath) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    return { artifact: canonical, entryKind: 'file', path: canonicalPath, stats: storedStats };
  }
  async resolveThreadResourceFile(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<ResolvedThreadResourceFile | null> {
    this.core.requireThread(threadId);
    if (!this.threadResourceReferences(threadId).some((candidate) => (
      resourceReferenceKey(candidate) === resourceReferenceKey(ref)
    ))) {
      return null;
    }
    const identity = `resource:${ref.id}:${ref.fileName}`;
    const storedPath = await this.detachedResourceObservationPath(threadId, identity, ref);
    if (!storedPath) return null;
    const storedStats = await lstat(storedPath).catch(() => null);
    if (!storedStats?.isFile() || storedStats.isSymbolicLink() || storedStats.nlink !== 1) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    const canonicalPath = await realpath(storedPath).catch(() => null);
    if (!canonicalPath || canonicalPath !== storedPath) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    const fileStats = await stat(canonicalPath).catch(() => null);
    if (!fileStats?.isFile()) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    return { entryKind: 'file', path: canonicalPath, stats: fileStats, ref };
  }
  async resolveThreadResourceSource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<ResolvedThreadResourceFile | null> {
    this.core.requireThread(threadId);
    if (!this.resources.hasThreadLink(threadId, ref)) return null;
    const resolution = await this.resources.resolve(ref, 'revealSource');
    if (resolution.status !== 'resolvedSource') return null;
    const fileStats = await stat(resolution.path).catch(() => null);
    if (!fileStats) return null;
    return {
      entryKind: resolution.entryKind,
      path: resolution.path,
      stats: fileStats,
      ref,
    };
  }

  private async detachedResourceObservationPath(
    threadId: ThreadId,
    identity: string,
    ref: ThreadResourceReference,
  ): Promise<string | null> {
    const available = await this.resources.useExactPath(ref, async () => true);
    if (!available) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    const key = `${threadId}\0${identity}`;
    let entry = this.detachedResourceObservations.get(key);
    if (!entry) {
      const observation = this.createResourceObservation(threadId);
      entry = { observation, path: observation.resolvePath(ref) };
      this.detachedResourceObservations.set(key, entry);
    }
    try {
      const path = await entry.path;
      if (!path && this.detachedResourceObservations.get(key) === entry) {
        this.detachedResourceObservations.delete(key);
        await entry.observation.dispose();
      }
      return path;
    } catch (error) {
      if (this.detachedResourceObservations.get(key) === entry) {
        this.detachedResourceObservations.delete(key);
        await entry.observation.dispose();
      }
      throw error;
    }
  }

  private async detachedImageArtifactObservationPath(
    threadId: ThreadId,
    identity: string,
    artifact: ThreadImageArtifactReference,
  ): Promise<string | null> {
    const key = `${threadId}\0${identity}`;
    let entry = this.detachedResourceObservations.get(key);
    if (!entry) {
      const observation = this.createResourceObservation(threadId);
      entry = { observation, path: observation.resolveArtifactPath(artifact) };
      this.detachedResourceObservations.set(key, entry);
    }
    try {
      const resolved = await entry.path;
      if (!resolved && this.detachedResourceObservations.get(key) === entry) {
        this.detachedResourceObservations.delete(key);
        await entry.observation.dispose();
      }
      return resolved;
    } catch (error) {
      if (this.detachedResourceObservations.get(key) === entry) {
        this.detachedResourceObservations.delete(key);
        await entry.observation.dispose();
      }
      throw error;
    }
  }

  private async discardDetachedResourceObservation(
    threadId: ThreadId,
    identity: string,
  ): Promise<void> {
    const key = `${threadId}\0${identity}`;
    const entry = this.detachedResourceObservations.get(key);
    if (!entry) return;
    this.detachedResourceObservations.delete(key);
    await entry.observation.dispose();
  }
  createResourceObservation(
    threadId: ThreadId,
    stableProviderPath = false,
  ): ManagedAttachmentObservation {
    return createManagedAttachmentObservation(
      this.attachmentScratchRoot,
      (ref, targetDirectory) => this.resources.copyForObservation(ref, targetDirectory),
      stableProviderPath ? { stableWorkspaceKey: threadId } : {},
    );
  }
  threadStorageReferences(threadId: ThreadId): ThreadStorageReferences {
    const turns = this.core.allTurns(threadId);
    return {
      resources: resourceReferencesFromTurns(turns),
      contexts: contextReferencesFromTurns(turns),
      internalTexts: internalTextReferencesFromTurns(turns),
      diagnostics: diagnosticsReferencesFromTurns(turns),
      textOutputs: textOutputReferencesFromTurns(turns),
    };
  }
  threadResourceReferences(threadId: ThreadId): ThreadResourceReference[] {
    return resourceReferencesFromTurns(this.core.allTurns(threadId));
  }
  async bindFinalCitations(thread: Thread, item: ThreadItem): Promise<ThreadItem> {
    const scopeId = `execution:${thread.id}`;
    this.resources.registerScope({
      scopeId,
      kind: thread.parentThreadId ? 'managedWorktree' : 'managedWorkspace',
      rootPath: thread.cwd,
      editable: thread.parentThreadId === null,
    });
    if (
      item.type !== 'agentMessage'
      || !item.text
      || (item.phase !== 'final_answer' && item.phase !== null)
    ) return item;
      const markers = parseReferenceMarkers(item.text, ['file']);
      const finalCitations: NonNullable<typeof item.finalCitations>[number][] = [];
      for (const [ordinal, marker] of markers.entries()) {
        if (marker.target.kind !== 'local-file') continue;
        try {
          const fileStat = await lstat(marker.target.path);
          const expectedKind = fileStat.isFile() ? 'file' : fileStat.isDirectory() ? 'directory' : null;
          if (!expectedKind) throw new Error('unsupportedKind');
          const source = await this.resources.sourceLocator(scopeId, marker.target.path, expectedKind);
          if (expectedKind === 'directory') {
            const ref = this.resources.createSourceReference({
              threadId: thread.id,
              displayName: basename(marker.target.path),
              source,
            });
            this.resources.recordCitation({
              threadId: thread.id,
              itemId: item.id,
              markerOrdinal: ordinal,
              ref,
              status: 'available',
              reason: 'sourceOnly',
            });
            finalCitations.push({
              markerOrdinal: ordinal,
              status: 'available',
              entryKind: 'directory',
              resourceRef: ref,
              openIntent: 'source',
              sourceAvailable: true,
              reason: 'sourceOnly',
            });
            continue;
          }
          const written = await this.resources.capturePath({
            threadId: thread.id,
            sourcePath: marker.target.path,
            mimeType: 'application/octet-stream',
            fileName: basename(marker.target.path),
            source,
          });
          this.resources.recordCitation({
            threadId: thread.id,
            itemId: item.id,
            markerOrdinal: ordinal,
            ref: written.ref,
            status: 'available',
          });
          finalCitations.push({
            markerOrdinal: ordinal,
            status: 'available',
            entryKind: 'file',
            resourceRef: written.ref,
            openIntent: 'delivered',
            sourceAvailable: true,
            reason: null,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unavailable';
          this.resources.recordCitation({
            threadId: thread.id,
            itemId: item.id,
            markerOrdinal: ordinal,
            ref: null,
            status: 'unavailable',
            reason,
          });
          finalCitations.push({
            markerOrdinal: ordinal,
            status: 'unavailable',
            entryKind: null,
            resourceRef: null,
            openIntent: null,
            sourceAvailable: false,
            reason,
          });
        }
      }
    return { ...item, finalCitations: Object.freeze(finalCitations) };
  }
  async threadImageArtifactReferences(threadId: ThreadId): Promise<readonly ThreadImageArtifactReference[]> {
    return (await this.scanResourceUsage(
      threadId,
      this.core.allTurns(threadId).flatMap((turn) => turn.items),
    )).artifacts;
  }
  threadContextPayloadReferences(threadId: ThreadId): ThreadContextPayloadReference[] {
    return contextReferencesFromTurns(this.core.allTurns(threadId));
  }
  threadInternalTextPayloadReferences(threadId: ThreadId): ThreadInternalTextPayloadReference[] {
    return internalTextReferencesFromTurns(this.core.allTurns(threadId));
  }
  threadTurnDiagnosticsReferences(threadId: ThreadId): TurnDiagnosticsPayloadReference[] {
    return diagnosticsReferencesFromTurns(this.core.allTurns(threadId));
  }
  threadTextPayloadReferences(threadId: ThreadId): ThreadItemOutputReference[] {
    return textOutputReferencesFromTurns(this.core.allTurns(threadId));
  }
  async resolveAdmissionContent(
    content: readonly ThreadUserContent[],
    thread: Thread,
  ): Promise<{
    readonly content: readonly ThreadUserContent[];
    readonly createdResources: readonly ThreadResourceReference[];
  }> {
    const createdResources: ThreadResourceReference[] = [];
    try {
      const resolved = await this.resolveUserContent(content, {
        threadId: thread.id,
        cwd: thread.cwd,
        recordCreatedResource: (ref) => createdResources.push(ref),
      });
      assertCanonicalUserContent(resolved);
      return { content: resolved, createdResources };
    } catch (error) {
      await this.discardUnreferencedCreatedResources(thread.id, createdResources);
      throw error;
    }
  }
  async discardUnreferencedCreatedResources(
    threadId: ThreadId,
    resources: readonly ThreadResourceReference[],
  ): Promise<void> {
    await this.discardCreatedResourcesAgainstReferences(
      threadId,
      resources,
      this.threadResourceReferences(threadId),
    );
  }
  async discardCreatedResourcesAgainstReferences(
    threadId: ThreadId,
    resources: readonly ThreadResourceReference[],
    referenced: readonly ThreadResourceReference[],
  ): Promise<void> {
    const unique = resources.filter((ref, index) => (
      resources.findIndex((candidate) => resourceReferenceKey(candidate) === resourceReferenceKey(ref)) === index
      && !referenced.some((candidate) => resourceReferenceKey(candidate) === resourceReferenceKey(ref))
    ));
    await Promise.all(unique.map((ref) => this.resources.discardThreadReference(threadId, ref)));
  }

  private scanResourceUsage(threadId: ThreadId, items: readonly ThreadItem[]) {
    return scanThreadItemResourceUsage(
      items,
      (ref) => this.core.payloads.readContext(threadId, ref),
    );
  }
}

async function copyHistoricalExactRevision(source: string, root: string, fileName: string): Promise<string> {
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 0; index < 10_000; index += 1) {
    const candidateName = index === 0 ? fileName : `${stem}-${index + 1}${extension}`;
    const candidate = join(root, candidateName);
    try {
      await copyFile(source, candidate, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      return candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  throw new Error('Could not allocate a current-workspace historical file copy');
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'EEXIST';
}

function resourceReferencesFromTurns(turns: readonly Turn[]): ThreadResourceReference[] {
  return turns.flatMap((turn) => turn.items.flatMap(itemResourceReferences));
}

function contextReferencesFromTurns(turns: readonly Turn[]): ThreadContextPayloadReference[] {
  return turns.flatMap((turn) => turn.items.flatMap(itemContextPayloadReferences));
}

function internalTextReferencesFromTurns(turns: readonly Turn[]): ThreadInternalTextPayloadReference[] {
  return turns.flatMap((turn) => turn.items.flatMap(itemInternalTextPayloadReferences));
}

function diagnosticsReferencesFromTurns(turns: readonly Turn[]): TurnDiagnosticsPayloadReference[] {
  return turns.flatMap((turn) => (
    turn.execution.diagnosticsRef ? [turn.execution.diagnosticsRef] : []
  ));
}

function textOutputReferencesFromTurns(turns: readonly Turn[]): ThreadItemOutputReference[] {
  return turns.flatMap((turn) => turn.items.flatMap((item) => [
    ...('outputRef' in item && item.outputRef ? [item.outputRef] : []),
    ...(item.type === 'contextEvidence' || item.type === 'contextCompaction' ? item.outputRefs : []),
  ]));
}

function attachmentSourcesEqual(
  left: ThreadAttachmentContent,
  right: ThreadAttachmentContent,
): boolean {
  if (
    left.name !== right.name
    || left.mimeType !== right.mimeType
    || left.sizeBytes !== right.sizeBytes
    || left.source.kind !== right.source.kind
  ) return false;
  if (left.source.kind === 'localFile' && right.source.kind === 'localFile') {
    if (left.source.path !== right.source.path) return false;
  } else if (left.source.kind === 'resource' && right.source.kind === 'resource') {
    if (resourceReferenceKey(left.source.ref) !== resourceReferenceKey(right.source.ref)) return false;
  } else {
    return false;
  }
  return left.artifactRef?.id === right.artifactRef?.id;
}
