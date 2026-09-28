# wow-noticias-es

Publica automáticamente en un canal de Discord las noticias nuevas de
[World of Warcraft (es-MX)](https://worldofwarcraft.blizzard.com/es-mx/news).
Usa un **webhook**, así que no hay bot ni servidor 24/7: corre con GitHub Actions
cada 20 minutos.

## Qué hace

1. Lee **solo la primera página** del listado de noticias. Los datos salen del
   JSON que la página trae embebido (`<script id="model">`).
2. Usa el **id numérico** de cada artículo (`/news/{id}/{slug}`) como clave única.
3. Por cada noticia nueva entra al artículo y toma título, resumen, `og:image`,
   URL y, si existe, el hilo en `us.forums.blizzard.com/es/wow` ("Comentar en los foros").
4. Publica un embed con:
   - título con link;
   - resumen de hasta 300 caracteres;
   - imagen grande;
   - fecha;
   - footer "Blizzard Entertainment • Fuente oficial".

   El color depende del título:

   | Título contiene            | Color     |
   |----------------------------|-----------|
   | Hotfixes                   | `#ED4245` |
   | Notas de la actualización  | `#E67E22` |
   | Resumen semanal            | `#F0B132` |
   | (resto)                    | `#5865F2` |

5. Publica de la noticia **más vieja a la más nueva**: como máximo 5 por
   ejecución, con 2 s entre mensajes, y respeta los `429` de Discord (`retry_after`).
6. Guarda en `state.json` los ids ya publicados (los últimos 300). Un id se marca
   como publicado **solo si Discord respondió OK**.

### Primera ejecución (modo SEED)

Si `state.json` no existe, se registran todos los ids actuales y se publica
**solo la noticia más reciente**. El historial viejo nunca se publica.

### Errores

Si la página falla o devuelve 0 artículos, el estado no se toca y el job
termina con error, así que GitHub te avisa por mail. Si falla una publicación
en Discord, se guarda el resto y esa noticia se reintenta en la próxima ejecución.

## Configuración

| Nombre                 | Tipo (en GitHub) | Obligatorio | Descripción |
|------------------------|------------------|-------------|-------------|
| `DISCORD_WEBHOOK_NEWS` | Secret           | Sí          | URL del webhook del canal. |
| `DISCORD_ROLE_ID`      | Secret           | No          | ID del rol a mencionar. Si está vacío, no se menciona a nadie. |
| `DISCORD_AVATAR_URL`   | Variable         | No          | URL de la imagen de avatar del webhook. |
| `EXCLUDE_PATCH_NOTES`  | Variable         | No          | `true` para no publicar artículos cuyo título empiece con "Hotfixes" o "Notas de la actualización". Default `false`. |

Los secrets se cargan en **Settings → Secrets and variables → Actions → Secrets**
y las variables en la pestaña **Variables** de esa misma pantalla.

### Cómo crear el webhook

1. En Discord, andá al canal → **Editar canal** → **Integraciones** → **Webhooks**.
2. **Nuevo webhook**, poné un nombre y **Copiar URL del webhook**.
3. Para el ID del rol: en **Ajustes de usuario → Avanzado**, activá el **Modo desarrollador**.
   Después andá a **Ajustes del servidor → Roles**, hacé clic derecho en el rol y elegí **Copiar ID del rol**.

### Cómo actualizar los secrets

Editá el `.env` local (nunca se commitea) y corré:

```bash
gh secret set -f .env
```

También podés cargar uno solo sin que quede en el historial de la terminal:

```bash
gh secret set DISCORD_WEBHOOK_NEWS
```

(`gh` te pide el valor de forma interactiva). Para las variables opcionales:

```bash
gh variable set EXCLUDE_PATCH_NOTES --body true
gh variable set DISCORD_AVATAR_URL --body "https://…/avatar.png"
```

## Forzar un nuevo seed

Borrá `state.json` del repo. La próxima ejecución registra todo lo actual y
publica solo la noticia más reciente:

```bash
git rm state.json
git commit -m "Forzar nuevo seed"
git push
gh workflow run news.yml
```

## Probar localmente

Requiere Node.js 20.6 o superior. No hay dependencias que instalar.

1. Creá un `.env` en la raíz:
   ```
   DISCORD_WEBHOOK_NEWS=https://discord.com/api/webhooks/...
   DISCORD_ROLE_ID=
   ```
2. Ver qué publicaría, sin mandar nada ni tocar `state.json`:
   ```bash
   npm run dry-run
   ```
3. Publicar de verdad:
   ```bash
   npm run local
   ```
   Si no existe `state.json`, entra en modo SEED y publica una sola noticia.
   **Borrá el `state.json` local después** si no querés commitearlo.

## Ejecutar el workflow a mano

```bash
gh workflow run news.yml
gh run watch
```

> Nota: GitHub desactiva los workflows programados de repos sin actividad
> durante 60 días. Los commits de `state.json` cuentan como actividad, pero si
> pasa mucho tiempo sin noticias nuevas puede que tengas que reactivarlo desde
> la pestaña **Actions**.
