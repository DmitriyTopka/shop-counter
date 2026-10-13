// "Link account": the real OAuth 2.1 flow against the shop server, the way Alexa+ account linking would.
// Discovery (RFC 9728 -> RFC 8414), Dynamic Client Registration, PKCE S256 made in the browser,
// redirect to the server's consent page, back here with ?code, exchange at /token.
// Discovery, registration and token calls go to this page's own origin (the Vite proxy or the
// same Lambda), only the consent page is a top-level navigation to the server itself.
// The resource is the whole shop server (root metadata): one link covers every store, like one
// Alexa account, and the closet is shared by the stores anyway.

const PENDING = 'sim.oauth.pending';
const CLIENTS = 'sim.oauth.clients';

export interface Linked { token: string; user: string; expiresIn: number; resource: string }

interface Pending { state: string; verifier: string; clientId: string; redirectUri: string; tokenPath: string; resource: string; search: string }

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const samePath = (url: string) => { const u = new URL(url); return u.pathname + u.search; };

async function getJson(path: string) {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

/** Starts linking: leaves the page for the consent screen. `note` logs each step. */
export async function startLink(note: (msg: string, data?: unknown) => void): Promise<never> {
  const prm = await getJson('/.well-known/oauth-protected-resource');
  note('protected resource metadata', prm);
  if (!prm.authorization_servers?.length) throw new Error('no authorization server in resource metadata');
  const as = await getJson('/.well-known/oauth-authorization-server');
  note('authorization server metadata', as);
  // MCP: no code_challenge_methods_supported with S256 -> refuse to proceed
  if (!as.code_challenge_methods_supported?.includes('S256')) throw new Error('authorization server does not support PKCE S256');

  const redirectUri = location.origin + location.pathname;
  const clients = JSON.parse(localStorage.getItem(CLIENTS) ?? '{}') as Record<string, string>;
  const key = `${as.issuer} ${redirectUri}`;
  let clientId = clients[key];
  if (!clientId) {
    if (!as.registration_endpoint) throw new Error('no registration endpoint');
    const r = await fetch(samePath(as.registration_endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Echo Show simulator', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }),
    });
    if (!r.ok) throw new Error(`registration failed (${r.status})`);
    clientId = (await r.json()).client_id;
    clients[key] = clientId;
    localStorage.setItem(CLIENTS, JSON.stringify(clients));
    note('registered client (RFC 7591)', { redirect_uri: redirectUri });
  }

  const verifier = random(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const pending: Pending = {
    state: random(16), verifier, clientId, redirectUri, tokenPath: samePath(as.token_endpoint), resource: prm.resource, search: location.search,
  };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  const auth = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256',
    state: pending.state, scope: (prm.scopes_supported ?? []).join(' '), resource: prm.resource,
  })) if (v) auth.searchParams.set(k, v);
  note('to the consent page', { authorize: auth.origin + auth.pathname, resource: prm.resource });
  location.assign(auth.href);
  return new Promise<never>(() => {});
}

/**
 * Call before reading location.search: if this page load is the OAuth callback, puts the original
 * query back (?user=..&store=..) and returns the token exchange; otherwise null.
 */
export function takeLinkCallback(): Promise<Linked> | null {
  const q = new URLSearchParams(location.search);
  if (!q.has('state') || !(q.has('code') || q.has('error'))) return null;
  const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as Pending | null;
  sessionStorage.removeItem(PENDING);
  history.replaceState(null, '', location.pathname + (pending?.search ?? ''));
  if (!pending || q.get('state') !== pending.state) return Promise.reject(new Error('link callback: state mismatch, ignored'));
  if (q.get('error')) return Promise.reject(new Error(`link: ${q.get('error')}${q.get('error_description') ? ` (${q.get('error_description')})` : ''}`));
  return (async () => {
    const r = await fetch(pending.tokenPath, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: q.get('code')!, code_verifier: pending.verifier, client_id: pending.clientId,
        redirect_uri: pending.redirectUri, resource: pending.resource,
      }),
    });
    const t = await r.json();
    if (!r.ok) throw new Error(`token: ${t.error} ${t.error_description ?? ''}`);
    return { token: t.access_token, user: t.user_id ?? 'linked shopper', expiresIn: t.expires_in, resource: t.resource ?? pending.resource };
  })();
}
