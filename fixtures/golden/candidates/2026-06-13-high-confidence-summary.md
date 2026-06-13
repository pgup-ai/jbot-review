# High-confidence golden corpus candidates

Generated: 2026-06-13T17:34:53.151Z
Window: 2026-06-06..2026-06-13 merged PRs, backend + frontend.

This is a review artifact, not the final fixture set. Promote only deduped, high-value entries into `fixtures/golden/<case>/expected-findings.json`.

## Counts

- Pull requests inspected: 87
- Explicit outcome candidates: 362
- Applied/legit candidates: 324
- Rejected/negative candidates: 38
- Likely j-bot miss seeds: 137
- J-bot hit regression seeds: 57
- Clean candidates: 7

## Applied By Source

- jbot-review: 96
- human: 81
- gemini-code-assist: 57
- cursor-bugbot: 52
- qodo: 16
- kilo-code: 12
- codex-review: 10

## Recommended Must-find Seeds: integral-xyz/fms

- integral-xyz/fms#3064 [cursor-bugbot] Delayed fallback suppresses follow-up reply
  - apps/core-ledger/src/ai-chat/ai-chat.service.ts:290; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3399488933
- integral-xyz/fms#3064 [cursor-bugbot] Unrelated merge misclassified after dedup
  - apps/core-ledger/src/ai-chat/agents/counterparty-dedup-intent.util.ts:43; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3400004500
- integral-xyz/fms#3064 [cursor-bugbot] Merge all ignores truncated duplicates
  - apps/core-ledger/src/ai-chat/agents/semantic-write-preview.builder.ts; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3400004504
- integral-xyz/fms#3064 [cursor-bugbot] Paged merge blocked by truncation check
  - apps/core-ledger/src/ai-chat/agents/semantic-write-preview.builder.ts:58; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3400022308
- integral-xyz/fms#3064 [cursor-bugbot] Initial merge previews without follow-up
  - apps/core-ledger/src/ai-chat/agents/counterparty-dedup-intent.util.ts:36; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3400022310
- integral-xyz/fms#3064 [cursor-bugbot] Duplicate summary detector too strict
  - apps/core-ledger/src/ai-chat/agents/counterparty-dedup-intent.util.ts:73; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3400100576
- integral-xyz/fms#3064 [cursor-bugbot] Duplicate merge previews same group
  - apps/core-ledger/src/ai-chat/agents/semantic-write-preview.builder.ts:75; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3400239371
- integral-xyz/fms#3064 [human] P1 correctness: the selector does not honor the commands emitted by the review response.\*\* Merge all except Acme matches all here and queues Acme's merge preview too, despite the r
  - apps/core-ledger/src/ai-chat/agents/semantic-write-preview.builder.ts; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3405200709
- integral-xyz/fms#3064 [human] Latin group names.\*\* normalizeSemanticText below uses [^a-z0-9], so labels and queries written in Chinese, Cyrillic, Arabic, Japanese, etc. normalize to empty or incomplete strings
  - apps/core-ledger/src/ai-chat/agents/semantic-write-preview.builder.ts:135; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3405200714
- integral-xyz/fms#3064 [human] ledger, this switches artifacts from process-local memory to shared Redis automatically. Root AGENTS.md requires a design note for persistence-contract changes, while docs/ai-chat/
  - apps/core-ledger/src/ai-chat/computation/computation-artifact-store.service.ts; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3405200720
- integral-xyz/fms#3064 [cursor-bugbot] Duplicate review hijacks counterparty lookups
  - apps/core-ledger/src/ai-chat/agents/counterparty-dedup-intent.util.ts:55; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3406132252
- integral-xyz/fms#3058 [gemini-code-assist] Performance Optimization: O(1) Map Lookups & Deduplication
  - apps/core-ledger-worker/src/workflows/migration/xero-sync/post-sync/xero-transfers-post-sync.activities.ts; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3058#discussion_r3397952793
