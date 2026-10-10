import { ValidationError } from '../../lib/errors';

export interface NormalizedUrl {
  rawUrl: string;
  normalizedUrl: string;
  hostname: string;
  pathname: string;
  isHttps: boolean;
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'mc_eid',
  '_ga',
  '_gl',
]);

/**
 * Normalize and validate a URL according to search engine standards.
 */
export function normalizeUrl(inputUrl: string): NormalizedUrl {
  if (!inputUrl || typeof inputUrl !== 'string') {
    throw new ValidationError('URL must be a non-empty string');
  }

  let raw = inputUrl.trim();
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    raw = 'https://' + raw;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(`Invalid URL format: "${inputUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Only HTTP and HTTPS URLs are supported');
  }

  const hostname = parsed.hostname.toLowerCase();
  const isHttps = parsed.protocol === 'https:';

  // Strip tracking parameters
  const params = new URLSearchParams(parsed.search);
  for (const param of Array.from(params.keys())) {
    if (TRACKING_PARAMS.has(param.toLowerCase())) {
      params.delete(param);
    }
  }

  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  parsed.pathname = pathname;
  parsed.search = params.toString();
  parsed.hash = ''; // Drop fragments

  const normalizedUrl = parsed.toString();

  return {
    rawUrl: inputUrl.trim(),
    normalizedUrl,
    hostname,
    pathname,
    isHttps,
  };
}

/**
 * Check if a URL matches a Search Console property (domain or URL prefix).
 */
export function urlMatchesProperty(url: string, siteUrl: string): boolean {
  try {
    const parsed = new URL(url);
    if (siteUrl.startsWith('sc-domain:')) {
      const domain = siteUrl.replace('sc-domain:', '').toLowerCase();
      const host = parsed.hostname.toLowerCase();
      return host === domain || host.endsWith('.' + domain);
    }
    return url.startsWith(siteUrl);
  } catch {
    return false;
  }
}
