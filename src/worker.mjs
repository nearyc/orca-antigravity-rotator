import { execFile } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { isPool, rankAccounts } from './quota-policy.mjs';

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
    chatUsesAgy: result.chatUsesAgy === true && result.chatKeyOnAgy !== true,
  };
}

async function runOrca(args) {
  const bin = resolveOrcaBinary();
  if (!bin) throw new OrcaFailure('找不到 Orca 的原生命令行程序（orca.exe）。');
  const env = { ...process.env };
  delete env.ORCA_ENVIRONMENT;
  delete env.ORCA_PAIRING_CODE;
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

export function createWorker(orca, { run = runOrca, now = Date.now, schedule = setInterval, cancel = clearInterval } = {}) {
  let prefs = { pool: null, auto: false, masked: true };
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
    prefs = { pool: isPool(saved?.pool) ? saved.pool : null, auto: saved?.auto === true, masked: saved?.masked !== false };
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
      ? rankAccounts(raw, prefs.pool, at)
      : { accounts: [], current: null, best: null, alternative: null };
    const limit = limitation(at);
    let policy;
    if (!prefs.auto) policy = '自动轮换未开启';
    else if (!prefs.pool) policy = '请选择监控额度池';
    else if (paused) policy = '上次切换未确认；关闭后重新开启可恢复自动轮换';
    else if (error || !raw) policy = '等待成功读取账号';
    else if (!raw.chatUsesAgy) policy = '未确认本机聊天使用这组账号，自动轮换暂停';
    else if (!current?.valid) policy = '等待当前账号的有效额度';
    else if (limit) policy = limit;
    else if (!current.low) policy = '监控中：任一窗口剩余不超过 5% 时才考虑切换';
    else if (!alternative) policy = '当前额度低，暂无额度充足的备用账号';
    else policy = '当前额度低，等待下一次自动检查';
    const recommendedId = !error && !limit && best && !best.active ? best.id : null;
    const recommendation = error ? '账号读取失败，无法推荐。'
      : !raw ? '正在读取账号。'
      : !accounts.length ? '尚未保存账号。'
      : !prefs.pool ? '请选择监控额度池以查看剩余额度和推荐账号。'
      : limit ?? (!best ? '暂无额度数据有效且充足的账号。'
        : best.active ? '当前账号已是推荐账号。' : null);
    return {
      revision, syncedAt, error, switching, pool: prefs.pool, auto: prefs.auto, masked: prefs.masked,
      intervalSeconds: POLL_SECONDS, policy, model: null, recommendedId, recommendation,
      accounts: accounts.map(({ id, email, index, active, updatedAt, fiveHour, weekly, valid, low, score }) => ({
        id, label: (prefs.masked ? null : email) || `账号 ${index + 1}`,
        active, updatedAt, fiveHour, weekly, valid, low, score,
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
    raw = parseAccountResult(result);
    syncedAt = now();
    error = null;
  }

  async function readAccounts() {
    try {
      const result = await run(LIST);
      if (!disposed) accept(result);
      return !disposed;
    } catch (err) {
      if (disposed) return false;
      const message = explain(err, '无法读取 Orca 账号。');
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
    switching = true;
    publish();
    try {
      const selection = await run(['account', 'select', '--agent', 'antigravity', '--account', targetId, '--json']);
      if (disposed) return refusal('插件已停止。');
      const verified = parseAccountResult(selection);
      if (verified.activeAccountId !== targetId) throw new OrcaFailure('Orca 未确认目标账号已激活。');
      accept(verified);
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
      const readable = !disposed && await readAccounts();
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
    return exclusive(async () => {
      await ready;
      if (disposed || !(await readAccounts()) || !checkAuto || !prefs.auto || !prefs.pool ||
        paused || saving || !raw.chatUsesAgy || limitation(now())) return;
      const { current, alternative } = rankAccounts(raw, prefs.pool, now());
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
      if (mode === 'recommended') {
        if (!raw.accounts.length) return refusal('尚未在 Orca 中保存账号。');
        if (!prefs.pool) return refusal('请先选择监控额度池。');
        const { best } = rankAccounts(raw, prefs.pool, now());
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
    if (input?.pool === null || isPool(input?.pool)) {
      if (prefs.pool !== input.pool) next.auto = false;
      next.pool = input.pool;
    }
    if (typeof input?.masked === 'boolean') next.masked = input.masked;
    if (typeof input?.auto === 'boolean') {
      if (input.auto && !next.pool) return refusal('请先选择监控额度池。');
      next.auto = input.auto;
    }
    saving = true;
    try {
      await orca.storage.set(PREF_KEY, next);
      if (!next.auto || !prefs.auto) paused = false;
      prefs = next;
      publish();
      return { success: true };
    } catch {
      return refusal('无法保存面板偏好。');
    } finally { saving = false; }
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
