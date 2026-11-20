// Renders site/og.png (1280x640): the social preview card for the site and the GitHub repo.
const path = require("path");
const puppeteer = require("puppeteer-core");
const { CHROME } = require("../test/helpers");

const html = `<!doctype html><html><head><style>
  body { margin: 0; width: 1280px; height: 640px; background: #faf9f6; font-family: "Segoe UI", system-ui, sans-serif; color: #1c1b19; }
  .wrap { box-sizing: border-box; height: 100%; padding: 72px 88px; display: flex; flex-direction: column; justify-content: space-between; border-left: 18px solid #c6613f; }
  .brand { font-size: 34px; font-weight: 700; color: #c6613f; letter-spacing: -0.01em; }
  h1 { font-size: 76px; line-height: 1.05; margin: 0; letter-spacing: -0.03em; max-width: 1000px; }
  .sub { font-size: 32px; color: #55524b; margin-top: 22px; }
  .row { display: flex; gap: 18px; align-items: center; }
  .pill { font: 600 26px ui-monospace, Consolas, monospace; background: #1c1b19; color: #fff; padding: 14px 22px; border-radius: 12px; }
  .meta { font-size: 26px; color: #55524b; }
</style></head><body><div class="wrap">
  <div class="brand">isagent</div>
  <div><h1>How to detect Claude in Chrome on your website</h1>
  <div class="sub">Like isbot, but for AI browser agents. See exactly which fields they filled.</div></div>
  <div class="row"><span class="pill">npm i isagent.js</span><span class="meta">Free &amp; open source · ~7 KB · no dependencies</span></div>
</div></body></html>`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 640 });
  await page.setContent(html);
  await page.screenshot({ path: path.join(__dirname, "../site/og.png") });
  await browser.close();
  console.log("site/og.png");
})();
