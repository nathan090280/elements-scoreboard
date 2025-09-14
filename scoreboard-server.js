// Simple Node.js/Express scoreboard server
// Usage (e.g., locally or on Replit/Render):
// 1) Ensure package.json includes: express, cors, bcryptjs, firebase-admin
// 2) Run: node scoreboard-server.js
// 3) The server persists scores in scores.json (created automatically) and optionally Firebase Firestore
//
// Enhancements:
// - Categories support (e.g., overall, easy, medium, hard, etc.)
// - Payload focuses on completedCounts as the source of truth
// - GET /scores?category=...&limit=... returns top players by category
// - GET /player/:name returns all category entries for a player
// - Syncs scores to Firebase Firestore if FIREBASE_KEY env variable is set

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'scores.json');
const USERS_FILE = path.join(__dirname, 'users.json');

app.use(cors());
app.use(express.json());

// Firebase Realtime Database setup
// Note: Use the RTDB URL without any trailing ':null'
if (process.env.FIREBASE_KEY) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://up-n-atom-e1691-default-rtdb.europe-west1.firebasedatabase.app"
    });
  } catch (e) {
    console.error("Failed to initialize Firebase:", e);
  }
}

const rtdb = admin.apps.length ? admin.database() : null;

// Load total number of elements from elements.json (once)
let TOTAL_ELEMENTS = 0;
let ELEMENT_SYMBOLS = {};
try {
  const elemsPath = path.join(__dirname, 'elements.json');
  const raw = fs.readFileSync(elemsPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (parsed && Array.isArray(parsed.elements)) TOTAL_ELEMENTS = parsed.elements.length;
  if (parsed && Array.isArray(parsed.elements)) {
    ELEMENT_SYMBOLS = Object.fromEntries(parsed.elements.map(e => [String(e.atomicNumber), e.symbol]));
  }
} catch (_) {
  // Fallback: 118 as a common table size if file not present
  TOTAL_ELEMENTS = 118;
}

function computePtPercentFromCounts(completedCounts) {
  try {
    if (!completedCounts || typeof completedCounts !== 'object') return 0;
    const counted = Object.keys(completedCounts).length;
    if (!TOTAL_ELEMENTS) return 0;
    return Math.max(0, Math.min(100, Math.round((counted / TOTAL_ELEMENTS) * 100)));
  } catch (_) { return 0; }
}

function computeUniqueElements(completedCounts) {
  try {
    if (!completedCounts || typeof completedCounts !== 'object') return 0;
    return Object.values(completedCounts).filter(v => Number(v) > 0).length;
  } catch (_) { return 0; }
}

function computeTotalCollected(completedCounts) {
  try {
    if (!completedCounts || typeof completedCounts !== 'object') return 0;
    return Object.values(completedCounts).reduce((a, b) => a + Number(b || 0), 0);
  } catch (_) { return 0; }
}

function computeProtonsGathered(completedCounts) {
  try {
    if (!completedCounts || typeof completedCounts !== 'object') return 0;
    let sum = 0;
    for (const [k, v] of Object.entries(completedCounts)) {
      const z = Number(k);
      const cnt = Number(v) || 0;
      if (Number.isFinite(z) && z > 0 && cnt > 0) sum += z * cnt;
    }
    return sum;
  } catch (_) { return 0; }
}

// JSON file helpers
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

// Firebase RTDB sync helper
async function saveScoreToFirebase(entry) {
  if (!rtdb) return; // Firebase not configured
  try {
    const cat = entry.category || 'overall';
    const key = (entry.name || 'anon').toLowerCase();
    const ref = rtdb.ref(`/scores/${cat}/${key}`);
    const payload = { ...entry, updatedAt: new Date().toISOString() };
    await ref.set(payload);
  } catch (err) {
    console.error("Failed to save score to Firebase RTDB:", err);
  }
}

// Firebase RTDB helpers for users
async function saveUserToFirebase(user) {
  if (!rtdb) return; // Firebase not configured
  try {
    if (!user || !user.nameLower) return;
    const ref = rtdb.ref(`/users/${user.nameLower}`);
    const payload = { ...user, updatedAt: new Date().toISOString() };
    await ref.set(payload);
  } catch (err) {
    console.error("Failed to save user to Firebase RTDB:", err);
  }
}

async function getUserFromFirebase(nameLower) {
  if (!rtdb) return null;
  try {
    const snap = await rtdb.ref(`/users/${nameLower}`).get();
    if (snap && snap.exists()) {
      return snap.val();
    }
    return null;
  } catch (err) {
    console.error("Failed to read user from Firebase RTDB:", err);
    return null;
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
    const playerName = String(name || '').trim();
    const isGuest = playerName.length === 0 || playerName.toLowerCase() === 'guest';
    if (!playerName) return res.status(400).json({ error: 'Invalid name' });
    if (isGuest) return res.status(400).json({ error: 'Guest cannot sign up' });
    const users = loadUsers();
    const lower = playerName.toLowerCase();
    // Prefer checking Firebase for global uniqueness if available
    let exists = users.users.find(u => u.nameLower === lower);
    if (rtdb && !exists) {
      const remote = await getUserFromFirebase(lower);
      if (remote) exists = remote;
    }
    if (exists) return res.status(409).json({ error: 'User already exists' });
    const hash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    const newUser = { name: playerName, nameLower: lower, passwordHash: hash, createdAt: now, updatedAt: now };
    users.users.push(newUser);
    // Save locally
    saveUsers(users);
    // Save to Firebase unless Guest
    if (!isGuest) await saveUserToFirebase(newUser);
    return res.json({ ok: true, name: playerName });
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
    const playerName = String(name || '').trim();
    const isGuest = playerName.length === 0 || playerName.toLowerCase() === 'guest';
    const users = loadUsers();
    const lower = playerName.toLowerCase();
    // Prefer RTDB user if present, fallback to local file
    let user = null;
    if (rtdb) {
      user = await getUserFromFirebase(lower);
    }
    if (!user) {
      user = users.users.find(u => u.nameLower === lower);
    }
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    return res.json({ ok: true, name: user.name });
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Get leaderboard (JSON)
app.get('/scores', (req, res) => {
  const { category = 'overall' } = req.query;
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  const data = loadScores();
  const filtered = data.players.filter(p => (p.category || 'overall') === String(category));
  const top = filtered
    .map(p => ({
      ...p,
      ptPercent: computePtPercentFromCounts(p.completedCounts || {}),
      uniqueElements: computeUniqueElements(p.completedCounts || {}),
      totalCollected: computeTotalCollected(p.completedCounts || {}),
      // elementsCreated mirrors uniqueElements for clarity in the client/UI
      elementsCreated: computeUniqueElements(p.completedCounts || {}),
      protonsGathered: computeProtonsGathered(p.completedCounts || {})
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit);
  res.json({ players: top, elementSymbols: ELEMENT_SYMBOLS });
});

// Submit score
app.post('/submit', (req, res) => {
  const { name, score, category = 'overall', moleculesAvailable, completedCounts,
          ptPercent, molPercent, electronsGathered, deaths, longestStreak, timeSeconds } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const playerName = String(name || '').trim();
  const isGuest = playerName.length === 0 || playerName.toLowerCase() === 'guest';
  const parsedScore = Number(score);
  if (!Number.isFinite(parsedScore) || parsedScore < 0) {
    return res.status(400).json({ error: 'Invalid score' });
  }

  const data = loadScores();
  const now = new Date().toISOString();
  const cat = String(category || 'overall');
  const idx = data.players.findIndex(p => p.name.toLowerCase() === playerName.toLowerCase() && (p.category || 'overall') === cat);
  if (idx >= 0) {
    data.players[idx].score = Math.max(data.players[idx].score || 0, parsedScore);
    data.players[idx].updatedAt = now;
    if (Number.isFinite(Number(moleculesAvailable))) data.players[idx].moleculesAvailable = Number(moleculesAvailable);
    if (completedCounts && typeof completedCounts === 'object') {
      const existing = data.players[idx].completedCounts || {};
      const merged = { ...existing };
      for (const [k, v] of Object.entries(completedCounts)) {
        const nv = Number(v) || 0;
        const ev = Number(existing[k] || 0);
        merged[k] = Math.max(ev, nv); // keep cumulative max per element id
      }
      data.players[idx].completedCounts = merged;
    }
    // Server-side derived fields from completedCounts
    data.players[idx].ptPercent = computePtPercentFromCounts(data.players[idx].completedCounts);
    data.players[idx].uniqueElements = computeUniqueElements(data.players[idx].completedCounts);
    data.players[idx].elementsCreated = data.players[idx].uniqueElements; // unique elements collected
    data.players[idx].totalCollected = computeTotalCollected(data.players[idx].completedCounts);
    data.players[idx].protonsGathered = computeProtonsGathered(data.players[idx].completedCounts);
    if (Number.isFinite(Number(molPercent))) data.players[idx].molPercent = Number(molPercent);
    if (Number.isFinite(Number(electronsGathered))) data.players[idx].electronsGathered = Number(electronsGathered);
    if (Number.isFinite(Number(deaths))) data.players[idx].deaths = Number(deaths);
    if (Number.isFinite(Number(longestStreak))) data.players[idx].longestStreak = Number(longestStreak);
    if (Number.isFinite(Number(timeSeconds))) data.players[idx].timeSeconds = Number(timeSeconds);
  } else {
    const entry = {
      name: playerName,
      category: cat,
      score: parsedScore,
      updatedAt: now,
      createdAt: now,
    };
    if (Number.isFinite(Number(moleculesAvailable))) entry.moleculesAvailable = Number(moleculesAvailable);
    if (completedCounts && typeof completedCounts === 'object') entry.completedCounts = completedCounts;
    // Server-side derived fields based on completedCounts
    entry.ptPercent = computePtPercentFromCounts(entry.completedCounts);
    entry.uniqueElements = computeUniqueElements(entry.completedCounts);
    entry.elementsCreated = entry.uniqueElements; // unique elements collected
    entry.totalCollected = computeTotalCollected(entry.completedCounts);
    entry.protonsGathered = computeProtonsGathered(entry.completedCounts);
    if (Number.isFinite(Number(molPercent))) entry.molPercent = Number(molPercent);
    if (Number.isFinite(Number(electronsGathered))) entry.electronsGathered = Number(electronsGathered);
    if (Number.isFinite(Number(deaths))) entry.deaths = Number(deaths);
    if (Number.isFinite(Number(longestStreak))) entry.longestStreak = Number(longestStreak);
    if (Number.isFinite(Number(timeSeconds))) entry.timeSeconds = Number(timeSeconds);
    data.players.push(entry);
  }

  // Persist to local JSON unless Guest
  if (!isGuest) saveScores(data);

  // Sync to Firebase RTDB unless Guest
  if (!isGuest) {
    const latest = (idx >= 0) ? data.players[idx] : data.players[data.players.length - 1];
    saveScoreToFirebase(latest);
  }

  res.json({ ok: true });
});

// Get only per-element completion counts for a player (prefer RTDB)
app.get('/player/:name/element-counts', async (req, res) => {
  try {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    const lower = name.toLowerCase();
    // Try RTDB first
    if (rtdb) {
      try {
        const snap = await rtdb.ref(`/scores/overall/${lower}`).get();
        if (snap && snap.exists()) {
          const val = snap.val() || {};
          return res.json({ completedCounts: val.completedCounts || {} });
        }
      } catch (e) {
        console.warn('RTDB read failed for element-counts, falling back to file:', e.message);
      }
    }
    const data = loadScores();
    const entry = data.players.find(p => p.name.toLowerCase() === lower && (p.category || 'overall') === 'overall');
    return res.json({ completedCounts: (entry && entry.completedCounts) || {} });
  } catch (e) {
    console.error('element-counts error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Removed deprecated /player/:name/atom-counts endpoint; completedCounts is the source of truth

// Get all entries for a given player across categories
app.get('/player/:name', (req, res) => {
  const name = req.params.name;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const data = loadScores();
  const entries = data.players.filter(p => p.name.toLowerCase() === name.toLowerCase());
  res.json({ entries, elementSymbols: ELEMENT_SYMBOLS });
});

app.listen(PORT, () => {
  console.log(`Scoreboard listening on port ${PORT}`);
});
