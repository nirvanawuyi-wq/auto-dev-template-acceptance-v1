import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join, basename } from 'node:path';

const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const shaPattern = /^[a-f0-9]{40}$/;
const terminalHours = 12;

function requireSlug(value, field) {
  const pattern = field === 'module ID' ? slug : /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error('Invalid ' + field);
  }
}

export function verifyModules(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Missing module plan');
  const modules = new Map();
  for (const input of raw) {
    requireSlug(input?.id, 'module ID');
    if (modules.has(input.id) ||
      !Array.isArray(input.dependsOn) || input.dependsOn.some(id => typeof id !== 'string' || !slug.test(id)) ||
      !Array.isArray(input.writablePaths) || input.writablePaths.length === 0 ||
      input.writablePaths.some(path => typeof path !== 'string' || !path ||
        /[\\\r\n]/.test(path) || path.startsWith('/') || path.split('/').includes('..'))) {
      throw new Error('Invalid plan record for ' + input.id);
    }
    modules.set(input.id, { id: input.id, dependsOn: [...input.dependsOn], writablePaths: [...input.writablePaths] });
  }
  if (!modules.has('foundation') || modules.get('foundation').dependsOn.length !== 0) {
    throw new Error('The plan must declare its foundation prerequisite');
  }
  const visiting = new Set();
  const seen = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Dependency cycle at ' + id);
    if (seen.has(id)) return;
    const module = modules.get(id);
    if (!module) throw new Error('Unknown dependency ' + id);
    visiting.add(id);
    for (const upstream of module.dependsOn) visit(upstream);
    visiting.delete(id);
    seen.add(id);
  }
  for (const id of modules.keys()) visit(id);
  return [...modules.values()];
}

export function readPlan(repo) {
  const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const sha = git('rev-parse', '--verify', 'refs/remotes/origin/main^{commit}');
  if (!shaPattern.test(sha)) throw new Error('Could not pin origin/main');
  const plan = JSON.parse(git('show', sha + ':docs/modules.json'));
  return { sha, modules: verifyModules(plan.modules) };
}

export function newLedger({ project, batch, plan, now }) {
  requireSlug(project, 'project name');
  requireSlug(batch, 'batch name');
  if (!shaPattern.test(plan.sha) || !Number.isFinite(Date.parse(now))) {
    throw new Error('Invalid batch baseline or start time');
  }
  const entries = verifyModules(plan.modules).filter(module => module.id !== 'foundation');
  return {
    version: 1,
    project,
    batch,
    planSha: plan.sha,
    startedAt: now,
    deadlineAt: new Date(Date.parse(now) + terminalHours * 60 * 60 * 1000).toISOString(),
    modules: entries.map(module => ({
      ...module,
      key: 'Cezar batch ' + project + '/' + batch + ' module ' + module.id,
      expectedBranch: 'module/' + module.id,
      status: 'pending',
      runId: null,
      prNumber: null,
    })),
  };
}

export function readLedger(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.version !== 1 || !shaPattern.test(data.planSha) || !Array.isArray(data.modules)) {
    throw new Error('Invalid batch ledger');
  }
  requireSlug(data.project, 'project name');
  requireSlug(data.batch, 'batch name');
  return data;
}

export function saveLedger(file, data) {
  writeBatchFile(file, JSON.stringify(data, null, 2) + '\n');
}

export function writeBatchFile(file, contents) {
  const directory = dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, '.' + basename(file) + '.' + randomUUID());
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, contents, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// The caller must durably save this intent before it makes the HTTP request.
export function reserve(entry, now) {
  if (entry.status !== 'pending' || entry.runId !== null) {
    throw new Error('The task is already reserved');
  }
  entry.status = 'submitting';
  entry.submittedAt = now;
}

export function reconcile(entry, runs, workflow) {
  if (!['submitting', 'reconcile', 'running'].includes(entry.status)) {
    throw new Error('Not a submitted task');
  }
  const candidates = runs.filter(run => run.workflow === workflow &&
    typeof run.task === 'string' && run.task.split('\n', 1)[0] === entry.key);
  const [candidate] = candidates;
  if (candidates.length !== 1 || typeof candidate.id !== 'string' || !candidate.id ||
      (entry.runId && entry.runId !== candidate.id) ||
      (candidate.branch && candidate.branch !== entry.expectedBranch)) {
    entry.status = 'reconcile';
    entry.reconcileReason = candidates.length !== 1 ? 'Cannot identify one accepted run' : 'Run or branch identity disagrees';
    return false;
  }
  entry.runId = candidate.id;
  entry.status = 'running';
  delete entry.reconcileReason;
  return true;
}
