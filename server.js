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

/* ---------- Leer una playlist completa de YouTube ---------- */
const CAB = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'es-419,es;q=0.9',
  'Cookie': 'CONSENT=YES+1; SOCS=CAI'
};

function recoger(obj, out, cont) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(x => recoger(x, out, cont)); return; }
  if (obj.playlistVideoRenderer) {
    const r = obj.playlistVideoRenderer;
    const t = r.title && (r.title.runs ? r.title.runs.map(x => x.text).join('') : r.title.simpleText);
    if (r.videoId && t && r.isPlayable !== false) out.push({ id: r.videoId, titulo: t });
  }
  if (obj.continuationItemRenderer) {
    const tk = obj.continuationItemRenderer.continuationEndpoint &&
      obj.continuationItemRenderer.continuationEndpoint.continuationCommand &&
      obj.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    if (tk) cont.push(tk);
  }
  for (const k in obj) if (obj[k] && typeof obj[k] === 'object') recoger(obj[k], out, cont);
}

async function leerPlaylist(pl) {
  const out = [], cont = [];
  let key = null, ver = '2.20240101.00.00', token = null;

  // Intento 1: leer la página de la playlist
  try {
    const r = await fetch('https://www.youtube.com/playlist?list=' + pl, { headers: CAB, signal: AbortSignal.timeout(15000) });
    const html = await r.text();
    const m = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
    if (m) {
      key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
      ver = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || ver;
      recoger(JSON.parse(m[1]), out, cont);
      token = cont[0];
    } else {
      console.log('Playlist: YouTube no devolvió los datos de la página (status ' + r.status + ')');
    }
  } catch (e) { console.log('Playlist: falló la página:', e.message); }

  if (!key) key = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  const llamar = async (extra) => {
    const rr = await fetch('https://www.youtube.com/youtubei/v1/browse?key=' + key, {
      method: 'POST',
      headers: { ...CAB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'es', gl: 'US' } }, ...extra }),
      signal: AbortSignal.timeout(15000)
    });
    return rr.json();
  };

  // Intento 2: pedirla directo a la API de YouTube
  if (!out.length) {
    try {
      const c1 = [];
      recoger(await llamar({ browseId: 'VL' + pl }), out, c1);
      token = c1[0];
      if (!out.length) console.log('Playlist: la API directa tampoco devolvió videos');
    } catch (e) { console.log('Playlist: falló la API directa:', e.message); }
  }

  // Pedir las siguientes tandas hasta terminar
  let vueltas = 0;
  while (token && out.length < 5000 && vueltas < 60) {
    vueltas++;
    try {
      const c2 = [];
      recoger(await llamar({ continuation: token }), out, c2);
      token = c2[0];
    } catch (e) { console.log('Playlist: se cortó en la vuelta ' + vueltas + ':', e.message); break; }
  }

  const vistos = new Set();
  return out.filter(v => okId(v.id) && !vistos.has(v.id) && vistos.add(v.id)).slice(0, 5000);
}

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

  socket.on('playlist', async (pl, cb) => {
    if (typeof cb !== 'function') return;
    if (typeof pl !== 'string' || !/^[\w-]+$/.test(pl)) return cb(null);
    try {
      const l = await leerPlaylist(pl);
      cb(l && l.length ? l : null);
    } catch (e) { cb(null); }
  });

  socket.on('titulos', async (ids, cb) => {
    if (!Array.isArray(ids) || typeof cb !== 'function') return;
    ids = [...new Set(ids)].filter(okId).slice(0, 5000);
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
      .slice(0, 5000)
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
