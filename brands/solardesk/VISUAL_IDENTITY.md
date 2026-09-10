# SolarDesk — Identidad visual

**Estado:** Documento de referencia visual para AlexAgent v0.2 (futuro Asset Engine). No implementa generación de assets. No sustituye ni modifica `BRAND.md`.
**Actualizado:** 2026-09-09
**Responsable:** Alex Sosa
**Agente:** AlexAgent, sujeto a `AGENT.md` y a `BRAND.md`.

Este documento describe únicamente lo que puede verificarse a partir del material visual disponible: los logos oficiales, las capturas reales del producto y las referencias de marketing en `brands/solardesk/assets/`, más el código fuente del repositorio local de SolarDesk (`~/Projects/SolarDesk`, disponible en este entorno). Donde no hay evidencia suficiente, el documento describe la característica en términos generales en vez de inventar un valor exacto.

---

## 1. Jerarquía de fuentes visuales y autoridad

| Fuente | Autoridad sobre |
| --- | --- |
| `assets/logos/` | Identidad del logo: forma, color, proporciones, variantes disponibles. |
| `assets/product-screenshots/` | Apariencia actual real de la interfaz del producto. |
| `assets/references/` | Inspiración estética y de composición únicamente. |
| `BRAND.md` | Product Truth: capacidades, límites, modelo comercial, precios, mensajes autorizados y restricciones de veracidad. |

Reglas de precedencia:

- Los logos oficiales definen la identidad del logo. Ninguna otra fuente puede alterarla.
- Las capturas reales del producto son la autoridad sobre cómo se ve la interfaz hoy.
- Las referencias de marketing (`references/`) son inspiración estética/compositiva únicamente. No son evidencia de funcionalidad ni de mensajes aprobados.
- `BRAND.md` controla Product Truth, capacidades, hechos comerciales, precios, reclamos y restricciones de mensaje. Este documento no la reemplaza ni la contradice; ante cualquier conflicto, `BRAND.md` prevalece para hechos de producto y este documento prevalece solo para tratamiento visual.

> **Las referencias visuales nunca deben usarse como evidencia de Product Truth.**

Una captura o pieza visual puede contener precios, promociones, métricas o datos de cliente visibles en el momento en que se tomó. Esos valores visuales no se convierten automáticamente en reclamos de marketing aprobados: cualquier precio, cifra o capacidad que se quiera comunicar debe verificarse contra `BRAND.md` (o reconfirmarse con Alex) antes de usarse, sin importar si aparece "visible" en una captura o en una pieza de referencia.

---

## 2. Identidad visual central

### Colores

Verificados directamente en el código fuente del producto real (`~/Projects/SolarDesk/src/app/globals.css`), y consistentes con lo ya documentado en `BRAND.md`:

| Rol | Valor verificado |
| --- | --- |
| Navy (primario) | `#0F172A` |
| Navy secundario | `#334155` |
| Ámbar (acento) | `#F59E0B` |
| Gris claro | `#E5E7EB` |
| Blanco | `#FFFFFF` |

El navy funciona como color dominante de marca (sidebar, texto principal, botones primarios). El ámbar funciona como acento de énfasis y llamada a la acción (parte del wordmark, botones de conversión como "Actualizar a PRO", iconografía destacada).

Observado adicionalmente en capturas reales del producto, sin confirmación de un valor hexadecimal exacto — no inventar uno:

- Un tono verde para estados positivos/activos (por ejemplo, la etiqueta "Activo" de un cliente, el contador "Aprobadas").
- Un tono rojo para acciones destructivas (por ejemplo, "Eliminar").
- Un tono azul/violeta para acciones de envío o estados "en revisión" (por ejemplo, el botón "Enviar" y la tarjeta "En revisión").
- Un tono amarillo/ámbar suave como fondo de tarjeta para destacar cifras financieras (por ejemplo, "Ahorro anual estimado").

Estos son colores de estado de la interfaz observados en capturas reales, no necesariamente parte de la paleta de marca central de cinco colores. Tratarlos como convención de UI verificada, no como identidad de marca a reproducir en piezas de marketing salvo que se esté recreando la interfaz real.

### Tipografía

Verificada directamente en el código fuente: **Inter**, con system-ui / -apple-system / sans-serif como respaldo. Esto confirma con certeza lo que `BRAND.md` ya proponía como referencia ("Inter o una sans serif similar").

### Jerarquía visual y tono general

Observado de forma consistente en las nueve capturas reales revisadas:

- Títulos de página en negrita, tamaño grande, navy sobre fondo claro.
- Subtítulos/descripciones cortas en gris medio, peso regular, directamente debajo del título.
- Micro-etiquetas de sección en mayúsculas con tracking amplio (p. ej. "EMPRESA", "CONTACTO", "PLAN ACTUAL", "HISTORIAL DE PAGOS") para dividir formularios y paneles largos.
- Texto de marcador de posición (placeholder) en gris claro dentro de los campos.
- Tono general: profesional, técnico, ordenado — coherente con el tono de voz ya documentado en `BRAND.md` ("profesional, práctica, cercana").

