import test from 'node:test';
import assert from 'node:assert/strict';
import { AfBuilder, normalizePath } from '../src/controllers/tools/build/af-builder.js';
import { configSchema } from '../src/config/schema.js';
import { pickNegotiateChallenge } from '../src/gateway/pi-web-api-client.js';
import { AppError, ErrorCategory } from '../src/errors/error-model.js';
import {
  applyPlanTool, createDatabaseTool, createCategoryTool, createUnitTool, createTableTool,
  createElementTemplateTool, createAttributeTemplateTool, createElementTool, createAttributeTool,
  createAnalysisTool, createPiPointsTool
} from '../src/controllers/tools/build/build_tools.js';
import {
  updateAttributeTemplateTool, updateAttributeTool, updateElementTool, setAttributeValuesTool, updateTableDataTool
} from '../src/controllers/tools/build/modify_tools.js';

// ---------------------------------------------------------------------------
// In-memory fake of the PI Web API endpoints used by AfBuilder.
// Objects are keyed by AF path; WebIDs are generated. Every write is recorded.
// ---------------------------------------------------------------------------
class FakeAf {
  constructor(paths = {}) {
    this.byPath = new Map();   // lower(path) -> obj
    this.byId = new Map();     // webId -> obj
    this.lists = new Map();    // `${parentId}/${collection}` -> [obj]
    this.calls = [];
    this.n = 0;
    for (const [path, extra] of Object.entries(paths)) this.add(path, extra);
  }

  add(path, extra = {}, parentId = null, collection = null) {
    const obj = { WebId: `W${++this.n}`, Name: extra.Name || path.split(/[\\|]/).pop().replace(/^.*\[|\]$/g, ''), Path: path, Links: {}, ...extra };
    this.byPath.set(path.toLowerCase(), obj);
    this.byId.set(obj.WebId, obj);
    if (parentId) {
      const key = `${parentId}/${collection}`;
      this.lists.set(key, [...(this.lists.get(key) || []), obj]);
    }
    return obj;
  }

  async request(method, url, body) {
    const u = new URL(url, 'https://x');
    const parts = u.pathname.split('/').filter(Boolean).slice(1); // drop "piwebapi"
    this.calls.push({ method, path: u.pathname, body });
    if (method === 'GET') {
      if (u.searchParams.has('path')) {
        const obj = this.byPath.get(u.searchParams.get('path').toLowerCase());
        if (!obj) throw new AppError({ category: ErrorCategory.NOT_FOUND, retryable: false, message: 'not found' });
        return obj;
      }
      if (parts[2] === 'value') return { Value: this.byId.get(parts[1])?.Value ?? null };
      if (parts[2] === 'data') return this.byId.get(parts[1])?.Data || { Columns: {}, Rows: [] };
      if (parts.length === 3) return { Items: this.lists.get(`${parts[1]}/${parts[2]}`) || [] };
      return this.byId.get(parts[1]) || {};
    }
    const [collection, id, child] = parts;
    const parent = this.byId.get(id);
    if (method === 'POST') {
      const sep = { elementtemplates: `\\ElementTemplates[${body?.Name}]`, attributetemplates: `|${body?.Name}`, attributes: `|${body?.Name}`, elements: `\\${body?.Name}` }[child];
      const extra = { ...body };
      if (child === 'analyses' || child === 'analysistemplates') {
        extra.Links = { AnalysisRule: `https://x/piwebapi/analysisrules/R${this.n + 1}`, TimeRule: `https://x/piwebapi/timerules/T${this.n + 1}` };
      }
      const target = child === 'analysistemplates'
        ? [...this.byId.values()].find(o => o.Path?.endsWith(`ElementTemplates[${body.TargetName}]`))
        : parent;
      const created = this.add(sep ? parent.Path + sep : `${parent.Path}#${child}[${body?.Name}]`, extra, target?.WebId || id, child);
      // Like AF: an element created from a template gets the template's attributes.
      if (child === 'elements' && body?.TemplateName) {
        const tPath = [...this.byPath.values()].find(o => o.Path.endsWith(`ElementTemplates[${body.TemplateName}]`))?.Path;
        for (const o of [...this.byPath.values()].filter(o => tPath && o.Path.startsWith(tPath + '|'))) {
          this.add(created.Path + o.Path.slice(tPath.length), { DataReferencePlugIn: o.DataReferencePlugIn || '' });
        }
      }
      return null;
    }
    if (method === 'PATCH') { Object.assign(this.byId.get(id) || {}, body); return null; }
    if (method === 'PUT' && child === 'value') { this.byId.get(id).Value = body.Value; return null; }
    if (method === 'PUT' && child === 'data') { this.byId.get(id).Data = body; return null; }
    return null;
  }

