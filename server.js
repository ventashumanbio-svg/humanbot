// =============================================
// BOHUMAN BIO — BOT DE LLAMADAS AUTOMÁTICAS
// Twilio Voice + Claude IA
// =============================================
const express  = require('express');
const twilio   = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const cors     = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── Clientes ──────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Estado en memoria ─────────────────────────
const llamadasPendientes = new Map(); // callSid → datos del prospecto
let resultados = [];

// ── Helpers ───────────────────────────────────
function limpiarNumero(tel) {
  let n = String(tel || '').replace(/\D/g, '');
  if (n.startsWith('52') && n.length > 10) n = n.slice(2);
  return '+52' + n;
}

async function generarMensajeVoz(prospecto) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 220,
      messages: [{
        role: 'user',
        content: `Genera un mensaje de voz de prospectación telefónica para Bohuman Bio, distribuidora de plásticos desechables para alimentos en México (vasos, platos, contenedores, cubiertos, popotes, bolsas, charolas).

Prospecto: ${prospecto.nombre} (${prospecto.tipo || 'negocio de alimentos'})
${prospecto.contacto ? 'Contacto: ' + prospecto.contacto : ''}
${prospecto.prods ? 'Productos de interés: ' + prospecto.prods : ''}
Objetivo: ${prospecto.objetivo || 'primer contacto y generar interés'}

REGLAS IMPORTANTES:
- Máximo 4 oraciones cortas, muy conciso porque es audio de teléfono
- Español mexicano natural, amigable y profesional
- SIEMPRE termina con exactamente esta frase: "Si le interesa recibir más información presione uno. Si prefiere que no le llamemos presione dos."
- Sin emojis, sin asteriscos, sin signos especiales
- No uses paréntesis ni comillas`
      }]
    });
    return res.content[0].text.trim();
  } catch {
    return `Hola, buen día. Le llama un asesor de Bohuman Bio, distribuidora de productos desechables para alimentos. Contamos con vasos, contenedores y cubiertos de alta calidad a precios de mayoreo para restaurantes y negocios como el suyo. Si le interesa recibir más información presione uno. Si prefiere que no le llamemos presione dos.`;
  }
}

