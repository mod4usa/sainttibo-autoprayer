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
HTTP/network errors pause new prayers and halve the concurrency target, down
to one. The script lets outstanding requests finish and then continues with
unsent prayers after the pause. Failed prayers remain recorded and are never
retried or replaced: `--prayers` specifies attempts, not guaranteed successes.

The initial recovery pause is two seconds. Repeated failure episodes increase
it to 4, 8, 16, then at most 30 seconds. Failures in the same outstanding pool
share one reduction and pause, measured from the last failure. A healthy
scaling window resets the backoff to two seconds. Longer server-provided
`Retry-After` delays are honored. Recovery can continue throughout a run;
`--timeout-seconds` still bounds the entire run when set.

Concurrency automatically adjusts to observed response times:

- `--concurrency` sets the starting number of outstanding requests (default 16).
- `--max-concurrency` sets the upper limit (default 64). Both options must be
  positive integers, and the starting concurrency cannot exceed the maximum.
- Every two seconds, a healthy window with enough completed requests increases
  the target by one. Rising latency or stalled requests halve the target, down
  to a minimum of one. Existing requests drain naturally when the target drops;
  they are not cancelled or replaced. After a reduction, the controller skips
  the next two scaling checks before changing the target again.

```sh
node autoprayer.mjs --prayers 100000 --concurrency 8 --max-concurrency 32
```

The controller compares mean latency with a moving baseline, weighted 80% to
the previous baseline and 20% to the latest window. It learns faster and slower
conditions, including during cooldown and at concurrency one, so an unusually
fast early response cannot permanently prevent recovery. A window is healthy
at no more than 1.25 times the baseline (with a threshold of at least 100 ms).
It reduces concurrency above twice the baseline (at least 250 ms), or when a
pending request exceeds three times the baseline (at least one second). Before
there are any samples, the pending-request threshold is three seconds. These
are throughput heuristics, not a guarantee that more concurrency improves
performance; the website may be the limiting factor.

Progress is printed to stderr every five seconds and whenever concurrency
changes, showing dispatched, completed, pending, and failed request counts,
the concurrency target and maximum, recent and lifetime-average completed
requests per second, the latest window's mean latency, and the scaling decision.
It distinguishes settled, successful, and failed requests, shows recovery pause
time, and reports `completed with failures` when all attempts finish with errors.
Recent throughput measures completions since the previous rate sample, at least
one second apart; closely spaced log lines share the latest sample. The final
JSON is printed to stdout.

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
  `counterIncrease`, and `errors`. Completed requests are settled requests,
  including HTTP/network failures.
- `prayerRequestsSucceeded`, `prayerRequestsFailed`, and `recoveryCount`:
  successful HTTP responses, failed requests, and recovery episodes.
- `status`: `completed`, `completed_with_failures`, or `timed_out`.
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
