export function runtimeEnvironmentContext(
  now = Date.now(),
  timezone = resolvedIanaTimezone(),
): string {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Runtime environment time must be finite');
  const currentDate = dateInTimezone(instant, timezone);
  return [
    '<environment_context>',
    `  <current_date>${currentDate}</current_date>`,
    `  <current_time_utc>${instant.toISOString()}</current_time_utc>`,
    `  <timezone>${escapeXmlText(timezone)}</timezone>`,
    '</environment_context>',
  ].join('\n');
}

export function resolvedIanaTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
}

function dateInTimezone(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) throw new Error(`Could not resolve the current date for ${timezone}`);
  return `${year}-${month}-${day}`;
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
