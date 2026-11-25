import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { branchOwner } from "./guard.mjs";
import { verifyModules } from "../../.ai/bin/batch-state.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const maintainer = process.env.MAINTAINER_GITHUB_LOGIN;
const fullSha = /^[a-f0-9]{40}$/;

function requireEvidence(condition, reason) {
  if (!condition) throw new Error(reason);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", timeout: 30000 }).trim();
}

function api(endpoint, paginate = false) {
  const args = ["api", "--method", "GET", "repos/" + repository + "/" + endpoint];
  if (paginate) args.push("--paginate", "--slurp");
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 30000 }));
}

function hasRunEvidence(run, name) {
  if (!run?.id) return false;
  return api("actions/runs/" + run.id + "/artifacts?per_page=100", true)
    .flatMap((page) => page.artifacts).some((artifact) => artifact.name === name);
}

function isMaintainer(login) {
  return typeof maintainer === "string" && maintainer.length > 0 && login === maintainer;
}

const approvedFoundationRepairs = new Map();

function isApprovedFoundationRepair(pr, parent, merged) {
  const reviewed = approvedFoundationRepairs.get(pr.number);
  if (!reviewed || pr.head.ref !== reviewed.branch || pr.head.sha !== reviewed.reviewedHead ||
      !isMaintainer(pr.merged_by?.login ?? api("pulls/" + pr.number).merged_by?.login)) return false;
  // These approvals cover only the reviewed patches. The normal module guard does not own those paths.
  const { reviewedBase, reviewedHead, paths } = reviewed;
  return git("merge-base", parent, reviewedHead) === reviewedBase &&
    git("diff", "--name-only", "--no-renames", parent, merged) === paths.join("\n") &&
    git("ls-tree", merged, "--", ...paths) === git("ls-tree", reviewedHead, "--", ...paths);
}

function readReviews(pr, head) {
  return api("pulls/" + pr.number + "/reviews?per_page=100", true).flat()
    .filter((review) => review.commit_id === head && isMaintainer(review.user?.login)).at(-1)?.state === "APPROVED";
}

function hasTrustedSchemaStatus(sha) {
  const incoming = api("commits/" + sha + "/statuses?per_page=100", true).flat()
    .find((status) => status.context === "integration-schema" && status.creator?.login === "github-actions[bot]");
  const prefix = "https://github.com/" + repository + "/actions/runs/";
  const id = incoming?.target_url?.startsWith(prefix) ? incoming.target_url.slice(prefix.length) : undefined;
  if (incoming?.state !== "success" || !/^\d+$/.test(id ?? "")) return false;
  const run = api("actions/runs/" + id);
  return run.repository?.full_name === repository && run.head_branch === "main" && run.event === "workflow_run" &&
    run.path?.split("@")[0] === ".github/workflows/migrate-integration.yml" && run.conclusion === "success";
}

