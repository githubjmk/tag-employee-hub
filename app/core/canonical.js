// Deterministic JSON (sorted keys, no whitespace) so a signed record always
// hashes to the same value no matter which engine wrote it.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
