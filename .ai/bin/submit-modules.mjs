import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readPlan, newLedger, readLedger, saveLedger } from './batch-state.mjs';
import { deliverModules } from './batch-cycle.mjs';
import { finishBatch, notifyOnce } from './batch-finish.mjs';
import { openCezar, openForge } from './batch-io.mjs';

const name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const [batch] = process.argv.slice(2);
const project = process.env.CEZAR_PROJECT_NAME;
const repo = process.env.CEZAR_PROJECT_ROOT;
const address = process.env.CEZAR_API_URL || 'http://127.0.0.1:4321';
if (!name.test(project ?? '') || !name.test(batch ?? '') || !repo) {
  console.error('A project checkout and safe project/batch names are required.');
  process.exit(1);
}

const directory = join(homedir(), 'cezar-state', project);
const ledgerPath = join(directory, batch + '.json');
const summaryPath = join(directory, batch + '-summary.md');
const save = data => saveLedger(ledgerPath, data);
const notify = (event, text) => {
  const result = spawnSync('bash', [join(homedir(), 'cezar-bin', 'notify.sh'), project, event], {
    input: text.slice(0, 3200), timeout: 30000, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, CEZ_RUN_ID: batch, CEZ_BATCH_NOTICE: '1' },
  });
  if (result.status !== 0) throw new Error('Notification could not be confirmed');
};

async function runBatch() {
  const forge = openForge(repo);
  const existed = fs.existsSync(ledgerPath);
  let ledger = existed ? readLedger(ledgerPath) : null;
  if (ledger && (ledger.project !== project || ledger.batch !== batch)) {
    throw new Error('The ledger belongs to a different batch');
  }
  if (ledger?.completedAt) return;
  if (ledger && Date.now() >= Date.parse(ledger.deadlineAt)) {
    await finishBatch(ledger, { forge, save, notify, summaryPath, now: new Date().toISOString() });
    return;
  }

  forge.fetchRefs();
  if (!ledger) {
    const plan = readPlan(repo);
    if (!forge.includesFoundation(plan.sha)) {
      throw new Error('Integration does not contain the main baseline for this batch');
    }
    ledger = newLedger({ project, batch, plan, now: new Date().toISOString() });
    save(ledger);
  }
  forge.verifyIntegrationRules();

  const cezar = await openCezar(address, repo);
  const config = await cezar.configuration();
  const local = JSON.parse(fs.readFileSync(join(repo, '.ai/cezar/config.json'), 'utf8'));
  if (!['integration', 'origin/integration'].includes(config.baseBranch) || config.defaultRunner !== 'codex' ||
      !config.branchNaming?.includes('Task branch:') || !local.namerModels?.codex) {
    throw new Error('The Cezar project is missing the verified integration branch naming settings');
  }
  await cezar.verifyWorkflows();

  const services = { cezar, forge, save, notify, summaryPath, now: new Date().toISOString() };
  const invocation = process.env.INVOCATION_ID;
  if (existed && /^[a-f0-9]{32}$/.test(invocation ?? '')) {
    notifyOnce(ledger, 'restart-' + invocation, 'restart', '批次 ' + batch + ' 已从台账恢复。', services);
  }
  for (;;) {
    services.now = new Date().toISOString();
    if (!ledger.closedAt && Date.parse(services.now) < Date.parse(ledger.deadlineAt)) {
      try {
        await deliverModules(ledger, services);
      } catch {
        console.error('Batch reconciliation is temporarily unavailable.');
        // Read the durable state before retrying. An accepted submission or
        // partial in-memory update must never become a new "pending" attempt.
        ledger = readLedger(ledgerPath);
      }
      for (const entry of [...ledger.modules, ...(ledger.repairs ?? [])]) {
        if (entry.failedSha) notifyOnce(ledger, 'e2e-' + entry.failedSha, 'blocked',
          entry.id + ' 集成 e2e 未通过，见批次 ' + batch + ' 台账。', services);
        if (entry.status === 'reconcile') notifyOnce(ledger, 'reconcile-' + entry.key, 'blocked',
          entry.id + ' 的运行与 PR 需要对账，见批次 ' + batch + ' 台账。', services);
      }
    }
    services.now = new Date().toISOString();
    try {
      if (await finishBatch(ledger, services)) return;
    } catch {
      console.error('Batch finalization is temporarily unavailable.');
      ledger = readLedger(ledgerPath);
    }
    const remaining = Date.parse(ledger.deadlineAt) - Date.now();
    await delay(remaining > 0 ? Math.min(remaining, 30000) : 30000);
  }
}

await runBatch().catch(error => {
  const safe = new Set([
    'The ledger belongs to a different batch',
    'Integration does not contain the main baseline for this batch',
    'The Cezar project is missing the verified integration branch naming settings',
    'Required integration rules are missing',
    'The required Cezar workflows are not loaded',
  ]);
  console.error(safe.has(error.message) ? error.message : 'The batch service could not safely start.');
  process.exitCode = 1;
});
