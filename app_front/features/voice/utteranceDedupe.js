/** Normalize transcript text into comparable words while retaining the original words. */
function wordsOf(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

/**
 * Decide which candidate words have not already been emitted for this utterance.
 * Comparisons are case-insensitive; emitted text keeps the candidate's casing.
 *
 * @param {string} covered
 * @param {string} candidate
 * @returns {{ emit: string, covered: string }}
 */
export function decideEmit(covered, candidate) {
  const coveredWords = wordsOf(covered);
  const candidateWords = wordsOf(candidate);
  const normalizedCovered = coveredWords.map((word) => word.toLowerCase());
  const normalizedCandidate = candidateWords.map((word) => word.toLowerCase());
  if (!candidateWords.length) return { emit: '', covered: normalizedCovered.join(' ') };
  if (!coveredWords.length) return { emit: candidateWords.join(' '), covered: normalizedCandidate.join(' ') };

  const extendsCovered = normalizedCovered.length <= normalizedCandidate.length
    && normalizedCovered.every((word, index) => word === normalizedCandidate[index]);
  if (extendsCovered) {
    return {
      emit: candidateWords.slice(coveredWords.length).join(' '),
      covered: normalizedCandidate.join(' '),
    };
  }
  const candidateIsCoveredPrefix = normalizedCandidate.length <= normalizedCovered.length
    && normalizedCandidate.every((word, index) => word === normalizedCovered[index]);
  if (candidateIsCoveredPrefix) {
    return { emit: '', covered: normalizedCovered.join(' ') };
  }
  if (normalizedCandidate[0] === normalizedCovered[0]) {
    const nextCovered = normalizedCandidate.length >= normalizedCovered.length
      ? normalizedCandidate
      : normalizedCovered;
    return { emit: '', covered: nextCovered.join(' ') };
  }
  return { emit: candidateWords.join(' '), covered: normalizedCandidate.join(' ') };
}