- integral-xyz/fms#3057 [gemini-code-assist] To prevent potential runtime TypeErrors, use optional chaining and a fallback when accessing fieldNames from the metadata properties. While mapped columns should generally have fie
  - libs/core-ledger-shared/src/counterparties/repository/read-counterparty.repository.ts; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3057#discussion_r3396994907
- integral-xyz/fms#3056 [gemini-code-assist] The @HttpCode(HttpStatus.OK) decorator is redundant here because the custom @ApiOk decorator already encapsulates and applies the HttpStatus.OK status code internally. Removing it
  - apps/core-ledger/src/orders/orders.controller.ts:427; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3396924838
- integral-xyz/fms#3056 [cursor-bugbot] No cap on recipient count
  - apps/core-ledger/src/orders/dto/order-email.dto.ts:25; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3396972385
- integral-xyz/fms#3056 [human] nit: might want to go with a more generic name like postmark-email.client.ts. same goes for the type and class name -- outbound + send feels a bit redundant
  - apps/core-ledger/src/orders/order-email/postmark-email.client.ts:1; category=maintainability; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3398304733
- integral-xyz/fms#3056 [human] qq: should these be jsonb fields so we can store a json array of recipients? that way we only need one record per email instead of duplicating rows in order_email_sends for multipl
  - libs/core-ledger-shared/src/order/entity/order-email-send.entity-schema.ts; category=bug; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3398378486
- integral-xyz/fms#3056 [human] if we're only keeping successful sends, we prob don't need the status col
  - libs/core-ledger-shared/src/order/entity/order-email-send.entity-schema.ts; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3398386091
- integral-xyz/fms#3056 [human] might not need this one either
  - libs/core-ledger-shared/src/order/entity/order-email-send.entity-schema.ts; category=maintainability; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3398388784
- integral-xyz/fms#3056 [human] might not need anymore
  - libs/core-ledger-shared/src/order/model/order-email-send.ts; category=maintainability; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3398418734

## Recommended Must-find Seeds: integral-xyz/fms-frontend

- integral-xyz/fms-frontend#1786 [gemini-code-assist] Removing the GPT models (gpt-5.5, gpt-5.4, gpt-5.4-mini) from llmModelMetadata can cause runtime crashes in AiAgentModelSelector (specifically llmModelMetadata[aiAgentConfig.modelI
  - src/types/ai-agent.ts:178; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1786#discussion_r3406334504
- integral-xyz/fms-frontend#1783 [gemini-code-assist] The in operator cannot be used on primitive strings in JavaScript/TypeScript and will throw a TypeError at runtime if actor is a string other than 'system'. Additionally, if actor
  - src/components/orders/order-email-send-history.tsx; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1783#discussion_r3405895317
- integral-xyz/fms-frontend#1768 [gemini-code-assist] The query key for useAutoCategorizedSummary only includes the serialized range parameters, but does not include entityId. In a multi-entity application, if a user switches entities
  - src/api/business-events.ts; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3391362370
- integral-xyz/fms-frontend#1768 [gemini-code-assist] The query key for useAutoMatchedSummary only includes the serialized range parameters, but does not include entityId. In a multi-entity application, if a user switches entities, Re
  - src/api/business-events.ts; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3391362379
- integral-xyz/fms-frontend#1768 [gemini-code-assist] When parsing the ISO date string latestStatementEnd with Luxon, using a bare DateTime.fromISO can cause the date to be shifted to the local system timezone. For example, a date lik
  - src/components/agentic-workflows/dashboard-summary-cards.tsx; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3391362386
- integral-xyz/fms-frontend#1768 [kilo-code] [SUGGESTION]:\*\* Test name asserts range params are checked, but the assertions only verify entityId, not timestamp.gte/timestamp.lt
  - src/api/**tests**/business-events.test.ts:284; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3391364101
- integral-xyz/fms-frontend#1768 [kilo-code] WARNING:\*\* Optional summary endpoint may surface transient 404s/retries
  - src/api/business-events.ts:424; category=maintainability; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3403181562
- integral-xyz/fms-frontend#1768 [kilo-code] WARNING:\*\* Optional summary endpoint may surface transient 404s/retries
  - src/api/business-events.ts:447; category=maintainability; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3403181565
