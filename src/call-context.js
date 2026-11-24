// The tool call that the current work belongs to. acrossSources (src/server.js) runs each
// source's task inside callContext.run({ signal }), and src/http.js reads the signal, so a
// request the call no longer needs (its time budget ran out, the client went away) is
// abandoned without every provider having to pass a signal along.

import { AsyncLocalStorage } from "node:async_hooks";

export const callContext = new AsyncLocalStorage();

/** Run fn outside any call: work it starts (a shared download others wait on) is never abandoned with one call. */
export const detached = (fn) => callContext.exit(fn);

/** The current call's AbortSignal, or null outside a call. */
export const callSignal = () => callContext.getStore()?.signal ?? null;
