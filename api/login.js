// POST /api/login: entra con usuario y contraseña. Devuelve una sesión firmada (válida 30 días).
const {
  ADMIN_USUARIO, configurado, claveValida, nuevoToken, leerPerfil, clavePerfilValida, permisosValidos,
  sesionPrincipal, esperar, cuerpo,
} = require('./_redis.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido.' }); return; }
  if (!process.env.CLAVE_EDITOR) { res.status(503).json({ error: 'Falta definir CLAVE_EDITOR en Vercel.' }); return; }
  const b = cuerpo(req);
  const usuario = String(b.usuario || '').trim().toLowerCase();
  const clave = String(b.clave || '');
  if (!usuario || !clave) { res.status(400).json({ error: 'Escribe tu usuario y tu contraseña.' }); return; }
  try {
    if (usuario === ADMIN_USUARIO) {
      if (claveValida(clave)) { res.status(200).json({ token: nuevoToken('__principal'), ...sesionPrincipal() }); return; }
    } else if (configurado()) {
      const perfil = await leerPerfil(usuario);
      if (clavePerfilValida(perfil, clave)) {
        res.status(200).json({ token: nuevoToken(usuario), principal: false, usuario, nombre: perfil.nombre, permisos: permisosValidos(perfil.permisos) });
        return;
      }
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo revisar el usuario.' });
    return;
  }
  await esperar(700);
  res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
};
