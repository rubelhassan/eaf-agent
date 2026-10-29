# Feature spec: Agent server

Status: **milestones 1 to 3 built** (2026-10-28 to 2026-10-29); milestone 4 (cache) deferred; milestone 5 (policy, tasks and hints on the server) after the participatory design (stage 4). Overall status: `../project-tracking.md`. Architecture in `../ai-system-design.md` (2.1 to 2.4).

## 1. Decisions so far *(decided 2026-10-27)*

- Node and TypeScript, in `server/` at the repo root. `src/` stays plain JavaScript.
- The server holds what is text only: prompts and user templates, model routing and keys, inference settings, personal information masking (patterns plus a local NER model), a cache across sessions, and logs in SQLite.
- The browser keeps everything that needs Blockly or the live program: the program view, search by code, reading and checking replies, the dry run, the speech and hint checks, the repair decision, the conversation and its in-memory cache.
- Every model call goes through the server. The browser sends an envelope with the input parts, not prompts.
- A learner is a random session id plus an optional study participant code (no names). No login yet.
- Off-topic stays with the intent model (the words are masked first).
- The eval's harness arm runs the browser part in Node and calls the server; the raw arm keeps calling OpenRouter directly.
- Runs on the dev machine for now. A lab server with your own model is designed for, not built.
- *(decided 2026-10-28)* The browser has no direct model client any more: the agent server, or the offline canned replies. Keys never live in the browser. The eval's raw arm still calls OpenRouter from Node.
- *(decided 2026-10-28)* Until milestone 1, a **dev-only adapter** behind the same client contract calls OpenRouter from the browser, only with a key in `config.local.js`. Milestone 1 deletes it; from then on the decision above holds, before any learner uses the system.
- *(decided 2026-10-28)* Logs stay on the dev machine until you delete them (an export and wipe script); a retention period is set with the study's consent and data agreement before any learner uses it.
- *(decided 2026-10-28)* **The eval runs the server's call handler in process** (`server/src/core.ts` has no HTTP or database), with the eval's recording model client as the provider, so the record and replay cache keeps working. The HTTP layer has its own tests.
- *(decided 2026-10-28)* **Prompts, user templates and inference settings stay plain JS modules** in `server/src/prompts` and `server/src/models/settings.js`, so the eval's webpack build imports them; the routes, core, store and providers are TypeScript, built with `tsc` into `server/dist`, which the eval and the unit tests import.
- *(decided 2026-10-28)* **Two servers in development:** the app as before (http-server) and the agent server on `http://localhost:8787` (`npm run dev` in `server/`), which allows pages from localhost (CORS) and listens on 127.0.0.1 only. `config.local.js` holds `agentServer`.
- *(decided 2026-10-28)* Events from the browser's task coordinator and conversation controller are batched, with a small retry buffer; they carry text (learner words, what the AI said), masked by the server before storing; besides assistant events, only counts of the learner's own edits and runs are logged (no program content).

## 2. API

Four endpoints: model calls, results, events, health.

### `POST /v1/agent/call`

Request:
```json
{
  "requestId": "r_7f3a",
  "session": {"id": "s_91c2", "learnerCode": "P07"},
  "taskId": "t_12", "revision": 2,
  "task": "EDIT_GUIDE",
  "learnerText": "make it count by five",
  "input": {"program": "Stacks: ...", "cursorLine": "Cursor: [b6] ..."},
  "policy": {"activity": "practice", "wholePlan": false},
  "repair": null
}
```
- `task`: INTENT, COMPREHEND, DEBUG, EDIT_GUIDE, SEARCH, HINT (SCAFFOLD later). `taskId` and `revision` tie the call to the coordinator's task in the logs.
- `input`: the task's input parts (`ai-system-design.md` 5.1), named fields per task, checked against a schema.
- `policy`: the server refuses a task the activity doesn't allow (quiz rules), as a second check after the browser.
- `repair`: on the repair round, `{"problems": ["..."]}` with the same `requestId`. The server adds its earlier reply and the problems to the conversation it kept for that request.