// ─────────────────────────────────────────────
// RUTA 1 — Iniciar llamada
// POST /llamar  { nombre, tipo, tel, objetivo, prods, contacto }
// ─────────────────────────────────────────────
app.post('/llamar', async (req, res) => {
  const { nombre, tipo, tel, objetivo, prods, contacto } = req.body;
  if (!tel) return res.status(400).json({ error: 'El campo tel es obligatorio' });

  const numero = limpiarNumero(tel);
  const serverUrl = process.env.SERVER_URL;

  try {
    const call = await twilioClient.calls.create({
      to:                   numero,
      from:                 process.env.TWILIO_PHONE_NUMBER,
      url:                  `${serverUrl}/twiml/saludo`,
      method:               'POST',
      statusCallback:       `${serverUrl}/twiml/estado`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent:  ['completed', 'no-answer', 'busy', 'failed', 'canceled'],
    });

    llamadasPendientes.set(call.sid, { nombre, tipo, tel: numero, objetivo, prods, contacto });

    console.log(`📞 Llamada iniciada → ${numero} (${nombre}) SID: ${call.sid}`);
    res.json({ ok: true, callSid: call.sid, numero });
  } catch (err) {
    console.error('Error Twilio:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// RUTA 2 — Llamada campanas en masa
// POST /llamar-lista  { prospectos: [{nombre,tipo,tel,...}], intervalo_seg }
// ─────────────────────────────────────────────
app.post('/llamar-lista', async (req, res) => {
  const { prospectos = [], intervalo_seg = 30 } = req.body;
  if (!prospectos.length) return res.status(400).json({ error: 'Lista vacía' });

  res.json({ ok: true, total: prospectos.length, mensaje: 'Campaña iniciada' });

  // Llamar uno por uno con intervalo para no saturar
  for (let i = 0; i < prospectos.length; i++) {
    const p = prospectos[i];
    if (!p.tel) continue;
    const numero = limpiarNumero(p.tel);
    const serverUrl = process.env.SERVER_URL;
    try {
      const call = await twilioClient.calls.create({
        to:                   numero,
        from:                 process.env.TWILIO_PHONE_NUMBER,
        url:                  `${serverUrl}/twiml/saludo`,
        method:               'POST',
        statusCallback:       `${serverUrl}/twiml/estado`,
        statusCallbackMethod: 'POST',
      });
      llamadasPendientes.set(call.sid, p);
      console.log(`📞 [${i+1}/${prospectos.length}] → ${numero} (${p.nombre})`);
    } catch (err) {
      console.error(`❌ Error llamando a ${numero}:`, err.message);
    }
    if (i < prospectos.length - 1) {
      await new Promise(r => setTimeout(r, intervalo_seg * 1000));
    }
  }
});

// ─────────────────────────────────────────────
// RUTA 3 — TwiML: saludo (lo que escucha el prospecto)
// ─────────────────────────────────────────────
app.post('/twiml/saludo', async (req, res) => {
  const callSid   = req.body.CallSid;
  const prospecto = llamadasPendientes.get(callSid) || { nombre: 'el negocio', tipo: 'restaurante' };
  const serverUrl = process.env.SERVER_URL;

  const mensaje = await generarMensajeVoz(prospecto);
  console.log(`🎙️  Mensaje generado para ${prospecto.nombre}: ${mensaje.slice(0, 60)}...`);

  const twiml   = new twilio.twiml.VoiceResponse();
  const gather  = twiml.gather({
    numDigits:  '1',
    action:     `${serverUrl}/twiml/respuesta`,
    method:     'POST',
    timeout:    12,
    finishOnKey: ''
  });
  gather.say({ voice: 'Polly.Mia', language: 'es-MX' }, mensaje);

  // Si no presiona nada
  twiml.say(
    { voice: 'Polly.Mia', language: 'es-MX' },
    'No recibimos ninguna respuesta. Le llamaremos en otro momento. Que tenga excelente día.'
  );
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

// ─────────────────────────────────────────────
// RUTA 4 — TwiML: respuesta a la tecla presionada
// ─────────────────────────────────────────────
app.post('/twiml/respuesta', (req, res) => {
  const callSid   = req.body.CallSid;
  const digit     = req.body.Digits;
  const prospecto = llamadasPendientes.get(callSid) || {};

  let resultado, mensajeFinal;
  if (digit === '1') {
    resultado    = 'interesado';
    const numLimpio = prospecto.tel ? String(prospecto.tel).replace(/[^0-9]/g,'').slice(-10) : '';
    const numFormato = numLimpio ? numLimpio.slice(0,3)+' '+numLimpio.slice(3,7)+' '+numLimpio.slice(7) : '';
    mensajeFinal = 'Excelente, muchas gracias. Le enviaremos el catálogo y precios de Bohuman Bio por WhatsApp a este número' + (numFormato ? ', el ' + numFormato : '') + '. Que tenga muy buen día.';
  } else if (digit === '2') {
    resultado    = 'no-interesa';
    mensajeFinal = 'Entendido, no hay problema. No le volveremos a llamar. Que tenga buen día.';
  } else {
    resultado    = 'sin-respuesta';
    mensajeFinal = 'Gracias por su tiempo. Que tenga buen día.';
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Mia', language: 'es-MX' }, mensajeFinal);
  twiml.hangup();

  guardarResultado(callSid, prospecto, resultado);
  llamadasPendientes.delete(callSid);

  res.type('text/xml').send(twiml.toString());
});

// ─────────────────────────────────────────────
// RUTA 5 — Estado de la llamada (callback Twilio)
// ─────────────────────────────────────────────
app.post('/twiml/estado', (req, res) => {
  const callSid   = req.body.CallSid;
  const status    = req.body.CallStatus;
  const prospecto = llamadasPendientes.get(callSid);

  const estadosFinales = { 'no-answer': 'no-contestó', busy: 'ocupado', failed: 'fallida', canceled: 'cancelada' };

  if (estadosFinales[status] && prospecto) {
    guardarResultado(callSid, prospecto, estadosFinales[status]);
    llamadasPendientes.delete(callSid);
    console.log(`📋 ${prospecto.nombre} → ${estadosFinales[status]}`);
  }

  res.sendStatus(200);
});

// ─────────────────────────────────────────────
// RUTA 6 — Ver resultados
// GET /resultados
// ─────────────────────────────────────────────
app.get('/resultados', (req, res) => {
  res.json(resultados);
});

// ─────────────────────────────────────────────
// RUTA 7 — Health check
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:      'activo',
    llamadas_en_curso: llamadasPendientes.size,
    total_resultados:  resultados.length
  });
});

// ── Helper guardar resultado ──────────────────
function guardarResultado(callSid, prospecto, resultado) {
  resultados.unshift({
    nombre:    prospecto.nombre    || 'Desconocido',
    tipo:      prospecto.tipo      || '',
    tel:       prospecto.tel       || '',
    resultado,
    fecha:     new Date().toLocaleString('es-MX', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
    callSid
  });
  if (resultados.length > 500) resultados.pop();
}

// ── Iniciar servidor ──────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Bot de llamadas Bohuman Bio activo → puerto ${PORT}`);
  console.log(`   Twilio número: ${process.env.TWILIO_PHONE_NUMBER || '(no configurado)'}`);
  console.log(`   Server URL:    ${process.env.SERVER_URL || '(no configurado)'}`);
});


// ─────────────────────────────────────────────
// RUTA 8 — Proxy IA: generar mensaje WhatsApp
// POST /generar-mensaje
// ─────────────────────────────────────────────
app.post('/generar-mensaje', async (req, res) => {
  const { nombre, tipo, contacto, ciudad, prods, obs, objetivo, firma, promo, nvar, tono } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'nombre y tipo son obligatorios' });

  const prompt = `Eres experto en ventas B2B para distribuidoras de productos desechables de plástico para alimentos en México (vasos, platos, contenedores, cubiertos, popotes, bolsas de empaque, charolas, guantes, servilletas, etc.). La empresa se llama ${firma || 'Bohuman Bio'}, distribuidora de desechables para alimentos.

Genera ${nvar || 1} variante${(nvar||1)>1?'s':''} de mensaje de WhatsApp para prospectar en frío. Cada variante debe tener apertura y estructura distinta.

DATOS DEL PROSPECTO:
- Negocio: ${nombre}
- Tipo: ${tipo}
- ${contacto?'Contacto: '+contacto:'Sin nombre de contacto'}
- ${ciudad?'Zona: '+ciudad:''}
- ${prods?'Productos de interés: '+prods:'Desechables para alimentos en general'}
- ${obs?'Observación: '+obs:''}
- ${promo?'Promoción: '+promo:''}

CONFIGURACIÓN:
- Tono: ${tono || 'amigable y directo'}
- Objetivo: ${objetivo || 'presentarse y generar interés'}
- Firma: ${firma || 'Bohuman Bio'}

REGLAS:
- Máximo 6 líneas por mensaje, lenguaje natural de WhatsApp
- No suenes a spam corporativo
- 1-3 emojis máximo
- Termina con pregunta o llamada a la acción clara
- ${contacto?'Usa el nombre del contacto':'Saludo general'}
- Español mexicano natural
- ${(nvar||1)>1?'Separa cada variante EXACTAMENTE con la línea: ---VARIANTE [número]---':''}
- Solo los mensajes, sin explicaciones`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const texto = response.content.map(b => b.text || '').join('');
    res.json({ ok: true, texto });
  } catch (err) {
    console.error('Error generando mensaje:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// RUTA 9 — Proxy IA: generar guión de llamada
// POST /generar-guion
// ─────────────────────────────────────────────
app.post('/generar-guion', async (req, res) => {
  const { nombre, tipo, contacto, objetivo, prods, tono } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'nombre y tipo son obligatorios' });

  const prompt = `Eres experto en ventas B2B para Bohuman Bio, distribuidora de plásticos desechables para alimentos en México.

Genera un guión de llamada telefónica de prospectación en frío. Debe sonar natural, conversacional y no robótico.

DATOS:
- Negocio: ${nombre}
- Tipo: ${tipo}
- ${contacto ? 'Contacto: '+contacto : 'Sin nombre de contacto conocido'}
- ${prods ? 'Productos a mencionar: '+prods : 'Desechables para alimentos en general'}
- Objetivo: ${objetivo || 'primer contacto y generar interés'}

ESTRUCTURA DEL GUIÓN (usa estas etiquetas exactas):
[APERTURA] — Saludo, presentación de 2 líneas máximo
[GANCHO] — Frase de valor en 1 oración que enganche
[PROPUESTA] — Qué ofreces y por qué les conviene (2-3 líneas)
[MANEJO DE OBJECIÓN] — Respuesta breve si dicen "no me interesa" o "ya tenemos proveedor"
[CIERRE] — Siguiente paso concreto

REGLAS:
- Español mexicano natural
- Máximo 200 palabras totales
- Sin frases corporativas vacías
- Solo el guión, sin explicaciones`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });
    const texto = response.content.map(b => b.text || '').join('').trim();
    res.json({ ok: true, texto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
