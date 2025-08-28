const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// SQLite database file
const DB_FILE = path.join(__dirname, 'scores.db');
const db = new sqlite3.Database(DB_FILE);

// Middleware
app.use(cors());
app.use(express.json());

// Initialize table
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS players (
    name TEXT PRIMARY KEY,
    score INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Get leaderboard (top 50)
app.get('/scores', (req, res) => {
  db.all(`SELECT name, score, createdAt, updatedAt
          FROM players
          ORDER BY score DESC
          LIMIT 50`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ players: rows });
  });
});

// Submit score
app.post('/submit', (req, res) => {
  const { name, score } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Invalid name' });
  const parsedScore = Number(score);
  if (!Number.isFinite(parsedScore) || parsedScore < 0) return res.status(400).json({ error: 'Invalid score' });

  const now = new Date().toISOString();

  // Insert or update max score
  db.run(`
    INSERT INTO players (name, score, createdAt, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      score = MAX(score, excluded.score),
      updatedAt = excluded.updatedAt
  `, [name, parsedScore, now, now], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.listen(PORT, () => {
  console.log(`Scoreboard listening on port ${PORT}`);
});
