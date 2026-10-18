import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";
import path from "path";

const logger = pino({ level: "info" });

// -------------------------------------------------------------------------
// 1. CONFIGURACIÓN DE VARIABLES DE ENTORNO
// -------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_BUCKET = "whatsapp-session";
const SESSION_DIR = path.resolve("./auth_session");

if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Faltan variables de entorno: DATABASE_URL, SUPABASE_URL o SUPABASE_KEY.");
  process.exit(1);
}

// Cliente Supabase y Pool Neon
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// -------------------------------------------------------------------------
// 2. SINCRONIZACIÓN DE SESIÓN CON SUPABASE STORAGE
// -------------------------------------------------------------------------
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

async function descargarSesionSupabase() {
  try {
    const { data: files, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .list();

    if (error) {
      logger.warn({ err: error.message }, "Aviso al listar bucket en Supabase");
      return;
    }

    if (!files || files.length === 0) {
      logger.info("ℹ️ No hay sesión previa en Supabase. Se requerirá escaneo de QR inicial.");
      return;
    }

    logger.info(`🔄 Descargando ${files.length} archivos de sesión desde Supabase...`);
    for (const f of files) {
      if (f.name === ".emptyFolderPlaceholder") continue;
      const { data, error: downErr } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .download(f.name);

      if (!downErr && data) {
        const buffer = Buffer.from(await data.arrayBuffer());
        fs.writeFileSync(path.join(SESSION_DIR, f.name), buffer);
      }
    }
    logger.info("✅ Sesión sincronizada desde Supabase con éxito.");
  } catch (err) {
    logger.error({ err }, "Error descargando sesión de Supabase");
  }
}

async function subirArchivoASupabase(fileName, filePath) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(fileName, fileBuffer, { upsert: true });
  } catch (err) {
    logger.error({ err, fileName }, "Error al respaldar archivo en Supabase");
  }
}

// -------------------------------------------------------------------------
// 3. CONSULTAS SQL A NEON (CARTERA DOCTORES)
// -------------------------------------------------------------------------
async function consultarCarteraPorTelefono(telefonoLimpio) {
  // Extraer los últimos 8 dígitos numéricos para tolerar formatos +593, 09, etc.
  const digitos = telefonoLimpio.replace(/\D/g, "");
  if (digitos.length < 8) return null;
  const ultimos8 = digitos.slice(-8);

  const query = `
    SELECT doctor_nombre, trato, saldo_pendiente
    FROM cuentas_doctores
    WHERE REPLACE(REPLACE(REPLACE(telefono, ' ', ''), '-', ''), '+', '') LIKE $1
    ORDER BY id DESC
    LIMIT 1;
  `;
  const params = [`%${ultimos8}`];

  try {
    const res = await pool.query(query, params);
    if (res.rows.length > 0) {
      return res.rows[0];
    }
    return null;
  } catch (err) {
    logger.error({ err }, "Error ejecutando consulta de cartera en Neon");
    return null;
  }
}

