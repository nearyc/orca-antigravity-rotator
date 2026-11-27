import { execFile } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { LOW_QUOTA, rankAccounts } from './quota-policy.mjs';
import { CockpitError, createCockpitSource, normalizedEmail } from './cockpit-quota.mjs';

const exec = promisify(execFile);
const LIST = ['account', 'list', '--agent', 'antigravity', '--json'];
const PREF_KEY = 'account-panel-preferences';
const DAY = 86_400_000;

function loadConfig() {
  try { return JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')); }
  catch { return {}; }
}

const config = loadConfig();
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
const POLL_SECONDS = Math.max(60, Math.min(3600, positive(config.native_refresh_seconds, 60)));
const COOLDOWN = positive(config.cooldown_seconds, 30) * 1000;
const CIRCUIT_WINDOW = positive(config.circuit_breaker_window_seconds, 180) * 1000;
const CIRCUIT_MAX = Math.ceil(positive(config.circuit_breaker_max_switches, 5));

export function resolveOrcaBinary(platform = process.platform, env = process.env, home = homedir(), exists = existsSync) {
  const override = env.ORCA_CLI_COMMAND;
  if (platform === 'win32') {
    const explicit = win32.isAbsolute(override || '') ? override.replace(/\.(cmd|bat)$/i, '.exe') : '';
    const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
    const dirs = (env.Path ?? env.PATH ?? '').split(';').map((dir) => dir.trim().replace(/^"|"$/g, ''));
    return [
      /\.exe$/i.test(explicit) && explicit,
      win32.join(local, 'Programs', 'Orca', 'resources', 'bin', 'orca.exe'),
      ...dirs.filter((dir) => win32.isAbsolute(dir)).map((dir) => win32.join(dir, 'orca.exe')),
    ].find((candidate) => candidate && exists(candidate)) ?? null;
  }
  return [
    override && isAbsolute(override) && override,
    join(home, '.config', 'orca', 'linux-orca-cli-shim', 'orca'),
    '/opt/homebrew/bin/orca',
    '/usr/local/bin/orca',
  ].find((candidate) => candidate && exists(candidate)) ?? (platform === 'linux' ? 'orca-ide' : 'orca');
}

class OrcaFailure extends Error {}

const cleanText = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';

export function parseAccountResult(result) {
  const accounts = result?.accounts;
  const active = result?.activeAccountId;
  if (!Array.isArray(accounts) || (active !== null && typeof active !== 'string') ||
    !accounts.every((item) => typeof item?.id === 'string' && item.id.length > 0 && !item.id.startsWith('-') && item.id !== 'system') ||
    new Set(accounts.map((item) => item.id)).size !== accounts.length ||
    (active !== null && !accounts.some((item) => item.id === active))) {
    throw new OrcaFailure('Orca 返回的账号数据格式不正确。');
  }
  return {
    accounts: accounts.map(({ id, email, usage }) => ({ id, email: cleanText(email) || null, usage })),
    activeAccountId: active,
    currentEmail: result.currentAccount?.identityKnown === true
      ? normalizedEmail(result.currentAccount.email) || null : null,
    chatUsesAgy: result.chatUsesAgy === true && result.chatKeyOnAgy !== true,
  };
}

export function orcaCommandEnv(platform = process.platform, inherited = process.env, home = homedir()) {
  const env = { ...inherited };
  // Orca's Windows worker allowlist omits APPDATA, but its CLI needs it to find the local runtime.
  if (platform === 'win32' && !env.APPDATA) env.APPDATA = win32.join(home, 'AppData', 'Roaming');
  delete env.ORCA_ENVIRONMENT;
  delete env.ORCA_PAIRING_CODE;
  return env;
}

async function runOrca(args) {
  const bin = resolveOrcaBinary();
  if (!bin) throw new OrcaFailure('找不到 Orca 的原生命令行程序（orca.exe）。');
  const env = orcaCommandEnv();
  // Account commands resolve their runtime from cwd; never inherit a focused WSL workspace.
  const cwd = isAbsolute(bin) ? dirname(bin) : homedir();
  let stdout;
  try {
    ({ stdout } = await exec(bin, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 12_000, maxBuffer: 2 * 1024 * 1024 }));
  } catch (error) {
    throw new OrcaFailure(error.killed ? 'Orca 命令超时。' : 'Orca 账号命令执行失败，请确认 Orca 正在运行且支持账号管理。');
  }
  let reply;
  try { reply = JSON.parse(stdout); } catch { throw new OrcaFailure('无法解析 Orca 的返回结果。'); }
  if (reply?.ok !== true) throw new OrcaFailure('Orca 拒绝执行账号操作。');
  return reply.result;
}