- integral-xyz/fms-frontend#1768 [kilo-code] WARNING:\*\* Reconciled card hides active changesDetected state
  - src/components/agentic-workflows/dashboard-summary-cards.tsx; category=bug; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3403181568
- integral-xyz/fms-frontend#1768 [human] nit: let's memo this
  - src/components/agentic-workflows/dashboard-summary-cards.tsx; category=maintainability; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3404055750
- integral-xyz/fms-frontend#1768 [human] nit: let's memo this too
  - src/components/agentic-workflows/dashboard-summary-cards.tsx; category=maintainability; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3404057109
- integral-xyz/fms-frontend#1768 [codex-review] Add the new summary keys to invalidation
  - src/api/query-keys/business-events.ts; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1768#discussion_r3404064334
- integral-xyz/fms-frontend#1767 [codex-review] Prevent dimension rows from becoming selectable filters
  - src/components/business-events/events-filter-provider.tsx:159; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1767#discussion_r3389751894
- integral-xyz/fms-frontend#1767 [gemini-code-assist] Import getTagColorBg alongside toTagColor to allow rendering a custom inline color dot.
  - src/components/business-events/events-filter-provider.tsx:29; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1767#discussion_r3389747987
- integral-xyz/fms-frontend#1766 [gemini-code-assist] Parsing orderDetails.orderDate with bare DateTime.fromISO uses the user's local timezone. In regions with negative offsets (e.g., US timezones), this can cause the parsed date to s
  - src/components/orders/order-wizard/use-invoice-preview-payload.ts:175; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1766#discussion_r3389149749
- integral-xyz/fms-frontend#1761 [human] nit: this fixture's date-range value is trimmed vs what the component actually emits — the real one also carries id, accountingTimePeriod, and accountingTimePeriodVariant. Those se
  - src/components/financial-statements/financial-statement-drill-down/**tests**/layout.test.ts:14; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1761#discussion_r3384301247
- integral-xyz/fms-frontend#1760 [gemini-code-assist] Currently, FilePreviewDialog is rendered as long as statementFileId is truthy, regardless of whether isStatementPreviewOpen is true. Inside FilePreviewDialog, the useDownloadFile q
  - src/components/bank-reconciliations/reconciliation-workspace-table.tsx; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1760#discussion_r3383700617
- integral-xyz/fms-frontend#1759 [gemini-code-assist] To prevent potential runtime crashes if text is unexpectedly null, undefined, or not a string (for example, if an item's value or keyword is missing or has an unexpected type), we
  - src/utils/text.ts:14; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1759#discussion_r3383355676
- integral-xyz/fms-frontend#1757 [gemini-code-assist] To further improve discoverability (which is the core goal of this PR), consider adding search synonyms for the **Manual** categorization option, such as 'manually', 'user', 'human
  - src/components/business-events/events-filter-provider.tsx; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1757#discussion_r3383063781
- integral-xyz/fms-frontend#1756 [kilo-code] [SUGGESTION]:\*\* Non-standard MIME type image/tif
  - src/components/orders/order-wizard/steps/upload-file-step.tsx; category=maintainability; evidence=https://github.com/integral-xyz/fms-frontend/pull/1756#discussion_r3382644832

## Recommended J-bot Hit Regression Seeds: integral-xyz/fms

- integral-xyz/fms#3064 [jbot-review] Missing local eval coverage for user-visible behavior change (TECHNICAL_STANDARDS.md §18)
  - apps/core-ledger/src/ai-chat/agents/chat.agent.ts:1348; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3399496005
- integral-xyz/fms#3064 [jbot-review] Missing focused unit test for buildCounterpartyDedupDirective prompt change
  - apps/core-ledger/src/ai-chat/agents/chat.agent.ts; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3399778350
- integral-xyz/fms#3064 [jbot-review] Eval case prior turn content does not trigger review intent detection
  - apps/core-ledger/test/evals/ai-chat/cases/agent-preview.eval-cases.ts:2346; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3400112855
