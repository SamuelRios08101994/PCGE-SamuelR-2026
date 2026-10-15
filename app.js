'use strict';
/* ==========================================================================
   Libro de Caja PCGE — app.js
   App 100% en JavaScript vanilla (sin librerías externas).
   Estructura:
     1. Utilidades puras (sin DOM) — normalización, formato, cálculo.
     2. Estado y persistencia (localStorage).
     3. Motor contable (agregaciones: balance, resultados, situación).
     4. Render de UI (tabs, tablas, formularios, gráficos, toasts).
     5. Arranque de la app y registro del Service Worker.
   ========================================================================== */

/* ------------------------------------------------------------------------
   1. UTILIDADES PURAS
   ------------------------------------------------------------------------ */

/** Quita tildes/diacríticos y pasa a minúsculas, para búsquedas tolerantes. */
function normalizeText(value) {
  try {
    if (value === null || value === undefined) return '';
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  } catch (err) {
    console.error('normalizeText error:', err);
    return '';
  }
}

/** Formatea un número como moneda "S/ 1,234.56". Nunca lanza error. */
function formatMoney(value) {
  const n = toNumber(value);
  try {
    return 'S/ ' + n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch (err) {
    return 'S/ ' + n.toFixed(2);
  }
}

/** Convierte cualquier valor a número finito; si no se puede, devuelve 0. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Redondea a 2 decimales evitando errores de coma flotante (0.1+0.2). */
function round2(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

/** "-" si el valor está vacío/nulo/indefinido; si no, el propio valor. */
function orDash(value) {
  if (value === null || value === undefined || value === '') return '-';
  return value;
}

/** Devuelve YYYY-MM-DD de hoy, para precargar el campo de fecha. */
function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Formatea "YYYY-MM-DD" a "dd/mm/aaaa" para mostrar. Tolera valores raros. */
function formatDateDisplay(iso) {
  if (!iso || typeof iso !== 'string') return '-';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return orDash(iso);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** "YYYY-MM" a partir de una fecha ISO; null si no se puede leer. */
function monthKey(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function monthLabel(key) {
  if (!key) return '-';
  const [y, m] = key.split('-');
  const idx = parseInt(m, 10) - 1;
  const mes = MESES_CORTOS[idx] || m;
  return `${mes} ${y}`;
}

/** Genera un id único, con respaldo si crypto.randomUUID no existe. */
function makeId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch (err) { /* sigue al respaldo */ }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

/** Elemento del PCGE = primer dígito del código (o los dos primeros para 0,8,9,88). */
function elementoDeCodigo(codigo) {
  const c = String(codigo || '').trim();
  if (!c) return '';
  return c.charAt(0);
}

/** true si la cuenta es "de orden" (elementos 0, 8 o 9), salvo el grupo 88. */
function esCuentaDeOrden(codigo) {
  const c = String(codigo || '').trim();
  if (!c) return false;
  if (c.slice(0, 2) === '88') return false;
  return c.charAt(0) === '0' || c.charAt(0) === '8' || c.charAt(0) === '9';
}


/* ------------------------------------------------------------------------
   2. ESTADO Y PERSISTENCIA
   ------------------------------------------------------------------------ */

const STORAGE_KEY = 'libroCajaPCGE_v1';       // clave antigua en localStorage (solo se lee para migrar una vez)
const DB_NOMBRE = 'LibroCajaPCGE';
const DB_VERSION = 1;
const PAGE_SIZE = 50; // paginación para evitar congelar la pantalla con muchos registros

/* ---------- Capa de almacenamiento (IndexedDB): los datos contables viven aquí ----------
   El resto de la app nunca toca indexedDB directamente — todo pasa por este objeto DB.
   localStorage queda reservado solo para preferencias de interfaz pequeñas (tema — ver
   inicializarTema más abajo). Esto es justamente lo que permite, el día de mañana, cambiar
   este módulo por uno que hable con una API (ver ApiRepository en los comentarios de abajo)
   sin tocar el resto de la app: toda la UI llama a DB.*, nunca a indexedDB.* directamente. */
const DB = {
  _conexion: null,

  /** Abre (o reutiliza) la conexión a IndexedDB. Crea los object stores la primera vez. */
  abrir() {
    if (this._conexion) return this._conexion;
    this._conexion = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('Este navegador no soporta IndexedDB.')); return; }
      const peticion = window.indexedDB.open(DB_NOMBRE, DB_VERSION);
      peticion.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('asientos')) {
          const almacen = db.createObjectStore('asientos', { keyPath: 'id' });
          almacen.createIndex('numero', 'numero', { unique: false });
          almacen.createIndex('codigo', 'codigo', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'clave' });
        }
      };
      peticion.onsuccess = () => resolve(peticion.result);
      peticion.onerror = () => reject(peticion.error);
    });
    return this._conexion;
  },

  /** Todos los asientos guardados (todas las líneas, de todos los números de asiento). */
  async getTodosLosAsientos() {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('asientos', 'readonly');
      const req = tx.objectStore('asientos').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  /** Reemplaza TODO el contenido (se usa para guardar el estado completo, tal como lo maneja hoy la app). */
  async reemplazarTodo(lineas) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('asientos', 'readwrite');
      const almacen = tx.objectStore('asientos');
      almacen.clear();
      for (const l of lineas) almacen.put(l);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transacción cancelada.'));
    });
  },

  /** Agrega o actualiza líneas puntuales sin tocar el resto (más eficiente que reemplazarTodo). */
  async guardarLineas(lineas) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('asientos', 'readwrite');
      const almacen = tx.objectStore('asientos');
      for (const l of lineas) almacen.put(l);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Elimina todas las líneas de un número de asiento. */
  async eliminarPorNumero(numero) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('asientos', 'readwrite');
      const idx = tx.objectStore('asientos').index('numero');
      const req = idx.openCursor(IDBKeyRange.only(numero));
      req.onsuccess = (ev) => { const cur = ev.target.result; if (cur) { cur.delete(); cur.continue(); } };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Borra todos los asientos (usado por "Borrar todos los datos"). */
  async limpiarTodo() {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('asientos', 'readwrite');
      tx.objectStore('asientos').clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  async getMeta(clave) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get(clave);
      req.onsuccess = () => resolve(req.result ? req.result.valor : undefined);
      req.onerror = () => reject(req.error);
    });
  },

  async setMeta(clave, valor) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ clave, valor });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
};

/** Estado global de la app en memoria. */
const state = {
  cuentas: [],          // [{codigo, nombre}]
  cuentasPorCodigo: new Map(),
  gruposPCGE: {},
  asientos: [],         // [{id, fecha, numero, codigo, glosa, debe, haber}]
  search: '',
  activeTab: 'registro',
  periodo: 'mes',
  mayorCuenta: null,
  mayorRango: 'todo',
  panelRango: 'todo',
  balanceRango: 'todo',
  resultadosRango: 'todo',
  situacionRango: 'todo',
  sort: {
    diario: { key: 'fecha', dir: 'desc' },
    balance: { key: 'codigo', dir: 'asc' }
  },
  page: { diario: 1, balance: 1 },
  dataReady: false
};

/** Lee el respaldo guardado en este celular. Nunca lanza error. */
/** Lee el respaldo antiguo que haya quedado en localStorage (de versiones previas de la app). */
function leerLocalStorageAntiguo() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.asientos)) return null;
    return parsed;
  } catch (err) {
    console.error('No se pudo leer el respaldo antiguo de localStorage:', err);
    return null;
  }
}

/**
 * Carga los asientos guardados. Primero mira IndexedDB (la fuente de verdad actual); si está
 * vacía y nunca se migró, busca el respaldo antiguo en localStorage, lo copia a IndexedDB y
 * marca la migración como hecha — todo esto UNA sola vez, de forma transparente para el
 * usuario. El dato original en localStorage no se borra (queda como respaldo silencioso).
 * Devuelve { asientos: [...] } o null si no hay nada guardado todavía.
 */
async function loadFromStorage() {
  try {
    const yaMigrado = await DB.getMeta('migradoDesdeLocalStorage');
    const enIndexedDB = await DB.getTodosLosAsientos();
    if (enIndexedDB.length > 0) return { asientos: enIndexedDB };
    if (yaMigrado) return null; // ya se migró antes y el usuario luego borró todo: respeta eso, no revive datos viejos

    const antiguo = leerLocalStorageAntiguo();
    if (antiguo && antiguo.asientos.length > 0) {
      const limpios = sanitizeAsientos(antiguo.asientos);
      await DB.reemplazarTodo(limpios);
      await DB.setMeta('migradoDesdeLocalStorage', new Date().toISOString());
      console.log(`Migración: ${limpios.length} líneas pasadas de localStorage a IndexedDB.`);
      return { asientos: limpios };
    }
    await DB.setMeta('migradoDesdeLocalStorage', new Date().toISOString());
    return null;
  } catch (err) {
    console.error('No se pudo cargar desde IndexedDB:', err);
    showToast('No se pudo abrir el almacenamiento local de este dispositivo.', 'error');
    return null;
  }
}

/** Guarda el estado actual (state.asientos) en IndexedDB. Devuelve true/false según el resultado. */
async function saveToStorage() {
  try {
    await DB.reemplazarTodo(state.asientos);
    return true;
  } catch (err) {
    console.error('No se pudo guardar en este dispositivo:', err);
    showToast('No se pudo guardar en este dispositivo (memoria llena, modo privado, o IndexedDB no disponible).', 'error', 5000);
    return false;
  }
}

/** Valida y normaliza una lista de asientos venida de data.json o de un respaldo importado. */
function sanitizeAsientos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const codigo = String(item.codigo || '').trim();
    if (!codigo) continue;
    const debe = round2(toNumber(item.debe));
    const haber = round2(toNumber(item.haber));
    if (debe === 0 && haber === 0) continue;
    out.push({
      id: item.id ? String(item.id) : makeId(),
      fecha: /^\d{4}-\d{2}-\d{2}/.test(String(item.fecha || '')) ? String(item.fecha).slice(0, 10) : todayISO(),
      numero: Number.isFinite(Number(item.numero)) ? Number(item.numero) : 1,
      codigo,
      glosa: item.glosa ? String(item.glosa).slice(0, 300) : '',
      debe,
      haber
    });
  }
  return out;
}

