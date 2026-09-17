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
export function nextConcurrency(current, maximum, { samples, averageMs, baselineMs, oldestPendingMs }) {
  const baseline = baselineMs ?? averageMs ?? 1000;
  if ((samples > 0 && averageMs > Math.max(250, baseline * 2)) ||
      oldestPendingMs > Math.max(1000, baseline * 3)) {
    return Math.max(1, Math.floor(current / 2));
  }
  if (samples >= current && averageMs <= Math.max(100, baseline * 1.25)) {
    return Math.min(maximum, current + 1);
  }
  return current;
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
  let dispatched = 0;
  let wake = () => {};
  let timedOut = false;
  const initialConcurrency = concurrency;
  let peakConcurrency = concurrency;
  let samples = 0;
  let latencySum = 0;
  let baselineMs = null;
  let runStarted;
  const progress = () => onProgress({
    prayersRequested: prayers, dispatched, completed, errors: errors.length,
    concurrency, maxConcurrency,
    requestsPerSecond: completed * 1000 / Math.max(1, performance.now() - runStarted),
  });
  const onRequest = request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.origin === new URL(page.url()).origin &&
        url.pathname.startsWith('/_serverFn/')) requests.set(request, performance.now());
  };
  const onFinished = request => {
    const started = requests.get(request);
    if (!requests.delete(request)) return;
    try {
      const response = request.existingResponse();
      if (!response?.ok()) errors.push(`Prayer request returned HTTP ${response?.status() ?? 'unknown'}.`);
      else {
        samples++;
        latencySum += performance.now() - started;
      }
    } catch (error) {
      errors.push(error.message);
    }
    completed++;
    wake();
  };
  const onFailed = request => {
    if (!requests.delete(request)) return;
    errors.push(request.failure()?.errorText ?? 'Prayer request failed.');
    completed++;
    wake();
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  let timeout;
  let progressInterval;
  let scalingInterval;
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
    progress();
    progressInterval = setInterval(progress, 5000);
    scalingInterval = setInterval(() => {
      if (errors.length || dispatched >= prayers) return;
      const now = performance.now();
      let oldestPendingMs = 0;
      for (const started of requests.values()) oldestPendingMs = Math.max(oldestPendingMs, now - started);
      const averageMs = samples ? latencySum / samples : null;
      const previous = concurrency;
      concurrency = nextConcurrency(concurrency, maxConcurrency, { samples, averageMs, baselineMs, oldestPendingMs });
      if (samples) baselineMs = Math.min(baselineMs ?? averageMs, averageMs);
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
        const available = Math.min(concurrency - (dispatched - completed), prayers - dispatched);
        if (errors.length === 0 && available > 0) {
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
          if (errors.length && completed === dispatched) break;
          // Scaling down drains existing requests; it never cancels or retries them.
          await new Promise(resolve => { wake = resolve; });
        }
      }
      clearTimeout(timeout);
    }
    clearInterval(progressInterval);
    clearInterval(scalingInterval);
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
        `${status.completed} requests completed, ${status.dispatched - status.completed} pending, ` +
        `${status.errors} errors, concurrency ${status.concurrency}/${status.maxConcurrency}, ` +
        `${status.requestsPerSecond.toFixed(1)} requests/s`);
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
