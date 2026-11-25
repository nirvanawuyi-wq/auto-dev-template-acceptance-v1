import { reconcile, reserve } from './batch-state.mjs';
import { classifyRunPr, dependencyGate, runPrNumber } from './batch-evidence.mjs';

const workflow = 'module-delivery';
const handled = new Set(['submitting', 'reconcile', 'running']);
const active = new Set(['queued', 'running', 'waiting']);
const integrationWaitMs = 60 * 60 * 1000;
const maxActive = 3;

function markForReconciliation(entry, reason) {
  entry.status = 'reconcile';
  entry.reconcileReason = reason;
}

function taskFor(entry, planSha) {
  return [
    entry.key,
    'Task branch: ' + entry.expectedBranch,
    'Module ID: ' + entry.id,
    'Plan SHA: ' + planSha,
    ...(entry.failedSha ? [
      'Integration e2e failed for ' + entry.failedSha + '. Inspect GitHub Actions run ' + entry.workflowRun + '.',
      'Repair that failure without changing the tests or taking work outside this module.',
    ] : []),
    'Read docs/plan.md and AGENTS.md. Work only on the assigned module and the listed paths.',
    'Approved writable paths:',
    ...entry.writablePaths.map(path => '- ' + path),
    'Preserve test coverage, guardrails and protected paths. Read .ai/prompts/must-human.md before taking any decision.',
  ].join('\n');
}

function recoverEntry(entry, runs, forge) {
  if (!entry.submittedAt || !reconcile(entry, runs, workflow)) return;
  const run = runs.find(candidate => candidate.id === entry.runId);
  try {
    const number = runPrNumber(run);
    if (!number && forge.listOpenPrs(entry.expectedBranch).length > 0) {
      markForReconciliation(entry, 'The branch has a PR that Cezar has not recorded');
      return;
    }
    const pr = number ? forge.readPr(number) : null;
    Object.assign(entry, classifyRunPr(entry, run, pr));
    if (pr && entry.status !== 'reconcile') {
      entry.prUrl = pr.url;
      entry.headSha = pr.headRefOid;
    }
  } catch {
    markForReconciliation(entry, 'GitHub could not verify the run PR');
  }
}

async function submitEntry(entry, runs, ledger, { cezar, forge, save, now }) {
  const sameRequest = runs.some(run => run.workflow === workflow &&
    typeof run.task === 'string' && run.task.split('\n', 1)[0] === entry.key);
  if (sameRequest || forge.listOpenPrs(entry.expectedBranch).length > 0) {
    markForReconciliation(entry, 'A run or PR exists before this batch recorded an attempt');
    save(ledger);
    return false;
  }

  reserve(entry, now);
  save(ledger);
  let accepted;
  try {
    accepted = await cezar.submit(workflow, taskFor(entry, ledger.planSha));
  } catch {
    // An unknown response may hide a successful acceptance. A later read resolves the saved intent.
    return true;
  }
  entry.runId = accepted.id;
  entry.status = 'running';
  save(ledger);
  return true;
}

function recordRepair(ledger, failedSha, workflowRun) {
  if (ledger.repairs.some(entry => entry.failedSha === failedSha)) return;
  const source = ledger.modules.find(entry => entry.mergeSha === failedSha);
  if (!source) {
    ledger.repairs.push({
      id: 'integration', failedSha, workflowRun, status: 'needs-human',
      reason: 'Integration e2e failed at a commit outside the batch merge records',
    });
    return;
  }
  const sequence = 1 + ledger.repairs.filter(entry => entry.id === source.id).length;
  ledger.repairs.push({
    id: source.id, writablePaths: source.writablePaths, failedSha, workflowRun,
    key: 'Cezar batch ' + ledger.project + '/' + ledger.batch + ' repair ' + failedSha,
    expectedBranch: 'fix/' + source.id + '-' + sequence,
    status: 'pending', runId: null, prNumber: null,
  });
}

export async function deliverModules(ledger, services) {
  const { cezar, forge, save, now } = services;
  ledger.repairs ??= [];
  const runs = await cezar.listRuns();
  for (const entry of [...ledger.modules, ...ledger.repairs]) {
    if (!handled.has(entry.status)) continue;
    recoverEntry(entry, runs, forge);
    save(ledger);
  }

  const entries = new Map(ledger.modules.map(entry => [entry.id, entry]));
  const pending = ledger.modules.filter(entry => entry.status === 'pending');
  let proof = null;
  if (pending.some(entry => dependencyGate(entry, entries, null).state === 'wait-integration') ||
      ledger.repairs.some(entry => entry.status === 'pending')) {
    const merged = ledger.modules.filter(entry => entry.status === 'merged').map(entry => entry.mergeSha);
    try {
      proof = forge.integrationProof(merged);
    } catch {
      // Keep these jobs pending and let unrelated jobs proceed.
    }
  }
  const integrationRed = new Map();
  let available = maxActive - runs.filter(run => active.has(run.status)).length;
  const beforeDeadline = Date.parse(now) < Date.parse(ledger.deadlineAt);
  for (const entry of pending) {
    const gate = dependencyGate(entry, entries, proof);
    if (gate.state === 'skip') {
      entry.status = 'skipped';
      entry.reason = 'Upstream module did not complete: ' + gate.dependency;
      save(ledger);
    }
    if (gate.state === 'integration-red' || gate.state === 'wait-integration') {
      entry.integrationWaitSince ??= now;
      if (Date.parse(now) - Date.parse(entry.integrationWaitSince) >= integrationWaitMs) {
        entry.status = 'skipped';
        entry.reason = 'Integration e2e was unavailable or unsuccessful for one hour';
      } else if (gate.state === 'integration-red') {
        integrationRed.set(gate.integrationSha, proof.fullE2e.workflowRun);
      }
      save(ledger);
    }
    if (gate.state !== 'ready' || available <= 0 || !beforeDeadline) continue;
    if (gate.integrationSha) entry.integrationSha = gate.integrationSha;
    if (await submitEntry(entry, runs, ledger, services)) available--;
  }

  for (const [sha, workflowRun] of integrationRed) recordRepair(ledger, sha, workflowRun);
  if (integrationRed.size > 0) save(ledger);
  for (const repair of ledger.repairs) {
    if (repair.status !== 'pending' || !proof) continue;
    if (proof.tip !== repair.failedSha || proof.fullE2e?.outcome === 'green') {
      repair.status = 'skipped';
      repair.reason = 'The failed integration revision is no longer current or its rerun passed';
      save(ledger);
    } else if (available > 0 && beforeDeadline && proof.fullE2e?.outcome === 'red') {
      if (await submitEntry(repair, runs, ledger, services)) available--;
    }
  }
}