/** Escapa un valor para CSV: si contiene comas, comillas o saltos de línea, lo envuelve en comillas dobles. */
function csvEscape(valor) {
  const s = valor === null || valor === undefined ? '' : String(valor);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Convierte los asientos a texto CSV (fecha, asiento, código, denominación, observación, debe, haber). */
function asientosACSV(asientos, cuentasPorCodigo) {
  const encabezado = ['fecha', 'asiento', 'codigo', 'denominacion', 'glosa', 'debe', 'haber'];
  const filas = [encabezado.join(',')];
  for (const l of asientos) {
    const cuenta = cuentasPorCodigo ? cuentasPorCodigo.get(l.codigo) : null;
    filas.push([
      l.fecha, l.numero, l.codigo, cuenta ? cuenta.nombre : '',
      l.glosa || '', l.debe || 0, l.haber || 0
    ].map(csvEscape).join(','));
  }
  return filas.join('\r\n');
}

/** Parser CSV: respeta comillas dobles (con "" como comilla escapada), comas y saltos de línea dentro de un campo. */
function parsearCSV(texto) {
  const filas = [];
  let fila = [], campo = '', enComillas = false;
  const s = String(texto || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (enComillas) {
      if (c === '"') { if (s[i + 1] === '"') { campo += '"'; i++; } else enComillas = false; }
      else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\r') { /* se ignora: el salto real lo marca \n */ }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter((f) => !(f.length === 1 && f[0].trim() === ''));
}

/**
 * Interpreta un CSV exportado por esta app (o uno hecho a mano en Excel con las mismas
 * columnas). Reconoce las columnas por su nombre en el encabezado, sin importar el orden.
 * Devuelve [] si no reconoce un encabezado con al menos código, debe y haber.
 */
function csvAAsientos(texto) {
  const filas = parsearCSV(texto);
  if (filas.length < 1) return [];
  const encabezado = filas[0].map((h) => normalizeText(h));
  const idx = (nombre) => encabezado.indexOf(nombre);
  const iFecha = idx('fecha'), iAsiento = idx('asiento'), iCodigo = idx('codigo'), iGlosa = idx('glosa'),
    iDebe = idx('debe'), iHaber = idx('haber');
  if (iCodigo === -1 || iDebe === -1 || iHaber === -1) return [];
  const salida = [];
  for (let r = 1; r < filas.length; r++) {
    const f = filas[r];
    if (!f || f.every((c) => c.trim() === '')) continue;
    salida.push({
      fecha: iFecha >= 0 ? f[iFecha] : '',
      numero: iAsiento >= 0 ? f[iAsiento] : 1,
      codigo: f[iCodigo],
      glosa: iGlosa >= 0 ? f[iGlosa] : '',
      debe: iDebe >= 0 ? f[iDebe] : 0,
      haber: iHaber >= 0 ? f[iHaber] : 0
    });
  }
  return salida;
}

/** Carga el plan de cuentas y los asientos iniciales desde data.json (con caché del Service Worker). */
async function loadInitialData() {
  const res = await fetch('data.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('No se pudo leer data.json (HTTP ' + res.status + ')');
  const json = await res.json();
  const cuentas = Array.isArray(json.cuentas) ? json.cuentas
    .filter((c) => c && c.codigo)
    .map((c) => ({ codigo: String(c.codigo).trim(), nombre: c.nombre ? String(c.nombre) : '(sin nombre)' })) : [];
  const gruposPCGE = (json.gruposPCGE && typeof json.gruposPCGE === 'object') ? json.gruposPCGE : {};
  return { cuentas, gruposPCGE, asientosSemilla: sanitizeAsientos(json.asientos) };
}

function indexCuentas() {
  state.cuentasPorCodigo = new Map(state.cuentas.map((c) => [c.codigo, c]));
}


/* ------------------------------------------------------------------------
   3. MOTOR CONTABLE (funciones puras: reciben datos, devuelven datos)
   ------------------------------------------------------------------------ */

/**
 * Busca cuentas por código o nombre (normalizado), para el autocompletado.
 * Limita los resultados para no congelar la pantalla con 1,278 cuentas.
 */
function buscarCuentas(cuentas, texto, limite = 20) {
  try {
    const q = normalizeText(texto);
    if (!q) return [];
    const porCodigo = [];
    const porNombre = [];
    for (const c of cuentas) {
      if (c.codigo.startsWith(q)) { porCodigo.push(c); continue; }
      if (normalizeText(c.nombre).includes(q)) porNombre.push(c);
      if (porCodigo.length + porNombre.length > limite * 4) break; // corte de seguridad
    }
    return [...porCodigo, ...porNombre].slice(0, limite);
  } catch (err) {
    console.error('buscarCuentas error:', err);
    return [];
  }
}

/**
 * Interpreta el texto escrito en un campo de cuenta: admite "1041 - Caja",
 * un código exacto, o una coincidencia única por nombre.
 * Devuelve la cuenta encontrada o null.
 */
function resolverCuenta(cuentasPorCodigo, cuentasArray, texto) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const conGuion = t.match(/^(\S+)\s+-\s+/);
  const codigoDirecto = conGuion ? conGuion[1] : t;
  if (cuentasPorCodigo.has(codigoDirecto)) return cuentasPorCodigo.get(codigoDirecto);
  // coincidencia única por nombre normalizado
  const q = normalizeText(t);
  const coincidencias = cuentasArray.filter((c) => normalizeText(c.nombre) === q);
  if (coincidencias.length === 1) return coincidencias[0];
  return null;
}

/**
 * Valida los datos del formulario de Registro (misma lógica que el Excel):
 * cuenta y contra-cuenta existentes y distintas, monto > 0, tipo elegido.
 * Devuelve { ok, mensaje, aviso } — aviso es una advertencia no bloqueante.
 */
function validarRegistro({ cuenta, contra, monto, tipo }) {
  if (!cuenta && !contra && !monto) {
    return { ok: false, mensaje: 'Complete cuenta, contra-cuenta y monto.', aviso: false };
  }
  if (!cuenta) return { ok: false, mensaje: 'Falta la cuenta contable.', aviso: false };
  if (!contra) return { ok: false, mensaje: 'Falta la contra-cuenta.', aviso: false };
  if (cuenta.codigo === contra.codigo) {
    return { ok: false, mensaje: 'La cuenta y la contra-cuenta son la misma.', aviso: false };
  }
  const m = toNumber(monto);
  if (!(m > 0)) return { ok: false, mensaje: 'El monto debe ser mayor que 0.', aviso: false };
  if (tipo !== 'debe' && tipo !== 'haber') {
    return { ok: false, mensaje: 'Elija Recibe (Debe) o Entrega (Haber).', aviso: false };
  }
  const mezclaOrden = esCuentaDeOrden(cuenta.codigo) !== esCuentaDeOrden(contra.codigo);
  return {
    ok: true,
    mensaje: 'Listo para registrar.',
    aviso: mezclaOrden ? 'Mezcla una cuenta de orden (elementos 0, 8 o 9) con una cuenta normal (1 a 7): no entrará al Estado de Situación.' : null
  };
}

/** A partir del formulario ya validado, arma las dos líneas del asiento. */
function construirLineasAsiento({ cuenta, contra, monto, tipo, glosa, fecha, numero }) {
  const m = round2(toNumber(monto));
  const g = (glosa && glosa.trim()) ? glosa.trim() : 'Registro rápido';
  const f = fecha || todayISO();
  const [codDebe, codHaber] = tipo === 'debe' ? [cuenta.codigo, contra.codigo] : [contra.codigo, cuenta.codigo];
  const [nomDebe, nomHaber] = tipo === 'debe' ? [cuenta.nombre, contra.nombre] : [contra.nombre, cuenta.nombre];
  return [
    { id: makeId(), fecha: f, numero, codigo: codDebe, glosa: `${g} · ${nomDebe}`, debe: m, haber: 0 },
    { id: makeId(), fecha: f, numero, codigo: codHaber, glosa: `${g} · ${nomHaber}`, debe: 0, haber: m }
  ];
}

/** Siguiente número de asiento correlativo. */
function siguienteNumeroAsiento(asientos) {
  let max = 0;
  for (const a of asientos) if (Number.isFinite(a.numero) && a.numero > max) max = a.numero;
  return max + 1;
}

/**
 * Agrupa las líneas del Diario por asiento, para poder borrar un registro completo
 * y para mostrar avisos de descuadre por asiento (no se usa para bloquear, solo informar).
 */
function agruparPorAsiento(asientos) {
  const grupos = new Map();
  for (const l of asientos) {
    if (!grupos.has(l.numero)) grupos.set(l.numero, []);
    grupos.get(l.numero).push(l);
  }
  return grupos;
}

/** Todas las líneas que pertenecen a un mismo asiento (cualquier cantidad), en el orden en que están guardadas. */
function obtenerLineasAsiento(asientos, numero) {
  return asientos.filter((a) => a.numero === numero);
}

/** Monto en céntimos enteros (número entero), para sumar sin errores de coma flotante (0.1+0.2). */
function aCentavos(valor) {
  return Math.round(toNumber(valor) * 100);
}

/** Céntimos enteros de vuelta a soles, redondeado a 2 decimales. */
function centavosAMoneda(centavos) {
  return round2(centavos / 100);
}

/**
 * Valida un asiento contable de cualquier cantidad de líneas (estructura interna del
 * formulario: [{cuenta, debe, haber}, ...]). Toda la suma se hace en céntimos enteros
 * para que la comparación Debe === Haber nunca falle por errores de coma flotante.
 * Devuelve { ok, mensaje, aviso, totalDebe, totalHaber, diferencia, cuadra }.
 */
function validarAsientoMultilinea(filas) {
  const vacio = { totalDebe: 0, totalHaber: 0, diferencia: 0, cuadra: false };
  const conAlgo = filas.filter((f) => f.cuenta || toNumber(f.debe) > 0 || toNumber(f.haber) > 0);
  const sinCuenta = conAlgo.find((f) => !f.cuenta);
  if (sinCuenta) return { ok: false, mensaje: 'Hay una línea con monto pero sin una cuenta contable válida.', aviso: null, ...vacio };

  const conCuenta = filas.filter((f) => f.cuenta);
  if (conCuenta.length < 2) return { ok: false, mensaje: 'El asiento necesita al menos 2 líneas con cuenta y monto.', aviso: null, ...vacio };

  for (const f of conCuenta) {
    const d = toNumber(f.debe), h = toNumber(f.haber);
    if (d > 0 && h > 0) return { ok: false, mensaje: `La línea ${f.cuenta.codigo} no puede tener Debe y Haber a la vez.`, aviso: null, ...vacio };
    if (d === 0 && h === 0) return { ok: false, mensaje: `Falta el monto en la línea ${f.cuenta.codigo}.`, aviso: null, ...vacio };
    if (d < 0 || h < 0) return { ok: false, mensaje: 'No se permiten montos negativos.', aviso: null, ...vacio };
  }

  const totalDebeC = conCuenta.reduce((s, f) => s + aCentavos(f.debe), 0);
  const totalHaberC = conCuenta.reduce((s, f) => s + aCentavos(f.haber), 0);
  const totalDebe = centavosAMoneda(totalDebeC);
  const totalHaber = centavosAMoneda(totalHaberC);
  const diferencia = centavosAMoneda(totalDebeC - totalHaberC);
  const cuadra = totalDebeC === totalHaberC;

  const nOrden = conCuenta.filter((f) => esCuentaDeOrden(f.cuenta.codigo)).length;
  const aviso = (nOrden > 0 && nOrden < conCuenta.length)
    ? 'Este asiento mezcla cuentas de orden (elementos 0, 8 o 9) con cuentas normales (1 a 7): no entrará al Estado de Situación.'
    : null;

  return {
    ok: cuadra,
    mensaje: cuadra ? 'Asiento cuadrado.' : `El asiento no cuadra. Diferencia: ${formatMoney(Math.abs(diferencia))}`,
    aviso, totalDebe, totalHaber, diferencia, cuadra
  };
}

/** Construye las líneas finales (una por fila con cuenta) a partir del estado del formulario multilínea. */
function construirLineasDesdeFilas(filas, { numero, fecha, glosa }) {
  const f = (fecha && fecha.trim()) ? fecha : todayISO();
  const g = (glosa && glosa.trim()) ? glosa.trim() : 'Registro rápido';
  return filas.filter((x) => x.cuenta).map((x) => ({
    id: makeId(), fecha: f, numero,
    codigo: x.cuenta.codigo,
    glosa: `${g} · ${x.cuenta.nombre}`,
    debe: round2(toNumber(x.debe)),
    haber: round2(toNumber(x.haber))
  }));
}

/**
 * Balance de comprobación: suma Debe/Haber por código de cuenta y calcula
 * el saldo Deudor o Acreedor. Solo incluye cuentas con movimiento.
 */
/**
 * Libro Mayor de una cuenta: todos sus movimientos ordenados por fecha, con el saldo
 * acumulado corriendo línea por línea (en céntimos, para que nunca arrastre errores de
 * coma flotante). El saldo inicial refleja TODO lo anterior a "desde" aunque esas líneas
 * no se muestren — así el saldo de cada fila es siempre el saldo real de la cuenta a esa
 * fecha, no solo la suma de lo que entra en el filtro.
 * `desde`/`hasta` son fechas "YYYY-MM-DD" o cadena vacía/null para "sin límite".
 */
function calcularMayorCuenta(asientos, codigo, desde, hasta) {
  const todas = asientos
    .filter((a) => a.codigo === codigo)
    .slice()
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || (a.numero - b.numero));

  let saldoC = 0;
  let saldoInicialC = 0;
  const filas = [];
  for (const l of todas) {
    const antes = desde && (l.fecha || '') < desde;
    const despues = hasta && (l.fecha || '') > hasta;
    if (antes) {
      saldoC += aCentavos(l.debe) - aCentavos(l.haber);
      saldoInicialC = saldoC;
      continue;
    }
    if (despues) continue; // no afecta saldo inicial (es posterior al rango) ni se muestra
    saldoC += aCentavos(l.debe) - aCentavos(l.haber);
    filas.push({ fecha: l.fecha, numero: l.numero, glosa: l.glosa, debe: l.debe, haber: l.haber, saldo: centavosAMoneda(saldoC) });
  }
  const totalDebe = round2(filas.reduce((s, f) => s + toNumber(f.debe), 0));
  const totalHaber = round2(filas.reduce((s, f) => s + toNumber(f.haber), 0));
  return {
    filas, totalDebe, totalHaber,
    saldoInicial: centavosAMoneda(saldoInicialC),
    saldoFinal: filas.length ? filas[filas.length - 1].saldo : centavosAMoneda(saldoInicialC)
  };
}

/**
 * Lógica central de filtrado de fechas, compartida por Mayor, Panel, Balance, Resultados y
 * Situación: cablea los botones Hoy/Todo/Este mes/Este año/Personalizado de una tarjeta y,
 * cuando cambian, llama a `onCambiar()`. `prefijo` identifica la tarjeta y debe coincidir con
 * los ids del HTML: #{prefijo}Periodo, #{prefijo}Fechas, #{prefijo}Desde, #{prefijo}Hasta,
 * y con la clave de estado state[`${prefijo}Rango`].
 */
function inicializarFiltroFecha(prefijo, onCambiar) {
  const cont = $('#' + prefijo + 'Periodo');
  const fechasCont = $('#' + prefijo + 'Fechas');
  const inpDesde = $('#' + prefijo + 'Desde');
  const inpHasta = $('#' + prefijo + 'Hasta');
  $all('.period-btn', cont).forEach((btn) => {
    btn.addEventListener('click', () => {
      state[prefijo + 'Rango'] = btn.dataset.rango;
      $all('.period-btn', cont).forEach((b) => b.classList.toggle('active', b === btn));
      fechasCont.hidden = state[prefijo + 'Rango'] !== 'personalizado';
      if (state[prefijo + 'Rango'] === 'personalizado' && !inpDesde.value) {
        inpHasta.value = todayISO();
        inpDesde.value = todayISO().slice(0, 7) + '-01';
      }
      onCambiar();
    });
  });
  inpDesde.addEventListener('input', onCambiar);
  inpHasta.addEventListener('input', onCambiar);
}

/** Lee el rango { desde, hasta } actualmente elegido en la tarjeta `prefijo` (preset o personalizado). */
function obtenerRangoFiltro(prefijo) {
  const rango = state[prefijo + 'Rango'] || 'todo';
  if (rango === 'personalizado') {
    return { desde: $('#' + prefijo + 'Desde').value || '', hasta: $('#' + prefijo + 'Hasta').value || '' };
  }
  return rangoPreset(rango);
}

/** Calcula fechas "desde"/"hasta" (YYYY-MM-DD) para un preset de rango. '' = sin límite. */
function rangoPreset(nombre, hoyISO) {
  const hoy = hoyISO || todayISO();
  if (nombre === 'hoy') return { desde: hoy, hasta: hoy };
  if (nombre === 'mes') return { desde: hoy.slice(0, 7) + '-01', hasta: hoy };
  if (nombre === 'anio') return { desde: hoy.slice(0, 4) + '-01-01', hasta: hoy };
  return { desde: '', hasta: '' }; // 'todo'
}

function calcularBalance(asientos, cuentasPorCodigo) {
  const mapa = new Map();
  for (const l of asientos) {
    const acc = mapa.get(l.codigo) || { codigo: l.codigo, debe: 0, haber: 0 };
    acc.debe = round2(acc.debe + toNumber(l.debe));
    acc.haber = round2(acc.haber + toNumber(l.haber));
    mapa.set(l.codigo, acc);
  }
  const filas = [];
  let totalDebe = 0, totalHaber = 0, totalDeudor = 0, totalAcreedor = 0;
  for (const acc of mapa.values()) {
    const dif = round2(acc.debe - acc.haber);
    const deudor = dif > 0 ? dif : 0;
    const acreedor = dif < 0 ? round2(-dif) : 0;
    const cuenta = cuentasPorCodigo.get(acc.codigo);
    filas.push({
      codigo: acc.codigo,
      nombre: cuenta ? cuenta.nombre : 'Cuenta no encontrada en el plan',
      debe: acc.debe, haber: acc.haber, deudor, acreedor
    });
    totalDebe = round2(totalDebe + acc.debe);
    totalHaber = round2(totalHaber + acc.haber);
    totalDeudor = round2(totalDeudor + deudor);
    totalAcreedor = round2(totalAcreedor + acreedor);
  }
  return {
    filas,
    totales: { debe: totalDebe, haber: totalHaber, deudor: totalDeudor, acreedor: totalAcreedor },
    cuadra: Math.abs(totalDebe - totalHaber) < 0.005
  };
}

/** Estado de Resultados: ingresos (elemento 7) y gastos (elemento 6) a partir del balance. */
function calcularResultados(balanceFilas) {
  const ingresos = [];
  const gastos = [];
  let totalIngresos = 0, totalGastos = 0;
  for (const f of balanceFilas) {
    const elem = elementoDeCodigo(f.codigo);
    if (elem === '7') {
      const monto = round2(f.haber - f.debe);
      if (monto !== 0) { ingresos.push({ ...f, monto }); totalIngresos = round2(totalIngresos + monto); }
    } else if (elem === '6') {
      const monto = round2(f.debe - f.haber);
      if (monto !== 0) { gastos.push({ ...f, monto }); totalGastos = round2(totalGastos + monto); }
    }
  }
  ingresos.sort((a, b) => b.monto - a.monto);
  gastos.sort((a, b) => b.monto - a.monto);
  return { ingresos, gastos, totalIngresos, totalGastos, neto: round2(totalIngresos - totalGastos) };
}

/**
 * Estado de Situación Financiera: Activo (1,2,3), Pasivo (4) y Patrimonio (5 + resultado).
 * Las cuentas de orden (0,8,9) no participan, igual que en el libro Excel.
 */
/** Suma el saldo de las cuentas cuyo código empieza con alguno de los prefijos dados, con naturaleza DEUDORA (activo: debe - haber). */
function sumaSaldoDeudor(balanceFilas, prefijos) {
  return round2(balanceFilas
    .filter((f) => prefijos.some((p) => f.codigo.startsWith(p)))
    .reduce((s, f) => s + (f.deudor - f.acreedor), 0));
}

/** Suma el saldo de las cuentas cuyo código empieza con alguno de los prefijos dados, con naturaleza ACREEDORA (pasivo: haber - debe). */
function sumaSaldoAcreedor(balanceFilas, prefijos) {
  return round2(balanceFilas
    .filter((f) => prefijos.some((p) => f.codigo.startsWith(p)))
    .reduce((s, f) => s + (f.acreedor - f.deudor), 0));
}

/** Líneas con fecha <= hasta (o todas, si hasta está vacío). Para KPIs de balance ("foto" a una fecha). */
function filtrarAsientosHasta(asientos, hasta) {
  if (!hasta) return asientos;
  return asientos.filter((a) => (a.fecha || '') <= hasta);
}

/** Líneas dentro de [desde, hasta] (cualquiera de los dos puede ir vacío). Para KPIs de flujo (ingresos/gastos del periodo). */
function filtrarAsientosRango(asientos, desde, hasta) {
  return asientos.filter((a) => (!desde || (a.fecha || '') >= desde) && (!hasta || (a.fecha || '') <= hasta));
}

function calcularSituacion(balanceFilas, resultadoNeto) {
  const activo = [];
  const pasivo = [];
  const patrimonio = [];
  let totalActivo = 0, totalPasivo = 0, totalPatrimonio = 0;
  for (const f of balanceFilas) {
    const elem = elementoDeCodigo(f.codigo);
    if (['1', '2', '3'].includes(elem)) {
      const monto = round2(f.debe - f.haber);
      if (monto !== 0) { activo.push({ ...f, monto }); totalActivo = round2(totalActivo + monto); }
    } else if (elem === '4') {
      const monto = round2(f.haber - f.debe);
      if (monto !== 0) { pasivo.push({ ...f, monto }); totalPasivo = round2(totalPasivo + monto); }
    } else if (elem === '5') {
      const monto = round2(f.haber - f.debe);
      if (monto !== 0) { patrimonio.push({ ...f, monto }); totalPatrimonio = round2(totalPatrimonio + monto); }
    }
  }
  if (resultadoNeto !== 0) {
    patrimonio.push({ codigo: '—', nombre: 'Resultado del ejercicio (de Estado de Resultados)', monto: resultadoNeto });
    totalPatrimonio = round2(totalPatrimonio + resultadoNeto);
  }
  activo.sort((a, b) => a.codigo.localeCompare(b.codigo));
  pasivo.sort((a, b) => a.codigo.localeCompare(b.codigo));
  const totalPasivoPatrimonio = round2(totalPasivo + totalPatrimonio);
  return {
    activo, pasivo, patrimonio,
    totalActivo, totalPasivo, totalPatrimonio, totalPasivoPatrimonio,
    diferencia: round2(totalActivo - totalPasivoPatrimonio),
    cuadra: Math.abs(totalActivo - totalPasivoPatrimonio) < 0.005
  };
}

/**
 * Serie mensual para los gráficos del Panel: ingresos, gastos, resultado,
 * saldo de Caja y Bancos (cuentas que empiezan con "10"), entradas y salidas.
 * Devuelve los últimos `meses` meses que tengan datos (o el rango disponible).
 */
function calcularSerieMensual(asientos, mesesAtras = 12) {
  if (asientos.length === 0) return [];
  const claves = new Set();
  for (const l of asientos) { const k = monthKey(l.fecha); if (k) claves.add(k); }
  const ordenadas = [...claves].sort();
  if (ordenadas.length === 0) return [];
  const desde = ordenadas.length > mesesAtras ? ordenadas[ordenadas.length - mesesAtras] : ordenadas[0];
  const rango = ordenadas.filter((k) => k >= desde);

  // saldo acumulado de Caja y Bancos hasta el fin de cada mes
  const porMes = new Map(rango.map((k) => [k, {
    mes: k, ingresos: 0, gastos: 0, entradas: 0, salidas: 0
  }]));
  for (const l of asientos) {
    const k = monthKey(l.fecha);
    if (!k || !porMes.has(k)) continue;
    const fila = porMes.get(k);
    const elem = elementoDeCodigo(l.codigo);
    if (elem === '7') fila.ingresos = round2(fila.ingresos + toNumber(l.haber) - toNumber(l.debe));
    if (elem === '6') fila.gastos = round2(fila.gastos + toNumber(l.debe) - toNumber(l.haber));
    if (String(l.codigo).startsWith('10')) {
      fila.entradas = round2(fila.entradas + toNumber(l.debe));
      fila.salidas = round2(fila.salidas + toNumber(l.haber));
    }
  }
  let saldoAcumulado = 0;
  const asientosOrdenados = [...asientos].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  let cursor = 0;
  const salida = [];
  for (const k of rango) {
    const finMes = k + '-31';
    while (cursor < asientosOrdenados.length && (asientosOrdenados[cursor].fecha || '') <= finMes) {
      const l = asientosOrdenados[cursor];
      if (String(l.codigo).startsWith('10')) saldoAcumulado = round2(saldoAcumulado + toNumber(l.debe) - toNumber(l.haber));
      cursor++;
    }
    const fila = porMes.get(k);
    salida.push({ ...fila, saldoCaja: saldoAcumulado, resultado: round2(fila.ingresos - fila.gastos) });
  }
  return salida;
}

/** Top N de gastos agrupados por tipo (dos primeros dígitos del elemento 6). */
function calcularTopGastos(balanceFilas, top = 5) {
  const NOMBRES = {
    '60': 'Compras', '61': 'Variación de existencias', '62': 'Gastos de personal',
    '63': 'Servicios de terceros', '64': 'Tributos', '65': 'Otros gastos de gestión',
    '66': 'Pérdida por medición de activos', '67': 'Gastos financieros',
    '68': 'Valuación y deterioro', '69': 'Costo de ventas'
  };
  const porTipo = new Map();
  for (const f of balanceFilas) {
    if (elementoDeCodigo(f.codigo) !== '6') continue;
    const tipo = f.codigo.slice(0, 2);
    const monto = round2(f.debe - f.haber);
    if (monto <= 0) continue;
    porTipo.set(tipo, round2((porTipo.get(tipo) || 0) + monto));
  }
  const lista = [...porTipo.entries()]
    .map(([cod, monto]) => ({ codigo: cod, nombre: NOMBRES[cod] || `Elemento ${cod}`, monto }))
    .sort((a, b) => b.monto - a.monto);
  const principales = lista.slice(0, top);
  const totalTodos = lista.reduce((s, x) => s + x.monto, 0);
  const totalPrincipales = principales.reduce((s, x) => s + x.monto, 0);
  const otros = round2(totalTodos - totalPrincipales);
  if (otros > 0.004) principales.push({ codigo: '—', nombre: 'Otros gastos', monto: otros });
  return principales;
}

/** Nombres estándar de los elementos del PCGE, para agrupar el Plan de Cuentas. */
const ELEMENTO_NOMBRES = {
  '0': 'Cuentas de orden',
  '1': 'Activo disponible y exigible',
  '2': 'Activo realizable',
  '3': 'Activo inmovilizado',
  '4': 'Pasivo',
  '5': 'Patrimonio neto',
  '6': 'Gastos por naturaleza',
  '7': 'Ingresos',
  '8': 'Saldos intermediarios de gestión',
  '9': 'Contabilidad analítica de explotación'
};

/**
 * Construye recursivamente los grupos intermedios (nivel 2, 3, 4… dígitos) de una lista
 * de cuentas que comparten un mismo prefijo de `longitud` caracteres. Si dentro del grupo
 * existe una cuenta cuyo propio código coincide con el prefijo, se usa su nombre real;
 * si no, se busca el nombre oficial del PCGE en `gruposNombres`; si tampoco está ahí,
 * el grupo se muestra solo con su código (nunca se inventa un nombre).
 */
function agruparPorPrefijo(lista, longitud, gruposNombres) {
  const directas = lista.filter((c) => c.codigo.length === longitud);
  const masLargas = lista.filter((c) => c.codigo.length > longitud);
  const porPrefijo = new Map();
  for (const c of masLargas) {
    const p = c.codigo.slice(0, longitud);
    if (!porPrefijo.has(p)) porPrefijo.set(p, []);
    porPrefijo.get(p).push(c);
  }
  const nodos = [];
  for (const d of directas) {
    if (!porPrefijo.has(d.codigo)) nodos.push({ codigo: d.codigo, nombre: d.nombre, hijos: [] });
  }
  for (const [prefijo, hijos] of porPrefijo) {
    const propia = directas.find((d) => d.codigo === prefijo);
    const nombre = (propia && propia.nombre) || (gruposNombres && gruposNombres[prefijo]) || null;
    nodos.push({
      codigo: prefijo,
      nombre: nombre || prefijo,
      sinNombreOficial: !nombre,
      hijos: agruparPorPrefijo(hijos, longitud + 1, gruposNombres)
    });
  }
  return nodos.sort((a, b) => a.codigo.localeCompare(b.codigo));
}

/**
 * Árbol completo del Plan de Cuentas: Elemento (1 dígito) → Cuenta (2) → Subcuenta (3) →
 * Divisionaria (4) → Sub-divisionaria (5-6), usando siempre nombres reales u oficiales del
 * PCGE para las carpetas intermedias. Si hay texto de búsqueda, cada rama se recorta a solo
 * lo que coincide (por código o nombre), conservando el camino hasta la raíz para dar contexto.
 */
function construirArbolCuentas(cuentas, gruposNombres, query) {
  const porElemento = new Map();
  for (const c of cuentas) {
    const elem = elementoDeCodigo(c.codigo) || '?';
    if (!porElemento.has(elem)) porElemento.set(elem, []);
    porElemento.get(elem).push(c);
  }
  const raiz = [...porElemento.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([elem, lista]) => ({
    codigo: elem,
    nombre: ELEMENTO_NOMBRES[elem] || `Elemento ${elem}`,
    hijos: agruparPorPrefijo(lista, 2, gruposNombres)
  }));
  const q = normalizeText(query);
  if (!q) return raiz;
  return filtrarArbolCuentas(raiz, q);
}

/** Recorta el árbol dejando solo las ramas que coinciden con `q` (ya normalizado), conservando el contexto del padre. */
function filtrarArbolCuentas(nodos, q) {
  const salida = [];
  for (const n of nodos) {
    const propio = n.codigo.toLowerCase().startsWith(q) || normalizeText(n.nombre).includes(q);
    const hijosFiltrados = propio ? n.hijos : filtrarArbolCuentas(n.hijos, q);
    if (propio || hijosFiltrados.length) salida.push({ ...n, hijos: propio ? n.hijos : hijosFiltrados });
  }
  return salida;
}

/** Cuenta cuántas cuentas reales (hojas y carpetas) hay en total dentro de un nodo del árbol. */
function contarNodos(nodo) {
  return 1 + nodo.hijos.reduce((s, h) => s + contarNodos(h), 0);
}

/** Cuenta solo las cuentas "hoja" (sin subcuentas propias) dentro de un nodo — lo que de verdad se puede usar para registrar. */
function contarHojas(nodo) {
  if (nodo.hijos.length === 0) return 1;
  return nodo.hijos.reduce((s, h) => s + contarHojas(h), 0);
}

/** Suma el saldo neto (deudor − acreedor) de un nodo y de todos sus descendientes, para mostrar un total por grupo. */
function saldoNodo(nodo, saldosPorCodigo) {
  const propio = saldosPorCodigo.get(nodo.codigo);
  let total = propio ? round2(propio.deudor - propio.acreedor) : 0;
  for (const h of nodo.hijos) total = round2(total + saldoNodo(h, saldosPorCodigo));
  return total;
}


/** Texto del eje X según la clave del periodo: "2026-03" (mes), "2026-Q1" (trimestre) o "2026" (año). */
function etiquetaPeriodo(clave) {
  const q = String(clave).match(/^(\d{4})-Q([1-4])$/);
  if (q) return `T${q[2]} ${q[1].slice(2)}`;
  if (/^\d{4}$/.test(clave)) return clave;
  return monthLabel(clave).split(' ')[0];
}

/** Reagrupa una serie mensual en trimestres o años, sumando los montos de cada bucket. */
/**
 * Serie mensual para los gráficos del Panel, respetando el filtro de fecha del dashboard:
 * el saldo de Caja y Bancos sigue calculándose desde el principio de los tiempos (para que
 * nunca "resetee" a 0 solo porque se filtró), pero la serie que se MUESTRA se recorta a los
 * meses dentro de [desde, hasta].
 */
function serieParaPanel(asientos, desde, hasta, mesesAtras) {
  const asientosHasta = filtrarAsientosHasta(asientos, hasta);
  let serie = calcularSerieMensual(asientosHasta, mesesAtras);
  if (desde) {
    const desdeYM = desde.slice(0, 7);
    serie = serie.filter((m) => m.mes >= desdeYM);
  }
  return serie;
}

function agruparSerie(serieMensual, granularidad) {
  if (granularidad === 'mes' || !serieMensual.length) return serieMensual;
  const buckets = new Map();
  for (const m of serieMensual) {
    const [anio, mes] = m.mes.split('-').map(Number);
    const clave = granularidad === 'trimestre' ? `${anio}-Q${Math.ceil(mes / 3)}` : `${anio}`;
    if (!buckets.has(clave)) buckets.set(clave, { mes: clave, ingresos: 0, gastos: 0, entradas: 0, salidas: 0, saldoCaja: 0 });
    const b = buckets.get(clave);
    b.ingresos = round2(b.ingresos + m.ingresos);
    b.gastos = round2(b.gastos + m.gastos);
    b.entradas = round2(b.entradas + m.entradas);
    b.salidas = round2(b.salidas + m.salidas);
    b.saldoCaja = m.saldoCaja; // el último saldo del bucket (la serie de entrada ya viene ordenada)
  }
  return [...buckets.values()].map((b) => ({ ...b, resultado: round2(b.ingresos - b.gastos) }));
}


/* ------------------------------------------------------------------------
   4. RENDER DE INTERFAZ
   ------------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- Toasts ---------- */
function showToast(mensaje, tipo = 'info', duracionMs = 3600) {
  try {
    const cont = $('#toastContainer');
    if (!cont) { console.log('[toast]', tipo, mensaje); return; }
    // no amontonar más de 3 avisos a la vez
    while (cont.children.length >= 3) cont.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = `toast ${tipo}`;
    const icono = tipo === 'success' ? '✔' : tipo === 'error' ? '⚠' : tipo === 'warning' ? '⚠' : 'ℹ';
    el.innerHTML = `<span aria-hidden="true">${icono}</span><span></span>`;
    el.lastElementChild.textContent = mensaje; // texto seguro, sin HTML
    cont.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, duracionMs);
  } catch (err) {
    console.error('showToast error:', err);
  }
}

/* ---------- Tabs ---------- */
function activarTab(nombre) {
  try {
    state.activeTab = nombre;
    $all('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === nombre));
    $all('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === nombre));
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    renderTabActual();
  } catch (err) {
    console.error('activarTab error:', err);
  }
}

function renderTabActual() {
  switch (state.activeTab) {
    case 'registro': renderEcuacion(); break;
    case 'diario': renderDiario(); break;
    case 'mayor': renderMayor(); break;
    case 'plan': renderPlan(); break;
    case 'balance': renderBalance(); break;
    case 'resultados': renderResultados(); break;
    case 'situacion': renderSituacion(); break;
    case 'panel': renderPanel(); break;
  }
}

/* ---------- Ecuación contable (cabecera) ---------- */
function renderEcuacion() {
  try {
    const balance = calcularBalance(state.asientos, state.cuentasPorCodigo);
    const resultados = calcularResultados(balance.filas);
    const situacion = calcularSituacion(balance.filas, resultados.neto);
    const el = $('#equationValue');
    if (el) {
      el.textContent = formatMoney(situacion.totalActivo);
      el.classList.toggle('is-bad', !situacion.cuadra);
    }
  } catch (err) {
    console.error('renderEcuacion error:', err);
  }
}

/* ---------- Autocompletado de cuentas ---------- */
function configurarAutocomplete(inputEl, listEl, hintEl, onSelect) {
  let items = [];
  let activeIndex = -1;

  function cerrar() { listEl.hidden = true; items = []; activeIndex = -1; }

  function abrir(texto) {
    items = buscarCuentas(state.cuentas, texto, 20);
    if (items.length === 0) { cerrar(); return; }
    listEl.innerHTML = items.map((c, i) =>
      `<li data-idx="${i}"><span><b>${escapeHtml(c.codigo)}</b> ${escapeHtml(c.nombre)}</span></li>`
    ).join('');
    listEl.hidden = false;
    activeIndex = -1;
  }

  inputEl.addEventListener('input', () => {
    onSelect(null); // se invalida la selección previa mientras el usuario escribe
    abrir(inputEl.value);
    actualizarHint(inputEl, hintEl, onSelect);
  });

  inputEl.addEventListener('focus', () => { if (inputEl.value) abrir(inputEl.value); });

  inputEl.addEventListener('blur', () => {
    // pequeño retraso para permitir el click sobre un ítem de la lista
    setTimeout(() => cerrar(), 150);
  });

  inputEl.addEventListener('keydown', (ev) => {
    if (listEl.hidden || items.length === 0) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); marcarActivo(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); marcarActivo(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (activeIndex >= 0) elegir(items[activeIndex]); }
    else if (ev.key === 'Escape') { cerrar(); }
  });

  function marcarActivo() {
    $all('li', listEl).forEach((li, i) => li.classList.toggle('active', i === activeIndex));
  }

  function elegir(cuenta) {
    inputEl.value = `${cuenta.codigo} - ${cuenta.nombre}`;
    onSelect(cuenta);
    cerrar();
    actualizarHint(inputEl, hintEl, onSelect);
  }

  listEl.addEventListener('mousedown', (ev) => {
    const li = ev.target.closest('li');
    if (!li) return;
    const idx = Number(li.dataset.idx);
    if (items[idx]) elegir(items[idx]);
  });

  return { cerrar };
}

function actualizarHint(inputEl, hintEl, onSelectGetter) {
  const texto = inputEl.value.trim();
  hintEl.classList.remove('hint-ok', 'hint-warn', 'hint-bad');
  if (!texto) { hintEl.textContent = ''; return; }
  const cuenta = resolverCuenta(state.cuentasPorCodigo, state.cuentas, texto);
  if (cuenta) {
    hintEl.textContent = `→ ${cuenta.codigo} · ${cuenta.nombre}`;
    hintEl.classList.add('hint-ok');
  } else {
    const sugerencias = buscarCuentas(state.cuentas, texto, 1);
    if (sugerencias.length) {
      hintEl.textContent = `⚠ Sin detalle: pruebe ${sugerencias[0].codigo} · ${sugerencias[0].nombre}`;
    } else {
      hintEl.textContent = '⚠ No se encontró la cuenta';
    }
    hintEl.classList.add('hint-bad');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Formulario de Registro: asiento multilínea con previsualización ---------- */
let _cargarAsientoEnFormulario = null; // asignado dentro de inicializarFormularioRegistro; usado por el Diario

function nuevaFilaAsiento() {
  return { id: makeId(), cuentaTexto: '', cuenta: null, debe: '', haber: '' };
}

function inicializarFormularioRegistro() {
  const inpObs = $('#inpObs');
  const inpFecha = $('#inpFecha');
  const form = $('#formRegistro');
  const status = $('#formStatus');
  const formTitle = $('#formTitle');
  const btnRegistrar = $('#btnRegistrar');
  const editBanner = $('#editBanner');
  const editBannerNum = $('#editBannerNum');
  const btnCancelEdit = $('#btnCancelEdit');
  const contFilas = $('#filasAsiento');
  const btnAgregarLinea = $('#btnAgregarLinea');
  const preview = $('#asientoPreview');

  inpFecha.value = todayISO();
  let modoEdicion = null; // { numero } mientras se edita un asiento existente
  let filas = [nuevaFilaAsiento(), nuevaFilaAsiento()];

  function actualizarModoUI() {
    if (modoEdicion) {
      formTitle.textContent = 'Editar asiento';
      editBanner.hidden = false;
      editBannerNum.textContent = String(modoEdicion.numero);
      btnRegistrar.textContent = '💾 Guardar cambios';
    } else {
      formTitle.textContent = 'Nuevo asiento';
      editBanner.hidden = true;
      btnRegistrar.textContent = '▶ Registrar asiento';
    }
  }

  function actualizarPreview() {
    const resultado = validarAsientoMultilinea(filas);
    const conCuenta = filas.filter((f) => f.cuenta);

    if (conCuenta.length === 0) {
      preview.innerHTML = '<p class="muted">Agregue al menos 2 líneas con cuenta y monto para ver la previsualización.</p>';
    } else {
      preview.innerHTML = `
        <table>
          <thead><tr><th>Cuenta</th><th class="num">Debe</th><th class="num">Haber</th></tr></thead>
          <tbody>${conCuenta.map((f) => `
            <tr>
              <td>${escapeHtml(f.cuenta.codigo)} ${escapeHtml(f.cuenta.nombre)}</td>
              <td class="num">${toNumber(f.debe) ? formatMoney(f.debe) : '-'}</td>
              <td class="num">${toNumber(f.haber) ? formatMoney(f.haber) : '-'}</td>
            </tr>`).join('')}</tbody>
          <tfoot><tr><td>TOTAL</td><td class="num">${formatMoney(resultado.totalDebe)}</td><td class="num">${formatMoney(resultado.totalHaber)}</td></tr></tfoot>
        </table>
        <p class="preview-estado ${resultado.cuadra ? 'ok' : 'bad'}">${resultado.cuadra
          ? '✔ ASIENTO CUADRADO'
          : `⚠ EL ASIENTO NO CUADRA · Diferencia ${formatMoney(Math.abs(resultado.diferencia))}`}</p>`;
    }

    status.classList.remove('ok', 'bad');
    if (resultado.ok) {
      status.textContent = resultado.aviso ? `✔ Listo · ⚠ ${resultado.aviso}` : (modoEdicion ? '✔ Listo para guardar los cambios.' : '✔ Listo para registrar.');
      status.classList.add('ok');
    } else {
      status.textContent = resultado.mensaje;
      if (conCuenta.length > 0) status.classList.add('bad');
    }
    btnRegistrar.disabled = !resultado.ok;
    return resultado;
  }

  function renderFilas() {
    contFilas.innerHTML = filas.map((f, i) => `
      <div class="fila-asiento" data-id="${f.id}">
        <div class="autocomplete">
          <input type="text" class="fila-input-cuenta" placeholder="Código o nombre de cuenta" autocomplete="off" value="${escapeHtml(f.cuentaTexto || '')}" aria-label="Cuenta contable de la línea ${i + 1}">
          <ul class="autocomplete-list" hidden></ul>
        </div>
        <p class="fila-hint hint"></p>
        <div class="fila-montos">
          <input type="number" class="fila-input-debe" placeholder="Debe" inputmode="decimal" step="0.01" min="0" value="${f.debe === '' ? '' : f.debe}" aria-label="Debe de la línea ${i + 1}">
          <input type="number" class="fila-input-haber" placeholder="Haber" inputmode="decimal" step="0.01" min="0" value="${f.haber === '' ? '' : f.haber}" aria-label="Haber de la línea ${i + 1}">
          <button type="button" class="fila-del" aria-label="Eliminar línea ${i + 1}" ${filas.length <= 2 ? 'disabled' : ''}>✕</button>
        </div>
      </div>`).join('');

    $all('.fila-asiento', contFilas).forEach((el, i) => {
      const f = filas[i];
      const inpC = $('.fila-input-cuenta', el);
      const listC = $('.autocomplete-list', el);
      const hintC = $('.fila-hint', el);
      const inpD = $('.fila-input-debe', el);
      const inpH = $('.fila-input-haber', el);
      const btnDel = $('.fila-del', el);

      configurarAutocomplete(inpC, listC, hintC, (cuenta) => {
        f.cuenta = cuenta || resolverCuenta(state.cuentasPorCodigo, state.cuentas, inpC.value);
        f.cuentaTexto = inpC.value;
        actualizarPreview();
      });
      inpD.addEventListener('input', () => {
        f.debe = inpD.value;
        if (inpD.value) { inpH.value = ''; f.haber = ''; }
        actualizarPreview();
      });
      inpH.addEventListener('input', () => {
        f.haber = inpH.value;
        if (inpH.value) { inpD.value = ''; f.debe = ''; }
        actualizarPreview();
      });
      btnDel.addEventListener('click', () => {
        if (filas.length <= 2) return;
        filas = filas.filter((x) => x.id !== f.id);
        renderFilas();
      });
    });

    actualizarPreview();
  }

  btnAgregarLinea.addEventListener('click', () => { filas.push(nuevaFilaAsiento()); renderFilas(); });

  function reiniciarFormulario() {
    filas = [nuevaFilaAsiento(), nuevaFilaAsiento()];
    inpObs.value = '';
    inpFecha.value = todayISO();
    renderFilas();
  }

  function cancelarEdicion() {
    modoEdicion = null;
    reiniciarFormulario();
    actualizarModoUI();
  }
  btnCancelEdit.addEventListener('click', cancelarEdicion);

  /** Carga un asiento existente (cualquier cantidad de líneas) en el formulario, para editarlo o duplicarlo. */
  function cargarAsientoEnFormulario(numero, modo) {
    const lineas = obtenerLineasAsiento(state.asientos, numero);
    if (lineas.length === 0) { showToast('No se encontró ese asiento.', 'error'); return; }

    const nuevasFilas = lineas.map((l) => {
      const cuenta = state.cuentasPorCodigo.get(l.codigo);
      return {
        id: makeId(),
        cuentaTexto: cuenta ? `${cuenta.codigo} - ${cuenta.nombre}` : l.codigo,
        cuenta: cuenta || null,
        debe: l.debe ? l.debe : '',
        haber: l.haber ? l.haber : ''
      };
    });
    if (nuevasFilas.some((f) => !f.cuenta)) {
      showToast('Alguna cuenta de este asiento ya no existe en el plan de cuentas; revísela antes de guardar.', 'warning', 5200);
    }

    activarTab('registro');
    filas = nuevasFilas;
    inpObs.value = (lineas[0].glosa || '').split(' · ')[0] || '';
    inpFecha.value = modo === 'duplicar' ? todayISO() : lineas[0].fecha;
    modoEdicion = modo === 'editar' ? { numero } : null;
    actualizarModoUI();
    renderFilas();
    showToast(
      modo === 'editar' ? `Editando el asiento N° ${numero} (${lineas.length} líneas).` : `Copiando el asiento N° ${numero} (${lineas.length} líneas) — revise y presione Registrar.`,
      'success', 3200
    );
  }
  _cargarAsientoEnFormulario = cargarAsientoEnFormulario;

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const resultado = actualizarPreview();
      if (!resultado.ok) { showToast(resultado.mensaje, 'error'); return; }
      if (resultado.aviso) {
        const seguir = window.confirm(resultado.aviso + '\n\n¿Registrar de todos modos?');
        if (!seguir) return;
      }
      const fecha = inpFecha.value || todayISO();
      const glosa = inpObs.value;

      if (modoEdicion) {
        const numero = modoEdicion.numero;
        const nuevasLineas = construirLineasDesdeFilas(filas, { numero, fecha, glosa });
        state.asientos = state.asientos.filter((a) => a.numero !== numero).concat(nuevasLineas);
        const guardadoOk = await saveToStorage();
        if (guardadoOk) showToast(`Asiento N° ${numero} actualizado (${nuevasLineas.length} líneas).`, 'success');
        cancelarEdicion();
        renderEcuacion();
        return;
      }

      const numero = siguienteNumeroAsiento(state.asientos);
      const nuevasLineas = construirLineasDesdeFilas(filas, { numero, fecha, glosa });
      state.asientos.push(...nuevasLineas);
      const guardado = await saveToStorage();
      if (guardado) {
        const balance = calcularBalance(state.asientos, state.cuentasPorCodigo);
        const resultados = calcularResultados(balance.filas);
        const situacion = calcularSituacion(balance.filas, resultados.neto);
        showToast(
          `Registrado (asiento N° ${numero}, ${nuevasLineas.length} líneas). ` + (situacion.cuadra ? 'El Estado de Situación cuadra.' : `Atención: no cuadra, diferencia ${formatMoney(situacion.diferencia)}.`),
          situacion.cuadra ? 'success' : 'warning', 4600
        );
      }
      reiniciarFormulario();
      renderEcuacion();
    } catch (err) {
      console.error('Error al registrar:', err);
      showToast('Ocurrió un error inesperado al registrar. Intente de nuevo.', 'error');
    }
  });

  renderFilas();
  actualizarModoUI();
}

/* ---------- Búsqueda universal ---------- */
function inicializarBusquedaGlobal() {
  const input = $('#globalSearch');
  const btnClear = $('#btnClearSearch');
  input.addEventListener('input', () => {
    state.search = input.value;
    btnClear.hidden = !state.search;
    state.page.diario = 1; state.page.balance = 1;
    renderPreviaCuentaBusqueda();
    if (state.activeTab === 'diario') renderDiario();
    else if (state.activeTab === 'balance') renderBalance();
    else if (state.activeTab === 'plan') renderPlan();
  });
  btnClear.addEventListener('click', () => {
    input.value = ''; state.search = ''; btnClear.hidden = true;
    renderPreviaCuentaBusqueda();
    if (state.activeTab === 'diario') renderDiario();
    else if (state.activeTab === 'balance') renderBalance();
    else if (state.activeTab === 'plan') renderPlan();
  });
}

/** Si lo escrito coincide EXACTO con el código de una cuenta, muestra su ficha (saldo, debe, haber) bajo el buscador. */
function renderPreviaCuentaBusqueda() {
  const cont = $('#searchAccountPreview');
  const texto = state.search.trim();
  const cuenta = texto ? state.cuentasPorCodigo.get(texto) : null;
  if (!cuenta) { cont.hidden = true; cont.innerHTML = ''; return; }
  const balance = calcularBalance(state.asientos, state.cuentasPorCodigo);
  const fila = balance.filas.find((f) => f.codigo === cuenta.codigo);
  const debe = fila ? fila.debe : 0, haber = fila ? fila.haber : 0;
  const saldo = fila ? (fila.deudor ? formatMoney(fila.deudor) + ' (deudor)' : fila.acreedor ? formatMoney(fila.acreedor) + ' (acreedor)' : formatMoney(0)) : formatMoney(0);
  cont.innerHTML = `
    <div class="sap-title">Cuenta <b>${escapeHtml(cuenta.codigo)}</b> · ${escapeHtml(cuenta.nombre)}</div>
    <div class="sap-item"><span>Debe</span><strong>${formatMoney(debe)}</strong></div>
    <div class="sap-item"><span>Haber</span><strong>${formatMoney(haber)}</strong></div>
    <div class="sap-item cyan"><span>Saldo</span><strong>${saldo}</strong></div>`;
  cont.hidden = false;
}

function coincideBusqueda(campos, query) {
  if (!query) return true;
  const q = normalizeText(query);
  return campos.some((c) => normalizeText(c).includes(q));
}

/* ---------- Ordenamiento de columnas ---------- */
function inicializarOrdenTabla(tableId, sortKey) {
  const table = $('#' + tableId);
  $all('th[data-sort]', table).forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const actual = state.sort[sortKey];
      if (actual.key === key) actual.dir = actual.dir === 'asc' ? 'desc' : 'asc';
      else { actual.key = key; actual.dir = 'asc'; }
      if (sortKey === 'diario') renderDiario(); else renderBalance();
    });
  });
}

