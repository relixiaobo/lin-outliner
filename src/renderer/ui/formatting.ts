export type FormatterLocale = string | undefined;

const FORMATTER_CACHE_LIMIT = 32;
const UNDEFINED_LOCALE_KEY = 'locale:undefined';
const DEFAULT_LOCALE_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
};

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();

export function dateTimeFormatter(
  locale: FormatterLocale,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return cachedFormatter(
    dateTimeFormatters,
    formatterKey(locale, options),
    () => new Intl.DateTimeFormat(locale, options),
  );
}

export function numberFormatter(
  locale?: FormatterLocale,
  options: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
  return cachedFormatter(
    numberFormatters,
    formatterKey(locale, options),
    () => new Intl.NumberFormat(locale, options),
  );
}

export function formatDateTime(
  value: number | Date,
  locale: FormatterLocale,
  options: Intl.DateTimeFormatOptions,
): string {
  return dateTimeFormatter(locale, options).format(dateValue(value));
}

export function formatNumber(
  value: number,
  locale?: FormatterLocale,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormatter(locale, options).format(value);
}

export function formatLocaleDateTime(value: number | Date, locale?: FormatterLocale): string {
  const date = dateValue(value);
  return Number.isFinite(date.getTime())
    ? dateTimeFormatter(locale, DEFAULT_LOCALE_DATE_TIME_OPTIONS).format(date)
    : date.toLocaleString(locale);
}

export function clearFormatterCachesForTests(): void {
  dateTimeFormatters.clear();
  numberFormatters.clear();
}

export function formatterCacheStatsForTests(): { dateTime: number; number: number } {
  return {
    dateTime: dateTimeFormatters.size,
    number: numberFormatters.size,
  };
}

function cachedFormatter<T>(
  cache: Map<string, T>,
  key: string,
  create: () => T,
): T {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const formatter = create();
  cache.set(key, formatter);
  if (cache.size > FORMATTER_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  return formatter;
}

function formatterKey(
  locale: FormatterLocale,
  options: Intl.DateTimeFormatOptions | Intl.NumberFormatOptions,
): string {
  return `${locale === undefined ? UNDEFINED_LOCALE_KEY : `locale:${locale}`}\0${optionsKey(options)}`;
}

function optionsKey(options: Intl.DateTimeFormatOptions | Intl.NumberFormatOptions): string {
  return Object.keys(options)
    .sort()
    .flatMap((key) => {
      const value = options[key as keyof typeof options];
      return value === undefined ? [] : [`${key}:${String(value)}`];
    })
    .join('\0');
}

function dateValue(value: number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}
