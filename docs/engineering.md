# Engineering guidelines

What a change is checked against in review. [CONTRIBUTING.md](../CONTRIBUTING.md) says how to submit a change, [architecture.md](architecture.md) says where code belongs; this file says what good code looks like here. The tools below enforce what they can, so a review can spend its time on the rest.

## Principles

1. **Deep modules.** A module should hide a lot behind a small interface. `FixtureRig` is the example: a thousand lines of lights, shadows and gobos behind `sync(fixtures)`. A function or class that only passes its arguments on to another adds a name to learn and hides nothing; leave it out. (After John Ousterhout's *A Philosophy of Software Design*.)
2. **Plain logic, framework at the edges.** Maths and rules (aiming, placement, crowd density, undo, rider mapping) take plain data and return plain data, with no Vue, Babylon, DOM or file system in them. Vue, Babylon and Node are a thin layer around that logic. This is what makes it testable.
3. **One owner for each piece of state.** Every value has one place that holds it and changes it; everything else reads it or asks the owner. The 3D scene is drawn from the stores, never the other way round.
4. **Dependencies point down.** Components use stores, stores use domain code, never the reverse. The layers and what each may import are in [architecture.md](architecture.md).
5. **Check data where it enters, trust it inside.** Request bodies, uploaded files, `localStorage`, JSON from disk and anything a vision model returns are checked for shape, type and size where they come in. A request body is checked against its zod schema in `shared/requests.ts` (`readBody` on the server); a new endpoint gets a schema there, not checks written by hand. Past that point the types are true, and code does not check them again.
6. **Say what failed.** An expected failure (a bad upload, a model that cannot be converted, a full disk) reaches the user as a message that says what happened and what to do. A bug throws. An empty `catch` needs a comment saying why ignoring the error is safe (as in `venues.ts` when `localStorage` is unavailable).
7. **Whoever creates something disposes it.** Babylon meshes, materials and textures, event listeners, timers, observers and object URLs each have an owner that releases them, usually in `dispose()` or `onBeforeUnmount`.
8. **Abstract on the third use.** Copying something once is cheaper than the wrong abstraction. When the third copy appears, extract it. No interfaces, factories or layers without a second implementation or caller that needs them.

Comments and names follow CONTRIBUTING: read like the code around it, and comments say why, not what.

## Vue and the client

- Components use `<script setup lang="ts">`. Data goes down as props, changes come up as events or store actions; a component does not reach into a sibling.
- State that more than one component needs lives in a store. State one component needs stays in it.
- Prefer `computed` to a `watch` that copies a value. A `watch` is for side effects (talking to the scene, saving, timers).
- Babylon objects never go into reactive state: keep them in plain variables, or use `shallowRef` / `markRaw`. Vue would wrap them in proxies, which is slow and breaks identity checks.
- Modes that exclude each other are one value with a type per mode (a discriminated union), not several booleans. What the next click in the view does is one such value (`stores/interaction.ts`).
- App-wide keyboard shortcuts are entries in `input/keymap.ts`, never a component's own window listener. A component handles keys only inside its own window or field, and stops them there.

## TypeScript

- `strict` is on in both workspaces, plus `noImplicitOverride`, `noImplicitReturns` and `noFallthroughCasesInSwitch`. `noUncheckedIndexedAccess` is the next to turn on: it finds about 260 places today, most of them in `Viewer.vue`, `scene/Crowd.ts` and the rider patch reader (`server/src/rider/patch.ts`), so it comes with their refactoring.
- No `any`. Data from outside starts as `unknown` and is narrowed by the code that checks it.
- A non-null assertion (`!`) or a cast (`as`) needs a reason the compiler cannot see, and a comment when the reason is not obvious from the next line.
- What the client and the server exchange is declared once, in `shared/` (`@preflight/shared`), together with maths both sides run. Nothing there may import Node, the DOM, Vue or Babylon (see [architecture.md](architecture.md#shared-code)).

## Tests

- Pure logic gets unit tests next to the code it tests (`*.test.ts`): maths, parsing, mapping, undo, checks of request bodies. The server's and `shared/`'s run on `node:test`, the client's on Vitest.
- Server routes are tested over HTTP (`server/src/index.test.ts`): the tests start the server in its own process, with its venues in a temporary folder.
- Rendering is covered by a browser smoke test (`e2e/smoke.spec.ts`, Playwright) that opens the demo club, checks the view shows more than one flat color, and fails on any console error. Whether the picture looks right is checked by eye in the running app, as CONTRIBUTING says.
- A test name is a sentence that says what should happen ("refuses a model that is empty, …").
- Test data is made up. Never commit a real venue, rider or patch.

## Size as a smell

These numbers do not fail anything. Crossing one is a reason to look for a seam, and to say in the review why there is none when that is the case.

- A function longer than about 60 lines, or nested more than three levels deep.
- A component with more than about 300 lines of script, or more than about 10 watchers.
- A module that more than half of its layer imports, or that imports more than half of another layer.

## Review

Each comment in a review says how much it matters:

- **Must fix:** a bug, a data loss, a leak, a security problem, or a break of the dependency rule. The change does not go in until it is fixed.
- **Should fix:** a design problem from the principles above. Fix it in the change, or open an issue for it and link it.
- **Nit:** a matter of taste. The author decides.

Formatting, unused code and anything the tools below catch are not review comments: the checks report them.

## Tools

| Check | Command | What it enforces |
|---|---|---|
| Format | `npm run format` (fixes), `npm run format:check` | Prettier, configured in `.prettierrc.json` to the existing style: no semicolons, single quotes, lines up to 160 characters. |
| Lint | `npm run lint` | ESLint with typescript-eslint and eslint-plugin-vue (`eslint.config.js`), including rules that need type information, such as unhandled promises. |
| Unused code | `npm run knip` | Unused files, dependencies, and exports that nothing outside their own file uses (`knip.json`). |
| Types | `npm run typecheck -w shared`, `npm run typecheck -w server`, `npx tsc --noEmit -p e2e`, `npm run build -w client` | `tsc` and `vue-tsc` with the settings above. |
| Tests | `npm test -w shared`, `npm test -w server`, `npm test -w client` | The unit tests and the server's route tests. |
| Browser | `npm run test:e2e` | The smoke test in a headless Chromium. It starts its own server and client on ports 3199 and 5199, with an empty scratch data folder. The first time, install the browser with `npx playwright install chromium`. |

`npm run check` runs all of them except the browser test, in the order CI does; CI runs the browser test as a job of its own.

ESLint sees the types a `.vue` file exports as `any`, so a type that more than one file uses belongs in a `.ts` file (as `MenuItem` in `components/contextMenu.ts`).

Prettier formats a click handler with two statements (`a(); b()`) onto two lines without a semicolon, which Vue then cannot compile. Put such a handler in a function in the script.
