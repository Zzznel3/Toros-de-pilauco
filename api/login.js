// POST /api/login: comprueba la clave de editor (variable CLAVE_EDITOR en Vercel).
const { claveValida, esperar, cuerpo } = require('./_redis.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido.' }); return; }
  if (!process.env.CLAVE_EDITOR) { res.status(503).json({ error: 'Falta definir CLAVE_EDITOR en Vercel.' }); return; }
  if (!claveValida(cuerpo(req).clave)) { await esperar(600); res.status(401).json({ error: 'Clave incorrecta.' }); return; }
  res.status(200).json({ ok: true });
};
