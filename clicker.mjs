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
      clicks: { type: 'string' },
      'timeout-seconds': { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return null;
  if (!/^\d+$/.test(values.clicks ?? '') || !Number.isSafeInteger(Number(values.clicks))) {
    throw new Error('--clicks must be a non-negative safe integer.');
  }
  const timeoutSeconds = Number(values['timeout-seconds']);
  // Node timers overflow above 2^31 - 1 milliseconds and fire immediately.
  if (!/^\d+(\.\d+)?$/.test(values['timeout-seconds']) ||
      !Number.isFinite(timeoutSeconds) || timeoutSeconds * 1000 > 2 ** 31 - 1) {
    throw new Error('--timeout-seconds must be between 0 and 2147483.647 (0 waits indefinitely).');
  }
  return { clicks: Number(values.clicks), timeoutSeconds };
}

export async function launchBrowser() {
  return chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }),
  });
}

export async function runClicks(page, clicks, timeoutSeconds = 0) {
  await page.waitForFunction(selector => {
    const button = document.querySelector(selector);
    return button && !button.disabled;
  }, BUTTON);

  // The site sends one same-origin server-function POST per click.
  // Count completed requests, since other visitors also move the public counter.
  const requests = new Set();
  const errors = [];
  let completed = 0;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const onRequest = request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.origin === new URL(page.url()).origin &&
        url.pathname.startsWith('/_serverFn/')) requests.add(request);
  };
  const onFinished = async request => {
    if (!requests.has(request)) return;
    try {
      const response = await request.response();
      if (!response?.ok()) errors.push(`Click request returned HTTP ${response?.status() ?? 'unknown'}.`);
    } catch (error) {
      errors.push(error.message);
    }
    completed++;
    if (completed === clicks) finish();
  };
  const onFailed = request => {
    if (!requests.has(request)) return;
    errors.push(request.failure()?.errorText ?? 'Click request failed.');
    completed++;
    if (completed === clicks) finish();
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  let timeout;
  try {
    const timing = await page.evaluate(({ buttonSelector, counterSelector, clicks }) => {
      const picture = document.querySelector(`${buttonSelector} img`);
      const raw = document.querySelector(counterSelector).textContent.trim();
      if (!/^[\d,]+$/.test(raw)) throw new Error(`Unexpected counter: ${raw}`);
      const beforeCounter = Number(raw.replaceAll(',', ''));
      const startTime = new Date().toISOString();
      const start = performance.now();
      for (let i = 0; i < clicks; i++) picture.click();
      return {
        beforeCounter,
        startTime,
        clicksEndTime: new Date().toISOString(),
        clickElapsedMs: performance.now() - start,
        // timeOrigin + now remains comparable across the final navigation.
        startMonotonicMs: performance.timeOrigin + start,
      };
    }, { buttonSelector: BUTTON, counterSelector: COUNTER, clicks });

    if (clicks > 0) {
      if (timeoutSeconds > 0) {
        timeout = setTimeout(() => {
          errors.push(`Timed out after ${timeoutSeconds} seconds: ${completed}/${clicks} click requests completed.`);
          finish();
        }, timeoutSeconds * 1000);
      }
      await done;
      clearTimeout(timeout);
    }
    // Reload only after requests settle, to read a fresh server-backed counter.
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
      clicksRequested: clicks,
      clickRequestsCompleted: completed,
      beforeCounter: timing.beforeCounter,
      afterCounter: after.afterCounter,
      counterIncrease: after.afterCounter - timing.beforeCounter,
      startTime: timing.startTime,
      clicksEndTime: timing.clicksEndTime,
      endTime: after.endTime,
      clickElapsedMs: timing.clickElapsedMs,
      totalElapsedMs: after.endMonotonicMs - timing.startMonotonicMs,
      errors,
      note: 'The public counter also includes other visitors\' clicks.',
    };
  } finally {
    clearTimeout(timeout);
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options === null) {
    console.log('Usage: node clicker.mjs --clicks <non-negative integer> [--timeout-seconds <seconds>]');
    console.log('--timeout-seconds defaults to 0: wait indefinitely for click requests.');
    return;
  }
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.goto(SITE, { waitUntil: 'domcontentloaded' });
    const result = await runClicks(page, options.clicks, options.timeoutSeconds);
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
