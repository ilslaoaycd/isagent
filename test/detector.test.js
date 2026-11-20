const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

let ctx;
before(async () => (ctx = await h.setup()));
after(async () => ctx && ctx.teardown());

const j = (x) => JSON.stringify(x);

// ------------------------------------------------------------------ baseline & environment
test("clean page: verdict none, no signals", async () => {
  const { page } = await h.open(ctx);
  await h.sleep(300);
  const r = await h.report(page);
  assert.equal(r.verdict, "none");
  assert.deepEqual(r.signals, {});
  await page.close();
});

test("automation globals (navigator.webdriver, ChromeDriver cdc_ vars) are reported", async () => {
  const { page } = await h.open(ctx, "demo/index.html", "");
  await page.evaluate(() => {
    window.cdc_adoQpoasnfa76pfcZLmcfl_Array = [];
    detector.audit();
  });
  const r = await h.report(page);
  const artifacts = r.details["automation-globals"].flatMap((d) => d.artifacts);
  assert.ok(artifacts.includes("window.cdc_adoQpoasnfa76pfcZLmcfl_Array"), j(artifacts));
  assert.equal(r.agent, "unknown");
  await page.close();
});

// ------------------------------------------------------------------ form_input
test("form_input: change→input from an isolated world is attributed to Claude per field", async () => {
  const { page, cdp } = await h.open(ctx);
  await h.isolated(cdp, h.formInputReplica("document.getElementById('name')", "Ada Lovelace"));
  await h.isolated(cdp, h.formInputReplica("document.getElementById('email')", "ada@example.com"));
  await h.isolated(cdp, h.formInputReplica("document.getElementById('plan')", "Pro"));
  await h.isolated(cdp, h.formInputReplica("document.getElementById('terms')", true));
  const r = await h.report(page);
  assert.equal(r.verdict, "agent");
  assert.equal(r.agent, "claude-in-chrome");
  assert.equal(r.signals["form-input"], 3);
  assert.equal(r.signals["programmatic-click"], 1);
  assert.equal(r.signals["synthetic-fill"], undefined, "checkbox click's own input/change are not double counted");
  for (const f of ['input#name[name="name"]:form_input', 'input#email[name="email"]:form_input', 'select#plan[name="plan"]:form_input', 'input#terms[name="terms"]:programmatic-click']) {
    assert.ok(r.fills.includes(f), f + " in " + j(r.fills));
  }
  await page.close();
});

