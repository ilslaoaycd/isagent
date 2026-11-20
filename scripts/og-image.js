// Renders site/og.png (1280x640): the social preview card for the site and the GitHub repo.
const path = require("path");
const puppeteer = require("puppeteer-core");
const { CHROME } = require("../test/helpers");

const html = `<!doctype html><html><head><style>
  body { margin: 0; width: 1280px; height: 640px; background: #ffffff; font-family: "Segoe UI", system-ui, sans-serif; color: #1c1b19; }
  .wrap { box-sizing: border-box; height: 100%; padding: 72px 88px; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { font-size: 34px; font-weight: 600; color: #1f2328; } .brand span { color: #59636e; font-weight: 400; }
  h1 { font-size: 76px; line-height: 1.05; margin: 0; letter-spacing: -0.03em; max-width: 1000px; }
  .sub { font-size: 32px; color: #59636e; margin-top: 22px; }
  .row { display: flex; gap: 18px; align-items: center; }
  .pill { font: 500 26px ui-monospace, Consolas, monospace; background: #f6f8fa; color: #1f2328; padding: 12px 18px; border: 1px solid #d1d9e0; border-radius: 3px; }
  .meta { font-size: 26px; color: #59636e; }
</style></head><body><div class="wrap">
  <div class="brand">isagent <span>· isagent.js.org</span></div>
  <div><h1>How to detect Claude in Chrome and other AI browser agents</h1>
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
