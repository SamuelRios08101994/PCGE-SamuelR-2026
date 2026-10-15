# Libro de Caja PCGE — PWA

App contable móvil (Progressive Web App), sin frameworks ni librerías externas
pesadas, basada en el Plan Contable General Empresarial (PCGE, Perú).

Incluye: Registro (formulario tipo app), Libro Diario, Balance de
Comprobación, Estado de Resultados, Estado de Situación Financiera y un
Panel con 4 gráficos (ingresos vs gastos por mes, resultado del mes, saldo
de Caja y Bancos, y top 5 de gastos), dibujados en `<canvas>` puro.

## Archivos
- `index.html` — estructura de la app.
- `styles.css` — estilos (paleta verde/crema/dorado, modo claro y oscuro).
- `app.js` — toda la lógica (estado, validaciones, motor contable, UI, gráficos).
- `data.json` — el Plan de Cuentas del PCGE (1,278 cuentas) y algunos
  asientos de ejemplo. Los registros reales del usuario se guardan en el
  `localStorage` del celular, no aquí.
- `manifest.json` y `sw.js` — hacen que la app se pueda instalar y funcione sin conexión.
- `icons/` — íconos de la app.

## Cómo probarla en su computadora antes de subirla
No se puede abrir `index.html` haciendo doble clic (el navegador bloquea
`fetch()` sobre `file://`). Hay que servirla con un mini-servidor local:

```bash
cd libro-de-caja-pcge
python3 -m http.server 8000
# abrir http://localhost:8000 en el navegador
```

## Cómo subirla a GitHub y publicarla (GitHub Pages)

### Opción A — desde la web de GitHub (sin usar la terminal)
1. Entre a https://github.com y cree un repositorio nuevo (botón verde
   **New**). Nombre sugerido: `libro-de-caja-pcge`. Público. No marque
   "Add a README" (ya tiene uno).
2. Dentro del repositorio recién creado, haga clic en
   **Add file → Upload files**.
3. Arrastre TODOS los archivos y la carpeta `icons/` de esta entrega
   (manteniendo la carpeta `icons` como carpeta).
4. Escriba un mensaje de commit ("Primera versión de la app") y presione
   **Commit changes**.
5. Vaya a la pestaña **Settings** del repositorio → en el menú de la
   izquierda **Pages**.
6. En "Build and deployment" → **Source**, elija **Deploy from a branch**.
7. En **Branch**, elija `main` y la carpeta `/ (root)`. Presione **Save**.
8. Espere 1-2 minutos. GitHub le mostrará la URL pública, algo como:
   `https://SU-USUARIO.github.io/libro-de-caja-pcge/`
9. Abra esa URL desde el celular. En Chrome (Android) aparecerá la opción
   **"Instalar app"** o **"Agregar a pantalla de inicio"**; en Safari
   (iPhone) use el botón Compartir → **"Agregar a pantalla de inicio"**.

### Opción B — con git desde la terminal
```bash
cd libro-de-caja-pcge
git init
git add .
git commit -m "Primera versión de la app"
git branch -M main
git remote add origin https://github.com/SU-USUARIO/libro-de-caja-pcge.git
git push -u origin main
```
Luego repita los pasos 5 a 9 de la Opción A para activar GitHub Pages.

## Actualizar la app más adelante
Cada vez que suba cambios (nuevo `git push` o un nuevo "Upload files"),
suba también el número de `CACHE_VERSION` al inicio de `sw.js` (por
ejemplo de `'v1'` a `'v2'`). Si no lo hace, los celulares que ya instalaron
la app seguirán viendo la versión vieja guardada en caché.

## Versión 2 — identidad "terminal financiero"
Se rediseñó visualmente la app (fondo azul marino oscuro + cyan como único
acento, tipografía sans-serif, barra lateral en pantallas grandes) y se
agregaron: una pestaña **Cuentas** con el Plan de Cuentas expandible por
elemento, un selector Mes/Trimestre/Año en el gráfico principal del Panel,
y una ficha rápida de saldo al escribir un código de cuenta exacto en el
buscador. Ninguna función anterior se quitó. El tema oscuro es ahora el
predeterminado; el botón 🌙/☀️ cambia a una variante clara si se prefiere.

