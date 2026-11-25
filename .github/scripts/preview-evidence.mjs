import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { branchOwner } from "./guard.mjs";

const repo = process.env.GITHUB_REPOSITORY;
const sha = /^[a-f0-9]{40}$/;
const numeric = (value) => /^\d+$/.test(String(value));

function api(path) {
  return JSON.parse(execFileSync("gh", ["api", "--method", "GET", "repos/" + repo + "/" + path], {
    encoding: "utf8", timeout: 15000,
  }));
}

function assert(valid, reason) {
  if (!valid) throw new Error(reason);
}

function projectId(deployment) {
  const payload = typeof deployment.payload === "string" ? JSON.parse(deployment.payload || "{}") : deployment.payload;
  return payload?.projectId ?? payload?.project?.id;
}

function validate(deployment, status) {
  const project = process.env.TEST_VERCEL_PROJECT_ID;
  const environment = process.env.TEST_VERCEL_DEPLOYMENT_ENV;
  const actor = process.env.TEST_VERCEL_ACTOR_ID;
  const slug = process.env.TEST_VERCEL_PROJECT_SLUG;
  const suffix = process.env.TEST_VERCEL_PREVIEW_SUFFIX;
  assert(/^prj_\w+$/.test(project ?? "") && environment && numeric(actor) &&
    /^[a-z0-9-]+$/.test(slug ?? "") && /^[a-z0-9-]+\.vercel\.app$/.test(suffix ?? ""),
  "Configure the tested Vercel project, actor, environment and immutable deployment domain.");
  const eventProject = projectId(deployment);
  assert(deployment.environment === environment && status.state === "success" &&
    deployment.production_environment === false && deployment.creator?.id === Number(actor) &&
    status.creator?.id === Number(actor) && sha.test(deployment.sha),
  "Expected a successful deployment from the configured Vercel actor.");
  // Vercel's native GitHub records can carry only the commit SHA and the immutable URL.
  // If the project ID is omitted, all status URL fields must match the pinned test host below.
  assert(eventProject === project || (eventProject === undefined && deployment.ref === deployment.sha &&
    status.target_url === status.environment_url && status.log_url === status.environment_url),
  "Expected the configured Vercel project or its native deployment status.");
  const exact = new URL(status.environment_url);
  assert(exact.origin === status.environment_url.replace(/\/$/, "") && exact.protocol === "https:" &&
    !exact.username && !exact.password && exact.port === "" &&
    exact.hostname.endsWith("-" + suffix),
  "Use the exact HTTPS URL from the tested deployment record.");
  const name = exact.hostname.slice(0, -(suffix.length + 1));
  assert(name.startsWith(slug + "-") && /^[a-z0-9]{9}$/.test(name.slice(slug.length + 1)),
    "Use the immutable Vercel deployment URL instead of a branch alias.");
  assert(!process.env.PRODUCTION_ORIGIN || exact.origin !== new URL(process.env.PRODUCTION_ORIGIN).origin,
    "Reject the configured production origin.");
  return { id: deployment.id, statusId: status.id, origin: exact.origin, sha: deployment.sha, ref: deployment.ref };
}

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const mode = process.argv[2];
  if (mode === "deployment") {
    assert(event.repository?.full_name === repo && numeric(event.deployment?.id) && numeric(event.deployment_status?.id),
      "Require a deployment status from the current repository.");
    const id = event.deployment.id;
    const statusId = event.deployment_status.id;
    const evidence = validate(api("deployments/" + id), api("deployments/" + id + "/statuses/" + statusId));
    assert(evidence.sha === event.deployment.sha && evidence.sha === process.env.GITHUB_SHA, "Deployment and workflow SHAs differ.");
    let branch = evidence.ref?.replace(/^refs\/heads\//, "");
    if (branch === evidence.sha) {
      const integrationHead = execFileSync("git", ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/integration"],
        { encoding: "utf8", timeout: 15000 }).trim();
      if (integrationHead === evidence.sha) branch = "integration";
    }
    const integration = branch === "integration";
    if (integration) {
      execFileSync("git", ["merge-base", "--is-ancestor", evidence.sha, "origin/integration"], { timeout: 15000 });
    } else {
      const prs = api("commits/" + evidence.sha + "/pulls?per_page=100").filter((pr) =>
        pr.state === "open" && pr.head.sha === evidence.sha && pr.head.repo?.full_name === repo &&
        (pr.base.ref === "integration" || (pr.base.ref === "main" && pr.head.ref === "stage-0")) &&
        (branch === evidence.sha || pr.head.ref === branch));
      assert(prs.length === 1, "Require one current in-repository PR head or a verified integration deployment.");
      branch = prs[0].head.ref;
    }
    const owner = branchOwner(branch);
    const moduleId = owner === "foundation" ? "" : owner ?? "";
    appendFileSync(process.env.GITHUB_OUTPUT, "sha=" + evidence.sha + "\norigin=" + evidence.origin + "\nintegration=" + integration + "\nmodule=" + moduleId + "\n");
    writeFileSync("deployment-evidence.json", JSON.stringify(evidence));
  } else if (mode === "publish") {
    const run = event.workflow_run;
    const workflow = api("actions/workflows/e2e.yml");
    assert(event.repository?.full_name === repo && run.repository?.full_name === repo &&
      run.head_repository?.full_name === repo && run.event === "deployment_status" && run.workflow_id === workflow.id &&
      run.path?.split("@")[0] === ".github/workflows/e2e.yml", "Reject an untrusted E2E source.");
    const evidence = JSON.parse(readFileSync("deployment-evidence.json", "utf8"));
    assert(numeric(evidence.id) && numeric(evidence.statusId) && evidence.sha === run.head_sha &&
      validate(api("deployments/" + evidence.id), api("deployments/" + evidence.id + "/statuses/" + evidence.statusId)).sha === evidence.sha,
    "Require deployment evidence bound to the E2E run SHA.");
    const state = run.conclusion === "success" ? "success" : "failure";
    appendFileSync(process.env.GITHUB_OUTPUT, "sha=" + evidence.sha + "\nstate=" + state + "\n");
  } else if (mode === "schema") {
    const commit = process.argv[3];
    assert(sha.test(commit), "Require the full preview SHA.");
    const statuses = api("commits/" + commit + "/statuses?per_page=100");
    const status = statuses.find((candidate) => candidate.context === "integration-schema" && candidate.creator?.login === "github-actions[bot]");
    if (!status) process.exitCode = 3;
    else {
      const prefix = process.env.GITHUB_SERVER_URL + "/" + repo + "/actions/runs/";
      const runId = status.target_url?.startsWith(prefix) ? status.target_url.slice(prefix.length) : undefined;
      assert(numeric(runId), "Schema signal must point to the trusted workflow.");
      const run = api("actions/runs/" + runId);
      assert(run.path?.split("@")[0] === ".github/workflows/migrate-integration.yml" &&
        run.event === "workflow_run" && run.repository.full_name === repo, "Wrong schema status source.");
      if (status.state === "failure" || run.conclusion === "failure") process.exitCode = 2;
      else if (status.state !== "success" || run.conclusion !== "success") process.exitCode = 3;
    }
  } else throw new Error("Select a trusted preview evidence operation.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