test("site scripts dispatching input→change are only 'synthetic-fill', never Claude", async () => {
  const { page } = await h.open(ctx);
  await page.evaluate(() => {
    const el = document.getElementById("name");
    el.value = "prefilled by site";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await h.sleep(20);
  const r = await h.report(page);
  assert.equal(r.claude, 0);
  assert.equal(r.verdict, "none");
  assert.equal(r.signals["form-input"], undefined);
  assert.ok(r.signals["synthetic-fill"] >= 1);
  await page.close();
});

test("site scripts reformatting a field the user just typed in are ignored", async () => {
  const { page } = await h.open(ctx);
  await page.focus("#name");
  await page.keyboard.down("a");
  await h.sleep(70);
  await page.keyboard.up("a");
  await page.evaluate(() => {
    const el = document.getElementById("name");
    el.value = el.value.toUpperCase();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await h.sleep(20);
  const r = await h.report(page);
  assert.deepEqual(r.signals, {}, j(r));
  await page.close();
});

// ------------------------------------------------------------------ form submission
test("report is added to FormData: requestSubmit, new FormData(form) and form.submit()", async () => {
  const { page, cdp } = await h.open(ctx);
  await h.isolated(cdp, h.formInputReplica("document.getElementById('email')", "ada@example.com"));
  const viaFormData = await page.evaluate(() => JSON.parse(new FormData(document.getElementById("signup")).get("agent_detection")));
  assert.equal(viaFormData.verdict, "agent");
  assert.equal(viaFormData.agent, "claude-in-chrome");
  assert.ok(viaFormData.fields.includes('input#email[name="email"]:form_input'), j(viaFormData));

  await page.$eval("#signup", (f) => f.requestSubmit());
  const shown = JSON.parse(await page.$eval("#submitted", (e) => e.textContent));
  assert.equal(shown.agent, "claude-in-chrome");

  // form.submit() skips the submit event but still builds FormData
  const nav = page.waitForNavigation();
  await page.$eval("#signup", (f) => {
    f.removeAttribute("onsubmit");
    HTMLFormElement.prototype.submit.call(f); // the demo's button is named "submit"
  });
  await nav;
  const sent = JSON.parse(new URL(page.url()).searchParams.get("agent_detection"));
  assert.equal(sent.agent, "claude-in-chrome");
  await page.close();
});

test("values set with no events at all are reported at submission as no-user-input", async () => {
  const { page } = await h.open(ctx);
  await page.evaluate(() => {
    document.getElementById("bio").value = "silently written";
    document.getElementById("plan").value = "free";
  });
  const sent = await page.evaluate(() => JSON.parse(new FormData(document.getElementById("signup")).get("agent_detection")));
  assert.ok(sent.fields.includes('textarea#bio[name="bio"]:no-user-input'), j(sent));
  assert.ok(sent.fields.includes('select#plan[name="plan"]:no-user-input'), j(sent));
  assert.ok(!sent.fields.some((f) => f.startsWith("input#name")), "untouched empty fields are not reported");
  await page.close();
});

// ------------------------------------------------------------------ typing
test("CDP typing (type action) is detected and attributed", async () => {
  const { page, cdp } = await h.open(ctx);
  await page.focus("#bio");
  await h.cdpType(cdp, "hello world");
  assert.equal(await page.$eval("#bio", (e) => e.value), "hello world");
  const r = await h.report(page);
  assert.equal(r.signals["synthetic-typing"], 1, j(r));
  assert.ok(r.fills.includes('textarea#bio[name="bio"]:synthetic-typing'));
  assert.equal(r.verdict, "agent");
  await page.close();
});

test("short CDP-typed values (2 characters) are caught", async () => {
  const { page, cdp } = await h.open(ctx);
  await page.focus("#name");
  await h.cdpType(cdp, "NY");
  const r = await h.report(page);
  assert.equal(r.signals["synthetic-typing"], 1, j(r));
  assert.ok(r.fills.includes('input#name[name="name"]:synthetic-typing'));
  await page.close();
});

test("CDP insertText raises insert-text", async () => {
  const { page, cdp } = await h.open(ctx);
  await page.focus("#name");
  await cdp.send("Input.insertText", { text: "José 🙂" });
  const r = await h.report(page);
  assert.ok(r.signals["insert-text"] >= 1, j(r));
  await page.close();
});

test("human-paced typing is not flagged", async () => {
  const { page } = await h.open(ctx);
  await page.focus("#bio");
  for (const ch of "hello there") {
    const key = ch === " " ? "Space" : ch;
    await page.keyboard.down(key);
    await h.sleep(55 + Math.random() * 60);
    await page.keyboard.up(key);
    await h.sleep(40 + Math.random() * 90);
  }
  const r = await h.report(page);
  assert.deepEqual(r.signals, {}, j(r));
  await page.close();
});

test("human typing during a busy main thread is not flagged (uses event timestamps)", async () => {
  const { page, cdp } = await h.open(ctx);
  await page.focus("#bio");
  // measure what a handler-time clock would see
  await page.evaluate(() => {
    window.handlerHolds = [];
    const downAt = {};
    addEventListener("keydown", (e) => (downAt[e.code] = performance.now()), true);
    addEventListener("keyup", (e) => window.handlerHolds.push(performance.now() - downAt[e.code]), true);
    setTimeout(() => {
      const t = performance.now();
      while (performance.now() - t < 900) {}
    }, 30);
  });
  await h.sleep(60); // page is now blocked
  const sends = [];
  for (const ch of "abcd") {
    const k = h.keyFor(ch);
    sends.push(cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...k, text: ch, unmodifiedText: ch }));
    await h.sleep(60);
    sends.push(cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k }));
    await h.sleep(50);
  }
  await Promise.all(sends);
  const handlerHolds = await page.evaluate(() => window.handlerHolds);
  assert.ok(handlerHolds.filter((x) => x < 8).length >= 3, "events were queued: handler-time holds look machine-like " + j(handlerHolds));
  const r = await h.report(page);
  assert.equal(r.signals["synthetic-typing"], undefined, j(r));
  await page.close();
});

