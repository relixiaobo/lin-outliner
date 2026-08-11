import { Compile, type Validator } from 'typebox/compile';
import type { Static, TSchema } from 'typebox';
import type { AgentTool } from './types';

const validators = new WeakMap<object, { readonly signature: string; readonly validator: Validator }>();
const MAX_VALIDATION_ERRORS = 5;
const MAX_VALIDATION_ERROR_PART_LENGTH = 240;

export function compileToolParameters(parameters: TSchema): Validator {
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    throw new Error('Tool parameters must be a JSON Schema object.');
  }
  let signature: string;
  try {
    signature = JSON.stringify(parameters);
  } catch {
    throw new Error('Tool parameters must be JSON-serializable.');
  }
  const cached = validators.get(parameters);
  if (cached?.signature === signature) return cached.validator;
  const validator = Compile(parameters);
  validators.set(parameters, { signature, validator });
  return validator;
}

export function validateExactToolArguments<TParameters extends TSchema>(
  tool: AgentTool<TParameters>,
  value: unknown,
): Static<TParameters> {
  const validator = compileToolParameters(tool.parameters);
  if (validator.Check(value)) return value as Static<TParameters>;
  const errors = validator.Errors(value)
    .slice(0, MAX_VALIDATION_ERRORS)
    .map((error) => (
      `${bounded(error.instancePath || '/')} ${bounded(error.message)}`
    ));
  const detail = errors.length > 0 ? errors.join('; ') : 'value does not match the schema';
  throw new Error(`Invalid arguments for tool "${tool.name.slice(0, 80)}": ${detail}`);
}

function bounded(value: string): string {
  return value.length <= MAX_VALIDATION_ERROR_PART_LENGTH
    ? value
    : `${value.slice(0, MAX_VALIDATION_ERROR_PART_LENGTH - 3)}...`;
}