  writes() { return this.calls.filter(c => c.method !== 'GET'); }
}

const DB = '\\\\SRV\\DB1';
const config = (allowed = '\\\\SRV\\DB1') => ({ PIWEBAPI_BASE_URL: 'https://srv/piwebapi', MCP_BUILD_ALLOWED_DATABASES: allowed });
const builder = (fake, allowed) => new AfBuilder({ gateway: fake, config: config(allowed), signal: null });
const seedDb = () => new FakeAf({ [DB]: {} });

const PLAN = {
  database: DB,
  elementTemplates: [{
    name: 'Pump', allowElementToExtend: true,
    attributes: [{ name: 'Temp', type: 'Double', dataReference: 'PI Point' }, { name: 'Rated', type: 'Double', defaultValue: 80 }],
    analyses: [{ name: 'Margin', type: 'Expression', expressions: [{ variable: 'M', expression: "'Rated' - 'Temp'", output: 'Rated' }], schedule: { type: 'Periodic', frequencySeconds: 60 }, enabled: false }]
  }],
  elements: [{ name: 'Area', children: [{ name: 'P1', template: 'Pump', attributeValues: { Rated: 90 } }] }]
};

// ---------------------------------------------------------------------------

test('Build - normalizePath and allow-list (exact database and \\\\Server\\* wildcard)', () => {
  assert.equal(normalizePath('SRV/DB1/Area/'), '\\\\SRV\\DB1\\Area');
  const exact = builder(seedDb(), '\\\\SRV\\DB1');
  exact.assertAllowed('\\\\SRV\\DB1\\Area|Attr');
  assert.throws(() => exact.assertAllowed('\\\\SRV\\DB2'), /outside MCP_BUILD_ALLOWED_DATABASES/);
  assert.throws(() => exact.assertAllowed('\\\\SRV\\DB10'), /outside/);
  const wild = builder(seedDb(), '\\\\SRV\\*');
  wild.assertAllowed('\\\\SRV\\Anything\\X');
  assert.throws(() => wild.assertAllowed('\\\\OTHER\\DB1'), /outside/);
});

test('Build - apply_plan dry run reports everything and writes nothing', async () => {
  const fake = seedDb();
  const b = builder(fake);
  const { counts, items } = await b.applyPlan(PLAN, true);
  assert.equal(fake.writes().length, 0);
  assert.equal(counts['would-create'], 6); // template, 2 attribute templates, analysis template, 2 elements
  assert.equal(counts['would-set'], 1);
  assert.ok(items.some(i => i.type === 'analysisTemplate' && i.status === 'would-create'));
});

test('Build - apply_plan creates in dependency order, configures analyses, and is idempotent', async () => {
  const fake = seedDb();
  const first = await builder(fake).applyPlan(PLAN, false);
  assert.equal(first.counts.failed, undefined, JSON.stringify(first.items.filter(i => i.status === 'failed')));
  const posts = fake.writes().filter(c => c.method === 'POST').map(c => c.path.split('/').pop());
  assert.ok(posts.indexOf('elementtemplates') < posts.indexOf('elements'), 'templates before elements');

  // PI Point attribute gets a tag-creation config string; analysis rule + schedule are patched.
  const temp = fake.writes().find(c => c.body?.Name === 'Temp');
  assert.match(temp.body.ConfigString, /%Element%\.%Attribute%;pointtype=Float64$/);
  const rule = fake.writes().find(c => c.method === 'PATCH' && c.path.includes('analysisrules'));
  assert.equal(rule.body.ConfigString, "M := 'Rated' - 'Temp';\r\n");
  assert.equal(rule.body.VariableMapping, 'M||Rated;');
  const time = fake.writes().find(c => c.method === 'PATCH' && c.path.includes('timerules'));
  assert.equal(time.body.ConfigString, 'Frequency=60');
  assert.ok(fake.writes().some(c => c.method === 'PUT' && c.body?.Value === 90), 'static value set on new element');

  // Second run: nothing new is written.
  const before = fake.writes().length;
  const second = await builder(fake).applyPlan(PLAN, false);
  assert.equal(fake.writes().length, before);
  assert.ok(second.items.every(i => i.status === 'exists'));
});

