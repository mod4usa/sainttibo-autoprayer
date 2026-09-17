import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchBrowser, parseOptions, runPrayers } from './autoprayer.mjs';

test('requires an explicit non-negative integer prayer count', () => {
  for (const args of [[], ['--prayers', '1.5'], ['--prayers=-1'], ['--prayers', 'NaN'],
    ['--prayers', '9007199254740992'], ['--prayers', '2', '--unknown']]) {
    assert.throws(() => parseOptions(args));
  }
  assert.deepEqual(parseOptions(['--prayers', '0']), { prayers: 0, timeoutSeconds: 0 });
  assert.deepEqual(parseOptions(['--prayers=200']), { prayers: 200, timeoutSeconds: 0 });
  assert.equal(parseOptions(['--help']), null);
});

test('accepts an optional timeout and rejects invalid or overflowing values', () => {
  for (const timeoutSeconds of [0, 0.5, 300]) {
    assert.deepEqual(parseOptions(['--prayers', '2', `--timeout-seconds=${timeoutSeconds}`]),
      { prayers: 2, timeoutSeconds });
  }
  for (const value of ['-1', '', 'NaN', 'Infinity', 'abc', '2147483.648']) {
    assert.throws(() => parseOptions(['--prayers', '2', `--timeout-seconds=${value}`]),
      /--timeout-seconds/);
  }
});

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function fixture({ prayers, failure = false, otherPrayers = 0, timeoutSeconds, hang = false }) {
  const page = await browser.newPage();
  let counter = 1234;
  let received = 0;
  let completed = 0;
  let maxInFlight = 0;
  let completedAtReload;
  await page.route('http://autoprayer.test/**', async route => {
    if (route.request().method() === 'POST') {
      received++;
      maxInFlight = Math.max(maxInFlight, received - completed);
      if (hang) return;
      // Responses complete later than prayer dispatch, as on the live site.
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!failure) counter++;
      completed++;
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
    const result = await runPrayers(page, prayers, timeoutSeconds);
    return { result, received, completedAtReload, maxInFlight };
  } finally {
    await page.close();
  }
}

test('bounds pending requests and completes every prayer despite concurrent visitors', async () => {
  const { result, received, completedAtReload, maxInFlight } = await fixture({ prayers: 200, otherPrayers: 17 });
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

test('a failed batch stops a 100,000-prayer run without queuing or retrying the rest', async () => {
  const { result, received, maxInFlight } = await fixture({ prayers: 100_000, failure: true });
  assert.equal(received, 16);
  assert.equal(maxInFlight, 16);
  assert.equal(result.prayersRequested, 100_000);
  assert.equal(result.prayersDispatched, 16);
  assert.equal(result.prayerRequestsCompleted, 16);
  assert.equal(result.errors.length, 16);
});
