export function proposalActions(card, human, busy = false) {
  return human === true && !busy && card?.kind === 'doc_proposal' && card.status === 'pending';
}

export function proposalPreview(card, limit = 16000) {
  const evidence = card.evidence?.find((entry) => entry.type === 'doc_diff');
  const diff = String(evidence?.diff || '');
  return { text: diff.slice(0, limit), truncated: evidence?.truncated === true || diff.length > limit };
}

export function proposalStatusKey(card) {
  if (card.status === 'decided') return card.optionId === 'apply' ? 'docs.proposals.applied' : 'docs.proposals.rejected';
  return `docs.proposals.${['pending', 'stale', 'deciding'].includes(card.status) ? card.status : 'stale'}`;
}
