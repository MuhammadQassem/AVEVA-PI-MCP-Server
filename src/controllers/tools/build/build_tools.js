import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import {
  AfBuilder, buildResult, normalizePath,
  attributeDefSchema, analysisDefSchema, elementDefSchema, elementTemplateDefSchema, planSchema, scheduleSchema, expressionSchema, rollupSchema,
  categoryDefSchema, unitDefSchema, tableDefSchema
} from './af-builder.js';

// MCP input schemas stay flat (recursive zod schemas do not translate cleanly to
// JSON Schema for clients); the nested parts are validated in the handler.

function parseOrThrow(schema, value, label) {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError({
      category: ErrorCategory.INVALID_INPUT,
      retryable: false,
      message: `Invalid ${label}: ${r.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`
    });
  }
  return r.data;
}

function builderFrom(context) {
  if (!context.config.MCP_BUILD_TOOLS_ENABLED) {
    throw new AppError({ category: ErrorCategory.FEATURE_DISABLED, retryable: false, message: 'AF build tools are disabled on this server.' });
  }
  return new AfBuilder({ gateway: context.gateway, config: context.config, signal: context.signal });
}

const ATTRIBUTE_HELP = 'Attribute definition: { name, description?, type? (Double|Single|Int32|String|Boolean|DateTime...), units?, defaultValue?, dataReference? ("PI Point"|"Formula"|...), configString?, pointType?, pointSource?, isConfigurationItem?, categories?, trait?, children?: [same shape] }';
const ANALYSIS_HELP = 'Analysis definition: { name, description?, type?: "Expression"|"Rollup" (default Expression), expressions?: [{ variable, expression, output? }] (Expression), rollup?: { attribute, elementNameFilter? (default *), searchCriteria?, functions: [{ function: "Sum"|"Average"|"Minimum"|"Maximum"|"Count", output }] } (Rollup: aggregates a child-element attribute into parent attributes; inputs must be numeric; Rollup OUTPUTS MUST BE "PI Point" attributes - the "Analysis" data reference only works for Expression outputs), schedule: { type: "Periodic"|"Natural", frequencySeconds?, offsetSeconds? }, enabled? }';
const ELEMENT_HELP = 'Element definition: { name, description?, template?, categories?, attributes?: [attribute], attributeValues?: { "Attr": value }, analyses?: [analysis], children?: [same shape] }';

const CONFIRM_DB = ' Always confirm the target AF database with the user before building (use pi.discovery.list_asset_databases to show the options, or pi.build.create_database for a new one).';

export const createDatabaseTool = {
  name: 'pi.build.create_database',
  description: 'Create a new, empty AF database on an AF server (create-only; skipped if it already exists). Confirm the name with the user first.',
  inputSchema: {
    database: z.string().describe('New database path, e.g. \\\\AFServer\\Plant_A'),
    description: z.string().optional()
  },
  async handler(args, context) {
    const b = builderFrom(context);
    await b.ensureDatabase(args.database, args.description, false);
    return buildResult(false, await b.summary());
  }
};

export const createCategoryTool = {
  name: 'pi.build.create_category',
  description: 'Create attribute / element / analysis / table categories in an AF database (create-only).' + CONFIRM_DB,
  inputSchema: {
    database: z.string().describe('AF database path'),
    categories: z.array(categoryDefSchema).min(1)
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const db = await b.requireDatabase(args.database);
    for (const c of args.categories) await b.ensureCategory(db, c, false);
    return buildResult(false, await b.summary());
  }
};

export const createUnitTool = {
  name: 'pi.build.create_unit',
  description: 'Create units of measure (and, if needed, a new unit class) on the AF server (create-only; server-wide). Conversion: value_in_reference_unit = value * factor + offset.',
  inputSchema: {
    server: z.string().describe('AF server name, e.g. AFServer'),
    units: z.array(unitDefSchema).min(1),
    dryRun: z.boolean().default(true).optional().describe('Default true')
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const dryRun = args.dryRun !== false;
    const server = args.server.replace(/^\\+/, '').split('\\')[0];
    for (const u of parseOrThrow(z.array(unitDefSchema), args.units, 'units')) await b.ensureUnit(server, u, dryRun);
    return buildResult(dryRun, await b.summary());
  }
};

