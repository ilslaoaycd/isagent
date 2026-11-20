// Shared test helpers: static server, Chrome, isolated worlds and CDP input that
// reproduces how Claude in Chrome acts on a page.
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");
const { createServer } = require("../scripts/serve.js");

const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--no-sandbox"],
  });
  return {
    base,
    browser,
    async teardown() {
      await browser.close();
      server.close();
    },
  };
}

/** Opens a page. `query` sets detector options, e.g. "environment=0". */
async function open(ctx, file = "demo/index.html", query = "environment=0") {
  const page = await ctx.browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(`${ctx.base}/${file}${query ? "?" + query : ""}`, { waitUntil: "load" });
  const cdp = await page.createCDPSession();
  return { page, cdp };
}

const report = (page) =>
  page.evaluate(() => {
    const r = detector.report();
    return {
      verdict: r.verdict,
      detected: r.detected,
      agent: r.agent,
      active: r.active,
      score: r.score,
      claude: r.claude,
      signals: Object.fromEntries(r.signals.map((s) => [s.name, s.count])),
      details: Object.fromEntries(r.signals.map((s) => [s.name, s.details])),
      fills: r.filledFields.map((f) => f.field + ":" + f.method),
    };
  });

/** Runs `expression` in a fresh isolated world, like an extension content script. */
async function isolated(cdp, expression, frameIndex = 0) {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const frame = frameIndex === 0 ? frameTree.frame : frameTree.childFrames[frameIndex - 1].frame;
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "ext" });
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    contextId: executionContextId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return { value: res.result.value, contextId: executionContextId };
}

/**
 * Same DOM steps as Claude in Chrome's form_input tool for text, select and checkbox
 * fields, written for these tests (the canary suite runs the real one).
 * `find` is an expression returning the element.
 */
function formInputReplica(find, value) {
  return `(async () => {
    const el = ${find};
    const v = ${JSON.stringify(value)};
    if (el instanceof HTMLSelectElement) {
      el.selectedIndex = [...el.options].findIndex(o => o.value === v || o.text === v);
      el.focus();
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      el.focus(); if (!el.checked) el.click(); return el.checked;
    } else {
      el.value = String(v); el.focus();
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`;
}

function keyFor(ch) {
  if (ch === " ") return { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
  const upper = ch.toUpperCase();
  return { key: ch, code: /[a-z]/i.test(ch) ? "Key" + upper : "Digit" + ch, windowsVirtualKeyCode: upper.charCodeAt(0) };
}

/** Keystrokes sent the way the extension's type action sends them: all pairs at once. */
async function cdpType(cdp, text) {
  const jobs = [];
  for (const ch of text) {
    const k = keyFor(ch);
    jobs.push(cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...k, text: ch, unmodifiedText: ch, modifiers: 0 }));
    jobs.push(cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k, modifiers: 0 }));
  }
  await Promise.all(jobs);
}

/** A click the way the extension's left_click sends it. */
async function cdpClick(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, modifiers: 0 });
  await sleep(100);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 0, force: 0.5 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
}

async function center(page, sel) {
  const b = await (await page.$(sel)).boundingBox();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

// ------------------------------------------------------------------ installed extension
const EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

/** Locates an installed Claude in Chrome (or EXTENSION_DIR) and its asset files. */
function findExtension() {
  let dir = process.env.EXTENSION_DIR;
  if (!dir) {
    const roots = [
      path.join(os.homedir(), "AppData/Local/Google/Chrome/User Data"),
      path.join(os.homedir(), "Library/Application Support/Google/Chrome"),
      path.join(os.homedir(), ".config/google-chrome"),
    ];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const profile of fs.readdirSync(root)) {
        const base = path.join(root, profile, "Extensions", EXTENSION_ID);
        if (!fs.existsSync(base)) continue;
        const ver = fs.readdirSync(base).sort().pop();
        if (ver) dir = path.join(base, ver);
        break;
      }
      if (dir) break;
    }
  }
  if (!dir || !fs.existsSync(path.join(dir, "manifest.json"))) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const assets = path.join(dir, "assets");
  const files = fs.readdirSync(assets).filter((f) => f.endsWith(".js"));
  const pick = (prefix) => files.find((f) => f.startsWith(prefix));
  const grep = (needle) => files.find((f) => fs.readFileSync(path.join(assets, f), "utf8").includes(needle));
  const p = (f) => (f ? path.join(assets, f) : null);
  return {
    version: manifest.version,
    dir,
    overlay: p(pick("agent-visual-indicator.js")),
    cursor: p(pick("cursor-motion.js")),
    tools: p(grep("__claudeFormInputBusy")),
  };
}

/** Pulls functions out of the installed extension's bundle at test time (nothing is copied into this repo). */
function extractFromBundle(file) {
  const acorn = require("acorn");
  const walk = require("acorn-walk");
  const src = fs.readFileSync(file, "utf8");
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
  const text = (n) => src.slice(n.start, n.end);
  let formInput = null;
  let typeClass = null;
  walk.full(ast, (node) => {
    if (!formInput && node.type === "Property" && node.key && node.key.name === "func" && /Function/.test(node.value.type)) {
      if (text(node.value).includes("__claudeFormInputBusy")) formInput = text(node.value);
    }
    if (!typeClass && node.type === "ClassBody") {
      const typeMethod = node.body.find((m) => m.type === "MethodDefinition" && m.key && m.key.name === "type");
      if (typeMethod && text(typeMethod).includes("requiresShift")) typeClass = node;
    }
  });
  const methods = {};
  if (typeClass) {
    for (const m of typeClass.body) {
      if (m.type === "MethodDefinition" && !m.static && ["type", "keyDown", "keyUp", "insertText"].includes(m.key.name)) {
        methods[m.key.name] = text(m);
      }
    }
  }
  return { formInput, typeMethods: methods };
}

module.exports = {
  CHROME,
  sleep,
  setup,
  open,
  report,
  isolated,
  formInputReplica,
  cdpType,
  cdpClick,
  center,
  keyFor,
  findExtension,
  extractFromBundle,
};
