/*
 * Runtime de la página de Toros de Pilauco en Vercel.
 * Hace lo que en Claude hacía la plataforma: carga los datos, resuelve los cálculos (dash.calc),
 * dibuja las partes que dependen de los datos (dash.draw), guarda los cambios en la base de datos
 * (claude.use('db')) y controla quién puede editar (claude.use('user')) con la clave de editor.
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
  };
  const CLAVE_LS = 'toros-clave-editor';
  const CADA_MS = 30000;

  const estado = { archivos: {}, colecciones: {}, cargado: false, errorArchivos: null, errorBase: null, firma: '' };
  const calcs = {};
  const cache = new Map();
  const dibujos = new Map();
  const alCambiar = [];
  let domListo = false;
  let editor = false;
  let resolverPermiso;
  const permisoListo = new Promise((r) => { resolverPermiso = r; });

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
    for (const el of document.querySelectorAll('[data-draw="' + nombre + '"]')) {
      try { fn(el); } catch (e) { console.error('Dibujo ' + nombre, e); }
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
    const r = await fetch('/api/estado', { cache: 'no-store' });
    let j = {};
    try { j = await r.json(); } catch (e) { /* respuesta vacía */ }
    if (!r.ok) throw new Error(j.error || 'La base de datos respondió ' + r.status);
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
  }

  // ---------- Base de datos (lo que la página pide con claude.use('db')) ----------
  async function escribir(cuerpo) {
    if (!cuerpo.coleccion) throw new Error('Colección desconocida');
    const clave = leerClave();
    if (!clave) throw new Error('Falta la clave de editor');
    const r = await fetch('/api/escribir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-clave': clave },
      body: JSON.stringify(cuerpo),
    });
    let j = {};
    try { j = await r.json(); } catch (e) { /* respuesta vacía */ }
    if (r.status === 401) cerrarSesion();
    if (!r.ok) throw new Error(j.error || 'No se guardó');
    const id = j.id || cuerpo.id;
    const lista = (estado.colecciones[cuerpo.coleccion] || []).filter((x) => x.id !== id);
    if (cuerpo.op !== 'delete') lista.push({ ...cuerpo.data, id });
    estado.colecciones[cuerpo.coleccion] = lista;
    estado.firma = '';
    redibujar();
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

  // ---------- Permisos (clave de editor) ----------
  function leerClave() { try { return localStorage.getItem(CLAVE_LS) || ''; } catch (e) { return ''; } }
  function guardarClave(c) { try { if (c) localStorage.setItem(CLAVE_LS, c); else localStorage.removeItem(CLAVE_LS); } catch (e) { /* sin almacenamiento */ } }

  async function probarClave(clave) {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clave }) });
    return r.ok;
  }

  function aplicarPermiso() {
    for (const raiz of document.querySelectorAll('.tb')) raiz.classList.toggle('sin-permiso', !editor);
    pintarAcceso();
  }

  function cerrarSesion() {
    editor = false;
    guardarClave('');
    aplicarPermiso();
  }

  async function iniciarPermiso() {
    const c = leerClave();
    if (c) {
      try { editor = await probarClave(c); } catch (e) { editor = false; }
      if (!editor) guardarClave('');
    }
    resolverPermiso();
    aplicarPermiso();
  }

  const usuario = {
    canEdit: async () => { await permisoListo; return editor; },
    can: async () => { await permisoListo; return editor; },
    isOwner: async () => false,
  };

  window.claude = {
    use: (nombre) => Promise.resolve(nombre === 'db' ? db : nombre === 'user' ? usuario : null),
  };

  // ---------- Acceso de editor y avisos en la página ----------
  let accesoAbierto = false;

  function montarAcceso() {
    const cont = document.querySelector('.tb-head-texto');
    if (!cont || cont.querySelector('.tb-acceso')) return;
    const caja = document.createElement('div');
    caja.className = 'tb-acceso';
    caja.innerHTML =
      '<button type="button" class="tb-acceso-btn" data-acceso="abrir">Ingresar para editar</button>' +
      '<span class="tb-acceso-ok" hidden>Modo editor <button type="button" class="tb-acceso-link" data-acceso="salir">Salir</button></span>' +
      '<form class="tb-acceso-form" hidden novalidate>' +
      '<label class="tb-sr" for="clave-editor">Clave de editor</label>' +
      '<input id="clave-editor" name="clave" type="password" autocomplete="current-password" placeholder="Clave de editor">' +
      '<button type="submit" class="tb-acceso-entrar">Entrar</button>' +
      '<button type="button" class="tb-acceso-link" data-acceso="cancelar">Cancelar</button>' +
      '<span class="tb-acceso-error" hidden>Clave incorrecta.</span>' +
      '</form>';
    cont.append(caja);
    const form = caja.querySelector('form');
    const error = caja.querySelector('.tb-acceso-error');
    caja.addEventListener('click', (e) => {
      const b = e.target.closest('[data-acceso]');
      if (!b) return;
      if (b.dataset.acceso === 'abrir') { accesoAbierto = true; pintarAcceso(); const i = form.querySelector('input'); if (i) i.focus(); }
      if (b.dataset.acceso === 'cancelar') { accesoAbierto = false; form.reset(); error.hidden = true; pintarAcceso(); }
      if (b.dataset.acceso === 'salir') cerrarSesion();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const clave = String(form.querySelector('input').value || '');
      if (!clave) return;
      const boton = form.querySelector('[type="submit"]');
      boton.disabled = true;
      error.hidden = true;
      let ok = false;
      try { ok = await probarClave(clave); } catch (err) { ok = false; }
      boton.disabled = false;
      if (!ok) { error.hidden = false; return; }
      guardarClave(clave);
      editor = true;
      accesoAbierto = false;
      form.reset();
      aplicarPermiso();
    });
    pintarAcceso();
  }

  function pintarAcceso() {
    const caja = document.querySelector('.tb-acceso');
    if (!caja) return;
    caja.querySelector('.tb-acceso-btn').hidden = editor || accesoAbierto;
    caja.querySelector('.tb-acceso-ok').hidden = !editor;
    caja.querySelector('.tb-acceso-form').hidden = editor || !accesoAbierto;
  }

  function pintarAviso() {
    const raiz = document.querySelector('.tb');
    if (!raiz) return;
    let aviso = document.getElementById('aviso-base');
    if (!aviso) {
      aviso = document.createElement('p');
      aviso.id = 'aviso-base';
      aviso.className = 'tb-aviso';
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

  document.addEventListener('DOMContentLoaded', () => {
    domListo = true;
    montarAcceso();
    redibujar();
    iniciarPermiso();
    cargarTodo();
    setInterval(refrescar, CADA_MS);
    document.addEventListener('visibilitychange', refrescar);
  });
})();
