const shaPattern = /^[a-f0-9]{40}$/;
const waitingStates = new Set(['queued', 'running', 'waiting']);
const blockedStates = new Set(['blocked', 'needs-human', 'skipped']);

export function runPrNumber(run) {
  const number = run.prRef?.number;
  if (Number.isSafeInteger(number) && number > 0) return number;
  const url = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/([1-9][0-9]*)$/.exec(run.pullRequestUrl ?? '');
  const fromUrl = Number(url?.[1]);
  return Number.isSafeInteger(fromUrl) ? fromUrl : null;
}

export function classifyRunPr(entry, run, pr) {
  const number = runPrNumber(run);
  const disagreement = reason => ({ status: 'reconcile', reconcileReason: reason });
  if (entry.prNumber !== null && number !== entry.prNumber) {
    return disagreement('The run PR no longer matches the ledger');
  }
  if ((!number && pr) || (number && !pr)) {
    return disagreement('Cezar and GitHub do not agree on the PR');
  }
  if (pr) {
    if (pr.number !== number || pr.baseRefName !== 'integration' ||
        pr.headRefName !== entry.expectedBranch || pr.isCrossRepository !== false) {
      return disagreement('GitHub PR is outside this module branch');
    }
    if (pr.state === 'MERGED') {
      if (!shaPattern.test(pr.mergeCommit?.oid ?? '')) {
        return disagreement('GitHub did not return the merge commit');
      }
      return { status: 'merged', prNumber: number, mergeSha: pr.mergeCommit.oid };
    }
    if (pr.state !== 'OPEN' && pr.state !== 'CLOSED') return disagreement('Unknown GitHub PR state');
    if (pr.state === 'CLOSED' && waitingStates.has(run.status)) {
      return disagreement('The PR was closed while the run was active');
    }
  }
  if (waitingStates.has(run.status)) return { status: 'running', prNumber: number };
  if (run.status === 'failed' || run.status === 'cancelled') {
    const human = run.steps?.some(step => step.id === 'prepare_human' && step.status === 'done');
    return { status: human ? 'needs-human' : 'blocked', prNumber: number };
  }
  return disagreement('The run finished without a verified merge');
}

export function dependencyGate(module, entries, proof) {
  const dependencies = module.dependsOn.filter(id => id !== 'foundation');
  const upstream = dependencies.map(id => ({ id, entry: entries.get(id) }));
  const stopper = upstream.find(({ entry }) => blockedStates.has(entry?.status));
  if (stopper) return { state: 'skip', dependency: stopper.id };
  if (upstream.some(({ entry }) => entry?.status !== 'merged')) return { state: 'wait-upstream' };
  if (upstream.length === 0) return { state: 'ready' };
  if (!proof || !shaPattern.test(proof.tip) || proof.fullE2e?.sha !== proof.tip ||
      !Array.isArray(proof.contains) ||
      upstream.some(({ entry }) => !shaPattern.test(entry.mergeSha ?? '') || !proof.contains.includes(entry.mergeSha))) {
    return { state: 'wait-integration' };
  }
  if (proof.fullE2e.outcome === 'green') return { state: 'ready', integrationSha: proof.tip };
  if (proof.fullE2e.outcome === 'red') return { state: 'integration-red', integrationSha: proof.tip };
  return { state: 'wait-integration' };
}
