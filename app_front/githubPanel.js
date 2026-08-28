import * as api from './core/api/index.js';
import { t } from './i18n/index.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

let githubTabVisible = false;
let expandedRunId = null;
let showPanelFallback = null;

function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value || '—';
}

function setBadge(text, type) {
  const badge = document.getElementById('github-status-badge');
  if (!badge) return;
  badge.textContent = text || '—';
  badge.classList.remove('git-status-badge--ok', 'git-status-badge--warn', 'git-status-badge--error');
  if (type) badge.classList.add(`git-status-badge--${type}`);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusBadgeClass(status, conclusion) {
  if (status === 'in_progress' || status === 'queued' || status === 'waiting') return 'warn';
  if (conclusion === 'success') return 'ok';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') return 'error';
  if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral') return 'warn';
  return 'warn';
}

function runStatusLabel(status, conclusion) {
  if (status && status !== 'completed') return status.replace(/_/g, ' ');
  if (conclusion) return conclusion.replace(/_/g, ' ');
  return status || '—';
}

function renderRepoInfo(info) {
  if (!info?.ok) {
    setBadge(t('github.noData'), 'error');
    setText('github-info-repo', '—');
    setText('github-info-remote', '—');
    setText('github-info-token', '—');
    return;
  }
  if (!info.isRepo) {
    setBadge(t('github.noRepo'), 'warn');
    setText('github-info-repo', '—');
    setText('github-info-remote', '—');
    setText('github-info-token', '—');
    return;
  }
  if (!info.isGithub) {
    setBadge(t('github.noGithubRemote'), 'warn');
    setText('github-info-repo', '—');
    setText('github-info-remote', '—');
    setText('github-info-token', '—');
    return;
  }
  setBadge(t('github.repoLinked'), 'ok');
  setText('github-info-repo', `${info.owner}/${info.repo}`);
  setText('github-info-remote', info.remoteUrl || '—');
  const tokenLabel = info.githubTokenEffective
    ? t('github.tokenConfigured')
    : t('github.tokenMissing');
  setText('github-info-token', tokenLabel);
}

function renderRunsError(message) {
  const list = document.getElementById('github-runs-list');
  if (!list) return;
  list.innerHTML = `<div class="github-empty">${message || t('github.loadRunsFailed')}</div>`;
}

function renderRunsLoading() {
  const list = document.getElementById('github-runs-list');
  if (!list) return;
  list.innerHTML = `<div class="github-empty">${t('github.loadingRuns')}</div>`;
}

function renderRunJobs(runId, jobs, errorMessage) {
  const container = document.getElementById(`github-run-jobs-${runId}`);
  if (!container) return;
  if (errorMessage) {
    container.innerHTML = `<div class="github-jobs-error">${errorMessage}</div>`;
    return;
  }
  if (!Array.isArray(jobs) || !jobs.length) {
    container.innerHTML = `<div class="github-jobs-empty">${t('github.noJobs')}</div>`;
    return;
  }
  container.innerHTML = jobs.map((job) => renderJobCard(job)).join('');
  container.querySelectorAll('[data-github-job-logs]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const jobId = btn.getAttribute('data-github-job-logs');
      if (jobId) loadJobLogs(jobId);
    });
  });
}

function renderJobCard(job) {
  const badgeType = statusBadgeClass(job.status, job.conclusion);
  const statusText = runStatusLabel(job.status, job.conclusion);
  const failedSteps = (job.steps || []).filter((step) => step.conclusion === 'failure');
  const stepsHtml = failedSteps.length
    ? `<ul class="github-failed-steps">${failedSteps
        .map((step) => `<li>${escapeHtml(step.name || t('github.step'))}</li>`)
        .join('')}</ul>`
    : '';
  const showLogs = job.conclusion === 'failure' || job.conclusion === 'timed_out';
  const logsBtn = showLogs
    ? `<button type="button" class="github-link-btn" data-github-job-logs="${job.id}">${t('github.showLogs')}</button>`
    : '';
  const openLink = job.htmlUrl
    ? `<a class="github-link-btn" href="${escapeHtml(job.htmlUrl)}" target="_blank" rel="noopener noreferrer">${t('github.openOnGithub')}</a>`
    : '';
  return `
    <article class="github-job-card">
      <div class="github-job-head">
        <strong>${escapeHtml(job.name || 'Job')}</strong>
        <span class="git-status-badge git-status-badge--${badgeType}">${escapeHtml(statusText)}</span>
      </div>
      <div class="github-job-meta">${escapeHtml(formatDate(job.completedAt || job.startedAt))}</div>
      ${stepsHtml}
      <div class="github-job-actions">${logsBtn}${openLink}</div>
      <pre id="github-job-logs-${job.id}" class="github-job-logs" hidden></pre>
    </article>
  `;
}

