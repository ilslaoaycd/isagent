# How to detect Claude in Chrome: what it does to a page

These notes describe what a web page can observe while the Claude in Chrome extension is working on it. They're based on reading the extension's shipped JavaScript (version 1.0.107, November 2026) and on running that code against test pages. No extension code is reproduced here.

## Components that touch the page

| Piece | Where it runs | What the page can see |
|---|---|---|
| Accessibility-tree script (all frames, `document_start`) | Extension's isolated world | Nothing. Its globals live in the isolated world, and it only reads the DOM. |
| Overlay script (top frame, `document_idle`) | Isolated world | The overlay element (below) |
| Tools that change the page (`form_input`, the click guard, `find`, …) | Injected with `chrome.scripting.executeScript` into the isolated world | The DOM writes and events they cause |
| Mouse, keyboard, screenshots | `chrome.debugger` (Chrome DevTools Protocol) | Trusted input events with machine timing |

## The overlay

When Claude starts working on a tab, the extension creates one `<div>` with no attributes, attaches a **closed** shadow root, and appends it to `<body>`. Its stylesheet makes the host `display: contents`. Everything visible is inside that root: the orange glow, Claude's cursor and label, the Stop button and the "Claude is working" tag. Whenever new pieces are added, the extension moves the host back to the end of `<body>`. It also strips any attributes the page adds to it.

Consequences for a page:

- Ids such as `claude-agent-glow-border` exist but can't be queried. Detectors that look for them (some earlier versions put them directly in the page) no longer match.
- The host itself is visible: an empty, attribute-less `div` with `display: contents` whose `attachShadow()` throws because a root already exists. It stays in the DOM after the session ends.
- The Stop button and tag accept pointer events, so `document.elementsFromPoint()` at their positions returns the host while Claude is working. The extension's stylesheet notes it deliberately avoids `display: none` when hiding the tag for screenshots, so that a page can't time screenshots by hit-testing.

## Tools

**`form_input`** looks the element up from a reference map kept in the isolated world, scrolls it into view, and sets the value through the DOM property:

- **Text, textarea, number, date and range fields:** focuses the field, then dispatches plain untrusted `Event("change")` followed by `Event("input")`, both bubbling and not composed.
- **Select:** sets `selectedIndex`, focuses, then fires change then input in the same way.
- **Checkbox and radio:** focuses, then calls `element.click()` until the field is in the wanted state.

The change→input order never happens with real user input, and the events never leave a shadow root because they aren't composed.

**`computer` type**: for each character with a known key code, sends a CDP `keyDown` and `keyUp`, and starts all of them at once. Characters without a key code go through `Input.insertText`. The result is trusted keyboard events held for well under a millisecond with no gap between keys.

**`computer` click**: one CDP `mouseMoved` straight to the target, a ~100 ms pause, then `mousePressed` and `mouseReleased` with almost no hold. The animated cursor is drawn in the overlay only; the real pointer events don't follow a path.

**Debugger session**: attaching `chrome.debugger` shows Chrome's "started debugging this browser" bar. The extension then enables focus emulation, which makes a background tab report `visibilityState: "visible"`, `hasFocus() === true` and run `requestAnimationFrame` at full rate. A page can't tell such a tab from a foreground one.

**Favicon**: behind a feature flag, the extension can replace the page's icon with a Claude cursor `data:` SVG while it works.

## Is the extension trying to avoid detection?

We found **no evidence of evasion aimed at websites** in 1.0.107. The changes that reduce what a page can see look aimed at protecting the user and the agent from the page.

Evidence against evasion:
- Input isn't humanised. Keystrokes are dispatched in parallel, with no random delays or jitter. Clicks jump straight to the target. The only `Math.random` calls are API retry backoff.
- The agent's presence stays visible by design: a full-page glow, a Stop button and a status tag, all hit-testable. The stylesheet explicitly keeps the tag hit-testable during screenshots.
- `navigator.webdriver` and the user agent aren't touched. The extension simply runs in the user's normal browser.
- The extension recognises bot-check and CAPTCHA pages, for example "Just a moment…" or "verify you are human". This appears to be telemetry: it records whether the person, Claude or the page itself got past the check. It doesn't solve the challenge.

Changes that reduce what a page can observe, and their apparent purpose:
- **Overlay moved into a closed shadow root.** This stops pages from restyling, hiding or clicking the Stop button. Stop also ignores untrusted clicks and clicks at Claude's own click position. As a side effect, id-based detectors stopped working.
- **Label text drawn with CSS generated content and generic font names.** This stops a page from reading what Claude is doing via `window.find` or custom-font loading tricks.
- **Page-added attributes stripped from the host.** This stops a page from hiding or tagging the overlay.

These are consistent with defending against malicious pages, for example a prompt-injection page hiding the Stop button or reading Claude's actions. The behavioural fingerprints this project uses are untouched. That could change in any release, which is why the canary tests run the extension's own code.
