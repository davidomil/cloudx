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
          Object.entries(payloadProperties).filter(([id]) => id !== "payload").map(async ([id, type]) => {
            const metadata = await this.portMetadata(propertySchemas[id]);
            return dataOutput(
              id,
              titleCase(id),
              type,
              metadata.description ?? descriptionFromSchema(propertySchemas[id]) ?? `${titleCase(id)} value from the ${trigger.title} trigger payload.`,
              { connectable: metadata.connectable }
            );
          })
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
        this.inputPortsForSchema(id, labelFromSchema(id, propertySchemas[id]), type, propertySchemas[id], required.has(id), inputPortFallbackDescription(hook, id, type))
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
        ...outputPortsForSchema(hook.outputSchema, this.typeService, hook.title)
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
  codeEditor?: AutomationPortDescriptor["codeEditor"];
  description?: string;
  defaultValue?: unknown;
  options?: AutomationPortDescriptor["options"];
  connectable?: boolean;
}

const PYTHON_CODE_COMPLETIONS = [
  {
    label: "cloudx.call_hook",
    type: "function",
    detail: "Queue a CloudX hook call.",
    info: [
      "Queue an automation-exposed CloudX hook call from Python.",
      "",
      "Signature:",
      "cloudx.call_hook(hook_id, input=None, target_tab_id=None)",
      "",
      "Use the registry hook id, such as \"workspace.tabs.create\" or \"jira.issues.search\". Do not include the automation node prefix \"hook:\".",
      "",
      "The Python process writes hook requests to stdout. CloudX removes those request lines from STDOUT and calls the hooks after Python exits successfully. Results are returned on the Hook Results output port in call order.",
      "",
      "Example:",
      "cloudx.call_hook(\"notifications.send\", {\"title\": \"Done\", \"body\": \"Automation finished\"})"
    ].join("\n"),
    apply: "cloudx.call_hook(\"hook.id\", {})"
  },
  {
    label: "call_hook",
    type: "function",
    detail: "Short alias for cloudx.call_hook.",
    info: [
      "Alias for cloudx.call_hook(hook_id, input=None, target_tab_id=None).",
      "",
      "Use the same plain hook id and input object rules as cloudx.call_hook. Hook requests run after Python exits successfully, and returned objects are collected on the Hook Results output port."
    ].join("\n"),
    apply: "call_hook(\"hook.id\", {})"
  },
  {
    label: "json.dumps",
    type: "function",
    detail: "Serialize JSON to STDOUT.",
    info: "Use json.dumps(value) with print(...) when Parse JSON is enabled and the node should expose structured data on the JSON output port.",
    apply: "json.dumps(value)"
  },
  {
    label: "sys.stdin.read",
    type: "function",
    detail: "Read node STDIN.",
    info: "Read the Run Python node's STDIN input as a string. Import sys before calling sys.stdin.read().",
    apply: "sys.stdin.read()"
  }
] satisfies NonNullable<AutomationPortDescriptor["codeEditor"]>["completions"];

