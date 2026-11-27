const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

const salas = {};

async function titulo(id) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id));
    const j = await r.json();
    return j.title || id;
  } catch (e) { return id; }
}
const pos = (e) => e.t + (e.play ? (Date.now() - e.marca) / 1000 : 0);
const estado = (s) => { const e = salas[s]; return { id: e.id, titulo: e.titulo, t: pos(e), play: e.play }; };

async function usuarios(s) {
  const so = await io.in(s).fetchSockets();
  io.to(s).emit('usuarios', so.map(x => ({ id: x.id, nombre: x.data.nombre, host: x.id === salas[s].host })));
}
function poner(s, id, tit) {
  const e = salas[s];
  Object.assign(e, { id, titulo: tit, t: 0, play: true, marca: Date.now() });
  e.historial.unshift({ id, titulo: tit });
  e.historial = e.historial.slice(0, 30);
  io.to(s).emit('estado', estado(s));
  io.to(s).emit('historial', e.historial);
}

io.on('connection', (socket) => {
  socket.on('entrar', ({ sala, nombre }) => {
    socket.join(sala);
    socket.data.sala = sala;
    socket.data.nombre = String(nombre || 'Invitado').slice(0, 20);
    const e = (salas[sala] = salas[sala] || { id: null, titulo: '', t: 0, play: false, marca: Date.now(), host: null, lista: [], historial: [] });
    if (!e.host) e.host = socket.id;
    if (e.id) socket.emit('estado', estado(sala));
    socket.emit('lista', e.lista);
    socket.emit('historial', e.historial);
    usuarios(sala);
  });

  socket.on('cargar', async (id) => {
    const s = socket.data.sala; if (!s || !salas[s]) return;
    poner(s, id, await titulo(id));
  });

  socket.on('agregar', async (id) => {
    const s = socket.data.sala; if (!s || !salas[s]) return;
    salas[s].lista.push({ id, titulo: await titulo(id) });
    io.to(s).emit('lista', salas[s].lista);
  });

  socket.on('reproducir', (i) => {
    const s = socket.data.sala, e = salas[s]; if (!e || !e.lista[i]) return;
    const it = e.lista.splice(i, 1)[0];
    poner(s, it.id, it.titulo);
    io.to(s).emit('lista', e.lista);
  });

  socket.on('quitar', (i) => {
    const s = socket.data.sala, e = salas[s]; if (!e || !e.lista[i]) return;
    e.lista.splice(i, 1);
    io.to(s).emit('lista', e.lista);
  });

  socket.on('fin', (id) => {
    const s = socket.data.sala, e = salas[s];
    if (!e || e.id !== id) return;
    const sig = e.lista.shift();
    if (sig) { poner(s, sig.id, sig.titulo); io.to(s).emit('lista', e.lista); }
    else { e.play = false; e.t = 0; }
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
