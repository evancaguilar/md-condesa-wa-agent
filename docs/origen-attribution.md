# Origen de alumnos — «¿cómo nos encontraste?» vs «¿viste anuncio?»

Construido 2026-09-10. Objetivo: para cada alumno que pagó desde 2026-08-01 y para cada alumno nuevo, saber **si vio un anuncio de Meta** antes de inscribirse, y registrarlo en Airtable para que las métricas de marketing (docs/marketing-metrics.md) puedan acreditar anuncios.

Dos preguntas distintas, dos campos distintos:

| Pregunta | Campo en Leads | Valores |
|---|---|---|
| ¿Cómo nos encontraste? (primer contacto) | `Adquisición` (single select, ya existía) | Pagado / Orgánico / Referido / Local |
| ¿Viste alguno de nuestros anuncios en Facebook/Instagram antes de inscribirte? (influencia) | `Vio anuncio` (multi select, **nuevo**, `fldFUeHCs1fyEZrSX`) | Sí, vio anuncio en Facebook/Instagram · No vio anuncio · No respondió |

Alguien puede habernos encontrado en Google o pasando por la academia **y además** haber visto anuncios. Por eso la fórmula `Origen` (`fldpEANJ9FH8XwRH2`) ahora cuenta como **Pagado** cualquiera de: `Ad` con id de Meta, `Adquisición = Pagado`, o `Vio anuncio` contiene «Sí». Lo demás no cambió (Orgánico por Adquisición/Canal; si no hay evidencia, Desconocido).

## Parte 1 — Backlog: pregunta por WhatsApp (toque y envía)

### Qué hay en Airtable (hecho)

- **Leads · `Vio anuncio`** (multi select) — arriba.
- **Leads · `WA Pregunta Origen`** (fórmula, `fldNzouVkSCdrSt4M`): link `wa.me` con el mensaje prellenado. Mismo patrón que «WhatsApp Link con Mensaje de Seguimiento»: quita todo lo que no sea dígito de `# de Teléfono`, antepone `52` si quedan 10 dígitos; vacío si no hay teléfono. Saluda por `Primer Nombre`. Texto:

  > ¡Hola {Primer Nombre}! Te escribimos de MD Condesa 🥋 Una pregunta rapidita que nos ayuda muchísimo:
  >
  > 1) ¿Cómo nos encontraste? Google / recomendación / pasaste por la academia / redes sociales / otro
  > 2) ¿Viste alguno de nuestros anuncios en Facebook o Instagram antes de inscribirte? Sí / No
  >
  > Con dos palabras basta, por ejemplo: «Google, sí». ¡Gracias!

- **Leads · `Origen`** actualizado (ver arriba).
- **Responsivas · `Cómo nos encontraste`** (multi select, `fldd7Mx2WU4B7N0Rz`) y **`Vio anuncio redes`** (single select Sí/No, `fldKxHZmfOau3EG1b`) — para la Parte 2.

### Vista «Origen pendiente» (pendiente Evan — el MCP no crea vistas)

En la tabla **Leads**, crear vista grid `Origen pendiente`:

- Filtros (todos): `Cerró` = 1 · `Origen` = Desconocido · `Fecha de Creación` es en o después de 2026-08-01.
- Orden: `Ingresos Lead` descendente.
- Columnas visibles, en este orden: `Nombre de Lead`, `# de Teléfono`, `Ingresos Lead`, `WA Pregunta Origen`, `Adquisición`, `Vio anuncio`, `Notas`. Ocultar el resto.

Al 2026-09-10 esa combinación da **20 leads** (el de mayor ingreso: 8,485). Tres no tienen teléfono (el link sale vacío): buscarlos en Alumnos o preguntar en persona.

Cuando la vista exista, añadirla a la interfaz **📊 Dashboard General → ⚠️ Excepciones** (`pbdK1hg3OTh7f1ctD` → `pagHNXtQQX41Dt35A`) como una sección grid de Leads con los mismos filtros/columnas, título «Origen pendiente» (el MCP tampoco edita páginas existentes). El bloque «Cierres sin origen» que ya está en esa página es el contador de esta misma lista.

### Instrucción para el equipo (pegar en Slack #wa-leads)