export const createTableTool = {
  name: 'pi.build.create_table',
  description: 'Create an AF table with its columns and rows (e.g. from an Excel sheet) for Table Lookup data references (create-only; an existing table is left unchanged).' + CONFIRM_DB,
  inputSchema: {
    database: z.string().describe('AF database path'),
    tables: z.array(z.any()).min(1).describe('Table definitions: { name, description?, categories?, columns: { "Col": "Double"|"String"|"Int32"|"Boolean"|"DateTime" }, rows: [ { "Col": value } ] }'),
    dryRun: z.boolean().default(true).optional().describe('Default true')
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const dryRun = args.dryRun !== false;
    const tables = parseOrThrow(z.array(tableDefSchema), args.tables, 'tables');
    const db = await b.requireDatabase(args.database);
    for (const t of tables) await b.ensureTable(db, t, dryRun);
    return buildResult(dryRun, await b.summary());
  }
};

export const createElementTemplateTool = {
  name: 'pi.build.create_element_template',
  description: 'Create an AF element template (create-only; skipped if it already exists), optionally with attribute templates and analysis templates.' + CONFIRM_DB,
  inputSchema: {
    database: z.string().describe('AF database path, e.g. \\\\Server\\Database'),
    name: z.string(),
    description: z.string().optional(),
    baseTemplate: z.string().optional(),
    categories: z.array(z.string()).optional(),
    allowElementToExtend: z.boolean().optional(),
    attributes: z.array(z.any()).optional().describe(ATTRIBUTE_HELP),
    analyses: z.array(z.any()).optional().describe(ANALYSIS_HELP)
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const def = parseOrThrow(elementTemplateDefSchema, args, 'element template');
    await b.applyPlan({ database: args.database, elementTemplates: [def] }, false);
    return buildResult(false, await b.summary());
  }
};

export const createAttributeTemplateTool = {
  name: 'pi.build.create_attribute_template',
  description: 'Add an attribute template (and optional child attribute templates) to an existing element template (create-only).',
  inputSchema: {
    database: z.string().describe('AF database path'),
    template: z.string().describe('Element template name'),
    parentAttribute: z.string().optional().describe('Existing parent attribute template (use A|B for nested) to create a child under'),
    attribute: z.any().describe(ATTRIBUTE_HELP)
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const def = parseOrThrow(attributeDefSchema, args.attribute, 'attribute');
    const owner = await b.resolveAttributeTemplateOwner(args.database, args.template, args.parentAttribute);
    await b.ensureAttributeTemplate(owner, def, false);
    return buildResult(false, await b.summary());
  }
};

export const createElementTool = {
  name: 'pi.build.create_element',
  description: 'Create an AF element (optionally from a template, with extra attributes, static values, analyses and child elements) under a database or parent element (create-only).' + CONFIRM_DB,
  inputSchema: {
    parent: z.string().describe('Parent path: AF database (\\\\Server\\DB) or element (\\\\Server\\DB\\Area)'),
    element: z.any().describe(ELEMENT_HELP),
    createPiPoints: z.boolean().optional().describe('Create missing PI points for the new element and its children')
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const def = parseOrThrow(elementDefSchema, args.element, 'element');
    const parent = await b.resolveParent(args.parent);
    const node = await b.ensureElement(parent, def, false);
    if (args.createPiPoints) await b.createPiPoints(node, true, false);
    return buildResult(false, await b.summary());
  }
};

export const createAttributeTool = {
  name: 'pi.build.create_attribute',
  description: 'Add an attribute (not from a template) to an existing element (create-only).',
  inputSchema: {
    element: z.string().describe('Element path, e.g. \\\\Server\\DB\\Area\\Pump1'),
    parentAttribute: z.string().optional().describe('Existing parent attribute (A|B for nested) to create a child under'),
    attribute: z.any().describe(ATTRIBUTE_HELP)
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const def = parseOrThrow(attributeDefSchema, args.attribute, 'attribute');
    const owner = await b.resolveAttributeOwner(args.element, args.parentAttribute);
    await b.ensureAttribute(owner, def, false);
    return buildResult(false, await b.summary());
  }
};

export const createPiPointsTool = {
  name: 'pi.build.create_pi_points',
  description: 'Create missing PI points for the PI Point data references of an element (like "Create or Update Data Reference" in PI System Explorer).',
  inputSchema: {
    element: z.string().describe('Element path'),
    includeChildElements: z.boolean().default(true).optional()
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const el = await b.resolveParent(args.element);
    if (el.kind !== 'element') {
      throw new AppError({ category: ErrorCategory.INVALID_INPUT, retryable: false, message: 'element must be an element path' });
    }
    await b.createPiPoints(el, args.includeChildElements !== false, false);
    return buildResult(false, await b.summary());
  }
};

