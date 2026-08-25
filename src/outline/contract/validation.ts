import type { Static, TSchema } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';

const validators = new WeakMap<object, Validator>();

export function outlineSchemaValidator(schema: TSchema): Validator {
  const cached = validators.get(schema);
  if (cached) return cached;
  const validator = Compile(schema);
  validators.set(schema, validator);
  return validator;
}

export function checkOutlineSchema<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  value: unknown,
): value is Static<TSchemaValue> {
  return outlineSchemaValidator(schema).Check(value);
}
