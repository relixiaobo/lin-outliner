import { describe, expect, test } from 'bun:test';
import {
  ManagedSkillValidationError,
  hashManagedSkillFiles,
  selectManagedSkillEntries,
  validateManagedSkillFiles,
  type ManagedSkillFile,
  type ManagedSkillTreeEntry,
} from '../../src/main/managedSkillValidation';

const encoder = new TextEncoder();

describe('managed skill validation', () => {
  test('validates a text-script subtree and hashes every selected byte deterministically', () => {
    const files = validFiles();
    const validated = validateManagedSkillFiles({
      files: [...files].reverse(),
      selectedDirectoryName: 'demo-skill',
      appVersion: '0.1.0',
      catalogCompatibilityRange: '>=0.1.0 <1.0.0',
    });

    expect(validated).toMatchObject({
      name: 'demo-skill',
      description: 'A managed validation fixture.',
      version: '1.2.3',
      fileCount: 2,
      scripts: ['scripts/run.py'],
      compatibility: {
        status: 'compatible',
        appVersion: '0.1.0',
        declaredRange: '>=0.1.0 <1.0.0 and >=0.1.0',
      },
    });
    expect(validated.contentHash).toBe(hashManagedSkillFiles(files));
    expect(validated.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('accepts missing Tenon metadata as unknown compatibility', () => {
    const skill = file('SKILL.md', [
      '---',
      'name: community-skill',
      'description: Community skill without a Tenon compatibility declaration.',
      '---',
      '# Community',
    ].join('\n'));

    expect(validateManagedSkillFiles({
      files: [skill],
      selectedDirectoryName: 'community-skill',
      appVersion: '0.1.0',
    }).compatibility.status).toBe('unknown');
  });

  test('hashes canonically equivalent Unicode paths in deterministic byte order', () => {
    const files = [
      file('assets/\u00e9.txt', 'precomposed\n'),
      file('assets/e\u0301.txt', 'decomposed\n'),
    ];

    expect(hashManagedSkillFiles(files)).toBe(hashManagedSkillFiles([...files].reverse()));
  });

  test('rejects unsafe Git entry kinds, modes, and hidden support files before download', () => {
    const base = treeEntry('skills/demo/SKILL.md');
    const cases: Array<{ entry: ManagedSkillTreeEntry; code: string }> = [
      { entry: { ...treeEntry('skills/demo/link'), mode: '120000' }, code: 'symlink' },
      { entry: { ...treeEntry('skills/demo/submodule'), mode: '160000', type: 'commit' }, code: 'submodule' },
      { entry: { ...treeEntry('skills/demo/scripts/run.sh'), mode: '100755' }, code: 'executable_file' },
      { entry: treeEntry('skills/demo/.secret'), code: 'hidden_file' },
      { entry: treeEntry('skills/demo/nested/.git/config'), code: 'nested_git_data' },
      { entry: treeEntry('skills/demo/bad\nname'), code: 'invalid_path' },
    ];

    for (const { entry, code } of cases) {
      expect(() => selectManagedSkillEntries([base, entry], 'skills/demo'))
        .toThrow(ManagedSkillValidationError);
      try {
        selectManagedSkillEntries([base, entry], 'skills/demo');
      } catch (error) {
        expect((error as ManagedSkillValidationError).code).toBe(code);
      }
    }
  });

  test('excludes inert source metadata instead of copying it', () => {
    const selected = selectManagedSkillEntries([
      treeEntry('demo/SKILL.md'),
      treeEntry('demo/.gitignore'),
      treeEntry('demo/assets/template.md'),
    ], 'demo');

    expect(selected.map((entry) => entry.relativePath)).toEqual(['SKILL.md', 'assets/template.md']);
  });

  test('ignores invalid paths outside the selected repository subtree', () => {
    const selected = selectManagedSkillEntries([
      treeEntry('skills/demo/SKILL.md'),
      treeEntry('../unrelated/control\nfile'),
    ], 'skills/demo');

    expect(selected.map((entry) => entry.relativePath)).toEqual(['SKILL.md']);
  });

  test('rejects malformed frontmatter, incompatible ranges, embedded shell, and secrets', () => {
    const invalidCases: Array<{ content: string; code: string }> = [
      { content: '---\nname: [broken\ndescription: nope\n---\nBody', code: 'invalid_frontmatter' },
      { content: '---\nname: demo\ndescription: Demo\nexecution: fork\n---\nBody', code: 'invalid_frontmatter' },
      { content: '---\nname: demo\ndescription: Demo\nmetadata:\n  tenon:\n    version: ">=2.0.0"\n---\nBody', code: 'incompatible_tenon' },
      { content: '---\nname: demo\ndescription: Demo\nmetadata:\n  tenon:\n    version: 2\n---\nBody', code: 'invalid_compatibility' },
      { content: '---\nname: demo\ndescription: Demo\n---\n```!\necho unsafe\n```', code: 'embedded_shell' },
      { content: '---\nname: demo\ndescription: Demo\n---\n```!echo unsafe```', code: 'embedded_shell' },
      { content: '---\nname: demo\ndescription: Demo\n---\nUse !`echo unsafe`.', code: 'embedded_shell' },
      { content: '---\nname: demo\ndescription: Demo\n---\n-----BEGIN PRIVATE KEY-----', code: 'secret_content' },
    ];

    for (const entry of invalidCases) {
      try {
        validateManagedSkillFiles({
          files: [file('SKILL.md', entry.content)],
          selectedDirectoryName: 'demo',
          appVersion: '0.1.0',
        });
        throw new Error('Expected validation to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(ManagedSkillValidationError);
        expect((error as ManagedSkillValidationError).code).toBe(entry.code);
      }
    }
  });
});

function validFiles(): ManagedSkillFile[] {
  return [
    file('SKILL.md', [
      '---',
      'name: demo-skill',
      'description: A managed validation fixture.',
      'metadata:',
      '  version: 1.2.3',
      '  tenon:',
      '    version: ">=0.1.0"',
      '---',
      '# Demo',
    ].join('\n')),
    file('scripts/run.py', 'print("hello")\n'),
  ];
}

function file(relativePath: string, content: string): ManagedSkillFile {
  return { relativePath, bytes: encoder.encode(content) };
}

function treeEntry(path: string): ManagedSkillTreeEntry {
  return {
    path,
    mode: '100644',
    type: 'blob',
    sha: 'a'.repeat(40),
    size: 10,
  };
}