function actualizarFlechasOrden(tableId, sortKey) {
  const table = $('#' + tableId);
  $all('th[data-sort]', table).forEach((th) => {
    const i = th.querySelector('i');
    if (th.dataset.sort === state.sort[sortKey].key) i.textContent = state.sort[sortKey].dir === 'asc' ? '▲' : '▼';
    else i.textContent = '';
  });
}

function ordenar(filas, key, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  return [...filas].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
    return String(va ?? '').localeCompare(String(vb ?? ''), 'es') * mult;
  });
}

/* ---------- Paginación ---------- */
function paginar(filas, page) {
  if (filas.length <= PAGE_SIZE) return { pagina: filas, totalPaginas: 1, page: 1 };
  const totalPaginas = Math.max(1, Math.ceil(filas.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPaginas);
  return { pagina: filas.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), totalPaginas, page: p };
}

function renderPaginacion(contId, totalPaginas, page, onChange) {
  const cont = $('#' + contId);
  if (totalPaginas <= 1) { cont.innerHTML = ''; return; }
  cont.innerHTML = `
    <button id="${contId}Prev" ${page <= 1 ? 'disabled' : ''}>‹ Anterior</button>
    <span>Página ${page} de ${totalPaginas}</span>
    <button id="${contId}Next" ${page >= totalPaginas ? 'disabled' : ''}>Siguiente ›</button>`;
  $('#' + contId + 'Prev').addEventListener('click', () => onChange(page - 1));
  $('#' + contId + 'Next').addEventListener('click', () => onChange(page + 1));
}