> **Origen pendiente — 5 pasos**
> 1. Abre la vista **Origen pendiente** en Leads (o la sección en ⚠️ Excepciones): son alumnos que pagaron y no sabemos de dónde vinieron.
> 2. Toca el link de **WA Pregunta Origen** → se abre WhatsApp con el mensaje listo → **Enviar** (no cambies el texto).
> 3. Cuando conteste, registra las **dos** respuestas: **Adquisición** = cómo nos encontró (Google/redes/otro → Orgánico · recomendación → Referido · pasó por la academia → Local · «por un anuncio» → Pagado) y **Vio anuncio** = Sí / No.
> 4. Si en 3 días no contesta, pon **Vio anuncio = No respondió** y déjalo; si sabes el origen por otra vía, pon Adquisición.
> 5. El lead sale de la vista solo cuando Origen deja de ser Desconocido (Adquisición o Vio anuncio = Sí). No borres nada.

## Parte 2 — La responsiva digital lo pregunta al inscribirse

La app **https://responsiva.mdcondesa.com** (repo aparte en la Mac de Evan; no es este repo ni md-condesa-site) escribe una fila en **Responsivas** por firma y vincula `Lead` (`fldriv7wmtJwq7npI`) y `Alumno` (`fldDaNfepq0N212o3`) desde su worker (`/submit`). Esta sesión corre en la nube y **no tiene acceso a ese repo**, así que la parte Airtable quedó lista y la parte del formulario está especificada aquí para hacerla desde la Mac.

### Airtable (hecho)

1. Dos campos nuevos en Responsivas (arriba).
2. Automatización **«Responsiva recibida»** (`wflfYZstKrvFxfrvV`) — **borrador v3, pendiente de publicar (abrir → Update)**. Se añadió un tercer paso (script) DESPUÉS del correo, para que un fallo nunca bloquee el comprobante. Lee `Cómo nos encontraste` + `Vio anuncio redes` de la responsiva y escribe en el/los Lead vinculados:
   - `Vio anuncio` ← Sí → «Sí, vio anuncio en Facebook/Instagram»; No → «No vio anuncio».
   - `Adquisición` ← **Pagado** si marcó «Anuncio en Facebook o Instagram» **o** contestó Sí; si no: **Referido** (recomendación) > **Local** (pasé por la academia) > **Orgánico** (Google / Instagram o Facebook orgánico / Otro).
   - Nunca degrada un `Adquisición = Pagado` existente; si la responsiva no trae respuestas (formulario viejo o sin Lead vinculado), no escribe nada y lo deja en el log.

   Elegí la automatización y no una escritura del worker de la responsiva porque (a) es lo que el usuario ofreció como opción, (b) el repo del worker no está accesible desde aquí, y (c) así el worker solo necesita escribir dos campos más. Si prefieres que lo haga el worker en `/submit`, la regla de mapeo es la misma; entonces hay que quitar el paso de la automatización para no escribir dos veces.

### Cambio en el repo de la responsiva (pendiente, hacer desde la Mac)

`grep -rl "responsiva.mdcondesa" ~` para encontrar el repo. Mantener el formulario igual de corto: **dos toques extra**, nada más. No tocar los formularios de reserva.

- (a) Obligatorio, marca todas las que apliquen — **«¿Cómo nos encontraste?»**: Google · Recomendación de un amigo o familiar · Pasé por la academia · Instagram o Facebook (orgánico) · Anuncio en Facebook o Instagram · Otro. Los nombres deben coincidir **exactamente** con las opciones de `fldd7Mx2WU4B7N0Rz` (Airtable rechaza opciones desconocidas sin `typecast`).
- (b) Obligatorio, Sí/No — **«¿Viste alguno de nuestros anuncios en redes sociales antes de venir?»** → `fldKxHZmfOau3EG1b` («Sí» / «No»).
- En el POST a Airtable del `/submit`, añadir a la fila de Responsivas: `"fldd7Mx2WU4B7N0Rz": ["Google", "Anuncio en Facebook o Instagram"]` (array de nombres) y `"fldKxHZmfOau3EG1b": "Sí"`. Escribir por field id, no por nombre. Incluirlos también en la versión en inglés de la UI si existe (`Idioma`), pero los valores guardados van siempre en español.
- Validación: bloquear el envío si (a) está vacío o (b) no está contestado; el texto firmado/hash **no** debe incluir estas respuestas (no forman parte del documento vinculante).
- Verificación local: previsualizar, firmar una responsiva de prueba contra la base, comprobar en Airtable que la fila trae los dos campos y que, tras publicar la automatización, el Lead vinculado recibe `Adquisición` + `Vio anuncio`. Deploy solo cuando Evan lo diga.

## Rollback

Todo lo hecho en Airtable es aditivo: dos campos nuevos en Leads, dos en Responsivas, una fórmula editada (`Origen`; la versión anterior está en docs/marketing-metrics.md §2 y en el historial del campo) y un borrador de automatización (revertir = quitar el tercer paso antes de publicar, o no publicar).
