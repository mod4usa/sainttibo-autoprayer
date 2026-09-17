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
  return { prayers: Number(values.prayers), timeoutSeconds };
}

export async function launchBrowser() {
  return chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }),
  });
}

export async function runPrayers(page, prayers, timeoutSeconds = 0, onProgress = () => {}) {
  await page.waitForFunction(selector => {
    const button = document.querySelector(selector);
    return button && !button.disabled;
  }, BUTTON);

  // The site sends one same-origin server-function POST per prayer.
  // Count completed requests, since other visitors also move the public counter.
  const requests = new Set();
  const errors = [];
  let completed = 0;
  let dispatched = 0;
  let batchTarget = 0;
  let finish = () => {};
  let timedOut = false;
  const progress = () => onProgress({ prayersRequested: prayers, dispatched, completed, errors: errors.length });
  const onRequest = request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.origin === new URL(page.url()).origin &&
        url.pathname.startsWith('/_serverFn/')) requests.add(request);
  };
  const onFinished = async request => {
    if (!requests.delete(request)) return;
    try {
      const response = await request.response();
      if (!response?.ok()) errors.push(`Prayer request returned HTTP ${response?.status() ?? 'unknown'}.`);
    } catch (error) {
      errors.push(error.message);
    }
    completed++;
    if (completed === batchTarget) finish();
  };
  const onFailed = request => {
    if (!requests.delete(request)) return;
    errors.push(request.failure()?.errorText ?? 'Prayer request failed.');
    completed++;
    if (completed === batchTarget) finish();
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  let timeout;
  let progressInterval;
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

    progress();
    progressInterval = setInterval(progress, 5000);
    if (prayers > 0) {
      if (timeoutSeconds > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          errors.push(`Timed out after ${timeoutSeconds} seconds: ${completed}/${prayers} prayer requests completed.`);
          finish();
        }, timeoutSeconds * 1000);
      }
      while (dispatched < prayers && !timedOut && errors.length === 0) {
        // Bound the browser queue and yield between batches so the page can
        // process responses. Never retry a prayer whose server outcome is unknown.
        const batchSize = Math.min(16, prayers - dispatched);
        batchTarget = dispatched + batchSize;
        const done = new Promise(resolve => { finish = resolve; });
        Object.assign(timing, await page.evaluate(({ buttonSelector, batchSize, start }) => {
          const button = document.querySelector(buttonSelector);
          if (!button || button.disabled) throw new Error('Saint Tibo button is unavailable.');
          const picture = button.querySelector('img');
          for (let i = 0; i < batchSize; i++) picture.click();
          return {
            prayersEndTime: new Date().toISOString(),
            prayerElapsedMs: performance.timeOrigin + performance.now() - start,
          };
        }, { buttonSelector: BUTTON, batchSize, start: timing.startMonotonicMs }));
        dispatched += batchSize;
        await done;
      }
      clearTimeout(timeout);
    }
    clearInterval(progressInterval);
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
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options === null) {
    console.log('Usage: node autoprayer.mjs --prayers <non-negative integer> [--timeout-seconds <seconds>]');
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
        `${status.errors} errors`);
    });
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
