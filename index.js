import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import pino from "pino";
import fs from "fs";
import path from "path";
import http from "http";

const logger = pino({ level: "info" });

// -------------------------------------------------------------------------
// 1. SERVIDOR HTTP OBLIGATORIO PARA RENDER WEB SERVICE
// -------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Mobadent Bot Cloud 24/7 en línea.");
}).listen(PORT, () => {
  console.log(`✅ Servidor HTTP escuchando en el puerto ${PORT}`);
});

// -------------------------------------------------------------------------
// 2. CONFIGURACIÓN Y VARIABLES DE ENTORNO
// -------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PHONE_NUMBER = process.env.WHATSAPP_PHONE;
const SUPABASE_BUCKET = "whatsapp-session";
const SESSION_DIR = path.resolve("./auth_session");

if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Faltan variables de entorno esenciales: DATABASE_URL, SUPABASE_URL o SUPABASE_KEY.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// -------------------------------------------------------------------------
// 3. PERSISTENCIA DE SESIÓN CON SUPABASE STORAGE
// -------------------------------------------------------------------------
async function descargarSesionSupabase() {
  try {
    const { data: files, error } = await supabase.storage.from(SUPABASE_BUCKET).list();
    if (error || !files || files.length === 0) return;

    for (const f of files) {
      if (f.name === ".emptyFolderPlaceholder") continue;
      const { data, error: downErr } = await supabase.storage.from(SUPABASE_BUCKET).download(f.name);
      if (!downErr && data) {
        fs.writeFileSync(path.join(SESSION_DIR, f.name), Buffer.from(await data.arrayBuffer()));
      }
    }
    logger.info("✅ Sesión existente sincronizada desde Supabase.");
  } catch (err) {
    logger.error({ err }, "Aviso sincronizando sesión inicial");
  }
}

async function subirArchivoASupabase(fileName, filePath) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    await supabase.storage.from(SUPABASE_BUCKET).upload(fileName, fileBuffer, { upsert: true });
  } catch (err) {
    logger.error({ err, fileName }, "Error al respaldar archivo en Supabase");
  }
}

// -------------------------------------------------------------------------
// 4. CONSULTA DE CARTERA DIRECTA EN NEON POSTGRESQL
// -------------------------------------------------------------------------
async function consultarCarteraPorTelefono(telefonoLimpio) {
  const digitos = telefonoLimpio.replace(/\D/g, "");
  console.log(`🔍 [BOT] Evaluando número entrante: '${telefonoLimpio}' -> Dígitos: '${digitos}'`);

  if (!digitos || digitos.length < 7) {
    console.log("⚠️ [BOT] Número muy corto o inválido.");
    return null;
  }

  const ultimos8 = digitos.slice(-8);
  const ultimos7 = digitos.slice(-7);

  console.log(`🔍 [BOT] Buscando en Neon coincidencias para: ${digitos} (o terminados en ${ultimos8})`);

  const query = `
    SELECT doctor_nombre, trato, saldo_pendiente, telefono
    FROM cuentas_doctores
    WHERE 
      REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') LIKE $1
      OR REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') LIKE $2
      OR REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') = $3
    ORDER BY id DESC
    LIMIT 1;
  `;
  const params = [`%${ultimos8}`, `%${ultimos7}`, digitos];

  try {
    const res = await pool.query(query, params);
    if (res.rows.length > 0) {
      console.log(`✅ [BOT] Registro encontrado en BD: ${res.rows[0].doctor_nombre} | Saldo: ${res.rows[0].saldo_pendiente}`);
      return res.rows[0];
    } else {
      console.log(`❌ [BOT] Sin coincidencias en cuentas_doctores.`);
      return null;
    }
  } catch (err) {
    console.error("❌ [BOT] Error SQL en Neon:", err.message);
    return null;
  }
}

