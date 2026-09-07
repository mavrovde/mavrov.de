---
name: lessons-learned
description: >-
  The committed "do-not-repeat" knowledge base for mavrov.de — hard-won operational lessons
  and footguns that unit tests and PR CI do NOT catch. Consult BEFORE touching the frontend
  SSR/HTTP/change-detection path, running backend pytest locally, adding a GitHub Actions
  cache, deciding a release SemVer bump, running destructive local/infra commands, writing any
  test or CI job that touches an external service, or shipping a release. Encodes the zoneless-CD +
  SSR-HttpBackend traps, pytest local-DB isolation, the GHA multi-GB-cache net-negative,
  SemVer-by-content, the green-pipeline release rule, the no-irreversible-local-destruction
  guardrail, the STRICT no-real-API-keys/paid-credentials-in-tests-or-CI rule, and the mandatory
  independent-review-gate-before-merge rule, the bisect-gate-failures-against-a-clean-main-build
  triage method, the @angular/* exact-peer single-pass-update/lockfile-regeneration rule, the
  mutation-check-your-tests discipline, the run-the-suite-as-CI-runs-it (`-n auto`) rule, the
  verify-that-gates-actually-gate habit, and the repo-rename/GHCR-package-visibility trap.
  Grep it or load it when a task matches — it exists so
  fresh contexts and teammates don't re-research answers we already have.
---

# Lessons learned — mavrov.de (do not repeat)

This is the **in-repo** home for durable, hard-won lessons — the things that cost us a revert, a red
pipeline, or a wasted research loop. It complements `CLAUDE.md` (the rules) with the *why* and the
concrete reproduction. **Sync discipline:** when you learn a new durable lesson, add it here as part
of the change — do not leave it only in a machine-local private memory, or it evaporates between
contexts and contributors.

Each entry: **the trap → why it bites → how to apply.** Most of these are invisible to unit tests and
PR CI (which runs only CodeQL) — they only surface in the full Docker E2E or in production.

---

## 1. BOTH apps are zoneless — async property mutations don't repaint

**Trap.** **Neither** `frontend/projects/public` **nor** `frontend/projects/admin` bundles
`zone.js` at runtime — `angular.json` has no `polyfills` entry for either, and zone.js is only in
`test-setup.ts` for unit tests. (This entry said "the public app" until #276: the admin app was
excluded from the cd-safety lint on that false premise, and the widened lint immediately found
**five** frozen-UI bugs in admin, plus a sixth the lint cannot see — see below.) A component that mutates a
**plain property** inside a `subscribe` / `setInterval` / `setTimeout` / `async`-`fetch` callback will
**silently never repaint**. This froze the footer at `BE: vUnknown` / `UPTIME 00:00:00` (#94) even
though the `/stats/public` fetch returned 200.

**Why it bites.** Unit tests DO bundle zone.js, so change detection fires there and the test passes —
the freeze only appears in the browser / Docker E2E.

**How to apply.** For any public component that updates on a timer or a `subscribe`, repaint
explicitly: inject `ChangeDetectorRef` and call `markForCheck()` after each async mutation, **or** use
signals, **or** render an `Observable` via the `async` pipe. The app is committed to zoneless via
`provideZonelessChangeDetection()` in `app.config.ts` (#105) — the async-mutation rule still holds.
Grep pattern to audit: `subscribe(` / `setInterval(` / `setTimeout(` in **either** app that assign
`this.<prop> =` without a following `markForCheck()`.

**The lint does NOT follow `await`** (its documented #234 gap), so an `async` method that assigns
after an await is invisible to it. #290's review found exactly that live in
`admin-linkedin.component.ts`: `checkLoginStatus()` set `isLoggedIn = true` and the banner kept
reading "🔴 Not Connected" with the login form still up. Three layers missed it — the lint by that
gap, the unit specs because they bundle zone.js, and the e2e spec because it always mocked the
initial status as logged-out. When you audit, read the `async` methods by hand; a green lint is not
a clean bill of health here.

## 2. SSR relative→absolute URL rewrite belongs in an `HttpBackend`, delegating to `HttpXhrBackend`

**Trap.** Doing the SSR URL rewrite in an `HttpInterceptorFn` runs it *before* Angular's
transfer-cache interceptor, so the server keys the transfer cache on the *rewritten* absolute URL
while the browser keys it on the *relative* URL → keys never match → the browser re-fetches every
request on hydration (blog `/blog/:slug` "flash to home", #25).

**Why it bites — and the specific landmine.** Fix by doing the rewrite in a custom `HttpBackend`
(terminal in the chain, runs *after* transfer-cache keying): `interceptors/ssr-http-backend.ts`
(`SsrHttpBackend`), wired via `provideHttpClient()` + `{provide: HttpBackend, useClass: SsrHttpBackend}`.
**CRITICAL: delegate to `HttpXhrBackend`, NOT `FetchBackend`.** The app has always used XHR on both
platforms. The reverted #84 delegated to `FetchBackend` and *deterministically* broke the browser's
`GET /api/app/stats/public` (`net::ERR_FAILED`), blocking the deploy across 4 attempts; only reverting
greened it. `HttpXhrBackend` keeps the browser byte-identical to the baseline.

**How to apply.** Never force the browser onto a different HTTP backend without proving it in the E2E.

## 3. SSR / HTTP / transfer-cache changes MUST be E2E-validated before merge

**Trap.** PR CI here runs **only CodeQL** — the real test suite + Docker E2E run in `deploy.yml` on
push to `main`. A browser-only regression sails through PR review and 100% unit coverage and only
surfaces *post-merge* on the prod deploy.

**How to apply.** For any change touching `HttpBackend` / `provideHttpClient` / interceptors /
transfer-cache / SSR hydration, run the full Docker E2E locally (`./verify_all.sh` or a targeted stack
repro) **before** merging. `frontend-dev` and `pr-reviewer` should explicitly ask "was this
E2E-validated?" for such changes. When you change a user-visible behavior, grep **all** e2e specs for
the OLD assertion (the #108→#110 stale-test fix-forward). Fix-forward on red: revert the offending
change to ship the rest, then redo it properly (never leave `main` red).

## 4. Backend pytest local DB — isolation rules (or it hangs / wipes the dev DB)

- **Always** export `TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@127.0.0.1:5433/test_mavrov`
  and `HIREFOLIO_GEMINI_API_KEY=""` before `./venv/bin/pytest`. This is exactly what
  `.claude/hooks/pre-push-tests.sh` sets. Without it, `conftest.get_test_engine()` falls back to the
  **live `mavrov` dev DB**, and the per-test `Base.metadata.drop_all` **hangs** on the running backend
  container's table locks (and would wipe the dev DB if it didn't block).
- The `test_mavrov` DB lives in the `mavrovde-db-1` container. Create if missing:
  `docker exec mavrovde-db-1 psql -U postgres -p 5433 -c "CREATE DATABASE test_mavrov"`.
- **2026-09-06 addendum — the rule is now ENFORCED IN CODE, because documentation did not stop
  the recurrence.** This exact lesson was on record, and an agent still ran ad-hoc
  `./venv/bin/pytest` without the export during the #65/#69 work: single-process runs silently
  drop/created tables on the dev `mavrov` DB all day (the parallel `-n auto` runs were spared only
  because the xdist worker-suffix DBs didn't exist as `mavrov_gw0`), and it only became VISIBLE
  when the integration stack's backend held a table lock and the drop hung — then every retried
  run stacked into zombie pytest processes behind the same lock. `backend/conftest.py` now
  refuses (`pytest.exit`) any resolved DB whose name doesn't start with `test_` (#260/#261).
  Meta-lesson: when a footgun recurs despite being documented, the fix is a GUARD, not a louder
  paragraph — same class as items 18 (gates must gate) and the #142/#177 startup refusals.
- **Never run two full pytest suites against `test_mavrov` at once** (e.g. a manual run while the
  pre-push hook fires). Both do `drop_all`/`create_all` per test on the same DB and clobber each other
  → dozens of spurious `InvalidRequestError: Could not refresh instance` / count-mismatch failures.
  Serialize them.
- `pyproject.toml` addopts already do `--cov=app`. Passing **extra** `--cov=app.api.foo` on the CLI can
  **segfault** (coverage C-tracer + asyncpg/greenlet). Use the plain full-suite run for the real
  coverage number; `--no-cov` for quick pass/fail iteration. Full suite ≈ 2.5 min; `pytest -q | tail`
  buffers until exit — use `-v` or write to a file for live progress.

## 5. GitHub Actions cache for multi-GB Docker artifacts is usually net-NEGATIVE

**Trap.** Caching large (multi-GB) base images or model weights via `actions/cache` does **not** speed
this pipeline up — the cache *transfer* (download tarball + `docker load`/extract) costs about as much
as re-pulling from the registry, and it eats the repo's 10 GB cache budget.

**Measured (v1.8.0 cycle).** #78 Ollama model-weights cache (~3.6 GB): +53s restore vs ~11s saved →
E2E job ~56s **slower**. #72/#76 base-image cache (~2.79 GB): ~30s saving at best (~2% of a 25-min
pipeline). The real bottleneck is the **sequential critical path**, not downloads: Backend Tests ~5m →
Build Backend Image ~5m → E2E ~8–9m → Proxy Verify ~5m. Real levers (issue #91): dedupe the two stack
bring-ups, `pytest-xdist -n auto`, and slim the backend image (done in #91 — dropping unused Node.js +
Playwright + Chromium cut ~500MB and the dominant build step).

**How to apply.** Before adding an `actions/cache` for a big Docker blob, estimate transfer vs
re-pull; prefer registry (CDN-backed) pulls. **Always MEASURE** before/after on real runs
(`gh api .../jobs` timings) — never assume a cache helps.

A corollary found in #134: **a cache placed downstream of its consumer is dead weight** — the E2E
job restored a multi-GB base-image cache *after* `docker compose up -d` had already pulled every
image, so it never saved a pull and cost 2 min per run (10 min on a miss). Audit step *ordering*,
not just hit rate.

## 6. Release SemVer bump is decided BY CONTENT of `[Unreleased]` — never by reflex

Stop at the first that matches:
- **MAJOR `X.0.0`** — any backward-**incompatible** change (removed/renamed API field or endpoint,
  non-additive DB migration, changed default/auth/config-key meaning). Signal: `feat!:` / `BREAKING
  CHANGE:`. Rare; confirm first.
- **MINOR `x.Y.0`** — ONLY if `[Unreleased]` has an `### Added` describing genuinely new,
  backward-compatible functionality (new endpoint/page/capability/feature-flag). Signal: `feat:`.
- **PATCH `x.y.Z`** (the maintenance default) — everything else: dependency bumps (even many at once),
  `### Fixed`, perf, refactors, internal tooling/CI, docs, additive-only migrations. Signals:
  `fix:`/`chore:`/`refactor:`/`perf:`/`docs:`/`ci:`.

**Rule of thumb:** only `### Changed`/`### Fixed`, no `### Added` feature → **patch**. Internal
AI-config/tooling/docs changes are patch-level (do not file them under `### Added`, which would
mislead the bump). Calibration: deps-only sweeps = patch (once wrongly defaulted to a minor — corrected).

## 7. A release is confirmed only when `deploy.yml` is GREEN end-to-end

Publishing is gated behind E2E/smoke, so a red pipeline ships nothing. After merging to `main`,
actively babysit the run (`gh run view <id> --json ... jobs`), surface each job result, and fix root
causes on red (fix-forward, never silent rollback). Only then tag `vX.Y.Z` (a tag push does not
re-trigger the branch pipeline). **Check GitHub security reports every release** — CodeQL
(`gh api .../code-scanning/alerts`) + Dependabot (`.../dependabot/alerts`) — triage each and note
pre-existing vs introduced. Caveat: a green publish updates the host only when the secrets-gated
`deploy` rollout job actually rolled (#175). **With `DEPLOY_*` unset the job does NOT show up as
`skipped` — it runs and reports `success` as a guarded no-op**, logging the notice
`DEPLOY_HOST/DEPLOY_USER/DEPLOY_SSH_KEY not configured — images are published but NOT rolled onto a
host`. So the job *status* is a false positive here: read the job's **log** (or probe the live
footer / `curl https://mavrov.de`) before ever saying "prod is on vX.Y.Z" ("published ≠ live", #112).
Confirmed again at the v1.10.0 release: run 33326238612 was 21/21 green with the rollout job
`success`, while live prod still served v1.2.27.

## 8. No irreversible LOCAL/infra destruction without explicit authorization

Never `docker volume rm`/`prune`, `docker compose down -v`/`--volumes`, `docker system prune`,
`docker image prune -a`, DROP/recreate a **non-`test_*`** database, or a recursive `rm` of a data dir / volume
mount **without explicit user authorization naming the resource** — a backup is **not** consent. Only
`test_*` DBs may be dropped autonomously. Origin: the #91 incident where a subagent ran
`docker volume rm mavrovde_open-webui_data` on its own initiative. Enforced by CLAUDE.md **rule 9** and
the `.claude/hooks/guard-destructive.sh` PreToolUse hook (bypass one authorized command with
`GUARD_DESTRUCTIVE=0` prefixed). Prefer non-destructive paths (bump the image to match the volume
schema, migrate, or leave it); if a workaround needs destroying local state, STOP and ask.

## 9. Deliver via PR; run the FULL suite before pushing; merge only when green

Never push feature work directly to `main` — branch → PR → merge (the merge is the sanctioned prod
trigger). Before pushing run the full local round (backend ruff/format + mypy + pytest **and** all
frontend project tests **and**, for SSR/HTTP/E2E-affecting changes, the Docker E2E). The shared
pre-push hook (`.claude/hooks/pre-push-tests.sh`) enforces docs + backend + frontend and self-gates
(only fires on a real `git push` invocation — command-position aware since #237; quoted prose
mentioning a push is data). When all gates are green and there is no explicit hold order, merge/deploy
without stopping to ask.

## 10. NEVER use real API keys / paid credentials in tests or CI (strictly forbidden)

**Trap.** A real credential for a paid, metered, or rate-limited service (any LLM/API that bills or
burns quota per call) wired into an automated test or a CI test stack fires on **every pipeline run** —
producing silent, unbounded, recurring cost and quota exhaustion, and exposing the credential to CI
logs. It hides easily: one test spec left unmocked, or a workflow injecting `${{ secrets.* }}` into a
test job's env "so the feature works", turns green CI into a money leak.

**How to apply (both layers).**
1. **Mock** the paid call at the test boundary — `page.route` in Playwright, monkeypatch/fake in
   pytest — so the request never leaves the test.
2. **Deny the credential** to every test/CI job: inject an **empty/dummy** key so the code path takes
   a **free local fallback** (e.g. Ollama here) instead of the paid API. In CI, pass `KEY: ""`, never
   `${{ secrets.* }}`. Real credentials belong **only** to the production runtime environment.
Before writing or running any test/CI path, verify it cannot reach a paid service with a live
credential. In review, treat a real paid-service secret in a test stack — or an unmocked paid-API
test — as a **blocker**. In this repo: `deploy.yml` passes `HIREFOLIO_GEMINI_API_KEY: ""` to the E2E stack (→
Ollama fallback) and the admin AI-suggestion specs mock `/posts/suggest-*`. This is **CLAUDE.md
rule 10**.

## 11. Every PR needs an INDEPENDENT pr-reviewer verdict before merge — no exceptions

**Trap.** Under time pressure it is tempting to merge on "green CI", "a dev agent (backend-dev/
frontend-dev) already validated it", "it's a trivial one-line CI/docs change", or "the user was
directing it in real time". **None of those is an independent review.** Merging without a posted
`pr-reviewer` verdict skips the two-party gate, leaves no audit trail, and lets plausible-but-wrong
changes through — exactly the class the reviewer exists to catch.

**How to apply.** A PR is mergeable only when **all gates are green AND a `pr-reviewer` APPROVE verdict
is posted to the PR**. This holds for EVERY PR with no carve-outs — hotfixes/emergencies, dependency
bumps, trivial/CI/docs changes, and user-directed changes. Urgent → the review is **expedited, not
skipped**. The implementing dev agent delivers the PR and does **not** merge; its own passing suite is
necessary but not sufficient. Every merged PR must carry a visible review comment. If one ever slips
through un-reviewed, post a **retrospective** review on the merged PR and fix-forward on any finding
(as was done for the four un-gated merges in the incident that produced this rule). This is **CLAUDE.md
rule 13**, enforced via the `pr-reviewer` agent.

---

## 12. Admin IP allowlist is meaningless without `real_ip` — and don't gate startup on the FULL `nginx -t`

**Trap.** In the containerized prod topology the admin subdomain sits behind a front proxy (1panel)
+ Docker NAT, so nginx sees the **Docker bridge gateway** as `$remote_addr` for *every* external
client. An `allow/deny` allowlist on `$remote_addr` therefore can't distinguish operators — and
flipping it to `deny all;` locks the owner out too (#86, split from #60, which is exactly why the
hardening was deferred once). The fix is nginx `real_ip`: `set_real_ip_from <trusted upstream CIDR>`
+ `real_ip_header X-Forwarded-For` + `real_ip_recursive on` (in the **http** context) so
`$remote_addr` becomes the real client IP *before* the allowlist runs. This only works if the front
proxy actually forwards the real client IP in that header and its egress falls inside the trusted
CIDR — **verify the proxy access logs show the real external IP**, not the gateway, before trusting
the allowlist. That runtime check can't be reproduced locally (needs the live front-proxy topology).

**Second trap (the one that bites at deploy time).** Don't add an entrypoint fail-safe that gates on
a **full-config** `nginx -t`. The rendered config's `proxy_pass http://backend:8000` upstreams
resolve **only inside the compose network**; a standalone `nginx -t` (or a startup DNS race) fails
with `host not found in upstream "backend"`, which has nothing to do with the allowlist. Under
`set -e` that can abort the entrypoint and **crash the proxy — taking the public site down too**, or
misattribute the failure and overwrite the allowlist. Validate **only your generated snippets, in
isolation**, with a throwaway minimal `nginx -t -c` config (an `http{}` including `real_ip.conf` + a
dummy `server{}` including `admin_allowlist.conf`), and keep the check non-aborting.

**How to apply.**
1. Generate `real_ip.conf` + `admin_allowlist.conf` at container start from env
   (`proxy/generate-admin-config.sh`: `TRUSTED_PROXY_CIDRS`, `REAL_IP_HEADER`, `ADMIN_ALLOWED_CIDRS`).
   **Validate every env entry against an IPv4/IPv6/CIDR regex** — an unvalidated value injects
   arbitrary nginx directives into the included file.
2. Ship **CLOSED**: empty `ADMIN_ALLOWED_CIDRS` → `deny all;` (loopback only), **never** a blanket
   `allow all;` as the default. Regex-valid ≠ nginx-valid (e.g. `999.999.999.999` passes `[0-9]{1,3}`
   but nginx rejects it) — so the isolated-`nginx -t` fail-safe reverts to the closed default and the
   real `exec nginx` still starts clean.
3. Give the owner a **break-glass** that never depends on their dynamic IP: loopback from on the box
   (`docker compose exec proxy wget … --header 'Host: admin.<domain>' https://127.0.0.1/`).
4. E2E hits `admin.localhost` through the bridge with **no** `X-Forwarded-For`, so `real_ip` can't
   recover a client — open the allowlist for the test run **only** via env
   (`docker-compose.e2e.yml` + `deploy.yml` set `ADMIN_ALLOWED_CIDRS=0.0.0.0/0`), never in the shipped
   default. Unit-test the generator deterministically (`proxy/test-generate-admin-config.sh`).

---

## 13. A failing local gate is NOT proof your change broke it — bisect against a clean `main` build first

**The trap (2026-08-29, the #170 dep sweep):** `./verify_all.sh` failed its proxy-route check
(`mavrov.de/admin/login` expected 200, got 404) right after the Angular/SSR bump — which
pattern-matches perfectly to "the SSR upgrade changed unmatched-route handling." It hadn't.
Building the frontend from an **unmodified `main` worktree with the committed lockfile**
(`git worktree add … main && npm ci && npm run build:public`, serve `dist/public/server/server.mjs`,
curl the route) reproduced the exact same 404: the check itself was stale, written before the
July-2026 admin/public workspace split when the admin SPA still lived at `/admin/*` inside the
public app.
1. Before root-causing a gate failure *inside your diff*, spend the ~5 minutes to reproduce it on
   a clean `main` build. If main fails too, you're fixing a latent gate bug, not your regression —
   different fix, different PR framing.
2. **Live prod behavior is NOT ground truth for a check while rollout is broken (#112):** the stale
   check "passed" against prod only because prod itself was running a months-stale pre-split image.
   A check validated only against a stale deployment validates nothing.
3. Local E2E details that cost time: the proxy's HTTPS is published on host port **10443**
   (`https://localhost:10443`, see `PROXY_SSL_PORT` in `verify_proxy_routes.py`) — plain
   `https://localhost/` curls give `000`. Express's default `Cannot GET /x` body = no Angular route
   matched, so `angularApp.handle()` returned null and Express fell through — that's the
   unmatched-route signature, not an nginx 404.

## 14. `@angular/*` framework packages pin EXACT peer versions — partial updates can never resolve

Angular publishes every framework package with exact-version peers (`@angular/forms@22.1.1` needs
`@angular/common@"22.1.1"`, not `^22.1.1`). Consequences (hit during #170):
1. `npm install @angular/common@^22.1.4 …` with only *some* of the packages → ERESOLVE, always:
   any **exact-peer framework package** left out (e.g. dev-dep `@angular/platform-browser-dynamic`)
   anchors the whole tree to the old exact version (tooling like `build`/`cli`/`ssr` uses ranged
   `^22.0.0` peers and doesn't anchor — but update it in the same pass anyway). Update **every**
   `@angular/*` dependency (deps AND devDeps, incl.
   `build`/`cli`/`ssr`/`compiler-cli`) in **one** resolver pass.
2. Even the all-at-once pass can fail when the *installed* tree anchors arborist. The reliable
   escape is regenerating from ranges: update `package.json`, then `rm -rf node_modules
   package-lock.json && npm install`. Expect a large lock diff — review it programmatically
   (registry hosts, unexpected majors, root-deps-vs-package.json identity), not line-by-line.
3. Framework and tooling move on separate patch trains (framework 22.1.4 vs build/cli/ssr 22.1.6
   the same day) — matching their patch numbers is wrong; matching each group internally is what
   must hold.

---

## 15. NEVER module-mock a dependency you assert against — and beware exceptions raised *inside* a streaming generator

**The trap (2026-08-30, #180):** `POST /ai/multi-chat` was broken in production for five weeks
while 778 backend tests stayed green. Two independent failures made that possible:

1. **Vacuous module mocks.** `conftest.py` did `sys.modules["crewai"] = MagicMock()` (and the whole
   `langchain_*` tree). A MagicMock accepts *any* constructor call, so `Agent(llm=<ChatOpenAI>)` —
   which real crewai 1.x rejects with a `ValidationError` — "passed" in every test. Mocking a whole
   module makes every assertion about that library meaningless. Mock at the **network boundary**
   (httpx/respx, `page.route`), not the library boundary; module-mock only a dependency that
   genuinely cannot be imported in tests, and never one whose behavior the code depends on.
2. **A raise inside a streaming endpoint is invisible to `response.ok`.** The exception fired
   *before* the async generator's first `yield`, i.e. after Starlette had already sent
   `http.response.start`. The client therefore saw **HTTP 200 + `Transfer-Encoding: chunked`**, then
   a mid-body connection close — not a 500. Frontend guards keyed on `response.ok` never tripped;
   the page just rendered "Connection Error". **In any streaming handler, do all setup that can fail
   inside a `try` and degrade into an error chunk on the stream**, because status codes are no
   longer available to you once the body has started.

Corollaries: an E2E that `page.route`-mocks the very endpoint it is named after proves nothing about
that endpoint (`multi-agent.spec.ts` mocked it); and when a library bump is "validated" by a suite
that mocks the library, the validation is vacuous — check what the tests actually exercise.

---

## 16. A test that passes before AND after the fix pins nothing — mutation-check it

**The trap (2026-08-30, the milestone sweep):** four separate times a test looked like it guarded a
fix and did not. A guard self-test passed against the *unfixed* guard. A "the fallback literal is not
mistaken for the version" case passed against the *unanchored* script (the real literal
`1.0.0-fallback` can never match `version="[0-9.]*"`, so the assertion was unreachable). A
leak-prevention test asserted `"[Error:" in content`, which the leaking string satisfies just as well
as the fixed one. A rotation test asserted the bullets moved but not that their heading came with
them — the exact thing that broke.

**The discipline:** after writing a test for a fix, *revert the fix and watch the test fail.* Report
the number ("mutation: 7 of 19 cases fail against the pre-fix script"), because that number — not the
green run — is the evidence the test is load-bearing. Two corollaries learned the hard way:
`git stash -- file` is a **no-op when the change is already committed** (it silently "passes"); use
`git checkout origin/main -- file` instead. And build the fixture to mirror reality — ours put a
nested literal *after* the target line while the real file has it *before*, so the read-side anchor
was never exercised until the ordering was fixed (4 mutation failures → 6).

**2026-09-06 addendum — the DATABASE can hide your normalization.** Mutation-checking the interview
calendar (#247 phase 2) showed `_parse_scheduled_at`'s `.astimezone(UTC)` was **unpinned**: every
assertion read the value back through a `timestamptz` column, and Postgres returns UTC no matter
what offset went in, so the API-layer conversion could be deleted and the tests stayed green. The
pin has to be an artifact produced **before** the round trip — here the timeline note, whose text
is rendered from the parsed value (`Interview scheduled: video on 2026-09-10T14:30:00+00:00`).
Generalize: whenever a store normalizes (timestamptz→UTC, `citext`, a DB default, a trigger), an
end-to-end assertion cannot tell your code from the store's; assert on something the store never
touched. Corollary for the harness itself: a mutant that makes the code **hang** (ours turned a
trial-decode fold loop into an infinite one) looks like a slow test run and leaves zombie pytest
processes on the shared test DB — bound every mutation run and check `pgrep -f pytest` afterwards.

## 17. After a signature change, run the FULL suite — *as CI runs it*

A targeted run (`-k`, or just the file you edited) cannot see **stale siblings**: tests in *other*
modules that still patch a symbol you deleted, or still mock a function with its old arity. This
happened three times in one day. Twice a reviewer caught it before merge (a spec still patching
`multi_chat.ChatOpenAI`; a mock still declaring `mock_multi_stream(agents, topic)` against a new
third argument). The third time it reached `main` and **reddened the deploy**.

That third one carries the sharper half of the lesson: it was green in every *serial* local run and
failed only under CI's `pytest -n auto`, because the test started the app **lifespan**, which seeds
the admin user and therefore needs a schema the xdist worker's DB does not have. So:

```bash
# NOT sufficient before pushing a signature/behaviour change:
pytest -q                      # serial; hides xdist-only failures
pytest -k the_thing_i_edited   # hides stale siblings entirely

# What CI actually runs — reproduce THIS:
pytest -n auto --cov=app --cov-report=term-missing --cov-fail-under=100
```

**"Run the full suite" means the suite as CI runs it.** Parallelism is part of the contract, not an
optimisation: `-n auto` changes fixture/DB topology, and anything that touches app startup, module
state or the database can pass serially and fail in a worker. (Our own pre-push hook still runs the
serial, unthresholded form — see §18: it is a smoke check, not the gate.)

## 18. Verify that your gates actually gate

`deploy.yml` ran `pytest --cov=app --cov-report=...` with **no `--cov-fail-under`** for the project's
entire history, and `pyproject.toml`'s `addopts` set no threshold either — so the headline "100%
coverage" standard printed a number and passed regardless. Separately, `bump_version.sh --check` ran
only in a machine-local pre-push hook, so any hook-bypassing push could reintroduce the drift it was
written to prevent. **A documented standard is not a gate until something fails when it is violated.** The pre-push hook
is itself an example: it runs `./venv/bin/pytest -q` — serial and without the coverage threshold — so
it is a smoke check that catches obvious breakage, *not* the gate that CI is.
Periodically ask of each claimed gate: *what would break if I violated this right now?* — and if the
answer is "nothing", it is documentation, not enforcement.

## 19. Fix the duplication, not the instance

`release.sh` had the version-revert block copy-pasted into each abort branch. A fix (restoring the
gitignored `.env`) was applied to one copy and silently missed two others — one of which was reachable
and left a bumped `.env` behind, i.e. *exactly the bug being fixed, still live*. The correct fix was
one `revert_bump()` called from all three paths. **When a fix lands in a copy-pasted block, the copy
is the bug**: extract it, or the next fix will miss a branch too (rule 1, applied to shell).

## 20. Renaming a repo does not carry the container packages with it

Renaming `mavrovde/mavrov.de` → `mavrovde/hirefolio` changed CI's publish target, because it derives
from `${{ github.repository }}`. The consequences are not obvious: **new GHCR packages are created
private, and package visibility does not follow a repository rename**, while the prod host pulls
anonymously with no `docker login`. Previously published tags stay at the *old* path forever, so
deploying a pre-rename version needs `IMAGE_REPO` pinned explicitly. Mitigation shipped: the rollout
job preflights anonymous pullability of every image and fails naming the package. Beware also that an
unauthenticated `curl` of a GHCR manifest returns 401 even for a *public* package — that is the token
handshake, not a visibility signal, and it will produce a false alarm if used as the check.


## 21. Loosening a guard? The bug is an EXEMPTION checked too narrowly — and it will come back

`guard-destructive.sh` (the rule-9 hook, born of the #91 volume-destruction incident) was firing on
*prose*: a quoted argument spanning newlines got split on the raw newline, so a line of text that
merely started with a destructive verb was inspected as an invocation. Fixing that took **four**
review rounds, and **every** round shipped a version that turned real denials into allows. The same
shape each time: **an exemption whose condition was checked too narrowly, so a benign leading token
hid what followed.**

| round | the hole | went deny → allow |
|---|---|---|
| 1 | quoted newlines flattened, fusing a multi-line *script* into one segment | `bash -c "echo start ↵ <volume rm>"` |
| 2 | heredoc attributed to the *first* command on the line, not the one consuming it | `echo hi && bash <<'EOF' ↵ <volume rm> ↵ EOF` |
| 2 | unterminated heredoc skipped to EOF, swallowing real commands | `cat > n.md <<'EOF' ↵ docs ↵ <volume rm>` |
| 2 | `ssh` option *value* eaten as the host, so the body was never inspected | `ssh -p 2222 host "cd /srv ↵ <volume rm>"` |
| 3 | **unquoted** heredoc delimiter — the shell *expands* that body, so `$(…)` executes | `cat > n.md <<EOF ↵ x=$(<destroy>) ↵ EOF` |
| 3 | `<<` inside a `#` comment, or after an escaped quote, read as a real redirect | `echo ok # <<'EOF' ↵ <volume rm> ↵ EOF` |
| 4 | the two functions granting the exemption disagreed about the line — one knew backslash escapes, the other did not | `git commit -m "the \" char" ; bash <<'EOF' ↵ <volume rm> ↵ EOF` |
| 5 (#210) | *replacing* a check with a better one instead of *adding* it — an early `return` deleted the fall-through that inspected the flattened body | `bash -c "docker compose -f $(echo f.yml) down -v"` |

Rows 1 and 2 are the **#91 command with an `echo` in front of it**. Each round the author (me)
believed the general case had been found and had only found an instance.

### What to actually do

1. **Write the adversarial cases first and run them against the PRE-fix version.** "Before: deny /
   after: allow" on any protected path is a blocker. Every one of these was found in seconds *once
   someone ran the comparison* — and missed entirely by reasoning about the diff.
2. **Never claim a check you did not run.** The round-1 PR body said *"No weakening — verified, not
   asserted"* over a table covering heredocs — an input class the changed function never touches.
   Asserting an unrun check is worse than admitting you didn't check.
3. **Enumerate an exemption's conditions and mutation-test each one alone** (§16). Round 3 found
   `mask_quotes` was doing real work that **zero** tests pinned: a sibling condition happened to
   cover the same inputs. A mutation score of 0 on a security check means the check is undefended,
   even with a green suite and correct behaviour today.
4. **Know what the shell actually does before exempting it.** `<<EOF` and `<<'EOF'` are different
   objects: the unquoted body is **expanded**, so a "document" can execute `$(…)`. Only exempt the
   forms you can prove are inert — and prove it by running them, not by reading the manual.
5. **Exempt via an allowlist, never a negation.** "Not a shell" would silently exempt every
   unrecognised command; "is a known text tool" fails closed on the unknown.
6. **Prefer a design that is robust to your own parser being wrong.** The `ssh` fix stopped trying to
   parse ssh's option grammar and inspects the body *before* any parsing — protection no longer
   depends on getting the grammar right.
7. **When a guard fires on documentation, that is a real bug** — it trains reflexive
   `GUARD_DESTRUCTIVE=0`, and a bypass used by habit protects nothing. Fix it in the direction that
   keeps the deny.
8. **Build test strings from concatenated parts** (`D="rm -""rf"`) or the guard blocks the file that
   tests it. This happened to a probe script, to a reviewer writing up findings, and to this file.
9. **Adding a better check must not remove the old one.** #210 replaced a fall-through with an early
   `return` because the new inner-script pass was strictly smarter. It wasn't *strictly* — the new
   pass re-splits on `(`/`)`/backtick, so a command substitution in the middle of an invocation
   fragments it and the multi-condition rules (compose + `down` + `-v`) never see all their
   conditions at once. The old flattened pass caught exactly those. Six protected paths went
   deny → allow. **Two overlapping imperfect checks beat one clever check**: keep both and let the
   first hit win.
10. **On a guard, COST is a correctness property.** The hook has a 15 s timeout, and a hook that
   times out does **not** deny — so an analysis that is too slow is an allow. #210 shipped an
   analysis that was `2^depth` (25 s at depth 9, on a command `main` decided in 153 ms) and every
   correctness test passed, because the decision was right and merely arrived too late. Two
   consequences: bound the work and make exceeding the bound **deny**, never "found nothing"; and
   pin it with **wall-clock** tests, because a correctness suite is structurally blind to this — the
   exponential mutant scored **0** against 155 passing cases.
11. **Check a pattern's POLARITY before copying it between rules.** #214 fixed a false denial by
   copying a neighbouring rule's character class. The neighbour's class sat on a **deny** condition,
   where a wider class denies more — conservative. The copy landed on an **exemption**, where a wider
   class *allows* more. The same two characters therefore inverted: `=` let a scratch-database name
   in a `--dbname=` flag disarm the rule while the actual operand was the production database, and
   17 destructive commands went `deny → allow`. Widening is safe on an alarm and dangerous on an
   excuse; a boundary is not portable between them.
12. **If two functions jointly enforce an invariant, they must share one model of the input.** Round 4
   was *introduced by the round-3 fix*: `mask_quotes` was taught about backslash escapes and its
   partner `quote_split` was not, so they disagreed about where a quoted region ended — and an
   everyday `git commit -m "… \" …"` made one see a real redirect while the other saw an unclosed
   quote. Measured directly: the six escaped-quote cases **pass** at the commit before that fix and
   **fail** at the fix itself. Two halves that are consistently wrong are safer than one half made
   right; when you correct a parsing rule, correct every function that parses.
13. **Bound the INPUT before the analysis, and measure where the budget actually goes.** #219: the
   wall-clock deadline (item 10) bounded the *inspection* phase, but the quoting scan ran before any
   deadline check could fire, so a large enough command still outlived the hook timeout — bulk alone
   defeated the guard, no cleverness required. The bound has to sit in front of the first unbounded
   loop, and exceeding it must deny. Bonus measurement: bash's `${s:i:1}` is O(n) *per access* under
   a UTF-8 locale (it re-counts multibyte characters from the start), turning every character loop
   quadratic; when every dispatch character is ASCII, `LC_ALL=C` is a one-line ~3.5x speedup that is
   semantically identical — UTF-8 continuation bytes have the high bit set and cannot alias ASCII.
14. **A quantifier in an ERE binds to ONE atom.** `-execdir? ` means `-execdi` + optional `r` — it
   matches `-execdir` and `-execdi` but never `-exec`, the common spelling (#218). Write
   `-exec(dir)?`. And when you *widen* a match, re-check what segment types it runs on: the widened
   `find -exec` unwrap had to be gated on the command actually being `find`, or a commit message
   quoting a `find -exec ...` line would deny (item 7).
15. **An allowlist of wrappers is a list of the framings someone thought of** (#217). `nice`,
   `stdbuf`, `timeout`, `busybox`, `doas`... each runs its argv unchanged, and each absence was a
   bypass. When two code paths peel wrappers, give them ONE shared peel function (item 12), and
   consume option *values* per-wrapper: consuming a value after a flag that takes none (`env -i`)
   swallows the real command — a false allow — while not consuming one (`nice -n 10`) hides the
   command behind the value token.

16. **The same class lives in every SIBLING matcher — audit them when you fix one** (#237). While the
   guard grew command-position awareness across #204→#225, `pre-push-tests.sh` right next to it kept
   deciding "this is a push" by raw substring on the tool-call text — quoted prose in a
   `gh pr review --body-file` that merely mentioned a push command tripped the full test gate (hit in
   the #211 review; the body had to be split across four files — item 7's "trains workarounds" in
   action), while a real `git -C <dir> push` never gated. The fix is item 12 applied ACROSS files:
   the guard's parsing (`quote_split`, `peel_wrapper`, the text-tool heredoc exemption) now lives in
   `.claude/hooks/hook-parse-lib.sh`, sourced by ALL THREE hooks — one model of the input, so a parsing
   fix or hole cannot diverge between them. And check item 11's polarity when reusing: "cannot
   analyse" (size/depth/time bound) must DENY on the guard but GATE (run the checks) on the test
   hook — both conservative, but they are different actions, and copying the guard's habits
   verbatim would have inverted one of them.

17. **The cost unit of a shell-parsing hook is a FORK PER DISPATCH, not a byte** (#235). Item 13 said
   "bound the input", and the obvious reading — long command = slow — is wrong: the 20 KB
   env-assignment run answered in 1 s while a 10 KB line of 5,000 two-character segments took 36.8 s,
   because `pipes_into_shell` spent ~3 forks on *every* segment (a `sed` normalise, a `grep` test, a
   `$(peel_wrapper)` subshell) and a fork costs ~2 ms no matter how little text it handles. Same
   lesson for return conventions: a helper that prints its result is a subshell at every call site.
   So **profile which loop forks per item, not which loop sees the most bytes** — then make the
   per-item path pure-bash (`case`, `${var#…}`, a global instead of `$(…)`) and let it fork only
   when the input actually needs it. Measured: 36.8 s → 7.9 s and 80.4 s → 7.9 s with no change to
   any decision. Corollary for the pins: a cost test must reproduce the *shape*, not the size — the
   fixed single-space shapes are fork-free, and one extra space per segment resurrected the whole
   cost (17.6 s), so the pin one space to the left proved nothing.
18. **A budget that "fails closed" by handing control to ANOTHER loop is only closed if that loop is
   bounded too** (#235 round-5 review). The per-segment budget in `pipes_into_shell` returned "treat
   this as piping into a shell" on timeout — correct in principle, since the payload pass then
   inspects and `inspect_segment`'s deadline denies. But the payload pass was the one pre-inspection
   loop in the file with no deadline check, and it forks ~3× per segment: the fail-closed answer cost
   *more* than the analysis it replaced, and an 8 KB command with a real destruction payload answered
   at 15.9 s — past the 15 s timeout, i.e. an allow in production (item 10 again, arrived at through
   the fix rather than the bug). Two rules: when you route past a budget, follow the control flow to
   the END and verify **the cost** of the path you handed to, not just its correctness; and prefer
   the *cheapest* path that reaches the same denial — here `return 1` into the unconditional main
   pass denies identically at 7.2 s instead of 19.7 s. Reviewing a budget means asking "what runs
   next, and is *it* bounded?"

This is the clearest evidence yet for CLAUDE.md rule 13: an independent reviewer caught a security
regression in four consecutive rounds that the author, the author's own new tests, and green CI all missed —
and CI *could not* have caught it, because nothing in the pipeline runs that suite (#208, #210).

## 22. Async SQLAlchemy after commit/rollback: the identity map and expiry WILL bite

Two distinct traps from the #69/#247 work, both invisible to unit tests that mock the session:

1. **Re-selecting after a commit does NOT refresh an already-loaded relationship.** The session's
   identity map returns the SAME object, keeping its stale (e.g. empty) collection — a `POST
   /notes` handler committed the note, re-selected the parent with `selectinload`, and returned
   `notes: []` anyway. Fix: `await db.refresh(obj, attribute_names=["notes", ...])` after the
   commit. A 201 with the write visible in the DB but absent from the response is this bug.
2. **`await db.rollback()` expires COMMITTED objects too.** Touching `obj.id` afterwards triggers a
   lazy sync reload inside the async context → `greenlet_spawn has not been called` → the whole
   request 500s. In a "guarded side-write" pattern (commit A; try commit B; except → rollback),
   capture every attribute of A you still need BEFORE the guarded block. The guard that was meant
   to make B optional otherwise takes A down with it (found by writing the coverage test for the
   guard — the test caught a real bug, the exact point of rule 2's error-path coverage).

## 23. The FIRST post-baseline CREATE TABLE migration must self-adopt (has_table guard)

The drift-guard CI job (and any historical pre-Alembic host) simulates prod by running
`Base.metadata.create_all` — which materializes every CURRENT model — then stamps `baseline0001`
and upgrades. Any later migration that `op.create_table`s therefore crashes on DuplicateTable in
exactly that scenario (first hit: `inbox0003`, #69/#258). Every migration that creates a table
must start with `if sa.inspect(op.get_bind()).has_table("<table>"): return` (create_all also built
the indexes, so skipping everything is correct). `encrypt0002` never hit this because it only
ALTERs; test both directions — clean DB creates, create_all DB no-ops. Product context: after the one-time fresh-server
pivot deploy, every deploy MIGRATES (user decision, 2026-09-05) — this guard class is permanent.

## 24. Compose `${VAR:-}` forwarding turns "unset on the host" into "EMPTY in the container"

The compose files forward env explicitly (`- SITE_NAME=${SITE_NAME:-}`); an unset host variable
arrives as an empty string, and pydantic-settings takes a present-but-empty env var as the VALUE,
silently overriding the field default ("" branding, "" CORS allowlist…). Either duplicate the
default in the compose line (drift-prone) or — the #65 pattern — a `field_validator(mode="before")`
that maps empty → field default for fields where empty is meaningless, EXCLUDING fields where empty
is a documented off-switch (`analytics_id`). Pin both directions with tests. Corollary: a new
Settings field does nothing in Docker until BOTH compose files forward it — grep the compose files
whenever adding one. **#256 corollary, one review round later:** a wizard that GENERATES a secret
must verify every compose file FORWARDS it — setup.sh printed working admin credentials while the
dev compose silently dropped `ADMIN_PASSWORD`, so the backend refused to seed. `docker compose
config` rendered against the generated `.env` is the 30-second check that catches this class.

## 25. A test that asserts equality with UNMODIFIED defaults pins nothing

Sharper special case of item 16, caught three times in one review (#255): `assert
payload.owner_name == settings.owner_name` passes verbatim against a mutant that hardcodes the
default value — defaults equal themselves. Same for a CORS test comparing middleware origins to
the default list, and an email test asserting a name that IS the default. The pin is a DISTINCT
patched value: monkeypatch `owner_name="Pin Owner"`, assert `"Pin Owner"` comes out. For wiring
fixed at import time (middleware built at module load), monkeypatch the setting, `importlib.reload`
the module, inspect the installed object's kwargs, and reload back in `finally`. And when the
behavior is "async config arrives LATER" (SSR), the pin needs a stream that has NOT emitted yet
(`ReplaySubject`, assert nothing-applied, then emit, assert applied) — every eager `of(config)`
mock hides the race by emitting during construction.

## 26. In this harness, a PreToolUse deny kills the ENTIRE compound command

`git add && git commit && git push` denied by the pre-push gate means NOTHING ran — not even the
`add`. Twice in one session an agent believed a commit existed because "only the push was denied";
both times the working tree still held the changes and a later `push` reported "up-to-date" for
the WRONG reason. Rule: after any hook deny, re-verify state (`git status`, `git log -1`) before
reasoning about it; keep `commit` and `push` as separate Bash calls (the release-manager charter
already mandates this — it applies to everyone).

---

## 27. Prove a NEW CI job by executing its exact recipe locally before flipping any gate (#261)

A CI job that has never run is a hypothesis, not a gate. Before `needs:`-gating publishes on the
new integration job, its EXACT recipe (prod compose + overlay, the published GHCR images at the
current main SHA, same env) was executed locally — and that measurement caught two failures
static review could not: compose `depends_on` drags a service in despite naming services on
`up -d` (fix: `--no-deps` + every real dependency listed explicitly), and nginx hard-fails at
STARTUP when an optional upstream hostname doesn't resolve (`host not found in upstream` emerg —
fix: give the stand-in container a network `aliases:` entry for that name). On arm64 against
amd64-only images: `docker pull --platform linux/amd64` per app image, native images for
db/WireMock, and an isolated `compose -p <project>` so the dev stack isn't touched.

## 28. One commit spawns MANY workflow runs — verify you are reading the right one (#69 postmortem)

`gh run list --branch main --limit 1` (or grabbing the first run id after a merge) can return the
CodeQL run, not Prod Deployment — checking THAT green produced a false "pipeline green"
close-the-loop claim on #69 (corrected in-thread). Always select by
`workflowName == "Prod Deployment"` before declaring a merge green. Related same-night lesson:
Playwright `getByRole` name matching is case-insensitive SUBSTRING — German copy containing
"en"/"de" collides with the EN/DE switcher buttons in strict mode (the "senden" incident, PR
#275); use `exact: true` for short exact-text locators.

## 29. 100% unit coverage says nothing about whether the feature works (v1.12.0)

v1.12.0 shipped three user-facing screens — the public contact form, the admin Inbox, the admin
Pipeline board — at 100% statements/branches/functions/lines on every project, and **not one of
them had ever rendered in a browser under CI**. Two independent reviews closed with exactly that
residual before anyone wrote a browser test. Coverage measures whether the units were executed,
not whether the product composes: routing, SSR, hydration, the zoneless repaint, and the contract
between client and server all live above it. (Closed by #282, which took the E2E suite 97 → 115.)

**The rule:** a new user-facing surface is not done until it has a test at the layer where its
failure mode lives — E2E for a screen, the integration tier for a composed API path (rule 12).
When you finish a feature, ask "what breaks that every unit test would still pass through?" and
write that test.

**Corollary — run the specs before trusting them.** Writing those tests produced two fake-green
specs that only execution revealed: a Playwright glob `*` does not cross `/`, so
`**/admin/interactions*` never matched `/admin/interactions/{id}` and a mocked PATCH escaped to
the live backend while the assertion observed nothing; and an assertion on a form's own bounding
box could not detect page overflow (the form is clamped well inside the viewport — measure
`document.documentElement.scrollWidth - clientWidth` instead). A third was circular: mocking an
idempotent server to "prove" the client prevents double submits passes no matter what the client
does — mock the NAIVE server, then the assertion means something.

## 30. Assert the guarantee at the layer that can ENFORCE it (v1.12.0)

Three v1.12.0 blockers were one mistake: a guarantee stated at a layer that cannot hold it.

- **Check-then-insert is not idempotency.** `POST /admin/opportunities/promote` did SELECT → `if
  existing is None` → INSERT with no unique constraint behind it. `get_db` yields a FRESH session
  per request, so review reproduced it directly: two sessions lined up on an `asyncio.Barrier` at
  the decision point produced **two permanent cards** (the router ships no DELETE). Fixed by a DB
  `UNIQUE` plus an `IntegrityError` recovery path, mutation-proven (drop `unique=True` → the race
  test reports 2 cards).
- **A rate limiter keyed on an attacker-controlled header limits nothing.** The bucket keyed on
  `xff.split(",")[0]`, but nginx APPENDS the real peer to whatever the client sent — hop 0 is the
  attacker's. `X-Real-IP` is authoritative here (#273).
- **A budget that "fails closed" by returning into an unbounded loop is not closed** (#235): the
  deadline check handed control to the one pre-inspection loop with no clock check, and a bulk
  command carrying a real destruction payload answered PAST the hook timeout — an allow in prod.

**The trap that makes this invisible:** the unit tier structurally CANNOT see a race.
`backend/conftest.py` overrides `get_db` to yield ONE shared session to every request, so
concurrent-looking calls in a test serialise. "883 passed" says nothing about concurrency. When the
property is "at most one of X", ask *what physically prevents the second one* — and if the answer is
an `if` in Python, write the constraint.

## 31. Isolate the resource; do not arbitrate access to it (2026-09-06)

The pre-push gate ran pytest SERIALLY against the shared `test_mavrov` and refused to start
whenever `pgrep -f pytest` saw another suite. That guard samples only at start, so an agent
beginning a suite one second later still clobbered the run — two suites doing `drop_all` /
`create_all` on one database produce dozens of spurious ERRORs that look exactly like real
failures. With agents working in parallel it blocked four pushes in one session, and each time the
temptation was to retry rather than read the log.

**The rule:** when two workers contend for a resource, give each its own instead of taking turns.
The gate now uses `test_mavrov_prepush` (conftest creates databases on demand and only drops
TABLES, so nothing accumulates) and runs `-n auto`, which is how CI runs it and additionally gives
every xdist worker its own `_gwN` database. A detector that samples at a point in time cannot prevent a race;
separate namespaces can. (Two concurrent pre-push runs would still share the gate's own name —
acceptable, because only one push runs at a time. The real collision was parallel AGENTS.)

**The meta-lesson, which cost more than the bug:** a gate failing repeatedly is data. Retrying it
unchanged is not a fix, and "it's the shared DB again" was an assumption — the log said mass
ERRORs, not the guard's refusal message, and that difference was the whole diagnosis.

## 32. A guard's SCOPE is a claim, and claims rot — check the premise, not the wiring (#276)

`frontend/scripts/check-cd-safety.mjs` shipped in #233 scoped to `projects/public` with the
comment *"The admin app is zone-based CSR … neither has the zoneless footgun."* That sentence was
false on the day it was written: `frontend/angular.json` gives the admin project **no `polyfills`
entry** (so no zone.js is bundled — `grep -rl __zone_symbol__ dist/admin/` returns nothing) and its
`app.config.ts` provides no `provideZoneChangeDetection()`, so `@angular/core`'s `ZONELESS_ENABLED`
default `factory: () => true` applies. The admin app was zoneless and completely unguarded for a
release cycle. Cost: **four** independent reviews raised it (#274 r1, #282 r1, #284 r2, plus issue
#276) before it was fixed, and when the gate was finally pointed at admin it flagged **five real
frozen-UI bugs** on the first run — a stale status bar, a stuck "Saving…" with an invisible error
banner, a permanent success banner, and a sidebar username that never tracked login/logout.

**The rule:** when you narrow a gate, the narrowing needs the same evidence standard as a
suppression — state *why* the excluded scope is safe, in falsifiable terms, and verify it against
the artifact (the built bundle, the config file), not against your memory of the architecture. A
green gate that is green because it is not looking is worse than no gate: it buys false confidence.
Same defect class as §21's `cd-safety-ok` suppression whose justification a later commit made
untrue — one level up, at the scope instead of the line.

**Corollary — the exclusion needs a test too.** The self-test now pins the *default scope*
(`--print-scope` must name both roots) and flags a violation planted only under an admin root, so
the scope cannot silently shrink again. And unit tests **can** see this bug class after all: a
TestBed that opts into `provideZonelessChangeDetection()` and never calls `detectChanges()` after
the action reproduces the frozen UI — see the `ssr-cd-safety` skill.

## 33. A mutation contract needs an IDENTITY CONTROL, or it certifies nothing

The merge gate's self-test was rebuilt twice and lied both times, in different ways:

1. **Round 1** asserted the process EXIT CODE — but these hooks deny via a JSON
   `permissionDecision` and exit 0, so removing the blocking entirely still passed every case.
2. **Round 2** added a mutation contract that reported 10/10 kills. Mutants were written to a temp
   directory WITHOUT `hook-parse-lib.sh`, so every mutant died on a missing library. A reviewer
   proved it by running a **byte-identical copy** of the hook through the same harness: it also
   "died". The honest score was 4 of 10 — the same 4 as round 1.

**The rule:** a mutation harness must run an **identity mutation that MUST SURVIVE**. If an
unmodified copy dies, every other result in that run is noise, and the run should abort rather than
report a score. Alongside it, three cheap validity checks stop a harness from flattering itself:
a mutation producing **no diff** tests nothing; a mutant that fails `bash -n` died of a **syntax
error**, not of the behaviour under test; and mutants need the same **environment** as the original
(copy the shared library in).

**And when a mutation legitimately survives, that is a finding about the CODE, not a gap to paper
over.** Two denies in this gate survived because a third check subsumes them: an empty verdict and
an explicit REQUEST CHANGES both fail the APPROVE test anyway. They stayed — their MESSAGES are
what tells an author what to do — but they are documented as message-only rather than pinned by
cases that cannot fail (§25 and the #240 precedent).

## 34. A stub that answers identically for every entity cannot prove you asked about the right one

Round 4 of the same gate. Two shapes — `echo 284 | xargs gh pr merge` and
`gh pr merge -b "squash msg" 284` — detected the merge, failed to read the operand, silently fell
back to the CURRENT BRANCH's PR, and verified a different PR than the one being merged. That is
worse than missing the merge outright, because the output says "verified".

New cases were written for both, and **they passed against the unfixed hook**. The `gh` stub
returned the same verdict JSON no matter which PR was queried, so "checked PR 284" and "fell back
to PR 999" were indistinguishable. Making the stub PR-aware was the fix — and the first attempt at
that keyed on `$2`, which is the literal word `view` in `gh pr view <n> --json …`, so the lookup
never hit and the stub was still uniform. Two rounds of a "fix" that measured nothing.

**The rule:** when the behaviour under test is *which* entity was consulted, the fake must **vary
its answer by entity**, and you must prove the variance is live — set the fallback entity to the
OPPOSITE verdict, so a fallback flips the result. Then run the new cases against the **unfixed**
code: a case that passes before the fix is pinning nothing. Measured here, that check turned a
claimed 7 regressions into the honest 5 (3× `ssh`, `xargs`, quoted `-b`); the other two already
denied and are kept only as guards.

**Corollary — fail closed on an unreadable operand.** If the target cannot be parsed, DENY. Do not
substitute a default target: the substitution is invisible and looks like success.

## 35. Test a gate's ESCAPE HATCH the way a caller types it — and a hatch that never opens is a bug

The merge gate's deny message advertised `PR_MERGE_GATE=0` as the authorized bypass. It never
worked. The hook read the flag from **its own environment**, but a caller writes it as a **command
prefix** — `PR_MERGE_GATE=0 gh pr merge 291` — which is part of the command TEXT and was eaten
unread by the env-assignment strip a few lines later. Live repro: the command was denied, by a
message naming the hatch it had just ignored.

There WAS a passing case for the bypass. It set the variable in the **harness environment**, so it
certified a path no caller can take — §34's defect, one level up: the test and the production
caller disagreed about what "setting the variable" means. `guard-destructive.sh:242` had the correct
shape all along (match the leading assignment run of the segment text); the gate simply didn't copy
it, which is what a shared parsing model is supposed to prevent.

**The rule:** a guard's bypass is part of its contract. Test it **as a command prefix**, add the
negative cases (`OTHER_VAR=0`, `PR_MERGE_GATE=1` must NOT bypass), and mutate it — if removing the
bypass check leaves the suite green, the hatch is untested. And when a guard has no working escape,
every false positive becomes a hard stop: round 4 of this PR denied six legitimate `gh pr merge`
shapes (`-R`, `-F`, `-A`, a quoted number, a branch name) with no way through.

**Corollary — read the tool's own help before writing a flag walk.** The value-taking flags were
guessed at; `gh help pr merge` lists them (`-A`, `-b`, `-F`, `-t`, `-R`, `--match-head-commit`) and
says the operand is `[<number> | <url> | <branch>]`. Three missing flags meant their VALUES were
read as the PR number.

## 36. `git checkout <file>` DISCARDS uncommitted work — it is not an undo for your last edit

Mid-review-round, a broken edit to `pre-merge-gate.test.sh` was "reverted" with
`git checkout .claude/hooks/pre-merge-gate.test.sh`. The file also held 14 new test cases and 3 new
mutations from that same round, none of it committed. All of it was destroyed in one command, and
had to be rewritten from scratch.

**How to apply.** Before `git checkout -- <file>`, `git restore <file>`, `git stash drop` or a hard
reset, run `git status --short` and ask what ELSE is uncommitted in that file. To undo only the last
edit, re-edit it — reach for the file-level revert only when you intend to lose everything since the
last commit. Commit working increments during a long round so a revert costs minutes, not the round.

**Mutation-testing corollary (#298 round 1, same failure repeated):** the mutate → run → restore
loop makes `git checkout <file>` feel like "undo the mutation", but when the file ALSO carries the
round's uncommitted fixes, the restore silently deletes them — and the just-passed test run makes
everything look fine. Two mutation checks in one round each destroyed an uncommitted fix this way
(the authz guard, the CV wiring). **Commit the round's fixes BEFORE the first mutation check**; then
`git checkout` restores exactly the fixed state and the loop is safe.

## 37. Model quoting AT THE SPLIT — a strip afterwards forges values

`set -- $seg` is IFS word-splitting, not argv splitting, and no amount of cleanup afterwards makes
it one. The merge gate split `gh pr merge -b "squash 999" 284` into `-b` `"squash` `999"` `284`,
read `999"` as the operand, and a `sed` added to "fix the quotes" turned it into a valid PR number.
The gate then verified PR **999** (approved) while merging PR **284** (request changes) — and
reported success. The same patch also *denied* every legitimate `-b "multi word" 284`.

