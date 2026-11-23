// GET /api/estado: devuelve todo lo editado desde la página (cualquiera puede leerlo).
const { configurado, inicializar, leerTodo } = require('./_redis.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Método no permitido.' }); return; }
  if (!configurado()) { res.status(503).json({ error: 'la base de datos no está conectada en Vercel (pestaña Storage).' }); return; }
  try {
    await inicializar();
    res.status(200).json({ colecciones: await leerTodo() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'no se pudo leer la base de datos.' });
  }
};