// ------------------------------------------------------------------ mouse
test("CDP teleport click (left_click) is detected", async () => {
  const { page, cdp } = await h.open(ctx);
  const { x, y } = await h.center(page, "#submit");
  await h.cdpClick(cdp, x, y);
  const r = await h.report(page);
  assert.equal(r.signals["teleport-click"], 1, j(r));
  await page.close();
});

test("human-like click with a movement trail is not flagged", async () => {
  const { page } = await h.open(ctx);
  await page.mouse.move(40, 40);
  await h.sleep(50);
  const { x, y } = await h.center(page, "#submit");
  await page.mouse.move(x + 7, y - 4, { steps: 25 });
  await page.mouse.down();
  await h.sleep(85);
  await page.mouse.up();
  const r = await h.report(page);
  assert.deepEqual(r.signals, {}, j(r));
  await page.close();
});

test("a quick tap as the first click on a page, without moving, is not a teleport", async () => {
  const { page, cdp } = await h.open(ctx);
  const { x, y } = await h.center(page, "#submit");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await h.sleep(8);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  const r = await h.report(page);
  assert.equal(r.signals["teleport-click"], undefined, j(r));
  await page.close();
});

test("clicks that keep hitting exact centres raise centered-clicks; varied clicks do not", async () => {
  const { page, cdp } = await h.open(ctx, "demo/index.html", "environment=0&forms=0");
  for (const sel of ["#name", "#email", "#plan", "#bio", "#name"]) {
    const { x, y } = await h.center(page, sel);
    await h.cdpClick(cdp, x, y);
    await page.keyboard.press("Escape");
  }
  let r = await h.report(page);
  assert.ok(r.signals["centered-clicks"] >= 1, j(r));
  await page.close();

  const human = await h.open(ctx, "demo/index.html", "environment=0&forms=0");
  for (const [sel, dx, dy] of [["#name", -60, 5], ["#email", 90, -6], ["#bio", -120, 12], ["#name", 140, 3], ["#email", -30, -7]]) {
    const { x, y } = await h.center(human.page, sel);
    await human.page.mouse.move(x + dx, y + dy, { steps: 15 });
    await human.page.mouse.down();
    await h.sleep(70);
    await human.page.mouse.up();
  }
  r = await h.report(human.page);
  assert.equal(r.signals["centered-clicks"], undefined, j(r));
  await human.page.close();
});

// ------------------------------------------------------------------ shadow DOM & iframes
test("fields inside open shadow roots are attributed", async () => {
  const { page, cdp } = await h.open(ctx, "test/fixtures/shadow.html", "");
  await h.isolated(cdp, h.formInputReplica("document.getElementById('host').shadowRoot.getElementById('inner')", "Paris"));
  const r = await h.report(page);
  assert.equal(r.agent, "claude-in-chrome", j(r));
  assert.ok(r.fills.includes('input#inner[name="city"] in <x-field>:form_input'), j(r.fills));
  await page.close();
});

test("same-origin iframes are watched automatically", async () => {
  const { page, cdp } = await h.open(ctx, "test/fixtures/frame.html", "");
  await h.sleep(200);
  await h.isolated(cdp, h.formInputReplica("document.getElementById('city')", "Lyon"), 1);
  const frame = page.frames()[1];
  await frame.focus("#zip");
  await h.cdpType(cdp, "69001");
  const r = await h.report(page);
  assert.ok(r.fills.includes('input#city[name="city"] in iframe:form_input'), j(r.fills));
  assert.ok(r.fills.includes('input#zip[name="zip"] in iframe:synthetic-typing'), j(r.fills));
  await page.close();
});

// ------------------------------------------------------------------ overlay & markers
test("overlay shape (closed shadow root on <body>) is detected; activity seen with sentinel", async () => {
  const { page, cdp } = await h.open(ctx, "demo/index.html", "environment=0&sentinel=1");
  const world = await h.isolated(
    cdp,
    `(() => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = ':host { all: initial !important; display: contents !important; }';
      root.appendChild(style);
      document.body.appendChild(host);
      globalThis.__show = () => { root.appendChild(document.createElement('div'));
        if (host.nextElementSibling) host.parentNode.appendChild(host); };
    })()`
  );
  await h.sleep(50);
  let r = await h.report(page);
  assert.equal(r.signals["overlay-host"], 1);
  assert.equal(r.agent, "claude-in-chrome");
  await ctx.browser; // keep linter quiet
  for (const n of [1, 2]) {
    await cdp.send("Runtime.evaluate", { expression: "__show()", contextId: world.contextId });
    await h.sleep(50);
    r = await h.report(page);
    assert.equal(r.signals["overlay-activity"], n, j(r));
  }
  await page.close();
});

