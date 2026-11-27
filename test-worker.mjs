import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorker, parseAccountResult, resolveOrcaBinary } from './src/worker.mjs';
import { POOLS, rankAccounts, scoreQuota } from './src/quota-policy.mjs';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const bucket = (group, windowMinutes, remaining, resetsAt = NOW + 6 * HOUR) =>
  ({ group, windowMinutes, usedPercent: 100 - remaining, resetsAt });
function account(id, short, week, updatedAt = NOW) {
  return { id, email: `${id}@example.test`, usage: {
    status: 'ok', updatedAt,
    buckets: [
      bucket(POOLS.gemini, 300, short),
      bucket(POOLS.gemini, 10080, week, NOW + 100 * HOUR),
      bucket(POOLS['claude-gpt'], 300, 100),
      bucket(POOLS['claude-gpt'], 10080, 100),
    ],
  } };
}
const roster = (activeAccountId = 'a', short = 5, week = 75) => ({
  accounts: [account('a', short, week), account('b', 81, 37), account('c', 66, 76)],
  activeAccountId, chatUsesAgy: true,
});

function harness(t, { run, prefs = { pool: 'gemini', auto: true } }) {
  const handlers = new Map();
  const calls = [];
  const posts = [];
  const log = [];
  let tick;
  let interval;
  let cleared = false;
  const subscription = () => ({ dispose() {} });
  const worker = createWorker({
    commands: { register: subscription }, events: { on: subscription },
    storage: { get: async () => prefs, set: async () => {} },
    panels: {
      handle: (name, fn) => { handlers.set(name, fn); return subscription(); },
      post: (_name, state) => posts.push(state),
    },
    host: { call: async (method, params) => { calls.push({ method, params }); } },
    log: (message) => log.push(message),
  }, {
    run, now: () => NOW,
    schedule: (fn, ms) => { tick = fn; interval = ms; return 42; },
    cancel: (id) => { assert.equal(id, 42); cleared = true; },
  });
  t.after(worker.dispose);
  return { handlers, calls, posts, log, tick, interval, worker, isCleared: () => cleared };
}

test('Windows replaces a .cmd override with the matching exe and searches the Windows PATH', () => {
  const exe = 'C:\\Tools\\orca.exe';
  const exists = (candidate) => candidate === exe;
  assert.equal(resolveOrcaBinary('win32', { ORCA_CLI_COMMAND: 'C:\\Tools\\orca.cmd' }, 'C:\\Users\\test', exists), exe);
  assert.equal(resolveOrcaBinary('win32', { Path: 'C:\\Other;"C:\\Tools"' }, 'C:\\Users\\test', exists), exe);
  assert.equal(resolveOrcaBinary('win32', {}, 'C:\\Users\\test', () => false), null);
});

test('pool isolation, exact low threshold, and composite weekly ranking', () => {
  const raw = roster();
  const result = rankAccounts(raw, 'gemini', NOW);
  assert.equal(result.current.low, true);
  assert.equal(result.best.id, 'c');
  assert.equal(result.alternative.id, 'c');
  assert.equal(rankAccounts(roster('a', 6), 'gemini', NOW).current.low, false);
  assert.equal(rankAccounts(roster('a', 99, 5), 'gemini', NOW).current.low, true);
  assert.equal(rankAccounts(raw, 'claude-gpt', NOW).current.low, false);
  assert.ok(scoreQuota(81, 37, NOW + HOUR, NOW) > scoreQuota(81, 37, NOW + 100 * HOUR, NOW));
  assert.ok(scoreQuota(80, 10, null, NOW) < scoreQuota(80, 20, null, NOW) / 2);
  assert.equal(scoreQuota(0, 100, NOW + HOUR, NOW), 0);
});

test('stale, reset, missing and invalid windows do not become eligible', () => {
  const raw = roster();
  raw.accounts[0].usage.updatedAt = NOW - 10 * 60_000 - 1;
  raw.accounts[1].usage.updatedAt = NOW - 5 * HOUR - 1;
  raw.accounts[2].usage.buckets[0].resetsAt = NOW;
  assert.equal(rankAccounts(raw, 'gemini', NOW).best, null);
  raw.accounts[2].usage.buckets[0].resetsAt = NOW + HOUR;
  raw.accounts[2].usage.buckets.splice(1, 1);
  assert.equal(rankAccounts(raw, 'gemini', NOW).best, null);
  raw.accounts[2].usage.buckets.push(bucket(POOLS.gemini, 10080, -1));
  assert.equal(rankAccounts(raw, 'gemini', NOW).best, null);
});

