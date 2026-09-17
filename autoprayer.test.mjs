import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchBrowser, nextConcurrency, parseOptions, runPrayers } from './autoprayer.mjs';

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
  assert.equal(nextConcurrency(16, 64, healthy), 17);
  assert.equal(nextConcurrency(16, 16, healthy), 16);
  assert.equal(nextConcurrency(16, 64, { ...healthy, samples: 1 }), 16);
  assert.equal(nextConcurrency(16, 64, { ...healthy, baselineMs: null }), 17);
});

test('latency growth and stalled requests scale down, with a floor of one and recovery', () => {
  const slow = { samples: 16, averageMs: 500, baselineMs: 100, oldestPendingMs: 500 };
  assert.equal(nextConcurrency(16, 64, slow), 8);
  assert.equal(nextConcurrency(3, 64, slow), 1);
  assert.equal(nextConcurrency(1, 64, slow), 1);
  assert.equal(nextConcurrency(16, 64, { ...slow, samples: 0, averageMs: null, oldestPendingMs: 4000 }), 8);
  assert.equal(nextConcurrency(16, 64, { ...slow, samples: 0, averageMs: null, oldestPendingMs: 0 }), 16);
  assert.equal(nextConcurrency(8, 64, { ...slow, averageMs: 100, oldestPendingMs: 100 }), 9);
});

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function fixture({ prayers, failure = false, otherPrayers = 0, timeoutSeconds, hang = false,
  concurrency = 16, maxConcurrency = 64, responseDelay = () => 50, networkFailure = false }) {
  const page = await browser.newPage();
  let counter = 1234;
  let received = 0;
  let completed = 0;
  let maxInFlight = 0;
  let completedAtReload;
  let firstFinished = false;
  let thirdStartedBeforeFirstFinished = false;
  const progress = [];
  await page.route('http://autoprayer.test/**', async route => {
    if (route.request().method() === 'POST') {
      const number = ++received;
      if (number === 3) thirdStartedBeforeFirstFinished = !firstFinished;
      maxInFlight = Math.max(maxInFlight, received - completed);
      if (hang) return;
      // Responses complete later than prayer dispatch, as on the live site.
      await new Promise(resolve => setTimeout(resolve, responseDelay(number)));
      if (networkFailure) {
        completed++;
        await route.abort('failed');
        return;
      }
      if (!failure) counter++;
      completed++;
      if (number === 1) firstFinished = true;
      if (completed === prayers) counter += otherPrayers;
      await route.fulfill({ status: failure ? 503 : 200, body: String(counter) });
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
    const result = await runPrayers(page, prayers, timeoutSeconds, status => progress.push(status),
      { concurrency, maxConcurrency });
    return { result, received, completedAtReload, maxInFlight, thirdStartedBeforeFirstFinished, progress };
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

test('a failure stops a 100,000-prayer run without queuing or retrying the rest', async () => {
  const { result, received, maxInFlight } = await fixture({ prayers: 100_000, failure: true });
  assert.equal(received, 16);
  assert.equal(maxInFlight, 16);
  assert.equal(result.prayersRequested, 100_000);
  assert.equal(result.prayersDispatched, 16);
  assert.equal(result.prayerRequestsCompleted, 16);
  assert.equal(result.errors.length, 16);
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

test('network failures stop further dispatch and drain the existing pool', async () => {
  const { result, received } = await fixture({ prayers: 100, concurrency: 3, networkFailure: true });
  assert.equal(received, 3);
  assert.equal(result.prayerRequestsCompleted, 3);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /ERR_FAILED/);
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