- integral-xyz/fms#3064 [jbot-review] RedisComputationArtifactStorageBackend.saveArtifact has a read-modify-write race on the index
  - apps/core-ledger/src/ai-chat/computation/computation-artifact-storage.backend.ts:228; category=bug; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3400112863
- integral-xyz/fms#3064 [jbot-review] Catch clause uses implicit any instead of unknown
  - libs/shared/src/redis/redis.service.ts; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3400209173
- integral-xyz/fms#3064 [jbot-review] catch block calls unwatch() which can throw and mask the original error
  - libs/shared/src/redis/redis.service.ts:70; category=bug; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3405640517
- integral-xyz/fms#3064 [jbot-review] nit (test, high)\*\* — Mock exec() return format does not match ioredis contract
  - libs/shared/src/redis/redis.service.spec.ts:17; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3405640522
- integral-xyz/fms#3064 [jbot-review] listArtifactsForConversation triggers unconditional WATCH/MULTI/SET via updateIndex
  - apps/core-ledger/src/ai-chat/computation/computation-artifact-storage.backend.ts:265; category=performance; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3405640516
- integral-xyz/fms#3064 [jbot-review] Remove unreachable counterpartyDuplicateSummary spreading in compact and default branches
  - apps/core-ledger/src/ai-chat/agents/chat-agent-python-tools.ts; category=bug; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3405697907
- integral-xyz/fms#3064 [jbot-review] handleCounterpartyDuplicateReviewFastPath loses page progress when tool execution throws
  - apps/core-ledger/src/ai-chat/agents/chat.agent.ts; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3405697902
- integral-xyz/fms#3064 [jbot-review] exec result not checked for individual command errors in updateJson and setJsonAndUpdateJson
  - libs/shared/src/redis/redis.service.ts; category=performance; evidence=https://github.com/integral-xyz/fms/pull/3064#discussion_r3405842873
- integral-xyz/fms#3062 [jbot-review] stableStringify silently merges Date, Map, Set as empty objects due to JSON.stringify handling
  - apps/core-ledger/src/ai-chat/agents/chat-agent-loop-guard.util.ts:38; category=bug; evidence=https://github.com/integral-xyz/fms/pull/3062#discussion_r3399069384

## Recommended J-bot Hit Regression Seeds: integral-xyz/fms-frontend

- integral-xyz/fms-frontend#1775 [jbot-review] Duplicate-only paste silently discards typed draft text
  - src/components/ui/email-recipient-input.tsx:107; category=bug; evidence=https://github.com/integral-xyz/fms-frontend/pull/1775#discussion_r3399343711
- integral-xyz/fms-frontend#1774 [jbot-review] Test description mentions idle but does not assert it
  - src/components/ai-agent/turn-status.test.ts; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1774#discussion_r3399135963
- integral-xyz/fms-frontend#1766 [jbot-review] ErrorBoundary resetKey uses stable Control reference so it never retries within a session
  - src/components/orders/order-wizard/invoice-preview-sheet.tsx; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1766#discussion_r3389161156
- integral-xyz/fms-frontend#1766 [jbot-review] Missing cleanup in onFormReady effect keeps stale control reference in wizard context
  - src/components/orders/order-details-form.tsx:589; category=bug; evidence=https://github.com/integral-xyz/fms-frontend/pull/1766#discussion_r3389161138
- integral-xyz/fms-frontend#1766 [jbot-review] Missing cleanup in onFormReady effect keeps stale control reference in wizard context
  - src/components/orders/order-details-form.tsx:588; category=bug; evidence=https://github.com/integral-xyz/fms-frontend/pull/1766#discussion_r3389191574
- integral-xyz/fms-frontend#1761 [jbot-review] Edge case: checkbox title preserved only when title is truthy
  - src/utils/filters.ts:667; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1761#discussion_r3383960910
- integral-xyz/fms-frontend#1754 [jbot-review] Silently drops selected values whose hydration fails from the command list
  - src/components/filter-bar/async-options.ts:49; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1754#discussion_r3381980745