/* ---------- Libro Diario ---------- */
function renderDiario() {
  try {
    const grupos = agruparPorAsiento(state.asientos);
    let filas = state.asientos.map((l) => {
      const cuenta = state.cuentasPorCodigo.get(l.codigo);
      return { ...l, nombre: cuenta ? cuenta.nombre : 'Cuenta no encontrada' };
    });
    filas = filas.filter((f) => coincideBusqueda([f.fecha, f.numero, f.codigo, f.nombre, f.glosa, f.debe, f.haber], state.search));
    filas = ordenar(filas, state.sort.diario.key, state.sort.diario.dir);

    $('#badgeDiarioCount').textContent = `${state.asientos.length} línea${state.asientos.length === 1 ? '' : 's'}`;
    $('#emptyDiario').hidden = state.asientos.length !== 0;
    $('#tableDiario').hidden = state.asientos.length === 0;

    const { pagina, totalPaginas, page } = paginar(filas, state.page.diario);
    state.page.diario = page;
    $('#bodyDiario').innerHTML = pagina.map((f) => {
      return `
      <tr data-numero="${f.numero}">
        <td>${escapeHtml(formatDateDisplay(f.fecha))}</td>
        <td>${escapeHtml(orDash(f.numero))}</td>
        <td>${escapeHtml(f.codigo)}</td>
        <td class="wrap">${escapeHtml(f.nombre)}</td>
        <td class="wrap">${escapeHtml(orDash(f.glosa))}</td>
        <td class="num">${f.debe ? formatMoney(f.debe) : '-'}</td>
        <td class="num">${f.haber ? formatMoney(f.haber) : '-'}</td>
        <td class="row-actions">
          <button class="row-edit" data-edit-asiento="${f.numero}" title="Editar asiento" aria-label="Editar asiento">✎</button>
          <button class="row-dup" data-dup-asiento="${f.numero}" title="Duplicar asiento" aria-label="Duplicar asiento">⧉</button>
          <button class="row-del" data-del-asiento="${f.numero}" title="Eliminar asiento completo" aria-label="Eliminar asiento">🗑</button>
        </td>
      </tr>`;
    }).join('') || '';
    actualizarFlechasOrden('tableDiario', 'diario');
    renderPaginacion('pagDiario', totalPaginas, page, (p) => { state.page.diario = p; renderDiario(); });

    $all('[data-del-asiento]', $('#bodyDiario')).forEach((btn) => {
      btn.addEventListener('click', () => eliminarAsiento(Number(btn.dataset.delAsiento)));
    });
    $all('[data-edit-asiento]', $('#bodyDiario')).forEach((btn) => {
      btn.addEventListener('click', () => { if (_cargarAsientoEnFormulario) _cargarAsientoEnFormulario(Number(btn.dataset.editAsiento), 'editar'); });
    });
    $all('[data-dup-asiento]', $('#bodyDiario')).forEach((btn) => {
      btn.addEventListener('click', () => { if (_cargarAsientoEnFormulario) _cargarAsientoEnFormulario(Number(btn.dataset.dupAsiento), 'duplicar'); });
    });
  } catch (err) {
    console.error('renderDiario error:', err);
    showToast('No se pudo mostrar el Libro Diario.', 'error');
  }
}

