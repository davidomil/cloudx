import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const schemaRoot = path.join(repoRoot, ".agents", "schemas");
const validators = new Map();

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

export function validateSchema(schemaName, value) {
  const validate = validatorFor(schemaName);
  if (!validate(value)) {
    throw new Error(
      `${schemaName} validation failed: ${formatErrors(validate.errors)}`,
    );
  }
  return value;
}

export function compileAllSchemas() {
  return fs
    .readdirSync(schemaRoot)
    .filter((name) => name.endsWith(".schema.json"))
    .sort()
    .map((name) => {
      validatorFor(name.slice(0, -".schema.json".length));
      return name;
    });
}

export function schemaPath(schemaName) {
  return path.join(schemaRoot, `${schemaName}.schema.json`);
}

function validatorFor(schemaName) {
  if (!/^[a-z][a-z0-9-]*$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }
  if (!validators.has(schemaName)) {
    const schema = JSON.parse(fs.readFileSync(schemaPath(schemaName), "utf8"));
    validators.set(schemaName, ajv.compile(schema));
  }
  return validators.get(schemaName);
}

function formatErrors(errors = []) {
  return errors
    .map((error) => {
      const extra =
        error.keyword === "additionalProperties"
          ? ` ${error.params.additionalProperty}`
          : "";
      return `${error.instancePath || "/"}${extra} ${error.message}`;
    })
    .join("; ");
}
