/**
 * ============================================================================
 * JSON SCHEMA SUBSET VALIDATOR FOR PACK TESTS (jsonSchemaSubset.ts)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Validates compendium data against the committed `schemas/*.schema.json`
 * files without adding a validator dependency to the web workspace. Tests
 * validate against the real schema files the server will mirror, not a
 * TypeScript copy of them.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Fail Closed On Unknown Keywords`:
 *      - Any keyword outside the supported subset throws, so a schema can
 *        never rely on a rule these tests silently skip.
 *   2. `Local References Only`:
 *      - `$ref` resolves `#/$defs/<name>` inside the same document.
 * ============================================================================
 */

type Schema = Record<string, unknown>;

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$comment", "$defs"]);
const SUPPORTED = new Set([
  "type",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "required",
  "properties",
  "additionalProperties",
  "minProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "$ref",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === "number" && actual === "integer");
}

/**
 * Returns every violation of `value` against `schema` as `"<json path>: <reason>"`.
 * An empty array means the value is valid.
 */
export function validateAgainstSchema(root: Schema, value: unknown): string[] {
  const errors: string[] = [];

  const visit = (schema: Schema, data: unknown, path: string): void => {
    for (const key of Object.keys(schema)) {
      if (!ANNOTATIONS.has(key) && !SUPPORTED.has(key)) {
        throw new Error(`Unsupported JSON Schema keyword '${key}' at ${path}`);
      }
    }
    if (typeof schema.$ref === "string") {
      const name = schema.$ref.replace(/^#\/\$defs\//, "");
      const target = (root.$defs as Record<string, Schema> | undefined)?.[name];
      if (!target) throw new Error(`Unresolved $ref ${schema.$ref}`);
      visit(target, data, path);
      return;
    }
    if (typeof schema.type === "string" && !matchesType(data, schema.type)) {
      errors.push(`${path}: expected ${schema.type}, got ${typeOf(data)}`);
      return;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(data as never)) {
      errors.push(`${path}: ${JSON.stringify(data)} is not one of ${JSON.stringify(schema.enum)}`);
    }
    if (typeof data === "number") {
      if (typeof schema.minimum === "number" && data < schema.minimum) errors.push(`${path}: ${data} < ${schema.minimum}`);
      if (typeof schema.maximum === "number" && data > schema.maximum) errors.push(`${path}: ${data} > ${schema.maximum}`);
    }
    if (typeof data === "string") {
      if (typeof schema.minLength === "number" && data.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
      if (typeof schema.maxLength === "number" && data.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(data)) {
        errors.push(`${path}: ${JSON.stringify(data)} does not match ${schema.pattern}`);
      }
    }
    if (Array.isArray(data)) {
      if (typeof schema.minItems === "number" && data.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
      if (typeof schema.maxItems === "number" && data.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
      if (schema.uniqueItems === true && new Set(data.map((d) => JSON.stringify(d))).size !== data.length) {
        errors.push(`${path}: items are not unique`);
      }
      if (schema.items && typeof schema.items === "object") {
        data.forEach((item, i) => visit(schema.items as Schema, item, `${path}[${i}]`));
      }
    }
    if (typeOf(data) === "object") {
      const record = data as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const required of (schema.required ?? []) as string[]) {
        if (!(required in record)) errors.push(`${path}: missing required '${required}'`);
      }
      if (typeof schema.minProperties === "number" && Object.keys(record).length < schema.minProperties) {
        errors.push(`${path}: fewer than ${schema.minProperties} properties`);
      }
      for (const [key, child] of Object.entries(record)) {
        if (properties[key]) visit(properties[key], child, `${path}.${key}`);
        else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property '${key}'`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          visit(schema.additionalProperties as Schema, child, `${path}.${key}`);
        }
      }
    }
  };

  visit(root, value, "$");
  return errors;
}
