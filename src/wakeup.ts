/**
 * Wake the idle loop on the one edge that can actually produce work: a runtime
 * root agent appearing.
 *
 * With no Lead there is no change-wait to arm, so the round can only sleep. A
 * timer there is a poll: it asks "is there a Lead yet?" on a schedule that
 * cannot know when the answer changes. But a Team only exists once a Lead does
 * — every ordinary runtime root is the implicit Lead of its own Team, and the
 * Team service wakes its own waiters on every roster and task append — so the
 * only edge the idle branch is missing is "a root agent was created".
 *
 * `agent/created` is a documented, always-present host event, and its payload
 * names the exact Agent, so the listener can read `parentAgent` and ignore
 * subagent spawns. That filter matters: another Team implementation on the same
 * host creates its members as ordinary subagents, and this plugin serves only
 * the native Agent Teams service. Ignoring every non-root creation keeps the two
 * isolated at the event layer, without reading anyone else's state.
 *
 * The subscription is registered once and stays armed while the loop sleeps.
 * The listener latches `fired` rather than requiring a resolver to be present,
 * because a root created between "found no Lead" and "start waiting" would
 * otherwise be missed and the loop would never look again.
 *
 * When `ctx.on` is not reachable (a host assembled without the agent registry)
 * the edge reports itself unavailable and the caller falls back to a timed
 * back-off, so a missing event bus costs efficiency, never correctness. On a
 * host that does expose the bus, no timer is armed at all: the subscription is
 * installed before the round can look, the listener latches, and the host
 * publishes a root and emits the event on the same path — so the event is not a
 * hint that the state may have changed, it is the state change.
 */

import type { Context } from '@deepseek-ai/cordis'

/** The documented host event emitted when an agent is created. */
const AGENT_CREATED = 'agent/created'

/** The slice of an Agent this module reads: whether it is a runtime root. */
interface AgentLike {
  readonly parentAgent?: unknown
}

/** The slice of `ctx` this module needs. */
interface EventHost {
  on(name: string, listener: (payload: unknown) => void): () => void
}

/** A subscription that settles when a runtime root agent appears. */
export interface TeamEdge {
  /** Whether the host exposes the agent event bus at all. */
  readonly available: boolean
  /**
   * Resolve on the next root creation, or immediately if one already fired
   * while nobody was waiting.
   * @param signal - cancellation; also resolves the wait.
   */
  wait(signal: AbortSignal): Promise<void>
  /** Drop the host subscription. */
  dispose(): void
}

/**
 * Subscribe to the host's agent-creation event.
 * @param ctx - host context; the event bus lives on it.
 * @returns the edge; `available` is false when the bus is unreachable.
 */
export function createTeamEdge(ctx: Context): TeamEdge {
  const host = readHost(ctx)
  if (host === undefined) {
    return {
      available: false,
      wait: () => Promise.resolve(),
      dispose: () => {},
    }
  }

  let fired = false
  let resolver: (() => void) | undefined
  let disposed = false

  const settleWaiting = (): void => {
    const settle = resolver
    resolver = undefined
    settle?.()
  }

  const off = host.on(AGENT_CREATED, (payload: unknown) => {
    // `agent/created` is dispatched serially: a listener that throws fails the
    // creation of that agent, so nothing here may escape.
    try {
      const agent = (payload as { agent?: AgentLike } | undefined)?.agent
      if (agent === undefined || agent === null) return
      // Only a runtime root can be the implicit Lead of a Team. A subagent is a
      // member of some Team — possibly of another Team implementation that this
      // plugin deliberately does not serve — and can never be a root itself.
      if (agent.parentAgent !== undefined && agent.parentAgent !== null) return
      if (resolver !== undefined) {
        settleWaiting()
        return
      }
      // Nobody is waiting yet: latch it, so the round that is about to start
      // waiting does not have to wait for a second root to be created.
      fired = true
    } catch {
      // A malformed payload must never break agent creation.
    }
  })

  return {
    available: true,
    wait(signal: AbortSignal): Promise<void> {
      if (fired || signal.aborted) {
        fired = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const settle = (): void => {
          resolver = undefined
          signal.removeEventListener('abort', settle)
          resolve()
        }
        resolver = settle
        signal.addEventListener('abort', settle, { once: true })
      })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      off()
      settleWaiting()
    },
  }
}

/**
 * Wait for the next runtime root.
 *
 * A host with an event bus arms no timer: the event is the state change, so
 * there is nothing to poll for. The caller can still bound the wait with
 * `timeout` for the one state no creation event can explain — a runtime root
 * that is present but does not resolve as a Lead (an identity replaced while
 * the host recomposes sessions, a provider-owned root, a roster write still in
 * flight). That re-read settles on its own, so one bounded look is enough.
 * @param edge - the root-agent edge.
 * @param sleep - the timed pause, injectable so pacing can be observed without
 *   spending wall-clock time in the test that checks it.
 * @param ms - fallback delay: the back-off for a host without a bus, or the
 *   bound of a single re-read when `timeout` is set.
 * @param signal - cancellation.
 * @param options - `timeout` bounds the wait with `ms`; omit it to wait for the
 *   edge alone.
 */
export async function waitForIdleEdge(
  edge: TeamEdge,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal,
  options: { readonly timeout?: boolean } = {},
): Promise<void> {
  if (signal.aborted) return
  if (!edge.available) {
    await sleep(ms, signal)
    return
  }
  if (options.timeout !== true) {
    // Nothing else can change a host's answer to "is there a root yet", so the
    // wait is unbounded and free. The listener was installed before this round
    // looked, and it latched any creation that landed since.
    await edge.wait(signal)
    return
  }

  const timer = new AbortController()
  const cancelTimer = (): void => timer.abort()
  signal.addEventListener('abort', cancelTimer, { once: true })
  const fallback = sleep(ms, timer.signal)
  // The fallback loses the race whenever the edge speaks first, so its
  // settlement must not escape as an unhandled rejection.
  void fallback.then(
    () => {},
    () => {},
  )
  try {
    await Promise.race([edge.wait(timer.signal), fallback])
  } finally {
    signal.removeEventListener('abort', cancelTimer)
    if (!timer.signal.aborted) timer.abort()
  }
}

/**
 * Read the agent event bus off the host context.
 *
 * A real Context always has `on`; a headless test context may not, and treating
 * that as "unavailable" rather than crashing keeps the loop runnable without a
 * host.
 * @param ctx - host context.
 * @returns the event host, or undefined when it does not expose one.
 */
function readHost(ctx: Context): EventHost | undefined {
  const candidate = ctx as unknown as Partial<EventHost> | undefined
  if (candidate === undefined || typeof candidate.on !== 'function') return undefined
  return candidate as EventHost
}
