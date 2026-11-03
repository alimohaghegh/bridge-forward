# AGENTS.md

Orientation for AI coding assistants (and humans) working in this project.
This file is auto-loaded by Claude Code, Cursor, and similar tools — keep it short
and true. For the full SDK reference (db, Bot API, fetch), see
[docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).

## What this project is

A **Telegram Mini App bot** running on Telegram's serverless platform. You write
JavaScript modules (database schema, shared library code, update handlers); the
platform runs them in a V8 isolate. The `tgcloud` CLI syncs this local project
with the bot's cloud environment — think `wrangler`/`vercel` + `drizzle-kit`.

There is no server to run locally and no `node_modules` to import from at runtime:
the only things available inside a module are the platform SDK and other modules
in this project.

## Layout

Everything the platform runs lives in the **`tgcloud/`** folder. The rest of the
project root is yours (a mini-app front-end, config, docs).

| Path                  | What it is                                                        |
|-----------------------|-------------------------------------------------------------------|
| `tgcloud/schema.js`   | Database schema — tables as **named exports**. One file.          |
| `tgcloud/lib/`        | Shared modules. Subdirectories allowed (`lib/internal/util.js`).  |
| `tgcloud/handlers/`   | Update handlers, **one level only**. Names match Telegram Bot API update types (`message`, `callback_query`, …). |
| `tgcloud/endpoints/`  | Functions the Mini App calls (`POST /api/<name>`), **one level only**. |
| `tgcloud.jsonc`       | Project config. Its `"static"` block names the build folder hosted as the Mini App. |
| `docs/`               | Reference docs (this project's, for you). Not deployed.           |
| `.tgcloud/`           | CLI state (credentials, snapshot, cached layout). **Never edit or read from here** — it's gitignored machine state. |

Only `.js` files under `tgcloud/` (`schema.js`, `lib/`, `handlers/`, `endpoints/`) are deployed
as code, plus — when `tgcloud.jsonc` names one — the front-end's build folder as
the Mini App's static files. Everything else (Markdown, config, `.tgcloud/`, the
front-end's sources) is local-only. Module names are relative to `tgcloud/`: the
file `tgcloud/handlers/message.js` is the module `handlers/message`.

## Mini App front-end

If the project root holds a front-end (Vite, React, Vue, …), its **build output**
is deployed next to the bot and served as the Mini App at
`https://app<app_id>.tgcloud.ai/` — `push` prints the exact URL.

- `tgcloud.jsonc` → `{ "static": { "source": "dist" } }` — `source` names the
  build folder; the other keys of the `static` object are the serving config
  (e.g. `"spa": true` serves `index.html` for unknown extension-less paths —
  client-side routing; `immutable`, `headers`, `redirects`). `tgcloud init` writes
  the file when it recognizes the front-end; after that it's a normal project
  file. JSON with comments and trailing commas (a project may use a strict-JSON
  `tgcloud.json` instead — never both). `"static": "dist"` is accepted as a
  shorthand for `{ "source": "dist" }`.
  `"static": false` removes the deployed site on the next push.
- **Build before you push.** `push` uploads the folder as it is on disk; it never
  runs the build. `npm run deploy` (build + push) is the safe default.
- The front-end is ordinary browser code with npm packages — none of the
  `tgcloud/` module rules apply to it, and `tgcloud/` modules can't import it.
  It talks to the bot's code only through **endpoints** (below).
- The site is served from the host root, so the bundler's default `base` (`/`)
  is right. Don't add `X-Frame-Options` or a restrictive `frame-ancestors`:
  Telegram Web opens Mini Apps in an iframe.

## Endpoints — the Mini App's server side

`tgcloud/endpoints/<name>.js` is called by the Mini App as `POST /api/<name>` on
the same host as the static site. Use it for anything the front-end can't do
itself: the database, the Bot API, secrets.

- `export default async function (input, ctx)` — `input` is the JSON body (an
  object); the return value goes back as JSON.
- `ctx.initData` is the Mini App's init data **verified by the platform** (same
  shape as `Telegram.WebApp.initDataUnsafe`): `ctx.initData.user` is the caller.
  There is no `ctx.user`. Invalid init data → `401`, the endpoint never runs.
- Refuse with `throw new EndpointError('Out of stock', { code: 'OUT_OF_STOCK' })`
  (`import { EndpointError } from 'sdk'`) → `400`, the Mini App gets
  `description` + `parameters`. Any other exception → generic `500`; never
  rely on its message reaching the client.
