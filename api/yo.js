// GET /api/yo: comprueba la sesión guardada en el navegador y devuelve el nombre y los permisos actuales.
const { sesionDe } = require('./_redis.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Método no permitido.' }); return; }
  try {
    const sesion = await sesionDe(req);
    if (!sesion) { res.status(401).json({ error: 'La sesión terminó. Vuelve a ingresar.' }); return; }
    res.status(200).json(sesion);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo revisar la sesión.' });
  }
};
