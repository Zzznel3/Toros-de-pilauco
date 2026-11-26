// Conexión a la base de datos Redis (Upstash) y manejo de administradores y sesiones.
// Vercel agrega solas las variables KV_REST_API_URL y KV_REST_API_TOKEN al conectar la base al proyecto.
const crypto = require('crypto');

// Si al conectar la base se eligió otro prefijo (por ejemplo STORAGE_), se busca cualquier variable que termine igual.
const variable = (...nombres) => {
  for (const n of nombres) if (process.env[n]) return process.env[n];
  const sufijo = nombres[0].replace(/^KV_/, '_');
  const otra = Object.keys(process.env).find((k) => k.endsWith(sufijo) && !k.includes('READ_ONLY'));
  return otra ? process.env[otra] : '';
};
const URL_REDIS = variable('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const TOKEN = variable('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');
const PREFIJO = 'toros:';

// Lo que se edita desde la página. Cada colección es un hash de Redis: id -> documento en JSON.
const COLECCIONES = [
  'plantel_extra',
  'plantel_quitados',
  'arbitraje_cambios',
  'ligas_extra',
  'ligas_ajustes',
  'ligas_inscripciones',
  'camisetas_extra',
  'camisetas_quitadas',
  'camisetas_prestamos',
  'camisetas_no_disponibles',
  'camisetas_pedidos_cambios',
];

// Secciones que se pueden dar a cada administrador, y qué secciones permiten escribir en cada colección.
const PERMISOS = ['pagos', 'ligas', 'jugadores', 'camisetas'];
const PERMISO_DE = {
  arbitraje_cambios: ['pagos', 'ligas'],
  ligas_inscripciones: ['pagos', 'ligas'],
  ligas_extra: ['ligas', 'jugadores'],
  ligas_ajustes: ['ligas'],
  plantel_extra: ['jugadores'],
  plantel_quitados: ['jugadores'],
  camisetas_extra: ['camisetas'],
  camisetas_quitadas: ['camisetas'],
  camisetas_prestamos: ['camisetas'],
  camisetas_no_disponibles: ['camisetas'],
  camisetas_pedidos_cambios: ['camisetas'],
};

// Administrador principal: entra con este usuario y la contraseña CLAVE_EDITOR (variable de Vercel).
const ADMIN_USUARIO = String(process.env.ADMIN_USUARIO || 'admin').trim().toLowerCase();
const ADMIN_NOMBRE = String(process.env.ADMIN_NOMBRE || 'Admin principal').trim();
const CLAVE_PERFILES = PREFIJO + 'perfiles';
const CLAVE_HISTORIAL = PREFIJO + 'historial';
const MAX_HISTORIAL = 300;
const DURACION_SESION_MS = 30 * 24 * 60 * 60 * 1000;

const configurado = () => Boolean(URL_REDIS && TOKEN);
const claveRedis = (coleccion) => PREFIJO + 'col:' + coleccion;

async function redis(comandos) {
  const r = await fetch(URL_REDIS.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(comandos),
  });
  if (!r.ok) throw new Error('Redis respondió ' + r.status);
  const respuestas = await r.json();
  for (const x of respuestas) if (x && x.error) throw new Error('Redis: ' + x.error);
  return respuestas.map((x) => (x ? x.result : null));
}

function filasDe(resultado) {
  const filas = [];
  const sumar = (id, texto) => {
    try { filas.push({ ...JSON.parse(texto), id }); } catch (e) { /* documento dañado: se ignora */ }
  };
  if (Array.isArray(resultado)) {
    for (let i = 0; i + 1 < resultado.length; i += 2) sumar(resultado[i], resultado[i + 1]);
  } else if (resultado && typeof resultado === 'object') {
    for (const [id, texto] of Object.entries(resultado)) sumar(id, texto);
  }
  return filas;
}

async function leerTodo() {
  const resultados = await redis(COLECCIONES.map((c) => ['HGETALL', claveRedis(c)]));
  const salida = {};
  COLECCIONES.forEach((c, i) => { salida[c] = filasDe(resultados[i]); });
  return salida;
}

