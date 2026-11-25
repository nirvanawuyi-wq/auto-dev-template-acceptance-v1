import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const shaPattern = /^[a-f0-9]{40}$/;
const branchPattern = /^(?:module|fix|report)\/[a-z0-9][a-z0-9-]*$/;
const workflowNames = new Set(['module-delivery', 'final-report']);
const failedConclusions = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

export async function openCezar(location, repo) {
  const origin = new URL(location);
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Cezar must use a loopback HTTP origin');
  }
  async function request(path, body) {
    const response = await fetch(origin.origin + path, {
      redirect: 'error', signal: AbortSignal.timeout(12000),
      ...(body ? {
        method: 'POST',
        headers: { origin: origin.origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      } : {}),
    });
    if (response.status !== (body ? 201 : 200)) {
      throw new Error('Cezar returned HTTP ' + response.status + ' while ' + (body ? 'submitting' : 'reading'));
    }
    return response.json();
  }
  const registry = await request('/api/v1/projects');
  const root = realpathSync(repo);
  const matches = registry.projects.filter(project => project.root === root);
  if (matches.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(matches[0].id)) {
    throw new Error('Cannot identify the registered project');
  }
  const scope = '/api/v1/p/' + matches[0].id;
  return {
    configuration() { return request(scope + '/config'); },
    async verifyWorkflows() {
      const result = await request(scope + '/workflows');
      if (!Array.isArray(result.issues) || result.issues.length > 0 ||
          [...workflowNames].some(name => !result.workflows?.some(workflow => workflow.name === name && workflow.source === 'file'))) {
        throw new Error('The required Cezar workflows are not loaded');
      }
    },
    async listRuns() {
      const runs = await request(scope + '/runs');
      if (!Array.isArray(runs)) throw new Error('Unexpected Cezar runs response');
      return runs;
    },
    async submit(workflow, task) {
      if (!workflowNames.has(workflow) || typeof task !== 'string' || !task) {
        throw new Error('Invalid workflow submission');
      }
      const run = await request(scope + '/runs', {
        workflow, task, runner: 'codex', autonomous: true, worktree: true, generateFollowups: false,
      });
      if (typeof run.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(run.id)) {
        throw new Error('Cezar did not return a valid run ID');
      }
      return run;
    },
  };
}