- integral-xyz/fms-frontend#1753 [jbot-review] parentId sentinel value could collide with a real account ID
  - src/components/chart-of-accounts/edit-coa/index.tsx:66; category=bug; evidence=https://github.com/integral-xyz/fms-frontend/pull/1753#discussion_r3381951374
- integral-xyz/fms-frontend#1753 [jbot-review] Stale closure in onSuccess when switching edit targets during in-flight mutation
  - src/components/chart-of-accounts/edit-coa/index.tsx:120; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1753#discussion_r3382431824
- integral-xyz/fms-frontend#1751 [jbot-review] setState side effects inside another setState updater
  - src/components/filter-bar/context.tsx; category=bug; evidence=https://github.com/integral-xyz/fms-frontend/pull/1751#discussion_r3377537418
- integral-xyz/fms-frontend#1751 [jbot-review] Implicit protocol linking filterId to condition-rewrite heuristic is fragile
  - src/utils/filters.ts; category=bug; evidence=https://github.com/integral-xyz/fms-frontend/pull/1751#discussion_r3377537420
- integral-xyz/fms-frontend#1751 [jbot-review] displayedFilterValidationErrors can derive stale errors when suppressFilterPersistence toggles
  - src/components/filter-bar/context.tsx; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1751#discussion_r3377537423

## False-positive / Negative Seeds: integral-xyz/fms

- integral-xyz/fms#3062 [gemini-code-assist] The stopWhen option in Vercel AI SDK's streamText expects a single callback function of type (step: StepResult) => boolean. Passing an array [stepCountIs(maxSteps), ...] will cause
  - apps/core-ledger/src/ai-chat/agents/chat.agent.ts:930; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3062#discussion_r3399047692
  - rejection=Not applied — false positive. In `ai@6.0.191`, `streamText`'s `stopWhen` is typed `StopCondition | Array<StopCondition>` and the runtime normalizes it with `asArray(stopWhen)`, so passing an array is supported (and `tsc` passes on this code). The suggested single-callback rewrite is also incorrect: `StopCondition` is `(options: { steps }) => boolean`, not `(step) => boolean`.
- integral-xyz/fms#3062 [jbot-review] AbortSignal.timeout created by resolveStreamAbortSignal runs to completion even after stream finishes
  - apps/core-ledger/src/ai-chat/agents/chat.agent.ts; category=maintainability; evidence=https://github.com/integral-xyz/fms/pull/3062#discussion_r3399069379
  - rejection=Not applied — `AbortSignal.timeout` is unref'd, so a pending timer does not keep the event loop alive (verified: a process with a 10s `AbortSignal.timeout` exits in ~1ms). It also self-clears at the deadline (≤180s), so there is no unbounded accumulation in a long-lived server.
- integral-xyz/fms#3062 [jbot-review] Key-ordering test uses identical args with different insertion order, which is itself order-dependent
  - apps/core-ledger/src/ai-chat/agents/chat-agent-loop-guard.util.spec.ts:42; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3062#discussion_r3399069391
  - rejection=Not applied — the test deliberately verifies that two objects with different key _insertion_ order produce the same key, i.e. that `stableStringify` is order-independent. That ordering difference is the behavior under test, not an accidental dependency.
