// POST /api/escribir: guarda o borra un documento y lo anota en el historial.
// Exige una sesión de administrador con permiso para la sección de esa colección.
const crypto = require('crypto');
const { COLECCIONES, configurado, claveRedis, redis, inicializar, sesionDe, puedeEscribir, comandosHistorial, cuerpo } = require('./_redis.js');

const ID_VALIDO = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC = 20000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido.' }); return; }
  if (!configurado()) { res.status(503).json({ error: 'La base de datos no está conectada en Vercel.' }); return; }
  if (!process.env.CLAVE_EDITOR) { res.status(503).json({ error: 'Falta definir CLAVE_EDITOR en Vercel.' }); return; }

  let sesion;
  try { sesion = await sesionDe(req); } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudo revisar la sesión.' }); return; }
  if (!sesion) { res.status(401).json({ error: 'La sesión terminó. Vuelve a ingresar.' }); return; }

  const b = cuerpo(req);
  const { op, coleccion } = b;
  if (!COLECCIONES.includes(coleccion)) { res.status(400).json({ error: 'Colección no válida.' }); return; }
  if (!puedeEscribir(sesion, coleccion)) { res.status(403).json({ error: 'Tu perfil no tiene permiso para editar esta sección.' }); return; }

  try {
    await inicializar();
    if (op === 'delete') {
      const id = String(b.id || '');
      if (!ID_VALIDO.test(id)) { res.status(400).json({ error: 'Id no válido.' }); return; }
      await redis([['HDEL', claveRedis(coleccion), id], ...comandosHistorial(sesion, { op, coleccion, id, descripcion: b.descripcion })]);
      res.status(200).json({ ok: true, id });
      return;
    }
    if (op === 'set' || op === 'add') {
      const datos = b.data;
      if (!datos || typeof datos !== 'object' || Array.isArray(datos)) { res.status(400).json({ error: 'Datos no válidos.' }); return; }
      const { id: _ignorado, ...limpio } = datos;
      const texto = JSON.stringify(limpio);
      if (texto.length > MAX_DOC) { res.status(413).json({ error: 'El documento es demasiado grande.' }); return; }
      const id = op === 'add' ? crypto.randomBytes(10).toString('hex') : String(b.id || '');
      if (!ID_VALIDO.test(id)) { res.status(400).json({ error: 'Id no válido.' }); return; }
      await redis([['HSET', claveRedis(coleccion), id, texto], ...comandosHistorial(sesion, { op, coleccion, id, descripcion: b.descripcion })]);
      res.status(200).json({ ok: true, id });
      return;
    }
    res.status(400).json({ error: 'Operación no válida.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar.' });
  }
};
