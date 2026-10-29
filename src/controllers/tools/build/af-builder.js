import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';

// Create-only AF builder used by the pi.build.* tools.
//
// Every operation first looks the target up by path; existing objects are left
// untouched and reported as "exists". Nothing is ever updated or deleted, with one
// exception: a brand-new object created in the same call is configured right after
// creation (attribute value, analysis rule/schedule/status), because PI Web API
// creates those in two steps.
//
// Paths are AF paths:
//   database            \\Server\Database
//   element             \\Server\Database\Parent\Child
//   attribute           \\Server\Database\Element|Attr|ChildAttr
//   element template    \\Server\Database\ElementTemplates[Name]
//   attribute template  \\Server\Database\ElementTemplates[Name]|Attr|ChildAttr

const DEFAULT_PI_POINT_CONFIG = '\\\\%Server%\\%Element%.%Attribute%';

// AF value type -> PI point type. A "pointtype=" entry is what enables tag creation
// ("Create or Update Data Reference") for a PI Point data reference.
const PI_POINT_TYPES = {
  double: 'Float64', single: 'Float32', float: 'Float32',
  int16: 'Int16', int32: 'Int32', int64: 'Int32', byte: 'Int16', boolean: 'Int16',
  string: 'String', datetime: 'Timestamp'
};

function piPointConfigString(def) {
  let cfg = def.configString ?? DEFAULT_PI_POINT_CONFIG;
  const pointType = def.pointType || PI_POINT_TYPES[String(def.type || 'Double').toLowerCase()] || 'Float64';
  if (!/;\s*pointtype=/i.test(cfg)) cfg += `;pointtype=${pointType}`;
  if (def.pointSource && !/;\s*pointsource=/i.test(cfg)) cfg += `;pointsource=${def.pointSource}`;
  return cfg;
}

// ---------------------------------------------------------------------------
// Input schemas (shared by the individual tools and apply_plan)
// ---------------------------------------------------------------------------

export const attributeDefSchema = z.lazy(() => z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional().describe('AF value type, e.g. Double, Single, Int32, String, Boolean, DateTime'),
  units: z.string().optional().describe('Default UOM name, e.g. degree Celsius, kilowatt, percent'),
  defaultValue: z.any().optional(),
  dataReference: z.string().optional().describe('Data reference plug-in, e.g. "PI Point", "Formula", "String Builder". Omit for a static value'),
  configString: z.string().optional().describe('Data reference config string. For "PI Point" defaults to \\\\%Server%\\%Element%.%Attribute% (tag name = Element.Attribute)'),
  pointType: z.string().optional().describe('PI Point only: point type for tag creation (Float32, Float64, Int32, String, Digital...). Defaults from type'),
  pointSource: z.string().optional().describe('PI Point only: point source for created tags'),
  isConfigurationItem: z.boolean().optional(),
  categories: z.array(z.string()).optional(),
  trait: z.string().optional().describe('Limit trait, e.g. LimitHi, LimitLo, Minimum, Maximum'),
  children: z.array(attributeDefSchema).optional()
}));

export const scheduleSchema = z.object({
  type: z.enum(['Periodic', 'Natural']).describe('Periodic = fixed interval; Natural = event-triggered on input changes'),
  frequencySeconds: z.number().int().positive().optional().describe('Required for Periodic'),
  offsetSeconds: z.number().int().nonnegative().optional()
});

export const expressionSchema = z.object({
  variable: z.string().min(1).describe('Variable name, e.g. TotalPower'),
  expression: z.string().min(1).describe("Performance Equation, e.g. 'Power A' + 'Power B'"),
  output: z.string().optional().describe('Attribute that receives the result (on the target element/template)')
});

export const rollupSchema = z.object({
  attribute: z.string().min(1).describe('Name of the attribute to collect from each child element, e.g. Load'),
  elementNameFilter: z.string().default('*').describe('Child element name filter (wildcards allowed). Default * = all children'),
  searchCriteria: z.string().optional().describe('Advanced: raw AF rollup search criteria, overrides attribute/elementNameFilter'),
  functions: z.array(z.object({
    function: z.enum(['Sum', 'Average', 'Minimum', 'Maximum', 'Count']),
    output: z.string().min(1).describe('Attribute on the parent (target) element that receives the result')
  })).min(1)
});

export const analysisDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['Expression', 'Rollup']).default('Expression').describe('Expression = Performance Equation; Rollup = aggregate an attribute over child elements'),
  expressions: z.array(expressionSchema).optional().describe('Required for Expression analyses'),
  rollup: rollupSchema.optional().describe('Required for Rollup analyses'),
  schedule: scheduleSchema,
  enabled: z.boolean().default(false).describe('Start the analysis (element) / create analyses enabled (template)')
}).superRefine((d, ctx) => {
  if (d.type === 'Expression' && !d.expressions?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expressions'], message: 'is required for Expression analyses' });
  }
  if (d.type === 'Rollup' && !d.rollup) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rollup'], message: 'is required for Rollup analyses' });
  }
});

export const elementDefSchema = z.lazy(() => z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  template: z.string().optional().describe('Element template name'),
  categories: z.array(z.string()).optional(),
  attributes: z.array(attributeDefSchema).optional().describe('Extra attributes not defined by the template'),
  attributeValues: z.record(z.string(), z.any()).optional().describe('Static values to set on a NEWLY created element, keyed by attribute name (use A|B for child attributes)'),
  analyses: z.array(analysisDefSchema).optional(),
  children: z.array(elementDefSchema).optional()
}));