function releasesThrough(target, requireChecks = true) {
  requireEvidence(fullSha.test(target), "Provide a full integration SHA");
  const chain = git("rev-list", "--first-parent", "origin/integration").split("\n");
  requireEvidence(chain.includes(target), "SHA must be on the integration first-parent chain");
  const ordered = chain.slice(chain.indexOf(target)).reverse();
  const releases = [];
  for (const sha of ordered) {
    const prs = api("commits/" + sha + "/pulls?per_page=100", true).flat();
    const pr = prs.find((candidate) => candidate.merged_at && candidate.merge_commit_sha === sha);
    if (!releases.length) {
      if (!pr || pr.base.ref !== "main" || pr.head.ref !== "stage-0") continue;
      requireEvidence(pr.head.repo?.full_name === repository && isMaintainer(pr.merged_by?.login ?? api("pulls/" + pr.number).merged_by?.login),
        "The maintainer must merge the bootstrap stage-0 PR");
      releases.push({ sha, owner: "foundation", reviewedSha: pr.head.sha });
      continue;
    }
    const fields = git("rev-list", "--parents", "-n", "1", sha).split(" ");
    if (!pr && fields.length === 2) {
      const paths = git("diff", "--name-only", fields[1], sha).split("\n");
      const trustedFiles = new Set([".github/workflows/guard.yml", ".github/scripts/trusted-release.mjs"]);
      // Recognize the maintainer's protected-main guard update mirrored to integration.
      if (paths.length && paths.every((path) => trustedFiles.has(path)) &&
          git("rev-list", "--first-parent", "origin/main").split("\n").includes(sha)) {
        releases.push({ sha, owner: "none" });
        continue;
      }
    }
    requireEvidence(fields.length === 2 && pr?.base.ref === "integration" && pr.head.repo?.full_name === repository,
      "Expected a single squash-merged pull request for " + sha);
    const branch = pr.head.ref;
    const modules = verifyModules(JSON.parse(git("show", fields[1] + ":docs/modules.json")).modules);
    const candidate = branchOwner(branch);
    const owner = candidate !== "foundation" && modules.some(({ id }) => id === candidate) ? candidate : undefined;
    const report = /^report\/\d{4}-\d{2}-\d{2}$/.test(branch);
    const skinPaths = ["DESIGN.md", "src/app/globals.css", "src/app/layout.tsx", "src/app/page.tsx"];
    const skin = /^skin\/[\w-]+$/.test(branch) &&
      isMaintainer(pr.merged_by?.login ?? api("pulls/" + pr.number).merged_by?.login) &&
      git("diff", "--name-only", "--no-renames", fields[1], sha).split("\n").every(path => skinPaths.includes(path));
    const auxiliary = report || skin;
    const typeSync = /^fix\/foundation-[1-9][0-9]*$/.test(branch) &&
      isMaintainer(pr.merged_by?.login ?? api("pulls/" + pr.number).merged_by?.login) &&
      git("diff", "--name-status", fields[1], sha) === "M\tsrc/lib/database.types.ts";
    const foundationRepair = isApprovedFoundationRepair(pr, fields[1], sha);
    requireEvidence(owner || auxiliary || typeSync || foundationRepair, "Unrecognised integration merge " + sha);
    if (requireChecks && !typeSync && !hasTrustedSchemaStatus(sha)) {
      const head = pr.head.sha;
      requireEvidence(fullSha.test(head), "Missing reviewed pull request head");
      // GitHub requires these named checks on the reviewed head. The target guard
      // also stamps the head with its trusted workflow run URL.
      const statuses = api("commits/" + head + "/statuses?per_page=100", true).flat();
      const checkRuns = api("commits/" + head + "/check-runs?filter=latest&per_page=100", true).flatMap((page) => page.check_runs);
      const guard = statuses.find((status) => status.context === "guard");
      const trustedUrl = new RegExp("^https://github\\.com/" + repository.replaceAll(".", "\\.") + "/actions/runs/(\\d+)$");
      const guardRunId = trustedUrl.exec(guard?.target_url ?? "")?.[1];
      const guardRun = guardRunId && api("actions/runs/" + guardRunId);
      const trustedGuard = guard?.state === "success" && guard.creator?.login === "github-actions[bot]" &&
        guardRun?.path?.split("@")[0] === ".github/workflows/guard.yml" &&
        guardRun.event === "pull_request_target" && guardRun.conclusion === "success" &&
        guardRun.repository?.full_name === repository && hasRunEvidence(guardRun, "guard-" + head);
      requireEvidence((foundationRepair || skin || trustedGuard) &&
        checkRuns.some((run) => run.name === "verify" && run.head_sha === head &&
          run.app?.slug === "github-actions" && run.conclusion === "success"),
      "Missing trusted guard and verify on " + head);
      const e2e = statuses.find((status) => status.context === "e2e");
      const e2eRunId = trustedUrl.exec(e2e?.target_url ?? "")?.[1];
      const e2eRun = e2eRunId && api("actions/runs/" + e2eRunId);
      requireEvidence(e2e?.state === "success" && e2e.creator?.login === "github-actions[bot]" &&
        e2eRun?.path?.split("@")[0] === ".github/workflows/e2e-status.yml" &&
        e2eRun.event === "workflow_run" && e2eRun.conclusion === "success" && hasRunEvidence(e2eRun, "e2e-" + head) &&
        statuses.find((status) => status.context === "Vercel" && status.creator?.login === "vercel[bot]")?.state === "success",
      "Missing trusted E2E or Vercel result on " + head);
    }
    releases.push({ sha, owner: owner ?? "none", typeSync });
  }
  requireEvidence(releases.length && releases.at(-1).sha === target, "Cannot identify reviewed integration baseline");
  return releases;
}

