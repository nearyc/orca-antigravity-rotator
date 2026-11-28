import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorker, orcaCommandEnv, parseAccountResult, resolveOrcaBinary } from './src/worker.mjs';
import { GEMINI_GROUP, rankAccounts, scoreQuota } from './src/quota-policy.mjs';
import { createCockpitSource, normalizeCockpitQuota, requestCockpit } from './src/cockpit-quota.mjs';

const OTHER_GROUP = 'Claude and GPT models';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const cockpitQuota = (id, { at = NOW, status = 'available', reset = NOW + HOUR, five = 80 } = {}) => ({
  platform: 'antigravity', accountId: id,
  quota: { status, updatedAt: Math.floor(at / 1000), data: { models: [
    { name: 'gemini-5h', percentage: five, reset_time: new Date(reset).toISOString() },
    { name: 'gemini-weekly', percentage: 68, reset_time: new Date(NOW + 60 * HOUR).toISOString() },
    { name: 'claude-5h', percentage: 0 },
  ] } },
});

test('Cockpit translates only Gemini windows and rejects stale or mismatched readings', () => {
  const response = cockpitQuota('one');
  const valid = normalizeCockpitQuota(response, 'one');
  assert.equal(valid.updatedAt, NOW);
  assert.equal(valid.status, 'ok');
  assert.deepEqual(valid.buckets.map(({ windowMinutes, usedPercent }) => [windowMinutes, usedPercent]), [[300, 20], [10080, 32]]);
  assert.equal(normalizeCockpitQuota(response, 'another'), null);
  response.quota.data.summaryStale = true;
  assert.equal(normalizeCockpitQuota(response, 'one').status, 'error');
  delete response.quota.data.summaryStale;
  response.quota.updatedAt = NOW;
  assert.equal(normalizeCockpitQuota(response, 'one').status, 'error');
});

test('Cockpit client correlates replies, enforces protocol version and rejects writes', async () => {
  const server = { port: 43123, token: 'fixture-local-token' };
  const command = { operation: 'list', platform: 'antigravity' };
  let version = 1;
  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      assert.equal(url, 'ws://127.0.0.1:43123');
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(text) {
      const { type, payload } = JSON.parse(text);
      assert.equal(type, 'request.automation');
      assert.equal(payload.authToken, 'fixture-local-token');
      assert.deepEqual(payload.command, command);
      for (const requestId of ['unrelated', payload.requestId]) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.automation',
          payload: { requestId, version, status: 'ok', data: requestId === 'unrelated' ? 'ignore' : ['matched'] } }) }));
      }
    }
    close() {}
  }
  assert.deepEqual(await requestCockpit(server, command, 1000, FakeSocket), ['matched']);
  version = 2;
  await assert.rejects(requestCockpit(server, command, 1000, FakeSocket), /不兼容/);
  await assert.rejects(requestCockpit(server, { ...command, operation: 'switch' }, 1000, FakeSocket), /不支持的/);
  class SilentSocket extends EventTarget { close() {} }
  await assert.rejects(requestCockpit(server, command, 5, SilentSocket), /超时/);
});

test('Cockpit refreshes one due account per check and a failed refresh cannot revive old data', async () => {
  let at = NOW;
  const writes = [];
  const seen = new Map([
    ['a', cockpitQuota('a', { at: NOW - 5 * 60_000 })],
    ['b', cockpitQuota('b', { at: NOW - HOUR, reset: NOW })],
  ]);
  const read = createCockpitSource({ now: () => at, discover: async () => ({}), request: async (_server, cmd) => {
    if (cmd.operation === 'list') return ['a', 'b'].map((id) => ({ id, email: `${id}@example.test` }));
    if (!cmd.refresh) return seen.get(cmd.accountId);
    writes.push(cmd.accountId);
    if (cmd.accountId === 'a') throw new Error('fixture failure');
    const fresh = cockpitQuota(cmd.accountId, { at });
    seen.set(cmd.accountId, fresh);
    return fresh;
  } });
  const run = () => read({ activeEmail: 'a@example.test', refresh: true });
  const first = await run();
  assert.deepEqual(writes, ['a']);
  assert.equal(first.accounts[0].usage.status, 'error');
  at += 60_000;
  const second = await run();
  assert.deepEqual(writes, ['a']);
  assert.equal(second.accounts[0].usage.status, 'error');
  assert.equal(rankAccounts(second, at).alternative, null);
  at += 60_000;
  const third = await run();
  assert.deepEqual(writes, ['a', 'b']);
  assert.equal(rankAccounts(third, at).alternative.id, 'b');
});
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