// La primera vez, copia a la base de datos lo que ya estaba editado en la página de Claude.
async function inicializar() {
  const [marcado] = await redis([['SET', PREFIJO + 'inicializado', new Date().toISOString(), 'NX']]);
  if (marcado !== 'OK') return;
  const semilla = require('./_semilla.js');
  const comandos = [];
  for (const c of COLECCIONES) {
    for (const doc of semilla[c] || []) {
      const { id, ...resto } = doc;
      comandos.push(['HSET', claveRedis(c), id, JSON.stringify(resto)]);
    }
  }
  if (comandos.length) await redis(comandos);
}

// ---------- Contraseñas y sesiones ----------
function iguales(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Contraseña del administrador principal.
function claveValida(dada) {
  const real = process.env.CLAVE_EDITOR || '';
  if (!real || typeof dada !== 'string' || !dada) return false;
  return iguales(dada, real);
}

function secreto() {
  return crypto.createHash('sha256').update('toros-sesion|' + (process.env.SESION_SECRETO || process.env.CLAVE_EDITOR || '')).digest();
}

function nuevoToken(usuario) {
  const cuerpoToken = Buffer.from(JSON.stringify({ u: usuario, iat: Date.now(), exp: Date.now() + DURACION_SESION_MS })).toString('base64url');
  const firma = crypto.createHmac('sha256', secreto()).update(cuerpoToken).digest('base64url');
  return cuerpoToken + '.' + firma;
}

function leerToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [cuerpoToken, firma] = token.split('.');
  const esperada = crypto.createHmac('sha256', secreto()).update(cuerpoToken).digest();
  const dada = Buffer.from(firma || '', 'base64url');
  if (dada.length !== esperada.length || !crypto.timingSafeEqual(dada, esperada)) return null;
  let datos;
  try { datos = JSON.parse(Buffer.from(cuerpoToken, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!datos || typeof datos.u !== 'string' || !(datos.exp > Date.now())) return null;
  return datos;
}

function hashClave(clave, sal) { return crypto.scryptSync(String(clave), sal, 32).toString('hex'); }

function clavePerfilValida(perfil, clave) {
  if (!perfil || !perfil.sal || !perfil.hash || typeof clave !== 'string' || !clave) return false;
  const a = Buffer.from(hashClave(clave, perfil.sal), 'hex');
  const b = Buffer.from(perfil.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function datosClave(clave) {
  const sal = crypto.randomBytes(16).toString('hex');
  return { sal, hash: hashClave(clave, sal), desde: Date.now() };
}

async function leerPerfil(usuario) {
  const [texto] = await redis([['HGET', CLAVE_PERFILES, usuario]]);
  if (!texto) return null;
  try { return JSON.parse(texto); } catch (e) { return null; }
}

const permisosValidos = (lista) => (Array.isArray(lista) ? lista : []).filter((p, i, a) => PERMISOS.includes(p) && a.indexOf(p) === i);
const sesionPrincipal = () => ({ principal: true, usuario: ADMIN_USUARIO, nombre: ADMIN_NOMBRE, permisos: PERMISOS.slice() });

// Quién hace la petición (o null). Lee los permisos actuales del perfil en cada petición.
async function sesionDe(req) {
  if (!process.env.CLAVE_EDITOR && !process.env.SESION_SECRETO) return null;
  const cabecera = String(req.headers.authorization || '');
  const datos = leerToken(cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '');
  if (!datos) return null;
  if (datos.u === '__principal') return sesionPrincipal();
  const perfil = await leerPerfil(datos.u);
  if (!perfil) return null;
  if (perfil.desde && (!datos.iat || datos.iat < perfil.desde)) return null;
  return { principal: false, usuario: datos.u, nombre: perfil.nombre, permisos: permisosValidos(perfil.permisos) };
}

const puedeEscribir = (sesion, coleccion) => Boolean(sesion && (sesion.principal || (PERMISO_DE[coleccion] || []).some((p) => sesion.permisos.includes(p))));

// Comandos para anotar un cambio en el historial (se mandan junto con el cambio).
function comandosHistorial(sesion, entrada) {
  const registro = {
    cuando: new Date().toISOString(),
    quien: sesion.nombre,
    usuario: sesion.usuario,
    descripcion: String(entrada.descripcion || '').slice(0, 300),
    op: entrada.op || '',
    coleccion: entrada.coleccion || '',
    id: entrada.id || '',
  };
  return [['LPUSH', CLAVE_HISTORIAL, JSON.stringify(registro)], ['LTRIM', CLAVE_HISTORIAL, 0, MAX_HISTORIAL - 1]];
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Bloqueo por intentos fallidos al ingresar ----------
// 5 contraseñas malas seguidas desde un mismo equipo (o 20 a un mismo usuario desde cualquier lugar)
// bloquean el ingreso por 8 minutos. Las direcciones IP se guardan cifradas y se borran solas.
const BLOQUEO_SEGUNDOS = 8 * 60;
const MAX_FALLOS_EQUIPO = 5;
const MAX_FALLOS_USUARIO = 20;
const huella = (texto) => crypto.createHash('sha256').update(String(texto)).digest('hex').slice(0, 32);

function ipDe(req) {
  const h = req.headers || {};
  const ip = h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || 'desconocida';
  return String(ip).trim();
}

const clavesFallos = (req, usuario) => [PREFIJO + 'fallos:equipo:' + huella(ipDe(req)), PREFIJO + 'fallos:usuario:' + huella(usuario)];
const segundos = (ttl) => (Number(ttl) > 0 ? Number(ttl) : BLOQUEO_SEGUNDOS);

// Segundos que faltan para poder volver a intentar (0 si no está bloqueado).
async function bloqueoRestante(req, usuario) {
  const [kEquipo, kUsuario] = clavesFallos(req, usuario);
  const [nEquipo, tEquipo, nUsuario, tUsuario] = await redis([['GET', kEquipo], ['TTL', kEquipo], ['GET', kUsuario], ['TTL', kUsuario]]);
  let resta = 0;
  if (Number(nEquipo) >= MAX_FALLOS_EQUIPO) resta = Math.max(resta, segundos(tEquipo));
  if (Number(nUsuario) >= MAX_FALLOS_USUARIO) resta = Math.max(resta, segundos(tUsuario));
  return resta;
}

// Anota una contraseña mala. Al llegar al límite, el bloqueo dura 8 minutos desde ese intento.
async function anotarFallo(req, usuario) {
  const [kEquipo, kUsuario] = clavesFallos(req, usuario);
  const r = await redis([
    ['SET', kEquipo, '0', 'EX', BLOQUEO_SEGUNDOS, 'NX'], ['INCR', kEquipo],
    ['SET', kUsuario, '0', 'EX', BLOQUEO_SEGUNDOS, 'NX'], ['INCR', kUsuario],
  ]);
  const nEquipo = Number(r[1]);
  const nUsuario = Number(r[3]);
  const alargar = [];
  if (nEquipo >= MAX_FALLOS_EQUIPO) alargar.push(['EXPIRE', kEquipo, BLOQUEO_SEGUNDOS]);
  if (nUsuario >= MAX_FALLOS_USUARIO) alargar.push(['EXPIRE', kUsuario, BLOQUEO_SEGUNDOS]);
  if (alargar.length) await redis(alargar);
  return { restantes: Math.max(0, MAX_FALLOS_EQUIPO - nEquipo), bloqueado: alargar.length > 0 };
}

// Al entrar bien, se olvidan los intentos fallidos de ese equipo y de ese usuario.
async function borrarFallos(req, usuario) {
  await redis([['DEL', ...clavesFallos(req, usuario)]]);
}

function cuerpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

module.exports = {
  COLECCIONES, PERMISOS, ADMIN_USUARIO, CLAVE_PERFILES, CLAVE_HISTORIAL,
  configurado, claveRedis, redis, leerTodo, inicializar,
  claveValida, nuevoToken, clavePerfilValida, datosClave, leerPerfil, permisosValidos,
  sesionPrincipal, sesionDe, puedeEscribir, comandosHistorial, esperar, cuerpo,
  BLOQUEO_SEGUNDOS, bloqueoRestante, anotarFallo, borrarFallos,
};
