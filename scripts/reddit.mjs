// Shared Reddit OAuth helper for generate-puzzle.mjs and generate-thread.mjs.
//
// Required env vars (add as GitHub Actions secrets):
//   REDDIT_CLIENT_ID      — from https://www.reddit.com/prefs/apps (Script app)
//   REDDIT_CLIENT_SECRET  — same app
//   REDDIT_USERNAME       — your Reddit username
//   REDDIT_PASSWORD       — your Reddit password
//
// Falls back to unauthenticated public API when creds are absent (local dev).

const USER_AGENT = 'WhatTheSub/1.0 daily-puzzle-game by /u/SeantheBomb';

let _token  = null;
let _useOAuth = false;

export async function initReddit() {
  const id     = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  const user   = process.env.REDDIT_USERNAME;
  const pass   = process.env.REDDIT_PASSWORD;

  if (!id || !secret || !user || !pass) {
    console.error('[reddit] OAuth credentials not set — falling back to unauthenticated API');
    console.error('[reddit] Add REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD to GH secrets');
    return;
  }

  const creds = Buffer.from(`${id}:${secret}`).toString('base64');
  try {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: `grant_type=password&username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`,
    });

    if (!res.ok) {
      console.error(`[reddit] OAuth token request failed: HTTP ${res.status}`);
      return;
    }

    const data = await res.json();
    if (!data.access_token) {
      console.error('[reddit] No access_token in response:', JSON.stringify(data));
      return;
    }

    _token    = data.access_token;
    _useOAuth = true;
    console.error(`[reddit] OAuth authenticated (expires in ${data.expires_in}s, scope: ${data.scope})`);
  } catch (err) {
    console.error('[reddit] OAuth init error:', err.message);
  }
}

/** Headers to attach to every Reddit API request. */
export function redditHeaders() {
  const h = { 'User-Agent': USER_AGENT };
  if (_token) h['Authorization'] = `Bearer ${_token}`;
  return h;
}

/** Base URL — oauth.reddit.com when authenticated, www.reddit.com otherwise. */
export function redditBase() {
  return _useOAuth ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
}
