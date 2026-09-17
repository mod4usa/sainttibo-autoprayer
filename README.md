# sainttibo-autoprayer

Requires Node.js 22 or newer.

```sh
npm install
npx playwright install chromium
node autoprayer.mjs --prayers 100
```

The browser install is optional if Google Chrome is already installed in its
standard location. The script uses Playwright's Chromium when available and
otherwise uses Chrome. It runs headlessly.

`--prayers` is required and accepts a non-negative integer, including zero for a
read-only run. The script visits https://codexreset.org/, waits for the Saint Tibo
button to become enabled, and calls the picture's normal DOM `click()` handler
the requested number of times. A rolling pool refills available request slots
as responses arrive, so one slow request does not hold up every other prayer.
The pool bounds outstanding requests to avoid filling the browser's queue.
HTTP/network errors stop new prayers; existing requests are allowed to finish
before the partial run is reported. Prayers are never retried.

Concurrency automatically adjusts to observed response times:

- `--concurrency` sets the starting number of outstanding requests (default 16).
- `--max-concurrency` sets the upper limit (default 64). Both options must be
  positive integers, and the starting concurrency cannot exceed the maximum.
- Every two seconds, a healthy window with enough completed requests increases
  the target by one. Rising latency or stalled requests halve the target, down
  to a minimum of one. Existing requests drain naturally when the target drops;
  they are not cancelled or replaced.

```sh
node autoprayer.mjs --prayers 100000 --concurrency 8 --max-concurrency 32
```

The controller compares mean latency with the best observed window. A window
is healthy at no more than 1.25 times that baseline (with a 100 ms allowance).
It reduces concurrency above twice the baseline (at least 250 ms), or when a
pending request exceeds three times the baseline (at least one second). Before
there are any samples, the pending-request threshold is three seconds. These
are throughput heuristics, not a guarantee that more concurrency improves
performance; the website may be the limiting factor.

Progress is printed to stderr every five seconds and whenever concurrency
changes, showing dispatched, completed, pending, and failed request counts,
the concurrency target and maximum, and average completed requests per second.
The final JSON is printed to stdout.

`--timeout-seconds` defaults to `0`, which waits indefinitely for prayer requests
to finish. Set a positive value to limit that wait (fractional seconds are
accepted, up to 2147483.647 seconds):

```sh
node autoprayer.mjs --prayers 100 --timeout-seconds 300
```

The timeout covers the entire request pool, starting just before the first prayer.
This option controls prayer-request completion only; browser navigation and
element waits retain Playwright's existing timeouts. Press Ctrl+C to stop a run.

Output is JSON containing:

- `beforeCounter` and `startTime`: the displayed public counter and UTC time just
  before praying.
- `prayersEndTime` and `prayerElapsedMs`: when the loop finished and the elapsed
  time through the last dispatched prayer, including waits for free request
  slots but excluding browser startup and the remaining network completion.
- `afterCounter` and `endTime`: a fresh counter and UTC time after the prayer
  requests complete and the page reloads.
- `totalElapsedMs`: elapsed time from the start of praying through the final
  counter capture, including request completion and the reload.
- `prayersRequested`, `prayersDispatched`, `prayerRequestsCompleted`,
  `counterIncrease`, and `errors`. Completed requests include HTTP/network
  failures; inspect `errors` to distinguish these from successful responses.
- `initialConcurrency`, `finalConcurrency`, `peakConcurrency`, and
  `maxConcurrency`: the starting, final, highest, and maximum allowed request
  targets. After a reduction, pending requests can temporarily exceed the new
  target while they drain.

Elapsed durations use the browser's monotonic performance clock. Other visitors
can increase the public counter during the run, so `counterIncrease` need not
equal `prayersRequested`. The script waits for its own requests rather than
inferring completion from the public counter. An HTTP/network failure or a
configured request completion timeout is reported in `errors` and produces a
nonzero exit status. Failed requests are not retried because a retry could
duplicate a prayer that reached the server. HTTP success is not an independent
guarantee that the server persisted each prayer.

The implementation depends on the site's current `data-testid` attributes and
one `/_serverFn/` POST per prayer; site changes may require updates.

Run the offline browser tests with `npm test`.
