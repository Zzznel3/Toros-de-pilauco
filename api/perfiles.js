// /api/perfiles: el administrador principal crea, cambia y borra los perfiles de los demás administradores.
// GET lista los perfiles (sin contraseñas). POST { op: 'crear' | 'actualizar' | 'borrar', ... }.
const {
  ADMIN_USUARIO, CLAVE_PERFILES, configurado, redis, sesionDe, leerPerfil, datosClave, permisosValidos,
  comandosHistorial, cuerpo,
} = require('./_redis.js');

const USUARIO_VALIDO = /^[a-z0-9._-]{3,30}$/;
const NOMBRES_PERMISO = { pagos: 'pagos', ligas: 'ligas', jugadores: 'jugadores', camisetas: 'camisetas' };
const listaPermisos = (p) => (p.length ? p.map((x) => NOMBRES_PERMISO[x]).join(', ') : 'ninguna sección');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configurado()) { res.status(503).json({ error: 'La base de datos no está conectada en Vercel.' }); return; }
  let sesion;
  try { sesion = await sesionDe(req); } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudo revisar la sesión.' }); return; }
  if (!sesion) { res.status(401).json({ error: 'Hay que ingresar como administrador.' }); return; }
  if (!sesion.principal) { res.status(403).json({ error: 'Solo el administrador principal maneja los perfiles.' }); return; }

  try {
    if (req.method === 'GET') {
      const [plano] = await redis([['HGETALL', CLAVE_PERFILES]]);
      const perfiles = [];
      const sumar = (usuario, texto) => {
        try { const p = JSON.parse(texto); perfiles.push({ usuario, nombre: p.nombre, permisos: permisosValidos(p.permisos), creado: p.creado || null }); } catch (e) { /* perfil dañado */ }
      };
      if (Array.isArray(plano)) for (let i = 0; i + 1 < plano.length; i += 2) sumar(plano[i], plano[i + 1]);
      else if (plano && typeof plano === 'object') for (const [u, t] of Object.entries(plano)) sumar(u, t);
      perfiles.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
      res.status(200).json({ perfiles, principal: { usuario: ADMIN_USUARIO } });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido.' }); return; }

    const b = cuerpo(req);
    const usuario = String(b.usuario || '').trim().toLowerCase();
    if (!USUARIO_VALIDO.test(usuario) || usuario === ADMIN_USUARIO) {
      res.status(400).json({ error: 'El usuario debe tener de 3 a 30 letras minúsculas, números, puntos o guiones, y no puede ser «' + ADMIN_USUARIO + '».' });
      return;
    }

    if (b.op === 'crear') {
      const nombre = String(b.nombre || '').trim().replace(/\s+/g, ' ');
      const clave = String(b.clave || '');
      const permisos = permisosValidos(b.permisos);
      if (!nombre || nombre.length > 40) { res.status(400).json({ error: 'Escribe el nombre (hasta 40 letras).' }); return; }
      if (clave.length < 6 || clave.length > 100) { res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' }); return; }
      if (!permisos.length) { res.status(400).json({ error: 'Marca al menos una sección que pueda editar.' }); return; }
      const perfil = { nombre, permisos, creado: new Date().toISOString(), ...datosClave(clave) };
      const [nuevo] = await redis([['HSETNX', CLAVE_PERFILES, usuario, JSON.stringify(perfil)]]);
      if (Number(nuevo) !== 1) { res.status(409).json({ error: 'Ya existe un administrador con ese usuario.' }); return; }
      await redis(comandosHistorial(sesion, { op: 'crear', coleccion: 'perfiles', id: usuario, descripcion: 'Creó el perfil de ' + nombre + ' (@' + usuario + ') para editar ' + listaPermisos(permisos) }));
      res.status(200).json({ ok: true });
      return;
    }

    const perfil = await leerPerfil(usuario);
    if (!perfil) { res.status(404).json({ error: 'Ese administrador ya no existe.' }); return; }

    if (b.op === 'actualizar') {
      const cambios = [];
      if (b.nombre != null) {
        const nombre = String(b.nombre).trim().replace(/\s+/g, ' ');
        if (!nombre || nombre.length > 40) { res.status(400).json({ error: 'Escribe el nombre (hasta 40 letras).' }); return; }
        if (nombre !== perfil.nombre) { cambios.push('nombre'); perfil.nombre = nombre; }
      }
      if (b.permisos != null) {
        const permisos = permisosValidos(b.permisos);
        if (!permisos.length) { res.status(400).json({ error: 'Marca al menos una sección que pueda editar.' }); return; }
        if (permisos.join() !== permisosValidos(perfil.permisos).join()) { cambios.push('secciones: ' + listaPermisos(permisos)); perfil.permisos = permisos; }
      }
      if (b.clave) {
        const clave = String(b.clave);
        if (clave.length < 6 || clave.length > 100) { res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' }); return; }
        Object.assign(perfil, datosClave(clave));
        cambios.push('contraseña');
      }
      if (!cambios.length) { res.status(200).json({ ok: true, sinCambios: true }); return; }
      await redis([
        ['HSET', CLAVE_PERFILES, usuario, JSON.stringify(perfil)],
        ...comandosHistorial(sesion, { op: 'actualizar', coleccion: 'perfiles', id: usuario, descripcion: 'Cambió el perfil de ' + perfil.nombre + ' (' + cambios.join(', ') + ')' }),
      ]);
      res.status(200).json({ ok: true });
      return;
    }

    if (b.op === 'borrar') {
      await redis([
        ['HDEL', CLAVE_PERFILES, usuario],
        ...comandosHistorial(sesion, { op: 'borrar', coleccion: 'perfiles', id: usuario, descripcion: 'Borró el perfil de ' + perfil.nombre + ' (@' + usuario + ')' }),
      ]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Operación no válida.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar el perfil.' });
  }
};
