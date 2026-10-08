/**
 * JSON Schema "lite" validator — spec RULE 6 (validate external input).
 * Supports the subset used by tool definitions: type/object/required/
 * properties/items/enum/min/max/pattern/minLength. Deliberately small;
 * full spec compliance is not needed for tool args.
 */
import type { JsonSchema } from '../types/common.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function validateJson(schema: JsonSchema, value: unknown, path = '$'): ValidationResult {
  const errors: string[] = [];

  const expectType = schema.type as string | string[] | undefined;
  if (expectType) {
    const t = typeOf(value);
    const allowed = Array.isArray(expectType) ? expectType : [expectType];
    const ok = allowed.some((a) => (a === 'integer' ? t === 'number' && Number.isInteger(value) : a === t));
    if (!ok) {
      errors.push(`${path}: expected ${allowed.join('|')}, got ${t}`);
      return { ok: false, errors };
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (obj[key] === undefined) errors.push(`${path}: missing required property "${key}"`);
    }
    const props = schema.properties as Record<string, JsonSchema> | undefined;
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (obj[key] !== undefined) errors.push(...validateJson(sub, obj[key], `${path}.${key}`).errors);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) errors.push(`${path}: unknown property "${key}"`);
        }
      }
    }
  }

  if (typeOf(value) === 'array') {
    const items = schema.items as JsonSchema | undefined;
    if (items) {
      const arr = value as unknown[];
      for (let i = 0; i < arr.length; i++) errors.push(...validateJson(items, arr[i], `${path}[${i}]`).errors);
    }
    if (typeof schema.minItems === 'number' && (value as unknown[]).length < schema.minItems) {
      errors.push(`${path}: minItems ${schema.minItems}`);
    }
  }

  if (typeOf(value) === 'string') {
    const s = value as string;
    if (typeof schema.minLength === 'number' && s.length < schema.minLength) errors.push(`${path}: minLength ${schema.minLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(s)) errors.push(`${path}: pattern mismatch`);
  }

  if (typeOf(value) === 'number') {
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) errors.push(`${path}: < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) errors.push(`${path}: > maximum ${schema.maximum}`);
  }

  return { ok: errors.length === 0, errors };
}
