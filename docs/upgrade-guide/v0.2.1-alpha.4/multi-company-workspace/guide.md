---
kind: upgrade-guide
description: "Enterprise desktop profiles may carry two signed companies; the active company and per-company session storage are new."
---

# Multi-company enterprise desktop profiles

English | [中文](guide.zh.md)

## Change

A packaged enterprise desktop client may now carry one or two signed companies in `dshDesktopCompanies` (from the profile `companies` array plus the primary `serviceOrigin`). The client selects a company before starting the Host and shows the selected company's name in the welcome surface. Company sessions move from `enterprise-session.bin` to `enterprise-sessions/<hash>/enterprise-session.bin`; the shell remembers the last company in `desktop/settings.json` under `enterprise.activeCompanyId`. Single-company packages keep their existing origin, session path and behavior. Switching companies restarts the client and interrupts tasks running in the previous company.

## Migration

1. Existing company profiles remain valid. To serve two companies, add `companies` to the profile and keep `serviceOrigin` equal to the first company's origin: `{"serviceOrigin":"https://a.example.test","companies":[{"companyId":"company-a","displayName":"Company A","serviceOrigin":"https://a.example.test"},{"companyId":"company-b","displayName":"Company B","serviceOrigin":"https://b.example.test"}]}`
2. Rebuild the desktop package with the same `--enterprise-profile`. Do not edit an installed manifest or add arbitrary origins; the company list is signed with the package.
3. On first launch after the upgrade, the existing single-company session is adopted by the first company when its stored `company-id` matches. Otherwise the client asks for a new sign-in. Confirm by launching the company picker, signing in to each company, and checking that each workspace shows only its own sessions and data.
