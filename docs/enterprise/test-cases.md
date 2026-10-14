---
description: "Traceable test cases for enterprise login, directory synchronization, policies, Messages/Files isolation, quotas, and upgrades."
document-type: reference
status: design
---

# Enterprise acceptance test cases

English | [中文](test-cases.zh.md)

<a id="summary"></a>
## Summary

This is a planned acceptance reference, not an execution report. Every case maps to a [product requirement](product-requirements.md) and the [technical rules](technical-design.md). No enterprise implementation or test suite is introduced by this documentation change.

<a id="contents"></a>
## Table of Contents

- [Environment and evidence](#environment)
- [Authentication](#auth)
- [Organization and policy](#organization-policy)
- [Gateway and file isolation](#gateway-files)
- [Quota and failures](#quota-failures)
- [Administration and desktop upgrades](#admin-desktop)
- [Release acceptance](#release)

<a id="environment"></a>
## Environment and evidence

Prepare one test company with parent/child departments, two peer departments, employees A/B, a multi-department employee, a disabled employee, an administrator, an unprivileged employee, and an out-of-scope identity. Use isolated PostgreSQL, deterministic clocks, a scripted WeCom boundary, and a real HTTP Messages/Files simulator. Keep Harness Loader, provider, session, tools, and persistence real in composition tests.

Levels: U = unit, I = database/HTTP integration, C = real profile composition, R = real WeCom/DeepSeek integration, D = packaged macOS desktop. P0 blocks release; P1 covers operational quality. Evidence includes inputs without secrets, request counts, ledger/database assertions, externally observed tool effects, and screenshots where appropriate.

All cases below start as not executed. When implementing, record run ID, exact versions, environment, pass/fail, artifacts, and defect links in release evidence; never mark mock results as real-service or signed-distribution qualification.

<a id="auth"></a>
## Authentication

| Case / requirement | Priority | Precondition and action | Expected result | Level |
| --- | --- | --- | --- | --- |
| A01 / PR-01 | P0 | Enabled in-scope A scans the embedded QR, confirms on the phone, and repeats via the browser alternative. | The desktop opens automatically after confirmation; one correct device session per attempt; renderer/URL/log contain no token. | I/R/D |
| A02 / PR-01 | P0 | Submit wrong/missing state or another attempt verifier. | Reject without code exchange/session minting as applicable. | U/I |
| A03 / PR-01 | P0 | Race two callbacks and two successful exchanges. | One approved identity and at most one minted session. | I |
| A04 / PR-01 | P0 | Cancel, expire, or consume an attempt, then redeem it. | Terminal state remains terminal; no credentials issued. | U/I/D |
| A05 / PR-01,07 | P0 | Login as disabled, out-of-scope, or another-company identity. | Access denied with safe reason; no new employee admin role. | I/R |
| A06 / PR-01 | P0 | Refresh once, reuse old token, and race legitimate callers. | Host refresh is serialized; confirmed reuse revokes device session. | I/C |
| A07 / PR-07 | P0 | Logout or revoke an active device during a model stream. | New requests fail after commit; active call aborts within five seconds. | I/C/D |
| A08 / PR-01,08 | P0 | Inspect installed resources, IPC, traces, and browser storage. | No corporate secret or renderer refresh token; secure local storage required. | C/D |
| A09 / PR-07 | P1 | Logout offline, quit/restart the app, reconnect, and retry old credentials. | Active credentials cleared; durable logout-only proof completes revocation and cannot refresh/infer. | I/D |
| A10 / PR-01 | P0 | Rename A and repeat login with the same company/UserID; deny reused expired access tokens. | Stable employee identity, no duplicate account, and expired access requires valid refresh. | I/R |
| A11 / PR-01,07 | P0 | Drop the successful token response, then call consumed-attempt cleanup with correct/wrong verifier. | Correct proof revokes only its orphan session; wrong proof fails; no old token is recovered or minted. | I |

<a id="organization-policy"></a>
## Organization and policy

| Case / requirement | Priority | Precondition and action | Expected result | Level |
| --- | --- | --- | --- | --- |
| O01 / PR-02,03 | P0 | Sync nested departments and A in two departments. | One complete active epoch; accurate tree/membership; unique valid cost department. | I/R |
| O02 / PR-02 | P0 | Fail a page, return 403, timeout, or crash halfway. | No partial publication or absent-member deletion; job failure visible. | I |
| O03 / PR-02,07 | P0 | Return cyclic parents/unknown references, then an unexplained scope/count reduction. | Structural errors preserve the old snapshot; unexplained scope reduction additionally freezes affected access pending review. | U/I |
| O04 / PR-02,07 | P0 | Publish confirmed removal; sync a manually disabled employee again. | Removal revokes access; sync never clears manual disablement. | I/R |
| O05 / PR-02,12 | P0 | Start before first snapshot; age it past 60 minutes, then restore successful sync. | New login/inference fail while stale; sanitized directory alert is raised and clears after recovery. | U/I/C |
| O06 / PR-02 | P1 | Run overlapping jobs and restart a lease owner. | One publisher; stale job cannot replace a newer snapshot. | I |
| O07 / PR-02,04 | P0 | Rename/move departments and repeat the complete sync. | Stable-ID policy binding survives; published state is idempotent. | I/R |
| P01 / PR-04 | P0 | Combine company/ancestor/peer/employee model restrictions and caps 8192/4096/2048. | Model intersection and deny priority are exact; output cap is 2048 and reasoning uses the most restrictive allowance. | U/I |
| P02 / PR-04 | P0 | Omit vs empty restrictions; progressively disallow preference, cost-department default, company default, then ordered fallbacks. | Inherit differs from deny-all; select the first permitted source in that order, or reject when none remains. | U/C |
| P03 / PR-04,08 | P0 | Modify local endpoint/model, forge employee headers, or use stale policy. | Corporate gateway authenticates its session and denies forbidden requests. | I/C |
| P04 / PR-04,09 | P0 | Two admins save with the same expected revision. | One succeeds; stale writer gets 409 without lost update. | I |
| P05 / PR-03,06 | P0 | Transfer A while a request is running; remove cost department. | Old request retains charge snapshot; new unresolved request is denied. | I |

<a id="gateway-files"></a>
## Gateway and file isolation

| Case / requirement | Priority | Precondition and action | Expected result | Level |
| --- | --- | --- | --- | --- |
| G01 / PR-05 | P0 | Run real profile against scripted Messages text stream. | Incremental display and durable final response match provider content. | C/R/D |
| G02 / PR-05 | P0 | Emit split tool JSON, perform a safe temp-file tool, then continue. | Tool runs once; externally verify file; next model call uses tool result. | C/R |
| G03 / PR-05 | P0 | Stream thinking/signatures and tool changes; resume session. | Replay preserves protocol data without duplicated content/tools. | C/R |
| G04 / PR-05,06 | P0 | Split SSE frames arbitrarily; emit ping and cumulative usage updates. | Correct parse/relay; output usage is not summed twice. | I/C |
| G05 / PR-05,12 | P0 | Return non-2xx before headers and an error after partial output. | Correct protocol failure; no JSON appended to SSE and no gateway replay. | I/C |
| G06 / PR-05,08 | P0 | Submit arbitrary path/URL, redirect, unauthorized beta, or oversized body. | Reject safely; corporate key never reaches an unapproved origin. | I |
| G07 / PR-05,06 | P0 | Trigger title, compaction, retry, and subagent model calls. | Every dispatched model attempt passes policy and quota admission. | C |
| F01 / PR-05,08 | P0 | A uploads; B lists, retrieves, deletes, or references A file ID. | B sees no file, foreign ID is rejected before upstream/model call. | I/R |
| F02 / PR-08 | P0 | A cache cleanup requests dsh-prefixed files owned by B. | Filtered listing and server ownership prevent deletion. | I/C |
| F03 / PR-05,08 | P0 | Test ownership-filtered pagination and foreign IDs in historical Messages. | All and only owned files appear; every reference is checked. | I |
| F04 / PR-05 | P0 | Refresh token after upload; reuse image and let files expire. | Safe reuse or reupload; expiry cleanup; no cross-user cache reuse. | C/R |
| F05 / PR-08,12 | P1 | Crash after upstream upload before ownership commit. | Orphan unavailable to employees; cleanup/reconciliation records survive. | I |
| F06 / PR-05,08 | P0 | Exceed upload/expiry/media limits and trigger the adapter inline-image fallback. | Invalid uploads rejected; supported inline fallback still checks model/body/quota at the gateway. | I/C/R |

<a id="quota-failures"></a>
## Quota and failures

| Case / requirement | Priority | Precondition and action | Expected result | Level |
| --- | --- | --- | --- | --- |
| Q01 / PR-06 | P0 | Request at, below, and above available output quota. | Correct admission; excessive reservation rejected before dispatch. | U/I |
| Q02 / PR-06 | P0 | Race 100 admissions from multiple employees through two backend instances against low shared budgets. | No company/employee/department bucket overspends; reservations commit or roll back together. | I |
| Q03 / PR-06 | P0 | With sufficient quota, start a third call; terminate one operation without final usage and retry. | Third is initially limited; concurrency slot recovers while uncertain budget reservation remains held. | I/C |
| Q04 / PR-06 | P0 | Deliver valid terminal usage twice or race reconciliation. | One debit and one release per request; immutable ledger evidence. | I |
| Q05 / PR-06,12 | P0 | Cancel/disconnect after dispatch without final usage, then reconcile. | Attempt upstream abort; keep uncertain reservation; sanitized alert raises and clears on reconciliation. | I/C |
| Q06 / PR-06,12 | P0 | Crash before dispatch, in dispatch window, and after terminal receipt. | Provably unsent work releases; ambiguous work stays uncertain; settlement is unique. | I |
| Q07 / PR-06 | P0 | Advance uncertain request past 24 hours, then provide trusted actual usage. | Explicit estimated debit then one audited delta adjustment, no duplicate refund. | U/I |
| Q08 / PR-06 | P0 | Retry same idempotency key with same/different body after dispatch. | No second execution; changed body gets 409. | I |
| Q09 / PR-06 | P0 | Cross month/change price/transfer during a stream; lower budget below settled plus reserved. | Request snapshots remain fixed, new periods initialize atomically, invalid reduction returns 409. | U/I |
| Q10 / PR-05,06 | P0 | With real model, exercise output cap including reasoning and image input. | Observed output stays within reservation; unsupported bounds block model enablement. | R |
| Q11 / PR-06,12 | P0 | Remove price/cache data; lose and restore the database during admission. | Cost unavailable/estimated; DB failure dispatches nothing, raises a sanitized alert, and recovery clears it. | I |
| Q12 / PR-05,06 | P0 | End Messages with absent/noninteger/negative/decreasing/over-reservation output usage. | No invented zero settlement; request becomes uncertain, bound violation disables model, incident evidence retained. | I/C |

<a id="admin-desktop"></a>
## Administration and desktop upgrades

| Case / requirement | Priority | Precondition and action | Expected result | Level |
| --- | --- | --- | --- | --- |
| S01 / PR-09 | P0 | Employee calls admin endpoints; first user logs in; leader syncs. | No automatic admin grants; all unauthorized admin requests fail. | I/R |
| S02 / PR-09 | P0 | Admin updates policy/quota, disables employee, and adjusts usage. | Actor/object/revision/reason/outcome are audited with no secret/content. | I |
| S03 / PR-08,09 | P0 | Attempt admin CSRF, injection, hostile error text, and auth brute force. | Writes protected, SQL parameterized, UI safe, entry points rate-limited. | I/D |
| S04 / PR-08 | P0 | Capture model-related metadata and conversation-content egress during a task. | Necessary content goes only to approved inference; no optional official log/analytics upload; authorized login/update/tool traffic remains allowed. | C/D |
| D01 / PR-10 | P0 | Install signed/notarized enterprise app beside personal app. | Correct identity and independent userData/home; no credential or session auto-import. | D |
| D02 / PR-10,11 | P0 | Boot packaged app with enterprise bundle and disabled personal routes. | Real Loader boots enterprise login/provider/UI; no official account fallback. | C/D |
| D03 / PR-10,11 | P0 | Update from company feed; try official/wrong/unsigned artifacts. | Qualified enterprise update works; invalid identity/signature/channel rejected. | D |
| D04 / PR-11 | P0 | Install an unapproved Host plugin, then run an incompatible plugin/API pair and outdated desktop. | Enterprise profile refuses unapproved Host code before activation; clear upgrade action; server refuses unsupported protocol; no compatibility bypass. | C/D |
| D05 / PR-11 | P0 | Upgrade existing sessions and restart older app on newer schema. | Forward migration preserves history; unsupported downgrade refuses safely. | C/D |
| D06 / PR-11,12 | P0 | Fail migration, restore an old backup, then try pre-restore tokens and consumed login attempts. | Old authentication is invalid; organization/admin/disable state rechecked, uncertain employees frozen, ledger reconciled before reopening. | I/D |
| D07 / PR-12 | P1 | Run 40 streams and simulate slow consumer/upstream. | Measure admission/relay targets, bounded buffers, cancellation, and alerts. | I/D |
| D08 / PR-11 | P0 | Qualify an upstream update with login, tools, Files, and saved sessions. | Pinned combination passes critical regression; artifacts record exact versions. | C/R/D |
| D09 / PR-08,10 | P0 | Sign out A and sign in B under the same OS account. | Host restarts into B data space; no A history, credentials, or upload cache is reused by the UI. | C/D |

<a id="release"></a>
## Release acceptance

The matrix has 61 cases: 57 P0 and four P1. Every PR-01 through PR-12 has coverage. First implement unit and database invariants, then real-profile cases and a pilot-company walkthrough. Require at least 80 percent backend line and branch coverage; changed Harness package code follows the repository per-file coverage policy.

Release requires all P0 cases and the product performance targets to pass, no unresolved critical/high security defects, and evidence from real WeCom and actual company DeepSeek Messages/Files credentials. A skipped external test is unverified. Record quotas and measured upstream cost for paid runs before execution approval.

<a id="dev-note"></a>
## Dev Note

Use only synthetic users/files in automated fixtures. Each test owns its temporary files, ports, sessions, and upstream cleanup. Snapshot tests assert model-visible/session behavior; owner-local expected output covers non-session GUI and backend behavior.
