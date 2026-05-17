const CSS_HEX_COLOR_BODY = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isCssHexColorToken(value: string): boolean {
  const token = value.startsWith('#') ? value.slice(1) : value;
  return CSS_HEX_COLOR_BODY.test(token);
}
