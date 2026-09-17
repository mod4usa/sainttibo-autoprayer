import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchBrowser, nextConcurrency, parseOptions, retryAfterDelay, runPrayers } from './autoprayer.mjs';

test('requires an explicit non-negative integer prayer count', () => {
  for (const args of [[], ['--prayers', '1.5'], ['--prayers=-1'], ['--prayers', 'NaN'],
    ['--prayers', '9007199254740992'], ['--prayers', '2', '--unknown']]) {
    assert.throws(() => parseOptions(args));
  }
  assert.deepEqual(parseOptions(['--prayers', '0']), { prayers: 0, timeoutSeconds: 0, concurrency: 16, maxConcurrency: 64 });
  assert.deepEqual(parseOptions(['--prayers=200']), { prayers: 200, timeoutSeconds: 0, concurrency: 16, maxConcurrency: 64 });
  assert.equal(parseOptions(['--help']), null);
});

test('accepts an optional timeout and rejects invalid or overflowing values', () => {
  for (const timeoutSeconds of [0, 0.5, 300]) {
    assert.deepEqual(parseOptions(['--prayers', '2', `--timeout-seconds=${timeoutSeconds}`]),
      { prayers: 2, timeoutSeconds, concurrency: 16, maxConcurrency: 64 });
  }
  for (const value of ['-1', '', 'NaN', 'Infinity', 'abc', '2147483.648']) {
    assert.throws(() => parseOptions(['--prayers', '2', `--timeout-seconds=${value}`]),
      /--timeout-seconds/);
  }
});

test('validates the initial concurrency and maximum', () => {
  assert.deepEqual(parseOptions(['--prayers', '100', '--concurrency', '4', '--max-concurrency', '8']),
    { prayers: 100, timeoutSeconds: 0, concurrency: 4, maxConcurrency: 8 });
  for (const option of ['--concurrency', '--max-concurrency']) {
    for (const value of ['0', '-1', '1.5', '', 'NaN', '9007199254740992']) {
      assert.throws(() => parseOptions(['--prayers', '1', `${option}=${value}`]), /concurrency/);
    }
  }
  assert.throws(() => parseOptions(['--prayers', '1', '--concurrency', '9', '--max-concurrency', '8']),
    /cannot exceed/);
});

test('healthy windows scale up gradually, respect the maximum, and require enough samples', () => {
  const healthy = { samples: 16, averageMs: 100, baselineMs: 100, oldestPendingMs: 100 };
  assert.equal(nextConcurrency(16, 64, healthy).concurrency, 17);
  assert.equal(nextConcurrency(16, 16, healthy).concurrency, 16);
  assert.equal(nextConcurrency(16, 64, { ...healthy, samples: 1 }).concurrency, 16);
  assert.equal(nextConcurrency(16, 64, { ...healthy, baselineMs: null }).concurrency, 17);
});

test('latency growth and stalled requests scale down, with a floor of one', () => {
  const slow = { samples: 16, averageMs: 500, baselineMs: 100, oldestPendingMs: 500 };
  assert.equal(nextConcurrency(16, 64, slow).concurrency, 8);
  assert.equal(nextConcurrency(3, 64, slow).concurrency, 1);
  assert.equal(nextConcurrency(1, 64, slow).concurrency, 1);
  assert.equal(nextConcurrency(16, 64, { ...slow, samples: 0, averageMs: null, oldestPendingMs: 4000 }).concurrency, 8);
  assert.equal(nextConcurrency(16, 64, { ...slow, samples: 0, averageMs: null, oldestPendingMs: 0 }).concurrency, 16);
});

test('recovers from concurrency one when successful responses remain slower than the original baseline', () => {
  let state = { concurrency: 1, baselineMs: 50, cooldownWindows: 0 };
  for (let window = 0; window < 10; window++) {
    state = nextConcurrency(state.concurrency, 64, {
      ...state, samples: 9, averageMs: 210, oldestPendingMs: 210,
    });
  }
  assert.ok(state.concurrency > 1, 'Stable 210 ms responses must not be stuck behind a historical 50 ms minimum');
  assert.ok(state.baselineMs > 150);
});