- Front-end call: `Telegram.WebApp.Serverless.call('<name>', input, (err, result) => …)`
  from the official `telegram-web-app.js` — it sends the init data; `err` has
  `message` (description), `type` (`'ENDPOINT_ERROR'` for your `EndpointError`)
  and `parameters`. Don't hand-roll `fetch` + init data.
- Names: letters, digits, `_`, not starting with a digit (`getProfile`).
  Scaffold with `npx tgcloud add endpoints/<name>`; test with
  `npx tgcloud run endpoints/<name> '{}' --ctx '{ initData: { user: { id: 1 } } }'`.

## Module system — the rules that bite

- **Import project modules by relative path WITH the `.js` extension; import
  the SDK by name.** (from `tgcloud/handlers/message.js`:)
  - ✅ `import { users } from '../schema.js'`
  - ✅ `import { addItem } from '../lib/cart.js'`
  - ✅ `import { db, api, fetch } from 'sdk'` / `import { eq, sql } from 'sdk/db'`
  - ❌ `import { users } from '../schema'` → a relative import must end in `.js`
  - ❌ `import x from '../../src/x.js'` → nothing outside `tgcloud/` is reachable
  - A module's *name* is its path inside `tgcloud/` without `.js` (`lib/cart`);
    `tgcloud run` takes it, and `from 'lib/cart'` (no extension) also resolves —
    but write relative imports.
- **No filesystem, no npm packages** at runtime. Only `sdk` (and its submodules
  like `sdk/db`) and your own project modules exist.
- A handler module's `export default` is what the platform invokes, with the
  update's **payload** as the first argument — for `handlers/message` that's the
  `Message` (i.e. `update.message`), for `handlers/callback_query` the
  `CallbackQuery`, and so on. The full `Update` (with `update_id`) is on the
  second argument: `ctx.update`. An endpoint's `export default` gets
  `(input, ctx)` — see *Endpoints* above.

## Platform SDK (`import … from 'sdk'`)

- **`db`** — the database (query builder + schema DSL). Full API: [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).
- **`api`** — the Telegram Bot API. `api.<method>({...})` (e.g. `api.sendMessage`,
  `api.getMe`) returns the **unwrapped** result and **throws `BotApiError`** on
  failure (`import { BotApiError } from 'sdk'`; it has `.code`/`.description`/`.parameters`).
- **`fetch`** — outbound HTTP, web-`fetch`-like (`res.status/ok`, `res.json()`,
  `res.text()`, streaming via `for await`, redirects followed).
- **`EndpointError`** — the one way an endpoint refuses a call (see *Endpoints*).

## Database — the rules that bite

Full API in [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md). The non-obvious parts:

- **Every DB call is async — always `await`.** `.all()`, `.get()`, `.values()`,
  `.run()`, `db.$count()` and the raw `db.run/all/get` all return Promises.
- **No foreign keys.** `.references()` and `foreignKey()` **throw at declaration**
  — the runtime runs with FKs off, so they'd be silently inert. Enforce integrity
  in application code (delete children before parents, etc.).
- **Drops happen only via `.deprecated('reason')`** on a column/table/index.
  Deleting the declaration does *not* drop anything.
- **Type changes aren't automatic** — do them by hand with `db.run(...)`.

## Deploy & migrate workflow

**Deploying never touches the database.** Schema sync is a separate, explicit step.

The CLI is a local dev-dependency, so run it with `npx tgcloud <command>` (or use
the `npm run` scripts in package.json — e.g. `npm run deploy`):

```
npx tgcloud status     # what changed locally vs the cloud
npx tgcloud push       # deploy modules (and the static build) to the cloud
npx tgcloud migrate    # apply tgcloud/schema.js changes to the database (interactive)
npx tgcloud run <module> [args]   # execute a handler or endpoint server-side
npx tgcloud pull       # bring the local project in line with the cloud
npx tgcloud login      # link this project to a bot
npx tgcloud webhook    # show the bot's webhook and whether it matches your handlers
```

After you change `tgcloud/schema.js`, `push` reports what the DB *would* change but applies
nothing — run `npx tgcloud migrate` to actually apply it.

The platform manages the bot's webhook for you, derived from your deployed
`handlers/*`, and refreshes it on `push`. If it ever drifts — e.g. someone called
`setWebhook` with the raw bot token — `npx tgcloud webhook` shows the mismatch and
`npx tgcloud webhook sync` repairs it.

## This project: bridge-forward (Telegram → Bale)

- Users link a Bale chat with a single-use code (`lib/linking.js`); every
  private message from a linked user is re-sent to Bale (`lib/forward.js`).
- Bale is reached only through `lib/bale.js` (`fetch` to `tapi.bale.ai`, via the
  Cloudflare relay first — `lib/relay.js`, path `/bale/...` — then direct,
  alternating: from the platform most direct connections time out);
  Bale updates are pulled with `getUpdates` when someone presses the verify
  button — there is no Bale webhook.
