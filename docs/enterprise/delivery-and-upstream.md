---
description: "Delivery phases, repository boundaries, release qualification, upstream integration, and recovery for the enterprise edition."
document-type: reference
status: design
---

# Enterprise delivery and upstream updates

English | [中文](delivery-and-upstream.zh.md)

<a id="summary"></a>
## Summary

Keep corporate business logic in an independent enterprise project and external Harness plugins. Keep the Harness enterprise branch small and preserve upstream history. This proposed delivery reference follows the [design status](README.md); it authorizes no remote repository creation, push, publication, or deployment.

<a id="contents"></a>
## Table of Contents

- [Repository and branch ownership](#repositories)
- [Implementation phases](#phases)
- [Upstream integration](#upstream)
- [Release and recovery](#release)
- [Deployment inputs](#inputs)

<a id="repositories"></a>
## Repository and branch ownership

The local development branch is `codex/enterprise-wecom-deepseek`, created from the existing `master` checkout for this design work. It retains upstream history. Existing unrelated untracked documents are outside this change. No additional repository or remote is created by this document set.

| Planned owner | Content | Upgrade boundary |
| --- | --- | --- |
| Harness enterprise distribution | Native welcome adapter, build identity, profile/home selection, update feed, and packaging patches. | Review each upstream merge; keep patches separate by concern. |
| Independent enterprise project | Backend, admin website, API schema, external identity/provider/UI plugins, and enterprise bundle. | Backend API versions evolve independently; plugins declare qualified Harness ranges. |
| Enterprise design directory | This document set and requirement/test identifiers. | Update the owning document when behavior changes. |

Within the independent project, organize `apps/server`, `apps/admin`, `packages/api-contract`, `packages/harness-identity`, `packages/harness-provider`, `packages/harness-ui`, and `packages/harness-bundle` as proposed module names. Publish the plugin artifacts through the company package/release process after authorization; no plugin source is copied into upstream packages merely for convenience.

<a id="phases"></a>
## Implementation phases

| Phase | Output | Exit evidence / dependency |
| --- | --- | --- |
| 0: access qualification | Verify WeCom identity/directory permissions and actual DeepSeek Messages/Files contract. | Real test identities, approved test spend, model output bounds, file/usage schemas; blocks production design assumptions. |
| 1: backend foundation | Validated configuration, DB migrations, identity/session, complete organization snapshots, and admin access. | A/O/S component cases with synthetic boundaries; stage-0 qualification remains required before opening real access. |
| 2: policy and gateway | Effective policies, Messages relay, isolated Files, transactional output quotas, usage and audit. | P/G/F/Q cases, concurrent/crash recovery, real-provider qualification. |
| 3: desktop plugins | Identity/provider/UI plugins and enterprise bundle; secure refresh and managed configuration. | Real Loader composition, model-visible snapshots, and employee walkthrough. |
| 4: desktop distribution | Minimal native patches, company app identity, data separation, signing, and update source. | Packaged macOS arm64 installation, update, and migration evidence. |
| 5: pilot and release | Limited-department pilot, monitoring, backup/recovery drill, and release report. | All P0 plus performance targets; product/security/operations acceptance before broader rollout. |

Use test-first implementation for new behavior and review each independently deliverable change. The case inventory is specified in [test cases](test-cases.md); this phase table records sequencing rather than duplicating test steps. This documentation task does not execute those future tests.

Local development uses a separate explicit entrypoint, synthetic company and employee IDs, loopback HTTPS and an isolated PostgreSQL cluster. It runs the same session, authorization and organization publication paths without actual WeCom credentials or model calls. ENT-034–037 track protocol corrections, synchronization, the local environment and real Loader development composition. ENT-023–026 may use that component baseline; ENT-022 security approval and ENT-005 live qualification remain mandatory before distribution approval and pilot.

<a id="upstream"></a>
## Upstream integration

Select a specific upstream release/tag in a dedicated integration branch. Merge upstream history into the enterprise distribution, resolve the small native patch set, and adapt external plugin consumers to changed APIs. Use a single explicit merge strategy rather than copying files between unrelated histories.

- Inspect upstream changes to the shared DeepSeek adapter, profile loading, plugin compatibility, client slots, account/native welcome, data formats, and update configuration.
- Run critical enterprise regression on the proposed upstream/plugin pair, including login, revocation, organization policy, streaming tools/reasoning, Files ownership, quotas, saved sessions, and packaging.
- Pin the upstream release, enterprise patch version, plugin/bundle versions, enterprise API major, and database/session compatibility in a release manifest. Pin checksums and qualified model capabilities in release artifacts, not handwritten commit hashes in maintained prose.
- Block incompatible plugin/runtime pairs rather than using compatibility exemptions as the release process. Harness APIs are pre-stable, so each update needs qualification even when source merges without conflict.

Keep the server API backward compatible for the supported desktop window so server fixes can ship independently. Define the overlap window and minimum versions in the release manifest. Version headers guide compatibility; all authorization remains server-enforced regardless of the version string.

<a id="release"></a>
## Release and recovery

Use a company-owned application ID, product name, signing/notarization identity, update feed, and mandatory-update policy. The current [production updater configuration](../../apps/desktop/scripts/desktop-auto-update-environment.mjs) fixes the official download origin, so the enterprise distribution needs an explicit configurable company origin. Do not treat the official nightly channel as the enterprise release channel.

Select independent Electron userData before startup and an identity-scoped Harness home before the employee Host starts; the sign-in stage uses a credential-free bootstrap space. Finder startup must choose these paths without relying on shell variables. Do not automatically import personal credentials or conversations. A separately approved import feature must name supported source formats, permission, copy behavior, and restore handling.

For the first release, deploy during a maintenance window: stop new admissions, drain or mark active requests uncertain, back up data, perform forward-only migration, verify readiness, and reopen traffic. Daily full backups with continuous WAL archival target RPO of 15 minutes and a verified RTO of four hours; confirm hosting support and exercise restoration before release.

Application rollback is permitted only when the previous build supports the current schema and session format. Otherwise restore a qualified backup into an isolated recovery environment. Before reopening, rotate the deployment-owned authentication generation, revoke every restored device/admin session, invalidate all restored login attempts, obtain a fresh organization snapshot, and recheck administrator grants and manual disablement against independently retained security records. Freeze employees whose security state cannot be confirmed. Reconcile reservations and possible upstream charges before traffic resumes. Old binaries refuse unsupported newer data; no automatic schema downgrade is promised.

<a id="inputs"></a>
## Deployment inputs

| Owner | Required decision or input |
| --- | --- |
| Enterprise WeCom administrator | CorpID, AgentID, protected secret reference, app visibility, directory fields, trusted network configuration, callback domain, and test accounts. |
| Model account owner | Company DeepSeek credential reference, actual Messages/Files capabilities, approved model IDs, output/reasoning caps, billing prices, and test spend. |
| Product/finance owner | Monthly quota sizes, company timezone, cost-department assignment, unknown-usage reconciliation owner, and report retention. |
| Operations/security owner | Hosting, PostgreSQL backup/WAL support, HTTPS certificate, administrator allowlist, audit retention, monitoring, and incident contact. |
| Desktop/release owner | Enterprise app identity, Keychain access, Apple signing/notarization, package distribution, update domain, pilot devices, and supported-version window. |

These inputs block production integration or release, not the creation of this design set. Do not request or paste live secrets into documents. Resolve decisions in the owning document and record approval/evidence in the release process.

<a id="dev-note"></a>
## Dev Note

The independent enterprise repository location, concrete package namespace, host environment, and retention periods remain to be assigned before implementation. The agreed architecture does not depend on those names.
