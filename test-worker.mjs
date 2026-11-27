import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorker, orcaCommandEnv, parseAccountResult, resolveOrcaBinary } from './src/worker.mjs';
import { GEMINI_GROUP, rankAccounts, scoreQuota } from './src/quota-policy.mjs';

const OTHER_GROUP = 'Claude and GPT models';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const bucket = (group, windowMinutes, remaining, resetsAt = NOW + 6 * HOUR) =>
  ({ group, windowMinutes, usedPercent: 100 - remaining, resetsAt });
function account(id, short, week, updatedAt = NOW) {
  return { id, email: `${id}@example.test`, usage: {
    status: 'ok', updatedAt,
    buckets: [
      bucket(GEMINI_GROUP, 300, short),
      bucket(GEMINI_GROUP, 10080, week, NOW + 100 * HOUR),
      bucket(OTHER_GROUP, 300, 100),
      bucket(OTHER_GROUP, 10080, 100),
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

test('Windows worker supplies missing APPDATA without overriding an existing profile path', () => {
  const home = 'C:\\Users\\test';
  const inherited = { USERPROFILE: home, ELECTRON_RUN_AS_NODE: '1', ORCA_ENVIRONMENT: 'remote', ORCA_PAIRING_CODE: 'mock' };
  assert.deepEqual(orcaCommandEnv('win32', inherited, home), {
    USERPROFILE: home, ELECTRON_RUN_AS_NODE: '1', APPDATA: `${home}\\AppData\\Roaming`,
  });
  assert.equal(orcaCommandEnv('win32', { APPDATA: 'D:\\Profiles\\Roaming' }, home).APPDATA, 'D:\\Profiles\\Roaming');
  assert.equal(orcaCommandEnv('linux', {}, '/home/test').APPDATA, undefined);
});

test('only Gemini buckets affect the exact low threshold and composite ranking', () => {
  const raw = roster();
  raw.accounts[2].usage.buckets[2].usedPercent = 100;
  raw.accounts[2].usage.buckets[3].usedPercent = 100;
  const result = rankAccounts(raw, NOW);
  assert.equal(result.current.low, true);
  assert.equal(result.best.id, 'c');
  assert.equal(result.alternative.id, 'c');
  assert.equal(rankAccounts(roster('a', 6), NOW).current.low, false);
  assert.equal(rankAccounts(roster('a', 99, 5), NOW).current.low, true);
  assert.ok(scoreQuota(81, 37, NOW + HOUR, NOW) > scoreQuota(81, 37, NOW + 100 * HOUR, NOW));
  assert.ok(scoreQuota(80, 10, null, NOW) < scoreQuota(80, 20, null, NOW) / 2);
  assert.equal(scoreQuota(0, 100, NOW + HOUR, NOW), 0);
});

test('stale, reset, missing and invalid windows do not become eligible', () => {
  const raw = roster();
  raw.accounts[0].usage.updatedAt = NOW - 10 * 60_000 - 1;
  raw.accounts[1].usage.updatedAt = NOW - 5 * HOUR - 1;
  raw.accounts[2].usage.buckets[0].resetsAt = NOW;
  assert.equal(rankAccounts(raw, NOW).best, null);
  raw.accounts[2].usage.buckets[0].resetsAt = NOW + HOUR;
  raw.accounts[2].usage.buckets.splice(1, 1);
  assert.equal(rankAccounts(raw, NOW).best, null);
  raw.accounts[2].usage.buckets.push(bucket(GEMINI_GROUP, 10080, -1));
  assert.equal(rankAccounts(raw, NOW).best, null);
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
  assert.equal(first.accounts[0].label, 'a@example.test');
  assert.equal((await h.handlers.get('preferences.set')({ masked: true })).success, true);
  const masked = await h.handlers.get('accounts.read')();
  assert.equal(masked.accounts[0].label, '账号 1');
  assert.doesNotMatch(JSON.stringify(masked), /@example\.test/);
  assert.equal(reads, 1);
});

test('without saved preferences, Gemini quotas and the next candidate are visible with emails', async (t) => {
  const h = harness(t, { prefs: null, run: async (args) => {
    assert.equal(args[1], 'list');
    return roster('b');
  } });
  const state = await h.handlers.get('accounts.refresh')();
  assert.equal(state.auto, false);
  assert.equal(state.masked, false);
  assert.equal(state.accounts.find(({ id }) => id === 'b').label, 'b@example.test');
  assert.equal(state.accounts.find(({ id }) => id === 'b').fiveHour.remaining, 81);
  assert.equal(state.accounts.find(({ id }) => id === 'b').weekly.remaining, 37);
  assert.equal(state.nextId, 'c');
  assert.equal(state.recommendedId, 'c');
});

test('next candidate is distinct from an immediate recommendation when the current account leads', async (t) => {
  const h = harness(t, { prefs: null, run: async () => roster('c') });
  const state = await h.handlers.get('accounts.refresh')();
  assert.equal(state.nextId, 'b');
  assert.equal(state.recommendedId, null);
  assert.match(state.recommendation, /无需立即切换/);
});

test('legacy Claude/GPT automation stays off; Gemini recommendation works without a pool setting', async (t) => {
  const writes = [];
  const h = harness(t, { prefs: { pool: 'claude-gpt', auto: true, masked: true }, run: async (args) => {
    if (args[1] === 'list') return roster();
    writes.push(args[5]);
    return roster(args[5]);
  } });
  const state = await h.handlers.get('accounts.refresh')();
  assert.equal(state.auto, false);
  assert.equal(state.masked, true);
  await h.tick();
  assert.deepEqual(writes, []);
  assert.deepEqual(await h.handlers.get('accounts.rotateNow')(), { success: true });
  assert.deepEqual(writes, ['c']);
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
