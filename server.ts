/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

interface PairingSession {
  offer: string;
  answer?: string;
  createdAt: number;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware for JSON body parsing
  app.use(express.json());

  const sessions = new Map<string, PairingSession>();

  // Cleanup stale sessions every 10 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [pin, session] of sessions.entries()) {
      if (now - session.createdAt > 10 * 60 * 1000) {
        sessions.delete(pin);
      }
    }
  }, 5 * 60 * 1000);

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Create pairing offer
  app.post('/api/pair/create', (req, res) => {
    const { offer } = req.body;
    if (!offer) {
      return res.status(400).json({ error: 'Offer is required' });
    }

    let pin = '';
    let attempts = 0;
    while (attempts < 100) {
      pin = Math.floor(1000 + Math.random() * 9000).toString();
      if (!sessions.has(pin)) {
        break;
      }
      attempts++;
    }

    sessions.set(pin, {
      offer,
      createdAt: Date.now()
    });

    console.log(`[Pairing] Created session for PIN ${pin}`);
    res.json({ pin });
  });

  // Get pairing offer by PIN
  app.get('/api/pair/get', (req, res) => {
    const pin = req.query.pin as string;
    if (!pin) {
      return res.status(400).json({ error: 'PIN is required' });
    }

    const session = sessions.get(pin);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    res.json({ offer: session.offer });
  });

  // Submit answer for PIN
  app.post('/api/pair/answer', (req, res) => {
    const { pin, answer } = req.body;
    if (!pin || !answer) {
      return res.status(400).json({ error: 'PIN and answer are required' });
    }

    const session = sessions.get(pin);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    session.answer = answer;
    console.log(`[Pairing] Submitted answer for PIN ${pin}`);
    res.json({ success: true });
  });

  // Poll for answer as the Laptop Host
  app.get('/api/pair/poll', (req, res) => {
    const pin = req.query.pin as string;
    if (!pin) {
      return res.status(400).json({ error: 'PIN is required' });
    }

    const session = sessions.get(pin);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    if (session.answer) {
      res.json({ answer: session.answer });
    } else {
      res.json({ status: 'waiting' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
