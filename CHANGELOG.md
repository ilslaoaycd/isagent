# Changelog

## 1.0.0 — 2026-11-20

First stable release.

- `isagent.isAgent()` quick check: uses the running detector, or a one-shot check for evidence already in the page.
- Claude in Chrome: overlay structure (closed shadow root), live `active` state via hit-testing, overlay re-attachment, legacy ids, tab icon, `form_input` change→input order.
- Generic agents: CDP typing timing (2+ keys), `Input.insertText`, teleport clicks (coalesced-sample aware), centred-click precision, script clicks on checkboxes and radios, synthetic fills, values with no user input at submission, automation globals (`navigator.webdriver`, `cdc_`, Playwright/Selenium/Puppeteer), markers reported for ChatGPT agent, Browser Use and Playwright.
- Per-field attribution with method; `agentFill(element)`.
- Report sent with every `FormData` built from a form (`formField`), including `form.submit()` and `fetch` + `FormData`.
- Shadow DOM fields, same-origin iframes.
- Timing from event timestamps, so busy main threads don't create false positives.
- TypeScript types, ESM/CommonJS/UMD, minified build (~7 KB gzipped).
- Canary tests that run an installed extension's own overlay, `form_input` and `type` code.
