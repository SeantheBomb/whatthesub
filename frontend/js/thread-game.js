// Find the Thread — game controller

let puzzle = null;   // { date, comments: [{id, body, score}] }
let reveal = null;   // full answer data (loaded after game ends)
let gameState = null;
let date = null;

// IDs of currently selected comment cards
let selectedIds = new Set();

document.addEventListener('DOMContentLoaded', init);

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  date = new Date().toISOString().slice(0, 10);
  renderDateHeader();
  updateAuthNav();

  const saved = ThreadStorage.getGame(date);

  if (saved && saved.status !== 'playing') {
    gameState = saved;
    renderCompletedShell();
    try {
      reveal = await API.revealThread(date);
      openEndModal(saved.status === 'won', reveal);
    } catch {
      openEndModal(saved.status === 'won', null);
    }
    return;
  }

  try {
    puzzle = await API.fetchThread();
    date = puzzle.date;
    gameState = saved ?? ThreadStorage.initGame(date);
    ThreadStorage.saveGame(date, gameState);
    renderGame();
  } catch (err) {
    showError(err.message);
  }
}

function renderDateHeader() {
  const el = document.getElementById('today-date');
  if (el) {
    el.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderGame() {
  const container = document.getElementById('game-container');
  syncStrikes();

  const foundIds = new Set(
    gameState.found_groups.flatMap(g => g.comment_ids ?? [])
  );

  const remaining = puzzle.comments.filter(c => !foundIds.has(c.id));

  container.innerHTML = `
    <p class="ftt-instruction">Find 4 comments from the same Reddit post.</p>
    <div id="found-groups"></div>
    <div class="ftt-board" id="comment-board"></div>
    <div class="ftt-controls">
      <span class="ftt-selected-count" id="selected-count"></span>
      <button class="ftt-submit-btn" id="submit-btn" disabled onclick="onSubmitGroup()">
        Submit Group
      </button>
      <button class="ftt-deselect-btn" id="deselect-btn" onclick="onDeselect()">
        Deselect All
      </button>
    </div>
  `;

  // Render already-found groups
  renderFoundGroups();

  // Render remaining comment cards
  renderBoard(remaining);
  updateControls();
}

function renderFoundGroups() {
  const el = document.getElementById('found-groups');
  if (!el) return;
  el.innerHTML = '';
  gameState.found_groups.forEach((g, i) => {
    el.appendChild(buildFoundGroupRow(g, i));
  });
}

function buildFoundGroupRow(group, colorIndex) {
  const colors = ['ftt-color-a', 'ftt-color-b', 'ftt-color-c', 'ftt-color-d'];
  const cls = colors[colorIndex % 4];
  const div = document.createElement('div');
  div.className = `ftt-found-group ${cls}`;

  const img = group.post_images?.[0]
    ? `<img class="ftt-group-thumb" src="${escapeHtml(group.post_images[0])}" alt="" loading="lazy" onerror="this.remove()">`
    : '';

  div.innerHTML = `
    <div class="ftt-group-header">
      ${img}
      <div class="ftt-group-meta">
        <span class="ftt-group-sub">r/${escapeHtml(group.subreddit)}</span>
        <a class="ftt-group-title" href="${escapeHtml(group.post_url)}" target="_blank" rel="noopener">
          ${escapeHtml(group.post_title)}
        </a>
      </div>
    </div>
  `;
  return div;
}

function renderBoard(comments) {
  const board = document.getElementById('comment-board');
  if (!board) return;
  board.innerHTML = '';
  comments.forEach(c => {
    board.appendChild(buildCommentCard(c));
  });
}

function buildCommentCard(comment) {
  const card = document.createElement('button');
  card.className = 'ftt-card';
  card.dataset.id = comment.id;
  if (selectedIds.has(comment.id)) card.classList.add('selected');

  const truncated = comment.body.length > 160
    ? comment.body.slice(0, 157) + '…'
    : comment.body;

  card.innerHTML = `
    <span class="ftt-card-body">${escapeHtml(truncated)}</span>
    <span class="ftt-card-score" title="${comment.score} upvotes">▲ ${fmtScore(comment.score)}</span>
  `;

  card.addEventListener('click', () => onCardClick(comment.id));
  return card;
}

function fmtScore(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function renderCompletedShell() {
  const container = document.getElementById('game-container');
  container.innerHTML = `
    <p class="round-indicator" style="margin-top:2rem; text-align:center;">You've already played today.</p>
    <p style="text-align:center; color:var(--muted); font-style:italic; margin-top:0.5rem;">
      Come back tomorrow for a new puzzle.
    </p>
    <div class="countdown-wrap">
      Next puzzle in<br>
      <span class="countdown-timer" id="countdown-main"></span>
    </div>
  `;
  syncStrikes();
  startCountdown('countdown-main');
}

function syncStrikes() {
  const current = gameState?.strikes ?? 0;
  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById(`strike-${i}`);
    if (!dot) continue;
    const shouldBeUsed = i < current;
    const wasUsed = dot.classList.contains('used');
    if (shouldBeUsed && !wasUsed) {
      dot.classList.add('used', 'newly-used');
      setTimeout(() => dot.classList.remove('newly-used'), 450);
    } else if (!shouldBeUsed) {
      dot.classList.remove('used', 'newly-used');
    }
  }
}

function updateControls() {
  const count = selectedIds.size;
  const countEl = document.getElementById('selected-count');
  const submitBtn = document.getElementById('submit-btn');
  const deselectBtn = document.getElementById('deselect-btn');
  if (countEl) countEl.textContent = count > 0 ? `${count} of 4 selected` : '';
  if (submitBtn) submitBtn.disabled = count !== 4;
  if (deselectBtn) deselectBtn.style.visibility = count > 0 ? 'visible' : 'hidden';
}

function showError(msg) {
  document.getElementById('game-container').innerHTML = `
    <div class="error-card" style="margin-top:1.5rem;">
      <p>Couldn't load today's puzzle.</p>
      <small>${escapeHtml(msg)}</small>
    </div>
  `;
}

// ── Interaction ───────────────────────────────────────────────────────────────

function onCardClick(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    if (selectedIds.size >= 4) return; // already at max
    selectedIds.add(id);
  }

  const card = document.querySelector(`.ftt-card[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.toggle('selected', selectedIds.has(id));
  updateControls();
}

function onDeselect() {
  selectedIds.clear();
  document.querySelectorAll('.ftt-card.selected').forEach(c => c.classList.remove('selected'));
  updateControls();
}

async function onSubmitGroup() {
  if (selectedIds.size !== 4) return;

  const group = [...selectedIds];

  // Disable all cards during request
  document.querySelectorAll('.ftt-card').forEach(c => { c.disabled = true; });
  document.getElementById('submit-btn').disabled = true;

  let result;
  try {
    result = await API.submitThreadGuess(date, group);
  } catch (err) {
    console.error('Thread guess error:', err);
    document.querySelectorAll('.ftt-card:not([disabled])').forEach(c => { c.disabled = false; });
    document.getElementById('submit-btn').disabled = false;
    return;
  }

  if (result.correct) {
    await animateCorrectGroup(group, result);

    // Record found group
    gameState.found_groups.push({
      post_index: result.post_index,
      subreddit: result.subreddit,
      post_title: result.post_title,
      post_url: result.post_url,
      post_images: result.post_images ?? null,
      comment_ids: group,
    });
    selectedIds.clear();
    ThreadStorage.saveGame(date, gameState);

    if (gameState.found_groups.length >= 4) {
      await finishWin();
    } else {
      renderGame();
    }
  } else {
    gameState.strikes += 1;
    ThreadStorage.saveGame(date, gameState);
    await animateWrongGroup(group);
    syncStrikes();

    if (gameState.strikes >= gameState.max_strikes) {
      await finishLoss();
    } else {
      selectedIds.clear();
      document.querySelectorAll('.ftt-card').forEach(c => { c.disabled = false; });
      onDeselect();
    }
  }
}

// ── Animations ────────────────────────────────────────────────────────────────

function animateCorrectGroup(ids, result) {
  return new Promise(resolve => {
    ids.forEach(id => {
      const card = document.querySelector(`.ftt-card[data-id="${CSS.escape(id)}"]`);
      if (card) card.classList.add('found');
    });
    setTimeout(resolve, 500);
  });
}

function animateWrongGroup(ids) {
  return new Promise(resolve => {
    ids.forEach(id => {
      const card = document.querySelector(`.ftt-card[data-id="${CSS.escape(id)}"]`);
      if (card) card.classList.add('wrong');
    });
    setTimeout(() => {
      ids.forEach(id => {
        const card = document.querySelector(`.ftt-card[data-id="${CSS.escape(id)}"]`);
        if (card) card.classList.remove('wrong');
      });
      resolve();
    }, 520);
  });
}

// ── Game over ─────────────────────────────────────────────────────────────────

async function finishWin() {
  gameState.status = 'won';
  gameState.completed_at = new Date().toISOString();
  ThreadStorage.saveGame(date, gameState);
  ThreadStorage.updateStatsAfterGame(gameState);

  if (typeof Auth !== 'undefined' && Auth.isLoggedIn()) {
    const secs = gameState.completed_at && gameState.started_at
      ? Math.round((new Date(gameState.completed_at) - new Date(gameState.started_at)) / 1000)
      : null;
    API.saveThreadResult(date, 'won', gameState.strikes, gameState.found_groups.length, secs).catch(() => {});
  }

  try {
    reveal = await API.revealThread(date);
    openEndModal(true, reveal);
  } catch {
    openEndModal(true, null);
  }
}

async function finishLoss() {
  gameState.status = 'lost';
  gameState.completed_at = new Date().toISOString();
  ThreadStorage.saveGame(date, gameState);
  ThreadStorage.updateStatsAfterGame(gameState);

  if (typeof Auth !== 'undefined' && Auth.isLoggedIn()) {
    const secs = gameState.completed_at && gameState.started_at
      ? Math.round((new Date(gameState.completed_at) - new Date(gameState.started_at)) / 1000)
      : null;
    API.saveThreadResult(date, 'lost', gameState.strikes, gameState.found_groups.length, secs).catch(() => {});
  }

  try {
    reveal = await API.revealThread(date);
    openEndModal(false, reveal);
  } catch {
    openEndModal(false, null);
  }
}

// ── End modal ─────────────────────────────────────────────────────────────────

function openEndModal(won, revealData) {
  const found = gameState.found_groups.length;
  const total = 4;

  document.getElementById('end-title').textContent = won ? 'Thread found!' : 'Game Over';
  document.getElementById('end-message').textContent = won
    ? `All ${total} groups with ${gameState.strikes} strike${gameState.strikes !== 1 ? 's' : ''}`
    : `Found ${found} of ${total} groups`;

  document.getElementById('share-card').textContent = buildShareText(won);

  // Countdown
  const modal = document.querySelector('#end-modal .modal');
  const existingCountdown = modal.querySelector('.countdown-wrap');
  if (!existingCountdown) {
    const countdownEl = document.createElement('div');
    countdownEl.className = 'countdown-wrap';
    countdownEl.innerHTML = `Next puzzle in<br><span class="countdown-timer" id="countdown-modal"></span>`;
    document.querySelector('#end-modal .answers-reveal').before(countdownEl);
  }

  // Cross-game prompt
  const existing = modal.querySelector('.cross-game-prompt');
  if (!existing) {
    const crossGame = document.createElement('div');
    crossGame.className = 'cross-game-prompt';
    crossGame.innerHTML = `
      <span>Try today's other puzzle →</span>
      <a href="/index.html" class="cross-game-link">WhatTheSub</a>
    `;
    modal.querySelector('.answers-reveal').before(crossGame);
  }

  if (revealData?.rounds) {
    const foundIndices = new Set(gameState.found_groups.map(g => g.post_index));
    document.getElementById('answers-reveal').innerHTML = revealData.rounds.map((r, i) => {
      const wasFound = foundIndices.has(i);
      const colors = ['ftt-color-a', 'ftt-color-b', 'ftt-color-c', 'ftt-color-d'];
      return `
        <div class="answer-row ftt-answer-row ${wasFound ? 'correct' : 'incorrect'}">
          <span class="ftt-answer-dot ${colors[i % 4]}"></span>
          <a href="${r.post_url}" target="_blank" rel="noopener">r/${escapeHtml(r.subreddit)}</a>
          <span class="result-icon" title="${wasFound ? 'Found!' : 'Not found'}">
            ${wasFound ? '✓' : '✗'}
          </span>
        </div>
      `;
    }).join('');
  }

  // Play Again (admin only)
  const playAgainBtn = document.getElementById('play-again-btn');
  if (playAgainBtn) playAgainBtn.style.display = isAdminMode() ? 'block' : 'none';

  document.getElementById('end-modal').classList.add('visible');
  startCountdown('countdown-modal');
}

function isAdminMode() {
  if (localStorage.getItem('wts_admin') === 'true') return true;
  const user = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  return !!(user?.is_admin || user?.unlimited_play);
}

function buildShareText(won) {
  const d = new Date(date + 'T12:00:00Z');
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const colors = ['🟨', '🟩', '🟦', '🟪'];
  const lines = [`Find the Thread · ${dateStr}`, ''];

  // Show groups in order found; unfound = ✗
  const allIndices = [0, 1, 2, 3];
  allIndices.forEach(idx => {
    const foundAt = gameState.found_groups.findIndex(g => g.post_index === idx);
    if (foundAt !== -1) {
      lines.push(colors[idx % 4].repeat(4));
    } else {
      lines.push('⬛'.repeat(4));
    }
  });

  lines.push('', `Strikes: ${gameState.strikes}/3`);
  lines.push('whatthesub.pages.dev/thread.html');
  return lines.join('\n');
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function formatCountdown() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(0, 5, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const diff = next - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function startCountdown(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = formatCountdown();
  setInterval(() => { el.textContent = formatCountdown(); }, 1000);
}

// ── Auth UI ───────────────────────────────────────────────────────────────────

function openAuthModal() {
  document.getElementById('auth-modal').classList.add('visible');
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.remove('visible');
}

function switchAuthTab(tab) {
  document.getElementById('login-form').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('register-form').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
}

function updateAuthNav() {
  const btn = document.getElementById('auth-nav-btn');
  if (!btn) return;
  const user = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  if (user) {
    btn.outerHTML = `<span class="nav-user-pill">
      <span>${escapeHtml(user.username)}</span>
      <button onclick="Auth.logout()">Sign out</button>
    </span>`;
  }
}

document.getElementById('login-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  err.textContent = '';
  try {
    await Auth.login(
      document.getElementById('login-username').value.trim(),
      document.getElementById('login-password').value,
    );
    closeAuthModal();
    updateAuthNav();
  } catch (ex) { err.textContent = ex.message; }
});

document.getElementById('register-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('register-error');
  err.textContent = '';
  try {
    await Auth.register(
      document.getElementById('reg-username').value.trim(),
      document.getElementById('reg-email').value.trim(),
      document.getElementById('reg-password').value,
    );
    closeAuthModal();
    updateAuthNav();
  } catch (ex) { err.textContent = ex.message; }
});

document.getElementById('auth-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('auth-modal')) closeAuthModal();
});

document.getElementById('copy-btn')?.addEventListener('click', e => {
  const text = document.getElementById('share-card').textContent;
  navigator.clipboard.writeText(text).then(() => {
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = 'Copy to Clipboard'; }, 2000);
  });
});

document.getElementById('play-again-btn')?.addEventListener('click', () => {
  ThreadStorage.clearGame(date);
  location.reload();
});

// ── Util ──────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
