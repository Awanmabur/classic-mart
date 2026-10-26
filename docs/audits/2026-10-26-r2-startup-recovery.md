# R2 startup timeout and process cleanup — 26 October 2026

The reported local sequence passed MongoDB topology and the standalone R2
round-trip check, then failed a subsequent startup GET with an AbortError. The
web entrypoint called `process.exit(1)` immediately afterwards, followed by a
Windows libuv `UV_HANDLE_CLOSING` assertion. Passing an earlier network probe
does not establish that the next request cannot time out. The exact native
Windows assertion has not been independently reproduced in this Linux workspace.

The R2 request deadline previously ended when fetch returned its headers;
response-body reads were outside that deadline. Startup had no transient probe
retry, successful PUT/DELETE replies were not consumed, and probe deletion
errors were always ignored. The web and worker startup catches also bypassed
their cleanup paths and hard-exited the process.

The request deadline now covers headers and bytes and returns a sanitized
`MEDIA_STORAGE_TIMEOUT` error. Late responses are discarded, reply streams are
consumed or cancelled, redirects remain forbidden and provider XML/signatures
are never copied into error messages. Ordinary media operations retain their
existing semantics and receive no automatic mutation replay.

Only the uniquely named private health object receives up to three attempts
per operation for known transient network/HTTP failures, with bounded backoff.
Retries reuse the same key and bytes. Permission, missing-object and integrity
failures do not retry. Successful checksum verification and deletion are both
required before readiness succeeds. Cancellation preserves the caller's stop
reason, stops backoff and makes one independent cleanup attempt of at most two
seconds. The configured request deadline is constrained to 3,000–60,000 ms to
prevent timer overflow and unbounded configuration values.

Web and worker startup accept a cancellation signal and check shutdown state
after each asynchronous initialization phase. Failed starts log the failure,
retain nonzero exit status, clean up and let Node drain native close callbacks.
A signal during startup cannot later open an HTTP listener or publish worker
readiness. The worker skips heartbeat queries before Mongo is connected and
withdraws readiness while stopping. A ten-second unref'd watchdog remains for
genuinely stuck shutdowns; it is the only forced-exit path.

Regression coverage includes real deadline timers, stalled headers/bodies,
late replies, transient recovery and exhaustion, ambiguous probe PUTs, forbidden
redirects, cleanup permission, cancellation and ordinary-upload non-replay.
Separate subprocess tests execute the actual web/worker entrypoints with
test-only dependency stubs, proving natural event-loop drain, nonzero failures,
shutdown/startup races and both real ten-second watchdogs. IPC delivery of the
registered signal handlers makes those fixtures portable; it does not claim
native Windows OS signal delivery. Existing live worker tests exercise the real
database/process lifecycle separately. Real Windows execution and the owner's
R2 credentials/network are outside this workspace's observed results.

Local verification passed 55 focused storage/startup/launch tests and 13 existing
R2, supervisor and live worker/readiness tests, with no failures or skips. Release
script, import, syntax, project, static security, frontend and functionality gates
passed. The final hosted result is tracked by the commit's Classic Mart CI check.

The first hosted attempt at `d4b28ec` (run `40369877172`) reached its one-hour
limit after the CI MongoDB service disappeared during the moderation catalogue
fixture. Later fixtures reported connection refused. The test runner orders
files alphabetically and serializes live fixtures, so this service loss occurred
before the new R2/entrypoint test files. Its three Pages checks passed; the
remaining release gates did not run. Container exit/OOM state was not recorded
by the startup-only diagnostic hook, so the underlying container failure is
unclassified. This attempt is not a successful hosted verification.

The Actions-only canonical test runner now checks the fixed disposable MongoDB
and Redis container states before launch and every ten seconds. Unavailable,
paused, restarting or uninspectable services terminate the owned test process
group, capture bounded state/log diagnostics to the existing artifact and emit
an escaped failure annotation. A SIGTERM-resistant descendant is force-stopped
after the cleanup grace period. Local test runs do not require Docker. No test
is skipped or replayed, no service is restarted, and all existing CI limits and
release gates remain unchanged. Twenty observer, diagnostics, real test-reporter
and release-pipeline regression cases passed locally with zero skips/failures.
