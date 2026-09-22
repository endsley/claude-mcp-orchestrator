/**
 * A deliberately conservative estimate. It keeps context below the requested
 * budget without importing a tokenizer into latency-sensitive voice requests.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function trimToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  const candidate = text.slice(0, Math.max(0, maxChars - 1));
  const boundary = candidate.lastIndexOf('\n');
  return `${boundary > maxChars * 0.55 ? candidate.slice(0, boundary) : candidate}…`;
}

/**
 * Longest input any lookup will consider.
 *
 * similarity() is whole-string Levenshtein, which is O(n*m), and it runs once
 * per label per candidate - roughly seven labels across every known project or
 * computer. The MCP body limit is 256KB, and measured on the real corpus a
 * find_project query costs about 27ms per KB, so an unbounded query was around
 * seven seconds of CPU per call. That work is synchronous and on the main
 * thread, so it does not merely make one call slow: it blocks the event loop
 * for every other request, and an authenticated client could hold the server
 * there by repeating the call.
 *
 * Nothing legitimate comes close to this bound. A spoken project or computer
 * reference is a handful of words.
 */
const MAX_LOOKUP_CHARS = 512;

export function normalizeLookup(value: string): string {
  return value
    .slice(0, MAX_LOOKUP_CHARS)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      current[j + 1] = Math.min(
        current[j]! + 1,
        previous[j + 1]! + 1,
        previous[j]! + (left[i] === right[j] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

export function similarity(left: string, right: string): number {
  const a = normalizeLookup(left);
  const b = normalizeLookup(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}