// -------------------------------------------------------------------------
// 4. INICIALIZACIÓN DEL BOT BAILEYS
// -------------------------------------------------------------------------
async function iniciarBot() {
  await descargarSesionSupabase();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Iniciando Baileys v${version.join(".")} (Última versión: ${isLatest})`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    defaultQueryTimeoutMs: 60000
  });

  // Guardar credenciales y sincronizar con Supabase
  sock.ev.on("creds.update", async () => {
    await saveCreds();
    try {
      const archivos = fs.readdirSync(SESSION_DIR);
      for (const archivo of archivos) {
        await subirArchivoASupabase(archivo, path.join(SESSION_DIR, archivo));
      }
    } catch (e) {
      logger.error({ err: e }, "Fallo al sincronizar credenciales actualizadas a Supabase");
    }
  });

  // Estado de la conexión
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n=======================================================");
      console.log("📲 ESCANEA ESTE CÓDIGO QR EN WHATSAPP (LOGS DE LA NUBE):");
      console.log("=======================================================\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const debeReconectar = statusCode !== DisconnectReason.loggedOut;
      logger.warn(`Conexión cerrada. Código: ${statusCode}. Reconectando: ${debeReconectar}`);

      if (debeReconectar) {
        setTimeout(iniciarBot, 5000);
      } else {
        logger.error("Sesión cerrada permanentemente (Logged Out). Limpie credenciales y reescanee.");
      }
    } else if (connection === "open") {
      logger.info("🟢 Mobadent Bot Cloud CONECTADO y activo 24/7.");
    }
  });

  // Escucha de mensajes entrantes
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Ignorar mensajes enviados por el propio bot o sin contenido
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid || "";
      if (remoteJid.endsWith("@g.us")) continue; // Ignorar grupos

      // 1. Extraer texto del mensaje
      const textoMensaje = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ""
      ).trim().toUpperCase();

      if (!textoMensaje) continue;

      // 2. Resolver el teléfono real evitando LIDs
      let telefonoReal = "";
      if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.includes("@s.whatsapp.net")) {
        telefonoReal = msg.key.remoteJidAlt.split("@")[0];
      } else if (remoteJid.endsWith("@s.whatsapp.net")) {
        telefonoReal = remoteJid.split("@")[0];
      } else if (sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(remoteJid);
          if (pn) telefonoReal = pn.split("@")[0];
        } catch (_) {}
      }

      if (!telefonoReal && remoteJid.includes("@")) {
        telefonoReal = remoteJid.split("@")[0];
      }

      // 3. Evaluar palabras clave y despachar respuestas
      try {
        if (/SALDO|DEUDA|CUENTA/.test(textoMensaje)) {
          const cuenta = await consultarCarteraPorTelefono(telefonoReal);

          if (!cuenta) {
            await sock.sendMessage(remoteJid, {
              text: "Estimado/a Doctor/a, no tenemos registrado su número en nuestro sistema de cartera contable.\n\nPor favor, comuníquese directamente con nuestro asesor comercial Michael para registrar su ficha o verificar su estado."
            });
            continue;
          }

          const trato = cuenta.trato || "Dr./Dra.";
          const nombre = cuenta.doctor_nombre || "";
          const saldo = parseFloat(cuenta.saldo_pendiente || 0);

          if (saldo > 0) {
            await sock.sendMessage(remoteJid, {
              text: `Estimado/a ${trato} ${nombre}:\n\nSu saldo pendiente actual es de *$${saldo.toFixed(2)}*.\n\nSi ya realizó su abono o cancelación, por favor compártanos el comprobante por este medio para conciliarlo en el sistema. ¡Muchas gracias por su preferencia!`
            });
          } else {
            await sock.sendMessage(remoteJid, {
              text: `Estimado/a ${trato} ${nombre}:\n\n¡Le felicitamos! Su cuenta se encuentra actualmente *AL DÍA* (Saldo: $0.00).\n\nGracias por su confianza y puntualidad con Mobadent.`
            });
          }
        } 
        else if (/BANCO|TRANSFERENCIA|PAGO/.test(textoMensaje)) {
          await sock.sendMessage(remoteJid, {
            text: "🏦 *DATOS BANCARIOS OFICIALES - MOBADENT*\n\n" +
                  "• *Banco:* Banco Pichincha\n" +
                  "• *Tipo de Cuenta:* Corriente\n" +
                  "• *Número de Cuenta:* 2100XXXXXX\n" +
                  "• *Titular:* MOBADENT S.A.S.\n" +
                  "• *RUC:* 099XXXXXXXX001\n" +
                  "• *Correo de soporte:* pagos@mobadent.ec\n\n" +
                  "Una vez realizada la transferencia, envíenos el comprobante por este chat para acreditarlo a su cuenta."
          });
        } 
        else if (/MENU|HOLA|AYUDA/.test(textoMensaje)) {
          await sock.sendMessage(remoteJid, {
            text: "👋 *Bienvenido al Asistente Automatizado de Mobadent*\n\n" +
                  "Escriba una de las siguientes opciones para ayudarle de inmediato:\n\n" +
                  "👉 *SALDO*: Consultar su estado de cuenta y balance pendiente.\n" +
                  "👉 *BANCO*: Ver los datos de cuenta para pagos y transferencias.\n" +
                  "👉 *ASESOR*: Solicitar atención personalizada con Michael."
          });
        } 
        else if (/MICHAEL|ASESOR|HUMANO/.test(textoMensaje)) {
          await sock.sendMessage(remoteJid, {
            text: "🔔 Hemos notificado a su asesor comercial *Michael*. En breve revisará este chat para atenderle de manera directa. Si es urgente, puede marcarle a su extensión móvil habitual."
          });
        }
      } catch (sendErr) {
        logger.error({ err: sendErr, remoteJid }, "Error respondiendo mensaje");
      }
    }
  });
}

iniciarBot().catch((err) => {
  logger.fatal({ err }, "Error crítico en proceso principal");
});