// Some agency servers (or some nodes behind their load balancers) send only their own
// certificate, without the intermediate CA. Browsers and curl fetch the missing
// intermediate from the certificate's "CA Issuers" (AIA) URL; Node does not, so the
// request fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. completeChain(host) does what a
// browser does: download that intermediate and add it to Node's default CA list -
// but only after checking it really issued the server's certificate and is itself
// signed by a root Node already trusts, so a forged "intermediate" is never trusted.

import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { USER_AGENT } from "./meta.js";

export const CHAIN_ERRORS = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]);

const done = new Map(); // host -> Promise<boolean>
let roots = null;

function trustedRoots() {
  roots ??= tls.rootCertificates.map((pem) => new X509Certificate(pem));
  return roots;
}

/** The server's leaf certificate, read without verifying it. */
function leafOf(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const raw = socket.getPeerCertificate(false)?.raw;
      socket.end();
      raw ? resolve(new X509Certificate(raw)) : reject(new Error("no peer certificate"));
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error("timeout reading certificate")));
    socket.on("error", reject);
  });
}

function aiaUrls(cert) {
  return [...String(cert.infoAccess ?? "").matchAll(/CA Issuers - URI:(\S+)/g)].map((m) => m[1]);
}

async function download(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new X509Certificate(Buffer.from(await res.arrayBuffer())); // DER or PEM
  } finally {
    clearTimeout(t);
  }
}

async function fix(host) {
  if (typeof tls.setDefaultCACertificates !== "function") return false; // Node < 22.19 / 24.5
  const leaf = await leafOf(host);
  for (const url of aiaUrls(leaf)) {
    let intermediate;
    try {
      intermediate = await download(url);
    } catch {
      continue;
    }
    const issuedLeaf = intermediate.ca && leaf.checkIssued(intermediate) && leaf.verify(intermediate.publicKey);
    const root = trustedRoots().find((r) => intermediate.checkIssued(r) && intermediate.verify(r.publicKey));
    if (!issuedLeaf || !root) continue;
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), intermediate.toString()]);
    return true;
  }
  return false;
}

/** Make the host's chain verifiable if its certificate names a valid intermediate. Resolves true when fixed. */
export function completeChain(host) {
  if (!done.has(host)) done.set(host, fix(host).catch(() => false));
  return done.get(host);
}
