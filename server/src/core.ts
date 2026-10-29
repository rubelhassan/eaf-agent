// The call handler: checks the envelope, renders the request, calls the routed model, keeps the first exchange for
// the repair round. No HTTP or database here, so the routes, the eval and the tests all run this same code.

import {renderRepair, renderRequest} from './prompts/render.js';
import {envelopeProblems, type AgentCall, type Task} from './envelope.js';
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
}

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

export type AgentReply =
  | {requestId: string; status: 'ok'; reply: string; meta: Record<string, unknown>}
  | {requestId: string; status: 'error'; code: string; message: string; meta?: Record<string, unknown>};

const ERROR_CODES: Record<string, string> = {timeout: 'TIMEOUT', aborted: 'ABORTED'};
// A request's first exchange waits this long for its repair round.
const OPEN_MS = 10 * 60 * 1000;

/** @param guard masking; null sends the words as they are (tests and replays of old runs) */
export function createAgentCore({routing, log = null, guard = null, now = () => Date.now()}:
  {routing: Routing; log?: CallLog | null; guard?: Guard | null; now?: () => number}) {
  // A request's first exchange, kept for its one repair round and the browser's verdict.
  const open = new Map<string, {payload: Record<string, unknown>; version: string; text: string; map: MaskMap | null; at: number;
    repaired: boolean}>();
  const stamp = () => new Date(now()).toISOString();

  const forget = () => {
    for (const [id, first] of open) if (now() - first.at > OPEN_MS) open.delete(id);
  };

  return {
    async call(body: unknown, {signal}: {signal?: AbortSignal} = {}): Promise<AgentReply> {
      forget();
      const requestId = typeof (body as AgentCall)?.requestId === 'string' ? (body as AgentCall).requestId : '';
      const problems = envelopeProblems(body);
      if (problems.length) return {requestId, status: 'error', code: 'INVALID_ENVELOPE', message: problems.join('; ')};
      let call = body as AgentCall;
      const model = routing.model(call.task);
      let payload: Record<string, unknown>;
      let version: string;
      let map: MaskMap | null = null;
      if (call.repair) {
        const first = open.get(requestId);
        if (!first || first.repaired) return {requestId, status: 'error', code: 'INVALID_ENVELOPE', message: 'repair without a first call'};
        first.repaired = true;
        ({version, map} = first);
        // The browser's problems quote the restored reply, so they are masked again.
        const problems = map ? call.repair.problems.map((p) => guard!.maskKnown(p, map!)) : call.repair.problems;
        call = {...call, repair: {problems}};
        payload = renderRepair(first.payload, first.text, problems);
      } else {
        if (guard) ({call, map} = await guard.mask(call));
        const rendered = renderRequest(call, {model, version: routing.promptVersion(call.task),
          overrides: routing.inference(call.task)});
        payload = rendered.payload as Record<string, unknown>;
        version = rendered.version;
      }
      const reply = await routing.provider(call.task).complete(payload, {signal, timeoutMs: routing.timeoutMs(call.task)});
      if (!call.repair) open.set(requestId, {payload, version, text: reply.text, map, at: now(), repaired: false});
      const restored = map && !reply.error ? guard!.restore(reply.text, map) : {text: reply.text, unknown: []};
      const meta = {
        model: reply.model || model,
        promptVersion: version,
        cached: !!reply.cached,
        latencyMs: reply.latencyMs,
        tokens: {input: reply.usage?.prompt_tokens, output: reply.usage?.completion_tokens, reasoning: reply.reasoningTokens},
        costUsd: reply.usage?.cost,
        // A mask id the request never had: the browser's check sends it to repair.
        ...(restored.unknown.length ? {problems: restored.unknown.map((id) =>
          `the reply has ${id}, which is not in the request; keep only the ids the request has, as written`)} : {}),
      };
      const result: AgentReply = reply.error ?
        {requestId, status: 'error', code: ERROR_CODES[reply.error] || 'MODEL', message: reply.error, meta} :
        {requestId, status: 'ok', reply: restored.text, meta};
      // Logged masked: the call as sent and the model's own text.
      log?.call({call, model, promptVersion: version, payload, reply: result, replyText: reply.text, at: stamp()});
      return result;
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