- integral-xyz/fms#3057 [jbot-review] Hand-authored migration bypasses generated-first policy and escalation requirement
  - apps/core-ledger/database/migrations/Migration20260611051417.ts:1; category=security; evidence=https://github.com/integral-xyz/fms/pull/3057#discussion_r3397050120
  - rejection=Not applied — this is the intended exception, not an oversight. `CREATE EXTENSION` cannot be expressed through MikroORM entity metadata, so `pnpm migrate:create core-ledger` generates nothing for it. It follows the existing precedent of the `vector` extension migration (`Migration20250716200813`), adds no table structure, and the file documents the rationale inline (satisfying the "say so explicit
- integral-xyz/fms#3056 [gemini-code-assist] If both entity.displayName and entity.officialName are null or undefined, getEntityName will return undefined (or null), which violates the string return type at runtime. Use nulli
  - apps/core-ledger/src/orders/order-email/order-email-content.builder.ts:42; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3396924854
  - rejection=Leaving this as-is intentionally. `OrgEntityModel.officialName` is required/non-null, so `getEntityName` cannot fall through to `undefined` under the current model contract. The `||` fallback is also useful here because an empty `displayName` should still fall back to `officialName` instead of producing `from ` in the subject/body.
- integral-xyz/fms#3056 [cursor-bugbot] Failure logging aborts batch
  - apps/core-ledger/src/orders/orders.service.ts:2478; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3397895905
  - rejection=Resolved as stale. The current implementation no longer records FAILED order_email_sends rows in the Postmark catch path. Provider failure now throws immediately and only successful sends are persisted, so aborting after a failed provider send is intentional V1 behavior.
- integral-xyz/fms#3056 [qodo] 1\. New writeorderemailsendrepository in core-ledger-shared 📘 Rule violation ⌂ Architecture
  - libs/core-ledger-shared/src/order/repository/write-order-email-send-repository.ts:1; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3398007565
  - rejection=Resolved as non-actionable for this PR. Orders persistence is still owned by core-ledger-shared in the current hybrid architecture, and this repository is a persistence-only companion to the existing order read/write repositories. Moving only order_email_sends into libs/modules would split order persistence before the Orders domain is extracted.
- integral-xyz/fms#3056 [qodo] 4\. Postmark timeout units wrong 🐞 Bug ☼ Reliability
  - apps/core-ledger/src/orders/order-email/postmark-email.client.ts:7; category=test-gap; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3398007576
  - rejection=Resolved as non-actionable. postmark@4.x treats the SDK timeout option as seconds and converts it to milliseconds internally in HttpClient, so the existing POSTMARK_SEND_TIMEOUT_SECONDS = 15 value configures a 15 second timeout, not 15ms.
- integral-xyz/fms#3056 [jbot-review] Audit log write failure silently swallowed
  - apps/core-ledger/src/orders/orders.service.ts:2533; category=bug; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3398322757
  - rejection=Yeap this is intentional. We don't want our an audit log to throw
- integral-xyz/fms#3056 [qodo] 1\. order-email-send model imports @app 📘 Rule violation ⌂ Architecture
  - libs/core-ledger-shared/src/order/model/order-email-send.ts:4; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3056#discussion_r3398895825
  - rejection=This is a false positive. In this repo `@app/shared/*` resolves to `libs/shared/src/*` via `tsconfig.json`, not to `apps/*`. So this is a `libs/core-ledger-shared -> libs/shared` import, which is an allowed and established pattern across the repo.
- integral-xyz/fms#3055 [gemini-code-assist] If result.failures is undefined (which is common for passing grader results), flatMap will return undefined elements in the array. This will cause a runtime TypeError when .filter
  - apps/core-ledger/test/evals/ai-chat/graders/compound-grader.ts:49; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3055#discussion_r3393099659
  - rejection=**Not applied.** `AiChatEvalGraderResult.failures` is typed `AiChatEvalFailure[]` (non-optional) and every grader constructs it as an array, so it cannot be `undefined` at runtime — TypeScript would reject a result that omitted it. Adding `?? []` would be defensive code against a type-impossible state, which this repo's type-rigor conventions discourage.
- integral-xyz/fms#3055 [gemini-code-assist] If g.failures is undefined, flatMap will include undefined in the returned array, causing a runtime TypeError when accessing f.severity. Use nullish coalescing to default to an emp
  - apps/core-ledger/test/evals/ai-chat/harness/run-ai-chat-eval-suite.ts; category=contract; evidence=https://github.com/integral-xyz/fms/pull/3055#discussion_r3393099662
  - rejection=**Not applied.** Same as the compound-grader thread: `failures` is `AiChatEvalFailure[]` (non-optional) on every `AiChatEvalGraderResult`, so `g.failures` is always an array and cannot inject `undefined` into the `flatMap`. `?? []` would guard a state the type system already rules out.

## False-positive / Negative Seeds: integral-xyz/fms-frontend

- integral-xyz/fms-frontend#1780 [gemini-code-assist] To adhere to defensive programming practices, use optional chaining when accessing currentEntity.reportingAssetId to prevent potential runtime TypeErrors if currentEntity is ever u
  - src/hooks/useGlobalContext.tsx:94; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1780#discussion_r3405165350
  - rejection=Leaving this as-is intentionally. `currentEntity` is asserted immediately above, and `GlobalContextValue` promises a resolved entity. Optional chaining here would mask a broken authenticated/entity-scope invariant and allow a partial global context instead of failing loudly.
- integral-xyz/fms-frontend#1780 [gemini-code-assist] To adhere to defensive programming practices, use optional chaining when accessing userDetails.user to prevent potential runtime TypeErrors if userDetails is ever undefined.
  - src/hooks/useGlobalContext.tsx:107; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1780#discussion_r3405165377
  - rejection=Leaving this as-is for the same reason. `userDetails` is asserted before constructing the context value, and `GlobalContextValue.user` is intentionally a required `UserDto`. Making this optional would leak an impossible auth-shell failure state to every consumer.
- integral-xyz/fms-frontend#1774 [gemini-code-assist] The test suite should cover all standard lifecycle states of the Vercel AI SDK ChatStatus union. Adding 'idle' (which is the default resting state in many versions of the SDK) ensu
  - src/components/ai-agent/turn-status.test.ts; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1774#discussion_r3399100830
  - rejection=Not applied as written — `'idle'` is not part of `ChatStatus` in `ai@6.0.195` (`'submitted' | 'streaming' | 'ready' | 'error'`), so asserting `isAgentTurnInFlight('idle')` would fail `tsc`. Fixed the real mismatch instead: the test description now references the resting (`ready`) and error states it actually asserts.
- integral-xyz/fms-frontend#1774 [jbot-review] Test description mentions idle but does not assert it
  - src/components/ai-agent/turn-status.test.ts; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1774#discussion_r3399135963
  - rejection=Not applied as written — `'idle'` is not part of `ChatStatus` in `ai@6.0.195` (`'submitted' | 'streaming' | 'ready' | 'error'`), so asserting `isAgentTurnInFlight('idle')` would fail `tsc`. Fixed the real mismatch instead: the test description now references the resting (`ready`) and error states it actually asserts.
- integral-xyz/fms-frontend#1761 [jbot-review] Edge case: checkbox title preserved only when title is truthy
  - src/utils/filters.ts:667; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1761#discussion_r3383960910
  - rejection=This one is stale now: the latest branch uses `item?.title ?? value.title ?? value.value`, and the test suite includes a regression case that preserves an intentional empty title. Preserving `'0'` and whitespace-only strings is also intentional because they are explicit string labels, not missing values.
- integral-xyz/fms-frontend#1756 [jbot-review] No test coverage for file-rejection toast or retry/clear workflows
  - src/api/**tests**/orders.test.ts:1; category=test-gap; evidence=https://github.com/integral-xyz/fms-frontend/pull/1756#discussion_r3382665628
  - rejection=Not applied — this is a non-blocking P3, and adding component-level wizard/dropzone tests would require a heavier harness than this targeted upload transport fix warrants. The upload API path remains covered by focused hook tests plus typecheck/lint.
- integral-xyz/fms-frontend#1753 [gemini-code-assist] Passing autoFocus={false} to FormItem and FormControl is invalid as these are layout components (typically rendering div elements) and do not support the autoFocus attribute. This
  - src/components/chart-of-accounts/edit-coa/index.tsx; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1753#discussion_r3381622639
  - rejection=Resolved in `bd8d290`: removed the invalid `autoFocus={false}` props from `FormItem` and `FormControl`. I did not add the suggested `onOpenAutoFocus` because this dialog uses our current Base UI wrapper rather than that Radix-style prop; the DOM warning source was the layout props themselves.
- integral-xyz/fms-frontend#1753 [codex-review] Keep the edit action visible on keyboard focus
  - src/components/chart-of-accounts/chart-account-table/index.tsx:155; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1753#discussion_r3382375234
  - rejection=Leaving this intentional for this table. The chart-of-accounts grid is not opting into the shared row-focus/navigation contract; adding `focusable` just to reveal this secondary hover affordance would change row focus behavior across the table. We are keeping `showOnRowHover` as a pointer-hover affordance here and not making a code change for this thread.
- integral-xyz/fms-frontend#1751 [cursor-bugbot] Condition change drops opposite bound
  - src/components/filter-bar/context.tsx; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1751#discussion_r3377602553
  - rejection=Not applied: the current behavior intentionally honors the edited chip and keeps one numeric filter per condition. Keeping both bounds after changing `gte` to `lte` would require duplicate `lte` filters, which the filter/API contract does not support.
- integral-xyz/fms-frontend#1751 [cursor-bugbot] Draft edits invisible outside FilterBar
  - src/components/filter-bar/context.tsx; category=contract; evidence=https://github.com/integral-xyz/fms-frontend/pull/1751#discussion_r3381844895
  - rejection=Not applied: draft filters are intentionally only rendered by FilterBar. Downstream consumers read applied filters so invalid drafts cannot affect saved views, exports, or API params; the chip itself still shows the validation error and can be cleared.
- integral-xyz/fms-frontend#1751 [human] same here - let's keep validation scoped to the actual input. i.e: Let's not allow adding invalid values to our filters & keep the main context lean
  - src/components/filter-bar/context.tsx; category=maintainability; evidence=https://github.com/integral-xyz/fms-frontend/pull/1751#discussion_r3381894308
  - rejection=**P2** - I agree this should stay scoped to the range input. `FilterNumberRangeInputs` already owns submit/parse, but it still commits `gte > lte` to provider draft state, which forces global `draftFilters`, validation errors, and an applied/draft split for one input invalid state. That weakens the established filter seam because `useFilterBar().filters` means applied state while the visible bar c
- integral-xyz/fms-frontend#1749 [kilo-code] [WARNING]:\*\* weight="strong" prop was dropped when wrapping the completed-by name in Tooltip.
  - src/components/bank-reconciliations/reconciliation-workspace-footer.tsx; category=maintainability; evidence=https://github.com/integral-xyz/fms-frontend/pull/1749#discussion_r3376359284
  - rejection=Leaving this as-is — dropping `weight="strong"` on the completed-by name was intentional.

## Clean Candidates

- integral-xyz/fms#3038 feat(business-events): expose `categorizedBy.in` filter on events list query
  - https://github.com/integral-xyz/fms/pull/3038
- integral-xyz/fms#3029 Add auto object matching settings
  - https://github.com/integral-xyz/fms/pull/3029
- integral-xyz/fms-frontend#1784 fix(bank-reconciliation): status-column actions no longer open the drawer
  - https://github.com/integral-xyz/fms-frontend/pull/1784
- integral-xyz/fms-frontend#1781 feat(bank-reconciliation): rename Matched section to Auto-matched + blue auto tags
  - https://github.com/integral-xyz/fms-frontend/pull/1781
- integral-xyz/fms-frontend#1777 Protect from Clickjacking
  - https://github.com/integral-xyz/fms-frontend/pull/1777
- integral-xyz/fms-frontend#1771 feat(bank-reconciliation): add Auto-explained status tag
  - https://github.com/integral-xyz/fms-frontend/pull/1771
- integral-xyz/fms-frontend#1770 docs(bank-reconciliation): mark R-EXPLAINED-CHANGE-DEADEND resolved by fms #3039
  - https://github.com/integral-xyz/fms-frontend/pull/1770

## Promotion Rules

- Use `recommendedUse=must-find-jbot-miss` and `recommendedUse=jbot-hit-regression` entries as positive labels only after deduping related comments within the same PR.
- Prefer correctness, data-integrity, contract, security, and high-signal test-gap findings over style or naming suggestions.
- Keep `exhaustive: false` for real bug PRs unless the PR was manually audited.
- Use clean candidates as `exhaustive: true` only after a quick manual check that no material review findings were present.
- Keep false-positive candidates outside `expected-findings.json` until the scorer supports negative labels.
