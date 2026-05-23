import type { JsonSchemaLike } from "@cloudx/plugin-api";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";

const ajv = new Ajv({ allErrors: true });
ajv.addKeyword({ keyword: "x-cloudx-option-source", valid: true });
ajv.addKeyword({ keyword: "x-cloudx-connectable", valid: true });
const validators = new WeakMap<JsonSchemaLike, ValidateFunction>();

export function validateObjectSchema(schema: JsonSchemaLike, value: unknown, label: string, valueLabel = "input"): asserts value is Record<string, unknown> {
  if (schema.type !== "object") {
    throw new Error(`Action schema ${label} must be an object schema.`);
  }
  const validate = validatorFor(schema);
  if (validate(value)) {
    return;
  }
  throw new Error(`Action ${label} invalid ${valueLabel}: ${formatAjvErrors(validate.errors ?? [], valueLabel)}`);
}

export function assertObjectRecord(value: unknown, label: string, valueLabel: string): asserts value is Record<string, unknown> {
  if (isObjectRecord(value)) {
    return;
  }
  throw new Error(`Action ${label} ${valueLabel} must be an object.`);
}

function validatorFor(schema: JsonSchemaLike): ValidateFunction {
  const existing = validators.get(schema);
  if (existing) {
    return existing;
  }
  const validate = ajv.compile(schema);
  validators.set(schema, validate);
  return validate;
}

function formatAjvErrors(errors: NonNullable<ValidateFunction["errors"]>, valueLabel: string): string {
  return errors
    .map((error) => {
      if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
        return `missing required ${valueLabel}: ${error.params.missingProperty}`;
      }
      if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") {
        return `does not accept ${valueLabel}: ${error.params.additionalProperty}`;
      }
      const path = error.instancePath || "/";
      return `${path} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
