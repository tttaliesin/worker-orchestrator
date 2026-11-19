import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { unwrapHostResult } from './index.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const within = (root, directory) => {
  const suffix = relative(root, directory);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

function directory(value) {
  if (!text(value) || !isAbsolute(value)) return null;
  try {
    return statSync(value).isDirectory() ? realpathSync.native(value) : null;
  } catch {
    return null;
  }
}

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[name];
  return spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 5000 });
}

export function resolveControllerScope(start) {
  const currentDirectory = directory(start);
  if (!currentDirectory) return null;
  const top = git(currentDirectory, 'rev-parse', '--show-toplevel');
  if (top.status !== 0) {
    if (top.status === 128 && /not a git repository/i.test(top.stderr)) {
      return { projectRoot: currentDirectory, roots: [currentDirectory], isGit: false };
    }
    return null;
  }
  const current = directory(top.stdout.replace(/\r?\n$/, ''));
  const worktrees = git(currentDirectory, 'worktree', 'list', '--porcelain', '-z');
  if (!current || worktrees.status !== 0) return null;
  const listed = worktrees.stdout.split('\0').filter(line => line.startsWith('worktree '));
  const roots = [...new Set(listed.map(line => directory(line.slice('worktree '.length))).filter(Boolean))];
  const projectRoot = directory(listed[0]?.slice('worktree '.length));
  return projectRoot && roots.includes(current) ? { projectRoot, roots, isGit: true } : null;
}

function readHistory(pages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const seenCursors = new Set();
  const threads = [];
  let cursor = null;
  for (const [index, page] of pages.entries()) {
    if (!page || (page.cursor ?? null) !== cursor || seenCursors.has(cursor)) return null;
    seenCursors.add(cursor);
    const result = unwrapHostResult(page.result);
    if (!Array.isArray(result.threads) || !(result.nextCursor === null || text(result.nextCursor))) return null;
    if (!result.threads.every(thread => thread?.kind === 'codex' && text(thread.id) && text(thread.hostId))) return null;
    threads.push(...result.threads.filter(thread => thread.archived !== true));
    cursor = result.nextCursor;
    if (cursor === null && index !== pages.length - 1) return null;
  }
  return cursor === null ? threads : null;
}

function repositoryMembership(cwd, scope) {
  const real = directory(cwd);
  if (!real) return null;
  if (!scope.roots.some(root => within(root, real))) return false;
  if (scope.roots.includes(real) || !scope.isGit) return true;
  const root = git(real, 'rev-parse', '--show-toplevel');
  const actual = root.status === 0 ? directory(root.stdout.replace(/\r?\n$/, '')) : null;
  return actual ? scope.roots.includes(actual) : null;
}

function membership(thread, scope, projects, inRepository) {
  const owner = projects.get(thread.projectId);
  const exact = owner && scope.roots.includes(owner.path);
  if (exact) return inRepository !== false ? true : null;
  if (inRepository === true) return !owner || scope.roots.some(root => within(owner.path, root)) ? true : null;
  if (inRepository === null && (!owner || scope.roots.some(root => within(owner.path, root)))) return null;
  return false;
}

export function assessControllerCandidate(scope, threadId, hostId, projectsResult, pages) {
  let rows;
  try { rows = readHistory(pages); } catch {}
  if (!rows) return { reason: 'INCOMPLETE_HISTORY' };
  const callerHosts = new Set(rows.filter(thread => thread.id === threadId).map(thread => thread.hostId));
  if (callerHosts.size !== 1 || (hostId && !callerHosts.has(hostId))) return { reason: 'CALLER_NOT_FOUND' };
  const [observedHostId] = callerHosts;
  let catalog;
  try { catalog = unwrapHostResult(projectsResult).projects; } catch {}
  if (!Array.isArray(catalog)) return { reason: 'AMBIGUOUS_PROJECT' };
  const projects = new Map();
  for (const project of catalog) {
    if (project?.hostId !== observedHostId || !['local', 'remote'].includes(project.projectKind)) continue;
    const projectPath = directory(project.path);
    if (!projectPath || !text(project.projectId)) continue;
    if (projects.has(project.projectId) && projects.get(project.projectId).path !== projectPath) {
      return { reason: 'AMBIGUOUS_PROJECT' };
    }
    projects.set(project.projectId, { id: project.projectId, path: projectPath });
  }
  const suitable = [...projects.values()].filter(project => scope.roots.includes(project.path) ||
    (scope.isGit && within(project.path, scope.projectRoot)))
    .sort((a, b) => Number(b.path === scope.projectRoot) - Number(a.path === scope.projectRoot) ||
      Number(scope.roots.includes(b.path)) - Number(scope.roots.includes(a.path)) ||
      b.path.length - a.path.length);
  const selected = suitable[0];
  if (!selected) return { reason: 'AMBIGUOUS_PROJECT' };
  const callerProjects = new Set(rows.filter(row => row.id === threadId && row.hostId === observedHostId)
    .map(row => row.projectId));
  const [callerProject] = callerProjects;
  const equallySpecific = suitable.filter(project => (project.path === scope.projectRoot) === (selected.path === scope.projectRoot) &&
    scope.roots.includes(project.path) === scope.roots.includes(selected.path) && project.path.length === selected.path.length);
  const hostProject = equallySpecific.length === 1 ? selected
    : equallySpecific.find(project => callerProjects.size === 1 && project.id === callerProject);
  if (!hostProject) return { reason: 'AMBIGUOUS_PROJECT' };

  const members = new Map();
  const directories = new Map();
  for (const thread of rows) {
    if (thread.hostId !== observedHostId) continue;
    if (!directories.has(thread.cwd)) directories.set(thread.cwd, repositoryMembership(thread.cwd, scope));
    const match = membership(thread, scope, projects, directories.get(thread.cwd));
    if (match === null || (members.has(thread.id) && members.get(thread.id) !== match)) {
      return { reason: 'AMBIGUOUS_THREAD_SCOPE' };
    }
    members.set(thread.id, match);
  }
  if (members.get(threadId) !== true) return { reason: 'CALLER_NOT_FOUND' };
  const matchingThreads = [...members.values()].filter(Boolean).length;
  if (matchingThreads !== 1) return { reason: 'MULTIPLE_THREADS', matchingThreads };
  return { reason: 'CANDIDATE', hostId: observedHostId, hostProjectId: hostProject.id, matchingThreads };
}
