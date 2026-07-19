const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5174' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Routes are mounted as they are built (Tasks 5-6):
// app.use('/api/pull', require('./routes/pull'));
// app.use('/api/lists', require('./routes/lists'));
// app.use('/api/leads', require('./routes/leads'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}: ${err.message}`);
  res.status(500).json({ error: err.message });
});

module.exports = app;