test('parsing separates empty data from unsupported or malformed replies', () => {
  assert.deepEqual(parseAccountResult({ accounts: [], activeAccountId: null }).accounts, []);
  assert.throws(() => parseAccountResult({}));
  assert.throws(() => parseAccountResult(roster('wrong')));
});

test('one 60-second timer, cached reads, masking and deduplication', async (t) => {
  let complete;
  let reads = 0;
  const h = harness(t, { run: () => {
    reads++;
    return new Promise((resolve) => { complete = resolve; });
  } });
  assert.equal(h.interval, 60_000);
  assert.equal((await h.handlers.get('accounts.read')()).syncedAt, null);
  const pending = h.handlers.get('accounts.refresh')();
  const second = h.handlers.get('accounts.refresh')();
  assert.equal((await h.handlers.get('accounts.selectTarget')({ id: 'b' })).success, false);
  complete(roster());
  const [first, other] = await Promise.all([pending, second]);
  assert.equal(reads, 1);
  assert.deepEqual(first, other);
  assert.equal(first.accounts.length, 3);
  assert.equal(first.accounts[0].label, '账号 1');
  assert.equal((await h.handlers.get('preferences.set')({ masked: false })).success, true);
  assert.equal((await h.handlers.get('accounts.read')()).accounts[0].label, 'a@example.test');
  assert.equal(reads, 1);
});

test('auto-switch starts only on a poll, at 5%, and confirms with account ID', async (t) => {
  const writes = [];
  let raw = roster('a', 6);
  const h = harness(t, { run: async (args) => {
    if (args[1] === 'list') return raw;
    writes.push(args[5]);
    raw = roster('c');
    return raw;
  } });
  await h.handlers.get('accounts.refresh')();
  await h.tick();
  assert.deepEqual(writes, []);
  raw = roster();
  await h.handlers.get('accounts.refresh')();
  assert.deepEqual(writes, []);
  const updated = await h.tick();
  assert.deepEqual(writes, ['c']);
  assert.equal(updated.accounts.find((entry) => entry.active).id, 'c');
  assert.ok(h.calls.some(({ method }) => method === 'notifications.show'));
  assert.ok(h.calls.every(({ method }) => method !== 'terminal.sendText'));
});

test('failed confirmation rereads once, publishes actual account, pauses auto, and does not notify success', async (t) => {
  let reads = 0;
  let writes = 0;
  const h = harness(t, { run: async (args) => {
    if (args[1] === 'list') reads++;
    else writes++;
    return roster();
  } });
  await h.handlers.get('accounts.refresh')();
  const state = await h.tick();
  assert.equal(reads, 3);
  assert.equal(writes, 1);
  assert.equal(state.accounts.find((entry) => entry.active).id, 'a');
  assert.match(state.policy, /上次切换未确认/);
  assert.ok(!h.calls.some(({ method }) => method === 'notifications.show'));
  await h.tick();
  assert.equal(writes, 1);
});

test('recommended switch distinguishes a failed read, an empty roster, and no eligible account', async (t) => {
  let raw = null;
  const h = harness(t, { run: async (args) => {
    assert.equal(args[1], 'list');
    if (!raw) throw new Error('mock CLI failure');
    return raw;
  } });
  await h.handlers.get('accounts.refresh')();
  const rotate = h.handlers.get('accounts.rotateNow');
  assert.deepEqual(await rotate(), { success: false, reason: '无法读取 Orca 账号。' });
  raw = { accounts: [], activeAccountId: null };
  assert.deepEqual(await rotate(), { success: false, reason: '尚未在 Orca 中保存账号。' });
  raw = { ...roster(), accounts: [account('a', 5, 60), account('b', 5, 100)] };
  assert.deepEqual(await rotate(), { success: false, reason: '没有额度数据有效且充足的账号。' });
});

test('unknown route, missing backup and failed refresh cannot rotate', async (t) => {
  let raw = { ...roster(), chatUsesAgy: false };
  const h = harness(t, { run: async (args) => {
    assert.equal(args[1], 'list');
    if (!raw) throw new Error('private stdout must stay private');
    return raw;
  } });
  await h.handlers.get('accounts.refresh')();
  assert.match((await h.tick()).policy, /未确认本机聊天/);
  raw = { ...roster(), accounts: [account('a', 5, 60), account('b', 5, 100)] };
  assert.match((await h.tick()).policy, /暂无额度充足/);
  raw = null;
  const state = await h.tick();
  assert.equal(state.accounts.length, 2);
  assert.equal(state.recommendedId, null);
  assert.match(state.error, /无法读取/);
  assert.doesNotMatch(JSON.stringify(h.log), /private stdout/);
});
