# A hosted version of pre(f)light

Status: **design proposal, nothing here is built.** pre(f)light is released to run locally or self-hosted. This document looks at what a hosted, multi-user version would take, so the decision can be made later with the costs and risks in view. It is based on the code as of November 2026 (`server/src/`, `client/src/`, `converter/`).

## Summary and recommendation

A hosted version is feasible and cheap to run for a small user base (roughly €25-50 a month), but **not with the SketchUp converter on the server**. The Trimble developer terms that cover the SketchUp C SDK forbid using it "for hosting, service provider, or like purposes" without Trimble's written approval, and the SDK only runs on Windows and macOS anyway. The rest of the server (venues, fixtures, rider patch reading, the fixture catalog) moves to a multi-user setup without trouble.

Recommended path:

1. **First, changes that make self-hosting better as well** (Phase 0): accept GLB/glTF uploads next to `.skp`, put storage behind an interface, move conversion behind a job interface, bind to `127.0.0.1` by default, check `Origin`, and add a revision number to venues so two tabs cannot overwrite each other without noticing. Every one of these helps self-hosters (Linux users cannot build the converter today) and none of them needs a hosted version to exist.
2. **Then the smallest useful hosted version** (Phase 1): invite-only, personal accounts, Postgres plus S3-compatible storage, GLB/glTF uploads only (with a small SketchUp extension that exports a pre(f)light-ready GLB from the user's own SketchUp), AI rider reading with the user's own key only, read-only share links, hosted in the EU.
3. **Teams, a paid AI quota and live collaboration later** (Phases 2-3), only if Phase 1 finds users.

Self-hosting stays the default: one codebase, one container image, and every hosted-only part switched off unless configured. On the license: both AGPL-3.0 and MIT let the owner run a hosted version. AGPL-3.0 fits this plan better if the hosted version is meant to run the same open code and the owner wants others' hosted forks to stay open; MIT fits better if a closed, hosted-only layer might come later. Either way, `converter/` should carry a permissive license (or an explicit linking exception), because it links a proprietary SDK. Details in [Licensing](#licensing).

## Where the code is today

What a hosted version has to change, by file:

| Area | Today | Why it matters for hosting |
|---|---|---|
| Server entry (`server/src/index.ts`) | A plain `node:http` server; `server.listen(PORT)` binds every interface. No login, no sessions, no CORS headers. `readBody` does not check the content type. | Anyone who can reach the port can read, change and delete every venue. A web page can send a `text/plain` POST to it (a "simple" request, no CORS preflight), and a DNS-rebinding page can read it. Also a concern for self-hosting. |
| Venues (`server/src/services/venues.ts`) | One folder per venue in `server/data/venues/<id>/`: `venue.json` (name, order, fixtures, groups, views, crowd, atmosphere), `model.skp`, `model.glb`, and for riders `rider.pdf` and `rider.json`. Venue ids are UUIDs. `sortIndex` is global. `listVenues` reads the whole folder. `updateVenue` is read-modify-write with no lock. | No owner on a venue; one global order; last write wins (`PUT /fixtures` replaces the whole list, so two tabs or two people silently overwrite each other). |
| Sizes | The sample venue: `.skp` 10 MB, `.glb` 10.8 MB, rider PDF 3.4 MB, `venue.json` 72 KB. | About 25 MB per venue with a model and a rider. |
| Uploads | `.skp` up to 500 MB (`MAX_UPLOAD`), checked by magic bytes and hashed while streaming. Rider PDFs up to 40 MB. | 500 MB is fine on your own machine, too much for a free hosted account. |
| Converter (`server/src/services/convert.ts`) | `execFile` of `converter/build/skp2glb` inside the upload request, timeout 120 s. The converter "version" is the binary's size and modification time. | Native code parsing untrusted files, in the API process's user, during an HTTP request. The version scheme only works with one binary on one machine. |
| GLB download | Streamed from disk with `cache-control: immutable`; the URL carries `modelHash` and `converterVersion`. | Good for a CDN or presigned URLs: the URL is already content-addressed. |
| Rider (`server/src/rider/`) | The PDF's patch table is read from its text (no AI). The plan is read by a vision model: the page is rendered at 300 dpi with pdf.js and `@napi-rs/canvas`, then 1 layout request plus 3 band requests, plus up to 3 more for lights the patch has and the plan did not show: **4-7 image requests per plan**. The rendered crop is cached in a process-wide `Map`. | Rendering untrusted PDFs at 300 dpi is CPU- and memory-heavy (an A0 page at 300 dpi is about 140 megapixels, over 500 MB as RGBA). The cache is per process. |
| API key | The client keeps the key in `localStorage` (`preflight.visionKey`) and sends it in the body of every `POST /rider/plan`. The server uses it for that request only, or falls back to `ANTHROPIC_API_KEY` from the environment. The client can also pick the `model`. | On a hosted server the fallback would make the operator pay for every user, on any model the client names. |
| WebSocket (`/ws`) | Sends `{type: 'hello'}`, nothing else; reserved for live DMX. No auth. | Needs auth on upgrade before it carries anything. |
| Client | Same-origin `fetch('/api/...')` (the Vite dev server proxies `/api` and `/ws`). Viewer settings and camera poses in `localStorage`. No notion of a user, and no read-only mode. | Serving the built client from the same origin as the API keeps this unchanged. A share link needs a read-only mode. |
| Catalog | Read-only fixture catalog in `server/catalog/` (OFL data, MIT), plus `custom.json`. | Shared by all users; custom fixtures would later be per team. |

## Accounts and auth

### Hosted

- **Sign-in:** email magic links plus "Sign in with Google / GitHub" (OAuth/OIDC). No passwords to store, and lighting people mostly have one of those accounts. A maintained auth library or a small hand-written OIDC flow both work; the session itself should live in Postgres, not in a third-party service, so the same code serves self-hosters.
- **Sessions:** an opaque session id in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, looked up in a `sessions` table. Cookies keep the client's plain `fetch('/api/...')` calls unchanged.
- **CSRF:** reject state-changing requests whose `Origin` is not the app's own, and require `content-type: application/json` on JSON endpoints (today `readBody` accepts anything). The raw-body upload endpoints check `Origin` too.
- **WebSocket:** the same cookie is checked on upgrade, plus the `Origin` header.
- **Authorization:** every venue route resolves the venue *and* checks that the session's user may read or write it. Every venue route already finds its venue through one helper, `venueOf(id)` in `server/src/routes/venues.ts`; it grows into `requireVenue(req, id, 'read' | 'write')`, so a forgotten check is easy to grep for.

### Self-hosted

Three modes, chosen by config:

| `AUTH` | For | Behaviour |
|---|---|---|
| `none` (default) | One person on their own machine | Today's behaviour, but bound to `127.0.0.1` unless `HOST` says otherwise, and with the `Origin`/`Host` checks above (they stop the cross-site and DNS-rebinding cases at no cost). Refuses to start on a non-loopback address without `AUTH` set, unless `ALLOW_UNAUTHENTICATED=1`. |
| `password` | A crew on a show LAN or a small team's server | One shared password (or a few named ones) from the environment; sets the same session cookie. |
| `oidc` | A company or collective with an identity provider | Sign in through any OIDC provider (Authentik, Keycloak, Google Workspace, ...). Same user and team model as hosted. |

The hosted version is `AUTH=oidc` plus magic links and sign-up, so it is the same code path, not a fork.

## Storage

### Data model

Keep the venue as one document, as it is now. The client already sends whole lists (`PUT /fixtures` with fixtures and groups, `PUT /views`), the server validates them as a whole (against the schemas in `shared/requests.ts`), and the document is small (72 KB for the sample venue, capped at 1 MB by `readBody`). Splitting fixtures into rows would mean rewriting the API and the client stores for no gain at this size.

Postgres tables (sketch):

| Table | Columns |
|---|---|
| `users` | id, email, name, created_at |
| `teams` | id, name, created_at (every user gets a personal team at sign-up) |
| `memberships` | team_id, user_id, role (`owner`, `editor`, `viewer`) |
| `venues` | id (UUID, as today), team_id, name, sort_index (per team), status, error, revision, doc (JSONB: fixtures, groups, views, crowd, atmosphere, hiddenTags), model_blob, model_hash, converter_version, created_at, updated_at |
| `blobs` | key, team_id, kind (`skp`, `glb`, `pdf`, `rider`), size, sha256, created_at |
| `share_links` | token (random, 128 bits), venue_id, created_by, expires_at, revoked_at |
| `jobs` | id, kind (`convert`, `validate-glb`, `render-plan`), venue_id, state, attempts, error, created_at, finished_at |
| `usage` | user_id, day, uploads, bytes, conversions, ai_requests |

`rider.json` becomes a JSONB column or a blob; the rider PDF is a blob.

### Files

Blobs go to S3-compatible object storage (Cloudflare R2, Hetzner Object Storage, Backblaze B2, MinIO for self-hosters who want it). Keys are content-addressed: `teams/<team>/<sha256>.glb`. That fits what the code already does (the model URL already carries the hash, and uploading the same file again already skips conversion), makes "Duplicate venue" a metadata copy instead of copying 20 MB, and lets GLBs be served with `immutable` caching from a CDN or through short-lived presigned URLs. Deleting is a reference count or a periodic sweep of blobs no venue points at.

Serve user files from a separate origin (for example `files.<domain>`) with an explicit `content-type` and `X-Content-Type-Options: nosniff`, so an uploaded file can never run as a page on the app's origin.

### Concurrency

Add `revision` to every venue and make writes conditional: the client sends the revision it last saw (`If-Match` or a body field), the server answers `409` with the current venue when it has moved on, and the client reloads that part and tells the user. This is needed even for one person with two tabs, so it belongs in the open codebase first. Live collaboration (below) builds on it.

### One code path, two backends

Put the current functions behind two interfaces:

- `VenueStore`: `list(teamId)`, `get(id)`, `create`, `update(id, patch, expectedRevision)`, `delete`, `reorder`, `duplicate`. Implementations: the current JSON files (default), and Postgres. SQLite would be a reasonable middle ground for self-hosters with several users, but two implementations are enough to maintain.
- `BlobStore`: `put(stream) -> key`, `get(key)`, `url(key)`, `delete(key)`. Implementations: local disk (default) and S3.

`DATABASE_URL` unset means JSON files, `STORAGE=fs` means local disk: exactly today's layout, so existing self-hosted data keeps working without a migration. A one-off `migrate-to-postgres` tool can import a data folder into a team for people who move from self-hosted to hosted, and the reverse (export a venue as a zip of `venue.json`, GLB and rider) is the "export my data" button the hosted version needs anyway.

## The SketchUp converter

### The license question comes first

`SketchUp_SDK/Trimble-Developer-Terms.url` points to the Trimble Developer Terms (v2.1 when read for this proposal; not a lawyer's reading, check with Trimble or counsel before relying on it). The relevant clauses:

- **2.5(c)** forbids using the Trimble software "for hosting, service provider, or like purposes".
- **2.7.1** limits use to development; distributing a solution built on it to customers needs Trimble's prior written approval. **2.7.2** exempts extensions that run inside SketchUp, and explicitly not integrations that embed SketchUp functionality in a third-party application or service.
- **2.2, 2.3, 2.5(c)**: the license cannot be passed on, and the SDK cannot be shared or sublicensed.
- **2.1**: you register with Trimble to get the SDK.

So a hosted service that converts users' `.skp` files with the C SDK is, as far as these terms go, not allowed without a separate agreement with Trimble. This is also why the converter cannot be shipped as a prebuilt binary with the open-source release, which the README already hints at.

If the owner wants server-side `.skp` conversion anyway, the step is to ask Trimble for written approval, describing the service. Everything below assumes that has not happened.

### Platform

Even with approval, the C SDK only exists for Windows and macOS, so a converter worker would need a Windows VM (roughly €30-60 a month with a Windows license) or a cloud Mac (Scaleway or MacStadium around €80-150 a month; AWS Mac instances are billed per day at a minimum and cost more). The rest of the stack runs on Linux.

### Sandboxing, if it ever runs on a server

The converter feeds untrusted files to a closed-source parser. Treat a bug in it as code execution:

- **Separate worker**, never the API process. The API stores the upload, inserts a `jobs` row and answers `202`; the worker takes jobs from Postgres (`SELECT ... FOR UPDATE SKIP LOCKED`, or a library like pg-boss), so no Redis is needed.
- **No credentials on the worker.** Each job carries a presigned GET URL for the input and a presigned PUT URL for the output, valid for minutes. The worker has no database password and no storage keys.
- **No network** other than the storage endpoint, a CPU, memory and wall-clock limit per conversion (the current 120 s timeout is a sensible start), a fresh temporary folder per job, and the VM reset from an image regularly. On Windows a process-isolated container or a throwaway VM; on macOS a Tart/Virtualization.framework VM.
- **An explicit converter version** (a constant compiled into the binary, printed by `skp2glb --version`) instead of the binary's size and modification time, so several workers agree on it.
- **Validate the output** like any uploaded GLB (below) before swapping it in.

The client then needs a "converting" state: today `uploadModel` waits for the converted venue in the upload response. A new venue `status: 'converting'` plus polling `GET /api/venues/<id>` (or a message on the WebSocket) covers it, and works for self-hosting too, where the "worker" is the same process.

### Alternatives (recommended for hosted)

1. **Accept GLB/glTF uploads directly.** The viewer already loads GLB; the server only needs to accept it, check it and store it. This also helps self-hosters on Linux, or anyone who does not want to register for the SDK. Checks, in the worker or a size-limited step in the API:
   - the [Khronos glTF validator](https://github.com/KhronosGroup/glTF-Validator) (Apache-2.0, has a JavaScript build) for structure;
   - **embedded resources only**: reject external `uri`s, so a model cannot make viewers' browsers fetch images from someone else's server (which would leak their IP addresses through share links);
   - limits on vertices, textures and texture size, so one upload cannot exhaust a viewer's GPU;
   - optionally recompress with glTF-Transform (meshopt geometry, smaller textures). Babylon reads `EXT_meshopt_compression` and `KHR_texture_basisu` with its loaders. The 10.8 MB sample GLB would likely shrink a lot, which cuts storage, egress and load time.
2. **A pre(f)light exporter extension for SketchUp.** A small Ruby extension, run inside the user's own SketchUp, that writes a GLB the way `skp2glb` does: one node per tag named `tag:<name>`, inches to meters, Z-up to Y-up, materials and textures inherited from groups. This is what clause 2.7.2 allows, it works for every SketchUp user without the SDK, and it keeps the model tags feature. It is a rewrite of the converter's logic (about 500 lines of C++) in Ruby, so a medium-sized job, and it could also upload straight to a pre(f)light server.
3. **SketchUp's own exports.** SketchUp exports COLLADA (`.dae`) in every edition and OBJ/FBX in Pro, and glTF through third-party extensions. These lose the `tag:<name>` structure, so the Model tags panel would be empty. Good enough as a documented fallback ("export glTF, upload it"), not as the main path.
4. **Client-side conversion.** The SDK is a native library with no WebAssembly build, so "conversion in the browser" is not possible with it. The client-side option is really option 2 (inside SketchUp) or a desktop helper that wraps `skp2glb` for people who have the SDK.

Recommendation: hosted accepts GLB/glTF only, with option 2 as the main way in and option 3 documented. Self-hosted keeps the native `.skp` converter for those who build it.

## AI rider import

The patch table is read from the PDF's text with no AI and costs nothing; only the plan reading uses a vision model.

### What one plan read costs

4-7 image requests (see above) to `claude-opus-5-5` by default (`DEFAULT_MODEL` in `vision/anthropic.ts`). Images are downscaled by the API to 2576 px on the long edge, about 4,800 tokens each at most, and each request allows up to 8,000 output tokens. Opus 5.5 costs $4 per million input tokens and $20 per million output tokens (list price, October 2026), and its thinking cannot be switched off (default effort `medium`). Roughly: 20-35k input tokens ($0.08-0.14) and 10-40k output tokens ($0.20-0.80), so **about $0.30-1.00 per plan read**, more when the plan has to be read again. This should be measured on a few real riders (the API returns token counts in `usage`) before any pricing decision. Sonnet 5.5 is half the price per token and might be good enough; that is an accuracy question to test, not to assume.

### Who pays

| Option | Key handling | Fit |
|---|---|---|
| **A. The user's own key, through the server (today)** | The key travels in the request body. The server must never store or log it (scrub request bodies from logs and error reports), and must not fall back to `ANTHROPIC_API_KEY` in hosted mode. | Works on day one. Users have to trust the operator with their key in transit. |
| **B. The user's own key, from the browser** | The browser calls the Anthropic API directly (it allows this with the `anthropic-dangerous-direct-browser-access` header). The key never reaches the server. The page rendering and cropping move to the browser (pdf.js runs there natively, crops are a canvas), and the prompts and parsing in `vision/plan.ts` are mostly plain functions that could be shared between client and server. | Cleanest for privacy and for the operator (no key, no cost, no PDF rendering on the server). A medium refactor, and keys in `localStorage` are exposed to any XSS on the app's origin, which raises the bar on the client's security. |
| **C. The operator's key, with a quota** | Server-side key in a dedicated Anthropic workspace with a monthly spend limit as a backstop. The model is pinned by the server (ignore `body.model`). | Best experience, but it costs real money per use, so it belongs with a paid plan. Needs per-user limits (for example a few plan reads a month free), a global daily cap, and rider PDFs then go to Anthropic as the operator's subprocessor, which the privacy policy has to say. |

Recommendation: hosted Phase 1 offers A with the safeguards (no storage, no logging, no env fallback, server-pinned model list); B is the better long-term design and is worth doing in the open codebase because self-hosters gain from it too; C waits until there is a paid plan.

### Rate limits and resource limits

Independent of who pays: one plan read at a time per user, a daily cap per user (say 20), the PDF limited to 20 MB and 100 pages in hosted mode, the rendered page limited in pixels (render large-format pages at a lower dpi instead of 300), and rendering in the worker, not the API process. The in-memory `planImages` cache becomes a blob (or is dropped) once there is more than one server process.

## Sharing and collaboration

### Read-only view links (Phase 1)

`share_links` with a random token: `/v/<token>` opens the viewer for that venue, read-only. The server exposes only a read endpoint for the venue document and the GLB behind the token. The client needs a read-only mode: hide the editing tools (the gizmo row, "+ Place light", the inspector's inputs, the Venues window), keep the camera, the saved views, haze and screenshots. Links can be revoked and given an expiry, pages carry `noindex`, and a link shows one venue, not the team's list.

This is the most useful sharing feature for a planning tool: send the venue to the band's LD, the venue's tech or the client, who look around without an account.

### Teams (Phase 2)

Each venue belongs to a team; every user has a personal team, and can create more and invite people by email with a role (owner, editor, viewer). Copying lights between venues (`/append`, the "Import from another venue" feature) is limited to venues the user can read. Custom fixtures (`server/catalog/custom.json`) become per team.

### Live collaboration (Phase 3)

With `revision` and 409s in place, two editors already cannot destroy each other's work, only interrupt it. Live editing over the WebSocket would mean: a room per venue, the server broadcasting each accepted change (a light's values, a moved fixture) with its new revision, clients applying them, and presence ("Alex is editing 3 lights"). The changes are coarse and per light, so a simple "last change per light wins" with broadcasts is enough; a CRDT library would be more machinery than this needs. Undo stays local to each person, as it is now.

### Live DMX and the WebSocket

The socket is reserved for Art-Net/sACN input. Those are UDP protocols on the show network, usually broadcast or multicast; neither a cloud server nor a browser can receive them. So live DMX is a local feature by nature:

- Self-hosted on the show LAN (today's design) is the natural home for it.
- A hosted version could support it later through a small **bridge** program on the show LAN that receives DMX and forwards frames over an outbound WebSocket to the server, which relays them to the viewers of that venue (or, simpler and with less latency, straight to a browser on the same machine through a local WebSocket).

Recommendation: keep live DMX a self-host feature until someone asks for it hosted. When it comes, the socket needs auth on upgrade (above), one room per venue, and a frame-rate cap per connection (DMX runs at up to 44 frames a second per universe).

## Hosting and cost

Assumptions for "small": up to 100 active users, about 500 venues, about 15 GB of files, light use of the rider reader. Prices are rough late-2026 list prices.

| Item | Option | Monthly |
|---|---|---|
| App server (API, worker, Postgres in Docker, Caddy for TLS) | One VPS at Hetzner (4 vCPU, 8 GB, 20 TB traffic) | €10-20 |
| ...or managed | Fly.io / Render for the app, Neon / Supabase for Postgres | $25-60 |
| Object storage | Cloudflare R2 ($0.015/GB, no egress fees) or Hetzner Object Storage | €1-6 |
| Backups | Nightly `pg_dump` to object storage, plus versioning on the bucket | €1-2 |
| Email (magic links) | Postmark or Resend | €0-15 |
| Domain, monitoring (uptime check, error reporting free tiers) | | €2-5 |
| AI plan reading | Option A or B: user pays | €0 |
| | Option C: about $0.30-1.00 per read | per use |
| SketchUp converter worker (only with Trimble's approval) | Windows VM or cloud Mac | +€30-150 |
| **Total, recommended Phase 1** | VPS + R2 + email | **about €25-50** |

Traffic: a 10 MB model per first open is cached by the browser (the URL never changes for the same file), and R2 has no egress fees; recompressing models (above) cuts it further. The client bundle (about 6 MB) belongs behind the same CDN with long cache lifetimes. The GPU work happens in the user's browser, so the server never renders anything except rider pages.

Location: host in the EU. Rider PDFs carry crew names and phone numbers, venue plans may be confidential, and the operator is in Germany, so GDPR applies (privacy policy, a processing record, data export and deletion, Anthropic listed as a subprocessor for option C), and a public German site needs an Impressum.

### Upload limits and abuse prevention

| Limit | Self-hosted default | Hosted, free account |
|---|---|---|
| Model upload | 500 MB (today) | 100 MB |
| Rider PDF | 40 MB (today) | 20 MB, 100 pages |
| Storage per team | none | 1 GB |
| Venues per team | none | 25 |
| Conversions / validations | none | 20 a day |
| Plan reads | none | 20 a day, one at a time |

Plus: sign-up by invite or with a verified email before the first upload; per-IP and per-user rate limits on sign-up, uploads and share-link views; uploads streamed with the size check that `receiveSkp` already does (and a request timeout); a report link on shared pages; and admin tools to disable an account and its share links. The files are parsed, never executed or shown as HTML, so the main abuse risks are storage and CPU use, hostile files aimed at the parsers (hence the worker and the GLB checks), and share links used to host unrelated content (hence quotas, revocation and the separate file origin).

## Keeping self-hosting first-class

- **One codebase, one container image.** No hosted fork. The hosted version is a configuration of the same server.
- **Defaults are today's behaviour:** JSON files and local disk, no login, the native converter if built. Each hosted feature is behind a setting, and an unset setting means the self-host behaviour.
- **A small config module** (`server/src/config.ts`) reads and checks the environment once at start: `HOST`, `PORT`, `AUTH`, `DATABASE_URL`, `STORAGE` and the S3 settings, `CONVERTER` (`local`, `queue` or `off`), `AI_KEYS` (`user`, `server` or `off`), the limits above, and `PUBLIC_URL`. It fails loudly on unsafe combinations (no auth on a public address).
- **Hosted-only parts are modules that do nothing when unset** (sign-up, quotas, email, later billing), not `if (hosted)` branches spread through the routes.
- **Tests run against both backends** (JSON files and Postgres) in CI, so the self-host path cannot rot.
- **Data moves both ways:** export a venue or a whole team as files, import them on another server.
- **Self-hosters get the improvements first:** GLB uploads, the job interface, `revision`, safer defaults and the browser-side rider reading are all useful without a hosted version.

## Licensing

Not legal advice; this is the shape of the decision.

- **The owner can host under either license.** A license governs what others may do with the code; the copyright holder can always run their own code. The difference is what *others* may do, and what happens to contributions.
- **AGPL-3.0:** anyone who runs a modified version as a network service must offer its users the source (section 13). That stops a third party from running a closed hosted fork. The owner is bound in the same way for code that others contributed under the AGPL, so a hosted version would have to publish its own changes too, unless contributors sign a CLA that lets the owner relicense. With a plain DCO (sign-off), the hosted version stays as open as the project. That matches this proposal, where hosted is the same code with config flags.
- **MIT:** anyone can run a closed hosted fork, including commercially. The owner can freely mix in closed code later (billing, abuse tooling, a hosted-only feature). Fewer obligations means fewer reasons for companies to avoid it.
- **Dependencies** are compatible with both: Babylon.js and pdf.js are Apache-2.0, `ws` and `@napi-rs/canvas` are MIT, the Open Fixture Library data is MIT (its license is kept next to the catalog).
- **The converter is the exception.** `converter/` links the proprietary SketchUp SDK. A GPL-family license on code that must be linked to a proprietary library creates a conflict for anyone who builds and distributes it. Give `converter/` a permissive license (MIT) whatever the main project uses, or add an explicit exception that allows linking it to the SketchUp SDK. The server only spawns it as a separate program, so it does not pull the server into that question.

If the hosted version is meant to stay the same open code, AGPL-3.0 with a DCO is the consistent choice. If keeping the option of a closed hosted layer matters more, MIT. Choosing AGPL without a CLA is hard to undo later; choosing MIT and switching later only affects new versions.

## Phased plan

### Phase 0: groundwork in the open codebase (useful without hosting)

| Item | Size |
|---|---|
| Bind `127.0.0.1` by default, `HOST` setting, `Origin`/`Host` checks, JSON content-type required | S |
| Config module | S |
| Accept GLB/glTF uploads (validation, embedded resources only, limits) next to `.skp` | M |
| `VenueStore` and `BlobStore` interfaces with the current file implementation | M |
| `revision` on venues, conditional writes, 409 handling in the client | M |
| Conversion behind a job interface (in process), `converting` status, explicit converter version | M |
| Dockerfile (without the SDK) | S |

### Phase 1: smallest useful hosted version (invite-only beta)

| Item | Size |
|---|---|
| Accounts: magic links and Google/GitHub, sessions in Postgres, personal team per user, `requireVenue` checks on every route | M/L |
| Postgres `VenueStore`, S3 `BlobStore`, presigned or CDN model URLs, separate file origin | M |
| Worker process with a Postgres job queue for GLB validation/recompression and rider page rendering | M |
| Quotas and rate limits | S/M |
| Read-only share links and the client's read-only mode | M |
| Rider plan reading with the user's key only, no storage or logging of keys, no env fallback, model list pinned | S |
| SketchUp exporter extension (Ruby) that writes a pre(f)light GLB with tags | M/L |
| Export and delete account, backups, privacy policy, Impressum, EU hosting | M |

Not in Phase 1: teams, server-side `.skp` conversion, operator-paid AI, live collaboration, live DMX.

### Phase 2: if people use it

Teams with roles and invitations; per-team custom fixtures; browser-side rider reading (option B); a paid plan with an included AI quota (option C) if users ask for it; usage overview for the operator.

### Phase 3: later

Live collaboration over the WebSocket (rooms, broadcasts, presence); comments on shared venues; a DMX bridge for hosted live input; server-side `.skp` conversion only with Trimble's written approval and the sandboxed worker described above; MVR import (which brings its own geometry and fixture positions and needs no SketchUp at all).

## Open questions

1. **Audience and money:** who is the hosted version for (groovejet's own crews, other lighting designers, venues), and should it ever charge? That decides whether option C and billing are ever needed.
2. **Trimble:** is it worth asking Trimble whether a hosted converter could be approved? Until then, server-side `.skp` conversion is off the table.
3. **The exporter extension:** is a SketchUp extension acceptable as the main way to get models into the hosted version, and is it worth publishing in the Extension Warehouse?
4. **License:** AGPL-3.0 (with a DCO or a CLA?) or MIT, and MIT for `converter/` in either case?
5. **Accuracy vs. cost of the plan reader:** how well does Sonnet 5.5 read real riders compared with Opus 5.5, and what does a read really cost? A small measured set of riders answers both.
6. **Browser-side rider reading:** is moving the plan reading into the client (option B) worth the refactor, given that the CLI tools (`read-rider`, `rider-overlay`) also use it?
7. **Read-only links:** may viewers of a share link change viewer settings (haze, exposure) and save screenshots, or is it fixed to what the owner saved?
8. **Live DMX:** is hosted live input wanted at all, or is it a self-host feature for good?
9. **Data:** how long are deleted venues kept (a trash with 30 days?), and are rider PDFs kept after reading or deleted once the lights are placed?
10. **Who runs it:** a hosted service needs someone on call for outages, abuse reports and GDPR requests. Is that the owner, or a group?
