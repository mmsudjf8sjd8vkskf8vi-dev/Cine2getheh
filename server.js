const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

const salas = {};

async function enviarUsuarios(sala) {
  const sockets = await io.in(sala).fetchSockets();
  io.to(sala).emit('usuarios', sockets.map(s => s.data.nombre));
}

io.on('connection', (socket) => {
  socket.on('entrar', ({ sala, nombre }) => {
    socket.join(sala);
    socket.data.sala = sala;
    socket.data.nombre = nombre || 'Invitado';
    const e = (salas[sala] = salas[sala] || { id: null, t: 0, play: false, marca: Date.now() });
    const t = e.t + (e.play ? (Date.now() - e.marca) / 1000 : 0);
    socket.emit('estado', { id: e.id, t, play: e.play });
    enviarUsuarios(sala);
  });

  socket.on('cargar', (id) => {
    const s = socket.data.sala; if (!s) return;
    salas[s] = { id, t: 0, play: true, marca: Date.now() };
    io.to(s).emit('estado', { id, t: 0, play: true });
  });

  socket.on('control', ({ play, t }) => {
    const s = socket.data.sala; if (!s || !salas[s]) return;
    Object.assign(salas[s], { play, t, marca: Date.now() });
    socket.to(s).emit('estado', { id: salas[s].id, t, play });
  });

  socket.on('chat', (texto) => {
    const s = socket.data.sala; if (!s) return;
    io.to(s).emit('chat', { nombre: socket.data.nombre, texto: String(texto).slice(0, 300) });
  });

  socket.on('disconnect', () => {
    if (socket.data.sala) enviarUsuarios(socket.data.sala);
  });
});

server.listen(process.env.PORT || 3000);