const BASH_CODE_COMPLETIONS = [
  {
    label: "set -euo pipefail",
    type: "keyword",
    detail: "Fail on errors, unset variables, and pipeline errors.",
    apply: "set -euo pipefail"
  },
  {
    label: "printf",
    type: "function",
    detail: "Write formatted output.",
    apply: "printf '%s\\n' \"\""
  },
  {
    label: "jq",
    type: "function",
    detail: "Process JSON when jq is installed in the environment.",
    apply: "jq '.'"
  }
] satisfies NonNullable<AutomationPortDescriptor["codeEditor"]>["completions"];

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
    ...stringComparisonEntries(),
    ...mathOperationEntries(),
    ...numberComparisonEntries(),
    {
      typeId: "primitive:sleep",
      kind: "primitive",
      title: "Sleep",
      description: "Delay program flow for a bounded number of milliseconds.",
      inputs: [
        execInput("exec", "Run", "Incoming program-flow step."),
        dataInput("durationMs", "Duration", NUMBER_TYPE, true, { description: "Delay duration in milliseconds.", defaultValue: 1000 })
      ],
      outputs: [execOutput("exec", "Done", "Continue after the delay completes.")]
    },
    {
      typeId: "primitive:python.exec",
      kind: "primitive",
      title: "Run Python",
      description: "Run Python code in a bounded subprocess without an implicit shell.",
      safety: "external",
      inputs: [
        execInput("exec", "Run", "Incoming program-flow step."),
        dataInput("code", "Code", STRING_TYPE, true, {
          description: "Python source code passed to python3 -c. Use cloudx.call_hook(hook_id, input) to invoke automation-exposed CloudX hooks.",
          codeEditor: { language: "python", minHeight: 260, completions: PYTHON_CODE_COMPLETIONS }
        }),
        dataInput("stdin", "STDIN", STRING_TYPE, false, { description: "Optional UTF-8 stdin passed to the Python process.", defaultValue: "" }),
        dataInput("cwd", "CWD", STRING_TYPE, false, { description: "Working directory. Relative paths resolve from the first configured CloudX root." }),
        dataInput("timeoutMs", "Timeout", NUMBER_TYPE, false, { description: "Process timeout in milliseconds.", defaultValue: 30_000 }),
        dataInput("cloudxHooks", "CloudX Hooks", BOOLEAN_TYPE, false, { description: "Expose cloudx.call_hook and call_hook helpers in the Python process.", defaultValue: true }),
        dataInput("parseJson", "Parse JSON", BOOLEAN_TYPE, false, { description: "Parse stdout as JSON and expose it on the JSON output port.", defaultValue: false })
      ],
      outputs: [
        execOutput("exec", "Done", "Continue after the Python process exits with code 0."),
        dataOutput("stdout", "STDOUT", STRING_TYPE, "Captured standard output."),
        dataOutput("stderr", "STDERR", STRING_TYPE, "Captured standard error."),
        dataOutput("exitCode", "Exit Code", NUMBER_TYPE, "Numeric process exit code."),
        dataOutput("json", "JSON", UNKNOWN_TYPE, "Parsed stdout JSON when Parse JSON is enabled."),
        dataOutput("hookResults", "Hook Results", ARRAY_TYPE, "Results returned by queued cloudx.call_hook calls."),
        dataOutput("hookResultCount", "Hook Count", NUMBER_TYPE, "Number of CloudX hook calls executed.")
      ]
    },
    {
      typeId: "primitive:bash.exec",
      kind: "primitive",
      title: "Run Bash",
      description: "Run bash commands in a bounded subprocess.",
      safety: "external",
      inputs: [
        execInput("exec", "Run", "Incoming program-flow step."),
        dataInput("script", "Script", STRING_TYPE, true, {
          description: "Bash script passed to bash --noprofile --norc -euo pipefail -c.",
          codeEditor: { language: "bash", minHeight: 220, completions: BASH_CODE_COMPLETIONS }
        }),
        dataInput("stdin", "STDIN", STRING_TYPE, false, { description: "Optional UTF-8 stdin passed to the bash process.", defaultValue: "" }),
        dataInput("cwd", "CWD", STRING_TYPE, false, { description: "Working directory. Relative paths resolve from the first configured CloudX root." }),
        dataInput("timeoutMs", "Timeout", NUMBER_TYPE, false, { description: "Process timeout in milliseconds.", defaultValue: 30_000 }),
        dataInput("parseJson", "Parse JSON", BOOLEAN_TYPE, false, { description: "Parse stdout as JSON and expose it on the JSON output port.", defaultValue: false })
      ],
      outputs: [
        execOutput("exec", "Done", "Continue after the bash process exits with code 0."),
        dataOutput("stdout", "STDOUT", STRING_TYPE, "Captured standard output."),
        dataOutput("stderr", "STDERR", STRING_TYPE, "Captured standard error."),
        dataOutput("exitCode", "Exit Code", NUMBER_TYPE, "Numeric process exit code."),
        dataOutput("json", "JSON", UNKNOWN_TYPE, "Parsed stdout JSON when Parse JSON is enabled.")
      ]
    },
    {
      typeId: "primitive:codex.exec",
      kind: "primitive",
      title: "Run Codex Exec",
      description: "Run Codex non-interactively in a bounded subprocess.",
      safety: "external",
      inputs: [
        execInput("exec", "Run", "Incoming program-flow step."),
        dataInput("prompt", "Prompt", STRING_TYPE, true, { description: "Task prompt passed to codex exec." }),
        dataInput("stdin", "STDIN", STRING_TYPE, false, { description: "Optional UTF-8 stdin passed as extra context.", defaultValue: "" }),
        dataInput("cwd", "CWD", STRING_TYPE, false, { description: "Working directory. Relative paths resolve from the first configured CloudX root." }),
        dataInput("timeoutMs", "Timeout", NUMBER_TYPE, false, { description: "Process timeout in milliseconds.", defaultValue: 300_000 }),
        dataInput("profile", "Profile", STRING_TYPE, false, { description: "Optional Codex profile or template name passed with --profile." }),
        dataInput("model", "Model", STRING_TYPE, false, { description: "Optional Codex model override passed with --model." }),
        dataInput("sandbox", "Sandbox", STRING_TYPE, false, { description: "Codex sandbox mode.", defaultValue: "read-only", options: { values: enumOptions(["read-only", "workspace-write", "danger-full-access"]) } }),
        dataInput("approvalPolicy", "Approval", STRING_TYPE, false, { description: "Codex approval policy.", defaultValue: "never", options: { values: enumOptions(["untrusted", "on-request", "never"]) } }),
        dataInput("ephemeral", "Ephemeral", BOOLEAN_TYPE, false, { description: "Pass --ephemeral so the run does not persist session rollout files.", defaultValue: true }),
        dataInput("json", "JSONL", BOOLEAN_TYPE, false, { description: "Run codex exec with --json and parse stdout JSONL events.", defaultValue: false }),
        dataInput("skipGitRepoCheck", "Skip Git Check", BOOLEAN_TYPE, false, { description: "Pass --skip-git-repo-check for trusted non-repository workspaces.", defaultValue: false })
      ],
      outputs: [
        execOutput("exec", "Done", "Continue after codex exec exits with code 0."),
        dataOutput("finalMessage", "Final Message", STRING_TYPE, "Final Codex response."),
        dataOutput("stdout", "STDOUT", STRING_TYPE, "Captured standard output."),
        dataOutput("stderr", "STDERR", STRING_TYPE, "Captured standard error and progress output."),
        dataOutput("exitCode", "Exit Code", NUMBER_TYPE, "Numeric process exit code."),
        dataOutput("jsonEvents", "JSON Events", ARRAY_TYPE, "Parsed JSONL events when JSONL is enabled.")
      ]
    },
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