The fix is `argv_split` in `hook-parse-lib.sh`: one character loop with the same three quoting
models the other parsers use, quotes consumed where they are, tokens preserved whole.

**The rule:** when a value's meaning depends on quoting, parse the quoting where the split happens.
A post-hoc strip cannot distinguish "a quote that closed a token" from "a quote character inside
data", so it will eventually manufacture a value that looks legitimate. That is worse than failing,
because the wrong answer is indistinguishable from the right one. And when a guard reads a target
positionally, ask what a quoted argument *ending in the target's shape* does to it.

## 38. Counting conventions go wrong on the CORPUS, not the matcher

Four hand counts were published for the same release — 30, 32, 34, 29 — and none reproduced; the measured value is 24. Every one used
essentially the same matcher (a review body containing APPROVE or REQUEST CHANGES). All the
disagreement was in *which pull requests are in the release*:

- `git log <prev-tag>..<tag> | grep -oE '\(#[0-9]+\)'` cites **issue** numbers as well as PR
  numbers — #65, #66, #69, #237, #239, #260 are issues, and `gh pr view` cannot resolve them.
- It also sweeps in PRs that merged **before** the previous tag (#245 *is* the v1.11.1 release PR).
- A hand-assembled list drifted the other way and included PRs merged **after** the tag.

**How to apply.** Define the corpus as a query, never a list: PRs whose `mergedAt` falls between the
two tags' dates. Put the runnable command in the doc, and when two people disagree about a number,
compare corpora first — the matcher is almost never the problem. A metric nobody can re-derive is
not a baseline, and a prediction stated against it (here: "below 2.5 rounds", when the real figure
was 2.4) is unfalsifiable.

## 39. `git push` rides ALONE — a PreToolUse hook vets the whole command BEFORE any of it runs

Three denied pushes in one evening, same shape each time: `fix-something && git commit && git push`
(or `ruff --fix; git push`). The pre-push hook is a PreToolUse hook — it evaluates the ENTIRE Bash
command **before the first character of it executes**. So in a chain:

- the fix ahead of the push **has not happened yet** when the gates run — the gate fails on the
  very thing the chain was about to fix;
- worse, on deny **nothing in the chain runs**: the commit silently never happened, and a later
  `git checkout`/`stash` can destroy the "committed" work (§36 was this exact cascade).

**The rule:** `git push` is always a SINGLE-command Bash invocation. Fix → separate command.
Commit → separate command. Verify the commit exists (`git log --oneline -1`) → then push, alone.
The same applies to any command a PreToolUse hook gates (`gh pr merge`): never chain state-changing
steps ahead of it, because "before the push" in your plan is "never" in a denied chain.

**Worktree corollary:** the hook gates from CLAUDE_PROJECT_DIR, so a push FROM A WORKTREE is
blocked by dirt in the MAIN checkout. Before pushing from a worktree, the main checkout must be
lint-clean too (or the in-progress work there stashed).

## Where the rules live (AI-config map)

- **`CLAUDE.md`** — the authoritative numbered rules (engineering rules 1–13, issue-tracking flow,
  execution protocol) **and the AI-config map**: the single table of every agent, command, skill,
  hook, plugin and MCP server. This file deliberately does NOT repeat that table — the copy that
  used to live here drifted every time the surface changed (it listed four of eight commands and
  said "rules 1–11" after a renumber), and one stale map is worse than none. This skill is the
  *why + reproduction* companion to the rules.
- **`.claude/agents/*.md`** + **`agents/common/roster.py`** (`PROJECT_PLAYBOOK`) — the agent charters;
  keep the two in sync (they restate overlapping lessons).
- **`.claude/skills/issue-workflow/`** — the issue/PR/milestone/label operational flow.
- **`.claude/hooks/`** — `pre-push-tests.sh` (test gate), `guard-destructive.sh` (destruction guard),
  `pre-merge-gate.sh` (rule-13 + Closes/AC merge gate), `hook-parse-lib.sh` (the ONE parsing model
  all three source, #237), plus a `*.test.sh` self-test beside each hook — the merge gate's carries
  a mutation contract with an identity control, because its first two versions certified themselves
  green while pinning nothing.
