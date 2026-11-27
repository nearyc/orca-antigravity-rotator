export const LOW_QUOTA = 5;
export const ACTIVE_MAX_AGE = 10 * 60_000;
export const RESERVE_MAX_AGE = 5 * 60 * 60_000;
const THREE_DAYS = 3 * 24 * 60 * 60_000;

export const GEMINI_GROUP = 'Gemini Models';

function readWindow(buckets, minutes, now, fresh) {
  const matches = buckets.filter((item) => item.windowMinutes === minutes);
  if (matches.length !== 1) return null;
  const { usedPercent, resetsAt } = matches[0];
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  const reset = Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null;
  return { remaining: 100 - usedPercent, resetsAt: reset, valid: fresh && !(reset !== null && reset <= now) };
}

export function scoreQuota(fiveHour, weekly, resetsAt, now) {
  const w = weekly / 100;
  const u = resetsAt > now ? Math.max(0, 1 - (resetsAt - now) / THREE_DAYS) : 0;
  const factor = 1 - 0.6 * (1 - w) * (1 - 0.7 * u) + 0.15 * w * u;
  return (fiveHour / 100) * Math.max(0.35, Math.min(1.15, factor)) * Math.min(1, weekly / 20);
}

export function rankAccounts(result, now) {
  const accounts = result.accounts.map(({ id, email, usage, switchable = true }, index) => {
    const active = id === result.activeAccountId;
    const updatedAt = Number.isFinite(usage?.updatedAt) && usage.updatedAt > 0 ? usage.updatedAt : null;
    const maxAge = active ? ACTIVE_MAX_AGE : RESERVE_MAX_AGE;
    const fresh = updatedAt !== null && updatedAt <= now && now - updatedAt <= maxAge && usage?.status === 'ok';
    const buckets = Array.isArray(usage?.buckets) ? usage.buckets.filter((item) => item?.group === GEMINI_GROUP) : [];
    const fiveHour = readWindow(buckets, 300, now, fresh);
    const weekly = readWindow(buckets, 10080, now, fresh);
    const valid = !!(fiveHour?.valid && weekly?.valid);
    const low = valid && Math.min(fiveHour.remaining, weekly.remaining) <= LOW_QUOTA;
    const score = valid ? scoreQuota(fiveHour.remaining, weekly.remaining, weekly.resetsAt, now) : null;
    return { id, email, index, active, updatedAt, fiveHour, weekly, valid, low, score, switchable };
  });
  const ranked = accounts.filter((account) => account.valid && !account.low && (account.active || account.switchable)).sort((a, b) =>
    b.score - a.score || b.fiveHour.remaining - a.fiveHour.remaining ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    accounts,
    current: accounts.find((account) => account.active) ?? null,
    best: ranked[0] ?? null,
    alternative: ranked.find((account) => !account.active) ?? null,
  };
}
