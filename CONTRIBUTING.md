# Contributing

Issues and pull requests are welcome, especially:

- **A detection stopped working** after an agent update. Include the agent name and version. If it's Claude in Chrome, the output of `npm run canary` helps.
- **False positives.** Describe the input method (keyboard, touchpad, on-screen keyboard, password manager, voice input), browser and OS.
- **New agents.** Please include a way to reproduce the agent's behaviour in a test.

Ground rules:

- Every signal needs a positive test and, where it touches user input, a test that ordinary human-like input doesn't trigger it.
- Don't add code copied from an agent's source. Describe the behaviour and write an independent check or replica.
- `npm run build` and commit `dist/` with source changes. CI checks they match.
