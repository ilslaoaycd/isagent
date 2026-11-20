/*!
 * isagent v1.0.0
 * Detect AI browser agents (Claude in Chrome first) operating on your page,
 * and find out which form fields they filled.
 * MIT License. Not affiliated with or endorsed by Anthropic or any agent vendor.
 */
(function (root, factory) {
  if (typeof define === "function" && define.amd) define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
  else root.isagent = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.0.0";
  var CLAUDE = "claude-in-chrome";

  // weight: how strongly the signal alone indicates an agent (0..1)
  // agent:  the agent the signal identifies, or null for generic automation evidence
  var SIGNALS = {
    "overlay-host": {
      weight: 0.95,
      agent: CLAUDE,
      description: "Claude in Chrome's overlay element: an attribute-less <div> on <body> that holds a closed shadow root",
    },
    "overlay-active": {
      weight: 0.99,
      agent: CLAUDE,
      description: "Claude's Stop button or \"Claude is working\" tag is on screen (found by hit-testing)",
    },
    "overlay-activity": {
      weight: 0.97,
      agent: CLAUDE,
      description: "Claude's overlay element re-attached itself to the end of <body>",
    },
    "legacy-marker": {
      weight: 0.95,
      agent: CLAUDE,
      description: "Element id used by earlier Claude in Chrome versions, e.g. #claude-agent-stop-container",
    },
    "tab-icon": {
      weight: 0.95,
      agent: CLAUDE,
      description: "Favicon replaced with Claude's agent cursor icon",
    },
    "form-input": {
      weight: 0.9,
      agent: CLAUDE,
      description: "Field set by script, then untrusted 'change' followed by 'input' in the same task (Claude's form_input tool)",
    },
    "agent-marker": {
      weight: 0.9,
      agent: null,
      description: "DOM marker reported for another browser agent (ChatGPT agent, Browser Use, Playwright)",
    },
    "automation-globals": {
      weight: 0.9,
      agent: null,
      description: "Automation artifacts: navigator.webdriver, or WebDriver / Playwright / Selenium / Puppeteer globals",
    },
    "synthetic-typing": {
      weight: 0.85,
      agent: null,
      description: "Keystrokes held for ~0 ms with no gap between keys (CDP Input.dispatchKeyEvent)",
    },
    "teleport-click": {
      weight: 0.6,
      agent: null,
      description: "Pointer jumped to the target without movement samples, then pressed and released within milliseconds",
    },
    "synthetic-fill": {
      weight: 0.4,
      agent: null,
      description: "Field changed through script-dispatched input/change events with no recent user input",
    },
    "insert-text": {
      weight: 0.35,
      agent: null,
      description: "Text inserted without a key press, paste or IME composition (CDP Input.insertText)",
    },
    "programmatic-click": {
      weight: 0.3,
      agent: null,
      description: "Script click() on a checkbox or radio button",
    },
    "unexplained-value": {
      weight: 0.3,
      agent: null,
      description: "At submission, a field holds a value that never came from user input",
    },
    "centered-clicks": {
      weight: 0.25,
      agent: null,
      description: "Clicks keep landing on the exact centre of their targets",
    },
  };

  // Ids that earlier Claude in Chrome versions placed directly in the page (now inside a closed shadow root).
  var LEGACY_CLAUDE_IDS = {
    "claude-agent-stop-container": 1,
    "claude-agent-glow-border": 1,
    "claude-agent-animation-styles": 1,
    "claude-phantom-cursor": 1,
    "claude-static-indicator-container": 1,
  };
  // Markers publicly reported for other agents. Not verified by this project's tests.
  var OTHER_AGENT_IDS = {
    "codex-agent-overlay-root": "chatgpt-agent",
    "browser-use-debug-highlights": "browser-use",
    "playwright-highlight-container": "playwright",
  };
  var OTHER_AGENT_ATTRS = [
    ["data-browser-use-highlight", "browser-use"],
    ["data-browser-use-interaction-highlight", "browser-use"],
    ["data-browser-use-coordinate-highlight", "browser-use"],
  ];
  var AUTOMATION_GLOBAL =
    /^(\$?cdc_|\$?wdc_|__(playwright|pw[A-Z_]|puppeteer|selenium|webdriver|driver_|fxdriver|nightmare|lastWatir)|_[Ss]elenium|callSelenium|calledSelenium|_phantom|callPhantom|domAutomation)/;

  var DEFAULTS = {
    threshold: 0.85,
    overlay: true,
    markers: true,
    favicon: true,
    forms: true,
    keyboard: true,
    mouse: true,
    environment: true,
    frames: true,
    probeShadowRoot: true,
    sentinel: false,
    activeProbeMs: 1000,
    typingStreak: 2,
    maxKeyHoldMs: 12,
    maxKeyGapMs: 15,
    maxClickHoldMs: 25,
    formField: null,
    onSignal: null,
    onDetect: null,
    onFieldFill: null,
    onActiveChange: null,
    debug: false,
  };

  var SKIP_TYPES = { hidden: 1, submit: 1, button: 1, reset: 1, image: 1, file: 1 };

  // ------------------------------------------------------------------ helpers
  function now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  /** When the browser created the event, so a busy main thread doesn't distort durations. */
  function stamp(e) {
    return typeof e.timeStamp === "number" && e.timeStamp > 0 ? e.timeStamp : now();
  }

  /** The real target, including inside open shadow roots. */
  function origin(e) {
    var path = typeof e.composedPath === "function" ? e.composedPath() : null;
    return path && path.length ? path[0] : e.target;
  }

  function isField(el) {
    return !!el && el.nodeType === 1 && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
  }

  function isCheckable(el) {
    return !!el && el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
  }

  function fieldValue(el) {
    if (isCheckable(el)) return el.checked;
    return el.value;
  }

  function isDirty(el) {
    if (isCheckable(el)) return el.checked !== el.defaultChecked;
    if (el.tagName === "SELECT") {
      var opts = el.options;
      if (el.multiple) {
        for (var i = 0; i < opts.length; i++) if (opts[i].selected !== opts[i].defaultSelected) return true;
        return false;
      }
      // a single select with no default-selected option starts on its first enabled option
      var def = -1;
      for (var k = 0; k < opts.length; k++) if (opts[k].defaultSelected) def = k;
      if (def === -1) for (var m = 0; m < opts.length && def === -1; m++) if (!opts[m].disabled) def = m;
      return el.selectedIndex !== def;
    }
    return el.value !== el.defaultValue;
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    var name = el.getAttribute("name");
    if (name) s += '[name="' + name + '"]';
    var root = el.getRootNode ? el.getRootNode() : null;
    if (root && root.host) s += " in <" + root.host.tagName.toLowerCase() + ">";
    if (typeof document !== "undefined" && el.ownerDocument !== document) s += " in iframe";
    return s;
  }

  function combine(weights) {
    var p = 1;
    for (var i = 0; i < weights.length; i++) p *= 1 - weights[i];
    return Math.round((1 - p) * 1000) / 1000;
  }

  function median(values) {
    var a = values.slice().sort(function (x, y) {
      return x - y;
    });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /**
   * True if `el` has the shape of Claude in Chrome's overlay element. With `probe`, a
   * closed shadow root is confirmed by attachShadow() throwing. When the element turns
   * out not to be a host, the probe leaves an open shadow root containing a <slot>, so
   * any children added later still render as normal.
   */
  function isClaudeOverlayHost(el, probe) {
    if (!el || el.nodeType !== 1 || el.tagName !== "DIV") return false;
    var doc = el.ownerDocument;
    if (el.parentNode !== doc.body && el.parentNode !== doc.documentElement) return false;
    if (el.attributes.length !== 0 || el.childNodes.length !== 0) return false;
    if (el.shadowRoot) return false;
    if (doc.defaultView.getComputedStyle(el).display !== "contents") return false;
    if (probe === false) return true;
    try {
      el.attachShadow({ mode: "open" }).appendChild(doc.createElement("slot"));
      return false;
    } catch (e) {
      return !!e && e.name === "NotSupportedError";
    }
  }

  function isClaudeTabIcon(href) {
    if (!href || href.indexOf("data:image/svg+xml") !== 0) return false;
    var s;
    try {
      s = decodeURIComponent(href);
    } catch (e) {
      s = href;
    }
    s = s.toUpperCase();
    return s.indexOf("#C6613F") !== -1 && s.indexOf("M2 1.5 14.2 6.6") !== -1;
  }

  /** Names of automation artifacts present in `win`. */
  function automationArtifacts(win) {
    var found = [];
    try {
      if (win.navigator.webdriver === true) found.push("navigator.webdriver");
      var scan = function (obj, label) {
        var names = Object.getOwnPropertyNames(obj);
        for (var i = 0; i < names.length; i++) if (AUTOMATION_GLOBAL.test(names[i])) found.push(label + names[i]);
      };
      scan(win, "window.");
      scan(win.document, "document.");
      var html = win.document.documentElement;
      ["webdriver", "selenium", "driver"].forEach(function (a) {
        if (html && html.hasAttribute(a)) found.push("<html " + a + ">");
      });
    } catch (e) {}
    return found;
  }

  // ------------------------------------------------------------------ detector
  function Detector(options) {
    this.options = {};
    var k;
    for (k in DEFAULTS) this.options[k] = DEFAULTS[k];
    for (k in options || {}) this.options[k] = options[k];
    this._cleanup = [];
    this._running = false;
    this._host = null;
    this._active = false;
    this._misses = 0;
    this._sentinel = null;
    this.reset();
  }

  Detector.prototype._log = function () {
    if (this.options.debug && typeof console !== "undefined") {
      console.debug.apply(console, ["[isagent]"].concat([].slice.call(arguments)));
    }
  };

  Detector.prototype._listen = function (target, type, fn) {
    var self = this;
    var opts = { capture: true, passive: true };
    var handler = function (e) {
      try {
        fn.call(self, e);
      } catch (err) {
        self._log("handler error", type, err);
      }
    };
    target.addEventListener(type, handler, opts);
    this._cleanup.push(function () {
      try {
        target.removeEventListener(type, handler, opts);
      } catch (e) {}
    });
  };

  Detector.prototype._emit = function (type, detail) {
    try {
      window.dispatchEvent(new CustomEvent("isagent:" + type, { detail: detail }));
    } catch (e) {}
  };

  Detector.prototype._signal = function (name, details) {
    var meta = SIGNALS[name];
    var t = Date.now();
    var s = this._signals[name];
    if (!s) {
      s = this._signals[name] = {
        name: name,
        weight: meta.weight,
        agent: meta.agent,
        description: meta.description,
        count: 0,
        first: t,
        last: t,
        details: [],
      };
    }
    s.count++;
    s.last = t;
    if (details && s.details.length < 20) s.details.push(details);
    if (details && details.agent && !s.agent) s.agent = details.agent;
    this._log("signal", name, details || "");
    var report = this.report();
    if (typeof this.options.onSignal === "function") this.options.onSignal(s, report);
    this._emit("signal", { signal: s, report: report });
    if (report.detected && !this._detectedFired) {
      this._detectedFired = true;
      if (typeof this.options.onDetect === "function") this.options.onDetect(report);
      this._emit("detect", { report: report });
    }
  };

  Detector.prototype._fill = function (el, method) {
    var prev = this._fillMap.get(el);
    var t = Date.now();
    if (prev && prev.method === method && t - prev.time < 250) {
      prev.value = fieldValue(el);
      prev.time = t;
      return prev;
    }
    var entry = { element: el, field: describe(el), method: method, value: fieldValue(el), time: t };
    this._fills.push(entry);
    if (this._fills.length > 500) this._fills.shift();
    this._fillMap.set(el, entry);
    if (typeof this.options.onFieldFill === "function") this.options.onFieldFill(entry);
    this._emit("fill", entry);
    return entry;
  };

  Detector.prototype._markUser = function (el) {
    this._userTouched.set(el, now());
  };

  Detector.prototype._userRecently = function (el, ms) {
    var t = this._userTouched.get(el);
    return t !== undefined && now() - t <= ms;
  };

  // ------------------------------------------------------------------ overlay & markers (top document)
  Detector.prototype._inspectChild = function (node, fromMutation) {
    if (!node || node.nodeType !== 1 || node === this._sentinel) return;
    var o = this.options;
    if (o.markers && node.id && !this._seenMarkers.has(node)) {
      if (LEGACY_CLAUDE_IDS[node.id]) {
        this._seenMarkers.add(node);
        this._signal("legacy-marker", { id: node.id });
        return;
      }
      if (OTHER_AGENT_IDS[node.id]) {
        this._seenMarkers.add(node);
        this._signal("agent-marker", { id: node.id, agent: OTHER_AGENT_IDS[node.id] });
        return;
      }
    }
    if (o.overlay && node.tagName === "DIV") this._checkHost(node, fromMutation);
  };

  Detector.prototype._checkHost = function (el, fromMutation) {
    if (this._hosts.has(el)) {
      if (fromMutation) this._signal("overlay-activity", { at: Date.now() });
      this._placeSentinel(el);
      return;
    }
    if (this._notHosts.has(el)) return;
    if (!isClaudeOverlayHost(el, this.options.probeShadowRoot)) {
      // empty divs are often filled right after insertion; only cache once they can no longer match
      if (el.attributes.length || el.childNodes.length || el.shadowRoot) this._notHosts.add(el);
      return;
    }
    this._hosts.add(el);
    this._host = el;
    this._signal("overlay-host", { element: "div with closed shadow root" });
    this._placeSentinel(el);
    var self = this;
    setTimeout(function () {
      self._tickActive();
    }, 100);
  };

  // Optional: Claude moves its element back to the end of <body> when it builds indicator
  // pieces and something follows it. A hidden sentinel after the element makes that observable.
  Detector.prototype._placeSentinel = function (host) {
    if (!this.options.sentinel || !host.parentNode) return;
    if (!this._sentinel) {
      this._sentinel = document.createElement("template");
      this._sentinel.setAttribute("data-isagent", "");
    }
    if (host.nextSibling !== this._sentinel) host.parentNode.appendChild(this._sentinel);
  };

  // Claude's Stop button and page tag live in the closed shadow root but take pointer
  // events, so hit-testing at their positions returns the overlay element itself.
  Detector.prototype._probeActive = function () {
    var host = this._host;
    if (!host || !host.isConnected || typeof document.elementsFromPoint !== "function") return false;
    var h = window.innerHeight;
    var x = Math.round(window.innerWidth / 2);
    var ys = [8, 24, 42, h - 8, h - 24, h - 38, h - 52];
    for (var i = 0; i < ys.length; i++) {
      if (ys[i] < 0 || ys[i] >= h) continue;
      if (document.elementsFromPoint(x, ys[i]).indexOf(host) !== -1) return true;
    }
    return false;
  };

  Detector.prototype._tickActive = function () {
    var hit = this._probeActive();
    this._misses = hit ? 0 : this._misses + 1;
    var active = hit || (this._active && this._misses < 2); // ride out one missed probe
    if (active === this._active) return;
    this._active = active;
    if (active) this._signal("overlay-active", { at: Date.now() });
    this._emit("active", { active: active });
    if (typeof this.options.onActiveChange === "function") this.options.onActiveChange(active);
  };

  Detector.prototype._scanAttributeMarkers = function () {
    for (var i = 0; i < OTHER_AGENT_ATTRS.length; i++) {
      var el = document.querySelector("[" + OTHER_AGENT_ATTRS[i][0] + "]");
      if (el && !this._seenMarkers.has(el)) {
        this._seenMarkers.add(el);
        this._signal("agent-marker", { attribute: OTHER_AGENT_ATTRS[i][0], agent: OTHER_AGENT_ATTRS[i][1] });
      }
    }
  };

  Detector.prototype._watchTopDocument = function () {
    var self = this;
    var o = this.options;
    var observed = new WeakSet();
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (node === document.body || node === document.head) observe(node);
          self._inspectChild(node, true);
        }
      }
    });
    function observe(target) {
      if (!target || observed.has(target)) return;
      observed.add(target);
      mo.observe(target, { childList: true });
      var kids = target.children;
      for (var i = 0; i < kids.length; i++) self._inspectChild(kids[i], false);
    }
    observe(document.documentElement);
    observe(document.head);
    observe(document.body);
    var timer = setInterval(function () {
      if (self._host) self._tickActive();
      if (o.markers) self._scanAttributeMarkers();
    }, o.activeProbeMs);
    this._cleanup.push(function () {
      clearInterval(timer);
      mo.disconnect();
      if (self._sentinel && self._sentinel.parentNode) self._sentinel.parentNode.removeChild(self._sentinel);
    });
  };

  // ------------------------------------------------------------------ favicon
  Detector.prototype._watchFavicon = function () {
    var self = this;
    function check(link, how) {
      if (link && link.tagName === "LINK" && isClaudeTabIcon(link.getAttribute("href"))) {
        self._signal("tab-icon", { how: how });
      }
    }
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === "attributes") check(r.target, "changed");
        else for (var n = 0; n < r.addedNodes.length; n++) check(r.addedNodes[n], "added");
      }
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
    var links = document.querySelectorAll("link[href]");
    for (var i = 0; i < links.length; i++) check(links[i], "present");
    this._cleanup.push(function () {
      mo.disconnect();
    });
  };

  // ------------------------------------------------------------------ environment
  Detector.prototype._checkEnvironment = function () {
    var found = automationArtifacts(window);
    var fresh = [];
    for (var i = 0; i < found.length; i++) {
      if (!this._artifacts[found[i]]) {
        this._artifacts[found[i]] = 1;
        fresh.push(found[i]);
      }
    }
    if (fresh.length) this._signal("automation-globals", { artifacts: fresh });
  };

  // ------------------------------------------------------------------ per-window watchers
  Detector.prototype._attachWindow = function (win) {
    var doc;
    try {
      doc = win.document;
      if (!doc || this._docs.has(doc)) return;
    } catch (e) {
      return; // cross-origin frame: include the script inside that frame instead
    }
    this._docs.add(doc);
    var o = this.options;
    if (o.forms) this._watchForms(win);
    if (o.keyboard) this._watchKeyboard(win);
    if (o.mouse) this._watchMouse(win);
    if (o.formField) this._watchFormData(win);
    if (o.frames) this._watchFrames(win);
  };

  Detector.prototype._watchFrames = function (win) {
    var self = this;
    function attach(frame) {
      try {
        if (frame.contentWindow) self._attachWindow(frame.contentWindow);
      } catch (e) {}
    }
    // load events never reach window, so listen on the document
    this._listen(win.document, "load", function (e) {
      var t = e.target;
      if (t && (t.tagName === "IFRAME" || t.tagName === "FRAME")) attach(t);
    });
    var frames = win.document.querySelectorAll("iframe, frame");
    for (var i = 0; i < frames.length; i++) attach(frames[i]);
  };

  Detector.prototype._watchForms = function (win) {
    var self = this;
    // Events dispatched without {composed: true} (as form_input does) never leave a shadow
    // root. Composed events that precede them (focusin from el.focus(), pointerdown, keydown)
    // tell us which shadow roots to watch as well.
    function reach(e) {
      var el = origin(e);
      var root = el && el.getRootNode ? el.getRootNode() : null;
      if (root && root.host && !self._roots.has(root)) {
        self._roots.add(root);
        self._watchFieldEvents(root);
      }
      return el;
    }
    function userTouch(e) {
      var el = reach(e);
      if (e.isTrusted && isField(el)) self._markUser(el);
    }
    ["keydown", "paste", "drop", "cut", "pointerdown", "focusin"].forEach(function (type) {
      self._listen(win, type, function (e) {
        if (type === "focusin") reach(e);
        else userTouch(e);
      });
    });
    this._watchFieldEvents(win);
  };

  Detector.prototype._watchFieldEvents = function (target) {
    var self = this;
    var pendingChange = null;
    var clicked = null; // checkbox/radio being toggled by a script click() in this task
    function firstSight(e) {
      if (self._seenEvents.has(e)) return false; // composed events reach both a shadow root and window
      self._seenEvents.add(e);
      return true;
    }

    function syntheticFill(el, kind) {
      if (self._userRecently(el, 1000)) return; // the page's own scripts reacting to the user
      self._fill(el, "synthetic-event");
      self._signal("synthetic-fill", { event: kind, field: describe(el) });
    }

    this._listen(target, "change", function (e) {
      var el = origin(e);
      if (!isField(el) || !firstSight(e)) return;
      if (e.isTrusted) return self._markUser(el);
      if (clicked === el) return;
      var ref = (pendingChange = { el: el });
      // form_input dispatches change and input back to back in one synchronous block,
      // so no microtask checkpoint runs between them.
      Promise.resolve().then(function () {
        if (pendingChange === ref) {
          pendingChange = null;
          syntheticFill(el, "change");
        }
      });
    });

    this._listen(target, "input", function (e) {
      var el = origin(e);
      if (!isField(el) || !firstSight(e)) return;
      if (e.isTrusted) return self._markUser(el);
      if (clicked === el) return;
      var plainEvent = !("inputType" in e);
      if (pendingChange && pendingChange.el === el && plainEvent) {
        pendingChange = null;
        self._fill(el, "form_input");
        self._signal("form-input", { field: describe(el) });
      } else {
        syntheticFill(el, "input");
      }
    });

    this._listen(target, "click", function (e) {
      var el = origin(e);
      if (!firstSight(e)) return;
      if (e.isTrusted) {
        if (isField(el)) self._markUser(el);
        return;
      }
      if (!isCheckable(el)) return;
      clicked = el;
      Promise.resolve().then(function () {
        if (clicked === el) clicked = null;
      });
      self._fill(el, "programmatic-click");
      self._signal("programmatic-click", { field: describe(el) });
    });
  };

  Detector.prototype._watchKeyboard = function (win) {
    var self = this;
    var o = this.options;
    var down = {};
    var lastUp = -Infinity;
    var lastKeydown = -Infinity;
    var streak = 0;
    var targets = [];
    var composing = false;

    this._listen(win, "compositionstart", function () {
      composing = true;
    });
    this._listen(win, "compositionend", function () {
      composing = false;
    });

    this._listen(win, "keydown", function (e) {
      if (!e.isTrusted || e.repeat) return;
      var t = stamp(e);
      lastKeydown = t;
      down[e.code || e.key] = { t: t, gap: t - lastUp, target: origin(e) };
    });

    this._listen(win, "keyup", function (e) {
      if (!e.isTrusted) return;
      var t = stamp(e);
      var key = e.code || e.key;
      var d = down[key];
      delete down[key];
      lastUp = t;
      if (!d) return;
      var hold = t - d.t;
      if (hold < 0 || hold > o.maxKeyHoldMs) {
        streak = 0;
        targets = [];
        return;
      }
      if (streak > 0 && d.gap <= o.maxKeyGapMs) streak++;
      else {
        streak = 1; // a machine-timed key after a pause starts a new run
        targets = [];
      }
      targets.push(d.target);
      if (streak < o.typingStreak) return;
      var seen = [];
      for (var i = 0; i < targets.length; i++) {
        var el = targets[i];
        if (isField(el) && seen.indexOf(el) === -1) {
          seen.push(el);
          self._fill(el, "synthetic-typing");
        }
      }
      targets = [d.target];
      if (streak === o.typingStreak) {
        self._signal("synthetic-typing", { holdMs: Math.round(hold * 100) / 100, field: describe(d.target) });
      }
    });

    this._listen(win, "beforeinput", function (e) {
      if (!e.isTrusted || composing || e.isComposing) return;
      if (e.inputType !== "insertText" || !e.data) return;
      if (stamp(e) - lastKeydown < 100) return;
      var el = origin(e);
      if (isField(el)) self._fill(el, "insert-text");
      self._signal("insert-text", { length: e.data.length, field: describe(el) });
    });
  };

  Detector.prototype._watchMouse = function (win) {
    var self = this;
    var o = this.options;
    var samples = [];
    var lastPos = null;
    var pressed = null;
    var offsets = [];

    this._listen(win, "pointermove", function (e) {
      if (!e.isTrusted || e.pointerType !== "mouse") return;
      var t = stamp(e);
      // a real mouse produces many coalesced samples per frame; one CDP mouseMoved produces one
      var n = typeof e.getCoalescedEvents === "function" ? Math.max(1, e.getCoalescedEvents().length) : 1;
      samples.push({ t: t, n: n, x: e.clientX, y: e.clientY, from: lastPos });
      while (samples.length && t - samples[0].t > 1000) samples.shift();
      lastPos = { x: e.clientX, y: e.clientY };
    });

    this._listen(win, "pointerdown", function (e) {
      if (!e.isTrusted || e.pointerType !== "mouse") return;
      var t = stamp(e);
      var recent = samples.filter(function (s) {
        return t - s.t <= 600;
      });
      var count = 0;
      for (var i = 0; i < recent.length; i++) count += recent[i].n;
      var teleport = false;
      if (recent.length && count <= 2) {
        var first = recent[0];
        teleport = first.from
          ? Math.hypot(first.x - first.from.x, first.y - first.from.y) >= 40
          : recent.length === 1; // first pointer event on the page arrived as a single jump
      }
      var el = origin(e);
      if (el && el.nodeType === 1 && el.getBoundingClientRect) {
        var r = el.getBoundingClientRect();
        if (r.width >= 8 && r.height >= 8 && r.width < win.innerWidth * 0.8 && r.height < win.innerHeight * 0.5) {
          var off = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / Math.hypot(r.width, r.height);
          offsets.push(off);
          if (offsets.length > 7) offsets.shift();
        }
      }
      pressed = { t: t, teleport: teleport, x: e.clientX, y: e.clientY, target: el };
      lastPos = { x: e.clientX, y: e.clientY };
    });

    this._listen(win, "pointerup", function (e) {
      if (!e.isTrusted || !pressed || e.pointerType !== "mouse") return;
      var hold = stamp(e) - pressed.t;
      if (pressed.teleport && hold >= 0 && hold <= o.maxClickHoldMs) {
        self._signal("teleport-click", {
          x: Math.round(pressed.x),
          y: Math.round(pressed.y),
          holdMs: Math.round(hold * 100) / 100,
          target: describe(pressed.target),
        });
      }
      if (offsets.length >= 5 && median(offsets.slice(-5)) <= 0.03) {
        self._signal("centered-clicks", { medianOffset: Math.round(median(offsets.slice(-5)) * 1000) / 1000 });
        offsets = [];
      }
      pressed = null;
    });
  };

  // Adds the report to every FormData built from a form: native submission, form.submit()
  // and `new FormData(form)` in fetch-based apps. No DOM changes needed.
  Detector.prototype._watchFormData = function (win) {
    var self = this;
    var name = this.options.formField;
    this._listen(win, "formdata", function (e) {
      if (e.formData && e.target && e.target.tagName === "FORM") {
        e.formData.set(name, JSON.stringify(self.summary(e.target)));
      }
    });
  };

  // ------------------------------------------------------------------ public API
  var current = null; // the detector isAgent() consults

  Detector.prototype.start = function () {
    if (this._running || typeof window === "undefined") return this;
    this._running = true;
    current = this;
    var o = this.options;
    var self = this;
    if (o.overlay || o.markers) this._watchTopDocument();
    if (o.favicon) this._watchFavicon();
    if (o.environment) {
      this._checkEnvironment();
      var t = setTimeout(function () {
        self._checkEnvironment();
      }, 3000);
      this._cleanup.push(function () {
        clearTimeout(t);
      });
    }
    this._attachWindow(window);
    return this;
  };

  Detector.prototype.stop = function () {
    while (this._cleanup.length) this._cleanup.pop()();
    this._running = false;
    if (current === this) current = null;
    this._docs = new WeakSet();
    this._roots = new WeakSet();
    return this;
  };

  Detector.prototype.reset = function () {
    this._signals = {};
    this._fills = [];
    this._fillMap = new WeakMap();
    this._userTouched = new WeakMap();
    this._hosts = this._hosts || new WeakSet();
    this._notHosts = this._notHosts || new WeakSet();
    this._seenMarkers = new WeakSet();
    this._seenEvents = new WeakSet();
    this._roots = this._roots || new WeakSet();
    this._docs = this._docs || new WeakSet();
    this._artifacts = {};
    this._detectedFired = false;
    return this;
  };

  /**
   * Checks fields in `scope` (default: the document) for values that never came from user
   * input, and refreshes the environment and marker checks. Called by summary().
   */
  Detector.prototype.audit = function (scope) {
    var o = this.options;
    if (o.environment) this._checkEnvironment();
    if (o.markers) this._scanAttributeMarkers();
    if (!o.forms) return this;
    var root = scope || document;
    var fields = root.querySelectorAll ? root.querySelectorAll("input, textarea, select") : [];
    if (root.elements) fields = root.elements; // includes form-associated fields outside the <form>
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      if (!isField(el) || SKIP_TYPES[el.type] || el.disabled) continue;
      if (this._userTouched.has(el) || this._fillMap.has(el)) continue;
      if (!isDirty(el)) continue;
      this._fill(el, "no-user-input");
      this._signal("unexplained-value", { field: describe(el) });
    }
    return this;
  };

  Detector.prototype.report = function () {
    var signals = [];
    var all = [];
    var byAgent = {};
    for (var k in this._signals) {
      var s = this._signals[k];
      signals.push(s);
      all.push(s.weight);
      if (s.agent) (byAgent[s.agent] = byAgent[s.agent] || []).push(s.weight);
    }
    var agents = {};
    var best = null;
    for (var a in byAgent) {
      agents[a] = combine(byAgent[a]);
      if (!best || agents[a] > agents[best]) best = a;
    }
    var score = combine(all);
    var detected = score >= this.options.threshold;
    return {
      version: VERSION,
      verdict: detected ? "agent" : score >= 0.5 ? "suspected" : "none",
      detected: detected,
      agent: best && agents[best] >= 0.5 ? best : detected ? "unknown" : null,
      active: this._active,
      score: score,
      claude: agents[CLAUDE] || 0,
      agents: agents,
      signals: signals,
      filledFields: this._fills.slice(),
    };
  };

  /** Compact JSON-safe summary for sending to a server. `scope` limits fields to a form or element. */
  Detector.prototype.summary = function (scope) {
    this.audit(scope);
    var r = this.report();
    return {
      v: VERSION,
      verdict: r.verdict,
      agent: r.agent,
      active: r.active,
      score: r.score,
      claude: r.claude,
      signals: r.signals.map(function (s) {
        return s.name + ":" + s.count;
      }),
      fields: r.filledFields
        .filter(function (f) {
          return !scope || (scope.contains && scope.contains(f.element)) || (scope.elements && [].indexOf.call(scope.elements, f.element) !== -1);
        })
        .map(function (f) {
          return f.field + ":" + f.method;
        }),
    };
  };

  /** How `el` was last filled by an agent, or null. */
  Detector.prototype.agentFill = function (el) {
    return this._fillMap.get(el) || null;
  };

  /**
   * true when an AI browser agent is (or was) operating on this page.
   * Uses the running detector (see start()) for full behavioural evidence; without one,
   * checks what is visible right now: Claude's overlay, agent markers, automation globals.
   */
  function isAgent(detector) {
    var d = detector instanceof Detector ? detector : current;
    if (d && d._running) return d.audit().report().detected;
    if (typeof window === "undefined") return false;
    var running = current;
    var once = new Detector({ forms: false, keyboard: false, mouse: false, frames: false, activeProbeMs: 3600000 }).start();
    var detected = once.report().detected;
    once.stop();
    current = running;
    return detected;
  }

  return {
    VERSION: VERSION,
    SIGNALS: SIGNALS,
    Detector: Detector,
    start: function (options) {
      return new Detector(options).start();
    },
    isAgent: isAgent,
    isClaudeOverlayHost: isClaudeOverlayHost,
    isClaudeTabIcon: isClaudeTabIcon,
    automationArtifacts: automationArtifacts,
  };
});