test('Build - Rollup analysis uses the Rollup plug-in and SearchCriteria mapping', async () => {
  const fake = new FakeAf({ [DB]: {}, [`${DB}\\Kingdom`]: {} });
  const b = builder(fake);
  const el = await b.resolveParent(`${DB}\\Kingdom`);
  await b.ensureAnalysis(el, {
    name: 'Totals', type: 'Rollup', enabled: true, schedule: { type: 'Natural' },
    rollup: { attribute: 'Subscribers', elementNameFilter: '*', functions: [{ function: 'Sum', output: 'Total' }, { function: 'Count', output: 'Cities' }] }
  }, false);
  const create = fake.writes().find(c => c.method === 'POST');
  assert.equal(create.body.AnalysisRulePlugInName, 'Rollup');
  const rule = fake.writes().find(c => c.path.includes('analysisrules'));
  assert.equal(rule.body.VariableMapping, 'SearchCriteria||Elements[@Name=*]|Attributes[@Name=Subscribers];Sum||Total;Count||Cities;');
  assert.ok(!fake.writes().some(c => c.path.includes('timerules')), 'Natural schedule needs no time rule config');
  assert.ok(fake.writes().some(c => c.method === 'PATCH' && c.body?.Status === 'Enabled'));
});

test('Modify - update sends only changed fields, reports old -> new, and dry run writes nothing', async () => {
  const path = `${DB}\\ElementTemplates[Pump]|Temp`;
  const fake = new FakeAf({ [path]: { DefaultUnitsName: 'degree Celsius', Description: 'x' } });
  await builder(fake).updateObject('attributeTemplate', path, { units: 'kelvin', description: 'x' }, true);
  assert.equal(fake.writes().length, 0);

  const b = builder(fake);
  await b.updateObject('attributeTemplate', path, { units: 'kelvin', description: 'x' }, false);
  const patch = fake.writes()[0];
  assert.deepEqual(patch.body, { DefaultUnitsName: 'kelvin' });
  assert.deepEqual(b.results[0].changes, { units: { from: 'degree Celsius', to: 'kelvin' } });
});

test('Modify - set_attribute_values refuses data-referenced attributes', async () => {
  const fake = new FakeAf({ [`${DB}\\P1|Temp`]: { DataReferencePlugIn: 'PI Point' }, [`${DB}\\P1|Rated`]: { DataReferencePlugIn: '', Value: 80 } });
  const b = builder(fake);
  await b.setValue(`${DB}\\P1|Temp`, 1, false);
  await b.setValue(`${DB}\\P1|Rated`, 95, false);
  assert.equal(b.results[0].status, 'refused');
  assert.equal(b.results[1].status, 'set');
  assert.deepEqual(fake.writes().map(c => c.body), [{ Value: 95 }]);
});

// ---------------------------------------------------------------------------
// Tool handlers, called the way the MCP server calls them.
// ---------------------------------------------------------------------------

const ctx = (fake, extra = {}) => ({
  gateway: fake, signal: null,
  config: { ...config('\\\\SRV\\*'), MCP_BUILD_TOOLS_ENABLED: true, MCP_MODIFY_TOOLS_ENABLED: true, ...extra }
});
const out = res => JSON.parse(res.content[0].text);

