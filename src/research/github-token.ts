import { findKey, keySpec } from '../keys.ts';
import type { Env, KeySpec } from '../keys.ts';

/** A GitHub token: only the research scripts read it, and only api.github.com receives it. */
export type GithubToken = string & { readonly __brand: 'GithubToken' };

export const readGithubToken = (env: Env): GithubToken | undefined => findKey(keySpec('github') as KeySpec, env)?.value as GithubToken | undefined;

let rejectionShown = false;

/**
 * api.github.com refused the token, as it does once a token expires. The read is asked again without it, so a bad token
 * gives the answers no token gives, and the refusal is said once.
 */
export function noteTokenRejected(): void {
  if (rejectionShown) return;
  rejectionShown = true;
  console.error('NOTE  api.github.com refused GITHUB_TOKEN (HTTP 401), so GitHub is read without it; replace or remove the token');
}

/** The token's header for a request to `url`, empty for any URL but https://api.github.com. */
export function githubAuthorization(url: string, token: GithubToken | undefined): { readonly authorization?: string } {
  const target = new URL(url);
  const github = target.protocol === 'https:' && target.hostname === 'api.github.com' && target.port === '' && target.username === '';
  return token === undefined || !github ? {} : { authorization: `Bearer ${token}` };
}
