---
kind: upgrade-guide
description: "企业桌面 profile 可携带两家签名公司；新增活动公司与按公司会话存储。"
---

# 企业桌面多公司工作区

[English](guide.md) | 中文

## 变更

企业桌面安装包现在可以在 `dshDesktopCompanies` 中携带一到两家签名公司（来自 profile 的 `companies` 数组，以及作为主公司的 `serviceOrigin`）。客户端在启动 Host 前选择公司，欢迎页显示当前公司名称。公司会话从 `enterprise-session.bin` 迁移到 `enterprise-sessions/<hash>/enterprise-session.bin`；客户端在 `desktop/settings.json` 的 `enterprise.activeCompanyId` 记住上次公司。单公司安装包继续沿用原 Origin、会话路径和行为。切换公司会重启客户端，并中断上一家公司中正在运行的任务。

## 迁移

1. 现有公司 profile 保持有效。要服务两家公司，在 profile 中增加 `companies`，并让 `serviceOrigin` 等于第一家公司：`{"serviceOrigin":"https://a.example.test","companies":[{"companyId":"company-a","displayName":"A 公司","serviceOrigin":"https://a.example.test"},{"companyId":"company-b","displayName":"B 公司","serviceOrigin":"https://b.example.test"}]}`
2. 用同一个 `--enterprise-profile` 重新构建桌面安装包。不要修改已安装的 manifest，也不要加入任意 Origin；公司列表随安装包签名。
3. 升级后首次启动时，若旧单公司会话保存的 `company-id` 与第一家公司一致，会自动迁移并保留登录；否则要求重新登录。验证方式：打开公司选择页，分别登录两家公司，确认各自工作区只显示本公司会话和数据。
