const express = require('express'), http = require('http'), crypto = require('crypto'), fs = require('fs');
const { Server } = require('socket.io');
const app = express(), srv = http.createServer(app);
const io = new Server(srv, { maxHttpBufferSize: 5e6 });
app.use(express.json());
app.get('/', (q, r) => r.sendFile(__dirname + '/index.html'));

// ---- Base de datos (Upstash Redis si hay variables; si no, archivo local) ----
const F = __dirname + '/data.json';
const UR = process.env.UPSTASH_URL, UT = process.env.UPSTASH_TOKEN;
let db = { users: {}, rooms: {}, tokens: {} }, tm;
async function load() {
  try {
    if (UR) {
      const r = await fetch(UR + '/get/db', { headers: { Authorization: 'Bearer ' + UT } });
      const j = await r.json();
      if (j.result) return JSON.parse(j.result);
    } else return JSON.parse(fs.readFileSync(F));
  } catch (e) {}
  return null;
}
function save() {
  clearTimeout(tm);
  tm = setTimeout(() => {
    const s = JSON.stringify(db);
    if (UR) fetch(UR + '/set/db', { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body: s }).catch(() => {});
    else try { fs.writeFileSync(F, s); } catch (e) {}
  }, 800);
}

// ---- Cuentas ----
const hash = (p, s = crypto.randomBytes(8).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const ok = (p, h) => !!h && hash(p, h.split(':')[0]) === h;
const tok = k => { const t = crypto.randomBytes(24).toString('hex'); db.tokens[t] = k; save(); return t; };
const E = (r, m) => r.status(400).json({ e: m });

app.post('/api/register', (q, r) => {
  const u = String(q.body.u || ''), p = String(q.body.p || '');
  if (!/^[\w.-]{3,20}$/.test(u) || p.length < 4) return E(r, 'Usuario: 3-20 letras o números. Clave: mínimo 4.');
  const k = u.toLowerCase();
  if (db.users[k]) return E(r, 'Ese usuario ya existe');
  db.users[k] = { n: u, h: hash(p), rooms: [] };
  r.json({ t: tok(k), n: u });
});
app.post('/api/login', (q, r) => {
  const k = String(q.body.u || '').toLowerCase(), x = db.users[k];
  if (!x || !ok(String(q.body.p || ''), x.h)) return E(r, 'Usuario o clave incorrectos');
  r.json({ t: tok(k), n: x.n });
});

// ---- Google ----
app.get('/api/cfg', (q, r) => r.json({ g: process.env.GOOGLE_CLIENT_ID || '' }));
app.post('/api/google', async (q, r) => {
  try {
    const x = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(q.body.c || '')))).json();
    if (!x.sub || x.aud !== process.env.GOOGLE_CLIENT_ID) return E(r, 'Google no pudo verificar tu cuenta');
    const k = 'g:' + x.sub, n = String(x.given_name || x.name || 'Usuario').slice(0, 20);
    if (!db.users[k]) db.users[k] = { n, h: '', rooms: [] };
    r.json({ t: tok(k), n: db.users[k].n });
  } catch (e) { E(r, 'Error con Google'); }
});

// ---- Salas ----
io.use((s, n) => {
  const k = db.tokens[s.handshake.auth.t];
  if (!k || !db.users[k]) return n(new Error('auth'));
  s.k = k; n();
});
const members = id => [...(io.sockets.adapter.rooms.get(id) || [])];
const people = id => {
  const seen = new Set(), rm = db.rooms[id];
  return members(id).map(i => io.sockets.sockets.get(i)).filter(x => x && !seen.has(x.k) && seen.add(x.k))
    .map(x => ({ n: db.users[x.k].n, o: x.k === rm.owner }));
};
const pub = id => { const r = db.rooms[id]; return { id, name: r.name, priv: r.priv, n: people(id).length }; };

