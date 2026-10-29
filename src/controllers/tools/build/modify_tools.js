import { z } from 'zod';
import { AppError, ErrorCategory } from '../../../errors/error-model.js';
import { AfBuilder, buildResult } from './af-builder.js';

// pi.modify.* tools change EXISTING AF objects. They never delete anything, are
// limited to MCP_BUILD_ALLOWED_DATABASES, report every change as old -> new, and
// run as a dry run unless dryRun=false is passed explicitly.

const DRY_RUN = z.boolean().default(true).optional().describe('Default true: only report old -> new. Set false after the user approves.');
const CONFIRM = ' DRY RUN BY DEFAULT: show the user the old -> new list and only call again with dryRun=false after they approve.';

function modifierFrom(context) {
  if (!context.config.MCP_MODIFY_TOOLS_ENABLED) {
    throw new AppError({ category: ErrorCategory.FEATURE_DISABLED, retryable: false, message: 'AF modify tools are disabled on this server.' });
  }
  return new AfBuilder({ gateway: context.gateway, config: context.config, signal: context.signal });
}

const attributeChanges = z.object({
  name: z.string().min(1).optional().describe('Rename'),
  description: z.string().optional(),
  type: z.string().optional(),
  units: z.string().optional().describe('Default UOM name'),
  dataReference: z.string().optional().describe('e.g. "PI Point", "Table Lookup", "Formula", "" for none'),
  configString: z.string().optional().describe('Data reference config string, e.g. generic tag path \\\\%Server%\\CFG_%Element%.%Attribute%'),
  categories: z.array(z.string()).optional(),
  isConfigurationItem: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  isExcluded: z.boolean().optional(),
  trait: z.string().optional(),
  displayDigits: z.number().int().optional()
}).strict();

async function runUpdates(context, kind, items, dryRun) {
  const m = modifierFrom(context);
  for (const it of items) await m.updateObject(kind, it.path, it.changes, dryRun);
  return buildResult(dryRun, await m.summary());
}

export const updateAttributeTemplateTool = {
  name: 'pi.modify.update_attribute_template',
  description: 'Change existing attribute templates (rename, units, type, data reference / config string such as generic tag paths, categories, flags). Changes apply to every element built from the template.' + CONFIRM,
  inputSchema: {
    items: z.array(z.object({
      path: z.string().describe('\\\\Server\\DB\\ElementTemplates[Template]|Attribute (|Child for nested)'),
      changes: attributeChanges.extend({ defaultValue: z.any().optional() })
    })).min(1),
    dryRun: DRY_RUN
  },
  async handler(args, context) {
    return runUpdates(context, 'attributeTemplate', args.items, args.dryRun !== false);
  }
};

export const updateAttributeTool = {
  name: 'pi.modify.update_attribute',
  description: 'Change existing attributes on individual elements (rename, units, type, data reference / config string, categories, flags).' + CONFIRM,
  inputSchema: {
    items: z.array(z.object({
      path: z.string().describe('\\\\Server\\DB\\Element|Attribute'),
      changes: attributeChanges
    })).min(1),
    dryRun: DRY_RUN
  },
  async handler(args, context) {
    return runUpdates(context, 'attribute', args.items, args.dryRun !== false);
  }
};

export const updateElementTool = {
  name: 'pi.modify.update_element',
  description: 'Change existing elements: rename, description, categories, or assign a different element template (AF may reject a template change that conflicts with existing attributes).' + CONFIRM,
  inputSchema: {
    items: z.array(z.object({
      path: z.string().describe('\\\\Server\\DB\\Parent\\Element'),
      changes: z.object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        categories: z.array(z.string()).optional(),
        template: z.string().optional().describe('Element template name')
      }).strict()
    })).min(1),
    dryRun: DRY_RUN
  },
  async handler(args, context) {
    return runUpdates(context, 'element', args.items, args.dryRun !== false);
  }
};

export const setAttributeValuesTool = {
  name: 'pi.modify.set_attribute_values',
  description: 'Set values of existing STATIC attributes (no data reference), e.g. configuration values, nameplate data, plant names. PI Point and other data-referenced attributes are refused.' + CONFIRM,
  inputSchema: {
    items: z.array(z.object({
      path: z.string().describe('\\\\Server\\DB\\Element|Attribute'),
      value: z.any()
    })).min(1),
    dryRun: DRY_RUN
  },
  async handler(args, context) {
    const m = modifierFrom(context);
    const dryRun = args.dryRun !== false;
    for (const it of args.items) await m.setValue(it.path, it.value, dryRun);
    return buildResult(dryRun, await m.summary());
  }
};

export const updateTableDataTool = {
  name: 'pi.modify.update_table_data',
  description: 'Replace ALL columns and rows of an existing AF table (e.g. re-import from Excel).' + CONFIRM,
  inputSchema: {
    database: z.string().describe('AF database path'),
    table: z.string().describe('Table name'),
    columns: z.record(z.string()).describe('Column name -> type (Double, String, Int32, Boolean, DateTime)'),
    rows: z.array(z.record(z.any())),
    dryRun: DRY_RUN
  },
  async handler(args, context) {
    const m = modifierFrom(context);
    const dryRun = args.dryRun !== false;
    await m.replaceTableData(args.database, args.table, args.columns, args.rows, dryRun);
    return buildResult(dryRun, await m.summary());
  }
};

export const MODIFY_TOOLS = [
  updateAttributeTemplateTool,
  updateAttributeTool,
  updateElementTool,
  setAttributeValuesTool,
  updateTableDataTool
];