test('Tools - every build tool runs through its handler', async () => {
  const fake = new FakeAf({ '\\\\SRV': {}, [DB]: {}, [`${DB}\\Area`]: {}, [`${DB}\\ElementTemplates[T]`]: {} });
  const c = ctx(fake);

  assert.equal(out(await createDatabaseTool.handler({ database: '\\\\SRV\\New' }, c)).items[0].status, 'created');
  assert.equal(out(await createDatabaseTool.handler({ database: DB }, c)).items[0].status, 'exists');

  const cats = out(await createCategoryTool.handler({ database: DB, categories: [{ kind: 'attribute', name: 'Proc' }, { kind: 'table', name: 'Curves' }] }, c));
  assert.equal(cats.counts.created, 2);

  const unitArgs = { server: 'SRV', units: [
    { unitClass: 'Heat Rate', name: 'kJ per kWh', abbreviation: 'kJ/kWh', createClass: { canonicalUnitName: 'kJ per kWh', canonicalUnitAbbreviation: 'kJ/kWh' } },
    { unitClass: 'Heat Rate', name: 'Btu per kWh', abbreviation: 'Btu/kWh', factor: 1.055 }
  ] };
  const dryUnits = out(await createUnitTool.handler(unitArgs, c));
  assert.deepEqual(dryUnits.items.map(i => i.status), ['would-create', 'would-create', 'would-create']);
  const units = out(await createUnitTool.handler({ ...unitArgs, dryRun: false }, c));
  assert.equal(units.counts.created, 3, JSON.stringify(units.items));
  const btu = fake.writes().find(w => w.body?.Abbreviation === 'Btu/kWh');
  assert.equal(btu.body.ReferenceUnitAbbreviation, 'kJ/kWh', 'defaults to the class canonical unit');
  await assert.rejects(createUnitTool.handler({ server: 'OTHER', units: unitArgs.units }, c), /outside/);

  const table = { name: 'Curve', columns: { X: 'Double', Y: 'Double' }, rows: [{ X: 1, Y: 2 }] };
  assert.equal(out(await createTableTool.handler({ database: DB, tables: [table] }, c)).items[0].status, 'would-create');
  assert.equal(out(await createTableTool.handler({ database: DB, tables: [table], dryRun: false }, c)).items[0].status, 'created');
  assert.equal(out(await createTableTool.handler({ database: DB, tables: [table], dryRun: false }, c)).items[0].status, 'exists');

  const tpl = out(await createElementTemplateTool.handler({ database: DB, name: 'Pump', attributes: [{ name: 'Flow', type: 'Double' }] }, c));
  assert.equal(tpl.counts.created, 2);
  const at = out(await createAttributeTemplateTool.handler({ database: DB, template: 'Pump', attribute: { name: 'Head', type: 'Double' } }, c));
  assert.equal(at.items[0].status, 'created');
  const el = out(await createElementTool.handler({ parent: `${DB}\\Area`, element: { name: 'P9', template: 'Pump' }, createPiPoints: true }, c));
  assert.equal(el.items.find(i => i.type === 'element').status, 'created');
  const attr = out(await createAttributeTool.handler({ element: `${DB}\\Area`, attribute: { name: 'Note', type: 'String', defaultValue: 'hi' } }, c));
  assert.equal(attr.counts.created, 1);
  assert.equal(attr.counts.set, 1);
  const an = out(await createAnalysisTool.handler({ element: `${DB}\\Area`, name: 'A1', expressions: [{ variable: 'X', expression: '1' }], schedule: { type: 'Natural' } }, c));
  assert.equal(an.items[0].status, 'created');
  const ant = out(await createAnalysisTool.handler({ database: DB, template: 'Pump', name: 'AT', expressions: [{ variable: 'X', expression: '1' }], schedule: { type: 'Periodic', frequencySeconds: 5 } }, c));
  assert.equal(ant.items[0].status, 'created');
  await assert.rejects(createAnalysisTool.handler({ name: 'B', expressions: [{ variable: 'X', expression: '1' }], schedule: { type: 'Natural' } }, c), /either element/);
  await assert.rejects(createAnalysisTool.handler({ element: `${DB}\\Area`, name: 'B', type: 'Rollup', schedule: { type: 'Natural' } }, c), /rollup is required/);
  assert.equal(out(await createPiPointsTool.handler({ element: `${DB}\\Area` }, c)).items[0].status, 'done');

  const dry = out(await applyPlanTool.handler({ database: '\\\\SRV\\Fresh', createDatabase: true, categories: [{ kind: 'element', name: 'E' }], elementTemplates: [{ name: 'T2' }], elements: [{ name: 'E1' }] }, c));
  assert.equal(dry.dryRun, true);
  assert.ok(dry.items.every(i => i.status === 'would-create'));

  await assert.rejects(applyPlanTool.handler({ database: DB }, ctx(fake, { MCP_BUILD_TOOLS_ENABLED: false })), /disabled/);
});

