/*
 * Runtime de la página de Toros de Pilauco en Vercel.
 * Hace lo que en Claude hacía la plataforma: carga los datos, resuelve los cálculos (dash.calc),
 * dibuja las partes que dependen de los datos (dash.draw) y guarda los cambios (claude.use('db')).
 * Además maneja los perfiles de administrador: ingreso con usuario y contraseña, permisos por sección,
 * historial de cambios y la pestaña Administradores del administrador principal.
 */
(function () {
  'use strict';

  // Datos fijos copiados de la planilla (carpeta /datos).
  const ARCHIVOS = {
    arbitraje: 'datos/arbitraje.json',
    ligas: 'datos/ligas.json',
    inscripcion: 'datos/inscripcion.json',
    camisetas_pedidos: 'datos/camisetas_pedidos.json',
    camisetas_numeros: 'datos/camisetas_numeros.json',
  };
  // Datos que se editan desde la página (guardados en la base de datos de Vercel).
  const COLECCIONES = {
    jugadores_extra: 'plantel_extra',
    jugadores_quitados: 'plantel_quitados',
    arbitraje_cambios: 'arbitraje_cambios',
    ligas_extra: 'ligas_extra',
    ligas_ajustes: 'ligas_ajustes',
    inscripcion_cambios: 'ligas_inscripciones',
    camisetas_extra: 'camisetas_extra',
    camisetas_quitadas: 'camisetas_quitadas',
    camisetas_prestamos: 'camisetas_prestamos',
    camisetas_no_disponibles: 'camisetas_no_disponibles',
  };
  const RUTAS = {
    'data/plantel/extra': 'plantel_extra',
    'data/plantel/quitados': 'plantel_quitados',
    'data/arbitraje/cambios': 'arbitraje_cambios',
    'data/ligas/extra': 'ligas_extra',
    'data/ligas/ajustes': 'ligas_ajustes',
    'data/ligas/inscripciones': 'ligas_inscripciones',
    'data/camisetas/extra': 'camisetas_extra',
    'data/camisetas/quitadas': 'camisetas_quitadas',
    'data/camisetas/prestamos': 'camisetas_prestamos',
    'data/camisetas/no-disponibles': 'camisetas_no_disponibles',
  };
  const PERMISOS = ['pagos', 'ligas', 'jugadores', 'camisetas'];
  const NOMBRE_PERMISO = { pagos: 'Pagos', ligas: 'Ligas', jugadores: 'Jugadores', camisetas: 'Camisetas' };
  const SESION_LS = 'toros-sesion';
  const CADA_MS = 30000;

  const estado = { archivos: {}, colecciones: {}, cargado: false, errorArchivos: null, errorBase: null, firma: '' };
  const calcs = {};
  const cache = new Map();
  const dibujos = new Map();
  const alCambiar = [];
  let domListo = false;
  let sesion = null;
  let resolverPermiso;
  const permisoListo = new Promise((r) => { resolverPermiso = r; });

  const el = (tag, cls, texto) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texto != null) e.textContent = texto;
    return e;
  };

  // ---------- Datos y cálculos ----------
  function data(id) {
    if (ARCHIVOS[id]) {
      if (estado.errorArchivos) return { status: 'error', data: [], message: String(estado.errorArchivos.message || estado.errorArchivos) };
      return estado.cargado ? { status: 'ok', data: estado.archivos[id] || [] } : { status: 'loading', data: [] };
    }
    if (COLECCIONES[id]) {
      return estado.cargado ? { status: 'ok', data: estado.colecciones[COLECCIONES[id]] || [] } : { status: 'loading', data: [] };
    }
    const def = calcs[id];
    if (!def) return { status: 'missing', data: [] };
    if (cache.has(id)) return cache.get(id);
    const entradas = def.inputs.map(data);
    if (entradas.some((x) => x.status !== 'ok')) {
      return { status: entradas.some((x) => x.status === 'error') ? 'error' : 'loading', data: [] };
    }
    let r;
    try {
      r = { status: 'ok', data: def.fn(...entradas.map((x) => x.data)) };
    } catch (e) {
      console.error('Cálculo ' + id, e);
      r = { status: 'error', data: [], message: e.message };
    }
    cache.set(id, r);
    return r;
  }

  function correrDibujo(nombre) {
    const fn = dibujos.get(nombre);
    if (!fn) return;
    for (const nodo of document.querySelectorAll('[data-draw="' + nombre + '"]')) {
      try { fn(nodo); } catch (e) { console.error('Dibujo ' + nombre, e); }
    }
  }

  function redibujar() {
    cache.clear();
    for (const fn of alCambiar) { try { fn(); } catch (e) { console.error('onData', e); } }
    for (const nombre of dibujos.keys()) correrDibujo(nombre);
    pintarAviso();
  }

  window.dash = {
    calc(id, def) { calcs[id] = def; },
    draw(nombre, fn) {
      if (typeof fn === 'function') { dibujos.set(nombre, fn); if (domListo) correrDibujo(nombre); }
      else correrDibujo(nombre);
    },
    data,
    onData(fn) { alCambiar.push(fn); try { fn(); } catch (e) { /* se reintenta al cargar */ } },
    setLink(id) { try { history.replaceState(null, '', '#' + id); } catch (e) { /* sin historial */ } },
    params() { return {}; },
    setParams() {},
    resetParams() {},
    colors: ['rgba(255, 255, 255, 0.9)'],
  };

  // ---------- Comunicación con el servidor ----------
  async function api(ruta, opciones) {
    const op = opciones || {};
    const headers = { 'Content-Type': 'application/json' };
    if (sesion && sesion.token && !op.sinSesion) headers.Authorization = 'Bearer ' + sesion.token;
    const r = await fetch(ruta, { method: op.method || 'GET', headers, body: op.body ? JSON.stringify(op.body) : undefined, cache: 'no-store' });
    let j = {};
    try { j = await r.json(); } catch (e) { /* respuesta vacía */ }
    if (r.status === 401 && sesion && !op.sinSesion) cerrarSesion();
    if (!r.ok) {
      const error = new Error(j.error || 'Error ' + r.status);
      error.status = r.status;
      throw error;
    }
    return j;
  }

  // ---------- Carga ----------
  async function leerJson(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error('No se pudo leer ' + url + ' (' + r.status + ')');
    return r.json();
  }

  function aplicarColecciones(cols) {
    const firma = JSON.stringify(cols);
    if (firma === estado.firma) return false;
    estado.firma = firma;
    estado.colecciones = {};
    for (const nombre of Object.values(COLECCIONES)) estado.colecciones[nombre] = Array.isArray(cols[nombre]) ? cols[nombre] : [];
    return true;
  }

  async function leerBase() {
    const j = await api('/api/estado', { sinSesion: true });
    estado.errorBase = null;
    return aplicarColecciones(j.colecciones || {});
  }

  async function cargarTodo() {
    try {
      const pares = await Promise.all(Object.entries(ARCHIVOS).map(async ([id, url]) => [id, await leerJson(url)]));
      for (const [id, filas] of pares) estado.archivos[id] = filas;
    } catch (e) {
      estado.errorArchivos = e;
      console.error(e);
    }
    try { await leerBase(); }
    catch (e) {
      estado.errorBase = e;
      aplicarColecciones({});
      console.error(e);
    }
    estado.cargado = true;
    redibujar();
  }

  async function refrescar() {
    if (!estado.cargado || document.visibilityState !== 'visible') return;
    try { if (await leerBase()) redibujar(); else pintarAviso(); }
    catch (e) { estado.errorBase = e; pintarAviso(); }
    if (sesion && panelVisible('historial')) cargarHistorial();
  }

  // ---------- Descripción de cada cambio (para el historial) ----------
  const ligaDe = (key) => (data('ligas_todas').data || []).find((l) => l.key === key) || null;
  const nombreLiga = (key) => { const l = ligaDe(key); return l ? l.corto || l.nombre : String(key || ''); };
  const plata = (v) => (window.toros ? window.toros.clp(v) : '$' + v);
  const periodo = (key, mes) => {
    const l = ligaDe(key);
    const texto = l && window.toros ? window.toros.descPeriodo(l, mes) : mes;
    return /^Fecha /.test(String(texto)) ? texto : String(texto || '').toLowerCase();
  };
  const camiseta = (d) => (d.modelo || 'Camiseta') + ' n.º ' + d.numero;

  function describir(c, previo) {
    const d = c.data || previo || {};
    const borra = c.op === 'delete';
    switch (c.coleccion) {
      case 'arbitraje_cambios': {
        const donde = 'Arbitraje ' + nombreLiga(d.cancha) + ', ' + periodo(d.cancha, d.mes);
        if (borra) return donde + ': ' + d.jugador + ' vuelve al dato de la planilla';
        const saldo = Number(d.saldo_pendiente) || 0;
        const que = d.estado === 'Pagado' ? (saldo > 0 ? 'pagó una parte (falta ' + plata(saldo) + ')' : 'pagó') : d.estado === 'Debe' ? 'debe' : 'sin registro';
        return donde + ': ' + d.jugador + ' → ' + que;
      }
      case 'ligas_inscripciones': {
        const donde = 'Inscripción ' + nombreLiga(d.liga);
        if (borra) return donde + ': ' + d.jugador + ' vuelve al dato de la planilla';
        return donde + ': ' + d.jugador + ' → ' + (d.estado === 'Pagado' ? 'pagada' : 'pendiente');
      }
      case 'ligas_extra':
        if (borra) return 'Eliminó la liga ' + (d.nombre || '');
        return (c.op === 'add' ? 'Creó la liga ' : 'Editó la liga ') + (d.nombre || '');
      case 'ligas_ajustes':
        if (borra) return 'Volvió la ' + (d.nombre || 'liga') + ' a como está en la planilla';
        return 'Editó la ' + (d.nombre || 'liga');
      case 'plantel_extra':
        if (borra) return 'Borró al jugador ' + (d.jugador || '');
        return (c.op === 'add' ? 'Agregó al jugador ' : 'Editó al jugador ') + (d.jugador || '');
      case 'plantel_quitados':
        return (borra ? 'Restauró al jugador ' : 'Quitó al jugador ') + (d.jugador || '');
      case 'camisetas_extra':
        return (borra ? 'Borró la camiseta ' : 'Agregó la camiseta ') + camiseta(d) + ' (' + (d.nombre || 'del equipo') + ')';
      case 'camisetas_quitadas':
        return (borra ? 'Restauró la camiseta ' : 'Quitó la camiseta ') + camiseta(d) + ' (' + (d.nombre || 'del equipo') + ')';
      case 'camisetas_prestamos':
        if (borra) return 'Marcó como devuelta la ' + camiseta(d) + (d.a ? ' (estaba con ' + d.a + ')' : '');
        return 'Prestó la ' + camiseta(d) + ' a ' + (d.a || 'alguien');
      case 'camisetas_no_disponibles':
        return (borra ? 'Marcó como disponible la ' : 'Marcó como no disponible la ') + camiseta(d);
      default:
        return '';
    }
  }

  // ---------- Base de datos (lo que la página pide con claude.use('db')) ----------
  async function escribir(cuerpo) {
    if (!cuerpo.coleccion) throw new Error('Colección desconocida');
    if (!sesion) throw new Error('Hay que ingresar como administrador');
    const previo = (estado.colecciones[cuerpo.coleccion] || []).find((x) => x.id === cuerpo.id) || null;
    let descripcion = '';
    try { descripcion = describir(cuerpo, previo); } catch (e) { /* sin descripción */ }
    const j = await api('/api/escribir', { method: 'POST', body: { ...cuerpo, descripcion } });
    const id = j.id || cuerpo.id;
    const lista = (estado.colecciones[cuerpo.coleccion] || []).filter((x) => x.id !== id);
    if (cuerpo.op !== 'delete') lista.push({ ...cuerpo.data, id });
    estado.colecciones[cuerpo.coleccion] = lista;
    estado.firma = '';
    redibujar();
    if (panelVisible('historial')) cargarHistorial();
    return { id };
  }

  function referencia(coleccion, id) {
    return {
      id,
      set: (datos) => escribir({ op: 'set', coleccion, id, data: datos }),
      update: (datos) => {
        const actual = (estado.colecciones[coleccion] || []).find((x) => x.id === id) || {};
        const { id: _sinId, ...resto } = actual;
        return escribir({ op: 'set', coleccion, id, data: { ...resto, ...datos } });
      },
      delete: () => escribir({ op: 'delete', coleccion, id }),
    };
  }

  const db = {
    collection(ruta) {
      const coleccion = RUTAS[ruta];
      return {
        add: async (datos) => { const r = await escribir({ op: 'add', coleccion, data: datos }); return referencia(coleccion, r.id); },
        doc: (id) => referencia(coleccion, id),
      };
    },
    doc(ruta) {
      const i = ruta.lastIndexOf('/');
      return referencia(RUTAS[ruta.slice(0, i)], ruta.slice(i + 1));
    },
  };

  // ---------- Sesión y permisos ----------
  function leerSesion() {
    try { const s = JSON.parse(localStorage.getItem(SESION_LS) || 'null'); return s && s.token ? s : null; } catch (e) { return null; }
  }
  function guardarSesion(s) {
    try {
      if (s) localStorage.setItem(SESION_LS, JSON.stringify(s)); else localStorage.removeItem(SESION_LS);
      localStorage.removeItem('toros-clave-editor');
    } catch (e) { /* sin almacenamiento */ }
  }
  const puede = (p) => Boolean(sesion && (sesion.principal || (sesion.permisos || []).includes(p)));

  function aplicarPermiso() {
    for (const raiz of document.querySelectorAll('.tb')) {
      raiz.classList.toggle('sin-permiso', !sesion);
      raiz.classList.toggle('es-admin', Boolean(sesion));
      raiz.classList.toggle('es-principal', Boolean(sesion && sesion.principal));
      for (const p of PERMISOS) raiz.classList.toggle('puede-' + p, puede(p));
    }
    pintarAcceso();
    if (sesion) cargarHistorial(); else vaciar('historial-lista');
    if (sesion && sesion.principal) cargarPerfiles(); else vaciar('perfiles-lista');
    const abierta = document.querySelector('.tb-tab[aria-selected="true"]');
    if (abierta && getComputedStyle(abierta).display === 'none') {
      const jugadores = document.getElementById('tab-jugadores');
      if (jugadores) jugadores.click();
    }
  }

  function cerrarSesion() {
    sesion = null;
    guardarSesion(null);
    aplicarPermiso();
  }

  async function iniciarPermiso() {
    const guardada = leerSesion();
    if (guardada) {
      sesion = guardada;
      try { sesion = { ...guardada, ...(await api('/api/yo')) }; guardarSesion(sesion); }
      catch (e) { if (e.status === 401) { sesion = null; guardarSesion(null); } }
    }
    resolverPermiso();
    aplicarPermiso();
  }

  const usuario = {
    canEdit: async () => { await permisoListo; return Boolean(sesion); },
    can: async () => { await permisoListo; return Boolean(sesion); },
    isOwner: async () => { await permisoListo; return Boolean(sesion && sesion.principal); },
  };

  window.claude = {
    use: (nombre) => Promise.resolve(nombre === 'db' ? db : nombre === 'user' ? usuario : null),
  };

  // ---------- Botón con un ojo para ver u ocultar la contraseña ----------
  const SVG_OJO = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  const OJO_ABIERTO = SVG_OJO + '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const OJO_TACHADO = SVG_OJO + '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1"/><path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function pintarOjo(boton, visible) {
    const texto = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
    boton.innerHTML = visible ? OJO_TACHADO : OJO_ABIERTO;
    boton.setAttribute('aria-pressed', String(visible));
    boton.setAttribute('aria-label', texto);
    boton.title = texto;
  }

  function agregarVerClave(raiz) {
    for (const input of (raiz || document).querySelectorAll('input[type="password"]:not([data-ver-clave])')) {
      input.dataset.verClave = '';
      const caja = el('span', 'tb-ver-clave');
      input.replaceWith(caja);
      const boton = el('button', 'tb-ver-clave-btn');
      boton.type = 'button';
      pintarOjo(boton, false);
      boton.addEventListener('click', () => {
        const ver = input.type === 'password';
        input.type = ver ? 'text' : 'password';
        pintarOjo(boton, ver);
        input.focus();
      });
      caja.append(input, boton);
    }
  }

  function ocultarClaves(raiz) {
    for (const input of (raiz || document).querySelectorAll('input[data-ver-clave]')) {
      input.type = 'password';
      const boton = input.parentNode.querySelector('.tb-ver-clave-btn');
      if (boton) pintarOjo(boton, false);
    }
  }

  // ---------- Ingreso de administradores (en el encabezado) ----------
  let accesoAbierto = false;

  function montarAcceso() {
    const cont = document.querySelector('.tb-head-texto');
    if (!cont || cont.querySelector('.tb-acceso')) return;
    const caja = el('div', 'tb-acceso');
    caja.innerHTML =
      '<button type="button" class="tb-acceso-btn" data-acceso="abrir">Ingresar como administrador</button>' +
      '<span class="tb-acceso-ok" hidden><span class="tb-acceso-nombre"></span> <button type="button" class="tb-acceso-link" data-acceso="salir">Salir</button></span>' +
      '<form class="tb-acceso-form" hidden novalidate>' +
      '<label class="tb-sr" for="acceso-usuario">Usuario</label>' +
      '<input id="acceso-usuario" name="usuario" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Usuario">' +
      '<label class="tb-sr" for="acceso-clave">Contraseña</label>' +
      '<input id="acceso-clave" name="clave" type="password" autocomplete="current-password" placeholder="Contraseña">' +
      '<button type="submit" class="tb-acceso-entrar">Entrar</button>' +
      '<button type="button" class="tb-acceso-link" data-acceso="cancelar">Cancelar</button>' +
      '<span class="tb-acceso-error" hidden></span>' +
      '</form>';
    cont.append(caja);
    agregarVerClave(caja);
    const form = caja.querySelector('form');
    const error = caja.querySelector('.tb-acceso-error');
    caja.addEventListener('click', (e) => {
      const b = e.target.closest('[data-acceso]');
      if (!b) return;
      if (b.dataset.acceso === 'abrir') { accesoAbierto = true; pintarAcceso(); form.querySelector('[name="usuario"]').focus(); }
      if (b.dataset.acceso === 'cancelar') { accesoAbierto = false; form.reset(); ocultarClaves(form); error.hidden = true; pintarAcceso(); }
      if (b.dataset.acceso === 'salir') cerrarSesion();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usuarioTxt = String(form.querySelector('[name="usuario"]').value || '').trim();
      const clave = String(form.querySelector('[name="clave"]').value || '');
      if (!usuarioTxt || !clave) { error.textContent = 'Escribe tu usuario y tu contraseña.'; error.hidden = false; return; }
      const boton = form.querySelector('[type="submit"]');
      boton.disabled = true;
      error.hidden = true;
      try {
        const j = await api('/api/login', { method: 'POST', body: { usuario: usuarioTxt, clave }, sinSesion: true });
        sesion = j;
        guardarSesion(j);
        accesoAbierto = false;
        form.reset();
        ocultarClaves(form);
        aplicarPermiso();
      } catch (err) {
        error.textContent = err.message || 'Usuario o contraseña incorrectos.';
        error.hidden = false;
      } finally {
        boton.disabled = false;
      }
    });
    pintarAcceso();
  }

  function pintarAcceso() {
    const caja = document.querySelector('.tb-acceso');
    if (!caja) return;
    caja.querySelector('.tb-acceso-btn').hidden = Boolean(sesion) || accesoAbierto;
    caja.querySelector('.tb-acceso-ok').hidden = !sesion;
    caja.querySelector('.tb-acceso-form').hidden = Boolean(sesion) || !accesoAbierto;
    const nombre = caja.querySelector('.tb-acceso-nombre');
    if (nombre) {
      nombre.textContent = sesion
        ? sesion.nombre + ' · ' + (sesion.principal ? 'administrador principal' : 'edita ' + (sesion.permisos || []).map((p) => NOMBRE_PERMISO[p] || p).join(', ').toLowerCase())
        : '';
    }
  }

  function pintarAviso() {
    const raiz = document.querySelector('.tb');
    if (!raiz) return;
    let aviso = document.getElementById('aviso-base');
    if (!aviso) {
      aviso = el('p', 'tb-aviso');
      aviso.id = 'aviso-base';
      aviso.setAttribute('role', 'status');
      const tabs = raiz.querySelector('.tb-tabs');
      raiz.insertBefore(aviso, tabs || raiz.firstChild);
    }
    if (estado.errorArchivos) {
      aviso.textContent = 'No se pudieron cargar los datos de la planilla. Recarga la página en un momento.';
      aviso.hidden = false;
    } else if (estado.errorBase) {
      aviso.textContent = 'No se pudo conectar con la base de datos: ' + (estado.errorBase.message || 'error desconocido') + ' Se muestran los datos de la planilla; los cambios hechos en la página no aparecen y no se pueden guardar.';
      aviso.hidden = false;
    } else {
      aviso.hidden = true;
    }
  }

  const panelVisible = (id) => { const p = document.getElementById(id); return Boolean(p && !p.hidden); };
  const vaciar = (id) => { const n = document.getElementById(id); if (n) n.replaceChildren(); };

  // ---------- Historial ----------
  const fechaHora = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('es-CL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  async function cargarHistorial() {
    const lista = document.getElementById('historial-lista');
    if (!lista || !sesion) return;
    try {
      const j = await api('/api/historial');
      const entradas = j.entradas || [];
      if (!entradas.length) { lista.replaceChildren(el('li', 'tb-historial-vacio', 'Todavía no hay cambios registrados.')); return; }
      lista.replaceChildren(...entradas.map((e) => {
        const li = el('li');
        const cuando = el('time', 'tb-historial-cuando', fechaHora(e.cuando));
        cuando.dateTime = e.cuando || '';
        li.append(cuando, el('b', 'tb-historial-quien', e.quien || '—'), el('span', 'tb-historial-que', e.descripcion || (e.op + ' · ' + e.coleccion)));
        return li;
      }));
    } catch (e) {
      if (e.status !== 401) lista.replaceChildren(el('li', 'tb-historial-vacio', 'No se pudo cargar el historial: ' + e.message));
    }
  }

  // ---------- Perfiles de administrador (solo el principal) ----------
  function casillasPermisos(prefijo, marcados) {
    const caja = el('fieldset', 'tb-checks');
    caja.append(el('legend', null, 'Puede editar'));
    for (const p of PERMISOS) {
      const id = prefijo + '-' + p;
      const lab = el('label');
      lab.htmlFor = id;
      const cb = el('input');
      cb.type = 'checkbox';
      cb.id = id;
      cb.value = p;
      cb.name = 'permiso';
      cb.checked = marcados.includes(p);
      lab.append(cb, document.createTextNode(NOMBRE_PERMISO[p]));
      caja.append(lab);
    }
    return caja;
  }

  const permisosDe = (raiz) => [...raiz.querySelectorAll('input[name="permiso"]:checked')].map((x) => x.value);

  async function cargarPerfiles() {
    const cont = document.getElementById('perfiles-lista');
    if (!cont || !sesion || !sesion.principal) return;
    try {
      const j = await api('/api/perfiles');
      pintarPerfiles(j.perfiles || []);
    } catch (e) {
      if (e.status !== 401) cont.replaceChildren(el('p', 'tb-note', 'No se pudieron cargar los perfiles: ' + e.message));
    }
  }

  function pintarPerfiles(perfiles) {
    const cont = document.getElementById('perfiles-lista');
    if (!cont) return;
    if (!perfiles.length) { cont.replaceChildren(el('p', 'tb-note', 'Todavía no hay otros administradores. Crea el primero con el formulario de abajo.')); return; }
    cont.replaceChildren(...perfiles.map((p) => {
      const card = el('article', 'tb-perfil');
      card.dataset.usuario = p.usuario;
      const cab = el('div', 'tb-perfil-cab');
      cab.append(el('b', 'tb-perfil-nombre', p.nombre), el('span', 'tb-de', '@' + p.usuario));
      const slug = 'perfil-' + p.usuario.replace(/[^a-z0-9]/g, '-');
      const clave = el('label', 'tb-field');
      clave.htmlFor = slug + '-clave';
      const inClave = el('input');
      inClave.type = 'password';
      inClave.id = slug + '-clave';
      inClave.name = 'clave';
      inClave.autocomplete = 'new-password';
      clave.append(document.createTextNode('Nueva contraseña (déjala vacía para no cambiarla)'), inClave);
      const acciones = el('div', 'tb-acciones');
      const guardar = el('button', 'tb-btn is-primary', 'Guardar cambios');
      guardar.type = 'button';
      guardar.dataset.perfil = 'guardar';
      const borrar = el('button', 'tb-link is-bad', 'Borrar perfil');
      borrar.type = 'button';
      borrar.dataset.perfil = 'borrar';
      acciones.append(guardar, borrar);
      const confirmar = el('p', 'tb-perfil-confirmar');
      confirmar.hidden = true;
      const si = el('button', 'tb-link is-bad', 'Sí, borrar');
      si.type = 'button';
      si.dataset.perfil = 'si';
      const no = el('button', 'tb-link', 'No');
      no.type = 'button';
      no.dataset.perfil = 'no';
      confirmar.append(document.createTextNode('¿Borrar a ' + p.nombre + '? Dejará de poder editar. '), si, document.createTextNode(' · '), no);
      const msg = el('p', 'tb-perfil-msg');
      msg.hidden = true;
      card.append(cab, casillasPermisos(slug, p.permisos || []), clave, acciones, confirmar, msg);
      return card;
    }));
    agregarVerClave(cont);
  }

  function montarPerfiles() {
    const cont = document.getElementById('perfiles-lista');
    if (cont) {
      cont.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-perfil]');
        if (!b) return;
        const card = b.closest('.tb-perfil');
        const usuarioPerfil = card.dataset.usuario;
        const msg = card.querySelector('.tb-perfil-msg');
        const confirmar = card.querySelector('.tb-perfil-confirmar');
        const mostrar = (texto, error) => { msg.textContent = texto; msg.classList.toggle('is-error', Boolean(error)); msg.hidden = false; };
        if (b.dataset.perfil === 'borrar') { confirmar.hidden = false; return; }
        if (b.dataset.perfil === 'no') { confirmar.hidden = true; return; }
        b.disabled = true;
        try {
          if (b.dataset.perfil === 'guardar') {
            const clave = card.querySelector('input[name="clave"]').value;
            const permisos = permisosDe(card);
            if (!permisos.length) { mostrar('Marca al menos una sección.', true); return; }
            if (clave && clave.length < 6) { mostrar('La contraseña debe tener al menos 6 caracteres.', true); return; }
            await api('/api/perfiles', { method: 'POST', body: { op: 'actualizar', usuario: usuarioPerfil, permisos, clave: clave || undefined } });
            card.querySelector('input[name="clave"]').value = '';
            ocultarClaves(card);
            mostrar(clave ? 'Guardado. Con la nueva contraseña, tendrá que volver a ingresar.' : 'Guardado.');
          }
          if (b.dataset.perfil === 'si') {
            await api('/api/perfiles', { method: 'POST', body: { op: 'borrar', usuario: usuarioPerfil } });
            await cargarPerfiles();
          }
          cargarHistorial();
        } catch (err) {
          mostrar(err.message, true);
        } finally {
          b.disabled = false;
        }
      });
    }

    const form = document.getElementById('form-perfil');
    if (form) {
      const permisosNuevo = form.querySelector('[data-permisos-nuevo]');
      if (permisosNuevo) permisosNuevo.replaceWith(casillasPermisos('nuevo-perfil', []));
      agregarVerClave(form);
      const msg = form.querySelector('.tb-perfil-msg');
      const mostrar = (texto, error) => { msg.textContent = texto; msg.classList.toggle('is-error', Boolean(error)); msg.hidden = false; };
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = String(form.querySelector('[name="nombre"]').value || '').trim();
        const usuarioNuevo = String(form.querySelector('[name="usuario"]').value || '').trim().toLowerCase();
        const clave = String(form.querySelector('[name="clave"]').value || '');
        const permisos = permisosDe(form);
        if (!nombre) { mostrar('Escribe el nombre.', true); return; }
        if (!/^[a-z0-9._-]{3,30}$/.test(usuarioNuevo)) { mostrar('El usuario debe tener de 3 a 30 letras minúsculas, números, puntos o guiones, sin espacios.', true); return; }
        if (clave.length < 6) { mostrar('La contraseña debe tener al menos 6 caracteres.', true); return; }
        if (!permisos.length) { mostrar('Marca al menos una sección que pueda editar.', true); return; }
        const boton = form.querySelector('[type="submit"]');
        boton.disabled = true;
        try {
          await api('/api/perfiles', { method: 'POST', body: { op: 'crear', nombre, usuario: usuarioNuevo, clave, permisos } });
          form.reset();
          ocultarClaves(form);
          mostrar('Listo. ' + nombre + ' ya puede ingresar con el usuario «' + usuarioNuevo + '».');
          await cargarPerfiles();
          cargarHistorial();
        } catch (err) {
          mostrar(err.message, true);
        } finally {
          boton.disabled = false;
        }
      });
    }

    for (const t of document.querySelectorAll('.tb-tab[aria-controls="historial"]')) t.addEventListener('click', () => cargarHistorial());
    for (const t of document.querySelectorAll('.tb-tab[aria-controls="administradores"]')) t.addEventListener('click', () => cargarPerfiles());
  }

  document.addEventListener('DOMContentLoaded', () => {
    domListo = true;
    montarAcceso();
    montarPerfiles();
    redibujar();
    iniciarPermiso();
    cargarTodo();
    setInterval(refrescar, CADA_MS);
    document.addEventListener('visibilitychange', refrescar);
  });
})();
