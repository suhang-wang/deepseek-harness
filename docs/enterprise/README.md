---
description: "Design index for WeCom identity, organization synchronization, DeepSeek access, and enterprise desktop delivery."
document-type: reference
status: design
---

# Enterprise edition design

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

The enterprise edition gives employees company-managed DeepSeek access through WeCom login. A central enterprise service owns identity, organization data, model policies, quotas, and usage; Harness plugins connect the desktop application to that service.

This document set records the agreed architecture and proposed first-release defaults. It specifies work to implement and accept, rather than capabilities already shipped. This change creates documentation only; API names, package names, numerical defaults, and test outcomes remain design inputs until implementation and qualification.

<a id="contents"></a>
## Table of Contents

- [Document map](#documents)
- [Decisions and limits](#decisions)
- [Ownership and review](#ownership)
- [Sources and verification](#sources)

<a id="documents"></a>
## Document map

| Document | Owns |
| --- | --- |
| [Product requirements](product-requirements.md) | Users, scope, requirements, product flows, and acceptance objectives. |
| [Technical design](technical-design.md) | Components, login protocol, organization snapshots, policy rules, gateway, and data ownership. |
| [Test cases](test-cases.md) | Requirement mapping, preconditions, actions, expected results, and evidence. |
| [Delivery and upstream updates](delivery-and-upstream.md) | Implementation sequence, branch/repository ownership, releases, upgrades, and recovery. |

<a id="decisions"></a>
## Decisions and limits

- The first release serves one company, uses a WeCom self-built application, and connects only DeepSeek.
- Deploy one enterprise backend with its administrator website and PostgreSQL database. Organize the backend by feature; the first release does not need a separate service for each feature.
- Keep desktop integration in external plugins and an enterprise bundle. Keep native welcome, application identity, data directories, and update-source changes in a small enterprise distribution patch set.
- Use the existing DeepSeek Messages adapter. Qualify its Messages and Files capabilities with the actual company credential before implementing the production gateway.
- The gateway enforces corporate access and output-token quotas. Cost reports are estimates; the first release does not promise a hard cap on the upstream monetary bill.

<a id="ownership"></a>
## Ownership and review

The product owner approves scope and policy behavior; the backend owner implements identity, synchronization, gateway, and ledger rules; the desktop owner maintains plugins and release patches; QA owns acceptance evidence; the enterprise administrator supplies application authorization, deployment domains, and approved model configuration.

Deployment secrets enter the server secret manager or protected environment through the deployment process. Review documents, source code, screenshots, and chat must not contain live secrets. Open deployment inputs are listed in the delivery document.

<a id="sources"></a>
## Sources and verification

Repository evidence: [plugin composition](../architecture.md), [external profiles and compatibility](../../apps/cli/README.md), [DeepSeek transport](../../packages/llm/llm-deepseek/README.md), and [testing policy](../testing.md). These sources describe existing Harness behavior; this directory describes the enterprise design layered on top.

Primary external references: [Tencent WeCom integration](https://intl.cloud.tencent.com/zh/document/product/1313/83263), [Tencent WeCom API index](https://cloud.tencent.com/document/product/1301/88712), [DeepSeek Anthropic-compatible API](https://api-docs.deepseek.com/guides/anthropic_api/), and [native application login guidance](https://www.rfc-editor.org/rfc/rfc8252). WeCom field permissions and actual Messages/Files responses require integration evidence; the design does not assume that WeCom is an OIDC provider or implements native PKCE.

<a id="dev-note"></a>
## Dev Note

Keep unresolved deployment choices in the delivery document and acceptance results in release evidence. Update both language files and their pairing record together.
