/** A real scheme, not the "localhost:3000" shape where the colon is a port. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** An IPv6 host like "[::1]", which contains the colons a split would eat. */
const BRACKET_HOST_PATTERN = /^\[[^\]]*\]/;

/** The first character that ends a hostname: path, port, query or fragment. */
const HOST_END_PATTERN = /[/:?#]/;

const WHITESPACE_PATTERN = /\s/;

const LOCAL_HOSTNAMES = new Set(["0.0.0.0", "127.0.0.1", "[::1]", "localhost"]);

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}

/** True only for a parseable http(s) URL — the sole kind the view will load. */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Turns what a person types into the URL the view loads, or null if it cannot
 * be one. Bare local addresses get http (dev servers rarely speak TLS), bare
 * remote hosts get https, and the result is canonical — the same string
 * `webContents.getURL()` reports — so "already there" checks compare equal.
 */
export function normalizeViewUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let candidate = trimmed;
  if (!SCHEME_PATTERN.test(candidate)) {
    const bracketHost = candidate.match(BRACKET_HOST_PATTERN)?.[0];
    const bareHost = bracketHost ?? candidate.split(HOST_END_PATTERN, 1)[0];
    candidate = `${isLocalHostname(bareHost) ? "http" : "https"}://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (WHITESPACE_PATTERN.test(url.host)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
