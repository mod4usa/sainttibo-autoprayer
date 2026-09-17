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
the requested number of times in batches of up to 16. Each batch waits for its
requests to finish before the next starts, keeping large runs from filling the
browser's request queue. There is no additional delay between batches. Each
prayer activates the picture through the DOM. A failed batch stops further
prayers and reports the partial run; it is not retried.

Progress is printed to stderr every five seconds, showing dispatched, completed,
pending, and failed request counts. The final JSON is printed to stdout.

`--timeout-seconds` defaults to `0`, which waits indefinitely for prayer requests
to finish. Set a positive value to limit that wait (fractional seconds are
accepted, up to 2147483.647 seconds):

```sh
node autoprayer.mjs --prayers 100 --timeout-seconds 300
```

The timeout covers all batches together, starting just before the first batch.
This option controls prayer-request completion only; browser navigation and
element waits retain Playwright's existing timeouts. Press Ctrl+C to stop a run.

Output is JSON containing:

- `beforeCounter` and `startTime`: the displayed public counter and UTC time just
  before praying.
- `prayersEndTime` and `prayerElapsedMs`: when the loop finished and the elapsed
  time through the last dispatched prayer, including waits between batches but
  excluding browser startup and the final batch's network completion.
- `afterCounter` and `endTime`: a fresh counter and UTC time after the prayer
  requests complete and the page reloads.
- `totalElapsedMs`: elapsed time from the start of praying through the final
  counter capture, including request completion and the reload.
- `prayersRequested`, `prayersDispatched`, `prayerRequestsCompleted`,
  `counterIncrease`, and `errors`. Completed requests include HTTP/network
  failures; inspect `errors` to distinguish these from successful responses.

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
