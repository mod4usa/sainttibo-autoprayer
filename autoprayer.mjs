import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const SITE = 'https://codexreset.org/';
const BUTTON = '[data-testid="saint-tibo-button"]';
const COUNTER = '[data-testid="tibo-total-pleas"]';

export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      prayers: { type: 'string' },
      concurrency: { type: 'string', default: '16' },
      'max-concurrency': { type: 'string', default: '64' },
      'timeout-seconds': { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return null;
  if (!/^\d+$/.test(values.prayers ?? '') || !Number.isSafeInteger(Number(values.prayers))) {
    throw new Error('--prayers must be a non-negative safe integer.');
  }
  const timeoutSeconds = Number(values['timeout-seconds']);
  // Node timers overflow above 2^31 - 1 milliseconds and fire immediately.
  if (!/^\d+(\.\d+)?$/.test(values['timeout-seconds']) ||
      !Number.isFinite(timeoutSeconds) || timeoutSeconds * 1000 > 2 ** 31 - 1) {
    throw new Error('--timeout-seconds must be between 0 and 2147483.647 (0 waits indefinitely).');
  }
  for (const name of ['concurrency', 'max-concurrency']) {
    if (!/^\d+$/.test(values[name]) || !Number.isSafeInteger(Number(values[name])) || Number(values[name]) < 1) {
      throw new Error(`--${name} must be a positive safe integer.`);
    }
  }
  const concurrency = Number(values.concurrency);
  const maxConcurrency = Number(values['max-concurrency']);
  if (concurrency > maxConcurrency) throw new Error('--concurrency cannot exceed --max-concurrency.');
  return { prayers: Number(values.prayers), timeoutSeconds, concurrency, maxConcurrency };
}

// Called once per two-second observation window. Increase gradually; halve
// the target on latency growth, including requests that have not finished yet.
export function nextConcurrency(current, maximum,
  { samples, averageMs, baselineMs, oldestPendingMs, cooldownWindows = 0 }) {
  const baseline = baselineMs ?? averageMs ?? 1000;
  let concurrency = current;
  let reason = samples ? 'learning baseline' : 'waiting for responses';
  if (cooldownWindows > 0) {
    reason = 'cooldown';
  } else if (oldestPendingMs > Math.max(1000, baseline * 3)) {
    concurrency = Math.max(1, Math.floor(current / 2));
    reason = 'stalled request';
  } else if (samples > 0 && averageMs > Math.max(250, baseline * 2)) {
    concurrency = Math.max(1, Math.floor(current / 2));
    reason = 'latency increase';
  } else if (samples >= current && averageMs <= Math.max(100, baseline * 1.25)) {
    concurrency = Math.min(maximum, current + 1);
    reason = concurrency > current ? 'healthy responses' : 'at maximum';
  }
  return {
    concurrency,
    // Learn changed conditions in both directions, including while at the floor.
    // A historical minimum would prevent recovery after a lasting latency shift.
    baselineMs: samples ? (baselineMs == null ? averageMs : baselineMs * 0.8 + averageMs * 0.2) : baselineMs,
    cooldownWindows: concurrency < current ? 2 : Math.max(0, cooldownWindows - 1),
    averageMs,
    oldestPendingMs,
    reason,
  };
}

export function retryAfterDelay(value = '', now = Date.now()) {
  const delay = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export async function launchBrowser() {
  return chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }),
  });
}

