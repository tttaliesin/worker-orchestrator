import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const cli = fileURLToPath(new URL('../../src/cli/main.mjs', import.meta.url));
const workspace = realpathSync.native(fileURLToPath(new URL('../../', import.meta.url)));
const execFileAsync = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(GIT_|CODEX_(THREAD|HOST)_ID$)/i.test(key)));

function gitCommand(cwd, args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

function gitRepository(root) {
  mkdirSync(root, { recursive: true });
  gitCommand(root, ['init', '--quiet', '--template=']);
  return root;
}

function fixture(t) {
  const local = join(workspace, '.local');
  mkdirSync(local, { recursive: true });
  assert.equal(realpathSync.native(local), local);
  const root = mkdtempSync(join(local, 'candidate-test-'));
  t.after(() => {
    const target = realpathSync.native(root);
    assert.equal(dirname(target), local);
    assert.equal(target, root);
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  });

  const stateDir = join(root, 'state');
  const projectRoot = gitRepository(join(root, 'project'));
  async function runTogether(calls) {
    const processes = calls.map(({ command, threadId }) => execFileAsync(process.execPath,
      [cli, command, '--state-dir', stateDir, '--input', '-'], {
        env: { ...env, CODEX_HOST_ID: 'local', ...(threadId === undefined ? {} : { CODEX_THREAD_ID: threadId }) },
        windowsHide: true, timeout: 20_000,
      }));

    // Start every CLI before supplying input so the claim calls can race on SQLite.
    for (const [index, execution] of processes.entries()) {
      execution.child.stdin.on('error', () => {}); // The process result reports early exit.
      execution.child.stdin.end(JSON.stringify(calls[index].input));
    }
    const results = await Promise.allSettled(processes);
    return results.map(result => {
      if (result.status === 'rejected') {
        throw new Error(`${result.reason.message}\n${result.reason.stdout ?? ''}`, { cause: result.reason });
      }
      const response = JSON.parse(result.value.stdout);
      assert.equal(response.ok, true, result.value.stdout);
      return response;
    });
  }

  async function run(command, input, threadId) {
    const [response] = await runTogether([{ command, input, threadId }]);
    return response;
  }
  return { root, projectRoot, run, runTogether };
}

function catalogEntry(path, projectId = 'desktop-project', isGitRepository = true) {
  return { projectId, projectKind: 'local', path, hostId: 'local', isGitRepository };
}

function thread(id, cwd, { projectId = 'desktop-project', status = { type: 'idle' } } = {}) {
  return { id, kind: 'codex', projectId, hostId: 'local', cwd, status };
}

function page(threads, { cursor = null, nextCursor = null } = {}) {
  return { cursor, result: { threads, nextCursor } };
}

function soleThread(projectRoot, threadId, projectId = 'desktop-project') {
  return {
    projectRoot,
    projects: { projects: [catalogEntry(projectRoot, projectId)] },
    threadPages: [page([thread(threadId, projectRoot, { projectId })])],
  };
}

function assertUnclaimed(result, decision, reason) {
  assert.equal(result.decision, decision);
  assert.equal(result.claimed, false);
  if (reason !== undefined) assert.equal(result.reason, reason);
}

function registerLegacyController(run, projectRoot) {
  return run('project', {
    projectId: 'legacy-project', projectRoot, hostProjectId: 'desktop-project',
    controller: { threadId: 'old-controller', hostId: 'local' },
    authorization: {
      createWorkers: true, sendFollowups: false, archiveCompleted: false, restoreWorkers: false,
      source: 'Synthetic CLI test fixture',
    },
  });
}

test('candidate defaults to read-only classification', async t => {
  const { projectRoot, run } = fixture(t);
  assertUnclaimed(await run('candidate', soleThread(projectRoot, 'current'), 'current'), 'candidate');

  const lookup = await run('candidate', { projectRoot }, 'current');
  assertUnclaimed(lookup, 'undetermined', 'DISCOVERY_REQUIRED');
  assert.equal(lookup.project, null);
});

test('candidate requires the caller identity from the subprocess environment', async t => {
  const { projectRoot, run } = fixture(t);
  const input = { ...soleThread(projectRoot, 'current'), claim: true };
  assertUnclaimed(await run('candidate', input), 'undetermined', 'MISSING_CURRENT_THREAD');
});

test('candidate requires the full cursor chain and counts older notLoaded threads', async t => {
  const { projectRoot, run } = fixture(t);
  const first = page([thread('current', projectRoot)], { nextCursor: 'older' });
  const input = { ...soleThread(projectRoot, 'current'), claim: true, threadPages: [first] };
  assertUnclaimed(await run('candidate', input, 'current'), 'undetermined', 'INCOMPLETE_HISTORY');

  const older = page([thread('older-thread', projectRoot, { status: { type: 'notLoaded' } })], { cursor: 'older' });
  const complete = await run('candidate', { ...input, threadPages: [first, older] }, 'current');
  assertUnclaimed(complete, 'not_candidate', 'MULTIPLE_THREADS');
});

test('candidate honors a pre-existing controller absent from stale discovery', async t => {
  const { projectRoot, run } = fixture(t);
  const { project } = await registerLegacyController(run, projectRoot);

  const stale = { ...soleThread(projectRoot, 'new-thread'), claim: true };
  assertUnclaimed(await run('candidate', stale, 'new-thread'), 'not_candidate', 'CONTROLLER_EXISTS');

  const lookup = await run('candidate', { projectRoot }, 'old-controller');
  assertUnclaimed(lookup, 'controller');
  assert.deepEqual(lookup.project, project);
});

test('candidate counts each nonarchived thread once and holds on an unresolved project peer', async t => {
  const { root, projectRoot, run } = fixture(t);
  const input = {
    projectRoot,
    projects: { projects: [catalogEntry(root, 'desktop-project', false)] },
    threadPages: [
      page([thread('current', projectRoot)], { nextCursor: 'older' }),
      page([thread('current', projectRoot), { ...thread('archived', projectRoot), archived: true }], { cursor: 'older' }),
    ],
  };
  assertUnclaimed(await run('candidate', input, 'current'), 'candidate');
  input.threadPages[1].result.threads.push(thread('unknown-scope', null));
  assertUnclaimed(await run('candidate', { ...input, claim: true }, 'current'), 'undetermined', 'AMBIGUOUS_THREAD_SCOPE');
});

test('candidate recognizes a bound worker and prevents a claim in an unbound repository', async t => {
  const { root, projectRoot, run } = fixture(t);
  const { project } = await registerLegacyController(run, projectRoot);
  const scope = { projectId: project.projectId, taskId: 'fixture-task' };
  const { action } = await run('dispatch', {
    ...scope, requestId: 'fixture-request', prompt: 'Synthetic worker fixture',
    profile: { model: 'fixture-model', thinking: 'low' },
  });
  await run('record', {
    ...scope, actionId: action.id, hostResult: { threadId: 'worker', hostId: 'local' },
    evidenceRef: 'fixture:worker-receipt',
  });

  const lookup = await run('candidate', { projectRoot }, 'worker');
  assertUnclaimed(lookup, 'worker');
  assert.deepEqual(lookup.project, project);

  const unbound = gitRepository(join(root, 'unbound'));
  const stale = { ...soleThread(unbound, 'worker', 'unbound-desktop'), claim: true };
  assertUnclaimed(await run('candidate', stale, 'worker'), 'worker');
});

test('candidate isolates sibling Git repositories sharing a Desktop parent', async t => {
  const { root, projectRoot, runTogether } = fixture(t);
  const sibling = gitRepository(join(root, 'sibling'));
  const projects = { projects: [catalogEntry(root, 'desktop-project', false)] };
  const threadPages = [page([thread('parent', root), thread('first', projectRoot), thread('second', sibling)])];

  const results = await runTogether([['first', projectRoot], ['second', sibling]].map(([threadId, checkout]) => ({
    command: 'candidate', threadId, input: { projectRoot: checkout, projects, threadPages, claim: true },
  })));
  for (const result of results) {
    assert.equal(result.claimed, true);
    assert.equal(result.project.hostProjectId, 'desktop-project');
  }
  assert.notEqual(results[0].project.projectId, results[1].project.projectId);
});

test('candidate uses the same repository and binding from a real linked worktree', async t => {
  const { root, projectRoot, run } = fixture(t);
  const hooks = join(root, 'empty-hooks');
  mkdirSync(hooks);
  gitCommand(projectRoot, ['-c', 'user.name=Candidate Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, 'commit', '--quiet', '--allow-empty', '-m', 'Initialize fixture']);
  const worktree = join(root, 'linked');
  gitCommand(projectRoot, ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
  const input = {
    ...soleThread(projectRoot, 'current'),
    threadPages: [page([thread('current', projectRoot), thread('linked', worktree, { projectId: null })])],
  };
  assertUnclaimed(await run('candidate', input, 'current'), 'not_candidate', 'MULTIPLE_THREADS');
  const claim = await run('candidate', { ...soleThread(projectRoot, 'current'), claim: true }, 'current');
  assert.equal(claim.claimed, true);
  const fromWorktree = await run('candidate', { projectRoot: worktree }, 'linked');
  assertUnclaimed(fromWorktree, 'not_candidate', 'CONTROLLER_EXISTS');
  assert.deepEqual(fromWorktree.project, claim.project);
});

test('candidate distinguishes a Git catalog parent from a nested repository', async t => {
  const { root, projectRoot, runTogether } = fixture(t);
  gitRepository(root);
  const projects = { projects: [catalogEntry(root, 'git-parent'), catalogEntry(projectRoot, 'git-child')] };
  const threadPages = [page([
    thread('parent', root, { projectId: 'git-parent' }),
    thread('child', projectRoot, { projectId: 'git-child' }),
  ])];

  const [parent, child] = await runTogether([
    { command: 'candidate', threadId: 'parent', input: { projectRoot: root, projects, threadPages, claim: true } },
    { command: 'candidate', threadId: 'child', input: { projectRoot, projects, threadPages, claim: true } },
  ]);
  for (const result of [parent, child]) {
    assert.equal(result.decision, 'controller');
    assert.equal(result.claimed, true);
  }
  assert.equal(parent.project.projectRoot, root);
  assert.equal(parent.project.hostProjectId, 'git-parent');
  assert.equal(child.project.projectRoot, projectRoot);
  assert.equal(child.project.hostProjectId, 'git-child');
});

test('candidate persists exactly one concurrent first claim without mutation permissions', async t => {
  const { projectRoot, run, runTogether } = fixture(t);
  const callers = ['first', 'second'];
  const claims = await runTogether(callers.map(threadId => ({
    command: 'candidate', threadId, input: { ...soleThread(projectRoot, threadId), claim: true },
  })));
  assert.equal(claims.filter(result => result.claimed === true).length, 1);
  const winnerIndex = claims.findIndex(result => result.claimed === true);
  const { project, decision } = claims[winnerIndex];
  assert.equal(decision, 'controller');
  assertUnclaimed(claims[1 - winnerIndex], 'not_candidate', 'CONTROLLER_EXISTS');
  assert.deepEqual(project.controller, { threadId: callers[winnerIndex], hostId: 'local' });
  assert.equal(project.projectRoot, projectRoot);
  assert.equal(project.hostProjectId, 'desktop-project');

  const lookup = await run('candidate', { projectRoot }, callers[winnerIndex]);
  assertUnclaimed(lookup, 'controller');
  assert.deepEqual(lookup.project, project);
  const persisted = await run('status', { projectId: project.projectId });
  assert.deepEqual(persisted.project, project);
  assert.deepEqual(persisted.tasks, []);
  const { createWorkers, sendFollowups, archiveCompleted, restoreWorkers } = persisted.project.authorization;
  assert.deepEqual({ createWorkers, sendFollowups, archiveCompleted, restoreWorkers }, {
    createWorkers: false, sendFollowups: false, archiveCompleted: false, restoreWorkers: false,
  });
});
