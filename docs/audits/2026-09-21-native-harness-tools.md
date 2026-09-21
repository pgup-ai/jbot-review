# Native review tools

This branch removes jbot's replacement repository tools. CommandCode now uses
its native CLI tools in plan mode, enabled by default; `JBOT_COMMANDCODE_TOOLS=false`
remains the rollback to embedded evidence only. Pi uses its documented native
`read`, `grep`, `find`, and `ls` tools. OpenCode no longer registers `review_context`.
Other provider routing and existing tool-less backend policies are unchanged.

Deleted the CommandCode mod, Pi read/search/diff replacements, shared byte-page
and literal-search implementations, and obsolete tool tests. No dependencies or
CLI versions changed. Full assigned diff delivery, finding verification and
publication gates remain in jbot. Optional evidence preparation/checkpoint hooks
remain; they do not register repository tools.

CommandCode keeps an isolated home and launch directory. JSON repairs use a
separate temporary home with tools denied, so repairing one response cannot
change permissions for concurrent sessions. Pi withholds mutation/shell tools
through the SDK's native tool selection. Native file tools are not a filesystem
sandbox: untrusted repositories should run in isolated environments.

## Local validation

Used the changed source and installed CommandCode 1.56.2. The small fixture changes
`if (index < 0)` to `if (!index)` after `indexOf`, with an unchanged caller looking
up the first array element. Runs used the real local pipeline with finding
verification explicitly enabled, full diff delivery, and no GitHub posting.

| Run                                                      | Result                                                                                          |                           Time |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -----------------------------: |
| CommandCode / Muse Spark 1.3 Contributor, low            | Main review and verification completed; retained the seeded bug; verifier made two native reads | 17.8s total; 7.9s verification |
| Pi / OpenRouter Ling 3.0 Flash Fin free                  | Main review and verification completed; retained the seeded bug                                 |                     7.2s total |
| Pi direct verification, same free model                  | Read both files using native tools; confirmed the seeded bug                                    |                           7.0s |
| CommandCode / Muse Spark, nine historical FMS candidates | 25 native calls completed; no final verdict before timeout                                      |                       180s cap |
| Pi / Nemotron 3.5 Lightning free, same nine candidates   | One tool call observed; no final verdict before timeout                                         |                       180s cap |

The first free MiniMax route returned 404 (free route unavailable); that was not
a review result. Initial local pipeline attempts also exposed operator settings:
`PROVIDER=devin` and `JBOT_SDK_ENGINE=opencode` in the local environment. The rows
above explicitly selected the intended provider/engine and verification setting.

The earlier standalone native-CLI experiment completed the nine FMS verdicts in
145.8s versus a custom-tool timeout at 180s, but this repeat did not reproduce
that completion. These runs prove native tool wiring and a simple known-bug
path, not a general latency or accuracy improvement. The fixture's P1 rating is
model output, not an independently validated severity calibration.

Pi's native regex grep, glob find, and bounded line reads were also exercised
directly against the installed SDK. The slim Docker image builds, contains
CommandCode 1.56.2 and Pi's native tools, and no longer contains the custom mod.

Local raw logs are in `.jbot-review/native-harness-validation/` and `/tmp/native-*.log`;
credentials are excluded. Model runs did not change the reviewed checkouts.

## Self-review

- Typecheck, lint, 1,112 tests, build and diff whitespace checks pass.
- Existing recovery tests now check native settings isolation and repair-home cleanup.
- Native Pi event telemetry is covered without replacing tool execution.
- De-slop: removed redundant native-tool descriptions and obsolete experiment arms;
  no new tool abstraction. Two modified comment blocks were reviewed and kept.
  Two renamed/reworked test cases preserve changed contracts; no new standalone cases.

The full live quality corpus and blind adjudication have **not** been run. Because
CommandCode tools become enabled by default, the repository's full-corpus gate
is still required before merging or deploying this default change. Local smoke
results do not satisfy that gate.
