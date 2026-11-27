import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { GEMINI_GROUP, rankAccounts } from './quota-policy.mjs';

const VERSION = 1;
const PLATFORM = 'antigravity';
const MAX_FRAME = 256 * 1024;
const MINUTE = 60_000;
const RETRY_MS = 5 * MINUTE;
const REFRESH_TIMEOUT = 18_000;
const REFRESH_INTERVAL = MINUTE;
const WINDOWS = [['gemini-5h', 300], ['gemini-weekly', 10080]];

export class CockpitError extends Error {}

async function readLocalJson(path) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16 * 1024) throw new Error();
    const bytes = Buffer.alloc(16 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16 * 1024) throw new Error();
    return JSON.parse(bytes.toString('utf8', 0, bytesRead));
  } finally { await file.close(); }
}

export async function discoverCockpit(home = homedir(), env = process.env) {
  try {
    const dev = env.COCKPIT_TOOLS_PROFILE?.trim().toLowerCase() === 'dev';
    const suffix = dev ? '_dev' : '';
    let root = env.COCKPIT_TOOLS_DATA_DIR?.trim();
    if (!root) {
      try { root = await readLocalJson(join(home, `.cockpit_tools${suffix}-data-root.json`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (root == null || root === '') {
      // Cockpit prefers the existing legacy directory when both roots exist.
      const legacy = join(home, `.antigravity_cockpit${suffix}`);
      try {
        if (!(await stat(legacy)).isDirectory()) throw new Error();
        root = legacy;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        root = join(home, `.cockpit_tools${suffix}`);
      }
    }
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error();
    const { ws_port: port, auth_token: token, automation_version: version } = await readLocalJson(join(root, 'server.json'));
    if (version !== VERSION) throw new CockpitError('Cockpit 桌面端的自动化协议不兼容。');
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token || token.length > 1024) throw new Error();
    return { port, token };
  } catch (error) {
    if (error instanceof CockpitError) throw error;
    throw new CockpitError('未找到可用的 Cockpit 本地服务，请确认 Cockpit Tools 桌面版正在运行。');
  }
}

export function requestCockpit({ port, token }, command, timeoutMs, Socket = globalThis.WebSocket) {
  if (command?.platform !== PLATFORM || (command.operation !== 'list' && command.operation !== 'quota')) {
    return Promise.reject(new CockpitError('不支持的 Cockpit 操作。'));
  }
  if (!Socket) return Promise.reject(new CockpitError('当前 Orca 插件运行环境不支持 WebSocket。'));
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const socket = new Socket(`ws://127.0.0.1:${port}`);
    let settled = false;
    function finish(error, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(new CockpitError(error));
      else resolve(data);
    }
    const timer = setTimeout(() => finish('Cockpit 本地请求超时。'), timeoutMs);
    socket.addEventListener('error', () => finish('无法连接 Cockpit 桌面端。'));
    socket.addEventListener('close', () => finish('Cockpit 本地连接已关闭。'));
    socket.addEventListener('open', () => {
      if (settled) return;
      try {
        socket.send(JSON.stringify({ type: 'request.automation', payload: { version: VERSION, requestId, authToken: token, command } }));
      } catch { finish('无法向 Cockpit 发送请求。'); }
    });
    socket.addEventListener('message', ({ data }) => {
      if (settled || typeof data !== 'string') return;
      if (Buffer.byteLength(data) > MAX_FRAME) return finish('Cockpit 本地响应过大。');
      let reply;
      try { reply = JSON.parse(data); } catch { return; }
      if (reply?.type !== 'response.automation' || reply.payload?.requestId !== requestId) return;
      const payload = reply.payload;
      if (payload.version !== VERSION) return finish('Cockpit 桌面端的自动化协议不兼容。');
      if (payload.status !== 'ok') return finish('Cockpit 未能完成额度读取或刷新。');
      finish(null, payload.data);
    });
  });
}

export const normalizedEmail = (email) => typeof email === 'string' && !/[\u0000-\u001f\u007f]/.test(email)
  ? email.trim().toLowerCase() : '';

function parseRoster(value) {
  if (!Array.isArray(value) || value.some((row) => typeof row?.id !== 'string' || !/^[\w.-]{1,160}$/.test(row.id) || ['.', '..'].includes(row.id)) ||
    new Set(value.map(({ id }) => id)).size !== value.length) throw new CockpitError('Cockpit 返回了无效的账号列表。');
  return value.map(({ id, email }) => ({ id, email: normalizedEmail(email) || null }));
}

export function normalizeCockpitQuota(reply, accountId) {
  if (reply?.platform !== PLATFORM || reply.accountId !== accountId || !reply.quota) return null;
  const { status, updatedAt, data } = reply.quota;
  if (!Array.isArray(data?.models)) return null;
  const buckets = WINDOWS.flatMap(([name, windowMinutes]) => {
    const matches = data.models.filter((row) => row?.name === name);
    if (matches.length !== 1) return [];
    const { percentage, reset_time, summary_exhausted } = matches[0];
    const reset = reset_time === '' || reset_time == null ? null : typeof reset_time === 'string' ? Date.parse(reset_time) : NaN;
    return Number.isInteger(percentage) && percentage >= 0 && percentage <= 100 && !Number.isNaN(reset)
      ? [{ group: GEMINI_GROUP, windowMinutes, usedPercent: summary_exhausted === true ? 100 : 100 - percentage, resetsAt: reset }]
      : [];
  });
  const validTime = Number.isSafeInteger(updatedAt) && updatedAt > 0 && updatedAt < 10_000_000_000;
  return {
    status: status === 'available' && data.summaryStale !== true && data.forbidden !== true && validTime && buckets.length === 2 ? 'ok' : 'error',
    updatedAt: validTime ? updatedAt * 1000 : null,
    buckets,
  };
}

export function createCockpitSource({ discover = discoverCockpit, request = requestCockpit, now = Date.now } = {}) {
  const lastAttempts = new Map();
  const failedRefreshes = new Map();
  const cache = new Map();
  let refreshBlockedUntil = 0;
  return async function read({ activeEmail, refresh }) {
    const server = await discover();
    const call = (command, ms) => request(server, { platform: PLATFORM, ...command }, ms);
    const accounts = parseRoster(await call({ operation: 'list' }, 4000));
    const ids = new Set(accounts.map(({ id }) => id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    for (const id of lastAttempts.keys()) if (!ids.has(id)) lastAttempts.delete(id);
    for (const id of failedRefreshes.keys()) if (!ids.has(id)) failedRefreshes.delete(id);
    const accountMatches = accounts.filter(({ email }) => email && email === activeEmail);
    const activeAccountId = accountMatches.length === 1 ? accountMatches[0].id : null;
    const quota = async (id, refresh, ms) => normalizeCockpitQuota(await call({ operation: 'quota', accountId: id, refresh }, ms), id);
    // Bound the duration of the whole snapshot even with a large roster or an unresponsive host.
    const deadline = now() + 6000;
    for (const account of accounts) {
      let usage;
      const remaining = deadline - now();
      if (remaining > 0) {
        try { usage = await quota(account.id, false, Math.min(remaining, 2000)); } catch { /* One account must not hide the roster. */ }
      }
      const previous = cache.get(account.id);
      const cached = previous?.email === account.email ? previous.usage : null;
      const failedAt = failedRefreshes.get(account.id);
      if (usage?.status === 'ok' && failedAt !== undefined && usage.updatedAt > failedAt) {
        failedRefreshes.delete(account.id);
      }
      if (usage?.status === 'ok' && failedRefreshes.has(account.id)) usage = { ...usage, status: 'error' };
      if (cached && (!usage?.buckets.length || (usage.updatedAt ?? 0) < (cached.updatedAt ?? 0))) {
        account.usage = { ...cached, status: 'error' };
      } else {
        account.usage = usage?.buckets.length ? usage : null;
      }
    }
    // Refresh at most one account per pass. An individual failure backs off without starving other accounts.
    if (refresh && now() >= refreshBlockedUntil) {
      const at = now();
      const { accounts: ranked } = rankAccounts({ accounts, activeAccountId }, at);
      const due = ranked.filter((row) => (!row.valid || at - row.updatedAt >= (row.active ? 5 : 240) * MINUTE) &&
        (!lastAttempts.has(row.id) || at - lastAttempts.get(row.id) >= RETRY_MS));
      due.sort((a, b) => Number(b.active) - Number(a.active) || (lastAttempts.get(a.id) ?? 0) - (lastAttempts.get(b.id) ?? 0));
      if (due.length) {
        const account = accounts.find(({ id }) => id === due[0].id);
        lastAttempts.set(account.id, at);
        refreshBlockedUntil = at + REFRESH_INTERVAL;
        try {
          const updated = await quota(account.id, true, REFRESH_TIMEOUT);
          // Cockpit timestamps have second precision. A refresh must not make an old snapshot eligible again.
          const startedSecond = Math.floor(at / 1000) * 1000;
          if (updated?.status !== 'ok' || updated.updatedAt < startedSecond ||
            updated.updatedAt < (account.usage?.updatedAt ?? 0)) throw new Error();
          failedRefreshes.delete(account.id);
          account.usage = updated;
        } catch {
          failedRefreshes.set(account.id, at);
          // Cockpit may still be completing a request after our socket timed out.
          refreshBlockedUntil = at + 2 * MINUTE;
          if (account.usage) account.usage = { ...account.usage, status: 'error' };
        }
      }
    }
    for (const { id, email, usage } of accounts) if (usage) cache.set(id, { email, usage });
    return { accounts, activeAccountId };
  };
}
