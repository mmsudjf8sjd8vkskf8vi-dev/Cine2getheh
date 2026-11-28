const path = require('path');
const https = require('https');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'índice.html'));
});

const salas = new Map();

function crearSala(codigo) {
  return {
    codigo,
    usuarios: new Map(), // socketId -> { id, nombre, host }
    vip: false,
    items: [],          // [{ id, titulo, fuente }]
    pos: -1,
    historial: [],    // [{ id, titulo, fuente }]
    estado: { id: null, fuente: 'yt', play: false, t: 0, ts: Date.now() }
  };
}

function obtenerSala(codigo) {
  if (!salas.has(codigo)) salas.set(codigo, crearSala(codigo));
  return salas.get(codigo);
}

function esHost(salaObj, socketId) {
  return Boolean(salaObj.usuarios.get(socketId)?.host);
}

function puedeControlar(salaObj, socketId) {
  if (!salaObj.vip) return true;
  return esHost(salaObj, socketId);
}

function tiempoActual(salaObj) {
  const e = salaObj.estado;
  if (!e.id || !e.play) return e.t || 0;
  const delta = (Date.now() - (e.ts || Date.now())) / 1000;
  return Math.max(0, (e.t || 0) + delta);
}

function emitirEstado(salaObj, target = null) {
  const payload = {
    id: salaObj.estado.id,
    fuente: salaObj.estado.fuente || 'yt',
    play: Boolean(salaObj.estado.play),
    t: tiempoActual(salaObj),
    vip: Boolean(salaObj.vip)
  };
  if (target) target.emit('estado', payload);
  else io.to(salaObj.codigo).emit('estado', payload);
}

function emitirUsuarios(salaObj) {
  const lista = Array.from(salaObj.usuarios.values());
  io.to(salaObj.codigo).emit('usuarios', lista);
}

function emitirLista(salaObj, target = null) {
  const payload = { items: salaObj.items, pos: salaObj.pos };
  if (target) target.emit('lista', payload);
  else io.to(salaObj.codigo).emit('lista', payload);
}

function emitirHistorial(salaObj, target = null) {
  if (target) target.emit('historial', salaObj.historial);
  else io.to(salaObj.codigo).emit('historial', salaObj.historial);
}

function agregarHistorial(salaObj, video) {
  if (!video || !video.id) return;
  const item = {
    id: String(video.id),
    titulo: String(video.titulo || video.id),
    fuente: video.fuente === 'tubi' ? 'tubi' : 'yt'
  };
  salaObj.historial = [
    item,
    ...salaObj.historial.filter(v => !(v.id === item.id && v.fuente === item.fuente))
  ].slice(0, 50);
  emitirHistorial(salaObj);
}

function reproducirIndice(salaObj, idx) {
  if (!salaObj.items.length) return;
  const i = ((idx % salaObj.items.length) + salaObj.items.length) % salaObj.items.length;
  salaObj.pos = i;
  const v = salaObj.items[i];
  const fuente = v.fuente === 'tubi' ? 'tubi' : 'yt';
  salaObj.estado = { id: v.id, fuente, play: true, t: 0, ts: Date.now() };
  agregarHistorial(salaObj, v);
  emitirLista(salaObj);
  emitirEstado(salaObj);
}

function cargarVideoDirecto(salaObj, id, titulo = null, fuente = 'yt') {
  if (!id) return;
  const limpio = String(id).trim();
  if (!limpio) return;
  const src = fuente === 'tubi' ? 'tubi' : 'yt';
  const idx = salaObj.items.findIndex(v => v.id === limpio && (v.fuente || 'yt') === src);
  if (idx !== -1) salaObj.pos = idx;
  salaObj.estado = { id: limpio, fuente: src, play: true, t: 0, ts: Date.now() };
  agregarHistorial(salaObj, { id: limpio, titulo: titulo || limpio, fuente: src });
  emitirLista(salaObj);
  emitirEstado(salaObj);
}