function renderRunsList(data) {
  const list = document.getElementById('github-runs-list');
  if (!list) return;
  const runs = Array.isArray(data?.runs) ? data.runs : [];
  if (!runs.length) {
    list.innerHTML = `<div class="github-empty">${t('github.noRuns')}</div>`;
    return;
  }
  list.innerHTML = runs.map((run) => renderRunCard(run)).join('');
  list.querySelectorAll('[data-github-run-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const runId = btn.getAttribute('data-github-run-toggle');
      if (!runId) return;
      toggleRunDetails(runId);
    });
  });
  list.querySelectorAll('[data-github-run-open]').forEach((link) => {
    link.addEventListener('click', (event) => event.stopPropagation());
  });
  if (expandedRunId) {
    const existing = document.getElementById(`github-run-jobs-${expandedRunId}`);
    if (existing) loadRunJobs(expandedRunId);
  }
}

function renderRunCard(run) {
  const badgeType = statusBadgeClass(run.status, run.conclusion);
  const statusText = runStatusLabel(run.status, run.conclusion);
  const branch = run.headBranch ? `#${escapeHtml(run.headBranch)}` : '';
  const sha = run.headSha ? `@${escapeHtml(run.headSha)}` : '';
  const openLink = run.htmlUrl
    ? `<a class="github-link-btn" href="${escapeHtml(run.htmlUrl)}" target="_blank" rel="noopener noreferrer" data-github-run-open>${t('github.openOnGithub')}</a>`
    : '';
  return `
    <article class="github-run-card">
      <div class="github-run-head">
        <button type="button" class="github-run-toggle" data-github-run-toggle="${run.id}" aria-expanded="${expandedRunId === String(run.id)}">
          <span class="github-run-name">${escapeHtml(run.name || 'Workflow')}</span>
          <span class="git-status-badge git-status-badge--${badgeType}">${escapeHtml(statusText)}</span>
        </button>
        ${openLink}
      </div>
      <div class="github-run-meta">
        <span>${escapeHtml(run.event || '—')}</span>
        <span>${branch}${sha}</span>
        <span>${escapeHtml(formatDate(run.updatedAt || run.createdAt))}</span>
      </div>
      <div id="github-run-jobs-${run.id}" class="github-run-jobs" hidden></div>
    </article>
  `;
}

function toggleRunDetails(runId) {
  const jobsEl = document.getElementById(`github-run-jobs-${runId}`);
  if (!jobsEl) return;
  const isOpen = !jobsEl.hidden;
  document.querySelectorAll('.github-run-jobs').forEach((el) => {
    el.hidden = true;
    el.innerHTML = '';
  });
  document.querySelectorAll('.github-run-toggle').forEach((btn) => {
    btn.setAttribute('aria-expanded', 'false');
  });
  if (isOpen) {
    expandedRunId = null;
    return;
  }
  expandedRunId = String(runId);
  jobsEl.hidden = false;
  const toggleBtn = document.querySelector(`[data-github-run-toggle="${runId}"]`);
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
  loadRunJobs(runId);
}

function loadRunJobs(runId) {
  renderRunJobs(runId, [], '');
  api.getGithubWorkflowRunJobs(runId).then((data) => {
    if (!data?.ok) {
      renderRunJobs(runId, [], data?.error || t('github.loadJobsFailed'));
      return;
    }
    renderRunJobs(runId, data.jobs, '');
  }).catch(() => {
    renderRunJobs(runId, [], t('github.loadJobsFailed'));
  });
}

function loadJobLogs(jobId) {
  const pre = document.getElementById(`github-job-logs-${jobId}`);
  if (!pre) return;
  pre.hidden = false;
  pre.textContent = t('github.loadingLogs');
  api.getGithubWorkflowJobLogs(jobId).then((data) => {
    if (!data?.ok) {
      pre.textContent = data?.error || t('github.loadLogsFailed');
      return;
    }
    pre.textContent = data.logs || t('github.noLogs');
  }).catch(() => {
    pre.textContent = t('github.loadLogsFailed');
  });
}

export function isGithubTabVisible() {
  return githubTabVisible;
}

export function setGithubPanelRouter(showPanel) {
  showPanelFallback = typeof showPanel === 'function' ? showPanel : null;
}

export function updateGithubTabVisibility() {
  return api.getGithubInfo().then((info) => {
    githubTabVisible = !!(info?.ok && info?.isGithub);
    const tabBtn = document.querySelector('.tab[data-panel="github"]');
    if (tabBtn) tabBtn.hidden = !githubTabVisible;
    renderRepoInfo(info);
    const panel = document.getElementById('github-panel');
    if (!githubTabVisible && panel?.classList.contains('active') && showPanelFallback) {
      showPanelFallback('git');
    }
    return info;
  }).catch(() => {
    githubTabVisible = false;
    const tabBtn = document.querySelector('.tab[data-panel="github"]');
    if (tabBtn) tabBtn.hidden = true;
    renderRepoInfo(null);
    return null;
  });
}

export function refreshGithubPanel() {
  renderRunsLoading();
  return updateGithubTabVisibility().then((info) => {
    if (!info?.isGithub) {
      renderRunsError(t('github.noGithubRemote'));
      return;
    }
    return api.getGithubWorkflowRuns().then((data) => {
      if (!data?.ok) {
        renderRunsError(data?.error || t('github.loadRunsFailed'));
        return;
      }
      renderRunsList(data);
    }).catch(() => {
      renderRunsError(t('github.loadRunsFailed'));
    });
  });
}

export function initGithubPanel() {
  const refreshBtn = document.getElementById('github-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshGithubPanel());
  }
  updateGithubTabVisibility();
}
