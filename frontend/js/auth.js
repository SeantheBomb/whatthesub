// Auth module — JWT-based user auth for WhatTheSub
const Auth = (() => {
  const TOKEN_KEY = 'wts_token';
  const USER_KEY  = 'wts_user';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
  }

  function setAuth(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function isLoggedIn() { return !!getToken(); }

  async function register(username, email, password) {
    const res = await fetch(`${CONFIG.API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    setAuth(data.token, data.user);
    return data.user;
  }

  async function login(username, password) {
    const res = await fetch(`${CONFIG.API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setAuth(data.token, data.user);
    return data.user;
  }

  async function refreshMe() {
    const token = getToken();
    if (!token) return null;
    try {
      const res = await fetch(`${CONFIG.API_BASE}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) { clearAuth(); return null; }
      const user = await res.json();
      setAuth(token, user);
      return user;
    } catch { return null; }
  }

  function logout() { clearAuth(); location.reload(); }

  return { getToken, getUser, isLoggedIn, register, login, logout, refreshMe };
})();