/* ---------- Consulta YouTube (sin API key) ---------- */
function fetchTexto(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Demasiadas redirecciones'));
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'es-419,es;q=0.9,en;q=0.8'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(fetchTexto(nextUrl, redirects + 1));
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => resolve(raw));
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function obtenerTituloVideo(id) {
  try {
    const u = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`;
    const txt = await fetchTexto(u);
    const data = JSON.parse(txt);
    return { id, titulo: data.title || id, fuente: 'yt' };
  } catch (e) {
    return { id, titulo: id, fuente: 'yt' };
  }
}

async function obtenerTitulos(ids) {
  const unicos = Array.from(new Set((ids || []).filter(Boolean).map(x => String(x).trim()))).slice(0, 200);
  const res = [];
  for (let i = 0; i < unicos.length; i += 8) {
    const parcial = await Promise.all(unicos.slice(i, i + 8).map(obtenerTituloVideo));
    res.push(...parcial);
  }
  return res;
}

function extraerVideosDeObjeto(obj, mapa) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) extraerVideosDeObjeto(item, mapa);
    return;
  }
  const r = obj.playlistVideoRenderer || obj.playlistPanelVideoRenderer;
  if (r && r.videoId && !mapa.has(r.videoId)) {
    const titulo = r.title?.runs?.map(x => x.text).join('') || r.title?.simpleText || r.videoId;
    mapa.set(r.videoId, { id: r.videoId, titulo, fuente: 'yt' });
  }
  for (const k of Object.keys(obj)) extraerVideosDeObjeto(obj[k], mapa);
}

async function obtenerPlaylist(listId) {
  if (!listId) return [];
  try {
    const html = await fetchTexto(`https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`);
    const mapa = new Map();
    const m1 = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    const m2 = html.match(/ytInitialData\]\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    const jsonStr = (m1 && m1[1]) || (m2 && m2[1]);
    if (jsonStr) {
      try { extraerVideosDeObjeto(JSON.parse(jsonStr), mapa); } catch (e) {}
    }
    if (!mapa.size) {
      const regex = /"videoId":"([\w-]{11})"[\s\S]{0,400}?"title":\{"runs":\[\{"text":"([^"]+)"/g;
      let match;
      while ((match = regex.exec(html)) !== null && mapa.size < 500) {
        const id = match[1];
        const titulo = match[2].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
        if (!mapa.has(id)) mapa.set(id, { id, titulo, fuente: 'yt' });
      }
    }
    return Array.from(mapa.values()).slice(0, 500);
  } catch (e) {
    return [];
  }
}

/* ---------- Socket.IO ---------- */
io.on('connection', (socket) => {
  let salaActual = null;

  socket.on('entrar', ({ sala, nombre }) => {
    const codigo = String(sala || '').trim().replace(/[^\w-]/g, '').slice(0, 30);
    if (!codigo) return;

    if (salaActual && salaActual.codigo !== codigo) {
      salaActual.usuarios.delete(socket.id);
      socket.leave(salaActual.codigo);
      emitirUsuarios(salaActual);
    }

    const salaObj = obtenerSala(codigo);
    salaActual = salaObj;
    socket.join(codigo);

    const noTieneHost = !Array.from(salaObj.usuarios.values()).some(u => u.host);
    const nomLimpio = String(nombre || 'Invitado').trim().slice(0, 20) || 'Invitado';

    salaObj.usuarios.set(socket.id, { id: socket.id, nombre: nomLimpio, host: noTieneHost });

    emitirUsuarios(salaObj);
    emitirLista(salaObj, socket);
    emitirHistorial(salaObj, socket);
    emitirEstado(salaObj, socket);
  });

  socket.on('nombre', (nuevoNombre) => {
    if (!salaActual) return;
    const u = salaActual.usuarios.get(socket.id);
    if (!u) return;
    const limp = String(nuevoNombre || '').trim().slice(0, 20);
    if (limp) { u.nombre = limp; emitirUsuarios(salaActual); }
  });

  socket.on('toggleVip', () => {
    if (!salaActual) return;
    if (!esHost(salaActual, socket.id)) {
      return socket.emit('aviso', 'Solo el anfitrión 👑 puede cambiar el modo VIP');
    }
    salaActual.vip = !salaActual.vip;
    io.to(salaActual.codigo).emit('aviso', salaActual.vip ? 'Modo VIP activado (solo 👑 controla)' : 'Modo VIP desactivado');
    emitirEstado(salaActual);
  });

  socket.on('expulsar', (targetId) => {
    if (!salaActual || !targetId) return;
    if (!esHost(salaActual, socket.id)) {
      return socket.emit('aviso', 'Solo el anfitrión 👑 puede expulsar usuarios');
    }
    if (targetId === socket.id) return;
    const objetivo = salaActual.usuarios.get(targetId);
    if (!objetivo) return;
    salaActual.usuarios.delete(targetId);
    emitirUsuarios(salaActual);
    io.to(targetId).emit('expulsado');
    const sObj = io.sockets.sockets.get(targetId);
    if (sObj) sObj.leave(salaActual.codigo);
    io.to(salaActual.codigo).emit('aviso', `${objetivo.nombre} fue expulsado de la sala`);
  });

  socket.on('control', ({ play, t }) => {
    if (!salaActual) return;
    if (!puedeControlar(salaActual, socket.id)) {
      emitirEstado(salaActual, socket);
      return socket.emit('aviso', 'Modo VIP activo: solo el anfitrión 👑 controla la reproducción');
    }
    const tiempo = typeof t === 'number' && !Number.isNaN(t) ? Math.max(0, t) : tiempoActual(salaActual);
    salaActual.estado = { ...salaActual.estado, play: Boolean(play), t: tiempo, ts: Date.now() };
    socket.to(salaActual.codigo).emit('estado', {
      id: salaActual.estado.id,
      fuente: salaActual.estado.fuente || 'yt',
      play: salaActual.estado.play,
      t: salaActual.estado.t,
      vip: Boolean(salaActual.vip)
    });
  });

  socket.on('fin', (videoIdTerminado) => {
    if (!salaActual || !salaActual.items.length) return;
    if (!puedeControlar(salaActual, socket.id)) return;
    let idx = salaActual.pos;
    if (idx < 0 && videoIdTerminado) {
      idx = salaActual.items.findIndex(v => v.id === videoIdTerminado);
    }
    const siguienteIdx = idx + 1;
    if (siguienteIdx < salaActual.items.length) {
      reproducirIndice(salaActual, siguienteIdx);
    } else {
      salaActual.estado.play = false;
      salaActual.estado.t = 0;
      salaActual.estado.ts = Date.now();
    }
  });

  socket.on('cargar', async (payload) => {
    if (!salaActual || !payload) return;
    if (!puedeControlar(salaActual, socket.id)) {
      return socket.emit('aviso', 'Modo VIP activo: solo el anfitrión 👑 puede cambiar el video');
    }
    if (typeof payload === 'object') {
      const id = String(payload.id || '').trim();
      const fuente = payload.fuente === 'tubi' ? 'tubi' : 'yt';
      const titulo = payload.titulo || id;
      if (!id) return;
      if (fuente === 'tubi') return cargarVideoDirecto(salaActual, id, titulo, 'tubi');
      const info = await obtenerTituloVideo(id);
      return cargarVideoDirecto(salaActual, info.id, info.titulo, 'yt');
    }
    const info = await obtenerTituloVideo(String(payload).trim());
    cargarVideoDirecto(salaActual, info.id, info.titulo, 'yt');
  });

  socket.on('reproducir', (idx) => {
    if (!salaActual) return;
    if (!puedeControlar(salaActual, socket.id)) {
      return socket.emit('aviso', 'Modo VIP activo: solo el anfitrión 👑 controla la lista');
    }
    reproducirIndice(salaActual, Number(idx) || 0);
  });

  socket.on('siguiente', () => {
    if (!salaActual || !salaActual.items.length) return;
    if (!puedeControlar(salaActual, socket.id)) {
      return socket.emit('aviso', 'Modo VIP activo: solo el anfitrión 👑 controla la lista');
    }
    const next = salaActual.pos < 0 ? 0 : (salaActual.pos + 1) % salaActual.items.length;
    reproducirIndice(salaActual, next);
  });

  socket.on('mezclar', () => {
    if (!salaActual || salaActual.items.length < 2) return;
    if (!puedeControlar(salaActual, socket.id)) {
      return socket.emit('aviso', 'Modo VIP activo: solo el anfitrión 👑 puede mezclar');
    }
    const actual = salaActual.pos >= 0 ? salaActual.items[salaActual.pos] : null;
    for (let i = salaActual.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [salaActual.items[i], salaActual.items[j]] = [salaActual.items[j], salaActual.items[i]];
    }
    salaActual.pos = actual ? salaActual.items.findIndex(v => v.id === actual.id) : -1;
    emitirLista(salaActual);
    socket.emit('aviso', 'Lista mezclada');
  });

  socket.on('vaciar', () => {
    if (!salaActual) return;
    if (!puedeControlar(salaActual, socket.id)) {
      return socket.emit('aviso', 'Modo VIP activo: solo el anfitrión 👑 puede vaciar la lista');
    }
    salaActual.items = [];
    salaActual.pos = -1;
    emitirLista(salaActual);
    socket.emit('aviso', 'Lista vaciada');
  });

  socket.on('quitar', (idx) => {
    if (!salaActual) return;
    if (!puedeControlar(salaActual, socket.id)) {
      return socket.emit('aviso', 'Modo VIP activo: solo el anfitrión 👑 puede quitar videos');
    }
    const i = Number(idx);
    if (i < 0 || i >= salaActual.items.length) return;
    salaActual.items.splice(i, 1);
    if (salaActual.items.length === 0) salaActual.pos = -1;
    else if (i < salaActual.pos) salaActual.pos--;
    else if (i === salaActual.pos) salaActual.pos = Math.min(salaActual.pos, salaActual.items.length - 1);
    emitirLista(salaActual);
  });

  socket.on('renombrar', ({ i, titulo }) => {
    if (!salaActual) return;
    if (!puedeControlar(salaActual, socket.id)) {
      return socket.emit('aviso', 'Modo VIP activo: solo el anfitrión 👑 puede renombrar');
    }
    const idx = Number(i);
    const nuevo = String(titulo || '').trim().slice(0, 120);
    if (idx < 0 || idx >= salaActual.items.length || !nuevo) return;
    salaActual.items[idx].titulo = nuevo;
    emitirLista(salaActual);
  });

  socket.on('agregar', async (payload) => {
    if (!salaActual || !payload) return;
    if (typeof payload === 'object') {
      const id = String(payload.id || '').trim();
      const fuente = payload.fuente === 'tubi' ? 'tubi' : 'yt';
      const titulo = String(payload.titulo || id).trim().slice(0, 140);
      if (!id) return;
      salaActual.items.push({ id, titulo, fuente });
      emitirLista(salaActual);
      return socket.emit('aviso', 'Añadido a la lista');
    }
    const info = await obtenerTituloVideo(String(payload).trim());
    salaActual.items.push({ id: info.id, titulo: info.titulo, fuente: 'yt' });
    emitirLista(salaActual);
    socket.emit('aviso', 'Añadido a la lista');
  });

  socket.on('importar', (listaVideos, ack) => {
    if (!salaActual || !Array.isArray(listaVideos)) {
      if (typeof ack === 'function') ack();
      return;
    }
    const limpios = listaVideos
      .filter(v => v && v.id)
      .slice(0, 500)
      .map(v => ({
        id: String(v.id).trim(),
        titulo: String(v.titulo || v.id).trim().slice(0, 140),
        fuente: v.fuente === 'tubi' ? 'tubi' : 'yt'
      }));
    salaActual.items.push(...limpios);
    emitirLista(salaActual);
    socket.emit('aviso', `Se importaron ${limpios.length} videos`);
    if (typeof ack === 'function') ack();
  });

  socket.on('titulos', async (ids, ack) => {
    const res = await obtenerTitulos(Array.isArray(ids) ? ids : []);
    if (typeof ack === 'function') ack(res);
  });

  socket.on('playlist', async (listId, ack) => {
    const res = await obtenerPlaylist(String(listId || '').trim());
    if (typeof ack === 'function') ack(res);
  });

  socket.on('chat', (texto) => {
    if (!salaActual) return;
    const u = salaActual.usuarios.get(socket.id);
    const limpio = String(texto || '').trim().slice(0, 500);
    if (!limpio) return;
    io.to(salaActual.codigo).emit('chat', {
      nombre: u ? u.nombre : 'Invitado',
      texto: limpio
    });
  });

  socket.on('sugerir', (video) => {
    if (!salaActual || !video || !video.id) return;
    const u = salaActual.usuarios.get(socket.id);
    io.to(salaActual.codigo).emit('chatVideo', {
      nombre: u ? u.nombre : 'Invitado',
      id: String(video.id),
      titulo: String(video.titulo || video.id),
      fuente: video.fuente === 'tubi' ? 'tubi' : 'yt'
    });
  });

  socket.on('senal', ({ para, tipo, datos }) => {
    if (!para || !tipo) return;
    io.to(para).emit('senal', { de: socket.id, tipo, datos });
  });

  socket.on('disconnect', () => {
    if (!salaActual) return;
    const eraHost = salaActual.usuarios.get(socket.id)?.host;
    salaActual.usuarios.delete(socket.id);

    if (salaActual.usuarios.size === 0) {
      salas.delete(salaActual.codigo);
      return;
    }

    if (eraHost) {
      const siguiente = salaActual.usuarios.values().next().value;
      if (siguiente) siguiente.host = true;
    }
    emitirUsuarios(salaActual);
  });
});

server.listen(PORT, () => {
  console.log(`Cine2Gether escuchando en el puerto ${PORT}`);
});
