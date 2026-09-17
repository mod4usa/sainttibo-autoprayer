# Codex Reset clicker

Requires Node.js 22 or newer.

```sh
npm install
npx playwright install chromium
node clicker.mjs --clicks 100
```

The browser install is optional if Google Chrome is already installed in its
standard location. The script uses Playwright's Chromium when available and
otherwise uses Chrome. It runs headlessly.

`--clicks` is required and accepts a non-negative integer, including zero for a
read-only run. The script visits https://codexreset.org/, waits for the Saint Tibo
button to become enabled, and calls the picture's normal DOM `click()` handler
the requested number of times in a browser-side loop with no intentional delay.
These are simulated DOM clicks, not physical mouse input.

`--timeout-seconds` defaults to `0`, which waits indefinitely for click requests
to finish. Set a positive value to limit that wait (fractional seconds are
accepted, up to 2147483.647 seconds):

```sh
node clicker.mjs --clicks 100 --timeout-seconds 300
```

This option controls click-request completion only; browser navigation and
element waits retain Playwright's existing timeouts. Press Ctrl+C to stop a run.

Output is JSON containing:

- `beforeCounter` and `startTime`: the displayed public counter and UTC time just
  before clicking.
- `clicksEndTime` and `clickElapsedMs`: when the loop finished and the elapsed
  time spent generating clicks, excluding browser startup and network completion.
- `afterCounter` and `endTime`: a fresh counter and UTC time after the click
  requests complete and the page reloads.
- `totalElapsedMs`: elapsed time from the start of clicking through the final
  counter capture, including request completion and the reload.
- `clicksRequested`, `clickRequestsCompleted`, `counterIncrease`, and `errors`.

Elapsed durations use the browser's monotonic performance clock. Other visitors
can increase the public counter during the run, so `counterIncrease` need not
equal `clicksRequested`. The script waits for its own requests rather than
inferring completion from the public counter. An HTTP/network failure or a
configured request completion timeout is reported in `errors` and produces a
nonzero exit status. Failed requests are not retried because a retry could
duplicate a click that reached the server. HTTP success is not an independent
guarantee that the server persisted each click.

The implementation depends on the site's current `data-testid` attributes and
one `/_serverFn/` POST per click; site changes may require updates.

Run the offline browser tests with `npm test`.
