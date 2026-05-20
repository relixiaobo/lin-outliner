export const WEB_SOURCE_CITATION_GUIDANCE =
  'When web results inform the final answer, cite the relevant result or fetched source URLs as markdown links.';

export const WEB_SEARCH_DESCRIPTION = [
  'Searches the web for current external information and source URLs.',
  '',
  'Usage:',
  '- Use web_search when you do not already have a specific URL, or when local/model knowledge may be stale.',
  '- Search results are source discovery, not final evidence. Use web_fetch on result URLs when you need details, exact dates, quotations, or higher confidence.',
  '- Include the current year, date, product version, place, or entity name in the query when freshness or disambiguation matters.',
  '- Use site for a single-host search. Use recency_days only as a best-effort freshness hint, then verify dates with web_fetch.',
  `- ${WEB_SOURCE_CITATION_GUIDANCE}`,
].join('\n');

export const WEB_SEARCH_QUERY_PARAMETER_DESCRIPTION =
  'The web search query. Natural language and search operators are allowed. Include the current year/date, product version, names, or locations when freshness or disambiguation matters.';

export const WEB_SEARCH_LIMIT_PARAMETER_DESCRIPTION =
  'Maximum search results to return. Use a small limit for focused lookup and a larger limit when comparing sources.';

export const WEB_SEARCH_SITE_PARAMETER_DESCRIPTION =
  'Optional single host to scope the search to, such as example.com. Do not include "site:"; the tool adds it.';

export const WEB_SEARCH_RECENCY_PARAMETER_DESCRIPTION =
  'Optional best-effort freshness hint in days. Use web_fetch on source URLs to verify publication dates or event dates when freshness matters.';

export const WEB_FETCH_DESCRIPTION = [
  'Reads a known web URL and returns page content, matching snippets, metadata, or binary file metadata.',
  '',
  'Usage:',
  '- Use web_fetch when you already have a URL. Use web_search first when you need to discover sources.',
  '- Use format="markdown" by default for readable page content. Use format="text" for plain text, "raw" when exact extracted text matters, and "metadata" when you only need title, description, headings, or links.',
  '- Use query to find matching snippets within a large page instead of reading the whole page.',
  '- Use offset/max_chars and nextOffset to continue reading long pages. Use match_offset and nextMatchOffset to continue find-mode results.',
  '- If binaryFile is returned, use file_read on binaryFile.filePath when you need to inspect supported files such as PDFs or images.',
  '- If the page requires login, is blocked, or redirects to an unexpected host, follow the tool instructions or choose another accessible source.',
  `- ${WEB_SOURCE_CITATION_GUIDANCE}`,
].join('\n');

export const WEB_FETCH_URL_PARAMETER_DESCRIPTION =
  'The absolute http(s) URL to read. Use web_search first if you do not know the URL. http:// URLs are upgraded to https://.';

export const WEB_FETCH_FORMAT_PARAMETER_DESCRIPTION =
  'Output format. Defaults to markdown. Use metadata for title, description, headings, and links; text for plain text; raw when exact extracted text matters.';

export const WEB_FETCH_OFFSET_PARAMETER_DESCRIPTION =
  'Character offset for read mode. Use nextOffset from a previous web_fetch result to continue reading. Default 0.';

export const WEB_FETCH_MAX_CHARS_PARAMETER_DESCRIPTION =
  'Maximum characters returned in read mode. Use this with offset for long pages.';

export const WEB_FETCH_QUERY_PARAMETER_DESCRIPTION =
  'When set, web_fetch uses find mode and returns matching snippets from this page instead of reading from offset.';

export const WEB_FETCH_CONTEXT_PARAMETER_DESCRIPTION =
  'Characters before and after each query match in find mode. Increase this when snippets lack enough surrounding context.';

export const WEB_FETCH_HEAD_LIMIT_PARAMETER_DESCRIPTION =
  'Maximum matches returned in find mode. Use nextMatchOffset from the result to continue.';

export const WEB_FETCH_MATCH_OFFSET_PARAMETER_DESCRIPTION =
  'Skip the first N matches in find mode. Use nextMatchOffset from a previous result to continue. Default 0.';

export const WEB_FETCH_CASE_INSENSITIVE_PARAMETER_DESCRIPTION =
  'Case-insensitive matching in find mode. Default true.';