test('Tools - every modify tool runs through its handler (dry run first, then real)', async () => {
  const fake = new FakeAf({
    [DB]: {}, [`${DB}\\P1`]: { Description: '' }, [`${DB}\\P1|Rated`]: { DataReferencePlugIn: '', Value: 1, DefaultUnitsName: 'kelvin' },
    [`${DB}\\ElementTemplates[Pump]|Flow`]: { DefaultUnitsName: 'liter' }
  });
  const c = ctx(fake);
  for (const dryRun of [true, false]) {
    const r1 = out(await updateAttributeTemplateTool.handler({ dryRun, items: [{ path: `${DB}\\ElementTemplates[Pump]|Flow`, changes: { units: 'gallon' } }] }, c));
    const r2 = out(await updateAttributeTool.handler({ dryRun, items: [{ path: `${DB}\\P1|Rated`, changes: { units: 'degree Celsius' } }] }, c));
    const r3 = out(await updateElementTool.handler({ dryRun, items: [{ path: `${DB}\\P1`, changes: { description: 'Pump 1' } }] }, c));
    const r4 = out(await setAttributeValuesTool.handler({ dryRun, items: [{ path: `${DB}\\P1|Rated`, value: 2 }] }, c));
    const want = dryRun ? ['would-update', 'would-update', 'would-update', 'would-set'] : ['updated', 'updated', 'updated', 'set'];
    assert.deepEqual([r1, r2, r3, r4].map(r => r.items[0].status), want);
  }
  const bad = out(await updateElementTool.handler({ items: [{ path: '\\\\OTHER\\DB\\X', changes: { name: 'Y' } }] }, c));
  assert.equal(bad.items[0].status, 'failed');

  const tables = new FakeAf({ [DB]: {} });
  await createTableTool.handler({ database: DB, tables: [{ name: 'Curve', columns: { X: 'Double' }, rows: [{ X: 1 }] }], dryRun: false }, ctx(tables));
  const t1 = out(await updateTableDataTool.handler({ database: DB, table: 'Curve', columns: { X: 'Double' }, rows: [{ X: 1 }, { X: 2 }] }, ctx(tables)));
  assert.deepEqual(t1.items[0], { type: 'tableData', path: `${DB}\\Tables[Curve]`, status: 'would-replace', from: { columns: 1, rows: 1 }, to: { columns: 1, rows: 2 } });
  const t2 = out(await updateTableDataTool.handler({ database: DB, table: 'Curve', columns: { X: 'Double' }, rows: [{ X: 1 }, { X: 2 }], dryRun: false }, ctx(tables)));
  assert.equal(t2.items[0].status, 'replaced');

  await assert.rejects(setAttributeValuesTool.handler({ items: [{ path: `${DB}\\P1|Rated`, value: 3 }] }, ctx(fake, { MCP_MODIFY_TOOLS_ENABLED: false })), /disabled/);
});

test('Config - build and modify switches enforce their safety rules', () => {
  const base = {
    PIWEBAPI_BASE_URL: 'https://pi.example.test/piwebapi', MCP_TRANSPORT: 'stdio',
    PIWEBAPI_AUTH_MODE: 'basic', PIWEBAPI_BASIC_USER: 'u', PIWEBAPI_BASIC_PASSWORD: 'p'
  };
  const issues = env => (configSchema.safeParse({ ...base, ...env }).error?.issues || []).map(i => i.message).join(' | ');
  assert.match(issues({ MCP_BUILD_TOOLS_ENABLED: 'true', MCP_BUILD_ALLOWED_DATABASES: '\\\\S\\D' }), /MCP_READ_ONLY/);
  assert.match(issues({ MCP_BUILD_TOOLS_ENABLED: 'true', MCP_READ_ONLY: 'false' }), /MCP_BUILD_ALLOWED_DATABASES/);
  assert.match(issues({ MCP_MODIFY_TOOLS_ENABLED: 'true' }), /requires MCP_BUILD_TOOLS_ENABLED/);
  assert.equal(issues({ MCP_BUILD_TOOLS_ENABLED: 'true', MCP_READ_ONLY: 'false', MCP_MODIFY_TOOLS_ENABLED: 'true', MCP_BUILD_ALLOWED_DATABASES: '\\\\S\\*' }), '');
});

test('Kerberos - picks the Negotiate challenge when PI Web API offers several methods', () => {
  assert.equal(pickNegotiateChallenge(['Negotiate', 'Basic realm="PI Web API"']), 'Negotiate');
  assert.equal(pickNegotiateChallenge(['Basic realm="x"', 'Negotiate abc==']), 'Negotiate abc==');
  assert.equal(pickNegotiateChallenge('Negotiate'), 'Negotiate');
  assert.equal(pickNegotiateChallenge(['Basic realm="x"']), null);
  assert.equal(pickNegotiateChallenge(undefined), null);
});
