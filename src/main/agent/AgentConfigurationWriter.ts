import { existsSync, readFileSync } from 'node:fs';
import { IDENTITY_COLORS, type IdentityColor } from '../../core/agent/configuration';
import type { AgentRoleDraft } from '../../core/types';
import { atomicWriteFile } from '../jsonFileStore';
import {
  RESERVED_AGENT_TYPE_NAMES,
  decodeConfigurationLayer,
  projectConfigurationPath,
  userConfigurationPath,
} from './AgentConfigurationLoader';

/**
 * The write half of Agent configuration.
 *
 * Reading is forgiving by design — a transcript renders whatever it can — but
 * writing is a boundary, and a boundary fails closed (A12). Every write here
 * re-reads the layer it is about to touch, applies one change, and validates
 * the candidate **in memory** through the loader's own decoder before anything
 * reaches disk. Nothing is written until the result is known to be readable, so
 * there is no window in which the rejected bytes are the live configuration and
 * no rollback that can itself fail.
 *
 * It never rewrites a file it did not understand, either. A layer that already
 * fails to parse is surfaced as an error rather than silently replaced with a
 * clean one, because the user's hand-written config is theirs — a UI that
 * "fixes" it by deleting it is worse than a UI that refuses. That check is the
 * loader's full decode, not a shape guess: `{"roles": ["auditor"]}` is valid
 * JSON the loader rejects, and treating it as "no roles" would drop the user's
 * content while reporting success.
 *
 * It also never destroys what it cannot show. The editor writes a Role's
 * description, instructions, and identity; a Role's `overrides` (model,
 * reasoningEffort, tools, skills, plugins, mcpServers) survive a save
 * untouched unless the draft names them.
 */

/** Which configuration layer a change is written to. */
export type ConfigurationLayerTarget = 'user' | 'project';

/**
 * Whether a Role write may land on a name that already exists.
 *
 * An unguarded upsert makes "add an agent" able to silently replace a Role the
 * user spent real effort on: same name, no confirmation, no undo. Intent is
 * explicit so create can fail closed.
 */
export type RoleWriteMode = 'create' | 'update';

export interface PresentationDraft {
  readonly persona?: string;
  readonly color?: string;
}

type JsonObject = Record<string, unknown>;

export class AgentConfigurationWriter {
  // Only the user-data root: validation goes through the loader's decoder as a
  // module function, so the writer does not hold — or appear to depend on — a
  // reader instance it never asks anything.
  constructor(private readonly userDataPath: string) {}

  /** Create or replace one Role in the chosen layer. */
  async writeRole(
    target: ConfigurationLayerTarget,
    cwd: string,
    draft: AgentRoleDraft,
    mode: RoleWriteMode,
  ): Promise<void> {
    const name = draft.name.trim();
    // `main` addresses the conversation's own agent wherever presentation is
    // written, and a built-in canonical type is claimed by a definition the
    // user cannot replace — a Role by either name resolves one way through
    // `resolveRole` and another through `agentTypeCandidates`. The loader
    // refuses `main` too; this is the same rule, said before the user loses
    // their typing.
    if (RESERVED_AGENT_TYPE_NAMES.includes(name)) {
      throw new Error(`'${name}' is a built-in agent name and cannot be reused`);
    }
    await this.edit(target, cwd, (config) => {
      const roles = asObject(config.roles);
      const existing = asObject(roles[name]);
      if (mode === 'create' && Object.hasOwn(roles, name)) {
        throw new Error(`An agent named '${name}' already exists in this layer`);
      }
      const presentation: JsonObject = {};
      if (draft.persona !== undefined && draft.persona.trim().length > 0) {
        presentation.persona = draft.persona.trim();
      }
      if (draft.color !== undefined && draft.color.length > 0) {
        presentation.color = assertColor(draft.color);
      }
      // Merged, not replaced: the editor does not show `overrides`, so a save
      // that never mentioned them must not delete the model, tools, or skills
      // the user hand-wrote.
      const overrides: JsonObject = asObject(existing.overrides);
      if (draft.model !== undefined) overrides.model = draft.model;
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
  async deleteRole(target: ConfigurationLayerTarget, cwd: string, name: string): Promise<void> {
    await this.edit(target, cwd, (config) => {
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
  async writePresentation(
    target: ConfigurationLayerTarget,
    cwd: string,
    agentType: string,
    draft: PresentationDraft,
  ): Promise<void> {
    await this.edit(target, cwd, (config) => {
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
   * Read-modify-write one layer, validated before it lands.
   *
   * Both ends are checked against the loader's own decoder, and only THIS
   * layer: a broken file in the other layer is someone else's problem to fix
   * and must not make this one uneditable. Nothing touches disk until the
   * candidate has parsed, so a refused edit leaves the file — and the
   * directory — exactly as the user had them.
   */
  private async edit(
    target: ConfigurationLayerTarget,
    cwd: string,
    change: (config: JsonObject) => JsonObject,
  ): Promise<void> {
    const path = this.layerPath(target, cwd);
    let current: JsonObject = {};
    if (existsSync(path)) {
      const original = readFileSync(path, 'utf8');
      if (original.trim().length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(original);
        } catch (error) {
          // Not repaired, not replaced: a hand-written configuration belongs to
          // whoever wrote it, and an editor that silently discards it is worse
          // than one that refuses to write.
          throw new Error(`Cannot edit ${path}: ${errorText(error)}`);
        }
        try {
          decodeConfigurationLayer(parsed, target, path);
        } catch (error) {
          throw new Error(`Cannot edit ${path}: ${errorText(error)}`);
        }
        current = parsed as JsonObject;
      }
    }
    const next = change(current);
    try {
      // The loader is the authority on what a valid layer is; validating with
      // a second, kinder parser here is how the two drift apart.
      decodeConfigurationLayer(next, target, path);
    } catch (error) {
      throw new Error(`Refused: ${errorText(error)}`);
    }
    await atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
    // The loader holds no cache, so the next read sees this write. Resolving
    // the catalog here would only re-read what the caller is about to.
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