export const createAnalysisTool = {
  name: 'pi.build.create_analysis',
  description: 'Create an analysis on an element, or an analysis template on an element template (create-only). type "Expression" = Performance Equation; type "Rollup" = Sum/Average/Minimum/Maximum/Count of a child-element attribute written to attributes of the parent (picks up new child elements automatically). Rollup outputs must be "PI Point" attributes (needs free PI point licenses); for on-demand results without PI points use an Expression analysis with "Analysis" data reference outputs.',
  inputSchema: {
    element: z.string().optional().describe('Element path (for an element analysis)'),
    database: z.string().optional().describe('AF database path (for an analysis template)'),
    template: z.string().optional().describe('Element template name (for an analysis template)'),
    name: z.string(),
    description: z.string().optional(),
    type: z.enum(['Expression', 'Rollup']).optional().describe('Default Expression'),
    expressions: z.array(expressionSchema).optional().describe('Required for Expression'),
    rollup: rollupSchema.optional().describe('Required for Rollup'),
    schedule: scheduleSchema,
    enabled: z.boolean().optional()
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const def = parseOrThrow(analysisDefSchema, args, 'analysis');
    if (args.element) {
      const el = await b.resolveParent(args.element);
      if (el.kind !== 'element') {
        throw new AppError({ category: ErrorCategory.INVALID_INPUT, retryable: false, message: 'element must be an element path' });
      }
      await b.ensureAnalysis(el, def, false);
    } else if (args.database && args.template) {
      const { db, template } = await b.resolveTemplate(args.database, args.template);
      await b.ensureAnalysisTemplate(db, template, def, false);
    } else {
      throw new AppError({ category: ErrorCategory.INVALID_INPUT, retryable: false, message: 'Provide either element, or database + template' });
    }
    return buildResult(false, await b.summary());
  }
};

export const applyPlanTool = {
  name: 'pi.build.apply_plan',
  description: 'Build a whole AF structure (e.g. converted from an Excel sheet): element templates (with attribute and analysis templates), then elements (nested children, extra attributes, static values, analyses), then optional PI points. Create-only: existing objects are skipped. DRY RUN BY DEFAULT: returns what would be created; call again with dryRun=false only after the user approves.' + CONFIRM_DB,
  inputSchema: {
    database: z.string().describe('Target AF database path, e.g. \\\\AFServer\\MyDatabase'),
    createDatabase: z.boolean().optional().describe('Create the database first if it does not exist'),
    databaseDescription: z.string().optional(),
    categories: z.array(categoryDefSchema).optional().describe('Categories to create first'),
    units: z.array(z.any()).optional().describe('Units to create first: { unitClass, name, abbreviation, factor?, offset?, referenceUnit?, createClass?: { canonicalUnitName, canonicalUnitAbbreviation } }'),
    tables: z.array(z.any()).optional().describe('AF tables to create first: { name, columns: { "Col": "Double"|... }, rows: [ {...} ] }'),
    parent: z.string().optional().describe('Optional element path relative to the database to place root elements under'),
    elementTemplates: z.array(z.any()).optional().describe('Element template definitions: { name, description?, baseTemplate?, categories?, allowElementToExtend?, attributes?: [attribute], analyses?: [analysis] }. ' + ATTRIBUTE_HELP + '. ' + ANALYSIS_HELP),
    elements: z.array(z.any()).optional().describe(ELEMENT_HELP),
    createPiPoints: z.boolean().optional(),
    dryRun: z.boolean().default(true).optional().describe('Default true. Set false to actually create.')
  },
  async handler(args, context) {
    const b = builderFrom(context);
    const plan = parseOrThrow(planSchema, args, 'plan');
    const dryRun = args.dryRun !== false;
    plan.database = normalizePath(plan.database);
    const summary = await b.applyPlan(plan, dryRun);
    return buildResult(dryRun, summary);
  }
};

export const BUILD_TOOLS = [
  applyPlanTool,
  createDatabaseTool,
  createCategoryTool,
  createUnitTool,
  createTableTool,
  createElementTemplateTool,
  createAttributeTemplateTool,
  createElementTool,
  createAttributeTool,
  createAnalysisTool,
  createPiPointsTool
];