### Espaciado y layout

- Patrón de shell de aplicación consistente en todas las capturas: barra lateral fija en navy oscuro con navegación e identidad del usuario, área de contenido principal en blanco/gris muy claro.
- El contenido principal se organiza en tarjetas (cards) de esquinas redondeadas con borde delgado y claro, generalmente agrupadas en una grilla de 2 a 4 columnas para métricas rápidas.
- Tablas de datos con encabezados en mayúsculas pequeñas, filas separadas por líneas divisorias sutiles, sin rejillas pesadas.
- Espaciado generoso; la interfaz evita saturación visual.

### Tratamiento de bordes/tarjetas/botones

- Tarjetas: esquinas redondeadas, borde de 1px en gris claro, sombra mínima o ausente.
- Botón primario: relleno sólido en navy (acciones estándar) o en ámbar (llamadas de conversión de alto valor, como actualizar a PRO).
- Botón secundario: borde delgado, fondo blanco.
- Acción destructiva: texto/botón en rojo, sin relleno pesado.
- Insignias de estado (badges): forma de píldora, fondo de color suave con texto del mismo tono en versión oscura (por ejemplo, "Activo" en verde suave, "FREE" en gris neutro).

### Estilo de imágenes solares/energía

Observado únicamente en las referencias de marketing. Las nueve capturas reales revisadas no incluyen la vista de detalle de una propuesta ni su PDF generado, así que no hay evidencia directa de si esas vistas incluyen fotografía de paneles; no asumir ausencia ni presencia de ese estilo dentro del producto real sin verificarlo:

- Fotografía realista de paneles solares en tejados residenciales, a menudo con luz cálida de atardecer/amanecer.
- Elementos de oficio/técnicos como props (casco de obra, planos, calculadora) para reforzar el tono profesional/instalador.
- Mockups de laptop/teléfono mostrando una interfaz de producto para anclar la propuesta de valor a la plataforma real.

---

## 3. Reglas del logo

- Los archivos de logo oficiales (`assets/logos/logo.png`, `logo_v.png`, `logo_white.png`) deben reutilizarse directamente, tal como existen. El logo **no debe** ser regenerado, redibujado, aproximado o alterado por IA generativa bajo ninguna circunstancia.
- Deben preservarse las proporciones originales del archivo; no deformar, estirar ni recortar el ícono de forma que pierda su forma reconocible.
- Debe mantenerse contraste adecuado y espacio de protección (clear space) alrededor del logo frente a fondos de imagen o color.
- Variantes disponibles observadas, para seleccionar según el fondo real de cada pieza (verificar contraste en cada caso, no asumirlo solo por el nombre del archivo):
  - `logo.png`: lockup horizontal ancho; el texto "Solar" se renderiza en un tono claro/transparente, por lo que este archivo es apto para fondos oscuros o de color, no para fondos blancos.
  - `logo_v.png`: lockup apilado/cuadrado sobre fondo navy sólido, con ícono circular completo (anillo + cuarto de sol en ámbar + rayo). Pensado para fondos oscuros.
  - `logo_white.png`: lockup horizontal con el texto "Solar" en navy oscuro; a pesar de su nombre de archivo, es apto para fondos claros/blancos, no para fondos oscuros.
- No se documentan variantes adicionales (por ejemplo, versión solo-ícono aislada, o una versión monocromática pura) porque no hay un archivo verificado que las represente. No inventar una variante que no exista en `assets/logos/`.

---

## 4. Reglas de capturas de producto

- Cuando una pieza de marketing demuestre funcionalidad real de SolarDesk, deben preferirse capturas reales (`assets/product-screenshots/`) sobre una recreación.
- Las capturas **no deben** ser recreadas por IA generativa. La funcionalidad de la interfaz no debe inventarse visualmente (no agregar secciones, métricas, botones o flujos que no existan en la captura real).
- Las capturas pueden recortarse, enmarcarse o componerse dentro de un layout de marketing (por ejemplo, dentro de un mockup de laptop) siempre que no se falsifique materialmente la interfaz mostrada.
- Las nueve capturas disponibles corresponden a una cuenta de prueba personal en el plan Free, con datos ficticios/de prueba visibles (por ejemplo, nombres de cliente como "John Doe", "Daniela Porras", cuenta de usuario "Pepito Perez"). Estos datos deben revisarse antes de cualquier uso público: no deben presentarse como clientes reales, y de ser necesario deben cubrirse, recortarse o sustituirse por un ejemplo explícitamente identificado como demostración, conforme a lo ya establecido en `BRAND.md`.
- Cualquier precio, promoción o métrica visible dentro de una captura (por ejemplo, el precio de PRO mostrado en la pantalla de suscripción) no es automáticamente un reclamo de marketing autorizado: debe verificarse contra `BRAND.md` antes de reutilizarse como mensaje público.
- Cuando el producto mismo es el sujeto de la pieza (una demostración de funcionalidad), la captura debe permanecer legible: evitar recortes o superposiciones que hagan ilegible el texto o la estructura de la interfaz que se está demostrando.

---

