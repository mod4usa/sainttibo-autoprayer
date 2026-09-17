import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchBrowser, parseClicks, runClicks } from './clicker.mjs';

test('requires an explicit non-negative integer click count', () => {
  for (const args of [[], ['--clicks', '1.5'], ['--clicks=-1'], ['--clicks', 'NaN'],
    ['--clicks', '9007199254740992'], ['--clicks', '2', '--unknown']]) {
    assert.throws(() => parseClicks(args));
  }
  assert.equal(parseClicks(['--clicks', '0']), 0);
  assert.equal(parseClicks(['--clicks=200']), 200);
  assert.equal(parseClicks(['--help']), null);
});

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function fixture({ clicks, failure = false, otherClicks = 0 }) {
  const page = await browser.newPage();
  let counter = 1234;
  let received = 0;
  let completed = 0;
  let completedAtReload;
  await page.route('http://clicker.test/**', async route => {
    if (route.request().method() === 'POST') {
      received++;
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
    const result = await runClicks(page, clicks);
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
