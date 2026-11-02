# Contributing to pre(f)light

Thanks for helping. Bug reports, ideas, testing on other platforms and pull requests are all welcome.

## Reporting a problem or an idea

Open an issue. For a bug, say what you did, what you expected and what happened, plus your OS, browser and GPU. Rendering problems are much easier to follow with a screenshot. For a security problem, don't open a public issue: see [SECURITY.md](SECURITY.md).

Results from **Windows and Linux** are especially useful, since only macOS has been tested so far: whether the converter builds, whether the app runs, and what you had to change.

## Setting up

Follow [Getting started](README.md#getting-started) in the README. You can work on most of the client and server without the SketchUp SDK; you only need it to import venues or to work on `converter/`.

[docs/architecture.md](docs/architecture.md) shows how the client and server are put together and which way dependencies should point. Read it before a change that moves code between layers, and update it when your change moves a boundary.

## Before you open a pull request

Run the checks that CI runs (formatting, lint, unused code, types, tests and the client build):

```
npm run check
```

`npm run format` fixes the formatting, and `npx eslint . --fix` fixes the lint findings that have an automatic fix. For a change to the client, also run the browser tests, `npm run test:e2e` (the first time, `npx playwright install chromium` downloads the browser). Then try the change in the running app (`npm run dev`), especially anything that renders.

What the checks enforce, and what a review looks at beyond them, is in [docs/engineering.md](docs/engineering.md).

- Keep a pull request to one change, and say in its description what it does and how you checked it. A screenshot helps for anything visible.
- Write code that reads like the code around it: the same naming, structure and amount of comments. Comments explain why something is done, not what the next line does.
- Add or update tests next to the code (`*.test.ts` in `server/src/`, `client/src/` or `shared/src/`) when you change logic, and in `server/src/index.test.ts` when you change what a route accepts. Test data must be made up.
- Update the README (and `docs/roadmap.md`) when you change what the app can do or how it's set up.
- Commit messages are one plain sentence that says what the change does, for example "Hide small floor objects while the rider plan is being placed".

## Keep other people's files out

Don't commit venue models (`.skp`, `.glb` of real venues), tech riders, patch plans or the SketchUp SDK. They usually belong to someone else, and the SDK's license doesn't allow redistributing it. `.gitignore` covers the usual paths; check `git status` before you commit anyway.

## License

By contributing, you agree that your contributions are licensed under the project's licenses: the [AGPL-3.0-or-later](LICENSE) for everything except `converter/`, which is under the [MIT License](converter/LICENSE).
