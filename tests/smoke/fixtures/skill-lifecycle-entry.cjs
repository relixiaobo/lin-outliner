// Test-only launch entry: install deterministic remote fixtures before Host construction.
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

const body = '---\nname: lifecycle-smoke-demo\ndescription: Native Skill review fixture\n---\nRead this complete fixture before installation.\n<script>untrusted()</script>\n';
const blobHash = createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0${body}`).digest('hex');
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  let value;
  if (url.hostname === 'api.github.com' && url.pathname.startsWith('/repos/tenon-fixtures/skills')) {
    if (url.pathname.endsWith('/skills')) value = { default_branch: 'main' };
    else if (url.pathname.includes('/git/ref/heads/')) value = { object: { type: 'commit', sha: 'a'.repeat(40) } };
    else if (url.pathname.includes('/git/trees/')) value = { truncated: false, tree: [{
      path: 'lifecycle-smoke-demo/SKILL.md', mode: '100644', type: 'blob', size: Buffer.byteLength(body), sha: blobHash,
    }] };
  } else if (url.hostname === 'raw.githubusercontent.com' && url.pathname === `/tenon-fixtures/skills/${'a'.repeat(40)}/lifecycle-smoke-demo/SKILL.md`) {
    return new Response(body, { status: 200 });
  }
  return value ? Response.json(value) : new Response('Fixture has no such resource', { status: 404 });
};
void import(pathToFileURL(resolve(__dirname, '../../../out/main/main.js')).href);
