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

// 1. Mantener puerto HTTP activo para que Render Web Service no aborte
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Mobadent Bot Cloud 24/7 en línea.");
}).listen(PORT, () => {
  console.log(`✅ Servidor HTTP escuchando en el puerto ${PORT}`);
});

// 2. Variables de entorno
const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PHONE_NUMBER = process.env.WHATSAPP_PHONE; // Número con prefijo (Ej: 5939XXXXXXXX)
const SUPABASE_BUCKET = "whatsapp-session";
const SESSION_DIR = path.resolve("./auth_session");

if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Faltan variables de entorno esenciales.");
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
    logger.error({ err, fileName }, "Error al respaldar en Supabase");
  }
}

async function consultarCarteraPorTelefono(telefonoLimpio) {
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
  try {
    const res = await pool.query(query, [`%${ultimos8}`]);
    return res.rows.length > 0 ? res.rows[0] : null;
  } catch (err) {
    logger.error({ err }, "Error consultando cartera en Neon");
    return null;
  }
}

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

  // Si no está registrado y definiste el teléfono, generar Pairing Code
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
      if (remoteJid.endsWith("@g.us")) continue;

      const texto = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ""
      ).trim().toUpperCase();

      if (!texto) continue;

      let telefonoReal = "";
      if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.includes("@s.whatsapp.net")) {
        telefonoReal = msg.key.remoteJidAlt.split("@")[0];
      } else if (remoteJid.endsWith("@s.whatsapp.net")) {
        telefonoReal = remoteJid.split("@")[0];
      } else {
        telefonoReal = remoteJid.split("@")[0];
      }

      try {
        if (/SALDO|DEUDA|CUENTA/.test(texto)) {
          const cuenta = await consultarCarteraPorTelefono(telefonoReal);
          if (!cuenta) {
            await sock.sendMessage(remoteJid, {
              text: "Estimado/a Doctor/a, no tenemos registrado su número en nuestro sistema de cartera contable.\n\nPor favor, comuníquese directamente con nuestro asesor comercial Michael."
            });
            continue;
          }
          const trato = cuenta.trato || "Dr./Dra.";
          const nombre = cuenta.doctor_nombre || "";
          const saldo = parseFloat(cuenta.saldo_pendiente || 0);

          if (saldo > 0) {
            await sock.sendMessage(remoteJid, {
              text: `Estimado/a ${trato} ${nombre}:\n\nSu saldo pendiente actual es de *$${saldo.toFixed(2)}*.\n\nSi ya realizó su abono, compártanos el comprobante por este medio. ¡Muchas gracias!`
            });
          } else {
            await sock.sendMessage(remoteJid, {
              text: `Estimado/a ${trato} ${nombre}:\n\n¡Le felicitamos! Su cuenta se encuentra actualmente *AL DÍA* (Saldo: $0.00).\n\nGracias por su confianza con Mobadent.`
            });
          }
        } else if (/BANCO|TRANSFERENCIA|PAGO/.test(texto)) {
          await sock.sendMessage(remoteJid, {
            text: "🏦 *DATOS BANCARIOS OFICIALES - MOBADENT*\n\n• *Banco:* Banco Pichincha\n• *Tipo de Cuenta:* Corriente\n• *Número:* 2100XXXXXX\n• *Titular:* MOBADENT S.A.S.\n• *RUC:* 099XXXXXXXX001\n• *Correo:* pagos@mobadent.ec"
          });
        } else if (/MENU|HOLA|AYUDA/.test(texto)) {
          await sock.sendMessage(remoteJid, {
            text: "👋 *Bienvenido a Mobadent*\n\nEscriba una opción:\n👉 *SALDO*: Consultar su deuda.\n👉 *BANCO*: Ver datos de transferencia.\n👉 *ASESOR*: Hablar con Michael."
          });
        } else if (/MICHAEL|ASESOR|HUMANO/.test(texto)) {
          await sock.sendMessage(remoteJid, {
            text: "🔔 Hemos notificado a su asesor comercial *Michael*. En breve revisará este chat."
          });
        }
      } catch (err) {
        logger.error({ err }, "Error procesando mensaje");
      }
    }
  });
}


iniciarBot().catch(console.error);