export interface ManagedSkillDefaultManifest {
  id: string;
  name: string;
  catalogId: string;
  owner: string;
  repo: string;
  repository: string;
  subdirectory: string;
  trackingRef: string;
  initialCommit: string;
  expectedContentHash: string;
  catalogCompatibilityRange: string;
}

/**
 * Product defaults pin only their first reviewed acquisition. Installed records
 * track the stable ref so later versions still flow through preview and apply.
 */
export const DEFAULT_MANAGED_SKILLS: readonly ManagedSkillDefaultManifest[] = [{
  id: 'browser-pilot',
  name: 'browser-pilot',
  catalogId: 'browser-pilot',
  owner: 'relixiaobo',
  repo: 'browser-pilot',
  repository: 'https://github.com/relixiaobo/browser-pilot',
  subdirectory: 'plugin/skills/browser-pilot',
  trackingRef: 'skill-stable',
  initialCommit: '853e95d26acec49bcb60d8dac3bb8e5060491727',
  expectedContentHash: 'bea2163ac5d51d8b0ec2b0c7d119dd23904079b0086bee087752eeef6aa86b6d',
  catalogCompatibilityRange: '>=0.1.0 <1.0.0',
}];
