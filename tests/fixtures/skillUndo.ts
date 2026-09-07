import { AgentSkillRuntime, skillLifecycleIdentity } from '../../src/main/agent/capabilities/agentSkills';

export async function undoSkillForTest(runtime: AgentSkillRuntime, name: string): Promise<void> {
  const skill = (await runtime.listAllSkills()).find((entry) => entry.name === name);
  if (!skill) throw new Error(`Missing fixture Skill: ${name}`);
  const target = await runtime.inspectUndoTarget(skillLifecycleIdentity(skill));
  await runtime.undoLastAgentSkillEdit(target);
}
