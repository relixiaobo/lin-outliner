import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import { resolveLinlabSkillsRoot } from '../../src/main/builtInSkillConfig';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dir, '..', '..');
const linlabSkillsRoot = resolveLinlabSkillsRoot({ repoRoot: root });
const python = '/usr/bin/python3';
const presentationSkillRoot = path.join(linlabSkillsRoot, 'presentation');
const documentSkillRoot = path.join(linlabSkillsRoot, 'document');
const spreadsheetSkillRoot = path.join(linlabSkillsRoot, 'spreadsheet');
const dataCleanupSkillRoot = path.join(root, 'src', 'main', 'builtInSkills', 'data-cleanup');
const htmlTool = path.join(presentationSkillRoot, 'scripts', 'html_tool.mjs');
const htmlTemplate = path.join(presentationSkillRoot, 'assets', 'templates', 'html-deck', 'index.html');
const markdownTool = path.join(documentSkillRoot, 'scripts', 'markdown_tool.mjs');
const pptxTool = path.join(presentationSkillRoot, 'scripts', 'pptx_tool.py');
const docxTool = path.join(documentSkillRoot, 'scripts', 'docx_tool.py');
const tableTool = path.join(spreadsheetSkillRoot, 'scripts', 'table_tool.py');
const tenonImportTool = path.join(dataCleanupSkillRoot, 'scripts', 'tenon-import.ts');