function createTelemetry(now) {
  const dir = join(homedir(), '.config', 'orca', 'antigravity-chat', 'antigravity-acp', 'brain');
  let cached;
  let pending;
  async function scan() {
    const time = now();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { return { status: error.code === 'ENOENT' ? 'empty' : 'error' }; }
    let input = 0, output = 0, cache = 0, records = 0, partial = false;
    const nonnegative = (n) => Number.isFinite(n) && n > 0 ? n : 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      const stream = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.includes('input_tokens')) continue;
          try {
            const row = JSON.parse(line);
            const at = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN;
            if (!Number.isFinite(at) || at < time - DAY || at > time) continue;
            const i = nonnegative(row.input_tokens);
            const o = nonnegative(row.output_tokens);
            const c = nonnegative(row.cache_read_tokens);
            if (i + o + c === 0) continue;
            input += i; output += o; cache += c; records++;
          } catch { /* Ignore incomplete transcript lines. */ }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') partial = true;
      } finally {
        lines.close();
        stream.destroy();
      }
    }
    if (!records) return { status: partial ? 'error' : 'empty' };
    const prices = config.pricing ?? {};
    const cost = (input * (prices.input_per_million ?? 1.25) +
      output * (prices.output_per_million ?? 5) + cache * (prices.cache_read_per_million ?? 0.30)) / 1_000_000;
    return { status: 'ok', input, output, cache, records, total: input + output + cache, partial, cost };
  }
  return async () => {
    if (cached && now() - cached.at < POLL_SECONDS * 1000) return cached.value;
    if (!pending) pending = scan().then((value) => {
      cached = { value, at: now() };
      return value;
    }).finally(() => { pending = null; });
    return pending;
  };
}

const refusal = (reason) => ({ success: false, reason });
const explain = (err, fallback) => err instanceof OrcaFailure ? err.message : fallback;

function withOrcaIdentity(cockpit, orca) {
  const unique = new Map();
  for (const { id, email } of orca?.accounts ?? []) {
    const key = normalizedEmail(email);
    if (key) unique.set(key, unique.has(key) ? null : id);
  }
  const counts = new Map();
  for (const { email } of cockpit.accounts) if (email) counts.set(email, (counts.get(email) ?? 0) + 1);
  const accounts = cockpit.accounts.map((account) => {
    const unambiguous = counts.get(account.email) === 1;
    const orcaId = unambiguous ? unique.get(account.email) ?? null : null;
    // Only use the actual login, never Cockpit's selected row or a saved-but-inactive Orca account.
    const active = unambiguous && account.email === orca?.currentEmail;
    return { ...account, active, orcaId, switchable: Boolean(orcaId) };
  });
  const activeAccountId = accounts.find(({ active }) => active)?.id ?? null;
  return {
    accounts,
    activeAccountId,
    chatUsesAgy: orca?.chatUsesAgy === true,
    identityUnavailable: !activeAccountId,
  };
}

