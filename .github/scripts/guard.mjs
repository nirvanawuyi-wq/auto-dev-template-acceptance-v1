import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { verifyModules } from "../../.ai/bin/batch-state.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });
}

function reject(message) {
  throw new Error(message);
}

const flagPrefix = "e2e/acceptance/delivered/";
const migrationPrefix = "supabase/migrations/";
const sharedEntry = /^(?:src\/app\/(?:maintain\/)?page\.tsx|src\/features\/[^/]+\/jobs\.ts)$/;

export const migrationName = /^(\d{14})_([a-z][a-z0-9]*(?:-[a-z0-9]+)*)_[a-z0-9][a-z0-9_]*\.sql$/;

export function validTimestamp(value) {
  const iso = value.replace(/^(....)(..)(..)(..)(..)(..)$/, "$1-$2-$3T$4:$5:$6Z");
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString().replace(/\D/g, "").slice(0, 14) === value;
}

export function parseFlag(value) {
  if (!/^\s*\{\s*"delivered"\s*:\s*(?:true|false)\s*\}\s*$/.test(value)) reject("保留仅含布尔 delivered 的单键开关。");
  return JSON.parse(value).delivered;
}

export function branchOwner(branch) {
  if (branch === "stage-0") return "foundation";
  return /^module\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(branch)?.[1] ??
    /^fix\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-[1-9][0-9]*$/.exec(branch)?.[1];
}

const ordinary = (mode) => mode === "100644" || mode === "100755";
const inScope = (path, paths) => paths.some((pattern) => path === pattern ||
  (pattern.includes("*") && matchesGlob(path, pattern)));

export function checkChanges({ changes, protectedPaths, baseBranch, headBranch, delivered, modules, baseFlags, headFlags, timestamps }) {
  const report = baseBranch === "integration" && /^report\/\d{4}-\d{2}-\d{2}$/.test(headBranch);
  if (report) {
    if (changes.length !== 1 || changes[0].path !== "docs/run-report.md" ||
        !["A", "M"].includes(changes[0].status) || changes[0].mode !== "100644") {
      reject("报告分支只能新增或更新普通文件 docs/run-report.md。");
    }
    return;
  }

  const owner = branchOwner(headBranch);
  const module = modules.find(({ id }) => id === owner);
  if (!delivered && !(baseBranch === "main" && headBranch === "stage-0")) reject("地基交接前只接收 stage-0。");
  if (!module || (delivered && (owner === "foundation" || baseBranch !== "integration"))) {
    reject("共有变更由维护者审查并放行；业务分支只向 integration 交付。");
  }
  if (!delivered && (headFlags.size !== modules.length || modules.some(({ id }) => {
    const flag = headFlags.get(id + ".json");
    return !flag || parseFlag(flag) !== (id === "foundation");
  }))) reject("地基须提交计划里的全部交付开关，且只开启 foundation.json。");
  if (delivered && (baseFlags.size !== headFlags.size || [...baseFlags.keys()].some((name) => !headFlags.has(name)))) {
    reject("保留交付开关的全部名称。");
  }

  const allowed = module.writablePaths;
  for (const { path, mode, status } of changes) {
    if (status !== "D" && !ordinary(mode)) reject("请使用普通文件，禁止链接和子模块：" + path);
    if (path.startsWith(flagPrefix)) {
      const name = path.slice(flagPrefix.length);
      const previous = baseFlags.get(name);
      const current = headFlags.get(name);
      if (!current || mode !== "100644") reject("按固定清单保留有效开关：" + path);
      if (!delivered) continue;
      if (status !== "M" || name !== owner + ".json" || !previous ||
          parseFlag(previous) || !parseFlag(current)) reject("开关只让对应板块从 false 改为 true：" + path);
      continue;
    }
    if (delivered && status === "D" && /^e2e\/features\/.*\.spec\.ts$/.test(path)) reject("保留已有功能用例：" + path);
    if (delivered && path.startsWith(migrationPrefix)) {
      const matched = migrationName.exec(path.slice(migrationPrefix.length));
      if (status !== "A" || mode !== "100644" || !matched || matched[2] !== owner || !inScope(path, allowed) ||
          !validTimestamp(matched[1]) || timestamps.has(matched[1])) reject("只追加本板块唯一 UTC 时间戳的迁移：" + path);
      timestamps.add(matched[1]);
      continue;
    }
    if (delivered && sharedEntry.test(path)) {
      const owners = modules.filter(({ id, writablePaths }) => id !== "foundation" && writablePaths.includes(path));
      if (status === "D" || owners.length !== 1 || owners[0].id !== owner) {
        reject("保留其他板块拥有的入口：" + path);
      }
      continue;
    }
    if ((delivered && protectedPaths.some((rule) => rule.test(path))) || !inScope(path, allowed)) {
      reject("撤回越界文件；共有修订请写入 PR 的需要地基变更一节：" + path);
    }
  }
}

function treeFlags(ref) {
  return new Map(git("ls-tree", "-rz", ref, "--", flagPrefix).split("\0").filter(Boolean).map((line) => {
    const [meta, path] = line.split("\t");
    if (!meta.startsWith("100644 blob ")) reject("交付开关须为普通 JSON 文件。");
    const value = git("show", ref + ":" + path);
    parseFlag(value);
    return [path.slice(flagPrefix.length), value];
  }));
}

export function assertFileSet({ base, head, baseBranch, headBranch, list }) {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha))) reject("需要固定的提交 SHA。");
  const mergeBase = git("merge-base", base, head).trim();
  const raw = git("diff", "--raw", "--no-renames", "-z", mergeBase, head, "--").split("\0");
  const changes = [];
  for (let i = 0; i < raw.length - 1; i += 2) {
    const path = raw[i + 1];
    const [, mode, , , status] = raw[i].split(" ");
    if (!path || /[\u0000-\u001f\u007f]/.test(path)) reject("请移除文件路径中的控制字符。");
    changes.push({ path, mode, status });
  }
  const targetFlags = treeFlags(base);
  const headFlags = treeFlags(head);
  const protectedPaths = readFileSync(list, "utf8").split(/\r?\n/).filter(Boolean).map((line) => new RegExp(line));
  const modules = verifyModules(JSON.parse(git("show", base + ":docs/modules.json")).modules);
  const names = git("ls-tree", "-rz", "--name-only", base, "--", migrationPrefix).split("\0");
  const timestamps = new Set(names.map((name) => migrationName.exec(name.split("/").at(-1))?.[1]).filter(Boolean));
  const foundation = targetFlags.get("foundation.json");
  const delivered = foundation ? parseFlag(foundation) : false;
  checkChanges({ changes, protectedPaths, baseBranch, headBranch, modules, delivered, baseFlags: targetFlags, headFlags, timestamps });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, head, baseBranch, headBranch] = process.argv.slice(2);
    assertFileSet({ base, head, baseBranch, headBranch, list: ".github/protected-paths.txt" });
  } catch (error) {
    console.error(error.message.replace(/[\n\r]/g, " "));
    process.exitCode = 1;
  }
}