describe('built-in skill helper scripts', () => {
  test('data-cleanup Tana adapter emits a validated Import Pack preview', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-cleanup-tana-'));
    const fixture = path.join(dataCleanupSkillRoot, 'fixtures', 'tana-fields-and-tags.json');
    const packFile = path.join(dir, 'pack.json');
    const coverageFile = path.join(dir, 'coverage.json');
    const validationFile = path.join(dir, 'validation.json');
    const previewFile = path.join(dir, 'preview.md');

    await execFile('bun', [tenonImportTool, 'tana', fixture, '--out', packFile, '--coverage-out', coverageFile, '--fidelity', 'full']);
    await execFile('bun', [tenonImportTool, 'validate', packFile, '--out', validationFile]);
    await execFile('bun', [tenonImportTool, 'preview', packFile, '--out', previewFile, '--offline-preview']);

    const pack = JSON.parse(await readFile(packFile, 'utf8'));
    const coverage = JSON.parse(await readFile(coverageFile, 'utf8'));
    const validation = JSON.parse(await readFile(validationFile, 'utf8'));
    const preview = await readFile(previewFile, 'utf8');

    expect(pack).toMatchObject({
      version: 1,
      source: { kind: 'tana' },
      stats: {
        sourceRecords: 14,
        sections: 1,
        nodes: 4,
        descriptions: 1,
        tags: 1,
        fields: 1,
        checked: 1,
        dropped: 4,
      },
      coverage: {
        unaccounted: 0,
      },
    });
    expect(pack.sections[0].nodes[0].children[0].fields).toEqual([{
      name: 'Status',
      values: ['Active', 'Review'],
    }]);
    expect(Array.isArray(coverage)).toBe(true);
    expect(coverage).toHaveLength(pack.stats.sourceRecords);
    expect(coverage.every((entry: { status?: string }) => entry.status !== 'unaccounted')).toBe(true);
    expect(validation).toMatchObject({ ok: true, stats: pack.stats, warnings: pack.warnings });
    expect(preview).toContain('# Import Preview: tana');
    expect(preview).toContain('Unaccounted: 0');
    expect(preview).toContain('Fields: 1');
    expect(preview).toContain('Home');
    expect(preview).toContain('trash_node');
  });

  test('data-cleanup preview requires the running app import API by default', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-cleanup-api-required-'));
    const fixture = path.join(dataCleanupSkillRoot, 'fixtures', 'tana-minimal.json');
    const packFile = path.join(dir, 'pack.json');
    const previewFile = path.join(dir, 'preview.md');

    await execFile('bun', [tenonImportTool, 'tana', fixture, '--out', packFile]);
    const failed = await execFile('bun', [tenonImportTool, 'preview', packFile, '--out', previewFile])
      .then(
        () => null,
        (error: { stdout?: string }) => JSON.parse(error.stdout ?? '{}') as { ok?: boolean; error?: { code?: string } },
      );

    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'app_unavailable' },
    });
  });

  test('presentation html inspector reports template warnings without failing structurally', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-presentation-skill-html-template-'));
    const out = path.join(dir, 'report.json');

    await execFile('node', [htmlTool, 'inspect', htmlTemplate, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      errors: [],
      slide_count: 3,
      layouts: ['cover', 'metric', 'product-stage'],
      visual_slide_count: 3,
      warnings: ['placeholder_text_found'],
    });
  });

  test('presentation html inspector ignores inline svg namespace URLs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-presentation-skill-html-svg-'));
    const input = path.join(dir, 'deck.html');
    const out = path.join(dir, 'report.json');
    await writeFile(input, [
      '<!doctype html><html><head><style>.slide{aspect-ratio:16 / 9}</style></head><body>',
      '<main data-deck><section class="slide" data-slide="1" data-layout="diagram" aria-current="true">',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
      '<h1>Evidence-backed claim</h1>',
      '</section></main><script>window.addEventListener("keydown",()=>{})</script>',
      '</body></html>',
    ].join(''), 'utf8');

    await execFile('node', [htmlTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      errors: [],
      warnings: [],
      remote_dependency_references: [],
    });
  });

  test('presentation html inspector reports visual-system risks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-presentation-skill-html-visual-risk-'));
    const input = path.join(dir, 'deck.html');
    const out = path.join(dir, 'report.json');
    const bullets = '<ul><li>One</li><li>Two</li><li>Three</li><li>Four</li><li>Five</li></ul>';
    await writeFile(input, [
      '<!doctype html><html><head><style>.slide{aspect-ratio:16 / 9;font-size:12px}</style></head><body>',
      '<main data-deck>',
      `<section class="slide" data-slide="1" data-layout="split"><h1>Claim 1</h1>${bullets}</section>`,
      `<section class="slide" data-slide="2" data-layout="split"><h1>Claim 2</h1>${bullets}</section>`,
      `<section class="slide" data-slide="3" data-layout="split"><h1>Claim 3</h1>${bullets}</section>`,
      `<section class="slide" data-slide="4" data-layout="split"><h1>Claim 4</h1>${bullets}</section>`,
      '</main><script>window.addEventListener("keydown",()=>{})</script>',
      '</body></html>',
    ].join(''), 'utf8');

    await execFile('node', [htmlTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      errors: [],
      layouts: ['split'],
      text_only_slides: [1, 2, 3, 4],
      bullet_dense_slides: [1, 2, 3, 4],
      tiny_text_hits: ['12px'],
    });
    expect(report.warnings).toEqual([
      'low_layout_variety',
      'text_only_slide_found',
      'bullet_dump_risk',
      'tiny_text_risk',
    ]);
  });

  test('presentation pptx inspector resolves parent-directory relationship targets', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-presentation-skill-pptx-'));
    const input = path.join(dir, 'deck.pptx');
    const out = path.join(dir, 'report.json');
    await writeZip(input, {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
      'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Real slide text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
      'ppt/slides/_rels/slide1.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
      'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    });

    await execFile(python, [pptxTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      missing_relationship_targets: [],
    });
  });

  test('document docx inspector resolves parent-directory relationship targets', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-document-skill-docx-'));
    const input = path.join(dir, 'document.docx');
    const out = path.join(dir, 'report.json');
    await writeZip(input, {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
      'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Real document text</w:t></w:r></w:p></w:body></w:document>',
      'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/></Relationships>',
      'customXml/item1.xml': '<root/>',
    });

    await execFile(python, [docxTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      missing_relationship_targets: [],
    });
  });

  test('document docx inspector reports semantic structure risks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-document-skill-docx-risk-'));
    const input = path.join(dir, 'document.docx');
    const out = path.join(dir, 'report.json');
    await writeZip(input, {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
      'word/document.xml': [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Skipped heading level</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>• Manual bullet text</w:t></w:r></w:p>',
        '<w:p><w:commentRangeStart w:id="9"/><w:r><w:t>Needs a missing comment</w:t></w:r><w:commentRangeEnd w:id="9"/><w:r><w:commentReference w:id="9"/></w:r></w:p>',
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
        '</w:body></w:document>',
      ].join(''),
      'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
    });

    await execFile(python, [docxTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      heading_count: 1,
      manual_bullet_count: 1,
      tables_without_grid_count: 1,
      missing_comment_references: ['9'],
    });
    expect(report.warnings).toEqual(expect.arrayContaining([
      'heading_level_jump_found',
      'manual_bullets_found',
      'missing_comment_references',
      'tables_without_grid_found',
    ]));
  });

  test('document markdown inspector records ordinary external source links', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-doc-skill-markdown-'));
    const input = path.join(dir, 'brief.md');
    const out = path.join(dir, 'report.json');
    await writeFile(input, [
      '# Decision Brief',
      '',
      '## Recommendation',
      '',
      'Use portable skills for repeated workflows. See [source](https://example.com/spec).',
      '',
    ].join('\n'), 'utf8');

    await execFile('node', [markdownTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      warnings: ['bare_url_found'],
      external_references: ['https://example.com/spec'],
      bare_urls: ['https://example.com/spec'],
      remote_image_references: [],
    });
  });

  test('document markdown inspector flags remote image dependencies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-doc-skill-remote-image-'));
    const input = path.join(dir, 'brief.md');
    const out = path.join(dir, 'report.json');
    await writeFile(input, [
      '# Decision Brief',
      '',
      '## Evidence',
      '',
      '![Chart](https://example.com/chart.png)',
      '',
    ].join('\n'), 'utf8');

    await execFile('node', [markdownTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      errors: [],
      warnings: ['remote_image_reference_found', 'bare_url_found'],
      external_references: ['https://example.com/chart.png'],
      bare_urls: ['https://example.com/chart.png'],
      remote_image_references: ['https://example.com/chart.png'],
    });
  });

  test('document markdown inspector reports hierarchy, paragraph, and table risks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-doc-skill-markdown-risk-'));
    const input = path.join(dir, 'brief.md');
    const out = path.join(dir, 'report.json');
    const longParagraph = Array.from({ length: 121 }, (_, index) => `word${index}`).join(' ');
    await writeFile(input, [
      '# Decision Brief',
      '',
      '### Skipped Level',
      '',
      longParagraph,
      '',
      '```',
      '# Not A Heading Inside Code',
      '```',
      '',
      '| A | B | C | D | E | F | G |',
      '|---|---|---|---|---|---|---|',
      '| 1 | 2 | 3 | 4 | 5 | 6 | 7 |',
      '',
    ].join('\n'), 'utf8');

    await execFile('node', [markdownTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      heading_count: 2,
      table_count: 1,
    });
    expect(report.long_paragraphs[0]).toMatchObject({ word_count: 121 });
    expect(report.heading_level_jumps[0]).toMatchObject({ level: 3, previous_level: 1 });
    expect(report.wide_table_rows[0]).toMatchObject({ column_count: 7 });
    expect(report.warnings).toEqual(expect.arrayContaining([
      'heading_level_jump_found',
      'long_paragraph_found',
      'wide_table_found',
    ]));
  });

  test('spreadsheet table inspector reports flat-table risks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-spreadsheet-skill-table-'));
    const input = path.join(dir, 'table.csv');
    const out = path.join(dir, 'report.json');
    await writeFile(input, [
      'id,id,amount',
      '001,001,=SUM(A1:A2)',
      '002,002,42',
      '',
    ].join('\n'), 'utf8');

    await execFile(python, [tableTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      column_count: 3,
      row_count: 2,
      duplicate_headers: ['id'],
      formula_like_cell_count: 1,
      leading_zero_cell_count: 4,
    });
    expect(report.warnings).toEqual(expect.arrayContaining([
      'duplicate_headers',
      'formula_like_cells',
      'leading_zero_cells',
    ]));
  });
});

async function writeZip(filePath: string, files: Record<string, string>): Promise<void> {
  const entries = Object.entries(files).map(([name, content]) => {
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    return { name, data, compressed, crc };
  });
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, entry.compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + entry.compressed.length;
  }

  const centralSize = central.reduce((size, chunk) => size + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await writeFile(filePath, Buffer.concat([...chunks, ...central, end]));
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