function stringComparisonEntries(): AutomationNodeCatalogEntry[] {
  return [
    {
      typeId: "primitive:string.compare",
      kind: "primitive",
      title: "Compare Text",
      description: "Compare text for equality, containment, prefix, or suffix.",
      inputs: [
        dataInput("left", "Left", STRING_TYPE, true, { description: "Text to compare.", defaultValue: "" }),
        dataInput("right", "Right", STRING_TYPE, true, { description: "Comparison text.", defaultValue: "" }),
        dataInput("operator", "Operator", STRING_TYPE, true, {
          description: "Text comparison operation.",
          defaultValue: "equals",
          options: {
            values: [
              { value: "equals", label: "Equals" },
              { value: "notEquals", label: "Not Equals" },
              { value: "contains", label: "Contains" },
              { value: "startsWith", label: "Starts With" },
              { value: "endsWith", label: "Ends With" }
            ]
          }
        }),
        dataInput("caseSensitive", "Case Sensitive", BOOLEAN_TYPE, false, { description: "Compare uppercase and lowercase letters as distinct.", defaultValue: true })
      ],
      outputs: [dataOutput("value", "Value", BOOLEAN_TYPE, "Boolean comparison result.")]
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

function numberComparisonEntries(): AutomationNodeCatalogEntry[] {
  return [
    {
      typeId: "primitive:number.compare",
      kind: "primitive",
      title: "Compare Numbers",
      description: "Compare two numbers for equality or order.",
      inputs: [
        dataInput("left", "Left", NUMBER_TYPE, true, { description: "Left operand.", defaultValue: 0 }),
        dataInput("right", "Right", NUMBER_TYPE, true, { description: "Right operand.", defaultValue: 0 }),
        dataInput("operator", "Operator", STRING_TYPE, true, {
          description: "Numeric comparison operation.",
          defaultValue: "equals",
          options: {
            values: [
              { value: "equals", label: "Equals" },
              { value: "notEquals", label: "Not Equals" },
              { value: "lessThan", label: "Less Than" },
              { value: "lessThanOrEqual", label: "Less Than Or Equal" },
              { value: "greaterThan", label: "Greater Than" },
              { value: "greaterThanOrEqual", label: "Greater Than Or Equal" }
            ]
          }
        })
      ],
      outputs: [dataOutput("value", "Value", BOOLEAN_TYPE, "Boolean comparison result.")]
    },
    {
      typeId: "primitive:number.range",
      kind: "primitive",
      title: "Number In Range",
      description: "Check whether a number is inside or outside a range.",
      inputs: [
        dataInput("value", "Value", NUMBER_TYPE, true, { description: "Number to test.", defaultValue: 0 }),
        dataInput("min", "Minimum", NUMBER_TYPE, true, { description: "Range lower bound.", defaultValue: 0 }),
        dataInput("max", "Maximum", NUMBER_TYPE, true, { description: "Range upper bound.", defaultValue: 1 }),
        dataInput("mode", "Mode", STRING_TYPE, true, {
          description: "Range inclusion mode.",
          defaultValue: "inclusive",
          options: {
            values: [
              { value: "inclusive", label: "Inclusive" },
              { value: "exclusive", label: "Exclusive" },
              { value: "outsideInclusive", label: "Outside Inclusive" },
              { value: "outsideExclusive", label: "Outside Exclusive" }
            ]
          }
        })
      ],
      outputs: [dataOutput("value", "Value", BOOLEAN_TYPE, "Boolean range result.")]
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

function inputPortFallbackDescription(hook: HookDescriptor, id: string, type: AutomationType): string {
  const label = titleCase(id);
  const jiraDescription = jiraInputPortDescription(hook.id, id);
  if (jiraDescription) {
    return jiraDescription;
  }
  const documentationDescription = documentationInputPortDescription(hook.id, id);
  if (documentationDescription) {
    return documentationDescription;
  }
  const commonDescription = commonInputPortDescription(id);
  if (commonDescription) {
    return commonDescription;
  }
  if (type.kind === "boolean") {
    return `${label} flag used by ${hook.title}.`;
  }
  if (type.kind === "array") {
    return `${label} list used by ${hook.title}.`;
  }
  if (type.kind === "object") {
    return `${label} object sent to ${hook.title}.`;
  }
  return `${label} value used by ${hook.title}.`;
}

function jiraInputPortDescription(hookId: string, id: string): string | undefined {
  if (!hookId.startsWith("jira.")) {
    return undefined;
  }
  const descriptions: Record<string, string> = {
    issueIdOrKey: "Jira issue key or numeric issue ID this node reads or modifies.",
    issueKey: "Jira issue key used by this node.",
    projectKey: "Jira project key for the issue operation.",
    issueType: "Jira issue type name, such as Task, Bug, Story, or Epic.",
    summary: "Jira issue summary text.",
    description: "Jira issue description text.",
    parentKey: "Parent Jira issue key for a child issue.",
    epicKey: "Epic Jira issue key for the issue relationship.",
    priority: "Jira priority name to set on the issue.",
    assigneeAccountId: "Jira account ID to assign to the issue.",
    labels: "Jira labels to add or replace on the issue.",
    customFields: "Additional Jira create fields keyed by field ID.",
    fields: "Jira REST fields object for fields accepted by this operation or transition screen.",
    update: "Jira REST update object for update operations such as labels or comments.",
    body: "Plain-text Jira comment body.",
    comment: "Plain-text Jira comment added while performing this operation.",
    transitionId: "Exact Jira transition ID to execute.",
    transitionName: "Exact Jira transition name to execute, matched case-insensitively.",
    targetStatus: "Exact target Jira status name to transition to, matched case-insensitively.",
    expandFields: "Include Jira transition-screen field metadata in the transition list.",
    inwardIssueKey: "Jira issue key for the inward side of the link.",
    outwardIssueKey: "Jira issue key for the outward side of the link.",
    typeName: "Jira issue link type name, such as Relates.",
    commentId: "Jira comment ID to include in the generated issue URL.",
    jql: "JQL query to execute.",
    maxResults: hookId === "jira.issues.searchAll" ? "Maximum total Jira issues to return across pages." : "Maximum Jira issues to return for this page.",
    pageSize: "Number of Jira issues requested per page.",
    nextPageToken: "Jira page token used to continue a previous search."
  };
  return descriptions[id];
}

function documentationInputPortDescription(hookId: string, id: string): string | undefined {
  if (!hookId.startsWith("documentation.")) {
    return undefined;
  }
  const descriptions: Record<string, string> = {
    path: hookId.includes(".archive.") ? "Filesystem path for the documentation archive file." : "File or directory path to ingest into the documentation archive.",
    cwd: "Base directory used to resolve a relative documentation path.",
    confirmation: "Required confirmation text for the destructive archive replacement.",
    query: "Search query sent to the documentation archive.",
    limit: "Maximum documentation search results to return.",
    states: "Documentation record states to include in the search.",
    sourceTypes: "Documentation source types to include in the search.",
    collection: "Documentation collection name used to group records.",
    mode: "Documentation search mode.",
    url: "Source URL to ingest into the documentation archive.",
    title: "Human-readable documentation record title.",
    text: "Raw text content to ingest as a documentation record.",
    uri: "Original source URI stored with the ingested text record.",
    sourceType: "Documentation source type stored with the record.",
    tags: "Tags stored with the documentation record.",
    transcript: "Transcript text associated with the ingested URL.",
    acceptGeneratedCodeDocumentation: "Allow generated summaries when ingesting source-code-heavy inputs.",
    retainRawCodeArtifacts: "Retain raw code artifacts during documentation ingestion when allowed.",
    documentId: "Documentation record ID to update or remove.",
    state: "New documentation record state.",
    reason: "Reason recorded for the documentation state change."
  };
  return descriptions[id];
}

function commonInputPortDescription(id: string): string | undefined {
  const descriptions: Record<string, string> = {
    targetTabId: "Workspace tab ID that receives this hook call.",
    pluginId: "Workspace plugin ID used by this operation.",
    tabId: "Workspace tab ID used by this operation.",
    windowId: "Workspace window ID used by this operation.",
    paneId: "Workspace pane ID used by this operation.",
    templateId: "Rules/skills or layout template ID used by this operation.",
    cwd: "Working directory used by this operation.",
    defaultCwd: "Default working directory for the created workspace window.",
    createDirectory: "Create the target directory when it does not already exist.",
    name: "Name assigned by this operation.",
    title: "Title assigned by this operation.",
    reason: "Reason recorded by this operation.",
    timeoutMs: "Maximum time this operation may run before it is cancelled.",
    command: "Shell command to execute.",
    text: "Text passed to this operation.",
    key: "Key press sent to the target tab.",
    submit: "Submit the entered text after typing it.",
    quietMs: "Quiet period required before the target is considered ready.",
    includeSizes: "Include filesystem size information in the returned project state.",
    mode: "Mode selected for this operation."
  };
  return descriptions[id];
}

function outputPortsForSchema(outputSchema: Record<string, unknown> | undefined, typeService: AutomationTypeService, sourceTitle: string): AutomationPortDescriptor[] {
  const outputType = typeService.schemaToType(outputSchema);
  if (outputType.kind !== "object") {
    return outputType.kind === "unknown" ? [] : [dataOutput("value", "Value", outputType, descriptionFromSchema(outputSchema) ?? `Value returned by ${sourceTitle}.`)];
  }
  return outputPortsForObject("", outputType, outputSchema, sourceTitle);
}

function outputPortsForObject(prefix: string, outputType: AutomationType, outputSchema: Record<string, unknown> | undefined, sourceTitle: string): AutomationPortDescriptor[] {
  const propertySchemas = recordOfRecords(outputSchema?.properties);
  return Object.entries(outputType.properties ?? {}).flatMap(([id, type]) => {
    const portId = prefix ? `${prefix}.${id}` : id;
    const schema = propertySchemas[id];
    const label = labelFromSchema(id, schema);
    if (schema?.["x-cloudx-connectable"] === false) {
      return [];
    }
    if (type.kind === "object" && shouldFlattenObjectSchema(schema)) {
      return outputPortsForObject(portId, type, schema, sourceTitle);
    }
    if (type.kind === "object") {
      return [];
    }
    return [dataOutput(portId, label, type, descriptionFromSchema(schema) ?? `${label} returned by ${sourceTitle}.`)];
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