export const elementTemplateDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  baseTemplate: z.string().optional(),
  categories: z.array(z.string()).optional(),
  allowElementToExtend: z.boolean().default(true),
  attributes: z.array(attributeDefSchema).optional(),
  analyses: z.array(analysisDefSchema).optional()
});

export const categoryDefSchema = z.object({
  kind: z.enum(['attribute', 'element', 'analysis', 'table']),
  name: z.string().min(1),
  description: z.string().optional()
});

export const unitDefSchema = z.object({
  unitClass: z.string().min(1).describe('Unit class name, e.g. Pressure (created if createClass is given and it does not exist)'),
  name: z.string().min(1).describe('Unit name, e.g. inch of water'),
  abbreviation: z.string().min(1).describe('Unit abbreviation, e.g. inH2O'),
  description: z.string().optional(),
  factor: z.number().default(1).describe('value_in_reference_unit = value * factor + offset'),
  offset: z.number().default(0),
  referenceUnit: z.string().optional().describe('Abbreviation of the unit the factor/offset refer to (default: the class canonical unit)'),
  createClass: z.object({
    canonicalUnitName: z.string().min(1),
    canonicalUnitAbbreviation: z.string().min(1),
    description: z.string().optional()
  }).optional().describe('Only when the unit class is new: its canonical unit')
});

export const tableDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  categories: z.array(z.string()).optional(),
  columns: z.record(z.string(), z.string()).describe('Column name -> type, e.g. { "Load": "Double", "Model": "String", "Active": "Boolean", "Count": "Int32", "Time": "DateTime" }'),
  rows: z.array(z.record(z.string(), z.any())).default([])
});

export const planSchema = z.object({
  database: z.string().describe('Target AF database path, e.g. \\\\AFServer\\MyDatabase'),
  createDatabase: z.boolean().default(false).describe('Create the database first if it does not exist'),
  databaseDescription: z.string().optional(),
  categories: z.array(categoryDefSchema).optional().describe('Built first'),
  units: z.array(unitDefSchema).optional().describe('Built first (units are server-wide)'),
  tables: z.array(tableDefSchema).optional().describe('Built before templates so Table Lookup references resolve'),
  elementTemplates: z.array(elementTemplateDefSchema).optional(),
  elements: z.array(elementDefSchema).optional().describe('Root elements (children nest inside)'),
  parent: z.string().optional().describe('Optional element path (relative to the database) to place the root elements under'),
  createPiPoints: z.boolean().default(false).describe('Create missing PI points for PI Point attributes of the created elements')
});

// ---------------------------------------------------------------------------

export function normalizePath(p) {
  let s = String(p || '').trim().replace(/\//g, '\\');
  if (!s.startsWith('\\\\')) s = '\\\\' + s.replace(/^\\+/, '');
  return s.replace(/\\+$/, '');
}

function piErrorText(err) {
  const raw = err?.details;
  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed?.Errors) && parsed.Errors.length) return parsed.Errors.join(' | ');
      if (parsed?.Message) return parsed.Message;
    } catch {
      if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 500);
    }
  }
  return err?.message || String(err);
}

export class AfBuilder {
  #gateway;
  #signal;
  #base;
  #allowed;
  #pendingUnitClasses = new Set();
  results = [];

  constructor({ gateway, config, signal }) {
    this.#gateway = gateway;
    this.#signal = signal;
    this.#base = new URL(config.PIWEBAPI_BASE_URL).pathname.replace(/\/+$/, '');
    this.#allowed = String(config.MCP_BUILD_ALLOWED_DATABASES || '')
      .split(';').map(s => s.trim()).filter(Boolean).map(s => normalizePath(s).toLowerCase());
  }

  // --- guards & low-level helpers ------------------------------------------