test('a reduction gives pending requests time to drain before another reduction', () => {
  const slow = { samples: 16, averageMs: 500, baselineMs: 100, oldestPendingMs: 4000 };
  let state = nextConcurrency(16, 64, slow);
  assert.equal(state.concurrency, 8);
  for (let window = 0; window < 2; window++) {
    state = nextConcurrency(state.concurrency, 64, { ...state, samples: 0, averageMs: null, oldestPendingMs: 4000 });
    assert.equal(state.concurrency, 8);
  }
  state = nextConcurrency(state.concurrency, 64, { ...state, samples: 0, averageMs: null, oldestPendingMs: 4000 });
  assert.equal(state.concurrency, 4, 'Persistent stalls must still reduce the target after cooldown');
});

test('learns a lasting latency shift without disabling congestion detection', () => {
  let state = { concurrency: 8, baselineMs: 50, cooldownWindows: 0 };
  const targets = [];
  for (let window = 0; window < 30; window++) {
    state = nextConcurrency(state.concurrency, 16, {
      ...state, samples: 20, averageMs: 500, oldestPendingMs: 500,
    });
    targets.push(state.concurrency);
  }
  assert.ok(Math.min(...targets) < 8);
  assert.ok(state.concurrency > Math.min(...targets));
  assert.ok(targets.every(target => target >= 1 && target <= 16));
  const stalled = nextConcurrency(state.concurrency, 16, {
    ...state, samples: 0, averageMs: null, oldestPendingMs: 5000,
  });
  assert.ok(stalled.concurrency < state.concurrency);
});

test('Retry-After accepts seconds and HTTP dates, and ignores invalid or expired delays', () => {
  const now = Date.parse('2026-09-17T22:00:00Z');
  assert.equal(retryAfterDelay('3', now), 3000);
  assert.equal(retryAfterDelay('Thu, 17 Sep 2026 22:00:05 GMT', now), 5000);
  assert.equal(retryAfterDelay('Thu, 17 Sep 2026 21:00:00 GMT', now), 0);
  assert.equal(retryAfterDelay('invalid', now), 0);
  assert.equal(retryAfterDelay(undefined, now), 0);
});

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function fixture({ prayers, failure = false, otherPrayers = 0, timeoutSeconds, hang = false,
  concurrency = 16, maxConcurrency = 64, responseDelay = () => 50, networkFailure = false,
  failureStatus = 503, retryAfter }) {
  const page = await browser.newPage();
  let counter = 1234;
  let received = 0;
  let completed = 0;
  let maxInFlight = 0;
  let completedAtReload;
  let firstFinished = false;
  let thirdStartedBeforeFirstFinished = false;
  const progress = [];
  const requestTimes = [];
  await page.route('http://autoprayer.test/**', async route => {
    if (route.request().method() === 'POST') {
      const number = ++received;
      requestTimes.push(performance.now());
      if (number === 3) thirdStartedBeforeFirstFinished = !firstFinished;
      maxInFlight = Math.max(maxInFlight, received - completed);
      if (hang) return;
      // Responses complete later than prayer dispatch, as on the live site.
      await new Promise(resolve => setTimeout(resolve, responseDelay(number)));
      if (typeof networkFailure === 'function' ? networkFailure(number) : networkFailure) {
        completed++;
        await route.abort('failed');
        return;
      }
      const rejected = typeof failure === 'function' ? failure(number) : failure;
      if (!rejected) counter++;
      completed++;
      if (number === 1) firstFinished = true;
      if (completed === prayers) counter += otherPrayers;
      await route.fulfill({
        status: rejected ? failureStatus : 200,
        headers: rejected && retryAfter ? { 'Retry-After': retryAfter } : {},
        body: String(counter),
      });
      return;
    }
    if (received > 0) completedAtReload = completed;
    await route.fulfill({ contentType: 'text/html', body: `
      <output data-testid="tibo-total-pleas">${counter.toLocaleString('en-US')}</output>
      <button data-testid="saint-tibo-button" disabled><img alt="Saint Tibo"></button>
      <script>
        const button = document.querySelector('button');
        button.onclick = () => fetch('/_serverFn/prayer', { method: 'POST' });
        setTimeout(() => { button.disabled = false; }, 30);
      </script>
    ` });
  });
  try {
    await page.goto('http://autoprayer.test/');
    const result = await runPrayers(page, prayers, timeoutSeconds, status => progress.push({ ...status, at: performance.now() }),
      { concurrency, maxConcurrency });
    return { result, received, completedAtReload, maxInFlight, thirdStartedBeforeFirstFinished, progress, requestTimes };
  } finally {
    await page.close();
  }
}

