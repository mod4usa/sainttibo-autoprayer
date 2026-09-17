import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchBrowser, parseOptions, runClicks } from './clicker.mjs';

test('requires an explicit non-negative integer click count', () => {
  for (const args of [[], ['--clicks', '1.5'], ['--clicks=-1'], ['--clicks', 'NaN'],
    ['--clicks', '9007199254740992'], ['--clicks', '2', '--unknown']]) {
    assert.throws(() => parseOptions(args));
  }
  assert.deepEqual(parseOptions(['--clicks', '0']), { clicks: 0, timeoutSeconds: 0 });
  assert.deepEqual(parseOptions(['--clicks=200']), { clicks: 200, timeoutSeconds: 0 });
  assert.equal(parseOptions(['--help']), null);
});

test('accepts an optional timeout and rejects invalid or overflowing values', () => {
  for (const timeoutSeconds of [0, 0.5, 300]) {
    assert.deepEqual(parseOptions(['--clicks', '2', `--timeout-seconds=${timeoutSeconds}`]),
      { clicks: 2, timeoutSeconds });
  }
  for (const value of ['-1', '', 'NaN', 'Infinity', 'abc', '2147483.648']) {
    assert.throws(() => parseOptions(['--clicks', '2', `--timeout-seconds=${value}`]),
      /--timeout-seconds/);
  }
});

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function fixture({ clicks, failure = false, otherClicks = 0, timeoutSeconds, hang = false }) {
  const page = await browser.newPage();
  let counter = 1234;
  let received = 0;
  let completed = 0;
  let completedAtReload;
  await page.route('http://clicker.test/**', async route => {
    if (route.request().method() === 'POST') {
      received++;
      if (hang) return;
      // Responses complete later than click dispatch, as on the live site.
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!failure) counter++;
      completed++;
      if (completed === clicks) counter += otherClicks;
      await route.fulfill({ status: failure ? 503 : 200, body: String(counter) });
      return;
    }
    if (received > 0) completedAtReload = completed;
    await route.fulfill({ contentType: 'text/html', body: `
      <output data-testid="tibo-total-pleas">${counter.toLocaleString('en-US')}</output>
      <button data-testid="saint-tibo-button" disabled><img alt="Saint Tibo"></button>
      <script>
        const button = document.querySelector('button');
        button.onclick = () => fetch('/_serverFn/click', { method: 'POST' });
        setTimeout(() => { button.disabled = false; }, 30);
      </script>
    ` });
  });
  try {
    await page.goto('http://clicker.test/');
    const result = await runClicks(page, clicks, timeoutSeconds);
    return { result, received, completedAtReload };
  } finally {
    await page.close();
  }
}

test('dispatches the exact burst and waits for completion despite concurrent visitors', async () => {
  const { result, received, completedAtReload } = await fixture({ clicks: 200, otherClicks: 17 });
  assert.equal(received, 200);
  assert.equal(completedAtReload, 200);
  assert.equal(result.clickRequestsCompleted, 200);
  assert.equal(result.beforeCounter, 1234);
  assert.equal(result.afterCounter, 1451);
  assert.equal(result.counterIncrease, 217);
  assert.deepEqual(result.errors, []);
  assert.ok(result.clickElapsedMs >= 0);
  assert.ok(result.totalElapsedMs > result.clickElapsedMs);
  assert.ok(Date.parse(result.endTime) >= Date.parse(result.clicksEndTime));
  assert.ok(Date.parse(result.clicksEndTime) >= Date.parse(result.startTime));
});

test('zero clicks records both snapshots without sending a click', async () => {
  const { result, received } = await fixture({ clicks: 0 });
  assert.equal(received, 0);
  assert.equal(result.beforeCounter, result.afterCounter);
  assert.equal(result.clickRequestsCompleted, 0);
  assert.deepEqual(result.errors, []);
});

test('reports rejected requests even when other visitors increase the counter', async () => {
  const { result } = await fixture({ clicks: 3, failure: true, otherClicks: 10 });
  assert.equal(result.counterIncrease, 10);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /HTTP 503/);
});

test('an explicit zero timeout waits for delayed click requests', async () => {
  const { result, completedAtReload } = await fixture({ clicks: 3, timeoutSeconds: 0 });
  assert.equal(completedAtReload, 3);
  assert.equal(result.clickRequestsCompleted, 3);
  assert.deepEqual(result.errors, []);
});

test('a configured timeout reports incomplete click requests', async () => {
  const { result } = await fixture({ clicks: 1, timeoutSeconds: 0.05, hang: true });
  assert.ok(result.errors.includes('Timed out after 0.05 seconds: 0/1 click requests completed.'));
  assert.equal(result.afterCounter, result.beforeCounter);
});
