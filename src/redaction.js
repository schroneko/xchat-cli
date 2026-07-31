const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(?:authorization|cookie|auth[_-]?token|ct0|twid|bearer|(?:conversation|access|refresh|guest|csrf|private|secret)[_-]?token|token|private[_-]?key|secret[_-]?key|password|passphrase|pin)/i;
const MESSAGE_KEY = /^(?:text|new[_-]?text|message[_-]?text|reply[_-]?preview)$/i;

export function redact(value, options = {}) {
  return redactValue(value, options, new WeakMap());
}

export function redactError(error) {
  const safe = {
    name: error?.name ?? "Error",
    message: scrubSecretText(String(error?.message ?? error)),
  };

  for (const key of ["code", "kind", "status", "retryAfter", "exitCode"]) {
    if (error?.[key] !== undefined) {
      safe[key] = redactValue(error[key], {}, new WeakMap());
    }
  }

  if (error?.details !== undefined) {
    safe.details = redact(error.details);
  }

  return safe;
}

export function scrubSecretText(value) {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;}\]]+/gi, `$1${REDACTED}`)
    .replace(/(\bbearer\s+)[A-Za-z0-9%._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/((?:auth_token|ct0|twid)\s*[=:]\s*)[^;\s,}\]]+/gi, `$1${REDACTED}`)
    .replace(/(\b(?:auth[_-]?token|conversation[_-]?token|access[_-]?token|refresh[_-]?token|guest[_-]?token|csrf[_-]?token|private[_-]?key|secret[_-]?key|token|pin|password|passphrase)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi, `$1${REDACTED}`)
    .replace(/(cookie\s*[:=]\s*)[^\n]+/gi, `$1${REDACTED}`);
}

function redactValue(value, options, seen) {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Error) {
    return redactError(value);
  }

  if (typeof value === "string") {
    return scrubSecretText(value);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[circular]";
  }

  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);

  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    if (options.messages && MESSAGE_KEY.test(key) && typeof item === "string") {
      output[key] = `[redacted:${[...item].length}]`;
      continue;
    }
    output[key] = redactValue(item, options, seen);
  }

  return output;
}
