import { join, resolve } from 'node:path';
import { Core } from '../../src/core/core';
import { plainText } from '../../src/core/types';
import { OutlineRuntimeWorkspace } from '../../src/outline/runtime';

const userData = resolve(process.argv[2]!);
const count = Number(process.argv[3] ?? 0);
const core = Core.new();
if (count > 0) {
  const roots = Array.from({ length: Math.ceil(count / 100) }, (_, group) => ({
    content: plainText(`Startup measurement group ${group}`),
    children: Array.from({ length: Math.min(99, count - group * 100 - 1) }, (_, index) => ({
      content: plainText(`Entry ${group * 100 + index}: ${'Structured workspace measurement content. '.repeat(8)}`),
      children: [],
    })),
  }));
  core.createNodesFromTree(core.projection().libraryId, roots);
}
const workspace = await OutlineRuntimeWorkspace.open(join(userData, 'outline-runtime', 'workspace'), {
  contentRoot: join(userData, 'content'),
  initialCore: core,
});
console.log(JSON.stringify({ userData, nodes: workspace.projection().nodes.length }));
workspace.close();