// -------------------------------------------------------------------------
// 5. INICIALIZACIÓN Y GESTIÓN DE MENSAJES DE WHATSAPP
// -------------------------------------------------------------------------
async function iniciarBot() {
  await descargarSesionSupabase();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    defaultQueryTimeoutMs: 60000
  });

  if (!sock.authState.creds.registered && PHONE_NUMBER) {
    setTimeout(async () => {
      try {
        const cleanNumber = PHONE_NUMBER.replace(/\D/g, "");
        const code = await sock.requestPairingCode(cleanNumber);
        console.log("\n=======================================================");
        console.log(`📲 CÓDIGO DE VINCULACIÓN DE WHATSAPP: ${code}`);
        console.log("=======================================================\n");
      } catch (err) {
        console.error("Error solicitando Pairing Code:", err);
      }
    }, 4000);
  }

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    try {
      const archivos = fs.readdirSync(SESSION_DIR);
      for (const archivo of archivos) {
        await subirArchivoASupabase(archivo, path.join(SESSION_DIR, archivo));
      }
    } catch (_) {}
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(iniciarBot, 5000);
      }
    } else if (connection === "open") {
      console.log("\n🟢 Mobadent Bot Cloud CONECTADO y activo 24/7.\n");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid || "";
      if (remoteJid.endsWith("@g.us")) continue; // Ignorar grupos

      const texto = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ""
      ).trim().toUpperCase();

      if (!texto) continue;

      // Resolver teléfono real evitando LIDs (@lid)
      let telefonoReal = "";
      if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.includes("@s.whatsapp.net")) {
        telefonoReal = msg.key.remoteJidAlt.split("@")[0];
      } else if (remoteJid.endsWith("@s.whatsapp.net")) {
        telefonoReal = remoteJid.split("@")[0];
      }

      if (!telefonoReal && sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(remoteJid);
          if (pn) telefonoReal = pn.split("@")[0];
        } catch (_) {}
      }

      if (!telefonoReal) {
        telefonoReal = remoteJid.split("@")[0];
      }

      try {
        // 1. CONSULTA DE SALDO / DEUDA / ESTADO DE CUENTA
        if (/SALDO|DEUDA|CUENTA|ESTADO/.test(texto)) {
          const cuenta = await consultarCarteraPorTelefono(telefonoReal);

          if (!cuenta) {
            await sock.sendMessage(remoteJid, {
              text: "Estimado/a Doctor/a:\n\nNo registramos una cuenta vinculada a este número de contacto en nuestro sistema de cartera.\n\nPor favor, envíenos sus nombres completos o su número de identificación para que el área de atención al cliente pueda asistirle formalmente."
            });
            continue;
          }

          const trato = cuenta.trato || "Dr./Dra.";
          const nombre = cuenta.doctor_nombre || "";
          const saldo = parseFloat(cuenta.saldo_pendiente || 0);

          if (saldo > 0) {
            await sock.sendMessage(remoteJid, {
              text: `Estimado/a ${trato} ${nombre}:\n\nLe informamos que su saldo pendiente actual es de *$${saldo.toFixed(2)}*.\n\nSi ya realizó su transferencia o depósito, por favor adjunte su comprobante por este medio para registrar su conciliación. ¡Agradecemos su puntualidad y confianza en Mobadent!`
            });
          } else {
            await sock.sendMessage(remoteJid, {
              text: `Estimado/a ${trato} ${nombre}:\n\nNos complace informarle que su cuenta se encuentra actualmente *AL DÍA* (Saldo: $0.00).\n\nMuchas gracias por su preferencia comercial con Mobadent.`
            });
          }
        } 
        // 2. DATOS BANCARIOS OFICIALES
        else if (/BANCO|TRANSFERENCIA|PAGO|DATOS/.test(texto)) {
          await sock.sendMessage(remoteJid, {
            text: "🏦 *DATOS BANCARIOS OFICIALES - MOBADENT S.A.S.*\n\n" +
                  "• *Institución Financiera:* Banco Pichincha\n" +
                  "• *Tipo de Cuenta:* Corriente\n" +
                  "• *Número de Cuenta:* 2100XXXXXX\n" +
                  "• *Titular:* MOBADENT S.A.S.\n" +
                  "• *RUC:* 099XXXXXXXX001\n" +
                  "• *Correo de Facturación/Cobranza:* pagos@mobadent.ec\n\n" +
                  "📌 *Nota:* Una vez realizada la operación, envíenos el comprobante emitido por el banco para validar su crédito contable."
          });
        } 
        // 3. MENÚ PRINCIPAL / BIENVENIDA
        else if (/MENU|HOLA|BUENAS|INICIO|OPCIONES/.test(texto)) {
          await sock.sendMessage(remoteJid, {
            text: "👋 *Atención al Cliente - Mobadent*\n\n" +
                  "Por favor, seleccione o escriba una de las siguientes opciones:\n\n" +
                  "👉 *SALDO*: Consulta de balance contable y estado de cartera.\n" +
                  "👉 *BANCO*: Información de cuentas oficiales para pagos.\n" +
                  "👉 *SOPORTE*: Contactar con el área de atención y cobranza."
          });
        } 
        // 4. ATENCIÓN AL CLIENTE / SOPORTE ADMINISTRATIVO
        else if (/SOPORTE|ATENCION|AYUDA|HUMANO|CONTACTO/.test(texto)) {
          await sock.sendMessage(remoteJid, {
            text: "🛎️ *Atención al Cliente - Mobadent*\n\n" +
                  "Hemos registrado su solicitud. Un representante del departamento administrativo revisará este canal para brindarle atención personalizada a la brevedad posible."
          });
        }
      } catch (err) {
        logger.error({ err }, "Error procesando mensaje");
      }
    }
  });
}

iniciarBot().catch(console.error);