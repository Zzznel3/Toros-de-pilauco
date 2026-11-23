# Toros de Pilauco · Página del equipo

Página del Club Deportivo Toros de Pilauco (rama de básquetbol): plantel, ligas, arbitraje, inscripciones, pagos y camisetas.

Cualquiera con el enlace puede **ver** la página. Para **editar** (marcar pagos, agregar jugadores, ligas o camisetas, prestar camisetas) hay que tocar **"Ingresar para editar"** en el encabezado y escribir la clave de editor.

## Cómo publicarla en Vercel (una sola vez)

1. **Sube esta carpeta a GitHub.** Crea un repositorio vacío en github.com (por ejemplo `toros-de-pilauco`) y, desde esta carpeta:
   ```
   git remote add origin https://github.com/TU-USUARIO/toros-de-pilauco.git
   git push -u origin main
   ```
2. **Importa el proyecto en Vercel.** En vercel.com: *Add New… → Project → Import* el repositorio. En *Framework Preset* deja **Other** y toca **Deploy**.
3. **Crea la base de datos.** En el proyecto de Vercel: pestaña **Storage → Create Database → Upstash (Redis)** (plan gratuito) → **Connect** al proyecto. Vercel agrega solas las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN`.
4. **Define la clave de editor.** *Settings → Environment Variables*: agrega `CLAVE_EDITOR` con la clave que quieras (para Production y Preview).
5. **Vuelve a publicar.** Pestaña *Deployments* → en el último, menú **⋯ → Redeploy**, para que tome la base de datos y la clave.

La primera vez que se abre, la página copia a la base de datos lo que ya estaba editado en la versión de Claude (Jose (nuevo), la Liga de Galvarino Verano y el ajuste de la Liga Galvarino).

Después, cada vez que subas un cambio a GitHub (`git push`), Vercel publica la nueva versión sola. Los datos editados en la página quedan en la base de datos y no se pierden al publicar.

## Qué hay en la carpeta

| Archivo | Qué es |
|---|---|
| `index.html` | La página: estilos con los colores del club, pestañas y toda la lógica de jugadores, ligas, pagos y camisetas. |
| `runtime.js` | Carga los datos, hace los cálculos y dibuja la página; guarda los cambios y maneja la clave de editor. |
| `base.css` | Tamaños, fuentes (Inter y Oswald) y controles base. |
| `datos/*.json` | Datos copiados de la planilla de Google (arbitraje, ligas, inscripción, camisetas). |
| `img/escudo.png` | Escudo del club. |
| `api/estado.js` | Devuelve lo editado desde la página (lectura pública). |
| `api/escribir.js` | Guarda o borra un cambio. Exige la clave de editor. |
| `api/login.js` | Comprueba la clave de editor. |
| `api/_redis.js` | Conexión a la base de datos Redis. |
| `api/_semilla.js` | Datos iniciales copiados desde la página de Claude. |

## Para tener en cuenta

- La página es **pública**: quien tenga el enlace ve quién debe y cuánto.
- La clave de editor queda guardada en el navegador de quien la ingresó hasta que toque **Salir**.
- Para cambiar la clave: edita `CLAVE_EDITOR` en Vercel y vuelve a publicar. Los editores tendrán que ingresarla de nuevo.
- Los datos de la planilla (`datos/*.json`) son una copia del 23 de noviembre de 2026. Si cambias la planilla de Google y quieres traer esos cambios, hay que actualizar esos archivos.
