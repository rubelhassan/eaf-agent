// The call handler: checks the envelope, renders the request, calls the routed model, keeps the first exchange for
// the repair round. No HTTP or database here, so the routes, the eval and the tests all run this same code.

import {renderRepair, renderRequest} from './prompts/render.js';
import {envelopeProblems, type AgentCall, type Task} from './envelope.js';
import {inferenceFor} from './models/settings.js';
import type {Guard} from './guard/index.js';
import type {MaskMap} from './guard/mask.js';

export interface ModelReply {
  text: string;
  usage: {prompt_tokens?: number; completion_tokens?: number; cost?: number; [k: string]: unknown};
  latencyMs: number;
  finishReason?: string | null;
  reasoningTokens?: number;
  provider?: string | null;
  model?: string;
  cached?: boolean;
  /** Set when the call failed; text is then empty. */
  error?: string;
}

/** A model behind a Chat Completions request (OpenRouter now; a lab model later). */
export interface Provider {
  complete(payload: Record<string, unknown>, options: {signal?: AbortSignal; timeoutMs?: number}): Promise<ModelReply>;
}

/** Which model, prompt version and settings each task uses. */
export interface Routing {
  model(task: Task): string;
  provider(task: Task): Provider;
  promptVersion(task: Task): string | undefined;
  inference(task: Task): Record<string, unknown> | null;
  timeoutMs(task: Task): number;
  fallback?(task: Task): ModelRoute | null;
}

/** A resolved model and its provider settings. */
export interface ModelRoute {
  model: string;
  provider: Provider;
  inference: Record<string, unknown> | null;
  timeoutMs: number;
}

type AttemptRoute = ModelRoute & {fallback: boolean};

export interface CallRecord {
  call: AgentCall;
  model: string;
  promptVersion: string | null;
  payload: Record<string, unknown> | null;
  reply: AgentReply;
  replyText: string;
  at: string;
}

export interface CallLog {
  call(record: CallRecord): void;
  result(record: {requestId: string; valid: boolean; problems: string[]; at: string}): void;
}

export type AgentErrorCode = 'TIMEOUT' | 'ABORTED' | 'MODEL' | 'RATE_LIMIT' | 'INVALID_ENVELOPE' | 'LIMIT';

export type AgentReply =
  | {requestId: string; status: 'ok'; reply: string; meta: Record<string, unknown>}
  | {requestId: string; status: 'error'; code: AgentErrorCode; message: string; meta?: Record<string, unknown>};

const ERROR_CODES: Record<string, AgentErrorCode> = {timeout: 'TIMEOUT', aborted: 'ABORTED', 'HTTP 429': 'RATE_LIMIT'};
// A request's first exchange waits this long for its repair round.
const OPEN_MS = 10 * 60 * 1000;