## Versión 3 — editar, duplicar e imprimir
Se agregó, en el Libro Diario, poder **editar** un asiento (vuelve a abrir el
formulario de Registro con los datos cargados; al guardar, actualiza el
mismo asiento en vez de crear uno nuevo) y **duplicarlo** (carga los mismos
datos con la fecha de hoy, listo para revisar y registrar como uno nuevo).
Solo funciona con asientos de 2 líneas — uno con más líneas debe eliminarse
y volver a registrarse. También se agregó un botón 🖨 para imprimir o
exportar a PDF el Libro Diario, el Balance, el Estado de Resultados y el
Estado de Situación Financiera por separado, cada uno con su propia vista
de impresión en blanco y negro. Nada de lo anterior cambió.

## Versión 4 — Plan de Cuentas jerárquico y CSV
El Plan de Cuentas (pestaña Cuentas) ahora es un árbol real de varios niveles
(Elemento → Cuenta → Subcuenta → Divisionaria), con los nombres oficiales del
PCGE en cada nivel intermedio — así, cuentas con nombres repetidos como
"Terceros" quedan claramente ubicadas bajo su grupo real (ej. 69111 Terceros
bajo 69 Costo de ventas > 691 Mercaderías, distinto de 70111 Terceros bajo
70 Ventas). Algunos niveles de 3 dígitos de los elementos 0, 3, 5, 8 y 9 no
tienen nombre oficial transcrito todavía y se muestran solo con su código.

También se agregó **Exportar a CSV / Excel** (además del respaldo .json de
siempre) y la importación ahora acepta tanto .json como .csv — incluyendo
un CSV armado a mano en Excel, siempre que tenga columnas fecha, asiento,
codigo, glosa, debe y haber (en cualquier orden).

## Versión 5 — mejoras para PWABuilder
El registro del Service Worker ahora vive en un `<script>` propio dentro de
`index.html` (antes estaba dentro de `app.js`), porque algunos analizadores
de PWA (como PWABuilder) a veces no lo detectan si está "escondido" dentro
de otro archivo JS. También se agregaron **accesos directos** (shortcuts):
al mantener presionado el ícono de la app instalada, aparecen "Nuevo
registro", "Libro Diario" y "Panel" para abrir esa pestaña directamente.

Si PWABuilder sigue mostrando "Has Service Worker" en rojo después de subir
esta versión, pruebe el botón "Test again" de su sitio — a veces el primer
análisis después de publicar queda en caché. Para confirmarlo usted mismo:
abra su sitio, F12 → pestaña Application → Service Workers, y debe
aparecer "activated and is running".

## Versión 6 — asientos multilínea reales
El formulario de Registro dejó de estar limitado a "1 cuenta + 1 contra-cuenta".
Ahora admite **cualquier cantidad de líneas** (botón "+ Agregar línea"), cada una
con su propia cuenta, y un campo Debe o un campo Haber (nunca los dos a la vez).
Se muestra una **previsualización en vivo** con el total de cada lado y un
indicador "✔ ASIENTO CUADRADO" / "⚠ NO CUADRA · Diferencia S/ ...". El botón
Registrar permanece deshabilitado hasta que Debe = Haber exactamente.

La comparación Debe = Haber se hace en **céntimos enteros** (no en decimales),
así que nunca falla por errores de coma flotante (el clásico 0.1 + 0.2 ≠ 0.3
de JavaScript no afecta a esta app).

Editar y Duplicar ahora funcionan con asientos de cualquier cantidad de
líneas (antes solo con los de 2). El Libro Diario, Balance, Estado de
Resultados, Estado de Situación, Panel, CSV y JSON ya estaban preparados
para esto — no hizo falta tocarlos.

## Versión 7 — Libro Mayor
Nueva pestaña **Mayor**: elija una cuenta (busca por código o nombre, igual
que en Registro) y vea todos sus movimientos ordenados por fecha, con el
**saldo corriendo línea por línea**. Filtros rápidos Hoy / Este mes / Este
año / Todo / Personalizado (con fecha desde-hasta). El "Saldo inicial" que
se muestra es el saldo real acumulado hasta el inicio del rango elegido
(no se resetea a 0 solo porque filtró el mes) — así el Mayor es consistente
con la contabilidad real. Tiene su propio botón 🖨 para imprimir.

## Versión 8 — IndexedDB + Dashboard con KPIs y filtros

**Persistencia (IndexedDB).** Los asientos ya no se guardan en `localStorage`
(que tiene un límite chico, ~5-10 MB) sino en **IndexedDB**, pensado para
mucho más volumen de datos. Todo el acceso pasa por un único módulo `DB`
dentro de `app.js` — el resto de la app nunca toca IndexedDB directamente,
así que el día de mañana se puede reemplazar por una API real sin tocar la
interfaz. `localStorage` queda solo para el tema (claro/oscuro).