test('bounds pending requests and completes every prayer despite concurrent visitors', async () => {
  const { result, received, completedAtReload, maxInFlight } = await fixture({ prayers: 200, otherPrayers: 17, maxConcurrency: 16 });
  assert.ok(maxInFlight <= 16, `Queued ${maxInFlight} simultaneous requests`);
  assert.equal(received, 200);
  assert.equal(completedAtReload, 200);
  assert.equal(result.prayerRequestsCompleted, 200);
  assert.equal(result.prayersDispatched, 200);
  assert.equal(result.beforeCounter, 1234);
  assert.equal(result.afterCounter, 1451);
  assert.equal(result.counterIncrease, 217);
  assert.deepEqual(result.errors, []);
  assert.ok(result.prayerElapsedMs >= 0);
  assert.ok(result.totalElapsedMs > result.prayerElapsedMs);
  assert.ok(Date.parse(result.endTime) >= Date.parse(result.prayersEndTime));
  assert.ok(Date.parse(result.prayersEndTime) >= Date.parse(result.startTime));
});

test('zero prayers records both snapshots without sending a prayer', async () => {
  const { result, received } = await fixture({ prayers: 0 });
  assert.equal(received, 0);
  assert.equal(result.beforeCounter, result.afterCounter);
  assert.equal(result.prayerRequestsCompleted, 0);
  assert.deepEqual(result.errors, []);
});

test('reports rejected requests even when other visitors increase the counter', async () => {
  const { result } = await fixture({ prayers: 3, failure: true, otherPrayers: 10 });
  assert.equal(result.counterIncrease, 10);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /HTTP 503/);
});

test('an explicit zero timeout waits for delayed prayer requests', async () => {
  const { result, completedAtReload } = await fixture({ prayers: 3, timeoutSeconds: 0 });
  assert.equal(completedAtReload, 3);
  assert.equal(result.prayerRequestsCompleted, 3);
  assert.deepEqual(result.errors, []);
});

test('a configured timeout reports incomplete prayer requests', async () => {
  const { result } = await fixture({ prayers: 1, timeoutSeconds: 0.05, hang: true });
  assert.ok(result.errors.includes('Timed out after 0.05 seconds: 0/1 prayer requests completed.'));
  assert.equal(result.afterCounter, result.beforeCounter);
  assert.equal(result.prayerRequestsCompleted, 0);
});

test('the overall timeout interrupts recovery without queuing or retrying the rest', async () => {
  const { result, received, maxInFlight } = await fixture({ prayers: 100_000, failure: true, timeoutSeconds: 0.25 });
  assert.equal(received, 16);
  assert.equal(maxInFlight, 16);
  assert.equal(result.prayersRequested, 100_000);
  assert.equal(result.prayersDispatched, 16);
  assert.equal(result.prayerRequestsCompleted, 16);
  assert.equal(result.prayerRequestsFailed, 16);
  assert.equal(result.prayerRequestsSucceeded, 0);
  assert.equal(result.errors.length, 17);
  assert.equal(result.status, 'timed_out');
});

test('refills free slots while a slow request is still pending', async () => {
  const { result, maxInFlight, thirdStartedBeforeFirstFinished } = await fixture({
    prayers: 8, concurrency: 2, maxConcurrency: 2, responseDelay: number => number === 1 ? 400 : 20,
  });
  assert.equal(thirdStartedBeforeFirstFinished, true);
  assert.equal(maxInFlight, 2);
  assert.equal(result.prayersDispatched, 8);
  assert.equal(result.prayerRequestsCompleted, 8);
  assert.deepEqual(result.errors, []);
});

test('automatically grows the rolling pool while preserving its ceiling and total', async () => {
  const { result, received, maxInFlight, progress } = await fixture({
    prayers: 120, concurrency: 2, maxConcurrency: 3,
  });
  assert.equal(received, 120);
  assert.equal(result.prayerRequestsCompleted, 120);
  assert.equal(result.initialConcurrency, 2);
  assert.equal(result.peakConcurrency, 3);
  assert.equal(maxInFlight, 3);
  assert.ok(progress.some(status => status.concurrency === 3));
  assert.ok(progress.every(status => status.completed <= status.dispatched));
  assert.deepEqual(result.errors, []);
});