/** @param guard masking; null sends the words as they are (tests and replays of old runs) */
export function createAgentCore({routing, log = null, guard = null, now = () => Date.now()}:
  {routing: Routing; log?: CallLog | null; guard?: Guard | null; now?: () => number}) {
  // A request's first exchange, kept for its one repair round and the browser's verdict.
  const open = new Map<string, {payload: Record<string, unknown>; version: string; text: string; map: MaskMap | null; at: number;
    repaired: boolean; target: AttemptRoute}>();
  const stamp = () => new Date(now()).toISOString();

  const forget = () => {
    for (const [id, first] of open) if (now() - first.at > OPEN_MS) open.delete(id);
  };

  /** Log each provider attempt, including the rate limit that caused a fallback. */
  async function completeAndLog({call, payload, target, version, map, signal}: {
    call: AgentCall; payload: Record<string, unknown>; target: AttemptRoute; version: string;
    map: MaskMap | null; signal?: AbortSignal;
  }) {
    const reply = await target.provider.complete(payload, {signal, timeoutMs: target.timeoutMs});
    const restored = map && !reply.error ? guard!.restore(reply.text, map) : {text: reply.text, unknown: []};
    const model = reply.model || target.model;
    const meta = {
      model, fallback: target.fallback, promptVersion: version, cached: !!reply.cached,
      latencyMs: reply.latencyMs, finishReason: reply.finishReason ?? null,
      tokens: {input: reply.usage?.prompt_tokens, output: reply.usage?.completion_tokens, reasoning: reply.reasoningTokens},
      costUsd: reply.usage?.cost,
      ...(restored.unknown.length ? {problems: restored.unknown.map((id) =>
        `the reply has ${id}, which is not in the request; keep only the ids the request has, as written`)} : {}),
    };
    const result: AgentReply = reply.error ?
      {requestId: call.requestId, status: 'error', code: ERROR_CODES[reply.error.split(':', 1)[0]] || 'MODEL', message: reply.error, meta} :
      {requestId: call.requestId, status: 'ok', reply: restored.text, meta};
    log?.call({call, model, promptVersion: version, payload, reply: result, replyText: reply.text, at: stamp()});
    return {result, text: reply.text};
  }

  return {
    async call(body: unknown, {signal}: {signal?: AbortSignal} = {}): Promise<AgentReply> {
      forget();
      const requestId = typeof (body as AgentCall)?.requestId === 'string' ? (body as AgentCall).requestId : '';
      const problems = envelopeProblems(body);
      if (problems.length) return {requestId, status: 'error', code: 'INVALID_ENVELOPE', message: problems.join('; ')};
      let call = body as AgentCall;
      let target: AttemptRoute;
      let payload: Record<string, unknown>;
      let version: string;
      let map: MaskMap | null = null;
      if (call.repair) {
        const first = open.get(requestId);
        if (!first || first.repaired) return {requestId, status: 'error', code: 'INVALID_ENVELOPE', message: 'repair without a first call'};
        first.repaired = true;
        ({version, map} = first);
        target = first.target;
        // The browser's problems quote the restored reply, so they are masked again.
        const problems = map ? call.repair.problems.map((p) => guard!.maskKnown(p, map!)) : call.repair.problems;
        call = {...call, repair: {problems}};
        payload = renderRepair(first.payload, first.text, problems);
      } else {
        target = {model: routing.model(call.task), provider: routing.provider(call.task),
          inference: routing.inference(call.task), timeoutMs: routing.timeoutMs(call.task), fallback: false};
        if (guard) ({call, map} = await guard.mask(call));
        const rendered = renderRequest(call, {model: target.model, version: routing.promptVersion(call.task),
          overrides: target.inference});
        payload = rendered.payload as Record<string, unknown>;
        version = rendered.version;
      }
      let attempt = await completeAndLog({call, payload, target, version, map, signal});
      if (attempt.result.status === 'error' && attempt.result.code === 'RATE_LIMIT' && !target.fallback && !signal?.aborted) {
        const fallback = routing.fallback?.(call.task);
        if (fallback) {
          target = {...fallback, fallback: true};
          // Keep the already-masked messages, including repair feedback, byte for byte.
          payload = {model: target.model, ...inferenceFor(call.task, {model: target.model, ...target.inference}),
            messages: payload.messages};
          attempt = await completeAndLog({call, payload, target, version, map, signal});
        }
      }
      if (!call.repair) open.set(requestId, {payload, version, text: attempt.text, map, at: now(), repaired: false, target});
      return attempt.result;
    },

    /** The browser's verdict on a reply it checked; the repair round is over either way. */
    result({requestId, valid, problems = []}: {requestId: string; valid: boolean; problems?: string[]}) {
      const map = open.get(requestId)?.map;
      open.delete(requestId);
      log?.result({requestId, valid, problems: map ? problems.map((p) => guard!.maskKnown(p, map)) : problems, at: stamp()});
    },
  };
}

export type AgentCore = ReturnType<typeof createAgentCore>;
