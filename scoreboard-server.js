// Simple Node.js/Express scoreboard server
// Usage (e.g., locally or on Replit/Render):
// 1) Ensure package.json includes: express, cors
// 2) Run: node scoreboard-server.js
// 3) The server persists scores in scores.json (created automatically)
//
// Enhancements:
// - Categories support (e.g., overall, easy, medium, hard, etc.)
// - Rich payload: bankTotal (atom bank), moleculesAvailable, completedCounts
// - GET /scores?category=...&limit=... returns top players by category
// - GET /player/:name returns all category entries for a player

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'scores.json');
const USERS_FILE = path.join(__dirname, 'users.json');

app.use(cors());
app.use(express.json());

function loadScores() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ players: [] }, null, 2));
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.players || !Array.isArray(data.players)) return { players: [] };
    return data;
  } catch (e) {
    console.error('Failed to load scores:', e);
    return { players: [] };
  }
}

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
    }
    const raw = fs.readFileSync(USERS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.users || !Array.isArray(data.users)) return { users: [] };
    return data;
  } catch (e) {
    console.error('Failed to load users:', e);
    return { users: [] };
  }
}

function saveUsers(data) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save users:', e);
  }
}

function saveScores(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save scores:', e);
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Sign up a new user: { name, password }
app.post('/signup', async (req, res) => {
  try {
    const { name, password } = req.body || {};
    if (!name || typeof name !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Name and password required' });
    }
    const nameTrim = name.trim();
    if (!nameTrim) return res.status(400).json({ error: 'Invalid name' });
    const users = loadUsers();
    const lower = nameTrim.toLowerCase();
    const exists = users.users.find(u => u.nameLower === lower);
    if (exists) return res.status(409).json({ error: 'User already exists' });
    const hash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    users.users.push({ name: nameTrim, nameLower: lower, passwordHash: hash, createdAt: now, updatedAt: now });
    saveUsers(users);
    return res.json({ ok: true, name: nameTrim });
  } catch (e) {
    console.error('Signup error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Login an existing user: { name, password }
app.post('/login', async (req, res) => {
  try {
    const { name, password } = req.body || {};
    if (!name || typeof name !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Name and password required' });
    }
    const nameTrim = name.trim();
    const users = loadUsers();
    const lower = nameTrim.toLowerCase();
    const user = users.users.find(u => u.nameLower === lower);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    return res.json({ ok: true, name: user.name });
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Get leaderboard (sorted desc by score)
// Optional query params:
// - category: string (filters to entries matching this category; default 'overall')
// - limit: number (max number of entries to return; default 50)
app.get('/scores', (req, res) => {
  const { category = 'overall' } = req.query;
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  const data = loadScores();
  const filtered = data.players.filter(p => (p.category || 'overall') === String(category));
  const top = filtered
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit);
  res.json({ players: top });
});

// Submit score.
// Expected body: {
//   name: string,
//   score: number,
//   category?: string,              // e.g., 'overall' | 'easy' | 'medium' | 'hard'
//   bankTotal?: number,             // total in the atom bank
//   moleculesAvailable?: number,    // count of molecules the bank can assemble
//   completedCounts?: object        // map atomicNumber -> count (optional)
// }
// The server stores the max score per (name, category).
app.post('/submit', (req, res) => {
  const { name, score, category = 'overall', bankTotal, moleculesAvailable, completedCounts,
          atomsCreated, ptPercent, molPercent, electronsGathered, deaths, longestStreak, timeSeconds } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const parsedScore = Number(score);
  if (!Number.isFinite(parsedScore) || parsedScore < 0) {
    return res.status(400).json({ error: 'Invalid score' });
  }

  const data = loadScores();
  const now = new Date().toISOString();
  const cat = String(category || 'overall');
  const idx = data.players.findIndex(p => p.name.toLowerCase() === name.toLowerCase() && (p.category || 'overall') === cat);
  if (idx >= 0) {
    data.players[idx].score = Math.max(data.players[idx].score || 0, parsedScore);
    data.players[idx].updatedAt = now;
    // Update metadata with latest snapshot (non-ranking fields)
    if (Number.isFinite(Number(bankTotal))) data.players[idx].bankTotal = Number(bankTotal);
    if (Number.isFinite(Number(moleculesAvailable))) data.players[idx].moleculesAvailable = Number(moleculesAvailable);
    if (completedCounts && typeof completedCounts === 'object') data.players[idx].completedCounts = completedCounts;
    // Extended fields for richer leaderboards
    if (Number.isFinite(Number(atomsCreated))) data.players[idx].atomsCreated = Number(atomsCreated);
    if (Number.isFinite(Number(ptPercent))) data.players[idx].ptPercent = Number(ptPercent);
    if (Number.isFinite(Number(molPercent))) data.players[idx].molPercent = Number(molPercent);
    if (Number.isFinite(Number(electronsGathered))) data.players[idx].electronsGathered = Number(electronsGathered);
    if (Number.isFinite(Number(deaths))) data.players[idx].deaths = Number(deaths);
    if (Number.isFinite(Number(longestStreak))) data.players[idx].longestStreak = Number(longestStreak);
    if (Number.isFinite(Number(timeSeconds))) data.players[idx].timeSeconds = Number(timeSeconds);
  } else {
    const entry = {
      name,
      category: cat,
      score: parsedScore,
      updatedAt: now,
      createdAt: now,
    };
    if (Number.isFinite(Number(bankTotal))) entry.bankTotal = Number(bankTotal);
    if (Number.isFinite(Number(moleculesAvailable))) entry.moleculesAvailable = Number(moleculesAvailable);
    if (completedCounts && typeof completedCounts === 'object') entry.completedCounts = completedCounts;
    // Extended fields for richer leaderboards
    if (Number.isFinite(Number(atomsCreated))) entry.atomsCreated = Number(atomsCreated);
    if (Number.isFinite(Number(ptPercent))) entry.ptPercent = Number(ptPercent);
    if (Number.isFinite(Number(molPercent))) entry.molPercent = Number(molPercent);
    if (Number.isFinite(Number(electronsGathered))) entry.electronsGathered = Number(electronsGathered);
    if (Number.isFinite(Number(deaths))) entry.deaths = Number(deaths);
    if (Number.isFinite(Number(longestStreak))) entry.longestStreak = Number(longestStreak);
    if (Number.isFinite(Number(timeSeconds))) entry.timeSeconds = Number(timeSeconds);
    data.players.push(entry);
  }
  saveScores(data);
  res.json({ ok: true });
});

// Get all entries for a given player across categories
app.get('/player/:name', (req, res) => {
  const name = req.params.name;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const data = loadScores();
  const entries = data.players.filter(p => p.name.toLowerCase() === name.toLowerCase());
  res.json({ entries });
});

app.listen(PORT, () => {
  console.log(`Scoreboard listening on port ${PORT}`);
});
