import type {
  AutomationCatalogResponse,
  AutomationDynamicOptionSource,
  AutomationNodeCatalogEntry,
  AutomationPortDescriptor,
  AutomationPortOption,
  AutomationSafety,
  AutomationType,
  HookDescriptor,
  TriggerDescriptor
} from "@cloudx/shared";
import { AUTOMATION_FSTRING_TYPE_ID, automationFStringInputPorts } from "@cloudx/shared";

import { AutomationTypeService, ARRAY_TYPE, BOOLEAN_TYPE, EXEC_TYPE, NUMBER_TYPE, OBJECT_TYPE, STRING_TYPE, UNKNOWN_TYPE } from "./AutomationTypeService.js";

export interface AutomationDynamicOptionResult {
  options: AutomationPortOption[];
  defaultValue?: unknown;
}

export type AutomationDynamicOptionProvider = (source: AutomationDynamicOptionSource) => AutomationDynamicOptionResult | Promise<AutomationDynamicOptionResult>;

export class AutomationCatalogService {
  constructor(
    private readonly typeService: AutomationTypeService,
    private readonly triggersProvider: () => TriggerDescriptor[],
    private readonly hooksProvider: () => HookDescriptor[],
    private readonly dynamicOptionsProvider: AutomationDynamicOptionProvider = () => ({ options: [] })
  ) {}

  async catalog(): Promise<AutomationCatalogResponse> {
    return {
      nodes: [
        ...(await Promise.all(this.triggersProvider().map((trigger) => this.triggerEntry(trigger)))),
        ...(await Promise.all(this.hooksProvider()
          .filter((hook) => hook.exposures.includes("automation"))
          .map((hook) => this.hookEntry(hook)))),
        ...primitiveEntries(),
        ...converterEntries()
      ]
    };
  }

  async entry(typeId: string): Promise<AutomationNodeCatalogEntry | undefined> {
    return (await this.catalog()).nodes.find((entry) => entry.typeId === typeId);
  }

  private async triggerEntry(trigger: TriggerDescriptor): Promise<AutomationNodeCatalogEntry> {
    const payloadType = this.typeService.schemaToType(trigger.payloadSchema);
    const payloadProperties = payloadType.kind === "object" ? payloadType.properties ?? {} : {};
    const propertySchemas = recordOfRecords(trigger.payloadSchema?.properties);
    return {
      typeId: `trigger:${trigger.id}`,
      kind: "trigger",
      title: trigger.title,
      description: trigger.description,
      pluginId: trigger.owner.pluginId,
      triggerId: trigger.id,
      inputs: [],
      outputs: [
        execOutput("exec", "Start", "Starts automation execution when this trigger fires."),
        dataOutput("payload", "Payload", payloadType, "Complete trigger payload object.", { connectable: false }),
        ...(await Promise.all(
          Object.entries(payloadProperties).filter(([id]) => id !== "payload").map(async ([id, type]) =>
            dataOutput(id, titleCase(id), type, descriptionFromSchema(propertySchemas[id]) ?? `${titleCase(id)} value from the ${trigger.title} trigger payload.`)
          )
        ))
      ]
    };
  }

  private async hookEntry(hook: HookDescriptor): Promise<AutomationNodeCatalogEntry> {
    const schema = hook.inputSchema as Record<string, unknown>;
    const inputType = this.typeService.schemaToType(schema);
    const properties = inputType.kind === "object" ? inputType.properties ?? {} : {};
    const propertySchemas = recordOfRecords(schema.properties);
    const required = new Set(inputType.kind === "object" ? inputType.required ?? [] : []);
    const inputPorts = (await Promise.all(
      Object.entries(properties).map(async ([id, type]) =>
        this.inputPortsForSchema(id, labelFromSchema(id, propertySchemas[id]), type, propertySchemas[id], required.has(id), `Input value for ${hook.title}.`)
      )
    )).flat();
    const targetTabPorts = hook.owner.kind === "plugin" && !Object.prototype.hasOwnProperty.call(properties, "targetTabId") ? [await this.targetTabInputPort()] : [];
    return {
      typeId: `hook:${hook.id}`,
      kind: "function",
      title: hook.title,
      description: hook.description,
      pluginId: hook.owner.pluginId,
      hookId: hook.id,
      safety: hook.automationSafety ?? defaultSafety(hook),
      inputs: [
        execInput("exec", "Run", "Run this node after the previous program-flow step."),
        ...targetTabPorts,
        ...inputPorts
      ],
      outputs: [
        execOutput("exec", "Done", "Continue program flow after this node completes."),
        ...outputPortsForSchema(hook.outputSchema, this.typeService)
      ]
    };
  }

