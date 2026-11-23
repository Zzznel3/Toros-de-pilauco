// POST /api/escribir: guarda o borra un documento. Exige la clave de editor en el encabezado x-clave.
const crypto = require('crypto');
const { COLECCIONES, configurado, claveRedis, redis, inicializar, claveValida, esperar, cuerpo } = require('./_redis.js');

const ID_VALIDO = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC = 20000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido.' }); return; }
  if (!configurado()) { res.status(503).json({ error: 'La base de datos no está conectada en Vercel.' }); return; }
  if (!process.env.CLAVE_EDITOR) { res.status(503).json({ error: 'Falta definir CLAVE_EDITOR en Vercel.' }); return; }
  if (!claveValida(req.headers['x-clave'])) { await esperar(600); res.status(401).json({ error: 'Clave incorrecta.' }); return; }

  const b = cuerpo(req);
  const { op, coleccion } = b;
  if (!COLECCIONES.includes(coleccion)) { res.status(400).json({ error: 'Colección no válida.' }); return; }

  try {
    await inicializar();
    if (op === 'delete') {
      if (!ID_VALIDO.test(String(b.id || ''))) { res.status(400).json({ error: 'Id no válido.' }); return; }
      await redis([['HDEL', claveRedis(coleccion), b.id]]);
      res.status(200).json({ ok: true, id: b.id });
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
      await redis([['HSET', claveRedis(coleccion), id, texto]]);
      res.status(200).json({ ok: true, id });
      return;
    }
    res.status(400).json({ error: 'Operación no válida.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar.' });
  }
};