**Migración automática.** Si abre esta versión y todavía tenía datos
guardados por una versión anterior de la app, se copian solos a IndexedDB
la primera vez (sin tocar nada, sin perder un registro) y no se repite en
cargas futuras. El dato viejo en `localStorage` NO se borra — queda ahí
como respaldo silencioso.

**Dashboard (pestaña Panel).** Se agregaron 3 indicadores: **Caja y
Bancos**, **Cuentas por cobrar** (cuentas 12 y 13) y **Cuentas por pagar**
(cuentas 42 y 43), más un filtro de fechas (Hoy / Este mes / Este año /
Todo / Personalizado) que ahora afecta tanto a los indicadores como a los
4 gráficos. Los indicadores de balance (Caja, CxC, CxP, Activo, Pasivo,
Patrimonio) se calculan "a la fecha Hasta" — como una foto —; Ingresos,
Gastos y Resultado del periodo son solo lo que se movió dentro del rango
elegido. El Panel también tiene su propio botón de imprimir.

## Versión 9 — filtros en todos los reportes + aviso de actualización

**Fase 18.** Balance, Estado de Resultados y Estado de Situación ahora tienen
el mismo filtro de fechas de Mayor y Panel (Hoy/Todo/Este mes/Este año/
Personalizado), con la misma lógica central y correcta: Balance y Situación
muestran una "foto" a la fecha Hasta; Resultados muestra solo lo que se
movió dentro del rango. Toda la lógica de filtrado vive en dos funciones
compartidas (`inicializarFiltroFecha`, `obtenerRangoFiltro`) — ya no está
repetida en cada pantalla.

**Fase 14 (aviso de actualización).** El Service Worker ya no se reemplaza
solo: cuando hay una versión nueva descargada, se queda esperando y la
app muestra un aviso fijo abajo — "Hay una nueva versión disponible ·
Actualizar" — y recién al presionar ese botón se activa la versión nueva
y la página se recarga sola. Antes de esto, una actualización podía quedar
aplicada sin que el usuario se diera cuenta.

## Versión 10 — importar y reemplazar + estados vacíos accionables

**Fase 7.** Al importar un respaldo (.json o .csv) ahora aparece un diálogo
con el resumen de lo que trae el archivo y 3 opciones: **Combinar** con lo
que ya tiene (comportamiento de antes), **Reemplazar todo** (borra lo
actual y deja solo lo del archivo, con una confirmación extra por ser
destructivo) o Cancelar. El reemplazo también pasa por `sanitizeAsientos`
y queda guardado en IndexedDB igual que cualquier otro cambio.

**Fase 17.** Los estados vacíos de Libro Diario y Balance de Comprobación
ahora tienen un botón "+ Registrar operación" que lleva directo al
formulario, en vez de ser solo un texto.

## Versión 11 — auditoría de accesibilidad, rendimiento y buenas prácticas

No se pudo correr Lighthouse en sí (sin acceso a internet para instalarlo
en este entorno), así que se auditó con las mismas APIs de Chrome en las
que se basa Lighthouse (árbol de accesibilidad, contraste de color
compuesto con alfa real, Performance API). Resultados y correcciones:

- **Corregido:** 7 campos sin etiqueta accesible (buscador del encabezado,
  los 3 campos de cada línea del asiento) — ahora tienen `aria-label`.
- **Corregido:** el buscador del encabezado no mostraba ningún cambio
  visual al enfocarlo con teclado — ahora el borde se ilumina en cyan.
- **Verificado sin problemas:** contraste de color en 15+ combinaciones de
  texto/fondo (todas ≥ 4.5:1), jerarquía de encabezados, todos los botones
  con nombre accesible, 0 mensajes en consola (de cualquier tipo, no solo
  errores) navegando toda la app, DOM liviano (420 nodos), carga total
  ~198 KB, manifest/Service Worker/offline/instalable sin cambios.

## Datos y respaldo
- Los registros del usuario viven únicamente en el `localStorage` de su
  celular/navegador — no se envían a ningún servidor.
- El botón **Exportar respaldo (.json)** descarga todos los asientos; **Exportar a CSV / Excel** hace lo mismo en formato de hoja de cálculo.
- El botón **Importar respaldo** acepta .json o .csv y los vuelve a cargar (útil al cambiar de
  equipo o formatear). Los asientos importados se renumeran para no chocar
  con los que ya existan.

## Límite conocido
GitHub Pages es un hosting de archivos estáticos: no hay usuarios ni base
de datos compartida. Cada celular tiene su propio respaldo local. Si en el
futuro quiere sincronizar entre varios dispositivos, se necesitaría un
backend (por ejemplo Firebase) — esta versión no lo incluye.