function harness(t, { run, readCockpit, now = () => NOW, prefs = { pool: 'gemini', auto: true } }) {
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
    run, readCockpit, now,
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
  assert.equal(rankAccounts(roster('a', 10), NOW).current.low, false);
  assert.equal(rankAccounts(roster('a', 9), NOW).current.low, true);
  assert.equal(rankAccounts(roster('a', 99, 9), NOW).current.low, true);
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

test('one 120-second timer, cached reads, masking and deduplication', async (t) => {
  let complete;
  let reads = 0;
  const h = harness(t, { run: () => {
    reads++;
    return new Promise((resolve) => { complete = resolve; });
  } });
  assert.equal(h.interval, 120_000);
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

test('low-quota rotation runs on a poll below 10%, not at 10%, and confirms the account ID', async (t) => {
  const writes = [];
  let raw = roster('a', 10);
  const h = harness(t, { run: async (args) => {
    if (args[1] === 'list') return raw;
    writes.push(args[5]);
    raw = roster('c');
    return raw;
  } });
  await h.handlers.get('accounts.refresh')();
  await h.tick();
  assert.deepEqual(writes, []);
  raw = roster('a', 9);
  await h.handlers.get('accounts.refresh')();
  assert.deepEqual(writes, []);
  const updated = await h.tick();
  assert.deepEqual(writes, ['c']);
  assert.equal(updated.accounts.find((entry) => entry.active).id, 'c');
  assert.ok(h.calls.some(({ method }) => method === 'notifications.show'));
  assert.ok(h.calls.every(({ method }) => method !== 'terminal.sendText'));
});

for (const source of ['orca', 'cockpit']) {
  test(`${source}: periodic rotation waits 30 minutes, skips ties, and restarts after a confirmed switch`, async (t) => {
    const period = 30 * 60_000;
    let at = NOW;
    let active = 'a';
    let remaining = { a: 40, b: 40 };
    const writes = [];
    const accounts = () => Object.entries(remaining).map(([id, five]) => account(id, five, 70, at));
    const h = harness(t, {
      prefs: { source, auto: true }, now: () => at,
      readCockpit: async () => ({ accounts: accounts().map((row) => ({ ...row, id: `cpt-${row.id}` })) }),
      run: async (args) => {
        if (args[1] === 'select') {
          active = args[5];
          writes.push(active);
        }
        return {
          accounts: accounts(), activeAccountId: active, chatUsesAgy: true,
          currentAccount: { identityKnown: true, email: `${active}@example.test` },
        };
      },
    });
    const initial = await h.handlers.get('accounts.refresh')();
    assert.equal(initial.lowQuota, 10);
    assert.equal(initial.upgradeMinutes, 30);

    remaining.b = 80;
    at = NOW + period - 1;
    await h.tick();
    assert.deepEqual(writes, []);

    remaining.b = 40;
    at = NOW + period;
    await h.tick();
    assert.deepEqual(writes, []);

    remaining.b = 80;
    await h.tick();
    assert.deepEqual(writes, ['b']);

    remaining.a = 90;
    at = NOW + 2 * period - 1;
    await h.tick();
    assert.deepEqual(writes, ['b']);
    at = NOW + 2 * period;
    await h.tick();
    assert.deepEqual(writes, ['b', 'a']);
  });
}

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
  assert.match((await h.tick()).policy, /暂无可切换且额度充足/);
  raw = null;
  const state = await h.tick();
  assert.equal(state.accounts.length, 2);
  assert.equal(state.recommendedId, null);
  assert.match(state.error, /无法读取/);
  assert.doesNotMatch(JSON.stringify(h.log), /private stdout/);
});

const cockpitPrefs = { source: 'cockpit', auto: true };
const cockpitRoster = () => ({ accounts: [
  { ...account('cpt-a', 5, 75), email: 'a@example.test' },
  { ...account('cpt-b', 61, 65), email: 'b@example.test' },
  account('cockpit-only', 100, 100),
] });
const orcaIdentity = (id) => ({ ...roster(id, 90), currentAccount: { email: `${id}@example.test`, identityKnown: true } });

test('Cockpit roster independently supplies scoring and rotation reuses a verified Orca ID', async (t) => {
  const writes = [];
  let active = 'a';
  let reserveExpired = true;
  const h = harness(t, { prefs: cockpitPrefs, readCockpit: async ({ activeEmail, refresh }) => {
    assert.equal(activeEmail, `${active}@example.test`);
    const result = cockpitRoster();
    if (reserveExpired) result.accounts[1].usage.buckets[0].resetsAt = NOW;
    if (!refresh) assert.fail('background reads should request bounded refresh');
    return result;
  }, run: async (args) => {
    if (args[1] === 'list') return orcaIdentity(active);
    writes.push(args[5]);
    active = args[5];
    return orcaIdentity(active);
  } });
  const first = await h.handlers.get('accounts.refresh')();
  assert.equal(first.source, 'cockpit');
  assert.equal(first.nextId, null);
  assert.equal(first.accounts.find(({ id }) => id === 'cockpit-only').switchable, false);
  assert.equal(first.accounts.find(({ id }) => id === 'cpt-a').fiveHour.remaining, 5);
  assert.deepEqual(writes, []);
  reserveExpired = false;
  const result = await h.tick();
  assert.deepEqual(writes, ['b']);
  assert.equal(result.accounts.find(({ active }) => active).id, 'cpt-b');
});

test('automatic rotation aborts if the actual login changes during Cockpit refresh', async (t) => {
  let active = 'a';
  let changeDuringRefresh = false;
  const commands = [];
  const h = harness(t, { prefs: cockpitPrefs, readCockpit: async () => {
    if (changeDuringRefresh) active = 'b';
    return cockpitRoster();
  }, run: async (args) => {
    commands.push(args[1]);
    return orcaIdentity(active);
  } });
  await h.handlers.get('accounts.refresh')();
  changeDuringRefresh = true;
  const state = await h.tick();
  assert.deepEqual(commands, ['list', 'list', 'list']);
  assert.equal(state.accounts.find(({ active }) => active).id, 'cpt-b');
  assert.ok(!h.calls.some(({ method }) => method === 'notifications.show'));
});

test('Cockpit data remains visible without Orca; ambiguous or missing identities cannot switch', async (t) => {
  let identity = null;
  const h = harness(t, { prefs: { ...cockpitPrefs, masked: true }, readCockpit: async () => cockpitRoster(), run: async (args) => {
    assert.equal(args[1], 'list');
    if (!identity) throw new Error('private diagnostic');
    return identity;
  } });
  const first = await h.handlers.get('accounts.refresh')();
  assert.equal(first.accounts.length, 3);
  assert.equal(first.identityUnavailable, true);
  assert.equal(first.nextId, null);
  assert.doesNotMatch(JSON.stringify(first), /@example\.test/);
  identity = orcaIdentity('a');
  identity.accounts.push({ ...account('duplicate', 100, 100), email: 'B@EXAMPLE.TEST' });
  const next = await h.tick();
  assert.equal(next.identityUnavailable, false);
  assert.equal(next.nextId, null);
  assert.equal(next.accounts.find(({ id }) => id === 'cpt-b').switchable, false);
  assert.equal((await h.handlers.get('accounts.selectTarget')({ id: 'cpt-b' })).success, false);
});

test('changing source disarms automation and a Cockpit outage does not fall back to Orca', async (t) => {
  const h = harness(t, { run: async () => orcaIdentity('a'), readCockpit: async () => { throw new Error('private diagnostic'); } });
  await h.handlers.get('accounts.refresh')();
  assert.equal((await h.handlers.get('preferences.set')({ source: 'cockpit' })).success, true);
  const next = await h.handlers.get('accounts.read')();
  assert.equal(next.source, 'cockpit');
  assert.equal(next.auto, false);
  assert.equal(next.accounts.length, 0);
  assert.equal(next.error, '无法读取 Cockpit 账号。');
  assert.doesNotMatch(JSON.stringify(h.log), /private diagnostic/);
});