async function eliminarAsiento(numero) {
  const lineas = state.asientos.filter((a) => a.numero === numero);
  const resumen = lineas.map((l) => `${l.codigo} ${l.debe ? 'Debe ' + formatMoney(l.debe) : 'Haber ' + formatMoney(l.haber)}`).join(' / ');
  const ok = window.confirm(`¿Eliminar el asiento N° ${numero}?\n${resumen}\n\nEsta acción no se puede deshacer.`);
  if (!ok) return;
  state.asientos = state.asientos.filter((a) => a.numero !== numero);
  await saveToStorage();
  showToast(`Asiento N° ${numero} eliminado.`, 'success');
  renderDiario();
  renderEcuacion();
}

/* ---------- Balance de Comprobación ---------- */
function renderBalance() {
  try {
    const { hasta } = obtenerRangoFiltro('balance');
    const balance = calcularBalance(filtrarAsientosHasta(state.asientos, hasta), state.cuentasPorCodigo);
    let filas = balance.filas.filter((f) => coincideBusqueda([f.codigo, f.nombre], state.search));
    filas = ordenar(filas, state.sort.balance.key, state.sort.balance.dir);

    $('#emptyBalance').hidden = balance.filas.length !== 0;
    $('#tableBalance').hidden = balance.filas.length === 0;
    const badge = $('#badgeBalanceOk');
    badge.textContent = balance.cuadra ? 'Cuadra' : `Descuadrado (${formatMoney(balance.totales.debe - balance.totales.haber)})`;
    badge.classList.toggle('bad', !balance.cuadra);

    const { pagina, totalPaginas, page } = paginar(filas, state.page.balance);
    state.page.balance = page;
    $('#bodyBalance').innerHTML = pagina.map((f) => `
      <tr>
        <td>${escapeHtml(f.codigo)}</td>
        <td class="wrap">${escapeHtml(f.nombre)}</td>
        <td class="num">${formatMoney(f.debe)}</td>
        <td class="num">${formatMoney(f.haber)}</td>
        <td class="num">${f.deudor ? formatMoney(f.deudor) : '-'}</td>
        <td class="num">${f.acreedor ? formatMoney(f.acreedor) : '-'}</td>
      </tr>`).join('');
    $('#footBalance').innerHTML = balance.filas.length ? `
      <tr>
        <td colspan="2">Total</td>
        <td class="num">${formatMoney(balance.totales.debe)}</td>
        <td class="num">${formatMoney(balance.totales.haber)}</td>
        <td class="num">${formatMoney(balance.totales.deudor)}</td>
        <td class="num">${formatMoney(balance.totales.acreedor)}</td>
      </tr>` : '';
    actualizarFlechasOrden('tableBalance', 'balance');
    renderPaginacion('pagBalance', totalPaginas, page, (p) => { state.page.balance = p; renderBalance(); });
  } catch (err) {
    console.error('renderBalance error:', err);
    showToast('No se pudo mostrar el Balance de Comprobación.', 'error');
  }
}

