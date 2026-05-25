/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

interface SyncMessage {
  id: number;
  data: any;
  sender: string;
}

interface PairingSession {
  offer: string;
  answer?: string;
  createdAt: number;
  messages: SyncMessage[];
  messageIdCounter: number;
  listeners: ((msg: SyncMessage) => void)[];
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
      createdAt: Date.now(),
      messages: [],
      messageIdCounter: 0,
      listeners: []
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

  // Send real-time synchronized handwriting messages
  app.post('/api/sync/send', (req, res) => {
    const { pin, sender, message } = req.body;
    if (!pin || !message) {
      return res.status(400).json({ error: 'PIN and message are required' });
    }

    const session = sessions.get(pin);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    if (!session.messages) session.messages = [];
    if (!session.listeners) session.listeners = [];
    if (session.messageIdCounter === undefined) session.messageIdCounter = 0;

    session.messageIdCounter++;
    const syncMsg: SyncMessage = {
      id: session.messageIdCounter,
      data: message,
      sender: sender || 'unknown'
    };

    // Store in historical message buffer for polling recovery
    session.messages.push(syncMsg);
    // Limit buffer to last 100 messages to prevent memory leak
    if (session.messages.length > 100) {
      session.messages.shift();
    }

    // Trigger SSE listeners instantly
    for (const listener of session.listeners) {
      try {
        listener(syncMsg);
      } catch (err) {
        console.error('Error in SSE listener:', err);
      }
    }

    res.json({ success: true, messageId: syncMsg.id });
  });

  // Real-time server-sent events stream
  app.get('/api/sync/stream', (req, res) => {
    const pin = req.query.pin as string;
    const clientType = req.query.client as string || 'unknown';
    if (!pin) {
      return res.status(400).send('PIN is required');
    }

    const session = sessions.get(pin);
    if (!session) {
      return res.status(440).send('Session not found or expired');
    }

    if (!session.messages) session.messages = [];
    if (!session.listeners) session.listeners = [];

    // Set headers for Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable buffering in reverse proxy
    });

    // Send initial connection message/keepalive
    res.write(`data: ${JSON.stringify({ type: 'connected', pin })}\n\n`);

    const listener = (msg: SyncMessage) => {
      // Don't send back to the sender
      if (msg.sender !== clientType) {
        res.write(`data: ${JSON.stringify(msg.data)}\n\n`);
      }
    };

    session.listeners.push(listener);

    // Keepalive ping every 10 seconds to bypass proxy timeouts
    const keepAliveInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 10000);

    req.on('close', () => {
      clearInterval(keepAliveInterval);
      if (sessions.has(pin)) {
        const s = sessions.get(pin);
        if (s && s.listeners) {
          s.listeners = s.listeners.filter(l => l !== listener);
        }
      }
    });
  });

  // Fast HTTP poll as fallback for stream disruption
  app.get('/api/sync/poll-data', (req, res) => {
    const pin = req.query.pin as string;
    const lastIdStr = req.query.lastId as string;
    const clientType = req.query.client as string || 'unknown';

    if (!pin) {
      return res.status(400).json({ error: 'PIN is required' });
    }

    const session = sessions.get(pin);
    if (!session) {
      return res.status(444).json({ error: 'Session not found or expired' });
    }

    if (!session.messages) session.messages = [];

    const lastId = lastIdStr ? parseInt(lastIdStr, 10) : 0;
    const newMessages = session.messages.filter(msg => msg.id > lastId && msg.sender !== clientType);

    res.json({
      messages: newMessages.map(msg => msg.data),
      lastId: session.messages.length > 0 ? session.messages[session.messages.length - 1].id : lastId
    });
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
