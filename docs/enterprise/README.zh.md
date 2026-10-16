---
description: "企业微信身份、组织同步、DeepSeek 接入和企业桌面版交付的设计入口。"
document-type: reference
status: design
---

# 企业版设计

[English](README.md) | 中文

<a id="summary"></a>
## 摘要

企业版通过企业微信登录，为员工提供由公司管理的 DeepSeek 使用入口。独立企业服务管理身份、组织数据、模型策略、额度和用量；Harness 插件负责桌面客户端接入。

本套文档记录已同意的架构方向及首期建议默认值，定义待实现、待验收的工作，不代表已发布能力。本次仅创建文档；接口名、包名、数值默认值和测试结果在实现与验证前均属于设计输入。

<a id="contents"></a>
## 目录

- [文档索引](#documents)
- [决策与限制](#decisions)
- [职责与评审](#ownership)
- [依据与验证](#sources)

<a id="documents"></a>
## 文档索引

| 文档 | 负责内容 |
| --- | --- |
| [产品需求](product-requirements.zh.md) | 用户、范围、需求、产品流程与验收目标。 |
| [技术设计](technical-design.zh.md) | 组件、登录协议、组织快照、策略规则、网关与数据归属。 |
| [测试用例](test-cases.zh.md) | 需求映射、前置条件、步骤、预期结果与证据。 |
| [交付与上游同步](delivery-and-upstream.zh.md) | 实施顺序、分支与仓库职责、发行、升级与恢复。 |

<a id="decisions"></a>
## 决策与限制

- 首期服务单一企业，使用企业微信自建应用，仅接入 DeepSeek。
- 部署一个企业后端，随服务提供管理网页并连接 PostgreSQL 数据库；后端按功能组织，首期各功能由同一服务承载。
- 桌面接入放在外部插件与企业组合包中；原生欢迎页、应用标识、数据目录与更新源改动保留为少量企业发行补丁。
- 复用现有 DeepSeek Messages 适配器；生产网关实现前，使用实际企业凭据验证 Messages 与 Files 能力。
- 网关强制执行企业访问权限与输出 token 额度；金额报表为估算，首期不承诺对上游实际金额账单实行硬封顶。

<a id="ownership"></a>
## 职责与评审

产品负责人确认范围与策略行为；后端负责人实现身份、同步、网关与账本规则；桌面负责人维护插件和发行补丁；测试负责人整理验收证据；企业管理员提供应用授权、部署域名及获准模型配置。

部署密钥通过部署流程写入服务端密钥管理系统或受保护环境；评审文档、源码、截图及聊天中不得包含真实密钥。待补充的部署输入见交付文档。

<a id="sources"></a>
## 依据与验证

仓库依据包括：[插件组合](../architecture.zh.md)、[外部 profile 与兼容性](../../apps/cli/README.zh.md)、[DeepSeek 传输](../../packages/llm/llm-deepseek/README.zh.md)及[测试规范](../testing.zh.md)。这些来源描述现有 Harness 行为，本目录描述在其上增加的企业版设计。

外部一手资料包括：[腾讯企业微信对接说明](https://intl.cloud.tencent.com/zh/document/product/1313/83263)、[腾讯企业微信 API 索引](https://cloud.tencent.com/document/product/1301/88712)、[DeepSeek Anthropic 兼容接口](https://api-docs.deepseek.com/guides/anthropic_api/)和[原生应用登录指南](https://www.rfc-editor.org/rfc/rfc8252)。企业微信字段权限及实际 Messages/Files 响应仍需联调证据；本设计不假设企业微信是 OIDC 提供商或原生实现 PKCE。

<a id="dev-note"></a>
## 开发备注

待定部署选择统一记录在交付文档，验收结果记录在发行证据中；每次修改同步更新双语文件和配对记录。