/* ---------- Libro Mayor ---------- */
function renderMayor() {
  try {
    const cuenta = state.mayorCuenta;
    $('#emptyMayor').hidden = !!cuenta;
    $('#mayorResumen').hidden = !cuenta;
    $('#tableMayor').hidden = !cuenta;
    if (!cuenta) { $('#bodyMayor').innerHTML = ''; $('#footMayor').innerHTML = ''; return; }

    const { desde, hasta } = obtenerRangoFiltro('mayor');

    const mayor = calcularMayorCuenta(state.asientos, cuenta.codigo, desde, hasta);
    $('#mayorSaldoInicial').textContent = formatSaldoConSigno(mayor.saldoInicial);
    $('#mayorSaldoFinal').textContent = formatSaldoConSigno(mayor.saldoFinal);

    $('#bodyMayor').innerHTML = mayor.filas.map((f) => `
      <tr>
        <td>${escapeHtml(formatDateDisplay(f.fecha))}</td>
        <td>${escapeHtml(orDash(f.numero))}</td>
        <td class="wrap">${escapeHtml(orDash(f.glosa))}</td>
        <td class="num">${f.debe ? formatMoney(f.debe) : '-'}</td>
        <td class="num">${f.haber ? formatMoney(f.haber) : '-'}</td>
        <td class="num">${escapeHtml(formatSaldoConSigno(f.saldo))}</td>
      </tr>`).join('');
    $('#footMayor').innerHTML = mayor.filas.length ? `
      <tr>
        <td colspan="3">Total del periodo</td>
        <td class="num">${formatMoney(mayor.totalDebe)}</td>
        <td class="num">${formatMoney(mayor.totalHaber)}</td>
        <td class="num">${escapeHtml(formatSaldoConSigno(mayor.saldoFinal))}</td>
      </tr>` : '';
    if (mayor.filas.length === 0) {
      $('#bodyMayor').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:18px 0;">Sin movimientos en este rango de fechas.</td></tr>`;
    }
  } catch (err) {
    console.error('renderMayor error:', err);
    showToast('No se pudo mostrar el Libro Mayor.', 'error');
  }
}

function inicializarMayor() {
  const inpCuenta = $('#inpMayorCuenta');
  const hint = $('#hintMayorCuenta');

  configurarAutocomplete(inpCuenta, $('#listMayorCuenta'), hint, (cuenta) => {
    state.mayorCuenta = cuenta || resolverCuenta(state.cuentasPorCodigo, state.cuentas, inpCuenta.value);
    renderMayor();
  });

  inicializarFiltroFecha('mayor', renderMayor);
}

/* ---------- Plan de Cuentas (explorador expandible) ---------- */
function renderPlan() {
  try {
    const balance = calcularBalance(state.asientos, state.cuentasPorCodigo);
    const saldosPorCodigo = new Map(balance.filas.map((f) => [f.codigo, f]));
    const arbol = construirArbolCuentas(state.cuentas, state.gruposPCGE, state.search);

    const totalMostrado = arbol.reduce((s, n) => s + contarHojas(n), 0);
    $('#badgePlanCount').textContent = state.search
      ? `${totalMostrado} de ${state.cuentas.length} cuentas`
      : `${state.cuentas.length} cuentas`;

    $('#emptyPlan').hidden = arbol.length !== 0;
    const abrir = !!state.search;
    $('#planTree').innerHTML = arbol.map((n) => renderNodoPlan(n, saldosPorCodigo, abrir)).join('');
  } catch (err) {
    console.error('renderPlan error:', err);
    showToast('No se pudo mostrar el Plan de Cuentas.', 'error');
  }
}

/** Formatea un saldo con signo: positivo tal cual, negativo entre paréntesis (convención contable). */
function formatSaldoConSigno(monto) {
  if (!monto) return '-';
  return monto > 0 ? formatMoney(monto) : `(${formatMoney(-monto)})`;
}

/** Renderiza un nodo del árbol del Plan de Cuentas: fila simple si es hoja, carpeta expandible si tiene hijos. */
function renderNodoPlan(nodo, saldosPorCodigo, abrir) {
  if (nodo.hijos.length === 0) {
    const f = saldosPorCodigo.get(nodo.codigo);
    const saldo = f ? round2(f.deudor - f.acreedor) : 0;
    return `<div class="plan-row">
      <span class="pr-codigo">${escapeHtml(nodo.codigo)}</span>
      <span class="pr-nombre">${escapeHtml(nodo.nombre)}</span>
      <span class="pr-saldo${saldo ? ' tiene-saldo' : ''}">${escapeHtml(formatSaldoConSigno(saldo))}</span>
    </div>`;
  }
  const totalSaldo = saldoNodo(nodo, saldosPorCodigo);
  const esRaiz = nodo.codigo.length === 1; // el nivel "elemento" no lleva estilo de código monoespaciado
  return `<details class="plan-group" ${abrir ? 'open' : ''}>
    <summary>
      <span class="pg-name">${esRaiz ? '' : `<b>${escapeHtml(nodo.codigo)}</b>`}${nodo.sinNombreOficial ? ` <i class="pg-sinnombre">(sin nombre oficial en este nivel)</i>` : ` · ${escapeHtml(nodo.nombre)}`}</span>
      <span class="pg-count">${contarHojas(nodo)}${totalSaldo ? ' · ' + formatSaldoConSigno(totalSaldo) : ''}</span>
    </summary>
    <div class="plan-list">
      ${nodo.hijos.map((h) => renderNodoPlan(h, saldosPorCodigo, abrir)).join('')}
    </div>
  </details>`;
}


/* ---------- Estado de Resultados ---------- */
function renderResultados() {
  try {
    const { desde, hasta } = obtenerRangoFiltro('resultados');
    const balance = calcularBalance(filtrarAsientosRango(state.asientos, desde, hasta), state.cuentasPorCodigo);
    const r = calcularResultados(balance.filas);
    $('#kpiIngresos').textContent = formatMoney(r.totalIngresos);
    $('#kpiGastos').textContent = formatMoney(r.totalGastos);
    $('#kpiNeto').textContent = formatMoney(r.neto);
    $('#kpiNetoBox').classList.toggle('kpi-highlight', true);

    $('#emptyIngresos').hidden = r.ingresos.length !== 0;
    $('#tableIngresos').hidden = r.ingresos.length === 0;
    $('#bodyIngresos').innerHTML = r.ingresos.map((f) => filaSimple(f)).join('');

    $('#emptyGastos').hidden = r.gastos.length !== 0;
    $('#tableGastos').hidden = r.gastos.length === 0;
    $('#bodyGastos').innerHTML = r.gastos.map((f) => filaSimple(f)).join('');
  } catch (err) {
    console.error('renderResultados error:', err);
    showToast('No se pudo calcular el Estado de Resultados.', 'error');
  }
}

function filaSimple(f) {
  return `<tr><td>${escapeHtml(f.codigo)}</td><td class="wrap">${escapeHtml(f.nombre)}</td><td class="num">${formatMoney(f.monto)}</td></tr>`;
}

/* ---------- Estado de Situación Financiera ---------- */
function renderSituacion() {
  try {
    const { hasta } = obtenerRangoFiltro('situacion');
    const balance = calcularBalance(filtrarAsientosHasta(state.asientos, hasta), state.cuentasPorCodigo);
    const r = calcularResultados(balance.filas);
    const s = calcularSituacion(balance.filas, r.neto);

    $('#kpiActivo').textContent = formatMoney(s.totalActivo);
    $('#kpiPasPat').textContent = formatMoney(s.totalPasivoPatrimonio);
    const status = $('#situacionStatus');
    status.classList.remove('ok', 'bad');
    if (s.cuadra) { status.textContent = 'Cuadra: Activo = Pasivo + Patrimonio'; status.classList.add('ok'); }
    else { status.textContent = `No cuadra: diferencia ${formatMoney(s.diferencia)}`; status.classList.add('bad'); }

    $('#emptyActivo').hidden = s.activo.length !== 0; $('#tableActivo').hidden = s.activo.length === 0;
    $('#bodyActivo').innerHTML = s.activo.map(filaSimple).join('');
    $('#emptyPasivo').hidden = s.pasivo.length !== 0; $('#tablePasivo').hidden = s.pasivo.length === 0;
    $('#bodyPasivo').innerHTML = s.pasivo.map(filaSimple).join('');
    $('#emptyPatrimonio').hidden = s.patrimonio.length !== 0; $('#tablePatrimonio').hidden = s.patrimonio.length === 0;
    $('#bodyPatrimonio').innerHTML = s.patrimonio.map(filaSimple).join('');
  } catch (err) {
    console.error('renderSituacion error:', err);
    showToast('No se pudo calcular el Estado de Situación Financiera.', 'error');
  }
}