  // Allowed entries are database paths (\\Server\DB) or a whole AF server (\\Server\*).
  assertAllowed(path) {
    const p = normalizePath(path).toLowerCase();
    const ok = this.#allowed.some(db => db.endsWith('\\*')
      ? p.startsWith(db.slice(0, -1)) && p.length > db.length - 1
      : p === db || p.startsWith(db + '\\') || p.startsWith(db + '|'));
    if (!ok) {
      throw new AppError({
        category: ErrorCategory.FEATURE_DISABLED,
        retryable: false,
        message: `Build target is outside MCP_BUILD_ALLOWED_DATABASES: ${path}`
      });
    }
  }

  #record(type, path, status, extra = {}) {
    const entry = { type, path, status, ...extra };
    this.results.push(entry);
    return entry;
  }

  #linkPath(link) {
    const u = new URL(link);
    return u.pathname + u.search;
  }

  async #get(path) {
    return this.#gateway.request('GET', path, null, this.#signal);
  }

  async #send(method, path, body) {
    return this.#gateway.request(method, path, body, this.#signal);
  }

  async #getByPath(endpoint, path, fields = 'WebId;Name;Links') {
    try {
      const res = await this.#get(`${this.#base}/${endpoint}?path=${encodeURIComponent(path)}&selectedFields=${fields}`);
      return res?.WebId ? res : null;
    } catch (err) {
      if (err?.category === ErrorCategory.NOT_FOUND || err?.statusCode === 400 || err?.statusCode === 404) return null;
      throw err;
    }
  }

  async summary() {
    const counts = {};
    for (const r of this.results) counts[r.status] = (counts[r.status] || 0) + 1;
    return { counts, items: this.results };
  }

  // --- database ---------------------------------------------------------------

  async requireDatabase(dbPath) {
    const path = normalizePath(dbPath);
    this.assertAllowed(path);
    const db = await this.#getByPath('assetdatabases', path);
    if (!db) {
      throw new AppError({ category: ErrorCategory.NOT_FOUND, retryable: false, message: `AF database not found: ${path}` });
    }
    return { path, webId: db.WebId };
  }

  async ensureDatabase(dbPath, description, dryRun) {
    const path = normalizePath(dbPath);
    const parts = path.slice(2).split('\\');
    if (parts.length !== 2 || !parts[1]) {
      throw new AppError({ category: ErrorCategory.INVALID_INPUT, retryable: false, message: `Not a database path (expected \\\\Server\\Database): ${dbPath}` });
    }
    this.assertAllowed(path);
    if (await this.#getByPath('assetdatabases', path)) {
      this.#record('database', path, 'exists');
      return;
    }
    if (dryRun) {
      this.#record('database', path, 'would-create');
      return;
    }
    try {
      const server = await this.#getByPath('assetservers', `\\\\${parts[0]}`, 'WebId');
      if (!server) throw new Error(`AF server not found: ${parts[0]}`);
      await this.#send('POST', `${this.#base}/assetservers/${server.WebId}/assetdatabases`, {
        Name: parts[1],
        Description: description || ''
      });
      this.#record('database', path, 'created');
    } catch (err) {
      this.#record('database', path, 'failed', { error: piErrorText(err) });
    }
  }

  // --- element templates ------------------------------------------------------

  async ensureElementTemplate(db, def, dryRun) {
    const path = `${db.path}\\ElementTemplates[${def.name}]`;
    const existing = await this.#getByPath('elementtemplates', path);
    if (existing) {
      this.#record('elementTemplate', path, 'exists');
      return { path, webId: existing.WebId, pending: false };
    }
    if (dryRun) {
      this.#record('elementTemplate', path, 'would-create');
      return { path, webId: null, pending: true };
    }
    try {
      await this.#send('POST', `${this.#base}/assetdatabases/${db.webId}/elementtemplates`, {
        Name: def.name,
        Description: def.description || '',
        BaseTemplate: def.baseTemplate || '',
        AllowElementToExtend: def.allowElementToExtend !== false,
        InstanceType: 'Element',
        CategoryNames: def.categories || []
      });
      const created = await this.#getByPath('elementtemplates', path);
      this.#record('elementTemplate', path, 'created');
      return { path, webId: created?.WebId, pending: false };
    } catch (err) {
      this.#record('elementTemplate', path, 'failed', { error: piErrorText(err) });
      return null;
    }
  }

  // --- attributes & attribute templates (shared shape) -------------------------

  #attributeBody(def) {
    const body = {
      Name: def.name,
      Description: def.description || ''
    };
    if (def.type) body.Type = def.type;
    if (def.units) body.DefaultUnitsName = def.units;
    if (def.isConfigurationItem !== undefined) body.IsConfigurationItem = def.isConfigurationItem;
    if (def.categories) body.CategoryNames = def.categories;
    if (def.trait) body.TraitName = def.trait;
    if (def.dataReference) {
      body.DataReferencePlugIn = def.dataReference;
      body.ConfigString = def.dataReference === 'PI Point' ? piPointConfigString(def) : (def.configString ?? '');
    } else if (def.configString) {
      body.ConfigString = def.configString;
    }
    return body;
  }

  /**
   * Ensures an attribute template (and its children) on a template.
   * owner = { kind: 'template'|'attributeTemplate', path, webId, pending }
   */
  async ensureAttributeTemplate(owner, def, dryRun) {
    const path = `${owner.path}|${def.name}`;
    let node = null;
    if (!owner.pending) {
      const existing = await this.#getByPath('attributetemplates', path);
      if (existing) {
        this.#record('attributeTemplate', path, 'exists');
        node = { kind: 'attributeTemplate', path, webId: existing.WebId, pending: false };
      }
    }
    if (!node) {
      if (dryRun || owner.pending) {
        this.#record('attributeTemplate', path, dryRun ? 'would-create' : 'skipped', dryRun ? {} : { error: 'parent was not created' });
        node = { kind: 'attributeTemplate', path, webId: null, pending: true };
      } else {
        const url = owner.kind === 'template'
          ? `${this.#base}/elementtemplates/${owner.webId}/attributetemplates`
          : `${this.#base}/attributetemplates/${owner.webId}/attributetemplates`;
        try {
          const body = this.#attributeBody(def);
          if (def.defaultValue !== undefined) body.DefaultValue = def.defaultValue;
          await this.#send('POST', url, body);
          const created = await this.#getByPath('attributetemplates', path);
          this.#record('attributeTemplate', path, 'created');
          node = { kind: 'attributeTemplate', path, webId: created?.WebId, pending: false };
        } catch (err) {
          this.#record('attributeTemplate', path, 'failed', { error: piErrorText(err) });
          node = { kind: 'attributeTemplate', path, webId: null, pending: true };
        }
      }
    }
    for (const child of def.children || []) {
      await this.ensureAttributeTemplate(node, child, dryRun);
    }
    return node;
  }

  /**
   * Ensures a (non-template) attribute on an element.
   * owner = { kind: 'element'|'attribute', path, webId, pending }
   */
  async ensureAttribute(owner, def, dryRun) {
    const path = `${owner.path}|${def.name}`;
    let node = null;
    let createdNow = false;
    if (!owner.pending) {
      const existing = await this.#getByPath('attributes', path);
      if (existing) {
        this.#record('attribute', path, 'exists');
        node = { kind: 'attribute', path, webId: existing.WebId, pending: false };
      }
    }
    if (!node) {
      if (dryRun || owner.pending) {
        this.#record('attribute', path, dryRun ? 'would-create' : 'skipped', dryRun ? {} : { error: 'parent was not created' });
        node = { kind: 'attribute', path, webId: null, pending: true };
      } else {
        const url = owner.kind === 'element'
          ? `${this.#base}/elements/${owner.webId}/attributes`
          : `${this.#base}/attributes/${owner.webId}/attributes`;
        try {
          await this.#send('POST', url, this.#attributeBody(def));
          const created = await this.#getByPath('attributes', path);
          node = { kind: 'attribute', path, webId: created?.WebId, pending: false };
          createdNow = true;
          this.#record('attribute', path, 'created');
        } catch (err) {
          this.#record('attribute', path, 'failed', { error: piErrorText(err) });
          node = { kind: 'attribute', path, webId: null, pending: true };
        }
      }
    }
    if ((createdNow || (dryRun && node.pending)) && def.defaultValue !== undefined && !def.dataReference) {
      await this.setAttributeValue(path, def.defaultValue, dryRun);
    }
    for (const child of def.children || []) {
      await this.ensureAttribute(node, child, dryRun);
    }
    return node;
  }

  async setAttributeValue(attrPath, value, dryRun) {
    if (dryRun) {
      this.#record('attributeValue', attrPath, 'would-set', { value });
      return;
    }
    try {
      const attr = await this.#getByPath('attributes', attrPath);
      if (!attr) throw new Error('attribute not found');
      await this.#send('PUT', `${this.#base}/attributes/${attr.WebId}/value`, { Value: value });
      this.#record('attributeValue', attrPath, 'set', { value });
    } catch (err) {
      this.#record('attributeValue', attrPath, 'failed', { value, error: piErrorText(err) });
    }
  }

  // --- elements ---------------------------------------------------------------

  /**
   * Ensures an element and (recursively) its attributes, values, analyses and children.
   * parent = { kind: 'database'|'element', path, webId, pending }
   */
  async ensureElement(parent, def, dryRun) {
    const path = `${parent.path}\\${def.name}`;
    let node = null;
    let createdNow = false;
    if (!parent.pending) {
      const existing = await this.#getByPath('elements', path);
      if (existing) {
        this.#record('element', path, 'exists');
        node = { kind: 'element', path, webId: existing.WebId, pending: false };
      }
    }
    if (!node) {
      if (dryRun || parent.pending) {
        this.#record('element', path, dryRun ? 'would-create' : 'skipped',
          { ...(def.template ? { template: def.template } : {}), ...(dryRun ? {} : { error: 'parent was not created' }) });
        node = { kind: 'element', path, webId: null, pending: true };
      } else {
        const url = parent.kind === 'database'
          ? `${this.#base}/assetdatabases/${parent.webId}/elements`
          : `${this.#base}/elements/${parent.webId}/elements`;
        try {
          await this.#send('POST', url, {
            Name: def.name,
            Description: def.description || '',
            TemplateName: def.template || '',
            CategoryNames: def.categories || []
          });
          const created = await this.#getByPath('elements', path);
          node = { kind: 'element', path, webId: created?.WebId, pending: false };
          createdNow = true;
          this.#record('element', path, 'created', def.template ? { template: def.template } : {});
        } catch (err) {
          this.#record('element', path, 'failed', { error: piErrorText(err) });
          node = { kind: 'element', path, webId: null, pending: true };
        }
      }
    }

    for (const attr of def.attributes || []) {
      await this.ensureAttribute(node, attr, dryRun);
    }
    // Static values are only applied to elements created in this run (or that would be).
    if (def.attributeValues && (createdNow || (dryRun && node.pending))) {
      for (const [name, value] of Object.entries(def.attributeValues)) {
        await this.setAttributeValue(`${path}|${name}`, value, dryRun);
      }
    }
    for (const an of def.analyses || []) {
      await this.ensureAnalysis(node, an, dryRun);
    }
    for (const child of def.children || []) {
      await this.ensureElement(node, child, dryRun);
    }
    return node;
  }

  // --- analyses -------------------------------------------------------------

  // Rollup rules keep everything in VariableMapping, e.g.
  // "SearchCriteria||Elements[@Name=*]|Attributes[@Name=Load];Sum||Load;"
  #ruleConfig(def) {
    if (def.type === 'Rollup') {
      const r = def.rollup;
      const criteria = r.searchCriteria || `Elements[@Name=${r.elementNameFilter || '*'}]|Attributes[@Name=${r.attribute}]`;
      const variableMapping = `SearchCriteria||${criteria};` + r.functions.map(f => `${f.function}||${f.output};`).join('');
      return { configString: '', variableMapping };
    }
    const configString = def.expressions.map(e => `${e.variable} := ${e.expression.trim().replace(/;+$/, '')};`).join('\r\n') + '\r\n';
    const variableMapping = def.expressions.filter(e => e.output).map(e => `${e.variable}||${e.output};`).join('');
    return { configString, variableMapping };
  }

  #timeRuleConfig(schedule) {
    if (schedule.type === 'Periodic') {
      if (!schedule.frequencySeconds) {
        throw new AppError({ category: ErrorCategory.INVALID_INPUT, retryable: false, message: 'schedule.frequencySeconds is required for Periodic analyses' });
      }
      return `Frequency=${schedule.frequencySeconds}` + (schedule.offsetSeconds ? `;Offset=${schedule.offsetSeconds}` : '');
    }
    return '';
  }

  // Configures the rule + schedule of an analysis or analysis template that was just created.
  async #configureAnalysisObject(obj, def) {
    const { configString, variableMapping } = this.#ruleConfig(def);
    const links = obj.Links || {};
    if (!links.AnalysisRule) throw new Error('created analysis has no AnalysisRule link');
    await this.#send('PATCH', this.#linkPath(links.AnalysisRule), {
      ConfigString: configString,
      VariableMapping: variableMapping
    });
    const timeConfig = this.#timeRuleConfig(def.schedule);
    if (timeConfig) {
      if (!links.TimeRule) throw new Error('created analysis has no TimeRule link');
      await this.#send('PATCH', this.#linkPath(links.TimeRule), { ConfigString: timeConfig });
    }
  }

  async #findChild(listUrl, name) {
    const res = await this.#get(`${listUrl}?selectedFields=Items.WebId;Items.Name;Items.Links`);
    return (res?.Items || []).find(i => i.Name.toLowerCase() === name.toLowerCase()) || null;
  }

  /** Analysis on a single element. element = { path, webId, pending } */
  async ensureAnalysis(element, def, dryRun) {
    const label = `${element.path}\\Analyses[${def.name}]`;
    this.#timeRuleConfig(def.schedule); // validate early
    if (!element.pending) {
      const existing = await this.#findChild(`${this.#base}/elements/${element.webId}/analyses`, def.name);
      if (existing) {
        this.#record('analysis', label, 'exists');
        return;
      }
    }
    if (dryRun || element.pending) {
      this.#record('analysis', label, dryRun ? 'would-create' : 'skipped', dryRun ? { enabled: def.enabled } : { error: 'element was not created' });
      return;
    }
    let step = 'create';
    try {
      await this.#send('POST', `${this.#base}/elements/${element.webId}/analyses`, {
        Name: def.name,
        Description: def.description || '',
        AnalysisRulePlugInName: def.type === 'Rollup' ? 'Rollup' : 'PerformanceEquation',
        TimeRulePlugInName: def.schedule.type,
        Status: 'Disabled'
      });
      const created = await this.#findChild(`${this.#base}/elements/${element.webId}/analyses`, def.name);
      if (!created) throw new Error('analysis not found after creation');
      step = 'configure';
      await this.#configureAnalysisObject(created, def);
      if (def.enabled) {
        step = 'enable';
        await this.#send('PATCH', `${this.#base}/analyses/${created.WebId}`, { Status: 'Enabled' });
      }
      this.#record('analysis', label, 'created', { enabled: !!def.enabled });
    } catch (err) {
      this.#record('analysis', label, 'failed', { step, error: piErrorText(err) });
    }
  }

  /** Analysis template on an element template. template = { path, webId, pending, name } */
  async ensureAnalysisTemplate(db, template, def, dryRun) {
    const label = `${template.path}\\AnalysisTemplates[${def.name}]`;
    this.#timeRuleConfig(def.schedule);
    if (!template.pending) {
      const existing = await this.#findChild(`${this.#base}/elementtemplates/${template.webId}/analysistemplates`, def.name);
      if (existing) {
        this.#record('analysisTemplate', label, 'exists');
        return;
      }
    }
    if (dryRun || template.pending) {
      this.#record('analysisTemplate', label, dryRun ? 'would-create' : 'skipped', dryRun ? { createEnabled: def.enabled } : { error: 'template was not created' });
      return;
    }
    let step = 'create';
    try {
      await this.#send('POST', `${this.#base}/assetdatabases/${db.webId}/analysistemplates`, {
        Name: def.name,
        Description: def.description || '',
        TargetName: template.name,
        AnalysisRulePlugInName: def.type === 'Rollup' ? 'Rollup' : 'PerformanceEquation',
        TimeRulePlugInName: def.schedule.type,
        CreateEnabled: !!def.enabled
      });
      const created = await this.#findChild(`${this.#base}/elementtemplates/${template.webId}/analysistemplates`, def.name);
      if (!created) throw new Error('analysis template not found after creation');
      step = 'configure';
      await this.#configureAnalysisObject(created, def);
      this.#record('analysisTemplate', label, 'created', { createEnabled: !!def.enabled });
    } catch (err) {
      this.#record('analysisTemplate', label, 'failed', { step, error: piErrorText(err) });
    }
  }

  // --- PI points ------------------------------------------------------------

  async createPiPoints(element, includeChildren, dryRun) {
    if (dryRun || element.pending) {
      this.#record('piPoints', element.path, dryRun ? 'would-create' : 'skipped', { includeChildren });
      return;
    }
    try {
      const log = await this.#send('POST', `${this.#base}/elements/${element.webId}/config?includeChildElements=${includeChildren ? 'true' : 'false'}`, null);
      const failures = (log?.ProgressEvents || []).filter(e => /^Failed/i.test(e));
      this.#record('piPoints', element.path, failures.length ? 'partial' : 'done', { includeChildren, failures: failures.length, log });
    } catch (err) {
      this.#record('piPoints', element.path, 'failed', { error: piErrorText(err) });
    }
  }

  // --- helpers for single-object tools ---------------------------------------

  /** Splits "\\Server\DB\A\B" into the database path and the element remainder. */
  splitElementPath(elementPath) {
    const p = normalizePath(elementPath);
    const parts = p.slice(2).split('\\');
    if (parts.length < 3) {
      throw new AppError({ category: ErrorCategory.INVALID_INPUT, retryable: false, message: `Not an element path: ${elementPath}` });
    }
    return { dbPath: `\\\\${parts[0]}\\${parts[1]}`, path: p, parentPath: `\\\\${parts.slice(0, -1).join('\\')}`, name: parts[parts.length - 1] };
  }

  async resolveParent(path) {
    const p = normalizePath(path);
    this.assertAllowed(p);
    const depth = p.slice(2).split('\\').length;
    if (depth === 2) {
      const db = await this.#getByPath('assetdatabases', p);
      if (!db) throw new AppError({ category: ErrorCategory.NOT_FOUND, retryable: false, message: `AF database not found: ${p}` });
      return { kind: 'database', path: p, webId: db.WebId, pending: false };
    }
    const el = await this.#getByPath('elements', p);
    if (!el) throw new AppError({ category: ErrorCategory.NOT_FOUND, retryable: false, message: `Element not found: ${p}` });
    return { kind: 'element', path: p, webId: el.WebId, pending: false };
  }

  async resolveTemplate(dbPath, templateName) {
    const db = await this.requireDatabase(dbPath);
    const path = `${db.path}\\ElementTemplates[${templateName}]`;
    const t = await this.#getByPath('elementtemplates', path);
    if (!t) throw new AppError({ category: ErrorCategory.NOT_FOUND, retryable: false, message: `Element template not found: ${path}` });
    return { db, template: { kind: 'template', path, webId: t.WebId, pending: false, name: templateName } };
  }

  async resolveAttributeTemplateOwner(dbPath, templateName, parentAttribute) {
    const { db, template } = await this.resolveTemplate(dbPath, templateName);
    if (!parentAttribute) return template;
    const path = `${template.path}|${parentAttribute}`;
    const at = await this.#getByPath('attributetemplates', path);
    if (!at) throw new AppError({ category: ErrorCategory.NOT_FOUND, retryable: false, message: `Attribute template not found: ${path}` });
    return { kind: 'attributeTemplate', path, webId: at.WebId, pending: false };
  }

  async resolveAttributeOwner(elementPath, parentAttribute) {
    const el = await this.resolveParent(elementPath);
    if (el.kind !== 'element') throw new AppError({ category: ErrorCategory.INVALID_INPUT, retryable: false, message: `Not an element path: ${elementPath}` });
    if (!parentAttribute) return el;
    const path = `${el.path}|${parentAttribute}`;
    const a = await this.#getByPath('attributes', path);
    if (!a) throw new AppError({ category: ErrorCategory.NOT_FOUND, retryable: false, message: `Attribute not found: ${path}` });
    return { kind: 'attribute', path, webId: a.WebId, pending: false };
  }

  // --- categories, units, tables ---------------------------------------------

  async #findInList(listUrl, name, fields = 'Items.WebId;Items.Name') {
    const res = await this.#get(`${listUrl}${listUrl.includes('?') ? '&' : '?'}selectedFields=${fields}`);
    return (res?.Items || []).find(i => i.Name.toLowerCase() === name.toLowerCase()) || null;
  }

  async ensureCategory(db, def, dryRun) {
    const collection = { attribute: 'attributecategories', element: 'elementcategories', analysis: 'analysiscategories', table: 'tablecategories' }[def.kind];
    const label = `${db.path}\\${def.kind}Categories[${def.name}]`;
    if (db.webId && await this.#findInList(`${this.#base}/assetdatabases/${db.webId}/${collection}`, def.name)) {
      this.#record('category', label, 'exists');
      return;
    }
    if (dryRun || !db.webId) {
      this.#record('category', label, dryRun ? 'would-create' : 'skipped');
      return;
    }
    try {
      await this.#send('POST', `${this.#base}/assetdatabases/${db.webId}/${collection}`, { Name: def.name, Description: def.description || '' });
      this.#record('category', label, 'created');
    } catch (err) {
      this.#record('category', label, 'failed', { error: piErrorText(err) });
    }
  }

  assertServerAllowed(serverName) {
    const prefix = `\\\\${serverName}\\`.toLowerCase();
    if (!this.#allowed.some(a => a.startsWith(prefix))) {
      throw new AppError({ category: ErrorCategory.FEATURE_DISABLED, retryable: false, message: `AF server is outside MCP_BUILD_ALLOWED_DATABASES: ${serverName}` });
    }
  }

  async ensureUnit(serverName, def, dryRun) {
    this.assertServerAllowed(serverName);
    const label = `\\\\${serverName}\\UOMs[${def.unitClass}]\\${def.name} (${def.abbreviation})`;
    try {
      const server = await this.#getByPath('assetservers', `\\\\${serverName}`, 'WebId');
      if (!server) throw new Error(`AF server not found: ${serverName}`);
      let cls = await this.#findInList(`${this.#base}/assetservers/${server.WebId}/unitclasses`, def.unitClass);
      if (!cls && dryRun && this.#pendingUnitClasses.has(def.unitClass.toLowerCase())) {
        this.#record('unit', label, 'would-create', { factor: def.factor, offset: def.offset });
        return;
      }
      if (!cls) {
        if (!def.createClass) throw new Error(`Unit class "${def.unitClass}" does not exist (pass createClass to create it)`);
        if (dryRun) {
          this.#pendingUnitClasses.add(def.unitClass.toLowerCase());
          this.#record('unitClass', `\\\\${serverName}\\UOMs[${def.unitClass}]`, 'would-create', { canonical: def.createClass.canonicalUnitAbbreviation });
          this.#record('unit', label, 'would-create');
          return;
        }
        await this.#send('POST', `${this.#base}/assetservers/${server.WebId}/unitclasses`, {
          Name: def.unitClass,
          Description: def.createClass.description || '',
          CanonicalUnitName: def.createClass.canonicalUnitName,
          CanonicalUnitAbbreviation: def.createClass.canonicalUnitAbbreviation
        });
        this.#record('unitClass', `\\\\${serverName}\\UOMs[${def.unitClass}]`, 'created');
        cls = await this.#findInList(`${this.#base}/assetservers/${server.WebId}/unitclasses`, def.unitClass);
        // The canonical unit is created with the class.
        if (def.createClass.canonicalUnitAbbreviation === def.abbreviation) {
          this.#record('unit', label, 'created', { canonical: true });
          return;
        }
      }
      const units = await this.#get(`${this.#base}/unitclasses/${cls.WebId}/units?selectedFields=Items.Name;Items.Abbreviation`);
      if ((units?.Items || []).some(u => u.Name.toLowerCase() === def.name.toLowerCase() || u.Abbreviation === def.abbreviation)) {
        this.#record('unit', label, 'exists');
        return;
      }
      if (dryRun) {
        this.#record('unit', label, 'would-create', { factor: def.factor, offset: def.offset });
        return;
      }
      // PI Web API needs an explicit reference unit; default to the class canonical unit.
      let referenceUnit = def.referenceUnit;
      if (!referenceUnit) {
        const clsInfo = await this.#get(`${this.#base}/unitclasses/${cls.WebId}?selectedFields=CanonicalUnitAbbreviation`);
        referenceUnit = clsInfo?.CanonicalUnitAbbreviation || '';
      }
      await this.#send('POST', `${this.#base}/unitclasses/${cls.WebId}/units`, {
        Name: def.name,
        Abbreviation: def.abbreviation,
        Description: def.description || '',
        ReferenceFactor: def.factor ?? 1,
        ReferenceOffset: def.offset ?? 0,
        ReferenceUnitAbbreviation: referenceUnit
      });
      this.#record('unit', label, 'created', { factor: def.factor, offset: def.offset });
    } catch (err) {
      this.#record('unit', label, 'failed', { error: piErrorText(err) });
    }
  }

  async ensureTable(db, def, dryRun) {
    const path = `${db.path}\\Tables[${def.name}]`;
    if (db.webId && await this.#findInList(`${this.#base}/assetdatabases/${db.webId}/tables`, def.name)) {
      this.#record('table', path, 'exists', { note: 'data left unchanged (use pi.modify.update_table_data)' });
      return;
    }
    if (dryRun || !db.webId) {
      this.#record('table', path, dryRun ? 'would-create' : 'skipped', { columns: Object.keys(def.columns).length, rows: def.rows.length });
      return;
    }
    let step = 'create';
    try {
      await this.#send('POST', `${this.#base}/assetdatabases/${db.webId}/tables`, {
        Name: def.name, Description: def.description || '', CategoryNames: def.categories || []
      });
      const table = await this.#findInList(`${this.#base}/assetdatabases/${db.webId}/tables`, def.name);
      if (!table) throw new Error('table not found after creation');
      step = 'data';
      await this.#send('PUT', `${this.#base}/tables/${table.WebId}/data`, { Columns: def.columns, Rows: def.rows });
      this.#record('table', path, 'created', { columns: Object.keys(def.columns).length, rows: def.rows.length });
    } catch (err) {
      this.#record('table', path, 'failed', { step, error: piErrorText(err) });
    }
  }

  // --- modify existing objects (pi.modify.*) ---------------------------------
  //
  // Each change reads the current object first and reports old -> new. Only fields
  // that actually differ are sent. Nothing is ever deleted.

  static FIELD_MAP = {
    name: 'Name', description: 'Description', type: 'Type', units: 'DefaultUnitsName',
    dataReference: 'DataReferencePlugIn', configString: 'ConfigString', categories: 'CategoryNames',
    isConfigurationItem: 'IsConfigurationItem', isHidden: 'IsHidden', isExcluded: 'IsExcluded',
    trait: 'TraitName', displayDigits: 'DisplayDigits', defaultValue: 'DefaultValue', template: 'TemplateName'
  };

  static KIND = {
    attributeTemplate: { endpoint: 'attributetemplates', fields: ['name', 'description', 'type', 'units', 'dataReference', 'configString', 'categories', 'isConfigurationItem', 'isHidden', 'isExcluded', 'trait', 'displayDigits', 'defaultValue'] },
    attribute: { endpoint: 'attributes', fields: ['name', 'description', 'type', 'units', 'dataReference', 'configString', 'categories', 'isConfigurationItem', 'isHidden', 'isExcluded', 'trait', 'displayDigits'] },
    element: { endpoint: 'elements', fields: ['name', 'description', 'categories', 'template'] },
    elementTemplate: { endpoint: 'elementtemplates', fields: ['name', 'description', 'categories'] }
  };

  async updateObject(kind, path, changes, dryRun) {
    const spec = AfBuilder.KIND[kind];
    const p = normalizePath(path);
    try {
      this.assertAllowed(p);
      const unknown = Object.keys(changes).filter(k => !spec.fields.includes(k));
      if (unknown.length) throw new Error(`Fields not changeable on ${kind}: ${unknown.join(', ')}`);
      const piFields = Object.keys(changes).map(k => AfBuilder.FIELD_MAP[k]);
      const current = await this.#getByPath(spec.endpoint, p, ['WebId', ...piFields].join(';'));
      if (!current) throw new Error(`${kind} not found`);
      const body = {};
      const diff = {};
      for (const [k, to] of Object.entries(changes)) {
        const f = AfBuilder.FIELD_MAP[k];
        const from = current[f];
        if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) {
          body[f] = to;
          diff[k] = { from: from ?? null, to };
        }
      }
      if (!Object.keys(body).length) {
        this.#record(kind, p, 'unchanged');
        return;
      }
      if (dryRun) {
        this.#record(kind, p, 'would-update', { changes: diff });
        return;
      }
      await this.#send('PATCH', `${this.#base}/${spec.endpoint}/${current.WebId}`, body);
      this.#record(kind, p, 'updated', { changes: diff });
    } catch (err) {
      this.#record(kind, p, 'failed', { changes, error: piErrorText(err) });
    }
  }

  // Values are only written to attributes without a data reference (static values /
  // configuration items). PI Point attributes are refused: that is a PI value write.
  async setValue(path, value, dryRun) {
    const p = normalizePath(path);
    try {
      this.assertAllowed(p);
      const attr = await this.#getByPath('attributes', p, 'WebId;DataReferencePlugIn');
      if (!attr) throw new Error('attribute not found');
      if (attr.DataReferencePlugIn) {
        this.#record('attributeValue', p, 'refused', { error: `attribute uses the "${attr.DataReferencePlugIn}" data reference; only static attributes can be set here` });
        return;
      }
      const cur = await this.#get(`${this.#base}/attributes/${attr.WebId}/value?selectedFields=Value`);
      const from = cur?.Value ?? null;
      if (JSON.stringify(from) === JSON.stringify(value)) {
        this.#record('attributeValue', p, 'unchanged', { value });
        return;
      }
      if (dryRun) {
        this.#record('attributeValue', p, 'would-set', { from, to: value });
        return;
      }
      await this.#send('PUT', `${this.#base}/attributes/${attr.WebId}/value`, { Value: value });
      this.#record('attributeValue', p, 'set', { from, to: value });
    } catch (err) {
      this.#record('attributeValue', p, 'failed', { to: value, error: piErrorText(err) });
    }
  }

  async replaceTableData(dbPath, name, columns, rows, dryRun) {
    const label = `${normalizePath(dbPath)}\\Tables[${name}]`;
    try {
      const db = await this.requireDatabase(dbPath);
      const table = await this.#findInList(`${this.#base}/assetdatabases/${db.webId}/tables`, name);
      if (!table) throw new Error('table not found');
      const cur = await this.#get(`${this.#base}/tables/${table.WebId}/data?selectedFields=Columns;Rows`);
      const from = { columns: Object.keys(cur?.Columns || {}).length, rows: (cur?.Rows || []).length };
      const to = { columns: Object.keys(columns).length, rows: rows.length };
      if (dryRun) {
        this.#record('tableData', label, 'would-replace', { from, to });
        return;
      }
      await this.#send('PUT', `${this.#base}/tables/${table.WebId}/data`, { Columns: columns, Rows: rows });
      this.#record('tableData', label, 'replaced', { from, to });
    } catch (err) {
      this.#record('tableData', label, 'failed', { error: piErrorText(err) });
    }
  }

  // --- whole plan -------------------------------------------------------------

  async #buildSupportObjects(plan, db, dryRun) {
    for (const c of plan.categories || []) await this.ensureCategory(db, c, dryRun);
    const serverName = db.path.slice(2).split('\\')[0];
    for (const u of plan.units || []) await this.ensureUnit(serverName, u, dryRun);
    for (const t of plan.tables || []) await this.ensureTable(db, t, dryRun);
  }

  async applyPlan(plan, dryRun) {
    if (plan.createDatabase) {
      await this.ensureDatabase(plan.database, plan.databaseDescription, dryRun);
      if (dryRun && this.results.at(-1)?.status === 'would-create') {
        // Nothing below can be looked up yet; report everything as would-create.
        const db = { path: normalizePath(plan.database), webId: null };
        const pendingRoot = { kind: 'database', path: db.path, webId: null, pending: true };
        await this.#buildSupportObjects(plan, db, true);
        for (const t of plan.elementTemplates || []) {
          const template = { kind: 'template', path: `${db.path}\\ElementTemplates[${t.name}]`, webId: null, pending: true, name: t.name };
          this.#record('elementTemplate', template.path, 'would-create');
          for (const a of t.attributes || []) await this.ensureAttributeTemplate(template, a, true);
          for (const an of t.analyses || []) await this.ensureAnalysisTemplate(db, template, an, true);
        }
        const roots = [];
        for (const e of plan.elements || []) roots.push(await this.ensureElement(pendingRoot, e, true));
        if (plan.createPiPoints) for (const r of roots) await this.createPiPoints(r, true, true);
        return this.summary();
      }
    }
    const db = await this.requireDatabase(plan.database);

    // 0. Categories, units and tables (referenced by templates and attributes).
    await this.#buildSupportObjects(plan, db, dryRun);

    // 1. Element templates, their attribute templates and analysis templates.
    for (const t of plan.elementTemplates || []) {
      const node = await this.ensureElementTemplate(db, t, dryRun);
      if (!node) continue;
      const template = { kind: 'template', path: node.path, webId: node.webId, pending: node.pending, name: t.name };
      for (const a of t.attributes || []) await this.ensureAttributeTemplate(template, a, dryRun);
      for (const an of t.analyses || []) await this.ensureAnalysisTemplate(db, template, an, dryRun);
    }

    // 2. Elements (templates exist by now, so template analyses are instantiated on creation).
    let root = { kind: 'database', path: db.path, webId: db.webId, pending: false };
    if (plan.parent) root = await this.resolveParent(`${db.path}\\${plan.parent.replace(/^\\+/, '')}`);
    const roots = [];
    for (const e of plan.elements || []) roots.push(await this.ensureElement(root, e, dryRun));

    // 3. PI points for PI Point data references.
    if (plan.createPiPoints) {
      for (const r of roots) await this.createPiPoints(r, true, dryRun);
    }
    return this.summary();
  }
}

export function buildResult(dryRun, summary) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ dryRun, ...summary }, null, 2)
    }]
  };
}
