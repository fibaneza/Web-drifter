import { Agent, interceptors, type Dispatcher } from 'undici';

/**
 * HTTP dispatchers.
 *
 * `request(url, { maxRedirections })` is no longer supported by undici: it
 * throws `InvalidArgumentError: maxRedirections is not supported, use the
 * redirect interceptor`. Both call sites that used it caught broadly, so on a
 * Node whose bundled undici has dropped the option the symptom was not an
 * error but silence - every sitemap yielded zero seeds, and every external
 * link was reported as unreachable.
 *
 * Composing the interceptor onto an explicit `Agent` is the supported
 * replacement, and unlike the old option it does not depend on which undici
 * backs the global dispatcher.
 */

/**
 * A dispatcher that follows up to `maxRedirections` redirects.
 *
 * The response's `context.history` carries the full chain, which is what the
 * link checker counts hops from. Callers own the dispatcher and must `close()`
 * it, or its sockets keep the pool alive.
 */
export function createRedirectingDispatcher(maxRedirections: number): Dispatcher {
  return new Agent().compose(interceptors.redirect({ maxRedirections }));
}