/* ---------- Panel (KPIs + gráficos en <canvas>, sin librerías) ---------- */
function renderPanel() {
  try {
    // --- rango de fechas elegido en el filtro del dashboard ---
    const { desde, hasta } = obtenerRangoFiltro('panel');

    // --- cuentas de balance (Activo/Pasivo/Patrimonio/Caja/CxC/CxP): "foto" a la fecha Hasta ---
    const asientosHasta = filtrarAsientosHasta(state.asientos, hasta);
    const balanceHasta = calcularBalance(asientosHasta, state.cuentasPorCodigo);
    const resultadosHasta = calcularResultados(balanceHasta.filas); // para que Patrimonio incluya TODO lo acumulado
    const s = calcularSituacion(balanceHasta.filas, resultadosHasta.neto);

    // --- cuentas de resultado (Ingresos/Gastos/Resultado del periodo): solo lo movido DENTRO del rango ---
    const asientosRango = filtrarAsientosRango(state.asientos, desde, hasta);
    const balanceRango = calcularBalance(asientosRango, state.cuentasPorCodigo);
    const r = calcularResultados(balanceRango.filas);

    $('#pnlCajaBancos').textContent = formatSaldoConSigno(sumaSaldoDeudor(balanceHasta.filas, ['10']));
    $('#pnlPorCobrar').textContent = formatSaldoConSigno(sumaSaldoDeudor(balanceHasta.filas, ['12', '13']));
    $('#pnlPorPagar').textContent = formatSaldoConSigno(sumaSaldoAcreedor(balanceHasta.filas, ['42', '43']));
    $('#pnlActivo').textContent = formatMoney(s.totalActivo);
    $('#pnlPasivo').textContent = formatMoney(s.totalPasivo);
    $('#pnlPatrimonio').textContent = formatMoney(s.totalPatrimonio);
    $('#pnlIngresos').textContent = formatMoney(r.totalIngresos);
    $('#pnlGastos').textContent = formatMoney(r.totalGastos);
    $('#pnlNeto').textContent = formatMoney(r.neto);
    const badge = $('#badgePanelCuadre');
    badge.textContent = s.cuadra ? 'Cuadra' : 'No cuadra';
    badge.classList.toggle('bad', !s.cuadra);

    const grupos = agruparPorAsiento(state.asientos);
    $('#pnlAsientos').textContent = String(grupos.size);
    $('#pnlLineas').textContent = String(state.asientos.length);

    // --- gráficos: respetan el mismo rango, con saldo de caja siempre correcto (ver serieParaPanel) ---
    const serie = serieParaPanel(state.asientos, desde, hasta, 12);
    const mesesParaPeriodo = { mes: 12, trimestre: 24, anio: 48 }[state.periodo] || 12;
    const serieChart = agruparSerie(serieParaPanel(state.asientos, desde, hasta, mesesParaPeriodo), state.periodo);
    dibujarIngresosGastos(serieChart);
    dibujarResultadoMensual(serie);
    dibujarCajaBancos(serie);
    dibujarTopGastos(calcularTopGastos(balanceRango.filas, 5));
  } catch (err) {
    console.error('renderPanel error:', err);
    showToast('No se pudo generar el Panel.', 'error');
  }
}

function inicializarFiltroPanel() {
  inicializarFiltroFecha('panel', renderPanel);
}

/** Prepara un canvas para dibujar nítido según la densidad de píxeles de la pantalla. */
function prepararCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const baseW = Number(canvas.getAttribute('width')) || 640;
  const baseH = Number(canvas.getAttribute('height')) || 280;
  canvas.width = baseW * dpr;
  canvas.height = baseH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, baseW, baseH);
  return { ctx, w: baseW, h: baseH };
}

function textoVacioEnCanvas(ctx, w, h, mensaje) {
  ctx.fillStyle = getCssVar('--text-muted');
  ctx.font = '13px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(mensaje, w / 2, h / 2);
}

function getCssVar(name) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#999'; }
  catch (err) { return '#999'; }
}

/** Gráfico de columnas dobles (ingresos/gastos) + línea de resultado. */
function dibujarIngresosGastos(serie) {
  const canvas = $('#chartIngGas');
  const { ctx, w, h } = prepararCanvas(canvas);
  if (!serie.length) { textoVacioEnCanvas(ctx, w, h, 'Registre operaciones para ver este gráfico.'); $('#legendIngGas').innerHTML = ''; return; }

  const padL = 52, padR = 14, padT = 16, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const maxVal = Math.max(1, ...serie.map((m) => Math.max(m.ingresos, m.gastos)));
  const n = serie.length;
  const slot = plotW / n;
  const barW = Math.min(20, slot * 0.32);

  dibujarEjeY(ctx, padL, padT, plotH, maxVal);
  ctx.strokeStyle = getCssVar('--line'); ctx.beginPath(); ctx.moveTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();

  const puntosLinea = [];
  serie.forEach((m, i) => {
    const cx = padL + slot * i + slot / 2;
    const yIng = padT + plotH - (m.ingresos / maxVal) * plotH;
    const yGas = padT + plotH - (m.gastos / maxVal) * plotH;
    ctx.fillStyle = getCssVar('--cyan');
    ctx.fillRect(cx - barW - 2, yIng, barW, padT + plotH - yIng);
    ctx.fillStyle = getCssVar('--text-muted');
    ctx.fillRect(cx + 2, yGas, barW, padT + plotH - yGas);
    ctx.fillStyle = getCssVar('--text-muted');
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(etiquetaPeriodo(m.mes), cx, padT + plotH + 16);
    const maxRes = Math.max(1, ...serie.map((x) => Math.abs(x.resultado)));
    const yRes = padT + plotH / 2 - (m.resultado / (maxRes * 2.2)) * plotH;
    puntosLinea.push([cx, yRes]);
  });
  ctx.strokeStyle = getCssVar('--white');
  ctx.lineWidth = 2;
  ctx.beginPath();
  puntosLinea.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
  puntosLinea.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fillStyle = getCssVar('--white'); ctx.fill(); });

  $('#legendIngGas').innerHTML = `
    <span><i style="background:${getCssVar('--cyan')}"></i>Ingresos (70-79)</span>
    <span><i style="background:${getCssVar('--text-muted')}"></i>Gastos (60-69)</span>
    <span><i style="background:${getCssVar('--white')}"></i>Resultado</span>`;
}

/** Gráfico de columnas del resultado del mes: verde si ganó, rojo si perdió. */
function dibujarResultadoMensual(serie) {
  const canvas = $('#chartResultado');
  const { ctx, w, h } = prepararCanvas(canvas);
  if (!serie.length) { textoVacioEnCanvas(ctx, w, h, 'Registre operaciones para ver este gráfico.'); return; }

  const padL = 52, padR = 14, padT = 16, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const maxAbs = Math.max(1, ...serie.map((m) => Math.abs(m.resultado)));
  const zeroY = padT + plotH / 2;
  const n = serie.length, slot = plotW / n, barW = Math.min(28, slot * 0.5);

  ctx.strokeStyle = getCssVar('--line'); ctx.beginPath(); ctx.moveTo(padL, zeroY); ctx.lineTo(padL + plotW, zeroY); ctx.stroke();
  dibujarEjeY(ctx, padL, padT, plotH, maxAbs, true);

  serie.forEach((m, i) => {
    const cx = padL + slot * i + slot / 2;
    const alto = (Math.abs(m.resultado) / maxAbs) * (plotH / 2);
    ctx.fillStyle = m.resultado >= 0 ? getCssVar('--ok') : getCssVar('--bad');
    if (m.resultado >= 0) ctx.fillRect(cx - barW / 2, zeroY - alto, barW, alto);
    else ctx.fillRect(cx - barW / 2, zeroY, barW, alto);
    if (m.resultado !== 0) {
      ctx.fillStyle = getCssVar('--text');
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      const y = m.resultado >= 0 ? zeroY - alto - 4 : zeroY + alto + 12;
      ctx.fillText(round2(m.resultado).toFixed(2), cx, y);
    }
    ctx.fillStyle = getCssVar('--text-muted');
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText(monthLabel(m.mes).split(' ')[0], cx, padT + plotH + 16);
  });
}

/** Columnas de entradas/salidas de efectivo + línea de saldo de Caja y Bancos. */
function dibujarCajaBancos(serie) {
  const canvas = $('#chartCaja');
  const { ctx, w, h } = prepararCanvas(canvas);
  if (!serie.length) { textoVacioEnCanvas(ctx, w, h, 'Registre operaciones para ver este gráfico.'); return; }

  const padL = 56, padR = 14, padT = 16, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const maxVal = Math.max(1, ...serie.map((m) => Math.max(m.entradas, m.salidas, m.saldoCaja)));
  const n = serie.length, slot = plotW / n, barW = Math.min(18, slot * 0.28);

  dibujarEjeY(ctx, padL, padT, plotH, maxVal);
  ctx.strokeStyle = getCssVar('--line'); ctx.beginPath(); ctx.moveTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();

  const puntos = [];
  serie.forEach((m, i) => {
    const cx = padL + slot * i + slot / 2;
    const yEnt = padT + plotH - (m.entradas / maxVal) * plotH;
    const ySal = padT + plotH - (m.salidas / maxVal) * plotH;
    ctx.fillStyle = getCssVar('--cyan');
    ctx.fillRect(cx - barW - 2, yEnt, barW, padT + plotH - yEnt);
    ctx.fillStyle = getCssVar('--text-muted');
    ctx.fillRect(cx + 2, ySal, barW, padT + plotH - ySal);
    ctx.fillStyle = getCssVar('--text-muted');
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(monthLabel(m.mes).split(' ')[0], cx, padT + plotH + 16);
    puntos.push([cx, padT + plotH - (m.saldoCaja / maxVal) * plotH]);
  });
  ctx.strokeStyle = getCssVar('--white'); ctx.lineWidth = 2;
  ctx.beginPath(); puntos.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y))); ctx.stroke();
  puntos.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fillStyle = getCssVar('--white'); ctx.fill(); });
}

/** Barras horizontales con el top de gastos por tipo. */
function dibujarTopGastos(items) {
  const canvas = $('#chartTop5');
  const { ctx, w, h } = prepararCanvas(canvas);
  if (!items.length) { textoVacioEnCanvas(ctx, w, h, 'Registre gastos para ver este gráfico.'); return; }

  const padL = 130, padR = 60, padT = 10, padB = 10;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const maxVal = Math.max(1, ...items.map((x) => x.monto));
  const n = items.length, rowH = plotH / n, barH = Math.min(26, rowH * 0.6);

  items.forEach((it, i) => {
    const cy = padT + rowH * i + rowH / 2;
    const barLen = (it.monto / maxVal) * plotW;
    ctx.fillStyle = it.nombre === 'Otros gastos' ? getCssVar('--text-muted') : getCssVar('--gold');
    ctx.fillRect(padL, cy - barH / 2, barLen, barH);
    ctx.fillStyle = getCssVar('--text');
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(it.nombre.length > 20 ? it.nombre.slice(0, 19) + '…' : it.nombre, padL - 8, cy + 4);
    ctx.textAlign = 'left';
    ctx.fillText(formatMoney(it.monto), padL + barLen + 6, cy + 4);
  });
}

function dibujarEjeY(ctx, padL, padT, plotH, maxVal, simetrico = false) {
  ctx.strokeStyle = getCssVar('--line');
  ctx.fillStyle = getCssVar('--text-muted');
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  const pasos = 4;
  for (let i = 0; i <= pasos; i++) {
    const y = padT + plotH - (plotH / pasos) * i;
    const valor = simetrico ? (maxVal * (i - pasos / 2) / (pasos / 2)) : (maxVal * i / pasos);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL - 4, y); ctx.stroke();
    ctx.fillText(Math.round(valor).toLocaleString('es-PE'), padL - 8, y + 3);
  }
}

/* ---------- Tema claro / oscuro ---------- */
function inicializarTema() {
  const THEME_KEY = 'libroCajaPCGE_theme';
  const btn = $('#btnTheme');
  function aplicar(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  let guardado = null;
  try { guardado = window.localStorage.getItem(THEME_KEY); } catch (err) { /* ignorar */ }
  aplicar(guardado === 'light' ? 'light' : 'dark'); // oscuro por defecto: es la identidad de la app
  btn.addEventListener('click', () => {
    const actual = document.documentElement.getAttribute('data-theme');
    const nuevo = actual === 'dark' ? 'light' : 'dark';
    aplicar(nuevo);
    try { window.localStorage.setItem(THEME_KEY, nuevo); } catch (err) { /* modo privado: no se pudo guardar la preferencia */ }
  });
}

/* ---------- Menú de herramientas (exportar / importar / limpiar / borrar) ---------- */
function inicializarMenu() {
  const backdrop = $('#menuBackdrop');
  const abrir = () => { backdrop.hidden = false; };
  const cerrar = () => { backdrop.hidden = true; };
  $('#btnMenu').addEventListener('click', abrir);
  $('#btnCloseMenu').addEventListener('click', cerrar);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) cerrar(); });

  $('#btnExport').addEventListener('click', () => { exportarRespaldo(); cerrar(); });
  $('#btnExport2').addEventListener('click', exportarRespaldo);
  $('#btnExportCSV').addEventListener('click', () => { exportarCSV(); cerrar(); });
  $('#btnExportCSV2').addEventListener('click', exportarCSV);

  const fileInput = $('#fileImport');
  const disparar = () => fileInput.click();
  $('#btnImportTrigger').addEventListener('click', () => { disparar(); cerrar(); });
  $('#btnImportTrigger2').addEventListener('click', disparar);
  fileInput.addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (file) importarRespaldo(file);
    fileInput.value = '';
  });

  $('#btnClearFilters').addEventListener('click', () => {
    state.search = ''; $('#globalSearch').value = ''; $('#btnClearSearch').hidden = true;
    state.page.diario = 1; state.page.balance = 1;
    renderTabActual();
    showToast('Filtros de búsqueda limpiados.', 'success');
    cerrar();
  });

  $('#btnResetData').addEventListener('click', async () => {
    const ok = window.confirm('¿Borrar TODOS los registros de este celular? Esta acción no se puede deshacer. Exporte un respaldo antes si no está seguro.');
    if (!ok) return;
    state.asientos = [];
    await saveToStorage();
    renderTabActual(); renderEcuacion();
    showToast('Se borraron todos los registros.', 'success');
    cerrar();
  });
}