## 5. Reglas de referencias de marketing

Las dos referencias disponibles (`Camp_01.png`, `portada.png`) se analizan como precedentes visuales, no como plantillas obligatorias.

Características de composición reutilizables observadas en ambas:

- Layout dividido: un bloque de texto/identidad (a menudo sobre un panel navy angulado o sólido) junto a una escena fotográfica o un mockup de producto.
- Titular corto y contundente (2–4 palabras), en navy con una palabra o línea de énfasis en ámbar; en `Camp_01.png` el énfasis se refuerza con una línea/subrayado ámbar.
- El lockup del logo (variante sobre fondo navy) aparece como ancla de marca dentro de la pieza, no solo en una esquina pequeña.
- Fotografía de paneles solares en tejados, con luz cálida, para transmitir el contexto de energía solar residencial/comercial.
- Presentación de producto vía mockup de laptop/teléfono mostrando una interfaz, junto con una simulación de PDF de propuesta con foto de techo, íconos de métricas (kWp, kWh, ahorro, CO₂) y un resumen financiero.
- Fila de iconos + etiqueta corta para comunicar beneficios clave (visto en `portada.png`: "Cálculos precisos", "Propuestas profesionales", "Sistemas eficientes", "Todo en la nube"), en tono ámbar.
- Props/tono profesional y técnico (casco, planos, calculadora) que refuerzan la audiencia de instaladores/ingenieros.

Limitación importante, verificada por comparación directa con las capturas reales del producto:

- Las interfaces mostradas dentro de ambas referencias son **conceptuales o históricas**, no el producto actual. Por ejemplo, muestran elementos de navegación ("Proyectos", "Plantillas"), una gráfica de "Cotizaciones por mes" y una "Tasa de conversión", y datos de clientes/negociaciones (nombres, montos, estados) que no aparecen en ninguna de las nueve capturas reales verificadas y que no están confirmados como funcionalidad actual en `BRAND.md`.
- Ninguna cifra, nombre de cliente, funcionalidad de interfaz o eslogan visible dentro de estas referencias (por ejemplo, "Tus propuestas también venden.", "Tu energía, tu futuro. Nosotros lo hacemos posible.", "Cotiza. Diseña. Impulsa.") debe tratarse como mensaje aprobado, funcionalidad confirmada o dato real. Los CTA autorizados siguen siendo los ya definidos en `BRAND.md` ("Comenzar gratis", "Crea tu primera cotización", "Comparte tu propuesta", "Conoce SolarDesk PRO") salvo que Alex apruebe explícitamente uno nuevo.
- Ninguna de las dos imágenes es una plantilla obligatoria. Sirven para inspirar composición y tono, no para clonarse pieza por pieza.

---

## 6. Lineamientos para un futuro Asset Engine

Sin implementar el motor, estos son los principios visuales que debería seguir cuando se construya:

- Preferir renderizado determinístico (no generativo) para texto exacto, logos, capturas de producto, copy de CTA y elementos de layout de marca — cualquier cosa donde la exactitud importa debe componerse, no "imaginarse".
- La imaginería generativa puede usarse más adelante para elementos de soporte: fondos, escenas ambientales, ilustraciones o elementos creativos decorativos — nunca para el contenido que debe ser exacto.
- La IA generativa no debe usarse para renderizar el logo exacto de SolarDesk, la interfaz exacta del producto, textos importantes, precios o información factual del producto. Estos elementos deben provenir de los assets oficiales o de datos verificados, nunca "aproximarse" generativamente.
- Los carruseles (carousels) deben mantener una identidad visual coherente entre slides (misma paleta, tipografía y tono), no un collage de estilos inconsistentes.
- Debe permitirse variación creativa dentro del sistema de marca, en vez de forzar cada pieza al mismo template fijo — coherencia de marca no significa uniformidad rígida de layout.

---

## Fuentes

- `brands/solardesk/assets/logos/logo.png`, `logo_v.png`, `logo_white.png` — inspeccionados directamente, 2026-09-09.
- `brands/solardesk/assets/product-screenshots/01.png` a `09.png` (nueve capturas) — inspeccionadas directamente, 2026-09-09. Corresponden a una cuenta de prueba personal en plan Free.
- `brands/solardesk/assets/references/Camp_01.png`, `portada.png` — inspeccionadas directamente, 2026-09-09.
- `~/Projects/SolarDesk/src/app/globals.css` — código fuente real del producto, disponible localmente en este entorno; inspeccionado únicamente para confirmar tokens de color y familia tipográfica. No se inspeccionaron ni modificaron archivos de configuración, variables de entorno, base de datos o backups de ese repositorio, ninguno de los cuales es relevante para identidad visual.
- `brands/solardesk/BRAND.md` — revisado como fuente de Product Truth; no fue modificado por este documento.

No se agregó ningún hecho de producto nuevo a `BRAND.md` a partir de este material visual. Cuando el material visual sugiere una posible funcionalidad no confirmada en `BRAND.md` (por ejemplo, las interfaces conceptuales de las referencias de marketing), este documento lo señala como límite de la referencia, no como hecho verificado.
