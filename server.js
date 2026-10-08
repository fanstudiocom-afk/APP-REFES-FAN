// Herramienta interna de FAN Studio: clientes, ideas (links), briefs y generación
// de guiones y contenido para redes con la API de Claude.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const {
  PORT = 3000,
  APP_PASSWORD,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-5-5',
  DATA_FILE = path.join(__dirname, 'data.json'),
} = process.env;

for (const [name, value] of Object.entries({ APP_PASSWORD, ANTHROPIC_API_KEY })) {
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
}

const styleGuide = fs.readFileSync(path.join(__dirname, 'style.md'), 'utf8');

// ---------- Datos ----------
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { clients: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

let db = loadData();

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function findClient(id) {
  return db.clients.find((c) => c.id === id);
}

// ---------- Sesión ----------
const sessions = new Set();

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => part.trim().split('=')).filter(([k]) => k)
  );
}

function samePassword(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie).session;
  if (token && sessions.has(token)) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

// ---------- Claude ----------
const KIND_INSTRUCTIONS = {
  guion: `Escribí un GUION de video con: título, objetivo, duración sugerida, y una tabla de escenas con columnas: tiempo, plano/cámara, acción, diálogo o voz en off. Cerralo con el llamado a la acción.`,
  contenido: `Escribí un PAQUETE DE CONTENIDO PARA REDES con: 10 ideas de clips cortos (cada una con gancho de los primeros 3 segundos, título y descripción breve), 3 textos para publicaciones (con hashtags) y 3 llamados a la acción.`,
};

async function generateWithClaude({ clientName, notes, links, brief, kind }) {
  const linksText = links.length
    ? links.map((l) => `- ${l.title}${l.url ? ` (${l.url})` : ''}${l.note ? `: ${l.note}` : ''}`).join('\n')
    : 'Sin referencias guardadas.';

  const userMessage = `Cliente: ${clientName}
Notas del cliente: ${notes || 'Sin notas.'}

Referencias e ideas guardadas:
${linksText}

Brief del proyecto:
${brief}

Tarea: ${KIND_INSTRUCTIONS[kind]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system: `Sos el asistente creativo interno de FAN Studio. Seguí esta guía de estilo:\n\n${styleGuide}`,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude respondió ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  if (!samePassword(req.body?.password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).session;
  sessions.delete(token);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/clients', requireAuth, (_req, res) => {
  res.json(db.clients.map(({ id, name, createdAt }) => ({ id, name, createdAt })));
});

app.post('/api/clients', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const notes = String(req.body?.notes || '').trim();
  if (!name) return res.status(400).json({ error: 'Falta el nombre del cliente' });

  const client = { id: newId(), name, notes, createdAt: now(), items: [] };
  db.clients.push(client);
  save();
  res.status(201).json(client);
});

app.get('/api/clients/:id', requireAuth, (req, res) => {
  const client = findClient(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(client);
});

app.delete('/api/clients/:id', requireAuth, (req, res) => {
  db.clients = db.clients.filter((c) => c.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.post('/api/clients/:id/items', requireAuth, (req, res) => {
  const client = findClient(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

  const title = String(req.body?.title || '').trim();
  const url = String(req.body?.url || '').trim();
  const note = String(req.body?.note || '').trim();
  if (!title) return res.status(400).json({ error: 'Falta un título' });

  const item = { id: newId(), type: 'link', title, url, note, createdAt: now() };
  client.items.push(item);
  save();
  res.status(201).json(item);
});

app.delete('/api/clients/:id/items/:itemId', requireAuth, (req, res) => {
  const client = findClient(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

  client.items = client.items.filter((i) => i.id !== req.params.itemId);
  save();
  res.json({ ok: true });
});

app.post('/api/clients/:id/generate', requireAuth, async (req, res) => {
  const client = findClient(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

  const brief = String(req.body?.brief || '').trim();
  const kind = req.body?.kind;
  if (!brief) return res.status(400).json({ error: 'Falta el brief' });
  if (!KIND_INSTRUCTIONS[kind]) return res.status(400).json({ error: 'Tipo inválido' });

  const links = client.items.filter((i) => i.type === 'link');

  try {
    const text = await generateWithClaude({
      clientName: client.name,
      notes: client.notes,
      links,
      brief,
      kind,
    });

    const output = { id: newId(), type: 'output', kind, brief, text, createdAt: now() };
    client.items.push(output);
    save();
    res.status(201).json(output);
  } catch (error) {
    console.error('Error generando contenido:', error.message);
    res.status(502).json({ error: 'No se pudo generar el contenido. Intentá de nuevo.' });
  }
});

app.listen(PORT, () => {
  console.log(`App escuchando en el puerto ${PORT}`);
});