export async function runPrayers(page, prayers, timeoutSeconds = 0, onProgress = () => {},
  { concurrency = 16, maxConcurrency = 64 } = {}) {
  await page.waitForFunction(selector => {
    const button = document.querySelector(selector);
    return button && !button.disabled;
  }, BUTTON);

  // The site sends one same-origin server-function POST per prayer.
  // Count completed requests, since other visitors also move the public counter.
  const requests = new Map();
  const errors = [];
  let completed = 0;
  let failed = 0;
  let dispatched = 0;
  let wake = () => {};
  let timedOut = false;
  let recovering = false;
  let recoveryCount = 0;
  let pauseUntil = 0;
  let recoveryDelayMs = 0;
  let nextPauseMs = 2000;
  const initialConcurrency = concurrency;
  let peakConcurrency = concurrency;
  let samples = 0;
  let latencySum = 0;
  let scaling = { baselineMs: null, averageMs: null, cooldownWindows: 0, reason: 'initial' };
  let runStarted;
  let rateStarted;
  let rateCompleted = 0;
  let recentRate = null;
  const runStatus = () => timedOut ? 'timed_out'
    : completed === prayers ? (failed ? 'completed_with_failures' : 'completed')
      : recovering ? 'recovering' : 'running';
  const progress = () => {
    const now = performance.now();
    const averageRate = completed * 1000 / Math.max(1, now - runStarted);
    // Nearby timer/scaling messages share a rate sample instead of reporting
    // misleading zeroes or spikes over a few milliseconds.
    if (now - rateStarted >= 1000) {
      recentRate = (completed - rateCompleted) * 1000 / (now - rateStarted);
      rateStarted = now;
      rateCompleted = completed;
    }
    onProgress({
      prayersRequested: prayers, dispatched, completed, errors: errors.length,
      succeeded: completed - failed, failed, status: runStatus(),
      pauseRemainingSeconds: recovering ? Math.max(0, (pauseUntil - now) / 1000) : 0,
      concurrency, maxConcurrency,
      requestsPerSecond: recentRate ?? averageRate,
      averageRequestsPerSecond: averageRate,
      latencyMs: scaling.averageMs,
      scalingReason: scaling.reason,
    });
  };
  const recordFailure = (message, serverDelayMs = 0) => {
    errors.push(message);
    failed++;
    scaling.reason = 'request failure';
    if (dispatched >= prayers) return;
    const firstInBurst = !recovering;
    if (firstInBurst) {
      recovering = true;
      recoveryCount++;
      concurrency = Math.max(1, Math.floor(concurrency / 2));
      recoveryDelayMs = nextPauseMs;
      nextPauseMs = Math.min(30_000, nextPauseMs * 2);
      samples = 0;
      latencySum = 0;
    }
    // Failures from the same outstanding pool extend one pause, without
    // repeatedly halving concurrency or increasing the backoff for that burst.
    pauseUntil = Math.max(pauseUntil, performance.now() + Math.max(recoveryDelayMs, serverDelayMs));
    if (firstInBurst) progress();
  };
  const onRequest = request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.origin === new URL(page.url()).origin &&
        url.pathname.startsWith('/_serverFn/')) requests.set(request, performance.now());
  };
  const onFinished = request => {
    const started = requests.get(request);
    if (!requests.delete(request)) return;
    let failure;
    let serverDelayMs = 0;
    try {
      const response = request.existingResponse();
      if (!response?.ok()) {
        failure = `Prayer request returned HTTP ${response?.status() ?? 'unknown'}.`;
        serverDelayMs = retryAfterDelay(response?.headers()['retry-after']);
      }
      else {
        samples++;
        latencySum += performance.now() - started;
      }
    } catch (error) {
      failure = error.message;
    }
    completed++;
    if (failure) recordFailure(failure, serverDelayMs);
    wake();
  };
  const onFailed = request => {
    if (!requests.delete(request)) return;
    completed++;
    recordFailure(request.failure()?.errorText ?? 'Prayer request failed.');
    wake();
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  let timeout;
  let progressInterval;
  let scalingInterval;
  let recoveryTimer;
  try {
    const timing = await page.evaluate(counterSelector => {
      const raw = document.querySelector(counterSelector).textContent.trim();
      if (!/^[\d,]+$/.test(raw)) throw new Error(`Unexpected counter: ${raw}`);
      const beforeCounter = Number(raw.replaceAll(',', ''));
      const startTime = new Date().toISOString();
      const start = performance.now();
      return {
        beforeCounter,
        startTime,
        prayersEndTime: startTime,
        prayerElapsedMs: 0,
        // timeOrigin + now remains comparable across the final navigation.
        startMonotonicMs: performance.timeOrigin + start,
      };
    }, COUNTER);

    runStarted = performance.now();
    rateStarted = runStarted;
    progress();
    progressInterval = setInterval(progress, 5000);
    scalingInterval = setInterval(() => {
      if (recovering || dispatched >= prayers) return;
      const now = performance.now();
      let oldestPendingMs = 0;
      for (const started of requests.values()) oldestPendingMs = Math.max(oldestPendingMs, now - started);
      const averageMs = samples ? latencySum / samples : null;
      const previous = concurrency;
      scaling = nextConcurrency(concurrency, maxConcurrency, {
        samples, averageMs, oldestPendingMs,
        baselineMs: scaling.baselineMs, cooldownWindows: scaling.cooldownWindows,
      });
      concurrency = scaling.concurrency;
      if (scaling.reason === 'healthy responses' || scaling.reason === 'at maximum') nextPauseMs = 2000;
      samples = 0;
      latencySum = 0;
      peakConcurrency = Math.max(peakConcurrency, concurrency);
      if (concurrency !== previous) progress();
      wake();
    }, 2000);
    if (prayers > 0) {
      if (timeoutSeconds > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          errors.push(`Timed out after ${timeoutSeconds} seconds: ${completed}/${prayers} prayer requests completed.`);
          wake();
        }, timeoutSeconds * 1000);
      }
      while (!timedOut && (dispatched < prayers || completed < dispatched)) {
        if (recovering && completed === dispatched) {
          const remainingPauseMs = pauseUntil - performance.now();
          if (remainingPauseMs > 0) {
            clearTimeout(recoveryTimer);
            // Long Retry-After delays must not overflow Node's timer limit.
            recoveryTimer = setTimeout(() => wake(), Math.min(remainingPauseMs, 2 ** 31 - 1));
          } else {
            recovering = false;
            clearTimeout(recoveryTimer);
            samples = 0;
            latencySum = 0;
            scaling.cooldownWindows = 2;
            scaling.reason = 'resuming unsent prayers';
            progress();
          }
        }
        const available = Math.min(concurrency - (dispatched - completed), prayers - dispatched);
        if (!recovering && available > 0) {
          // Reserve slots before awaiting browser execution. Responses can arrive
          // during evaluate; each completion frees a slot independently.
          dispatched += available;
          Object.assign(timing, await page.evaluate(({ buttonSelector, count, start }) => {
            const button = document.querySelector(buttonSelector);
            if (!button || button.disabled) throw new Error('Saint Tibo button is unavailable.');
            const picture = button.querySelector('img');
            for (let i = 0; i < count; i++) picture.click();
            return {
              prayersEndTime: new Date().toISOString(),
              prayerElapsedMs: performance.timeOrigin + performance.now() - start,
            };
          }, { buttonSelector: BUTTON, count: available, start: timing.startMonotonicMs }));
        } else {
          // Scaling down drains existing requests; it never cancels or retries them.
          await new Promise(resolve => { wake = resolve; });
        }
      }
      clearTimeout(timeout);
    }
    clearInterval(progressInterval);
    clearInterval(scalingInterval);
    clearTimeout(recoveryTimer);
    progress();
    // Freeze request tracking before reload, which may abort outstanding requests
    // after a timeout. The report must not count those aborts as completed prayers.
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(COUNTER).waitFor();
    const after = await page.evaluate(selector => {
      const raw = document.querySelector(selector).textContent.trim();
      if (!/^[\d,]+$/.test(raw)) throw new Error(`Unexpected counter: ${raw}`);
      return {
        afterCounter: Number(raw.replaceAll(',', '')),
        endTime: new Date().toISOString(),
        endMonotonicMs: performance.timeOrigin + performance.now(),
      };
    }, COUNTER);
    return {
      prayersRequested: prayers,
      prayersDispatched: dispatched,
      prayerRequestsCompleted: completed,
      prayerRequestsSucceeded: completed - failed,
      prayerRequestsFailed: failed,
      recoveryCount,
      status: runStatus(),
      initialConcurrency,
      finalConcurrency: concurrency,
      peakConcurrency,
      maxConcurrency,
      beforeCounter: timing.beforeCounter,
      afterCounter: after.afterCounter,
      counterIncrease: after.afterCounter - timing.beforeCounter,
      startTime: timing.startTime,
      prayersEndTime: timing.prayersEndTime,
      endTime: after.endTime,
      prayerElapsedMs: timing.prayerElapsedMs,
      totalElapsedMs: after.endMonotonicMs - timing.startMonotonicMs,
      errors,
      note: 'The public counter also includes other visitors\' prayers.',
    };
  } finally {
    clearTimeout(timeout);
    clearInterval(progressInterval);
    clearInterval(scalingInterval);
    clearTimeout(recoveryTimer);
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options === null) {
    console.log('Usage: node autoprayer.mjs --prayers <non-negative integer> [--concurrency <integer>] [--max-concurrency <integer>] [--timeout-seconds <seconds>]');
    console.log('Concurrency starts at 16 and automatically scales between 1 and --max-concurrency (default 64).');
    console.log('--timeout-seconds defaults to 0: wait indefinitely for prayer requests.');
    return;
  }
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.goto(SITE, { waitUntil: 'domcontentloaded' });
    const result = await runPrayers(page, options.prayers, options.timeoutSeconds, status => {
      console.error(`Prayers: ${status.dispatched}/${status.prayersRequested} dispatched, ` +
        `${status.completed} settled (${status.succeeded} succeeded, ${status.failed} failed), ${status.dispatched - status.completed} pending, ` +
        `${status.errors} errors, concurrency ${status.concurrency}/${status.maxConcurrency}, ` +
        `${status.requestsPerSecond.toFixed(1)} requests/s recent, ` +
        `${status.averageRequestsPerSecond.toFixed(1)} requests/s average, ` +
        `${status.latencyMs === null ? 'n/a' : status.latencyMs.toFixed(0)} ms latency, ` +
        `${status.status.replaceAll('_', ' ')}` +
        (status.status === 'running' ? `, ${status.scalingReason}` : '') +
        (status.status === 'recovering' ? `, pause ${status.pauseRemainingSeconds.toFixed(1)}s` : ''));
    }, options);
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