io.on('connection', s => {
  const me = () => db.users[s.k];
  const rm = () => db.rooms[s.room];
  const q = () => io.to(s.room).emit('q', { q: rm().q, cur: rm().cur });
  const go = i => {
    const r = rm();
    if (!r || i < 0 || i >= r.q.length) return;
    r.cur = i; r.st = { playing: true, t: 0, at: Date.now() };
    save(); io.to(s.room).emit('go', { cur: i });
  };

  s.on('my', a => a(me().rooms.filter(i => db.rooms[i]).map(i => ({ ...pub(i), own: db.rooms[i].owner === s.k }))));

  s.on('create', (d, a) => {
    if (d.priv && !String(d.pass || '').trim()) return a({ e: 'Pon una clave para la sala privada' });
    const id = crypto.randomBytes(3).toString('hex').toUpperCase();
    db.rooms[id] = {
      name: String(d.name || 'Sala').slice(0, 30), owner: s.k, priv: !!d.priv,
      pass: d.priv ? hash(String(d.pass)) : '', q: [], cur: -1, st: { playing: false, t: 0, at: Date.now() }
    };
    me().rooms.push(id); save(); a({ id });
  });

  s.on('join', (d, a) => {
    const id = String(d.id || '').toUpperCase(), r = db.rooms[id];
    if (!r) return a({ e: 'No existe esa sala' });
    const mine = me().rooms.includes(id);
    if (r.priv && !mine && !(d.pass && ok(String(d.pass), r.pass))) return a({ e: 'Clave incorrecta' });
    if (!mine) { me().rooms.push(id); save(); }
    if (s.room) s.leave(s.room);
    s.join(id); s.room = id;
    const t = r.st.t + (r.st.playing ? (Date.now() - r.st.at) / 1000 : 0);
    a({ id, name: r.name, own: r.owner === s.k, q: r.q, cur: r.cur, st: { playing: r.st.playing, t } });
    io.to(id).emit('ppl', people(id));
  });

  s.on('chat', m => { if (rm()) io.to(s.room).emit('chat', { n: me().n, m: String(m).slice(0, 500) }); });

  s.on('add', (items, p) => {
    const r = rm();
    if (!r || !Array.isArray(items)) return;
    const n0 = r.q.length;
    for (const x of items) if (r.q.length < 5000) r.q.push({ id: String(x.id).slice(0, 11), t: String(x.t || '').slice(0, 100) });
    save(); q();
    if (r.q.length > n0 && (p || r.cur < 0)) go(n0);
  });

  s.on('play', go);
  s.on('next', from => { const r = rm(); if (r && r.cur === from) go(r.cur + 1); });

  s.on('rm', i => {
    const r = rm();
    if (!r || !r.q[i]) return;
    const was = i === r.cur;
    r.q.splice(i, 1);
    if (i < r.cur) r.cur--;
    save(); q();
    if (was) r.q.length ? go(Math.min(i, r.q.length - 1)) : (r.cur = -1);
  });

  s.on('st', d => {
    const r = rm();
    if (!r) return;
    r.st = { playing: !!d.playing, t: +d.t || 0, at: Date.now() };
    s.to(s.room).emit('st', r.st);
  });

  s.on('ti', d => {
    const r = rm();
    if (r && r.q[d.i] && !r.q[d.i].t) { r.q[d.i].t = String(d.t).slice(0, 100); save(); q(); }
  });

  s.on('del', id => {
    const r = db.rooms[id];
    if (r && r.owner === s.k) {
      io.to(id).emit('gone');
      delete db.rooms[id];
      for (const u of Object.values(db.users)) u.rooms = u.rooms.filter(x => x !== id);
      save();
    }
  });

  s.on('out', () => { const id = s.room; if (id) { s.leave(id); s.room = null; io.to(id).emit('ppl', people(id)); } });
  s.on('disconnect', () => { if (s.room && db.rooms[s.room]) io.to(s.room).emit('ppl', people(s.room)); });
});

(async () => {
  const d = await load();
  if (d) db = { users: d.users || {}, rooms: d.rooms || {}, tokens: d.tokens || {} };
  srv.listen(process.env.PORT || 3000, () => console.log('Listo'));
})();
