import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  IDENTITY_COLORS,
  MAIN_PRESENTATION_KEY,
  type IdentityColor,
} from '../../core/agent/configuration';
import {
  AgentConfigurationLoader,
  projectConfigurationPath,
  userConfigurationPath,
} from './AgentConfigurationLoader';

/**
 * The write half of Agent configuration.
 *
 * Reading is forgiving by design — a transcript renders whatever it can — but
 * writing is a boundary, and a boundary fails closed (A12). Every write here
 * re-reads the layer it is about to touch, applies one change, and hands the
 * result back through the LOADER's own parser before it reaches disk: if the
 * edit would produce a file the loader cannot read, the write is refused and
 * nothing is saved. That is what keeps the editor from being a way to brick
 * the configuration it edits.
 *
 * It never rewrites a file it did not understand, either. A layer that already
 * fails to parse is surfaced as an error rather than silently replaced with a
 * clean one, because the user's hand-written config is theirs — a UI that
 * "fixes" it by deleting it is worse than a UI that refuses.
 */

/** Which configuration layer a change is written to. */
export type ConfigurationLayerTarget = 'user' | 'project';

export interface AgentRoleDraft {
  readonly name: string;
  readonly description: string;
  readonly developerInstructions: string;
  readonly persona?: string;
  readonly color?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly tools?: readonly string[];
}

export interface PresentationDraft {
  readonly persona?: string;
  readonly color?: string;
}

type JsonObject = Record<string, unknown>;

export class AgentConfigurationWriter {
  constructor(
    private readonly userDataPath: string,
    private readonly loader: AgentConfigurationLoader,
  ) {}

  /** Create or replace one Role in the chosen layer. */
  writeRole(target: ConfigurationLayerTarget, cwd: string, draft: AgentRoleDraft): void {
    const name = draft.name.trim();
    // `main` addresses the conversation's own agent wherever presentation is
    // written; a Role by that name would resolve to one identity in the
    // override map and another in the Agent-type catalog. The loader refuses
    // it too — this is the same rule, said before the user loses their typing.
    if (name === MAIN_PRESENTATION_KEY) {
      throw new Error(`'${MAIN_PRESENTATION_KEY}' is reserved for the conversation's own agent`);
    }
    this.edit(target, cwd, (config) => {
      const roles = asObject(config.roles);
      const presentation: JsonObject = {};
      if (draft.persona !== undefined && draft.persona.trim().length > 0) {
        presentation.persona = draft.persona.trim();
      }
      if (draft.color !== undefined) presentation.color = assertColor(draft.color);
      const overrides: JsonObject = {};
      if (draft.model !== undefined && draft.model.length > 0) overrides.model = draft.model;
      if (draft.reasoningEffort !== undefined) overrides.reasoningEffort = draft.reasoningEffort;
      if (draft.tools !== undefined) overrides.tools = [...draft.tools];
      roles[name] = {
        description: draft.description.trim(),
        developerInstructions: draft.developerInstructions.trim(),
        ...(Object.keys(presentation).length > 0 ? { presentation } : {}),
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      };
      return { ...config, roles };
    });
  }

  /**
   * Remove a Role from the chosen layer. Deleting affects future spawns only:
   * a running child keeps the configuration it resolved at spawn, and past
   * transcripts fall through the identity chain rather than losing their
   * speaker.
   */
  deleteRole(target: ConfigurationLayerTarget, cwd: string, name: string): void {
    this.edit(target, cwd, (config) => {
      const roles = asObject(config.roles);
      if (!(name in roles)) throw new Error(`No Agent Role named '${name}' in this configuration`);
      delete roles[name];
      return Object.keys(roles).length > 0
        ? { ...config, roles }
        : withoutKey(config, 'roles');
    });
  }

  /**
   * Re-skin an identity the user cannot redefine without forking it: the
   * built-in Agent types and the conversation's own agent. A field cleared to
   * empty is REMOVED rather than stored blank, so the built-in default shows
   * through again — the editor's "reset" is the absence of an override, not a
   * second copy of the default.
   */
  writePresentation(
    target: ConfigurationLayerTarget,
    cwd: string,
    agentType: string,
    draft: PresentationDraft,
  ): void {
    this.edit(target, cwd, (config) => {
      const overrides = asObject(config.presentationOverrides);
      const entry: JsonObject = {};
      const persona = draft.persona?.trim();
      if (persona !== undefined && persona.length > 0) entry.persona = persona;
      if (draft.color !== undefined && draft.color.length > 0) entry.color = assertColor(draft.color);
      if (Object.keys(entry).length > 0) overrides[agentType] = entry;
      else delete overrides[agentType];
      return Object.keys(overrides).length > 0
        ? { ...config, presentationOverrides: overrides }
        : withoutKey(config, 'presentationOverrides');
    });
  }

  private layerPath(target: ConfigurationLayerTarget, cwd: string): string {
    return target === 'user' ? userConfigurationPath(this.userDataPath) : projectConfigurationPath(cwd);
  }

  /**
   * Read-modify-write one layer, validated before it lands. The candidate is
   * written to disk only after the loader has parsed the result: on any
   * failure the previous bytes are restored, so a rejected edit leaves the
   * file exactly as the user had it.
   */
  private edit(
    target: ConfigurationLayerTarget,
    cwd: string,
    change: (config: JsonObject) => JsonObject,
  ): void {
    const path = this.layerPath(target, cwd);
    const existed = existsSync(path);
    const original = existed ? readFileSync(path, 'utf8') : null;
    let current: JsonObject = {};
    if (original !== null && original.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(original);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('the file is not a JSON object');
        }
        current = parsed as JsonObject;
      } catch (error) {
        // Not repaired, not replaced: a hand-written configuration belongs to
        // whoever wrote it, and an editor that silently discards it is worse
        // than one that refuses to write.
        throw new Error(`Cannot edit ${path}: ${errorText(error)}`);
      }
    }
    const next = change(current);
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized, 'utf8');
    try {
      // The loader is the authority on what a valid layer is; validating with
      // a second, kinder parser here is how the two drift apart.
      this.loader.resolveIdentityCatalog(cwd);
    } catch (error) {
      if (original === null) writeFileSync(path, '{}\n', 'utf8');
      else writeFileSync(path, original, 'utf8');
      throw new Error(`Refused: ${errorText(error)}`);
    }
  }
}

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as JsonObject) }
    : {};
}

function withoutKey(config: JsonObject, key: string): JsonObject {
  const next = { ...config };
  delete next[key];
  return next;
}

function assertColor(value: string): IdentityColor {
  if (!IDENTITY_COLORS.includes(value as IdentityColor)) {
    throw new Error(`Unknown identity colour '${value}'`);
  }
  return value as IdentityColor;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
