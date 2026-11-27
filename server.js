const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

const salas = {};
const okId = (x) => typeof x === 'string' && /^[\w-]{11}$/.test(x);

async function titulo(url, defecto) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
    const j = await r.json();
    return j.title || defecto;
  } catch (e) { return defecto; }
}
const tituloVideo = (id, def = id) => titulo('https://www.youtube.com/watch?v=' + id, def);

const pos = (e) => e.t + (e.play ? (Date.now() - e.marca) / 1000 : 0);
const estado = (s) => {
  const e = salas[s];
  return { id: e.id, titulo: e.titulo, t: pos(e), play: e.play };
};
const envLista = (dest, e) => dest.emit('lista', { items: e.lista, pos: e.pos });

async function usuarios(s) {
  const so = await io.in(s).fetchSockets();
  io.to(s).emit('usuarios', so.map(x => ({ id: x.id, nombre: x.data.nombre, host: x.id === salas[s].host })));
}

function poner(s, id, tit, p) {
  const e = salas[s];
  Object.assign(e, { id, titulo: tit, t: 0, play: true, marca: Date.now(), pos: p });
  e.historial = [{ id, titulo: tit }, ...e.historial.filter(x => x.id !== id)].slice(0, 50);
  io.to(s).emit('estado', estado(s));
  io.to(s).emit('historial', e.historial);
  io.to(s).emit('chatVideo', { id, titulo: tit });
  envLista(io.to(s), e);
}

function siguienteDe(s) {
  const e = salas[s];
  const n = e.lista[e.pos + 1];
  if (n) poner(s, n.id, n.titulo, e.pos + 1);
  else io.to(s).emit('aviso', 'No hay más videos en la lista');
}

io.on('connection', (socket) => {
  socket.on('entrar', ({ sala, nombre }) => {
    socket.join(sala);
    socket.data.sala = sala;
    socket.data.nombre = String(nombre || 'Invitado').slice(0, 20);
    const e = (salas[sala] = salas[sala] || { id: null, titulo: '', t: 0, play: false, marca: Date.now(), host: null, lista: [], pos: -1, historial: [] });
    if (!e.host) e.host = socket.id;
    if (e.id) socket.emit('estado', estado(sala));
    envLista(socket, e);
    socket.emit('historial', e.historial);
    usuarios(sala);
  });

  socket.on('nombre', (n) => {
    const s = socket.data.sala; if (!s || typeof n !== 'string') return;
    socket.data.nombre = n.trim().slice(0, 20) || socket.data.nombre;
    usuarios(s);
  });

  socket.on('cargar', async (id) => {
    const s = socket.data.sala, e = salas[s];
    if (!e || !okId(id)) return;
    const i = e.lista.findIndex(x => x.id === id);
    poner(s, id, i >= 0 ? e.lista[i].titulo : await tituloVideo(id), i);
  });

  socket.on('reproducir', (i) => {
    const s = socket.data.sala, e = salas[s];
    if (!e || !e.lista[i]) return;
    poner(s, e.lista[i].id, e.lista[i].titulo, i);
  });

  socket.on('siguiente', () => {
    const s = socket.data.sala; if (!s || !salas[s]) return;
    siguienteDe(s);
  });

  socket.on('fin', (id) => {
    const s = socket.data.sala, e = salas[s];
    if (!e || e.id !== id) return;
    const n = e.lista[e.pos + 1];
    if (n) poner(s, n.id, n.titulo, e.pos + 1);
    else { e.play = false; e.t = 0; }
  });

  socket.on('agregar', async (id) => {
    const s = socket.data.sala, e = salas[s];
    if (!e || !okId(id)) return;
    e.lista.push({ id, titulo: await tituloVideo(id) });
    envLista(io.to(s), e);
    io.to(s).emit('aviso', 'Video añadido a la lista');
  });

  socket.on('titulos', async (ids, cb) => {
    if (!Array.isArray(ids) || typeof cb !== 'function') return;
    ids = [...new Set(ids)].filter(okId).slice(0, 200);
    const out = [];
    for (let i = 0; i < ids.length; i += 10) {
      const r = await Promise.all(ids.slice(i, i + 10).map(async (id) => ({ id, titulo: await tituloVideo(id, null) })));
      r.forEach(v => v.titulo && out.push(v));
    }
    cb(out);
  });

  socket.on('importar', (items, cb) => {
    const s = socket.data.sala, e = salas[s];
    if (!e || !Array.isArray(items)) return;
    const nuevos = items
      .filter(v => v && okId(v.id) && typeof v.titulo === 'string')
      .slice(0, 200)
      .map(v => ({ id: v.id, titulo: v.titulo.slice(0, 150) }));
    e.lista.push(...nuevos);
    envLista(io.to(s), e);
    io.to(s).emit('aviso', nuevos.length + ' videos añadidos a la lista');
    if (typeof cb === 'function') cb(nuevos.length);
  });

  socket.on('sugerir', (v) => {
    const s = socket.data.sala; if (!s || !v || !okId(v.id) || typeof v.titulo !== 'string') return;
    io.to(s).emit('chatVideo', { id: v.id, titulo: v.titulo.slice(0, 150), nombre: socket.data.nombre });
  });

  socket.on('renombrar', ({ i, titulo }) => {
    const s = socket.data.sala, e = salas[s];
    if (!e || !e.lista[i] || typeof titulo !== 'string') return;
    e.lista[i].titulo = titulo.trim().slice(0, 150) || e.lista[i].titulo;
    envLista(io.to(s), e);
  });

  socket.on('quitar', (i) => {
    const s = socket.data.sala, e = salas[s];
    if (!e || !e.lista[i]) return;
    e.lista.splice(i, 1);
    if (i <= e.pos) e.pos--;
    envLista(io.to(s), e);
  });

  socket.on('mezclar', () => {
    const s = socket.data.sala, e = salas[s]; if (!e) return;
    for (let i = e.lista.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [e.lista[i], e.lista[j]] = [e.lista[j], e.lista[i]];
    }
    e.pos = e.lista.findIndex(x => x.id === e.id);
    envLista(io.to(s), e);
  });

  socket.on('vaciar', () => {
    const s = socket.data.sala, e = salas[s]; if (!e) return;
    e.lista = []; e.pos = -1;
    envLista(io.to(s), e);
  });

  socket.on('control', ({ play, t }) => {
    const s = socket.data.sala; if (!s || !salas[s]) return;
    Object.assign(salas[s], { play, t, marca: Date.now() });
    socket.to(s).emit('estado', estado(s));
  });

  socket.on('chat', (texto) => {
    const s = socket.data.sala; if (!s) return;
    io.to(s).emit('chat', { nombre: socket.data.nombre, texto: String(texto).slice(0, 300) });
  });

  socket.on('senal', ({ para, tipo, datos }) => {
    io.to(para).emit('senal', { de: socket.id, tipo, datos });
  });

  socket.on('disconnect', async () => {
    const s = socket.data.sala; if (!s || !salas[s]) return;
    if (salas[s].host === socket.id) {
      const so = await io.in(s).fetchSockets();
      salas[s].host = so.length ? so[0].id : null;
    }
    usuarios(s);
  });
});

server.listen(process.env.PORT || 3000);
