// Offline tests of the HTTP guards for a long-running server: hosts that are down are
// skipped after a few failures, and requests a call no longer needs are abandoned.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchText, skippedHosts, resetHosts } from "../src/http.js";
import { callContext } from "../src/call-context.js";

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("http: a host that keeps failing is skipped at once, and any real answer lets it back in", async () => {
  resetHosts();
  let mode = "slow";
  let seen = 0;
  const { server, base } = await serve((req, res) => {
    seen++;
    if (mode === "slow") return; // never answers: each request times out
    res.writeHead(mode === "missing" ? 404 : 200);
    res.end("ok");
  });
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(fetchText(`${base}/x`, { timeoutMs: 150 }), /Timed out/);
    const before = seen;
    const t0 = Date.now();
    await assert.rejects(fetchText(`${base}/x`, { timeoutMs: 150 }), /not answering \(timed out; 3 failures in a row\)/);
    assert.ok(Date.now() - t0 < 50, "fails at once");
    assert.equal(seen, before, "the host is not asked");
    assert.equal(skippedHosts()[0].reason, "timed out");

    // Once it answers again (here: after a reset standing in for the cool-off), an error status counts as an answer.
    resetHosts();
    mode = "missing";
    await assert.rejects(fetchText(`${base}/x`, { timeoutMs: 150 }), /HTTP 404/);
    assert.deepEqual(skippedHosts(), []);
    mode = "ok";
    assert.equal(await fetchText(`${base}/x`), "ok");
  } finally {
    resetHosts();
    server.closeAllConnections();
    server.close();
  }
});

test("http: requests a call no longer needs are abandoned, queued or in flight, and their slots freed", async () => {
  resetHosts();
  const { server, base } = await serve((req, res) => {
    if (req.url === "/fast") return res.end("fast");
    setTimeout(() => res.end("slow"), 1500);
  });
  try {
    const ctrl = new AbortController();
    // Six requests to one host: four run (the per-host cap), two wait in its queue.
    const calls = callContext.run({ signal: ctrl.signal }, () => Array.from({ length: 6 }, () => fetchText(`${base}/slow`, { timeoutMs: 5000 })));
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort(new Error("the call's budget ran out"));
    const outcomes = await Promise.allSettled(calls);
    assert.ok(outcomes.every((o) => o.status === "rejected" && /Abandoned: the call's budget ran out/.test(o.reason.message)));
    // The host is free again at once, and abandoning it did not count as an outage.
    const t0 = Date.now();
    assert.equal(await fetchText(`${base}/fast`), "fast");
    assert.ok(Date.now() - t0 < 500, "no slot left taken");
    assert.deepEqual(skippedHosts(), []);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("http: work started outside any call (detached) is not abandoned with a call", async () => {
  const { detached } = await import("../src/call-context.js");
  const { server, base } = await serve((req, res) => setTimeout(() => res.end("shared"), 200));
  try {
    const ctrl = new AbortController();
    const shared = callContext.run({ signal: ctrl.signal }, () => detached(() => fetchText(`${base}/shared`)));
    ctrl.abort();
    assert.equal(await shared, "shared");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("http: a hedged request is sent again when the first stalls, and the first answer wins", async () => {
  resetHosts();
  let n = 0;
  const { server, base } = await serve((req, res) => {
    n++;
    if (n === 1) return setTimeout(() => res.end("slow"), 3000); // this instance stalls
    res.end("fast");
  });
  try {
    const t0 = Date.now();
    assert.equal(await fetchText(`${base}/q`, { hedgeAfterMs: 150, timeoutMs: 5000 }), "fast");
    assert.ok(Date.now() - t0 < 1500, "the twin answered long before the stalled request");
    assert.equal(n, 2);
    // An answer before the hedge time sends nothing twice.
    n = 1;
    assert.equal(await fetchText(`${base}/q`, { hedgeAfterMs: 1000 }), "fast");
    assert.equal(n, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