/** Exporta todos los asientos como archivo .json descargable. */
function exportarRespaldo() {
  try {
    if (state.asientos.length === 0) { showToast('No hay registros para exportar.', 'warning'); return; }
    const payload = {
      app: 'Libro de Caja PCGE', version: 1,
      exportado: new Date().toISOString(),
      asientos: state.asientos
    };
    descargarArchivo(JSON.stringify(payload, null, 2), `respaldo_libro_de_caja_${todayISO()}.json`, 'application/json');
    showToast('Respaldo exportado.', 'success');
  } catch (err) {
    console.error('exportarRespaldo error:', err);
    showToast('No se pudo exportar el respaldo.', 'error');
  }
}

/** Exporta todos los asientos como CSV (se abre directo en Excel / Google Sheets). */
function exportarCSV() {
  try {
    if (state.asientos.length === 0) { showToast('No hay registros para exportar.', 'warning'); return; }
    const csv = asientosACSV(state.asientos, state.cuentasPorCodigo);
    // BOM para que Excel en Windows detecte UTF-8 y no rompa las tildes/ñ
    descargarArchivo('\uFEFF' + csv, `libro_de_caja_${todayISO()}.csv`, 'text/csv;charset=utf-8');
    showToast('CSV exportado. Se abre directo en Excel o Google Sheets.', 'success');
  } catch (err) {
    console.error('exportarCSV error:', err);
    showToast('No se pudo exportar el CSV.', 'error');
  }
}

function descargarArchivo(contenido, nombre, tipo) {
  const blob = new Blob([contenido], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Agrega al Libro Diario una lista de asientos ya saneados (vengan de JSON o de CSV), renumerándolos. */
async function importarEntrantes(entrantes, origen) {
  if (entrantes.length === 0) {
    showToast(`El archivo ${origen} no tiene registros reconocibles. Revise que tenga las columnas fecha, asiento, codigo, glosa, debe y haber.`, 'error', 5500);
    return;
  }
  let base = siguienteNumeroAsiento(state.asientos) - 1;
  const mapaNumeros = new Map();
  let asientosNuevos = 0;
  for (const l of entrantes) {
    if (!mapaNumeros.has(l.numero)) { base += 1; mapaNumeros.set(l.numero, base); asientosNuevos += 1; }
    l.numero = mapaNumeros.get(l.numero);
    l.id = makeId();
  }
  const ok = window.confirm(`Se importarán ${entrantes.length} líneas (${asientosNuevos} asientos) al final del Libro Diario.\n\nSi ya cargó estos registros antes, se duplicarán. ¿Continuar?`);
  if (!ok) return;
  state.asientos.push(...entrantes);
  await saveToStorage();
  renderTabActual(); renderEcuacion();
  showToast(`Importadas ${entrantes.length} líneas en ${asientosNuevos} asientos.`, 'success', 4600);
}

/** Importa un respaldo .json o un .csv (propio o hecho a mano en Excel) y agrega sus asientos al final. */
function importarRespaldo(file) {
  const esCSV = /\.csv$/i.test(file.name || '');
  const reader = new FileReader();
  reader.onerror = () => showToast('No se pudo leer el archivo.', 'error');
  reader.onload = () => {
    const texto = String(reader.result);
    if (esCSV) {
      try {
        mostrarEleccionImportar(sanitizeAsientos(csvAAsientos(texto)), 'CSV');
      } catch (err) {
        console.error('importarRespaldo (CSV) error:', err);
        showToast('No se pudo interpretar el archivo CSV.', 'error');
      }
      return;
    }
    try {
      const json = JSON.parse(texto);
      mostrarEleccionImportar(sanitizeAsientos(json && json.asientos), 'JSON');
    } catch (err) {
      console.error('importarRespaldo (JSON) error:', err);
      showToast('El archivo no es un respaldo JSON válido. Si es una hoja de cálculo, guárdela como .csv.', 'error', 5500);
    }
  };
  reader.readAsText(file);
}

/* ---------- Elegir cómo importar: combinar con lo actual, o reemplazarlo todo ---------- */
let _importacionPendiente = null;

function mostrarEleccionImportar(entrantes, origen) {
  if (entrantes.length === 0) {
    showToast(`El archivo ${origen} no tiene registros reconocibles. Revise que tenga las columnas fecha, asiento, codigo, glosa, debe y haber.`, 'error', 5500);
    return;
  }
  _importacionPendiente = { entrantes, origen };
  const asientosEntrantes = agruparPorAsiento(entrantes).size;
  const asientosActuales = agruparPorAsiento(state.asientos).size;
  $('#importResumenTexto').textContent =
    `El archivo ${origen} trae ${entrantes.length} líneas (${asientosEntrantes} asientos). ` +
    `Usted ya tiene ${state.asientos.length} líneas (${asientosActuales} asientos) guardadas. ¿Qué quiere hacer?`;
  $('#importBackdrop').hidden = false;
}

function cerrarEleccionImportar() {
  $('#importBackdrop').hidden = true;
  _importacionPendiente = null;
}

/** Borra todo lo que hay y deja SOLO lo que trae el archivo importado (con confirmación explícita, por ser destructivo). */
async function importarYReemplazar(entrantes, origen) {
  const actuales = state.asientos.length;
  const ok = window.confirm(
    `Esto BORRARÁ las ${actuales} líneas que tiene ahora y las reemplazará por las ${entrantes.length} del archivo ${origen}.\n\n` +
    `Exporte un respaldo antes si no está seguro. Esta acción no se puede deshacer.\n\n¿Continuar?`
  );
  if (!ok) return;

  const mapaNumeros = new Map();
  let base = 0;
  const limpios = entrantes.map((l) => {
    if (!mapaNumeros.has(l.numero)) { base += 1; mapaNumeros.set(l.numero, base); }
    return { ...l, numero: mapaNumeros.get(l.numero), id: makeId() };
  });

  state.asientos = limpios;
  const guardadoOk = await saveToStorage();
  renderTabActual();
  renderEcuacion();
  if (guardadoOk) showToast(`Reemplazado: ahora hay ${limpios.length} líneas en ${mapaNumeros.size} asientos.`, 'success', 4600);
}

function inicializarEleccionImportar() {
  $('#importBackdrop').addEventListener('click', (ev) => { if (ev.target.id === 'importBackdrop') cerrarEleccionImportar(); });
  $('#btnImportarCancelar').addEventListener('click', cerrarEleccionImportar);
  $('#btnImportarCombinar').addEventListener('click', async () => {
    const pendiente = _importacionPendiente;
    cerrarEleccionImportar();
    if (pendiente) await importarEntrantes(pendiente.entrantes, pendiente.origen);
  });
  $('#btnImportarReemplazar').addEventListener('click', async () => {
    const pendiente = _importacionPendiente;
    cerrarEleccionImportar();
    if (pendiente) await importarYReemplazar(pendiente.entrantes, pendiente.origen);
  });
}

/* ---------- Selector de periodo del gráfico principal del Panel ---------- */
function inicializarSelectorPeriodo() {
  const cont = $('#periodSelector');
  if (!cont) return;
  $all('.period-btn', cont).forEach((btn) => {
    btn.addEventListener('click', () => {
      state.periodo = btn.dataset.period;
      $all('.period-btn', cont).forEach((b) => b.classList.toggle('active', b === btn));
      renderPanel();
    });
  });
}

/** Imprime (o exporta a PDF) solo la tarjeta indicada, ocultando el resto de la app. */
function imprimirReporte(cardId) {
  try {
    const card = document.getElementById(cardId);
    if (!card) return;
    document.body.classList.add('printing-report');
    card.classList.add('print-target');
    let limpiado = false;
    const limpiar = () => {
      if (limpiado) return;
      limpiado = true;
      document.body.classList.remove('printing-report');
      card.classList.remove('print-target');
      window.removeEventListener('afterprint', limpiar);
    };
    window.addEventListener('afterprint', limpiar);
    window.print();
    setTimeout(limpiar, 2500); // respaldo por si el navegador no dispara "afterprint"
  } catch (err) {
    console.error('imprimirReporte error:', err);
    showToast('No se pudo abrir el diálogo de impresión.', 'error');
  }
}

/** Muestra el aviso persistente "Nueva versión disponible" con un botón Actualizar. */
function mostrarAvisoActualizacion(worker) {
  if (document.getElementById('updateBanner')) return; // ya se está mostrando
  const banner = document.createElement('div');
  banner.id = 'updateBanner';
  banner.className = 'update-banner';
  banner.innerHTML = `
    <span>⬆ Hay una nueva versión de la app disponible.</span>
    <button type="button" id="btnActualizarAhora">Actualizar</button>`;
  document.body.appendChild(banner);
  document.getElementById('btnActualizarAhora').addEventListener('click', () => {
    worker.postMessage({ type: 'SKIP_WAITING' });
    banner.remove();
  });
}

/**
 * Detecta cuándo hay una versión nueva del Service Worker ya descargada y esperando
 * (ver sw.js: nunca se auto-activa). Muestra el aviso y, recién cuando el usuario confirma
 * y la nueva versión toma el control, recarga la página una sola vez.
 */
async function inicializarActualizacionDisponible() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = window.__swRegistro ? await window.__swRegistro : await navigator.serviceWorker.getRegistration();
    if (!reg) return;

    if (reg.waiting && navigator.serviceWorker.controller) mostrarAvisoActualizacion(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const nuevo = reg.installing;
      if (!nuevo) return;
      nuevo.addEventListener('statechange', () => {
        if (nuevo.state === 'installed' && navigator.serviceWorker.controller) mostrarAvisoActualizacion(nuevo);
      });
    });

    let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (recargando) return;
      recargando = true;
      window.location.reload();
    });
  } catch (err) {
    console.error('No se pudo comprobar si hay una actualización del Service Worker:', err);
  }
}

function inicializarImpresion() {
  const mapa = [
    ['btnPrintDiario', 'printDiario'],
    ['btnPrintMayor', 'printMayor'],
    ['btnPrintPanel', 'printPanel'],
    ['btnPrintBalance', 'printBalance'],
    ['btnPrintResultados', 'printResultados'],
    ['btnPrintSituacion', 'printSituacion']
  ];
  for (const [btnId, cardId] of mapa) {
    const btn = $('#' + btnId);
    if (btn) btn.addEventListener('click', () => imprimirReporte(cardId));
  }
}

/* ------------------------------------------------------------------------
   5. ARRANQUE DE LA APP
   ------------------------------------------------------------------------ */
async function iniciarApp() {
  try {
    const { cuentas, gruposPCGE, asientosSemilla } = await loadInitialData();
    state.cuentas = cuentas;
    state.gruposPCGE = gruposPCGE;
    indexCuentas();

    const guardado = await loadFromStorage();
    state.asientos = guardado ? sanitizeAsientos(guardado.asientos) : asientosSemilla;
    if (!guardado) await saveToStorage();

    state.dataReady = true;
  } catch (err) {
    console.error('No se pudo cargar la información inicial:', err);
    state.cuentas = []; state.cuentasPorCodigo = new Map(); state.asientos = [];
    showToast('No se pudo cargar el plan de cuentas. Revise su conexión y vuelva a abrir la app.', 'error', 6000);
  }

  inicializarTema();
  inicializarMenu();
  inicializarBusquedaGlobal();
  inicializarFormularioRegistro();
  inicializarOrdenTabla('tableDiario', 'diario');
  inicializarOrdenTabla('tableBalance', 'balance');
  inicializarSelectorPeriodo();
  inicializarImpresion();
  inicializarMayor();
  inicializarFiltroPanel();
  inicializarFiltroFecha('balance', renderBalance);
  inicializarFiltroFecha('resultados', renderResultados);
  inicializarFiltroFecha('situacion', renderSituacion);
  inicializarActualizacionDisponible();
  inicializarEleccionImportar();
  $all('.btn-ir-registrar').forEach((btn) => btn.addEventListener('click', () => activarTab('registro')));

  $all('.tab').forEach((btn) => btn.addEventListener('click', () => activarTab(btn.dataset.tab)));

  renderEcuacion();
  // si se abrió desde un acceso directo (#registro, #diario, #panel…) o el usuario recarga en otra pestaña
  const tabsValidas = ['registro', 'diario', 'mayor', 'plan', 'balance', 'resultados', 'situacion', 'panel'];
  const tabDesdeHash = (location.hash || '').replace('#', '');
  if (tabsValidas.includes(tabDesdeHash)) activarTab(tabDesdeHash);
  else renderTabActual();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', iniciarApp);
} else {
  iniciarApp();
}
