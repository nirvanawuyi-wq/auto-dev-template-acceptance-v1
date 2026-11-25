import fs from 'node:fs';
import { reconcile, reserve, writeBatchFile } from './batch-state.mjs';
import { runPrNumber } from './batch-evidence.mjs';

const done = new Set(['merged', 'blocked', 'needs-human', 'skipped']);
const active = new Set(['queued', 'running', 'waiting']);
const reportPreflightReason = 'The report branch or task already exists';

const labels = {
  merged: '已合并', blocked: '熔断', 'needs-human': '搁置，需人工',
  skipped: '跳过', pending: '尚未启动', submitting: '正在对账接单状态',
  running: '仍在运行', reconcile: '待人工对账',
};

function privatePrLink(entry) {
  const url = entry.prUrl;
  if (typeof url !== 'string' || !Number.isSafeInteger(entry.prNumber)) return null;
  const match = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/([1-9][0-9]*)$/.exec(url);
  return match && Number(match[1]) === entry.prNumber ? url : null;
}

function summary(ledger, forge, stoppedByDeadline) {
  const lines = [
    '# 批次摘要 ' + ledger.batch, '',
    stoppedByDeadline ? '已到批次时限，以下保留未完成任务的实际状态。' : '本批板块和返修均已到终态。',
    '', '计划提交 `' + ledger.planSha + '`', '', '## 板块和返修', '',
  ];
  for (const entry of [...ledger.modules, ...ledger.repairs]) {
    const link = privatePrLink(entry);
    const prText = link ? ' [PR #' + entry.prNumber + '](' + link + ')' : (entry.prNumber ? ' PR #' + entry.prNumber : '');
    const source = entry.headSha ?? entry.mergeSha;
    let decisions = '未读取';
    if (source) {
      const content = forge.readDecisionRecord(source, entry.id);
      if (typeof content === 'string') {
        decisions = String(content.split('\n').filter(line => /^\s*(?:[-*]\s+|#{1,6}\s+)?(?:\*\*)?AI 代决(?:\b|[\s：:*])/u.test(line)).length);
      }
    }
    const repair = entry.failedSha ? '，集成返修 `' + entry.failedSha.slice(0, 12) + '`' : '';
    lines.push('- ' + entry.id + ' · ' + labels[entry.status] + repair + prText + ' · AI 代决 ' + decisions);
    if (entry.reason || entry.reconcileReason) lines.push('  - ' + (entry.reason ?? entry.reconcileReason));
    if (entry.runId) lines.push('  - Cezar ' + entry.runId);
  }
  return lines.join('\n') + '\n';
}

export function notifyOnce(ledger, key, event, text, { save, notify, now }) {
  ledger.notices ??= {};
  if (Object.hasOwn(ledger.notices, key)) return;
  ledger.notices[key] = { status: 'sending', at: now };
  save(ledger);
  try {
    notify(event, text);
    ledger.notices[key].status = 'sent';
  } catch {
    // A timed-out response might still have delivered the message.
    ledger.notices[key].status = 'uncertain';
  }
  save(ledger);
}

function reportEntry(ledger) {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(ledger.startedAt));
  return {
    key: 'Cezar batch ' + ledger.project + '/' + ledger.batch + ' final report',
    expectedBranch: 'report/' + date,
    status: 'pending', runId: null, prNumber: null,
  };
}

function isOpenReportDraft(pr, branch) {
  return pr?.state === 'OPEN' && pr.isDraft === true && pr.isCrossRepository === false &&
    pr.baseRefName === 'integration' && pr.headRefName === branch;
}

async function advanceReport(ledger, { cezar, forge, save, now, summaryPath }) {
  const report = ledger.report ??= reportEntry(ledger);
  const workflow = 'final-report';
  const runs = await cezar.listRuns();
  const pending = report.status === 'pending';
  const unsubmitted = report.submittedAt == null && report.runId == null && report.prNumber == null;
  const blockedAtPreflight = report.status === 'reconcile' && report.reconcileReason === reportPreflightReason;
  let openPrs;
  if (unsubmitted && (pending || blockedAtPreflight)) {
    const possibleReportRuns = runs.filter(run => typeof run?.workflow !== 'string' ||
      !run.workflow || run.workflow === workflow);
    if (possibleReportRuns.some(run => typeof run?.task === 'string' && run.task.split('\n', 1)[0] === report.key)) {
      report.status = 'reconcile';
      report.reconcileReason = 'The report task already exists before this batch recorded an attempt';
      save(ledger);
      return false;
    }
    if (possibleReportRuns.every(run => typeof run?.task === 'string' && run.task)) {
      openPrs = forge.listOpenPrs(report.expectedBranch);
      if (!Array.isArray(openPrs)) throw new Error('Unexpected open report PRs response');
      const [pr] = openPrs;
      if (openPrs.length === 1 && isOpenReportDraft(pr, report.expectedBranch) &&
          Number.isSafeInteger(pr.number) && pr.number > 0) {
        report.status = 'failed';
        report.reason = 'The report branch is already occupied by open draft PR #' + pr.number;
        delete report.reconcileReason;
        return true;
      }
    }
  }
  if (pending) {
    if (openPrs?.length !== 0) {
      report.status = 'reconcile';
      report.reconcileReason = unsubmitted ? reportPreflightReason : 'The pending report already has submission evidence';
      save(ledger);
      return false;
    }
    reserve(report, now);
    save(ledger);
    let accepted;
    try {
      accepted = await cezar.submit(workflow, [
        report.key,
        'Task branch: ' + report.expectedBranch,
        'Read this completed batch summary: ' + summaryPath,
        'Produce only docs/run-report.md following .ai/prompts/final-report.md.',
      ].join('\n'));
    } catch {
      return false;
    }
    report.runId = accepted.id;
    report.status = 'running';
    save(ledger);
    return false;
  }
  if (['done', 'failed'].includes(report.status)) return true;
  if (!report.submittedAt || !reconcile(report, runs, workflow)) {
    save(ledger);
    return false;
  }
  const run = runs.find(candidate => candidate.id === report.runId);
  if (active.has(run.status)) {
    save(ledger);
    return false;
  }
  if (['done', 'review'].includes(run.status)) {
    const number = runPrNumber(run);
    const pr = number ? forge.readPr(number) : null;
    if (isOpenReportDraft(pr, report.expectedBranch)) {
      report.prNumber = number;
      report.status = 'done';
      return true;
    }
  }
  report.status = 'failed';
  return true;
}

export async function finishBatch(ledger, services) {
  const { save, forge, now, summaryPath } = services;
  if (ledger.completedAt) return true;
  const entries = [...ledger.modules, ...(ledger.repairs ?? [])];
  const timedOut = Date.parse(now) >= Date.parse(ledger.deadlineAt);
  if (!ledger.closedAt && !timedOut && !entries.every(entry => done.has(entry.status))) return false;
  if (!ledger.closedAt || !fs.existsSync(summaryPath)) {
    writeBatchFile(summaryPath, summary(ledger, forge, timedOut));
    ledger.closedAt ??= now;
    save(ledger);
  }
  const notice = [
    '批次 ' + ledger.batch + (timedOut ? ' 到达时限' : ' 全部结束'),
    ...entries.map(entry => entry.id + ' · ' + labels[entry.status] + (entry.prNumber ? ' · PR #' + entry.prNumber : '')),
    '详细摘要已保存在服务器。',
  ].join('\n');
  notifyOnce(ledger, 'complete', 'complete', notice, services);

  if (!timedOut && !await advanceReport(ledger, services)) return false;
  ledger.completedAt = now;
  save(ledger);
  return true;
}
