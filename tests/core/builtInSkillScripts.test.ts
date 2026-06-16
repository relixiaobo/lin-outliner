import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dir, '..', '..');
const python = '/usr/bin/python3';
const htmlTool = path.join(root, 'src', 'main', 'builtInSkills', 'presentation', 'scripts', 'html_tool.mjs');
const htmlTemplate = path.join(root, 'src', 'main', 'builtInSkills', 'presentation', 'assets', 'templates', 'html-deck', 'index.html');
const markdownTool = path.join(root, 'src', 'main', 'builtInSkills', 'document', 'scripts', 'markdown_tool.mjs');
const pptxTool = path.join(root, 'src', 'main', 'builtInSkills', 'presentation', 'scripts', 'pptx_tool.py');
const docxTool = path.join(root, 'src', 'main', 'builtInSkills', 'document', 'scripts', 'docx_tool.py');
const dataTool = path.join(root, 'src', 'main', 'builtInSkills', 'data-analysis', 'scripts', 'data_tool.py');
const xlsxTool = path.join(root, 'src', 'main', 'builtInSkills', 'data-analysis', 'scripts', 'xlsx_tool.py');

describe('built-in skill helper scripts', () => {
  test('presentation html inspector reports template warnings without failing structurally', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-presentation-skill-html-template-'));
    const out = path.join(dir, 'report.json');

    await execFile('node', [htmlTool, 'inspect', htmlTemplate, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      errors: [],
      slide_count: 1,
      warnings: ['placeholder_text_found'],
    });
  });

  test('presentation html inspector ignores inline svg namespace URLs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-presentation-skill-html-svg-'));
    const input = path.join(dir, 'deck.html');
    const out = path.join(dir, 'report.json');
    await writeFile(input, [
      '<!doctype html><html><head><style>.slide{aspect-ratio:16 / 9}</style></head><body>',
      '<main data-deck><section class="slide" data-slide="1" aria-current="true">',
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

  test('data-analysis xlsx inspector resolves parent-directory relationship targets', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-skill-xlsx-'));
    const input = path.join(dir, 'workbook.xlsx');
    const out = path.join(dir, 'report.json');
    await writeZip(input, {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
      'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData></worksheet>',
      'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
      'xl/drawings/drawing1.xml': '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
    });

    await execFile(python, [xlsxTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      missing_relationship_targets: [],
    });
  });

  test('data-analysis xlsx inspector reports workbook calculation risks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-skill-xlsx-risk-'));
    const input = path.join(dir, 'workbook.xlsx');
    const out = path.join(dir, 'report.json');
    await writeZip(input, {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
      'xl/workbook.xml': [
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        '<sheets>',
        '<sheet name="Summary" sheetId="1" r:id="rId1"/>',
        '<sheet name="Hidden Assumptions" sheetId="2" state="hidden" r:id="rId2"/>',
        '</sheets>',
        '<definedNames><definedName name="Revenue">Summary!$A$1</definedName></definedNames>',
        '<calcPr calcMode="manual"/>',
        '</workbook>',
      ].join(''),
      'xl/_rels/workbook.xml.rels': [
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>',
        '</Relationships>',
      ].join(''),
      'xl/worksheets/sheet1.xml': [
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        '<dimension ref="A1:A2"/>',
        '<cols><col min="1" max="1" hidden="1"/></cols>',
        '<sheetData><row r="1" hidden="1"><c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData>',
        '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>',
        '</worksheet>',
      ].join(''),
      'xl/worksheets/sheet2.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    });

    await execFile(python, [xlsxTool, 'inspect', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      formula_count: 1,
      formula_error_count: 1,
      defined_name_count: 1,
      calculation_mode: 'manual',
      hidden_sheets: [{ name: 'Hidden Assumptions', state: 'hidden' }],
    });
    expect(report.sheets[0]).toMatchObject({
      hidden_row_count: 1,
      hidden_column_count: 1,
      merged_cell_count: 1,
      formula_error_cells: [{ cell: 'A1', value: '#DIV/0!' }],
    });
    expect(report.warnings).toEqual(expect.arrayContaining([
      'formulas_present_not_recalculated',
      'formula_errors_found',
      'hidden_sheets_present',
      'manual_calculation_mode',
    ]));
  });

  test('data-analysis profiler reports missing values and numeric summaries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-skill-profile-'));
    const input = path.join(dir, 'metrics.csv');
    const out = path.join(dir, 'report.json');
    await writeFile(input, 'segment,revenue,users\nA,1200,40\nB,980,35\nC,,21\n', 'utf8');

    await execFile(python, [dataTool, 'profile', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      warnings: ['missing_values_present'],
      row_count: 3,
      column_count: 3,
    });
    expect(report.columns.find((column: { name: string }) => column.name === 'revenue')).toMatchObject({
      type: 'number',
      missing_count: 1,
      numeric: {
        min: 980,
        max: 1200,
        mean: 1090,
      },
    });
  });

  test('data-analysis profiler reports duplicate rows, dates, outliers, and contract hints', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-skill-profile-quality-'));
    const input = path.join(dir, 'events.csv');
    const out = path.join(dir, 'report.json');
    await writeFile(input, [
      'id,amount,created,status',
      'A,10,2026-01-01T00:00:00Z,open',
      'A,1000,2026-02-01,closed',
      'B,12,2026-02-02,open',
      'B,12,2026-02-02,open',
      '',
    ].join('\n'), 'utf8');

    await execFile(python, [dataTool, 'profile', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report).toMatchObject({
      ok: true,
      duplicate_row_count: 1,
      row_count: 4,
    });
    expect(report.warnings).toContain('duplicate_rows_present');
    expect(report.columns.find((column: { name: string }) => column.name === 'created')).toMatchObject({
      type: 'date',
      date: { min: '2026-01-01T00:00:00', max: '2026-02-02T00:00:00' },
    });
    expect(report.quality.outlier_columns).toContain('amount');
    expect(report.suggested_contract.fields.find((field: { name: string }) => field.name === 'amount')).toMatchObject({
      type: 'number',
      required: true,
    });
  });

  test('data-analysis profiler keeps numeric ids numeric and rejects malformed grouped numbers', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-skill-profile-types-'));
    const input = path.join(dir, 'metrics.csv');
    const out = path.join(dir, 'report.json');
    await writeFile(input, [
      'id,flag,amount',
      '1,yes,"1,2,3"',
      '2,no,"1,234"',
      '3,yes,"2,345"',
      '',
    ].join('\n'), 'utf8');

    await execFile(python, [dataTool, 'profile', input, '--out', out]);
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report.columns.find((column: { name: string }) => column.name === 'id')).toMatchObject({
      type: 'number',
      numeric: { min: 1, max: 3 },
    });
    expect(report.columns.find((column: { name: string }) => column.name === 'flag')).toMatchObject({
      type: 'boolean',
    });
    expect(report.columns.find((column: { name: string }) => column.name === 'amount')).toMatchObject({
      type: 'string',
      type_counts: { number: 2, string: 1 },
    });
  });

  test('data-analysis validator reports portable contract failures', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-skill-validate-'));
    const input = path.join(dir, 'events.csv');
    const contract = path.join(dir, 'contract.json');
    const out = path.join(dir, 'validation.json');
    await writeFile(input, [
      'id,amount,status',
      'A,10,open',
      'A,1000,closed',
      'B,12,draft',
      '',
    ].join('\n'), 'utf8');
    await writeFile(contract, JSON.stringify({
      fields: [
        { name: 'id', type: 'string', required: true, unique: true },
        { name: 'amount', type: 'number', min: 0, max: 100 },
        { name: 'status', type: 'string', allowedValues: ['open', 'closed'] },
      ],
      uniqueKeys: [['id']],
      rowCountMin: 1,
    }), 'utf8');

    try {
      await execFile(python, [dataTool, 'validate', input, '--contract', contract, '--out', out]);
    } catch {
      // Expected: validation failures produce a non-zero exit status.
    }
    const report = JSON.parse(await readFile(out, 'utf8'));

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      'field:id:unique',
      'field:amount:range',
      'field:status:allowedValues',
      'uniqueKey:id',
    ]));
  });

  test('data-analysis validator reports malformed contracts without tracebacks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lin-data-skill-validate-contract-'));
    const input = path.join(dir, 'events.csv');
    const nonObjectContract = path.join(dir, 'non-object.json');
    const invalidRowsContract = path.join(dir, 'invalid-rows.json');
    const nonObjectOut = path.join(dir, 'non-object-report.json');
    const invalidRowsOut = path.join(dir, 'invalid-rows-report.json');
    await writeFile(input, 'id,amount\nA,10\n', 'utf8');
    await writeFile(nonObjectContract, '[]', 'utf8');
    await writeFile(invalidRowsContract, JSON.stringify({
      fields: [],
      rowCountMin: 'abc',
      rowCountMax: {},
    }), 'utf8');

    try {
      await execFile(python, [dataTool, 'validate', input, '--contract', nonObjectContract, '--out', nonObjectOut]);
    } catch {
      // Expected: malformed contracts produce a non-zero exit status.
    }
    try {
      await execFile(python, [dataTool, 'validate', input, '--contract', invalidRowsContract, '--out', invalidRowsOut]);
    } catch {
      // Expected: invalid row count constraints produce a non-zero exit status.
    }

    const nonObjectReport = JSON.parse(await readFile(nonObjectOut, 'utf8'));
    const invalidRowsReport = JSON.parse(await readFile(invalidRowsOut, 'utf8'));

    expect(nonObjectReport).toMatchObject({
      ok: false,
      errors: ['contract_not_object'],
      checks: [],
    });
    expect(invalidRowsReport).toMatchObject({
      ok: false,
      errors: ['rowCountMin', 'rowCountMax'],
    });
    expect(invalidRowsReport.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'rowCountMin', status: 'failed' }),
      expect.objectContaining({ name: 'rowCountMax', status: 'failed' }),
    ]));
  });

  test('document markdown inspector allows ordinary external source links', async () => {
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
      warnings: [],
      external_references: ['https://example.com/spec'],
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
      warnings: ['remote_image_reference_found'],
      external_references: ['https://example.com/chart.png'],
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
