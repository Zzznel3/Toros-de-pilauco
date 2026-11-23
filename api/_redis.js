// Conexión a la base de datos Redis (Upstash) que se crea desde la pestaña Storage de Vercel.
// Vercel agrega solas las variables KV_REST_API_URL y KV_REST_API_TOKEN al conectarla al proyecto.
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
];

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

function claveValida(dada) {
  const real = process.env.CLAVE_EDITOR || '';
  if (!real || typeof dada !== 'string' || !dada) return false;
  const a = crypto.createHash('sha256').update(dada).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function cuerpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

module.exports = { COLECCIONES, configurado, claveRedis, redis, leerTodo, inicializar, claveValida, esperar, cuerpo };
