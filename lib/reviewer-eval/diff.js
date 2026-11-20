/**
 * Minimal unified-diff reader for the reviewer eval: which old-side and
 * new-side line ranges did each file change?
 */

/**
 * @param {string} diffText
 * @returns {Array<{ file: string, hunks: Array<{ oldStart: number, oldEnd: number, newStart: number, newEnd: number }> }>}
 */
export function parseUnifiedDiff(diffText) {
  /** @type {Map<string, any>} */
  const files = new Map();
  let current = null;
  for (const line of String(diffText || '').split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = files.get(header[2]) || { file: header[2], hunks: [] };
      files.set(header[2], current);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    const oldStart = Number(hunk[1]);
    const oldLen = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const newStart = Number(hunk[3]);
    const newLen = hunk[4] === undefined ? 1 : Number(hunk[4]);
    current.hunks.push({
      oldStart,
      oldEnd: Math.max(oldStart, oldStart + oldLen - 1),
      newStart,
      newEnd: Math.max(newStart, newStart + newLen - 1),
    });
  }
  return [...files.values()].filter((f) => f.hunks.length > 0);
}