test('a burst of network failures pauses once, lowers concurrency, and continues only unsent prayers', async () => {
  const { result, received, progress, requestTimes } = await fixture({
    prayers: 20, concurrency: 8, networkFailure: number => number <= 3,
  });
  assert.equal(received, 20);
  assert.equal(result.prayerRequestsCompleted, 20);
  assert.equal(result.prayerRequestsSucceeded, 17);
  assert.equal(result.prayerRequestsFailed, 3);
  assert.equal(result.recoveryCount, 1);
  assert.equal(result.status, 'completed_with_failures');
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /ERR_FAILED/);
  const recovery = progress.find(status => status.status === 'recovering');
  assert.equal(recovery.concurrency, 4);
  assert.ok(requestTimes[recovery.dispatched] - recovery.at >= 1900);
  assert.equal(progress.at(-1).status, 'completed_with_failures');
});

test('HTTP failures honor Retry-After before dispatching unsent prayers', async () => {
  const { result, received, requestTimes } = await fixture({
    prayers: 4, concurrency: 2, failure: number => number <= 2, failureStatus: 429, retryAfter: '3',
  });
  assert.equal(received, 4);
  assert.equal(result.prayerRequestsSucceeded, 2);
  assert.equal(result.prayerRequestsFailed, 2);
  assert.equal(result.recoveryCount, 1);
  assert.ok(requestTimes[2] - requestTimes[1] >= 2900);
  assert.match(result.errors[0], /HTTP 429/);
});

test('repeated failures increase the pause while each requested prayer is attempted only once', async () => {
  const { result, received, requestTimes } = await fixture({ prayers: 3, concurrency: 1, networkFailure: true });
  assert.equal(received, 3);
  assert.equal(result.prayerRequestsFailed, 3);
  assert.equal(result.prayerRequestsSucceeded, 0);
  assert.equal(result.recoveryCount, 2);
  assert.ok(requestTimes[1] - requestTimes[0] >= 1900);
  assert.ok(requestTimes[2] - requestTimes[1] >= 3900);
  assert.equal(result.status, 'completed_with_failures');
});

test('historical errors do not prevent adaptive scaling after recovery', async () => {
  const { result, progress } = await fixture({
    prayers: 160, concurrency: 2, maxConcurrency: 3, networkFailure: number => number === 1,
  });
  const recoveryIndex = progress.findIndex(status => status.status === 'recovering');
  assert.equal(progress[recoveryIndex].concurrency, 1);
  assert.ok(progress.slice(recoveryIndex + 1).some(status => status.status === 'running' && status.concurrency > 1));
  assert.equal(result.prayersDispatched, 160);
  assert.equal(result.prayerRequestsSucceeded, 159);
  assert.equal(result.prayerRequestsFailed, 1);
  assert.equal(result.status, 'completed_with_failures');
});

test('stalled requests scale the target down without cancelling or dispatching replacements', async () => {
  const { result, received, progress } = await fixture({
    prayers: 100, concurrency: 4, maxConcurrency: 4, hang: true, timeoutSeconds: 4.2,
  });
  assert.equal(received, 4);
  assert.equal(result.prayersDispatched, 4);
  assert.equal(result.prayerRequestsCompleted, 0);
  assert.equal(result.finalConcurrency, 2);
  assert.ok(progress.some(status => status.concurrency === 2 && status.dispatched === 4 && status.completed === 0));
  assert.ok(result.errors.includes('Timed out after 4.2 seconds: 0/100 prayer requests completed.'));
});

test('recent throughput reflects a slowdown instead of reporting the lifetime average', async () => {
  const { result, progress } = await fixture({
    prayers: 40, concurrency: 2, maxConcurrency: 2, responseDelay: number => number <= 10 ? 20 : 400,
  });
  const last = progress.at(-1);
  assert.equal(result.prayerRequestsCompleted, 40);
  assert.deepEqual(result.errors, []);
  assert.ok(last.requestsPerSecond < last.averageRequestsPerSecond,
    `Recent ${last.requestsPerSecond} must show the slowdown relative to average ${last.averageRequestsPerSecond}`);
  assert.ok(last.latencyMs > 0);
  assert.equal(typeof last.scalingReason, 'string');
  assert.ok(progress.every(status => Number.isFinite(status.requestsPerSecond) && Number.isFinite(status.averageRequestsPerSecond)));
});
