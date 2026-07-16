import type { AgentAuthoringInput, AgentDefinitionView } from '../../api/types';

/**
 * Mirror a built-in agent definition view back into the full {@link AgentAuthoringInput}
 * the update IPC expects.
 *
 * The composer's quick model/effort chip changes only model + effort, but
 * `agent_update_agent_definition` takes a *complete* input — sending a partial one
 * would clear the user's other overlay fields (persona, description, tools, skills).
 * So we round-trip the *current* materialized definition and let the caller override
 * just what changed. The runtime diffs the result against the code base, so mirrored
 * defaults collapse back to "not stored" and never freeze (see
 * `AgentRuntime.updateAgentDefinition`).
 */
export function builtInDefinitionToAuthoringInput(view: AgentDefinitionView): AgentAuthoringInput {
  // `['*']` is the unrestricted sentinel; mirror it as "no restriction" (undefined),
  // matching the editor, so it never lands as a stored tool list. A list that merely
  // *contains* `*` alongside real tools is still a restriction — keep those entries
  // (dropping the meaningless `*`) so the user's restriction is never wiped.
  const tools = !view.tools || (view.tools.length === 1 && view.tools[0] === '*')
    ? undefined
    : view.tools.filter((tool) => tool !== '*');
  return {
    // The editor's `name` field edits the DISPLAY name; the stable `name` is Neva's
    // memory anchor and never changes.
    name: view.displayName ?? view.name,
    description: view.description,
    body: view.body,
    model: view.model && view.model !== 'inherit' ? view.model : undefined,
    effort: typeof view.effort === 'string' ? view.effort : undefined,
    maxTurns: view.maxTurns,
    tools,
    disallowedTools: view.disallowedTools ? [...view.disallowedTools] : undefined,
    skills: view.skills ? [...view.skills] : undefined,
    background: view.background,
  };
}