export function createWorker(orca, { run = runOrca, now = Date.now, schedule = setInterval, cancel = clearInterval,
  readCockpit = createCockpitSource({ now }) } = {}) {
  let prefs = { auto: false, masked: false, source: 'orca' };
  let raw = null;
  let syncedAt = null;
  let error = null;
  let switching = false;
  let operation = null;
  let saving = false;
  let paused = false;
  let disposed = false;
  let revision = 0;
  let history = [];
  let trippedUntil = 0;
  let statusQueue = Promise.resolve();
  const telemetry = createTelemetry(now);

  const ready = Promise.resolve().then(() => orca.storage.get(PREF_KEY)).then((saved) => {
    // A previously enabled Claude/GPT policy must not silently enable Gemini rotation.
    prefs = {
      auto: saved?.auto === true && (saved.pool === undefined || saved.pool === 'gemini'),
      masked: saved?.masked === true,
      source: saved?.source === 'cockpit' ? 'cockpit' : 'orca',
    };
  }).catch(() => orca.log('无法读取面板偏好，已使用安全默认值。'));

  function limitation(at) {
    if (trippedUntil > at) return `切换过于频繁，已暂停（还需 ${Math.ceil((trippedUntil - at) / 1000)} 秒）。`;
    const last = history.at(-1);
    return last !== undefined && at - last < COOLDOWN
      ? `切换冷却中（还需 ${Math.ceil((COOLDOWN - at + last) / 1000)} 秒）。` : null;
  }

  function snapshot() {
    const at = now();
    const { accounts, current, best, alternative } = raw
      ? rankAccounts(raw, at)
      : { accounts: [], current: null, best: null, alternative: null };
    const limit = limitation(at);
    let policy;
    if (!prefs.auto) policy = '自动轮换未开启';
    else if (paused) policy = '上次切换未确认；关闭后重新开启可恢复自动轮换';
    else if (error || !raw) policy = '等待成功读取账号';
    else if (!raw.chatUsesAgy) policy = '未确认本机聊天使用这组账号，自动轮换暂停';
    else if (!current?.valid) policy = '等待当前账号的有效额度';
    else if (limit) policy = limit;
    else if (!current.low) policy = `监控中：任一窗口剩余不超过 ${LOW_QUOTA}% 时才考虑切换`;
    else if (!alternative) policy = '当前额度低，暂无可切换且额度充足的备用账号';
    else policy = '当前额度低，等待下一次自动检查';
    const recommendedId = !error && !limit && !raw?.identityUnavailable && best && !best.active ? best.id : null;
    const recommendation = error ? '账号读取失败，无法推荐。'
      : !raw ? '正在读取账号。'
      : !accounts.length ? '所选来源尚未保存账号。'
      : raw.identityUnavailable ? '无法确认本机 agy 登录身份，暂停切换。'
      : limit ?? (!best ? '暂无可切换且额度充足的账号。'
        : best.active ? '当前账号评分最高，无需立即切换。' : null);
    return {
      revision, syncedAt, error, switching, auto: prefs.auto, masked: prefs.masked,
      source: prefs.source, identityUnavailable: raw?.identityUnavailable === true,
      intervalSeconds: POLL_SECONDS, lowQuota: LOW_QUOTA, policy, model: null, recommendedId, recommendation,
      nextId: !error && !raw?.identityUnavailable && current ? alternative?.id ?? null : null,
      accounts: accounts.map(({ id, email, index, active, updatedAt, fiveHour, weekly, valid, low, score, switchable }) => ({
        id, label: prefs.masked ? `账号 ${index + 1}` : email || `账号 ${index + 1}（邮箱未提供）`,
        active, updatedAt, fiveHour, weekly, valid, low, score, switchable,
      })),
    };
  }

  function publish() {
    if (disposed) return;
    revision++;
    const state = snapshot();
    orca.panels.post('accounts.changed', state);
    statusQueue = statusQueue.then(async () => {
      if (disposed || state.revision !== revision) return;
      const current = state.accounts.find((account) => account.active);
      const label = state.error ? '读取失败' : state.syncedAt === null ? '读取中' : current?.label ?? '无当前账号';
      const quota = !state.error && current?.fiveHour?.valid ? ` · 5 小时余 ${current.fiveHour.remaining}%` : '';
      const text = `Antigravity：${label.slice(0, 32)}${quota}`.slice(0, 64);
      const tooltip = `Antigravity：${label.slice(0, 80)}${quota} · ${state.policy}`.slice(0, 256);
      await orca.host.call('statusBar.update', {
        id: 'agy-status',
        text,
        tooltip,
        tone: state.error || current?.low ? 'warning' : 'neutral',
      });
    }).catch(() => orca.log('无法更新 Antigravity 状态栏。'));
  }

  function accept(result) {
    raw = result;
    syncedAt = now();
    error = null;
  }

  async function readOrcaIdentity() {
    try { return parseAccountResult(await run(LIST)); }
    catch { return null; }
  }

  async function readAccounts(refreshQuota = false) {
    try {
      let result;
      if (prefs.source === 'cockpit') {
        const orcaIdentity = await readOrcaIdentity();
        if (disposed) return false;
        const cockpit = await readCockpit({ activeEmail: orcaIdentity?.currentEmail, refresh: refreshQuota });
        result = withOrcaIdentity(cockpit, orcaIdentity);
      } else {
        result = parseAccountResult(await run(LIST));
      }
      if (!disposed) accept(result);
      return !disposed;
    } catch (err) {
      if (disposed) return false;
      const message = err instanceof CockpitError ? err.message
        : prefs.source === 'cockpit' ? '无法读取 Cockpit 账号。' : explain(err, '无法读取 Orca 账号。');
      if (error !== message) orca.log(message);
      error = message;
      return false;
    }
  }

  function exclusive(fn) {
    const task = Promise.resolve().then(fn).finally(() => {
      operation = null;
      publish();
    });
    operation = task;
    return task;
  }

  async function select(targetId, automatically) {
    const cockpitMode = prefs.source === 'cockpit';
    const target = raw.accounts.find(({ id }) => id === targetId);
    if (!target) return refusal('找不到所选账号。');
    if (cockpitMode && (raw.identityUnavailable || !target.orcaId)) {
      return refusal('无法确认本机登录或目标账号的 Orca 切换路径。');
    }
    const orcaId = cockpitMode ? target.orcaId : targetId;
    switching = true;
    publish();
    try {
      if (cockpitMode) {
        // A Cockpit refresh can take seconds; check for external account changes before writing.
        const identity = await readOrcaIdentity();
        if (disposed) return refusal('插件已停止。');
        const checked = withOrcaIdentity(raw, identity);
        if (checked.activeAccountId !== raw.activeAccountId || checked.identityUnavailable ||
          checked.accounts.find(({ id }) => id === targetId)?.orcaId !== orcaId ||
          (automatically && !checked.chatUsesAgy)) {
          raw = checked;
          return refusal('本机账号或聊天路由已变化，请刷新后重试。');
        }
        if (automatically) {
          const { current, alternative } = rankAccounts(checked, now());
          if (!current?.low || alternative?.id !== targetId) return refusal('额度状态已变化，已取消自动切换。');
        }
      }
      const selection = await run(['account', 'select', '--agent', 'antigravity', '--account', orcaId, '--json']);
      if (disposed) return refusal('插件已停止。');
      const verified = parseAccountResult(selection);
      const result = cockpitMode ? withOrcaIdentity(raw, verified) : verified;
      if (verified.activeAccountId !== orcaId || result.activeAccountId !== targetId) {
        throw new OrcaFailure('Orca 未确认目标账号已激活。');
      }
      accept(result);
      const at = now();
      history = history.filter((time) => at - time < Math.max(CIRCUIT_WINDOW, COOLDOWN));
      history.push(at);
      if (history.filter((time) => at - time < CIRCUIT_WINDOW).length >= CIRCUIT_MAX) trippedUntil = at + CIRCUIT_WINDOW;
      if (automatically && config.notifications_enabled !== false) {
        void Promise.resolve().then(() => orca.host.call('notifications.show', {
          title: '已自动切换 Antigravity 账号',
          body: 'Orca 已确认新的当前账号。插件不会重新发送当前回合。',
        })).catch(() => orca.log('无法发送账号切换通知。'));
      }
      return { success: true };
    } catch (err) {
      paused = true;
      const checked = cockpitMode && !disposed ? await readOrcaIdentity() : null;
      if (cockpitMode && !disposed) raw = withOrcaIdentity(raw, checked);
      const readable = !disposed && (cockpitMode ? !raw.identityUnavailable : await readAccounts());
      const status = readable && raw.activeAccountId === targetId
        ? '重新读取时目标已是当前账号，但切换命令的结果无法确认。'
        : readable ? '重新读取时目标不是当前账号。' : '无法确认当前账号。';
      const message = `${explain(err, '切换命令未确认成功。')}${status}`;
      if (!disposed) orca.log(message);
      return refusal(message);
    } finally {
      switching = false;
    }
  }

  function refresh(checkAuto) {
    if (operation) return operation.then(snapshot);
    if (saving || disposed) return Promise.resolve(snapshot());
    return exclusive(async () => {
      await ready;
      if (disposed || !(await readAccounts(true)) || !checkAuto || !prefs.auto ||
        paused || saving || !raw.chatUsesAgy || raw.identityUnavailable || limitation(now())) return;
      const { current, alternative } = rankAccounts(raw, now());
      if (current?.low && alternative) await select(alternative.id, true);
    }).then(snapshot);
  }

  function manualSelect(mode, targetId) {
    if (operation || saving) return refusal('正在读取或切换，请稍后再试。');
    return exclusive(async () => {
      await ready;
      if (disposed || !(await readAccounts())) return refusal(error ?? '插件已停止。');
      if (saving) return refusal('正在更新偏好，请稍后再试。');
      const limit = limitation(now());
      if (limit) return refusal(limit);
      if (raw.identityUnavailable) return refusal('无法确认本机 agy 登录身份，暂停切换。');
      if (mode === 'recommended') {
        if (!raw.accounts.length) return refusal(prefs.source === 'cockpit' ? '尚未在 Cockpit 中保存账号。' : '尚未在 Orca 中保存账号。');
        const { best } = rankAccounts(raw, now());
        if (!best) return refusal('没有额度数据有效且充足的账号。');
        if (best.active) return refusal('当前账号已经是最合适的账号。');
        targetId = best.id;
      }
      if (!raw.accounts.some((account) => account.id === targetId)) return refusal('找不到所选账号。');
      if (raw.activeAccountId === targetId) return refusal('所选账号已是当前账号。');
      return select(targetId, false);
    });
  }

  async function setPreferences(input) {
    await ready;
    if (saving || switching || disposed) return refusal('当前无法更新偏好。');
    const next = { ...prefs };
    if (typeof input?.masked === 'boolean') next.masked = input.masked;
    if (typeof input?.auto === 'boolean') next.auto = input.auto;
    const changeSource = (input?.source === 'orca' || input?.source === 'cockpit') && input.source !== prefs.source;
    if (changeSource) {
      if (operation) return refusal('正在同步账号，请稍后更换来源。');
      next.source = input.source;
      next.auto = false;
    }
    saving = true;
    try {
      await orca.storage.set(PREF_KEY, next);
      if (!next.auto || !prefs.auto) paused = false;
      prefs = next;
      if (changeSource) {
        raw = null;
        syncedAt = null;
        error = null;
      }
      publish();
    } catch {
      return refusal('无法保存面板偏好。');
    } finally { saving = false; }
    if (changeSource && !disposed) await refresh(false);
    return { success: true };
  }

  const subscriptions = [
    orca.commands.register('rotate-now', () => manualSelect('recommended')),
    // This contribution wakes the worker; it does not start another polling path.
    orca.events.on('workspace.changed', () => {}),
    orca.panels.handle('accounts.read', async () => { await ready; return snapshot(); }),
    orca.panels.handle('accounts.refresh', () => refresh(false)),
    orca.panels.handle('accounts.rotateNow', () => manualSelect('recommended')),
    orca.panels.handle('accounts.selectTarget', (input) => manualSelect('explicit', input?.id)),
    orca.panels.handle('preferences.set', setPreferences),
    orca.panels.handle('telemetry.read', telemetry),
  ];

  void refresh(false);
  const timer = schedule(() => refresh(true), POLL_SECONDS * 1000);
  return {
    dispose() {
      disposed = true;
      cancel(timer);
      for (const subscription of subscriptions) subscription?.dispose();
    },
  };
}

export default function activate(orca) {
  return createWorker(orca);
}
