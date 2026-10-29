# AF Build & Modify Tools

Version 1.1.0 adds two optional tool groups that let an AI assistant build and maintain PI Asset Framework (AF) structures through PI Web API:

- **Build** (`pi.build.*`): create AF objects. Existing objects are skipped, never changed.
- **Modify** (`pi.modify.*`): change existing AF objects. Nothing is ever deleted, and every call is a dry run unless `dryRun: false` is passed.

Both groups are **off by default** and only work inside the AF databases you allow.

---

## 1. Enabling

```ini
MCP_TRANSPORT=stdio                 # build/modify tools are stdio-only
MCP_READ_ONLY=false                 # required by both groups
MCP_BUILD_TOOLS_ENABLED=true
MCP_BUILD_ALLOWED_DATABASES=\\MyAFServer\Sandbox;\\MyAFServer\Plant_A
MCP_MODIFY_TOOLS_ENABLED=true       # optional; requires MCP_BUILD_TOOLS_ENABLED=true
MCP_WRITE_TOOLS_ENABLED=false       # PI time-series value writes are a separate switch
```

`MCP_BUILD_ALLOWED_DATABASES` accepts:

| Entry | Allows |
|---|---|
| `\\Server\Database` | that database only |
| `\\Server\*` | every database on that AF server, including new ones created with `pi.build.create_database` |

Units of measure are server-wide; `pi.build.create_unit` is allowed on a server that appears in at least one allow-list entry.

The service account used by the server needs AF write permission on the target databases (and on the UOM database for units).

---

## 2. Tools

### Build (`pi.build.*`)

| Tool | Creates | Notes |
|---|---|---|
| `apply_plan` | A whole structure from one JSON plan (see §3) | **Dry run by default.** Order: database → categories → units → tables → element templates (+ attribute and analysis templates) → elements (+ attributes, static values, analyses, children) → PI points. |
| `create_database` | Empty AF database | |
| `create_category` | Attribute / element / analysis / table categories | |
| `create_unit` | Units of measure, optionally a new unit class | Dry run by default. `value_in_reference_unit = value × factor + offset`; reference unit defaults to the class canonical unit. |
| `create_table` | AF table with columns and rows | Dry run by default. An existing table is left as is (use `pi.modify.update_table_data`). |
| `create_element_template` | Element template with attribute templates and analysis templates | |
| `create_attribute_template` | Attribute template (or child) on an existing template | |
| `create_element` | Element (optionally from a template) with children | |
| `create_attribute` | Attribute (or child) on an existing element | |
| `create_analysis` | Expression or Rollup analysis on an element, or analysis template on a template | Created **disabled** unless `enabled: true`. |
| `create_pi_points` | PI points behind PI Point data references ("Create or Update Data Reference") | Needs free PI point licenses. |

### Modify (`pi.modify.*`)

All modify tools take a list of `items`, report `old → new` per field, send only fields that differ, and default to `dryRun: true`.

| Tool | Changes | Fields |
|---|---|---|
| `update_attribute_template` | Attribute templates (affects every element built from the template) | `name`, `description`, `type`, `units`, `dataReference`, `configString`, `categories`, `isConfigurationItem`, `isHidden`, `isExcluded`, `trait`, `displayDigits`, `defaultValue` |
| `update_attribute` | Attributes on individual elements | same as above except `defaultValue` |
| `update_element` | Elements | `name`, `description`, `categories`, `template` |
| `set_attribute_values` | Values of **static** attributes (no data reference) | Attributes with any data reference (PI Point, Table Lookup, Formula, …) are refused. |
| `update_table_data` | Replaces all columns and rows of an AF table | |

---

## 3. Plan format (`pi.build.apply_plan`)

```jsonc
{
  "database": "\\\\MyAFServer\\Plant_A",
  "createDatabase": true,             // create the database if missing
  "dryRun": true,                     // default; set false after review
  "createPiPoints": false,            // needs PI point licenses

  "categories": [ { "kind": "attribute", "name": "Process" } ],

  "units": [
    { "unitClass": "Pressure", "name": "inch of water", "abbreviation": "inH2O",
      "factor": 0.249089, "referenceUnit": "kPa" }
  ],

  "tables": [
    { "name": "PumpCurve", "columns": { "Flow": "Double", "Head": "Double" },
      "rows": [ { "Flow": 0, "Head": 50 }, { "Flow": 100, "Head": 42 } ] }
  ],

  "elementTemplates": [
    {
      "name": "Pump",
      "attributes": [
        { "name": "Flow", "type": "Double", "units": "cubic meter per hour", "dataReference": "PI Point" },
        { "name": "Rated Head", "type": "Double", "defaultValue": 45, "isConfigurationItem": true },
        { "name": "Head", "type": "Double", "dataReference": "Table Lookup",
          "configString": "SELECT Head FROM [PumpCurve] WHERE Flow = 50" },
        { "name": "Head Margin", "type": "Double", "dataReference": "Analysis" }
      ],
      "analyses": [
        { "name": "Head Margin", "type": "Expression",
          "expressions": [ { "variable": "M", "expression": "'Rated Head' - 'Head'", "output": "Head Margin" } ],
          "schedule": { "type": "Periodic", "frequencySeconds": 60 }, "enabled": true }
      ]
    }
  ],

  "elements": [
    { "name": "Area 1",
      "children": [
        { "name": "Pump-01", "template": "Pump", "attributeValues": { "Rated Head": 48 } },
        { "name": "Pump-02", "template": "Pump" }
      ] }
  ]
}
```