Reply:
```json
{
  "requestId": "r_7f3a",
  "status": "ok",
  "reply": "{\"steps\": [...], \"voiceLine\": \"...\"}",
  "meta": {"model": "deepseek/deepseek-v4.1-flash", "promptVersion": "v4", "cached": false,
           "latencyMs": 2140, "tokens": {"input": 2310, "output": 180, "reasoning": 240}, "costUsd": 0.0009}
}
```
- `reply` is the model's text with masked values restored. The browser parses and checks it as today.
- `status`:
  - `ok`;
  - `blocked`, with `say` (a fixed reply) and `reason` (`policy`, milestone 5); no model was called;
  - `error`, with `code` (`TIMEOUT`, `ABORTED`, `MODEL`, `INVALID_ENVELOPE`, `LIMIT`).
- The browser gives no repair round after `blocked` or `error`; it reports `/v1/agent/result` only for replies it checked.
- Short ids stay short ids. The server never sees real block ids or the workspace.

### `POST /v1/agent/result`

`{requestId, valid, problems}` after the browser checked a reply. Valid replies may enter the cache; problems go to the `results` table.

### `POST /v1/agent/events`

A batch of events:
```json
{"session": {"id": "s_91c2", "learnerCode": "P07"},
 "events": [{"id": "e_s_91c2_41", "seq": 41, "time": "2026-10-28T15:02:11.204Z", "kind": "step.applied",
             "taskId": "t_12", "revision": 2, "data": {"proposalId": "p_3", "step": 1, "of": 2}}]}
```
- `id` is unique per event; the server ignores an id it already stored, so retries never duplicate.
- `seq` orders a session's events even if batches arrive out of order.
- As built *(2026-10-29)*: an event's data fields sit next to `id`, `seq`, `time`, `kind`, `taskId` and `revision` (the browser's sender spreads them; data never overrides those); the server stores the rest as `data`. Free text is in `text` (the learner's words, what the assistant said) and `words` (steps in words); only those are masked, with every finder. `session.client` (output and voice settings, learner level) comes when it changed. The activity counts are an `activity.summary` event, so a retry can't store them twice.
- The reply lists the ids stored (`{stored}`); a batch that fails its checks gets 400 with the reasons and is dropped, a network or server error keeps it for the next batch. A closing page sends its last batch with `sendBeacon` as text/plain (no preflight).

### `GET /v1/health`

Version, configured models, whether the key is set. Used by the app to choose the server client or the offline client.

## 3. Guard in

1. **Envelope check** against the task's schema; unknown fields refused.
2. **Off-topic** *(decided 2026-10-29)*: the agent only helps with the program and learning to code, for every feature (editing, debugging, explaining, search, cursor and output, and later authoring, hints, quizzes, multimodal input). Off-topic is decided by the intent model in general (no phrase lists), and gets the fixed generic redirect from code; distress and personal topics count as off-topic. A gate on the way out (every task's reply able to say it's off-topic) is deferred; prompts don't change for this now.
3. **Masking:**
   - in `learnerText`: names, school, age, location, emails, phones, addresses;
   - in the program text: emails, phones and addresses (names typed into the program are program content and stay);
   - typed ids numbered per request (`NAME_1`, `PHONE_1`, `SCHOOL_1`...); the same value gets the same id everywhere in the request;
   - finder: regex patterns, cue phrases for lowercase speech ("my name is", "I go to ... elementary", "I live in", "I'm 9"), plus a small named-entity model run locally (transformers.js, `Xenova/bert-base-NER`, int8, pinned in `ner_models.json`, fetched by `npm run models`); no outside call. Speech is lower case, so a word the model's vocabulary knows only with a capital, or doesn't know at all, gets a capital first. An entity always covers whole words;
   - the map lives in memory for the request and its repair round, then is dropped. It is never logged or cached.

## 4. Prompts and routing

- Prompts move from `src/agent/prompts` to the server, with a user template per task and version that renders the input parts. The current user messages (built in the harness modules today) become those templates unchanged, so results stay comparable.
- `inference.js` (task and model settings) moves with them.
- Routing config, a JSON file in `server/`:
  ```json
  {"tasks": {"INTENT": {"model": "inception/mercury-2.5"}, "*": {"model": "deepseek/deepseek-v4.1-flash"}},
   "providers": {"openrouter": {"baseUrl": "https://openrouter.ai/api/v1", "keyEnv": "OPENROUTER_API_KEY"}}}
  ```
  A lab model later is another provider (`"lab": {"baseUrl": "http://...:8000/v1"}`) with its own prompt versions.
- Every OpenRouter request sets `data_collection: "deny"` next to the pinned endpoint.
- Timeout per task, and the browser's abort cancels the model call.

## 5. Guard out

- Restore masked ids in the reply text. A mask id the request didn't have is left as is and reported in `meta.problems`, so the browser's check sends it to repair.
- No other content checks here; the browser's checks need the program.

## 6. Cache

- Key: hash of the masked rendered messages, model, settings and prompt version.
- Stored in SQLite with the masked reply; only replies the browser later reports as valid are kept (the browser sends `POST /v1/agent/result {requestId, valid}`).
- `cached: true` in `meta`; cached replies are restored with the current request's mask map.

## 7. Logs

SQLite, one file (`server/data/agent.db`, gitignored).

| Table | Fields |
|---|---|
| `sessions` | session id, learner code, started, last seen, client (app version, output and voice settings) |
| `calls` | request id, session id, task id, revision, time, task, prompt version, model, settings, masked request, masked reply, status, latency, tokens, cost, cached, repair round |
| `results` | request id, valid, problems (from the browser) |
| `events` | event id, session id, seq, time, kind, task id, revision, data (JSON, text masked) |

**Event kinds:**

| Group | Kinds | Data |
|---|---|---|
| Session | `session.started`, `session.suspended`, `session.resumed`, `session.ended` | how (wake phrase, key, idle) |
| Messages | `message.submitted`, `message.routed` | text, input (voice, typed, button, key); route (control word, answer, intent and relation) |
| AI speech | `ai.said`, `speech.interrupted` | text, kind; by (voice, Ctrl, I, navigation) |
| Tasks | `task.started`, `task.stage`, `task.revised`, `task.done`, `task.cancelled`, `task.failed` | action, stage, reason |
| Proposals | `proposal.offered`, `proposal.withdrawn`, `step.applied`, `step.undone` | proposal id, step, steps, the ops in words |
| Help | `hint.opened`, `hint.shown`, `search.went` | question id, level |
| Guard | `navigation.blocked` | lock (frozen, read-only) |
| Own work | `activity.summary` | counts of the learner's own edits (blocks added, removed, moved, fields changed) and runs since the last summary; no program content |

`activity.summary` is sent with each batch when the counts changed, so the learner's own work can be compared with what the agent did.

**Reliance signals** (computed by queries per learner code, for a teacher view later):
- hint requests per question and the highest level reached;
- agent steps applied against the learner's own edits;
- fixes offered, accepted and undone;
- requests per task kind, and how often a task was revised or stopped.

Retention: kept until you delete them; `npm run logs:export` writes JSONL and `npm run logs:wipe` empties the database. A retention period comes with the study's consent; nothing leaves the machine.

## 8. Browser changes

- **Built first, before the server** *(done 2026-10-28)*: the contract `src/agent/model/agent_client.js` (`AgentClient.call` and `result`); the harness builds calls (task, input parts, learner text) instead of model requests; `render.js` holds the user templates and renders them exactly as before; `local_agent.js` is the dev-only adapter (render plus OpenRouter, model per task); `fake.js` has `createFakeAgentClient` (tests, including blocked and error results) and `createOfflineAgentClient` (the app without a key). The eval's harness arm goes through the dev adapter too. Checked: replays of the recorded harness runs give identical records; 198 unit tests, including the contract suite in `test/agent_client.mocha.js`, which milestone 1 also runs against the server client.
- Still to come with the server client: the session id per page load (learner code null until the study setup), and the eval passing its model, prompt versions and inference overrides to the server.
- A new `createAgentServerClient({url})` in `src/agent/model/`. The harness modules build input parts instead of payloads; `askWithRepair` sends the repair through the same request id.
- The app picks the server client when `/v1/health` answers, else the offline client. `config.local.js` gets `agentServer` (URL) and loses `apiKey`; `createOpenRouterClient` leaves the plugin (the eval keeps its own copy for the raw arm).
- The harness modules send the task context (`harness-context.md`) as an input part; the server's templates render it exactly as the browser does today.
- The event sender (`src/interaction/events.js`, built in `task-coordinator.md`) gets a server sink: batches to `POST /v1/agent/events`, `navigator.sendBeacon` on page hide. The console sink stays for the Log events setting.
- Own-work counts come from workspace change events, excluding changes the coordinator applied.
- The prompts and inference settings leave the plugin bundle.

## 9. Eval

- The harness arm runs the browser part headless in Node (as now) with the server client; the eval's record and replay cache stays in front of it.
- New guardrail items for masking (personal information in chat and in program text) and off-topic, distress included; scored on the sent request and the intent.
- The raw arm is unchanged.

## 10. Layout

```
server/
  package.json, tsconfig.json   TypeScript, allowJs for the shared JS where needed
  src/app.ts                    Fastify app, routes, schemas
  src/guard/                    mask.ts (patterns, cues, map), ner.ts (the local model)
  src/prompts/                  prompts and user templates per task and version
  src/models/                   router.ts, openrouter.ts, openai_compatible.ts, settings.ts
  src/store/                    cache.ts, logs.ts (better-sqlite3)
  routing.json
  test/
  data/                         gitignored: agent.db
```
Keys from `server/.env` (gitignored) or the environment.

## 11. Milestones

1. *(done 2026-10-28)* **Server core:**
   - Fastify app, envelope schemas, `call`, `result` and `health`;
   - prompts, user templates and inference settings moved from `src/agent/prompts` and `inference.js`;
   - routing config, OpenRouter with the pinned endpoint and `data_collection: "deny"`, timeout, abort;
   - `calls` and `results` logging;
   - browser: the server client, health check, offline fallback; the direct client removed.
   - **Check:** a dev replay through the server gives the same requests (byte for byte, before masking) and the same scores as the current harness.

   Notes from building it:
   - Versions (patched releases at least two weeks old; `npm audit` clean): Fastify 5.12.7, @fastify/cors 11.3.1, better-sqlite3 13.0.3, TypeScript 6.0.3, tsx 4.23.15. Server tests run with Node's test runner through tsx (`npm test` in `server/`).
   - The envelope check is in the core (`envelope.ts`), so the eval is checked too: known fields per task, types, unknown fields refused (`INVALID_ENVELOPE`), and nothing reaches a model.
   - `data_collection: "deny"` is set in `settings.js` for every request (pinned or not). The eval's cache key leaves that field out, so earlier recordings still replay.
   - Replay of three recorded dev runs through the in-process core: all 161 records whose calls were all recorded came back byte-identical (cache hits) with the same outputs and scores (one search score matches the later rescored file). The misses predate the server: an intent run recorded with intent v1, an item edited after its run, five repair rounds that only exist since the impossible-place check (your skipped runs `m2-harness-dev-4` and `m2-comprehend-dev-2`), and the new revision items.
   - The app checks `/v1/health` (3 s) at load; no answer means the offline client, with a console line saying how to start the server. The browser client logs failed calls (`[agent] TASK failed: ...`). Browser check with a fake provider: a typed question went through the server (logged with the page's session id, intent on v3), no request reached OpenRouter; with the server down, the offline reply.
   - `local_agent.js`, `client.js` and the browser's OpenRouter client are gone; the eval keeps its own OpenRouter client (`eval/runner/openrouter.js`) for live runs and the raw arm. Tests that check rendered requests use `test/helpers/scripted_agent.js` (the server core over a scripted model).
   - Calls are logged as sent (not yet masked); masking comes with milestone 2, before any learner uses it.
2. *(done 2026-10-29)* **Guard in and out:** masking (patterns and the local NER model), restore, unknown mask id check; masked logs. New guardrail items (personal information in chat and program text, off-topic and distress); the harness arm runs through the server.

   Notes from building it:
   - A first version also screened distress and personal topics with phrase lists, with two fixed replies and a flag. Removed the same day (decided 2026-10-29): it would need finer rules for every new feature; off-topic stays with the intent model.
   - `server/src/guard/`: `mask.ts` (patterns, cues, ids, restore), `ner.ts` (the model, spans back from word pieces, capitals for speech), `index.ts` (the guard the core takes). transformers.js 4.3.1; `npm audit` clean. The server refuses to start without the model; health shows `nameFinder`.
   - Name finder comparison (29 sentences of mine, 17 values to mask and 12 coding sentences, cased and lowercase, all local): patterns and cues alone 6/17; bert-base-NER 17/17 cased, 9/17 lowercase, 15/17 with vocabulary capitals and 17/17 also capitalizing unknown words, no false masks, about 4 ms; distilbert-NER 17/17 cased but masked "Greeting" and "Blockly". Kept bert-base-NER with both capital rules.
   - The core masks before rendering, keeps the map with the request's first exchange until the browser's verdict, masks the repair problems and the verdict's problems again, and restores the reply (JSON-escaped). A mask id the request never had is in `meta.problems`, which the browser adds to its checks. Logs hold the masked request and the model's own text.
   - On the dev items: all 44 guardrail items get the expected masks; of the other 158 learner lines, 2 change ("taylor" in an off-topic item; "yes louit" becomes "yes NAME_1", since an unknown misheard word gets a capital), so old runs replay except those. A run file can set `"guard": false` to replay runs made before it.
   - Browser check with a fake provider and the real guard: "my name is zoe" reached the model as NAME_1 and came back as "Hi zoe"; "zoe" is nowhere in the log.
3. *(done 2026-10-29)* **Events and sessions:** `events` endpoint, idempotent storage, `sessions`; the server sink in the browser; export and wipe scripts.

   Notes from building it:
   - `server/src/events.ts` (checks, masking, storing; no HTTP), `store/logs.ts` (`sessions`, `events`; a call also updates its session), `store/report.ts` and `store/cli.ts`: `npm run logs:export` (JSONL per table in `data/export-<time>/`), `npm run logs:wipe -- --yes` (refuses without `--yes`), `npm run logs:report [-- --json]` (the reliance signals per learner code, or per session without one: tasks by action, offers, steps applied and undone, own edits and runs, agent steps per own edit, hints per question with the last level shown). `AGENT_DB` points the commands at another file.
   - Events filled in: `task.*` events carry the action once known, `task.stage` when the action starts, `proposal.offered` has the steps in words, `search.went`, `message.submitted` has the words (typed, voice, key or button), `ai.said` for every reply and progress line (`replyKind`), `hint.opened` and `hint.shown` (question id, level, written or AI) from the question popover, `navigation.blocked` once per lock. Voice sessions already had `session.started`, `session.ended`, `session.suspended`, `session.wake`.
   - The masker now restores capitals word by word, not only in all-lowercase text: the assistant's "Hi zoe, ..." was stored with the name, since "Hi" has a capital. Same comparison scores and the same 2 of 158 dev lines changed.
   - Browser check with a fake provider: a question's events reached the server in order with the action and the page's settings; the last batch came by beacon when the page closed; the learner's name was masked in the stored message and in the assistant's reply.
4. **Cache:** server cache with valid results only, restored with the current mask map.
5. **Policy on the server:** the quiz rules checked again on the server; teacher-set actions per activity come with the guardrails step.

Each milestone ends with unit tests, a stubbed browser check (no real model) and a short results note for your review.

## 12. Acceptance criteria and tests

Server unit tests (Node test runner or vitest, no real model; a fake provider):
- envelopes: unknown fields and wrong types refused with `INVALID_ENVELOPE`;
- rendered requests equal today's browser requests for every dev item (with and without a task context);
- masking: emails, phones, addresses, names, schools and ages in chat are masked; names in program text stay; the same value gets the same id; the provider never sees an original value (checked on the fake provider's input); replies are restored; an unknown mask id is reported;
- the mask map is gone after the request and its repair round; logs and cache hold only masked text;
- repair: the second call with the same `requestId` contains the first reply and the problems;
- abort: a closed browser request cancels the provider call;
- events: a repeated id is stored once; `seq` order is kept; text in events is masked;
- cache: a reply reported invalid is never served from the cache.

Browser and integration:
- a stubbed browser check against the server with a fake provider: a typed request, a step applied, events stored;
- the eval harness arm through the server reproduces the last dev scores on replay.

## 13. Open questions

- Whether distress needs its own handling later (a gentler reply, a flag for the teacher); for now it is off-topic.
