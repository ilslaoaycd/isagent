// Canary tests: run the REAL code of a locally installed Claude in Chrome extension
// against the detector. They read the extension from your Chrome profile (or
// EXTENSION_DIR) at test time; nothing from the extension is stored in this repo.
// Skipped when the extension is not installed. Run alone with `npm run canary`.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const h = require("./helpers");

const ext = h.findExtension();
const skip = ext ? false : "Claude in Chrome is not installed (set EXTENSION_DIR to point at an unpacked copy)";
const bundle = ext && ext.tools ? h.extractFromBundle(ext.tools) : { formInput: null, typeMethods: {} };
const j = (x) => JSON.stringify(x);

let ctx;
before(async () => {
  if (ext) {
    ctx = await h.setup();
    console.log(`# canary: Claude in Chrome ${ext.version}`);
  }
});
after(async () => ctx && ctx.teardown());

test(`real overlay script is detected, incl. live state${ext ? ` (v${ext.version})` : ""}`, { skip }, async () => {
  const { page, cdp } = await h.open(ctx);
  const shim = `
    globalThis.__listeners = [];
    globalThis.chrome = { runtime: { id: 'canary', onMessage: { addListener: f => __listeners.push(f) },
      sendMessage: async () => ({ success: true }) } };
    globalThis.__send = (msg) => new Promise(res => { for (const l of __listeners) l(msg, {}, res); });`;
  const code = shim + fs.readFileSync(ext.cursor, "utf8") + ";\n" + fs.readFileSync(ext.overlay, "utf8") + ";0";
  await h.isolated(cdp, code);
  const icon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#C6613F" d="M2 1.5 14.2 6.6z"/></svg>');
  await h.isolated(
    cdp,
    `(async () => {
      await __send({ type: 'SHOW_AGENT_INDICATORS', ownerTabId: 1, cursorStep: { label: 'Clicking' }, tabIcon: ${j(icon)} });
      await new Promise(r => setTimeout(r, 300));
      await __send({ type: 'UPDATE_PHANTOM_CURSOR', x: 300, y: 200, pressed: true });
      await __send({ type: 'HIDE_FOR_TOOL_USE' });
      await __send({ type: 'SHOW_AFTER_TOOL_USE' });
      await new Promise(r => setTimeout(r, 1500));
    })()`
  );
  let r = await h.report(page);
  assert.equal(r.signals["overlay-host"], 1, j(r));
  assert.equal(r.active, true, "Stop button / tag is hit-testable");
  assert.ok(r.signals["tab-icon"] >= 1, "tab icon (feature-flagged in the extension)");
  assert.equal(r.agent, "claude-in-chrome");
  assert.equal(await page.evaluate(() => document.querySelector("[id^=claude-]")), null, "ids stay hidden from the page");

  await h.isolated(cdp, `__send({ type: 'HIDE_AGENT_INDICATORS' }).then(() => new Promise(r => setTimeout(r, 3000)))`);
  r = await h.report(page);
  assert.equal(r.active, false, "inactive after the turn ends");

  const late = await page.evaluate(() => {
    const d = new isagent.Detector({ environment: false }).start();
    const names = d.report().signals.map((s) => s.name);
    d.stop();
    return names;
  });
  assert.ok(late.includes("overlay-host"), "the overlay element persists for late-loading detectors");
  await page.close();
});

test("real form_input function is detected on text, email, select and checkbox", { skip: skip || (!bundle.formInput && "form_input not found in bundle") }, async () => {
  const { page, cdp } = await h.open(ctx);
  const results = [];
  for (const [id, value] of [["name", "Ada Lovelace"], ["email", "ada@example.com"], ["plan", "Pro"], ["terms", true]]) {
    const { value: out } = await h.isolated(
      cdp,
      `(async () => {
        window.__claudeElementMap = { ref_t: new WeakRef(document.getElementById(${j(id)})) };
        const formInput = ${bundle.formInput};
        return await formInput("ref_t", ${j(value)});
      })()`
    );
    results.push(out);
  }
  assert.ok(results.every((x) => x && !x.error), j(results));
  const r = await h.report(page);
  assert.equal(r.agent, "claude-in-chrome", j(r));
  for (const f of ['input#name[name="name"]:form_input', 'input#email[name="email"]:form_input', 'select#plan[name="plan"]:form_input', 'input#terms[name="terms"]:programmatic-click']) {
    assert.ok(r.fills.includes(f), f + " in " + j(r.fills));
  }
  await page.close();
});

test("real type() method is detected as synthetic typing", { skip: skip || (!bundle.typeMethods.type && "type() not found in bundle") }, async () => {
  const { page, cdp } = await h.open(ctx);
  await page.focus("#bio");
  // The real type/keyDown/keyUp methods, with the CDP transport wired to this page.
  const methods = ["type", "keyDown", "keyUp", "insertText"].filter((m) => bundle.typeMethods[m]).map((m) => bundle.typeMethods[m]);
  const typer = eval(`({ ${methods.join(",\n")} })`);
  typer.dispatchKeyEvent = (_tab, params) => cdp.send("Input.dispatchKeyEvent", { modifiers: 0, ...params });
  typer.insertText = typer.insertText || ((_tab, text) => cdp.send("Input.insertText", { text }));
  typer.sendCommand = (_tab, method, params) => cdp.send(method, params);
  typer.requiresShift = (ch) => /[A-Z!@#$%^&*()_+{}|:"<>?~]/.test(ch);
  typer.getKeyCode = (k) => {
    if (k === "Enter") return { key: "Enter", code: "Enter", keyCode: 13, text: "\r" };
    if (!/^[a-z0-9 ]$/i.test(k)) return null;
    const kk = h.keyFor(k);
    return { key: kk.key, code: kk.code, keyCode: kk.windowsVirtualKeyCode, text: k };
  };
  await typer.type(0, "Hello from the real type method");
  assert.equal(await page.$eval("#bio", (e) => e.value), "Hello from the real type method");
  const r = await h.report(page);
  console.log("# key holds (ms):", j(r.details["synthetic-typing"]?.map((d) => d.holdMs)));
  assert.ok(r.signals["synthetic-typing"] >= 1, j(r));
  assert.ok(r.fills.includes('textarea#bio[name="bio"]:synthetic-typing'));
  await page.close();
});
