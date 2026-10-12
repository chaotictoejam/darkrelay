export interface RuntimeConfig {
  apiUrl: string;
  authDomain: string;
  clientId: string;
}

const TOKEN = 'darkrelay.token';
const VERIFIER = 'darkrelay.verifier';
const STATE = 'darkrelay.state';

const redirectUri = () => `${location.origin}/`;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function random(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

interface Token {
  accessToken: string;
  expiresAt: number;
}

export function currentToken(): string | undefined {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN) ?? 'null') as Token | null;
    return t && t.expiresAt > Date.now() + 30_000 ? t.accessToken : undefined;
  } catch {
    return undefined;
  }
}

/** Cognito hosted sign-in, authorization code flow with PKCE. */
export async function signIn(config: RuntimeConfig): Promise<never> {
  const verifier = random();
  const state = random();
  sessionStorage.setItem(VERIFIER, verifier);
  sessionStorage.setItem(STATE, state);
  const challenge = b64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  const url = new URL(`${config.authDomain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  location.assign(url.toString());
  return new Promise(() => {});
}

/** Completes sign-in if this page load is the redirect back from Cognito. */
export async function completeSignIn(config: RuntimeConfig): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return false;
  const verifier = sessionStorage.getItem(VERIFIER);
  if (!verifier || params.get('state') !== sessionStorage.getItem(STATE)) {
    throw new Error('Sign-in state mismatch. Try again.');
  }
  const res = await fetch(`${config.authDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Sign-in failed (HTTP ${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  sessionStorage.setItem(
    TOKEN,
    JSON.stringify({
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    }),
  );
  sessionStorage.removeItem(VERIFIER);
  sessionStorage.removeItem(STATE);
  history.replaceState(null, '', location.pathname + location.hash);
  return true;
}

export function signOut(config: RuntimeConfig) {
  sessionStorage.removeItem(TOKEN);
  const url = new URL(`${config.authDomain}/logout`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: redirectUri(),
  }).toString();
  location.assign(url.toString());
}
