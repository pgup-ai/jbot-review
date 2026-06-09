<!-- context7 -->

Use the `ctx7` CLI to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Context7 Steps

1. Resolve library: `npx ctx7@latest library <name> "<user's question>"` -- use the official library name with proper punctuation (e.g., "Next.js" not "nextjs", "Customer.io" not "customerio", "Three.js" not "threejs").
2. Pick the best match (ID format: `/org/project`) by exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results do not look right, try alternate names or queries.
3. Fetch docs: `npx ctx7@latest docs <libraryId> "<user's question>"`.
4. Answer using the fetched documentation.

You MUST call `library` first to get a valid ID unless the user provides one directly in `/org/project` format. Use the user's full question as the query; specific and detailed queries return better results than vague single words. Do not run more than 3 commands per question. Do not include sensitive information (API keys, passwords, credentials) in queries.

For version-specific docs, use `/org/project/version` from the `library` output (e.g., `/vercel/next.js/v14.3.0`).

If a command fails with a quota error, inform the user and suggest `npx ctx7@latest login` or setting `CONTEXT7_API_KEY` env var for higher limits. Do not silently fall back to training data.

Run Context7 CLI requests outside Codex's default sandbox. If a Context7 CLI command fails with DNS or network errors such as ENOTFOUND, host resolution failures, or fetch failed, rerun it outside the sandbox instead of retrying inside the sandbox.

<!-- context7 -->

## Review MCP Stack

Keep the review stack tight. Use MCPs only when they provide a more authoritative source of truth than local code inspection.

### GitHub MCP

Use GitHub MCP as the primary live-state source for PR review workflows. Fetch PR review threads, flat issue comments, review submissions, commit checks, workflow runs, job steps, and logs before drawing conclusions about the current PR state.

When fixing or validating review feedback, compare the current diff against the live GitHub state instead of relying only on local files. Re-query unresolved review threads after pushes or replies, and stop based on the live thread state.

### Context7

Use Context7 when a change adds or modifies usage of an external API, SDK, framework, CLI, or cloud service such as OpenAI, Anthropic, GitHub Actions, or Octokit. Treat it as a docs verifier for current API contracts, request/response shapes, auth expectations, deprecations, and version-specific behavior.

Do not use Context7 as a general reviewer. If the code change does not touch an external contract, prefer local code inspection, tests, and repository patterns.

### GitHub Actions Logs

For dogfooding and failed review runs, inspect the exact workflow run, job steps, and job logs before deciding whether the issue is a code regression, provider/API failure, auth or configuration problem, or transient infrastructure failure.

Do not call a dogfood run validated from local checks alone when the posted bot comment, check result, or workflow logs are the actual validation surface.
