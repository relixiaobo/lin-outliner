export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const { hostname, protocol } = new URL(baseUrl);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    const host = stripTrailingDot(stripIpv6Brackets(hostname.toLowerCase()));
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}
