// @ts-check
// The agent client over the agent server: the browser sends the call envelope, the server renders, calls the model
// and logs. Keys and prompts never reach the browser.

/**
 * @param {{url: string, session: {id: string, learnerCode?: ?string}, fetch?: typeof fetch}} options
 *     url: the server, e.g. http://localhost:8787
 * @returns {!import('./agent_client.js').AgentClient & {health: function(): !Promise<?Object>,
 *     events: function(!Object, {final?: boolean}=): !Promise<void>}}
 */
export function createAgentServerClient({url, session, fetch: send = (...a) => fetch(...a)}) {
  const base = url.replace(/\/$/, '');
  const post = (route, body, signal) => send(`${base}${route}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal,
  });

  return {
    async call(call, {signal} = {}) {
      const failed = (code, message) => {
        if (code !== 'ABORTED') console.warn(`[agent] ${call.task} failed: ${message}`);
        return {requestId: call.requestId, status: 'error', code, message};
      };
      try {
        const response = await post('/v1/agent/call', {...call, session}, signal);
        if (!response.ok) return failed('MODEL', `server: HTTP ${response.status}`);
        const reply = await response.json();
        if (reply.status === 'error') failed(reply.code, reply.message);
        return reply;
      } catch (e) {
        if (signal?.aborted) return failed('ABORTED', 'aborted');
        return failed('MODEL', `the agent server can't be reached (${e.message})`);
      }
    },
    result({requestId, valid, problems = []}) {
      // The verdict only feeds logs and the cache; a lost one costs nothing.
      post('/v1/agent/result', {requestId, valid, problems}).catch(() => {});
    },
    /**
     * A batch of the app's events. When the page closes (final) it goes by sendBeacon, which outlives the page.
     * Throws when the batch should be sent again; a batch the server refuses is dropped.
     */
    async events(batch, {final = false} = {}) {
      const body = JSON.stringify(batch);
      if (final && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        // text/plain needs no preflight, which a closing page can't wait for.
        navigator.sendBeacon(`${base}/v1/agent/events`, new Blob([body], {type: 'text/plain'}));
        return;
      }
      const response = await send(`${base}/v1/agent/events`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body});
      if (response.status === 400) {
        console.warn(`[events] refused: ${(await response.json().catch(() => ({}))).error || 'bad batch'}`);
        return;
      }
      if (!response.ok) throw new Error(`events: HTTP ${response.status}`);
    },
    /** The server's health, or null when it doesn't answer within 3 s. */
    async health() {
      try {
        const response = await send(`${base}/v1/health`, {signal: AbortSignal.timeout(3000)});
        return response.ok ? await response.json() : null;
      } catch (e) {
        return null;
      }
    },
  };
}