export function openForge(repo, invoke = (file, args) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GH_REPO;
  return execFileSync(file, args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000, maxBuffer: 8 * 1024 * 1024, env,
  }).trim();
}) {
  const git = (...args) => invoke('git', args);
  const gh = (...args) => JSON.parse(invoke('gh', args));
  const slug = 'repos/{owner}/{repo}';
  const prFields = 'number,state,baseRefName,headRefName,isCrossRepository,isDraft,headRefOid,mergeCommit,url';
  function isAncestor(ancestor, tip) {
    if (!shaPattern.test(ancestor) || !shaPattern.test(tip)) throw new Error('Invalid ancestry input');
    try {
      git('merge-base', '--is-ancestor', ancestor, tip);
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw new Error('Could not verify integration ancestry');
    }
  }
  function selectE2e(tip) {
    const runs = gh('api', slug + '/actions/workflows/e2e.yml/runs', '--method', 'GET',
      '-f', 'head_sha=' + tip, '-f', 'branch=integration', '-f', 'event=deployment_status',
      '--paginate', '--slurp');
    const recent = runs.flatMap(page => page.workflow_runs)
      .filter(run => run.head_branch === 'integration' && run.head_sha === tip &&
        run.event === 'deployment_status' && Number.isSafeInteger(run.id))
      .sort((a, b) => b.id - a.id)[0];
    if (!recent || recent.status !== 'completed') return null;
    const jobs = gh('api', slug + '/actions/runs/' + recent.id + '/jobs?filter=latest', '--paginate', '--slurp');
    const exact = jobs.flatMap(page => page.jobs).filter(job => job.head_sha === tip);
    const deploy = exact.filter(job => job.name === 'deploy');
    const browser = exact.filter(job => job.name === 'browser');
    if (deploy.length !== 1 || deploy[0].status !== 'completed' || deploy[0].conclusion !== 'success' ||
        browser.length !== 1 || browser[0].status !== 'completed') return null;
    const result = browser[0].conclusion;
    const outcome = result === 'success' && recent.conclusion === 'success' ? 'green' :
      failedConclusions.has(result) && failedConclusions.has(recent.conclusion) ? 'red' : null;
    if (!outcome) return null;

    const state = outcome === 'green' ? 'success' : 'failure';
    const statuses = gh('api', slug + '/commits/' + tip + '/statuses?per_page=100', '--paginate', '--slurp').flat();
    const status = statuses.find(entry => entry.context === 'e2e');
    if (status?.state !== state || status.creator?.login !== 'github-actions[bot]') return null;
    const target = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d*)$/.exec(status.target_url ?? '');
    if (!target) return null;
    const [, repository, publisherId] = target;
    const publisher = gh('api', slug + '/actions/runs/' + publisherId);
    if (publisher.path?.split('@')[0] !== '.github/workflows/e2e-status.yml' ||
        publisher.repository?.full_name !== repository || publisher.event !== 'workflow_run' ||
        publisher.status !== 'completed' || publisher.conclusion !== state) return null;
    const artifacts = gh('api', slug + '/actions/runs/' + publisherId + '/artifacts?per_page=100', '--paginate', '--slurp')
      .flatMap(page => page.artifacts);
    if (!artifacts.some(artifact => artifact.name === 'e2e-' + tip && artifact.expired === false)) return null;
    return { sha: tip, outcome, workflowRun: recent.id };
  }
  return {
    fetchRefs() { git('fetch', '--prune', 'origin'); },
    verifyIntegrationRules() {
      const rules = gh('api', slug + '/rules/branches/integration');
      const types = new Set(rules.map(rule => rule.type));
      const required = rules.filter(rule => rule.type === 'required_status_checks')
        .flatMap(rule => rule.parameters?.required_status_checks ?? []);
      const enabled = new Set(required.filter(check => Number.isSafeInteger(check.integration_id) && check.integration_id > 0)
        .map(check => check.context));
      if (['pull_request', 'non_fast_forward', 'deletion'].some(type => !types.has(type)) ||
          ['verify', 'guard', 'e2e', 'Vercel'].some(check => !enabled.has(check))) {
        throw new Error('Required integration rules are missing');
      }
    },
    readPr(number) {
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid PR number');
      return gh('pr', 'view', String(number), '--json', prFields);
    },
    listOpenPrs(branch) {
      if (!branchPattern.test(branch)) throw new Error('Invalid task branch');
      return gh('pr', 'list', '--head', branch, '--state', 'open', '--limit', '2', '--json', prFields);
    },
    readDecisionRecord(sha, id) {
      if (!shaPattern.test(sha) || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid decision scope');
      try {
        const data = gh('api', slug + '/contents/docs/decisions/' + id + '.md?ref=' + sha);
        if (data.encoding !== 'base64' || typeof data.content !== 'string') return null;
        return Buffer.from(data.content, 'base64').toString('utf8');
      } catch {
        return null;
      }
    },
    includesFoundation(sha) {
      const tip = git('rev-parse', '--verify', 'refs/remotes/origin/integration^{commit}');
      return isAncestor(sha, tip);
    },
    integrationProof(mergeShas) {
      git('fetch', 'origin', 'refs/heads/integration:refs/remotes/origin/integration');
      const tip = git('rev-parse', '--verify', 'refs/remotes/origin/integration^{commit}');
      if (!shaPattern.test(tip)) throw new Error('Invalid integration SHA');
      const contains = [...new Set(mergeShas)].filter(sha => isAncestor(sha, tip));
      return { tip, fullE2e: selectE2e(tip), contains };
    },
  };
}
