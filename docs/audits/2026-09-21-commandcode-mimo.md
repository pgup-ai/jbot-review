# CommandCode MiMo v2.6 support

CommandCode 1.62.0's published changelog adds MiMo v2.6 Pro, Pro UltraSpeed and
Flash. The 1.56.2 catalog lacks these IDs; the authenticated 1.62.0 model listing
includes all three. The Docker pin now uses 1.62.0. J-Bot's prompt limits use the
bundled catalog's 1,048,576-token context window for each variant.

Both requested models were tried through the real local pipeline, with native
tools, full diff delivery and verification enabled:

- `commandcode/xiaomi/mimo-v2.6-flash`
- `commandcode/xiaomi/mimo-v2.6-pro`

The initial key hit its weekly usage limit. Retrying with an alternate key from
`.env` allowed inference. Flash completed the full review and verification in
31.5s: 2/2 hunks delivered, both seeded bugs confirmed, no incomplete sessions.
Pro also completed with both bugs confirmed and no incomplete sessions: 143.0s
total, including 81.6s for the main review and 60.7s for verification. Native
reads/searches worked in both models. Pro attempted one shell command that the
read-only policy blocked, then completed using the allowed tools.

Logs: `/tmp/commandcode-mimo-alternate-0-flash.log` and
`/tmp/commandcode-mimo-alternate-0-pro.log`. These are small-fixture smoke tests,
not a general quality or latency benchmark. Credentials were not changed.

The local npm install and CLI catalog check passed. The Docker build reached the
updated npm installation but failed with `ENOSPC` in Docker's storage. Packaging
still needs a successful image build; no caches or existing images were deleted.

All 1,120 tests, typecheck, lint, formatting and the JavaScript bundle build
passed. Self-review found no new code issues. The quality corpus was not run;
model defaults and review prompts are unchanged by this upgrade.
