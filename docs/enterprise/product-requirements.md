---
description: "First-release product requirements for employee access, organization policies, DeepSeek quotas, and enterprise administration."
document-type: reference
status: design
---

# Enterprise product requirements

English | [中文](product-requirements.zh.md)

<a id="summary"></a>
## Summary

Employees sign in with their company WeCom identity and use approved DeepSeek models without handling corporate API keys. Administrators synchronize the authorized organization, configure access and output quotas, and inspect usage. This is a design reference under the [design status](README.md).

<a id="contents"></a>
## Table of Contents

- [Users and scope](#scope)
- [Requirements](#requirements)
- [Product flows and pages](#flows)
- [Policy experience](#policy-experience)
- [Acceptance objectives](#acceptance)

<a id="scope"></a>
## Users and scope

| Role | Permissions |
| --- | --- |
| Employee | Sign in/out, view own effective policy and usage, select an allowed model, and run local Harness tasks. |
| Enterprise administrator | Manage authorized employees, model policies, quotas, sessions, synchronization, usage reports, and audit records. |

Administrator identity comes from an explicit initial allowlist and subsequent audited grants. Department leadership does not automatically grant administration. The initial platform is macOS arm64; other desktop targets require their own release qualification.

Included: single-company login, authorized department trees and membership, employee lifecycle, DeepSeek Messages streaming with local tools and reasoning, supported image/file paths, model settings, output quotas, usage estimates, audit, and enterprise updates. Excluded from the first release: SaaS tenancy, other model vendors, HR writeback, approval workflows, knowledge bases, centralized conversation storage, and unattended remote control of employee machines.

<a id="requirements"></a>
## Requirements

All requirements below are required for the first release. The [test reference](test-cases.md) maps each identifier to concrete acceptance cases; implementation rules belong to the [technical design](technical-design.md).

| ID | Requirement | Observable acceptance |
| --- | --- | --- |
| PR-01 | WeCom login | Only authorized, enabled employees receive a desktop session; cancellation, expiry, and retry have clear outcomes. |
| PR-02 | Organization synchronization | Import the authorized department tree and employees; show sync time, scope, counts, failures, and manual retry. |
| PR-03 | Membership and cost department | Retain multiple memberships and one validated cost department per employee; unresolved attribution blocks inference. |
| PR-04 | Model policy | Manage company, department, and employee restrictions; preview the effective models, defaults, and reasons. |
| PR-05 | DeepSeek gateway | Streaming, tool execution cycles, reasoning replay, and supported images work through the corporate gateway. |
| PR-06 | Quota and usage | Reserve and settle output-token quotas without concurrent overspend; distinguish confirmed, reserved, and uncertain usage. |
| PR-07 | Access revocation | Logout, session revocation, disablement, and confirmed removal stop future gateway requests. |
| PR-08 | Data and credential protection | Corporate keys remain server-side; employee file access is isolated; optional official uploads are disabled. |
| PR-09 | Administration and audit | Reject employee admin access and record privileged changes with actor, object, time, and outcome. |
| PR-10 | Desktop distribution | Install an identifiable enterprise client with independent data directories and the company update channel. |
| PR-11 | Upstream compatibility | Pin a qualified upstream/plugin/API combination and verify existing session data before upgrades. |
| PR-12 | Operations and failure recovery | Expose actionable health, stale-directory, upstream, and uncertain-ledger alerts with tested recovery. |

<a id="flows"></a>
## Product flows and pages

Employee onboarding: open the enterprise app, scan its embedded WeCom login QR code, confirm on the phone, and enter the workspace automatically after authorization. The system browser remains an alternative when QR login is unavailable. An employee who has not logged in can already appear in the synchronized admin directory. An inactive employee, unresolved cost department, or empty model policy receives a reason and an administrator contact path.

Normal use: the model picker shows the effective catalog and allowed reasoning/output settings. Each model call, including task titles, compaction, and subagent work, consumes the relevant quota. Missing or revoked access leaves local history readable while new corporate inference is unavailable.

| Page | Required information and actions |
| --- | --- |
| Desktop sign-in/account | Company and employee identity, session state, retry/cancel/signout, and actionable errors. |
| Desktop model settings | Allowed models, effective defaults, output cap, quota, and policy explanation; corporate endpoint is managed. |
| Organization and employees | Tree, search, multiple memberships, cost department, sync state, and disable/revoke actions. |
| Policies and quotas | Company/department/employee scopes, effective preview, revision conflicts, and monthly limits. |
| Usage and audit | Employee and cost-department aggregation, token classes, estimated cost, uncertain records, and privileged operations. |
| System status | Directory freshness, gateway health, upstream access, compatibility requirements, and failed background jobs. |

<a id="policy-experience"></a>
## Policy experience

Explicit restrictions combine conservatively across company, department memberships, and employee settings. The interface explains which restrictions apply and never silently substitutes a different model. Cost allocation uses one server-owned department; displaying several memberships does not charge several peer departments for one request.

Quota is measured in generated output tokens, including reasoning where the qualified upstream protocol counts it. Administrators configure finite monthly company, employee, and cost-department limits. Input/cache token statistics and versioned prices support estimated monetary reports; upstream bills remain the reconciliation authority. Unknown usage is visible and cannot appear as a confirmed zero charge.

The enterprise distribution routes approved model calls through the gateway and removes ordinary personal-key setup. A user who controls the machine can run other software or modify local code; controlling all machine traffic requires a separate device/network management policy and is outside this release.

<a id="acceptance"></a>
## Acceptance objectives

The following values are proposed acceptance targets, not measured results. The pilot baseline is 1,000 employees, 100 departments, and 40 simultaneous model streams, with at most two active calls per employee.

| Area | Target and measurement condition |
| --- | --- |
| Revocation | After the backend revocation transaction commits, new admissions fail; active streams are aborted within five seconds. |
| WeCom changes | Poll every 15 minutes; distinguish detection delay from backend enforcement. A failed sync raises an alert and does not count as successful lifecycle processing. |
| Directory availability | A first complete authorized snapshot is required before access; a snapshot older than 60 minutes blocks new login and inference. |
| Gateway overhead | At the pilot baseline, p95 admission overhead is at most 200 ms and p95 relay delay is at most 50 ms; exclude upstream generation and human login time. |
| Correctness | All P0 cases pass, no unresolved critical/high security defects, no duplicate settlement, and no cross-employee file disclosure. |
| Qualification | Real WeCom, real DeepSeek Messages/Files, signed macOS installation, update, and migration evidence are required before company-wide release. |

<a id="dev-note"></a>
## Dev Note

Confirm quota sizes, data retention, operational ownership, and company deployment inputs during implementation planning; [delivery](delivery-and-upstream.md) owns that checklist.
