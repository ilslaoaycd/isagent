// Renders docs/demo.png: the demo page after Claude in Chrome-style input.
const path = require("path");
const h = require("../test/helpers");
(async () => {
  const ctx = await h.setup();
  const { page, cdp } = await h.open(ctx);
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.setViewport({ width: 1040, height: 760, deviceScaleFactor: 2 });
  await h.isolated(cdp, h.formInputReplica("document.getElementById('name')", "Ada Lovelace"));
  await h.isolated(cdp, h.formInputReplica("document.getElementById('email')", "ada@example.com"));
  await h.isolated(cdp, h.formInputReplica("document.getElementById('plan')", "Pro"));
  await h.isolated(cdp, h.formInputReplica("document.getElementById('terms')", true));
  await page.focus("#bio");
  await h.cdpType(cdp, "Mathematician and writer");
  await page.$eval("#signup", (f) => f.requestSubmit());
  await page.evaluate(() => document.activeElement.blur());
  await page.screenshot({ path: path.join(__dirname, "../docs/demo.png"), clip: { x: 0, y: 0, width: 1040, height: 760 } });
  await ctx.teardown();
  console.log("docs/demo.png");
})();
