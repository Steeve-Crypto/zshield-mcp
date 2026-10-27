/**
 * Redaction of secrets and local paths from anything the server returns, logs, or
 * writes to the audit log. Values are registered once at startup; redact() replaces
 * every occurrence, longest first.
 */

const entries = new Map<string, string>();

/** Register a value to hide and the label that replaces it. Values under 4 characters are ignored. */
export function registerRedaction(value: string | undefined, label: string): void {
  if (!value || value.length < 4) return;
  entries.set(value, label);
}

/** Forget every registered value. For tests. */
export function resetRedactions(): void {
  entries.clear();
}

/** Replace every registered value in `text`. */
export function redact(text: string): string {
  if (entries.size === 0 || !text) return text;
  let out = text;
  for (const [value, label] of [...entries].sort((a, b) => b[0].length - a[0].length)) {
    if (out.includes(value)) out = out.split(value).join(label);
  }
  return out;
}

/** Copy of `value` with redact() applied to every string inside it. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}

/** Whether a server URL carries credentials: a user, a password, a query string, or a fragment. */
export function urlHasCredentials(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "";
  } catch {
    return false;
  }
}

/** A server URL safe to show: credentials, query, and fragment replaced. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const cred = u.username || u.password ? "[credentials]@" : "";
    const query = u.search ? "?[redacted]" : "";
    return `${u.protocol}//${cred}${u.host}${u.pathname === "/" ? "" : u.pathname}${query}`;
  } catch {
    return "[server url]";
  }
}

/**
 * Register a lightwalletd URL: the full URL and each secret part of it (user, password,
 * query values, fragment), in raw and percent-decoded forms, so none of them leaks
 * through an error or a zingo-cli message.
 */
export function registerServerUrl(url: string | undefined): void {
  if (!url || !urlHasCredentials(url)) return;
  const shown = displayUrl(url);
  registerRedaction(url, shown);
  try {
    const u = new URL(url);
    registerRedaction(u.href, shown);
    const parts = [u.username, u.password, u.search.slice(1), u.hash.slice(1)];
    for (const [, v] of u.searchParams) parts.push(v);
    for (const p of parts) {
      registerRedaction(p, "[redacted]");
      try {
        registerRedaction(decodeURIComponent(p), "[redacted]");
      } catch {
        // Not valid percent encoding; the raw form is registered.
      }
    }
  } catch {
    // Not a URL; the raw value is registered.
  }
}
