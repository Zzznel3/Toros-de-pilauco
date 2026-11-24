// POST /api/login: entra con usuario y contraseña. Devuelve una sesión firmada (válida 30 días).
// Después de varias contraseñas malas seguidas, el ingreso queda bloqueado 8 minutos (ver _redis.js).
const {
  ADMIN_USUARIO, configurado, claveValida, nuevoToken, leerPerfil, clavePerfilValida, permisosValidos,
  sesionPrincipal, esperar, cuerpo, BLOQUEO_SEGUNDOS, bloqueoRestante, anotarFallo, borrarFallos,
} = require('./_redis.js');

const minutos = (seg) => { const m = Math.max(1, Math.ceil(seg / 60)); return m === 1 ? '1 minuto' : m + ' minutos'; };

function bloqueado(res, seg) {
  res.setHeader('Retry-After', String(seg));
  res.status(429).json({ error: 'Demasiados intentos fallidos. Espera ' + minutos(seg) + ' y vuelve a intentarlo.', espera: seg });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido.' }); return; }
  if (!process.env.CLAVE_EDITOR) { res.status(503).json({ error: 'Falta definir CLAVE_EDITOR en Vercel.' }); return; }
  const b = cuerpo(req);
  const usuario = String(b.usuario || '').trim().toLowerCase().slice(0, 60);
  const clave = String(b.clave || '');
  if (!usuario || !clave) { res.status(400).json({ error: 'Escribe tu usuario y tu contraseña.' }); return; }
  const conBase = configurado();
  try {
    if (conBase) {
      const resta = await bloqueoRestante(req, usuario);
      if (resta > 0) { bloqueado(res, resta); return; }
    }
    if (usuario === ADMIN_USUARIO) {
      if (claveValida(clave)) {
        if (conBase) await borrarFallos(req, usuario);
        res.status(200).json({ token: nuevoToken('__principal'), ...sesionPrincipal() });
        return;
      }
    } else if (conBase) {
      const perfil = await leerPerfil(usuario);
      if (clavePerfilValida(perfil, clave)) {
        await borrarFallos(req, usuario);
        res.status(200).json({ token: nuevoToken(usuario), principal: false, usuario, nombre: perfil.nombre, permisos: permisosValidos(perfil.permisos) });
        return;
      }
    }
    await esperar(700);
    if (!conBase) { res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }); return; }
    const fallo = await anotarFallo(req, usuario);
    if (fallo.bloqueado) { bloqueado(res, BLOQUEO_SEGUNDOS); return; }
    const aviso = fallo.restantes === 1 ? ' Te queda 1 intento antes de un bloqueo de 8 minutos.'
      : fallo.restantes <= 2 ? ' Te quedan ' + fallo.restantes + ' intentos antes de un bloqueo de 8 minutos.' : '';
    res.status(401).json({ error: 'Usuario o contraseña incorrectos.' + aviso, restantes: fallo.restantes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo revisar el usuario.' });
  }
};