function verifySignal(event, workflowName, filename, trigger) {
  const run = event.workflow_run;
  const workflow = api("actions/workflows/" + workflowName);
  requireEvidence(run && event.repository?.full_name === repository &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.workflow_id === workflow.id && run.path?.split("@")[0] === ".github/workflows/" + filename &&
    run.event === trigger && fullSha.test(run.head_sha), "Reject untrusted workflow signal");
  return run;
}

function manual(event) {
  const { mode, ref, pull_request: value } = event.inputs ?? {};
  requireEvidence(process.env.GITHUB_REF === "refs/heads/main" && isMaintainer(process.env.GITHUB_ACTOR) &&
    isMaintainer(process.env.GITHUB_TRIGGERING_ACTOR), "Start manual migrations from protected main as the maintainer");
  requireEvidence(fullSha.test(ref) && /^[1-9]\d*$/.test(value), "Enter the reviewed full SHA and PR number");
  const pr = api("pulls/" + value);
  requireEvidence(pr.base.ref === "main" && pr.head.repo?.full_name === repository,
    "Select the in-repository pull request targeting main");
  if (mode === "bootstrap-test") {
    requireEvidence(pr.head.ref === "stage-0" && pr.head.sha === ref && pr.state === "open", "Select the exact stage-0 PR head");
    requireEvidence(process.env.REVIEWED_SHA === ref, "The maintainer must independently confirm this exact SHA");
    return [{ sha: ref, owner: "foundation", reviewedBootstrap: true }];
  }
  requireEvidence(mode === "production" && pr.head.ref === "integration" && pr.head.sha === ref &&
    (readReviews(pr, ref) || process.env.REVIEWED_SHA === ref), "Use the maintainer-reviewed integration release SHA");
  const statuses = api("commits/" + ref + "/statuses?per_page=100", true).flat();
  requireEvidence(hasTrustedSchemaStatus(ref), "Test schema must already be green on this SHA");
  const checks = statuses.find((status) => status.context === "e2e");
  requireEvidence(checks?.state === "success" && checks.creator?.login === "github-actions[bot]", "E2E must already be green on this SHA");
  return releasesThrough(ref);
}

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const mode = process.argv[2];
  let releases;
  if (mode === "manual") releases = manual(event);
  else if (mode === "integration") {
    const run = verifySignal(event, "integration-merged.yml", "integration-merged.yml", "push");
    requireEvidence(run.head_branch === "integration" && run.conclusion === "success", "Integration signal must be a successful integration push");
    const newest = git("rev-parse", "origin/integration");
    // Reconcile queued signals against current first-parent history. Concurrency queues
    // can collapse pending signals, so a single run publishes evidence for all seen SHAs.
    releases = releasesThrough(newest);
    requireEvidence(releases.some(({ sha }) => sha === run.head_sha), "Signal SHA is not in the accepted merge chain");
  } else throw new Error("Select an explicit release verification mode");
  writeFileSync("verified-releases.json", JSON.stringify(releases, null, 2) + "\n");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
