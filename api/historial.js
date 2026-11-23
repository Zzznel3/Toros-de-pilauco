// GET /api/historial: últimos cambios hechos desde la página. Solo para administradores.
const { CLAVE_HISTORIAL, configurado, redis, sesionDe } = require('./_redis.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Método no permitido.' }); return; }
  if (!configurado()) { res.status(503).json({ error: 'La base de datos no está conectada en Vercel.' }); return; }
  try {
    const sesion = await sesionDe(req);
    if (!sesion) { res.status(401).json({ error: 'Hay que ingresar como administrador.' }); return; }
    const [lista] = await redis([['LRANGE', CLAVE_HISTORIAL, 0, 199]]);
    const entradas = [];
    for (const texto of lista || []) { try { entradas.push(JSON.parse(texto)); } catch (e) { /* entrada dañada */ } }
    res.status(200).json({ entradas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo leer el historial.' });
  }
};