test("look-alikes are not mistaken for the overlay, and probed divs still render children", async () => {
  const { page } = await h.open(ctx);
  const ok = await page.evaluate(async () => {
    const css = document.createElement("style");
    css.textContent = "body > div:empty { display: contents }";
    document.head.appendChild(css);
    const plain = document.createElement("div");
    document.body.appendChild(plain); // empty, attribute-less, display:contents via page CSS
    const open = document.createElement("div");
    open.attachShadow({ mode: "open" }).innerHTML = "<style>:host{display:contents}</style>";
    document.body.appendChild(open);
    await new Promise((r) => setTimeout(r, 50));
    const p = document.createElement("p");
    p.textContent = "portal content";
    plain.appendChild(p); // e.g. a portal rendering into the div later
    return p.getBoundingClientRect().height > 0;
  });
  assert.ok(ok, "children added after the probe still render");
  const r = await h.report(page);
  assert.equal(r.signals["overlay-host"], undefined, j(r));
  await page.close();
});

test("legacy Claude ids and other agents' markers are recognised", async () => {
  const { page } = await h.open(ctx);
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "claude-agent-stop-container";
    document.body.appendChild(d);
  });
  await h.sleep(50);
  let r = await h.report(page);
  assert.equal(r.signals["legacy-marker"], 1);
  assert.equal(r.agent, "claude-in-chrome");
  await page.close();

  const other = await h.open(ctx);
  await other.page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "codex-agent-overlay-root";
    document.body.appendChild(d);
  });
  await h.sleep(50);
  r = await h.report(other.page);
  assert.equal(r.agent, "chatgpt-agent", j(r));
  await other.page.close();
});

test("favicon swap to Claude's cursor icon is detected", async () => {
  const { page } = await h.open(ctx);
  await page.evaluate(() => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#C6613F" d="M2 1.5 14.2 6.6z"/></svg>';
    document.querySelector("link[rel=icon]").setAttribute("href", "data:image/svg+xml," + encodeURIComponent(svg));
  });
  await h.sleep(50);
  const r = await h.report(page);
  assert.equal(r.signals["tab-icon"], 1, j(r));
  await page.close();
});

// ------------------------------------------------------------------ packaging
test("minified build and module entry points expose the same API", async () => {
  const path = require("path");
  const min = require(path.join(__dirname, "../dist/isagent.min.js"));
  const src = require(path.join(__dirname, "../src/isagent.js"));
  const esm = await import("../src/index.mjs");
  assert.equal(min.VERSION, src.VERSION);
  assert.equal(esm.VERSION, src.VERSION);
  assert.deepEqual(Object.keys(min).sort(), Object.keys(src).sort());
  assert.deepEqual(Object.keys(min.SIGNALS), Object.keys(src.SIGNALS));
  assert.equal(require(path.join(__dirname, "../package.json")).version, src.VERSION);
});

test("isAgent(): live detector, one-shot check without a detector, and clean page", async () => {
  const { page, cdp } = await h.open(ctx);
  assert.equal(await page.evaluate(() => isagent.isAgent()), false);
  await h.isolated(cdp, h.formInputReplica("document.getElementById('email')", "ada@example.com"));
  assert.equal(await page.evaluate(() => isagent.isAgent()), true, "running detector saw form_input");

  // no detector running: the one-shot check still finds Claude's overlay element
  await page.evaluate(() => {
    detector.stop();
    // the test browser itself is automation (navigator.webdriver); look like a normal Chrome
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
  });
  assert.equal(await page.evaluate(() => isagent.isAgent()), false);
  await h.isolated(
    cdp,
    `(() => { const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      const st = document.createElement('style'); st.textContent = ':host{all:initial!important;display:contents!important}';
      root.appendChild(st); document.body.appendChild(host); })()`
  );
  assert.equal(await page.evaluate(() => isagent.isAgent()), true, "one-shot check");
  await page.close();
});