- **Secrets:** `tgcloud/lib/config.js` (Bale token, owner id) is generated in
  CI by `scripts/write-config.mjs` and is git-ignored. Never commit or log it.
- **Deploy only via GitHub Actions** (`.github/workflows/deploy.yml`): a local
  `npx tgcloud push` without `config.js` would deploy a broken bot.
- Channels: «پل کانال به کانال (به بله)» (or `/channel`) links a Telegram channel to a Bale channel or group
  (`lib/channels.js`; the Bale chat is named by @id, a post of it forwarded to
  the Bale bot, or a code posted in a group — nothing is posted in a channel).
  Posts, edits and deletions go through a durable ordered queue
  (`lib/mirror.js`, table `outbox`) that keeps each job until Bale accepts it;
  `.github/workflows/drain.yml` re-runs it every minute (`__drain`, Bale and
  Eitaa), dispatched by the Cloudflare Worker's cron (GitHub `schedule`
  never fired here).
  Deleted posts are found by `lib/post_check.js`: an empty
  `setMessageReaction` (MESSAGE_ID_INVALID = deleted), confirmed by a
  forward to the owner; `editMessageReplyMarkup` answers from a stale copy
  until the channel's next post. Times compared across runs use the
  database clock (`DB_NOW`, `DB_NOW_MS` in util.js): the machines' clocks
  differ by up to ~100 s. Raw SELECTs must use `db.all`/`db.get`, not `db.run`.
- Albums: one update per item; `lib/album.js` collects them in the DB and the
  first item's run sends them with `sendMediaGroup`.
- Privacy: never store or log message contents; only ids, state, counters
  (album items are the one exception: held seconds, then deleted).
- All user-facing texts are Persian and live in `lib/texts.js`.
- Formatting: `lib/entities.js` is the shared entity core (UTF-16, nesting,
  chunking). Eitaa (`eitaa_html.js`) emits only b/i/code/a (verified live);
  Bale (`format.js`) has no parse_mode — everything is Markdown — so links
  are `[text](url)`, bold `*` and italic `_` (Bale's spacing rule applies),
  adjustable by the owner's `/bale_diag fmt` (settings key `bale_fmt`,
  loaded by `loadBaleFormat()` at the start of each handler; the diagnostic
  starts from the current format). Eitaa's tag set is fixed in code: a
  stored "nothing ticked" answer once switched all formatting off.
  EitaaYar places each tag by searching for its text from the message
  start, so a tagged piece whose text occurs elsewhere gets an invisible,
  equal-length code (U+2060/U+200B) before its closing tag.
- `npm test` (node:test, `tests/`, SDK stubbed by `tests/register.mjs`)
  runs in the deploy workflow before anything is pushed.
- `/start` shows one main menu (`lib/eitaa_link.js` showMenu); its first
  buttons open the Bale screens (`lib/bale_ui.js`) and the Eitaa screens
  (`lib/eitaa_link.js`); screens are shown with `show()` (`lib/ui.js`). Users
  never need to type a command; the old ones still work. The menu text is
  U+2063: Telegram refuses U+2800, U+200B and U+3164 as "empty".
- Eitaa: Telegram channel → Eitaa channel via EitaaYar (`lib/eitaa.js`,
  `https://eitaayar.ir/api/<token>/<method>`; only sendMessage/sendFile, one
  file per post, no album/edit/delete). `lib/eitaa_mirror.js` keeps ids and
  outcomes per post in `eitaa_posts` (no contents): a retried post is re-read
  by forwarding it to the channel owner's chat and deleting the copy. Albums
  are skipped (one notice) or sent as their first item; edits/deletions are
  reported to the owner with the panel title `tg-<id>`. Simple mode uses the
  owner's shared token and only an id the owner approved (reply to the
  request); advanced mode stores the user's token AES-GCM-encrypted
  (`EITAA_TOKEN_KEY`). Missing Eitaa secrets disable a mode, never a deploy.
  Telegram Serverless can't reach Eitaa at all, so EitaaYar calls go through
  the Cloudflare Worker in `relay/worker.js` (deployed by hand in the
  owner's Cloudflare dashboard, not by tgcloud), signed with
  `EITAA_RELAY_KEY`; `EITAA_RELAY_URL` names it.
  Owner `/eitaa_diag [methods|size]` stores findings
  (tags, limits, methods) in `eitaa_settings`.
- CI logs are public (public repo): `tgcloud run` outputs must hold counts
  and codes only, never ids, tokens or contents.