### Attribute definition

`{ name, description?, type?, units?, defaultValue?, dataReference?, configString?, pointType?, pointSource?, isConfigurationItem?, categories?, trait?, children? }`

- **PI Point:** `configString` defaults to `\\%Server%\%Element%.%Attribute%`. A `;pointtype=…` entry (derived from `type`, or `pointType`) is appended automatically. AF only creates tags for PI Point references that carry a point type.
- **Static value:** omit `dataReference` and set `defaultValue`.

### Analysis definition

`{ name, description?, type: "Expression" | "Rollup", expressions?, rollup?, schedule, enabled? }`

- **Expression:** `expressions: [{ variable, expression, output? }]`. Plain attribute names (`'Temperature'`) and relative paths (`'Child|Attr'`) work.
- **Rollup:** `rollup: { attribute, elementNameFilter?: "*", searchCriteria?, functions: [{ function: "Sum"|"Average"|"Minimum"|"Maximum"|"Count", output }] }`. This collects `attribute` from the child elements and writes the results to `output` attributes on the parent.
- **Schedule:** `{ type: "Periodic", frequencySeconds, offsetSeconds? }` or `{ type: "Natural" }` (event-triggered).

---

## 4. Excel → AF workflow

1. Give the assistant the workbook and say which AF database to use (or to create a new one).
2. The assistant converts the sheets into a plan (§3) and calls `pi.build.apply_plan` with the default dry run.
3. Review the list of `would-create` items.
4. Approve, and the assistant calls the same plan with `dryRun: false`. The result lists every item as `created`, `exists`, `skipped` or `failed` (with PI Web API's reason).
5. Re-running a plan is safe: existing items are reported as `exists`.
6. Changes to existing objects (renames, units, generic tag paths, values, table data) go through `pi.modify.*`. Review the dry-run diff, then apply.

---

## 5. AF behaviours and limits to know

| Topic | Behaviour |
|---|---|
| **Rollup outputs** | The Analysis Service must *store* Rollup results, so Rollup outputs need **PI Point** data references (and free PI point licenses). Outputs with the `Analysis` data reference stay empty for Rollups. |
| **`Analysis` data reference** | Computes **Expression** analysis outputs on read, without PI points. It's a good fallback when the license is full (e.g. sum named children with an Expression). |
| **Natural schedule** | Triggers only when an input **changes**. With static inputs (configuration values), use a Periodic schedule. |
| **Changing units** | `pi.modify.update_*` with `units` changes the unit, **not** the stored number. Set new values if conversion is needed. |
| **Template change** | `pi.modify.update_element` with `template` works when the new template is compatible with the element's existing attributes; AF rejects conflicting changes. |
| **Table Lookup** | AF interpolates on at most one column. 2-D (bilinear) interpolation needs breakpoints plus several lookups and an analysis. |
| **Gauge units** | A unit is a fixed factor/offset, so gauge pressure relative to a *measured* barometric pressure must be an analysis, not a unit. |
| **PI point licenses** | `-12216 Maximum licensed aggregate Point/Module Count exceeded` means the Data Archive has no free points. Map attributes to existing tags or free licenses. |
| **Excel/VBA functions** | Add-in functions (e.g. steam/gas property functions) have no AF equivalent; use a custom data reference or an external calculation. |

---

## 6. Troubleshooting

- **"Build target is outside MCP_BUILD_ALLOWED_DATABASES"**: add the database (or `\\Server\*`) to the allow-list and restart the MCP client.
- **"This server feature is disabled by its configuration"** with no detail: the relevant switch (`MCP_BUILD_TOOLS_ENABLED` / `MCP_MODIFY_TOOLS_ENABLED`) is off.
- **`failed` items:** the `error` field carries PI Web API's own message, e.g. a missing category, unit or template name.
- **Generic "An exception has occurred" from PI Web API:** enable PI Web API debug mode on the server to see the full reason.