  private async inputPortsForSchema(id: string, label: string, type: AutomationType, schema: Record<string, unknown> | undefined, required: boolean, fallbackDescription: string): Promise<AutomationPortDescriptor[]> {
    if (type.kind === "object" && shouldFlattenObjectSchema(schema)) {
      const childSchemas = recordOfRecords(schema?.properties);
      const requiredChildren = new Set(Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
      const ports = await Promise.all(
        Object.entries(type.properties ?? {}).map(([childId, childType]) =>
          this.inputPortsForSchema(
            `${id}.${childId}`,
            labelFromSchema(childId, childSchemas[childId]),
            childType,
            childSchemas[childId],
            required && requiredChildren.has(childId),
            `${label} ${titleCase(childId)} value.`
          )
        )
      );
      return ports.flat();
    }
    const metadata = withFallbackDescription(await this.portMetadata(schema), fallbackDescription);
    return [dataInput(id, label, type, required, { ...metadata, connectable: metadata.connectable ?? type.kind !== "object" })];
  }

  private async targetTabInputPort(): Promise<AutomationPortDescriptor> {
    const dynamic = await this.dynamicOptionsProvider("workspace.tabs");
    return dataInput("targetTabId", "Target Tab", STRING_TYPE, false, {
      automationRole: "pluginTargetTab",
      description: "Workspace tab that should receive this plugin hook. Leave empty to use the active or only matching plugin tab.",
      options: { source: "workspace.tabs", values: dynamic.options }
    });
  }

  private async portMetadata(schema: Record<string, unknown> | undefined): Promise<PortMetadata> {
    if (!schema) {
      return {};
    }
    const dynamicSource = dynamicOptionSource(schema["x-cloudx-option-source"]);
    const dynamic = dynamicSource ? await this.dynamicOptionsProvider(dynamicSource) : undefined;
    const staticOptions = Array.isArray(schema.enum) ? enumOptions(schema.enum) : undefined;
    return {
      description: typeof schema.description === "string" ? schema.description : undefined,
      defaultValue: schema.default !== undefined ? schema.default : dynamic?.defaultValue,
      options: dynamic
        ? { source: dynamicSource, values: dynamic.options }
        : staticOptions
          ? { values: staticOptions }
          : undefined,
      connectable: typeof schema["x-cloudx-connectable"] === "boolean" ? schema["x-cloudx-connectable"] : undefined
    };
  }
}

interface PortMetadata {
  automationRole?: AutomationPortDescriptor["automationRole"];
  description?: string;
  defaultValue?: unknown;
  options?: AutomationPortDescriptor["options"];
  connectable?: boolean;
}

function primitiveEntries(): AutomationNodeCatalogEntry[] {
  return [
    {
      typeId: "primitive:sequence",
      kind: "primitive",
      title: "Sequence",
      description: "Pass execution through to the next step.",
      inputs: [execInput("exec", "Run", "Incoming program-flow step.")],
      outputs: [execOutput("exec", "Next", "Outgoing program-flow step.")]
    },
    {
      typeId: "primitive:if",
      kind: "primitive",
      title: "If",
      description: "Branch execution based on a boolean condition.",
      inputs: [execInput("exec", "Run", "Incoming program-flow step."), dataInput("condition", "Condition", BOOLEAN_TYPE, true, { description: "Boolean value used to choose the True or False output." })],
      outputs: [execOutput("true", "True", "Runs when Condition is true."), execOutput("false", "False", "Runs when Condition is false.")]
    },
    {
      typeId: "primitive:while",
      kind: "primitive",
      title: "While",
      description: "Repeat the body while the condition is true.",
      inputs: [execInput("exec", "Run", "Incoming program-flow step."), dataInput("condition", "Condition", BOOLEAN_TYPE, true, { description: "Boolean value checked before each loop iteration." })],
      outputs: [execOutput("body", "Body", "Runs while Condition is true."), execOutput("done", "Done", "Runs after Condition becomes false.")]
    },
    {
      typeId: "primitive:variables.create",
      kind: "primitive",
      title: "Create Variable",
      description: "Declare a run variable and set its initial value.",
      inputs: [execInput("exec", "Run", "Incoming program-flow step."), dataInput("initial", "Initial", UNKNOWN_TYPE, false, { description: "Initial value stored in the configured variable name." })],
      outputs: [execOutput("exec", "Done", "Continue after the variable is created."), dataOutput("value", "Value", UNKNOWN_TYPE, "Value stored in the variable.")]
    },
    {
      typeId: "primitive:variables.set",
      kind: "primitive",
      title: "Set Variable",
      description: "Store a value in the run variable map.",
      inputs: [execInput("exec", "Run", "Incoming program-flow step."), dataInput("value", "Value", UNKNOWN_TYPE, false, { description: "Value stored in the configured variable name." })],
      outputs: [execOutput("exec", "Done", "Continue after the variable is stored."), dataOutput("value", "Value", UNKNOWN_TYPE, "Stored variable value.")]
    },
    {
      typeId: "primitive:variables.get",
      kind: "primitive",
      title: "Get Variable",
      description: "Read a value from the run variable map.",
      inputs: [],
      outputs: [dataOutput("value", "Value", UNKNOWN_TYPE, "Current value of the configured variable name.")]
    },
    {
      typeId: "primitive:array.literal",
      kind: "primitive",
      title: "Array",
      description: "Provide a configured array value.",
      inputs: [],
      outputs: [dataOutput("value", "Value", ARRAY_TYPE, "Configured array value.")]
    },
    {
      typeId: "primitive:array.append",
      kind: "primitive",
      title: "Append To Array",
      description: "Return a new array with an item appended.",
      inputs: [dataInput("array", "Array", ARRAY_TYPE, true, { description: "Input array." }), dataInput("item", "Item", UNKNOWN_TYPE, true, { description: "Item appended to the end." })],
      outputs: [dataOutput("value", "Value", ARRAY_TYPE, "New array containing the appended item.")]
    },
    {
      typeId: "primitive:array.get",
      kind: "primitive",
      title: "Array Get",
      description: "Read an array item by zero-based index.",
      inputs: [dataInput("array", "Array", ARRAY_TYPE, true, { description: "Input array." }), dataInput("index", "Index", NUMBER_TYPE, true, { description: "Zero-based item index.", defaultValue: 0 })],
      outputs: [dataOutput("value", "Value", UNKNOWN_TYPE, "Array item at Index.")]
    },
    {
      typeId: "primitive:array.length",
      kind: "primitive",
      title: "Array Length",
      description: "Return the number of items in an array.",
      inputs: [dataInput("array", "Array", ARRAY_TYPE, true, { description: "Input array." })],
      outputs: [dataOutput("value", "Value", NUMBER_TYPE, "Number of items in Array.")]
    },
    {
      typeId: "primitive:constant.string",
      kind: "primitive",
      title: "Text",
      description: "Provide a configured string value.",
      inputs: [],
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Configured text value.")]
    },
    {
      typeId: "primitive:constant.number",
      kind: "primitive",
      title: "Number",
      description: "Provide a configured number value.",
      inputs: [],
      outputs: [dataOutput("value", "Value", NUMBER_TYPE, "Configured numeric value.")]
    },
    {
      typeId: "primitive:constant.boolean",
      kind: "primitive",
      title: "Boolean",
      description: "Provide a configured boolean value.",
      inputs: [],
      outputs: [dataOutput("value", "Value", BOOLEAN_TYPE, "Configured true/false value.")]
    },
    {
      typeId: "primitive:stringTemplate",
      kind: "primitive",
      title: "String Template",
      description: "Render a string from node config and input values.",
      inputs: [dataInput("value", "Value", UNKNOWN_TYPE, false, { description: "Optional value available to the template as ${value}." })],
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Rendered template text.")]
    },
    {
      typeId: AUTOMATION_FSTRING_TYPE_ID,
      kind: "primitive",
      title: "F-String",
      description: "Render a Python-style f-string template from named dynamic inputs.",
      inputs: automationFStringInputPorts(),
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Rendered f-string text.")]
    },
    ...stringOperationEntries(),
    ...mathOperationEntries(),
    {
      typeId: "primitive:log",
      kind: "primitive",
      title: "Log",
      description: "Append a message to the automation run trace.",
      inputs: [execInput("exec", "Run", "Incoming program-flow step."), dataInput("message", "Message", UNKNOWN_TYPE, false, { description: "Message written to the run trace. Empty uses node config.message." })],
      outputs: [execOutput("exec", "Done", "Continue after the message is logged.")]
    }
  ];
}

function stringOperationEntries(): AutomationNodeCatalogEntry[] {
  return [
    {
      typeId: "primitive:string.append",
      kind: "primitive",
      title: "Append Text",
      description: "Append text to the end of another string.",
      inputs: [
        dataInput("text", "Text", STRING_TYPE, true, { description: "Base text.", defaultValue: "" }),
        dataInput("suffix", "Suffix", STRING_TYPE, true, { description: "Text appended to the end.", defaultValue: "" })
      ],
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Combined text.")]
    },
    {
      typeId: "primitive:string.insert",
      kind: "primitive",
      title: "Insert Text",
      description: "Insert text at a zero-based character index.",
      inputs: [
        dataInput("text", "Text", STRING_TYPE, true, { description: "Base text.", defaultValue: "" }),
        dataInput("insert", "Insert", STRING_TYPE, true, { description: "Text inserted into Text.", defaultValue: "" }),
        dataInput("index", "Index", NUMBER_TYPE, true, { description: "Zero-based character index.", defaultValue: 0 })
      ],
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Text with Insert placed at Index.")]
    },
    {
      typeId: "primitive:string.split",
      kind: "primitive",
      title: "Split Text",
      description: "Split text into an array using a separator.",
      inputs: [
        dataInput("text", "Text", STRING_TYPE, true, { description: "Text to split.", defaultValue: "" }),
        dataInput("separator", "Separator", STRING_TYPE, true, { description: "Separator string.", defaultValue: " " })
      ],
      outputs: [dataOutput("value", "Value", ARRAY_TYPE, "Array of text segments.")]
    },
    {
      typeId: "primitive:string.replace",
      kind: "primitive",
      title: "Replace Text",
      description: "Replace plain text or a regular expression match.",
      inputs: [
        dataInput("text", "Text", STRING_TYPE, true, { description: "Text to modify.", defaultValue: "" }),
        dataInput("search", "Search", STRING_TYPE, true, { description: "Plain search text or regular expression pattern.", defaultValue: "" }),
        dataInput("replacement", "Replacement", STRING_TYPE, true, { description: "Replacement text.", defaultValue: "" }),
        dataInput("regex", "Regex", BOOLEAN_TYPE, false, { description: "Treat Search as a JavaScript regular expression.", defaultValue: false }),
        dataInput("flags", "Flags", STRING_TYPE, false, { description: "Regular expression flags such as g or i.", defaultValue: "g" })
      ],
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Text after replacement.")]
    },
    {
      typeId: "primitive:string.regex.test",
      kind: "primitive",
      title: "Regex Test",
      description: "Return true when text matches a regular expression.",
      inputs: [
        dataInput("text", "Text", STRING_TYPE, true, { description: "Text to test.", defaultValue: "" }),
        dataInput("pattern", "Pattern", STRING_TYPE, true, { description: "JavaScript regular expression pattern.", defaultValue: "" }),
        dataInput("flags", "Flags", STRING_TYPE, false, { description: "Regular expression flags such as i or m.", defaultValue: "" })
      ],
      outputs: [dataOutput("value", "Value", BOOLEAN_TYPE, "True when Pattern matches Text.")]
    },
    {
      typeId: "primitive:string.regex.extract",
      kind: "primitive",
      title: "Regex Extract",
      description: "Extract a regular expression match or capture group.",
      inputs: [
        dataInput("text", "Text", STRING_TYPE, true, { description: "Text to search.", defaultValue: "" }),
        dataInput("pattern", "Pattern", STRING_TYPE, true, { description: "JavaScript regular expression pattern.", defaultValue: "" }),
        dataInput("flags", "Flags", STRING_TYPE, false, { description: "Regular expression flags such as i or m.", defaultValue: "" }),
        dataInput("group", "Group", NUMBER_TYPE, false, { description: "Capture group index. Zero returns the full match.", defaultValue: 0 })
      ],
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Matched text or empty string when no match exists.")]
    },
    {
      typeId: "primitive:string.length",
      kind: "primitive",
      title: "Text Length",
      description: "Return the number of UTF-16 code units in text.",
      inputs: [dataInput("text", "Text", STRING_TYPE, true, { description: "Text to measure.", defaultValue: "" })],
      outputs: [dataOutput("value", "Value", NUMBER_TYPE, "Text length.")]
    },
    {
      typeId: "primitive:string.trim",
      kind: "primitive",
      title: "Trim Text",
      description: "Remove leading and trailing whitespace.",
      inputs: [dataInput("text", "Text", STRING_TYPE, true, { description: "Text to trim.", defaultValue: "" })],
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Trimmed text.")]
    },
    {
      typeId: "primitive:string.lowercase",
      kind: "primitive",
      title: "Lowercase Text",
      description: "Convert text to lowercase.",
      inputs: [dataInput("text", "Text", STRING_TYPE, true, { description: "Text to convert.", defaultValue: "" })],
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Lowercase text.")]
    },
    {
      typeId: "primitive:string.uppercase",
      kind: "primitive",
      title: "Uppercase Text",
      description: "Convert text to uppercase.",
      inputs: [dataInput("text", "Text", STRING_TYPE, true, { description: "Text to convert.", defaultValue: "" })],
      outputs: [dataOutput("value", "Value", STRING_TYPE, "Uppercase text.")]
    }
  ];
}

function mathOperationEntries(): AutomationNodeCatalogEntry[] {
  return [
    binaryMathEntry("primitive:math.add", "Add Numbers", "Add Left and Right.", "Sum of Left and Right."),
    binaryMathEntry("primitive:math.subtract", "Subtract Numbers", "Subtract Right from Left.", "Difference between Left and Right."),
    binaryMathEntry("primitive:math.multiply", "Multiply Numbers", "Multiply Left by Right.", "Product of Left and Right."),
    binaryMathEntry("primitive:math.divide", "Divide Numbers", "Divide Left by Right.", "Quotient of Left divided by Right."),
    binaryMathEntry("primitive:math.modulo", "Modulo Numbers", "Return the remainder after dividing Left by Right.", "Remainder after division."),
    binaryMathEntry("primitive:math.power", "Power", "Raise Left to the power of Right.", "Left raised to Right."),
    binaryMathEntry("primitive:math.min", "Minimum", "Return the smaller number.", "Smaller of Left and Right."),
    binaryMathEntry("primitive:math.max", "Maximum", "Return the larger number.", "Larger of Left and Right."),
    unaryMathEntry("primitive:math.abs", "Absolute Value", "Return the absolute value.", "Absolute value."),
    unaryMathEntry("primitive:math.round", "Round Number", "Round to the nearest integer.", "Rounded number."),
    unaryMathEntry("primitive:math.floor", "Floor Number", "Round down to an integer.", "Floored number."),
    unaryMathEntry("primitive:math.ceil", "Ceil Number", "Round up to an integer.", "Ceiling number.")
  ];
}

function binaryMathEntry(typeId: string, title: string, description: string, outputDescription: string): AutomationNodeCatalogEntry {
  return {
    typeId,
    kind: "primitive",
    title,
    description,
    inputs: [
      dataInput("left", "Left", NUMBER_TYPE, true, { description: "Left operand.", defaultValue: 0 }),
      dataInput("right", "Right", NUMBER_TYPE, true, { description: "Right operand.", defaultValue: 0 })
    ],
    outputs: [dataOutput("value", "Value", NUMBER_TYPE, outputDescription)]
  };
}

function unaryMathEntry(typeId: string, title: string, description: string, outputDescription: string): AutomationNodeCatalogEntry {
  return {
    typeId,
    kind: "primitive",
    title,
    description,
    inputs: [dataInput("value", "Value", NUMBER_TYPE, true, { description: "Input number.", defaultValue: 0 })],
    outputs: [dataOutput("value", "Value", NUMBER_TYPE, outputDescription)]
  };
}

function converterEntries(): AutomationNodeCatalogEntry[] {
  return [
    converter("converter:string.toNumber", "String to Number", STRING_TYPE, NUMBER_TYPE),
    converter("converter:number.toString", "Number to String", NUMBER_TYPE, STRING_TYPE),
    converter("converter:boolean.toString", "Boolean to String", BOOLEAN_TYPE, STRING_TYPE),
    converter("converter:object.toString", "Object to String", OBJECT_TYPE, STRING_TYPE),
    converter("converter:string.toObject", "String to Object", STRING_TYPE, OBJECT_TYPE)
  ];
}

function converter(typeId: string, title: string, input: AutomationType, output: AutomationType): AutomationNodeCatalogEntry {
  return {
    typeId,
    kind: "converter",
    title,
    description: `Convert ${input.kind} to ${output.kind}.`,
    inputs: [dataInput("value", "Value", input, true, { description: `Input ${input.kind} value to convert.` })],
    outputs: [dataOutput("value", "Value", output, `Converted ${output.kind} value.`)]
  };
}

function outputPortsForSchema(outputSchema: Record<string, unknown> | undefined, typeService: AutomationTypeService): AutomationPortDescriptor[] {
  const outputType = typeService.schemaToType(outputSchema);
  if (outputType.kind !== "object") {
    return outputType.kind === "unknown" ? [] : [dataOutput("value", "Value", outputType, descriptionFromSchema(outputSchema))];
  }
  return outputPortsForObject("", outputType, outputSchema);
}

function outputPortsForObject(prefix: string, outputType: AutomationType, outputSchema: Record<string, unknown> | undefined): AutomationPortDescriptor[] {
  const propertySchemas = recordOfRecords(outputSchema?.properties);
  return Object.entries(outputType.properties ?? {}).flatMap(([id, type]) => {
    const portId = prefix ? `${prefix}.${id}` : id;
    const schema = propertySchemas[id];
    const label = labelFromSchema(id, schema);
    if (schema?.["x-cloudx-connectable"] === false) {
      return [];
    }
    if (type.kind === "object" && shouldFlattenObjectSchema(schema)) {
      return outputPortsForObject(portId, type, schema);
    }
    if (type.kind === "object") {
      return [];
    }
    return [dataOutput(portId, label, type, descriptionFromSchema(schema) ?? `${label} value returned by this hook.`)];
  });
}

function shouldFlattenObjectSchema(schema: Record<string, unknown> | undefined): boolean {
  return Object.keys(recordOfRecords(schema?.properties)).length > 0 && schema?.["x-cloudx-connectable"] !== true;
}

function withFallbackDescription(metadata: PortMetadata, description: string): PortMetadata {
  return { ...metadata, description: metadata.description ?? description };
}

function defaultSafety(hook: HookDescriptor): AutomationSafety {
  if (hook.owner.kind === "app") {
    return hook.id.includes(".create") || hook.id.includes(".set") || hook.id.includes(".apply") ? "write" : "read";
  }
  return "write";
}

function execInput(id: string, label: string, description?: string): AutomationPortDescriptor {
  return { id, label, kind: "exec", direction: "input", type: EXEC_TYPE, description };
}

function execOutput(id: string, label: string, description?: string): AutomationPortDescriptor {
  return { id, label, kind: "exec", direction: "output", type: EXEC_TYPE, description };
}

function dataInput(id: string, label: string, type: AutomationType, required: boolean, metadata: PortMetadata = {}): AutomationPortDescriptor {
  return { id, label, kind: "data", direction: "input", type, required, ...metadata };
}

function dataOutput(id: string, label: string, type: AutomationType, description?: string, metadata: Pick<PortMetadata, "connectable"> = {}): AutomationPortDescriptor {
  return { id, label, kind: "data", direction: "output", type, description, ...metadata };
}

function titleCase(value: string): string {
  const titled = value
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
  return titled.replace(/\b(Id|Url|Cwd|Ui|Ai|Asr|Api|Http|Https|Json|Iso)\b/g, (match) => match.toUpperCase());
}

function labelFromSchema(id: string, schema: Record<string, unknown> | undefined): string {
  return typeof schema?.title === "string" && schema.title.trim() ? schema.title.trim() : titleCase(id);
}

function recordOfRecords(value: unknown): Record<string, Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, Record<string, unknown>] => typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]))
  );
}

function enumOptions(values: unknown[]): AutomationPortOption[] {
  return values.filter((value): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean").map((value) => ({
    value: String(value),
    label: titleCase(String(value))
  }));
}

function dynamicOptionSource(value: unknown): AutomationDynamicOptionSource | undefined {
  if (
    value === "plugins.all" ||
    value === "plugins.creatable" ||
    value === "workspace.tabs" ||
    value === "workspace.windows" ||
    value === "workspace.panes" ||
    value === "workspace.layoutTemplates" ||
    value === "rulesSkills.templates"
  ) {
    return value;
  }
  return undefined;
}

function descriptionFromSchema(schema: Record<string, unknown> | undefined): string | undefined {
  return typeof schema?.description === "string" ? schema.description : undefined;
}
