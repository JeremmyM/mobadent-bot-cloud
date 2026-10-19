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
// 1. SERVIDOR HTTP PARA RENDER WEB SERVICE (KEEPALIVE)
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
  console.log("⬇️ Verificando sesión almacenada en Supabase...");
  try {
    const { data: files, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .list("", { limit: 1000, sortBy: { column: "name", order: "asc" } });

    if (error || !files || files.length === 0) {
      console.log("ℹ️ No hay sesión previa en Supabase. Se iniciará vinculación nueva.");
      return false;
    }

    console.log(`📦 Descargando ${files.length} archivos de sesión...`);
    for (const f of files) {
      if (f.name === ".emptyFolderPlaceholder") continue;
      const { data, error: downErr } = await supabase.storage.from(SUPABASE_BUCKET).download(f.name);
      if (!downErr && data) {
        fs.writeFileSync(path.join(SESSION_DIR, f.name), Buffer.from(await data.arrayBuffer()));
      }
    }
    console.log("✅ Sesión descargada y lista.");
    return true;
  } catch (err) {
    console.error("⚠️ Error durante descarga inicial:", err.message);
    return false;
  }
}

async function sincronizarArchivosASupabase() {
  try {
    if (!fs.existsSync(SESSION_DIR)) return;
    const archivos = fs.readdirSync(SESSION_DIR);
    for (const archivo of archivos) {
      const ruta = path.join(SESSION_DIR, archivo);
      if (fs.lstatSync(ruta).isFile()) {
        const fileBuffer = fs.readFileSync(ruta);
        await supabase.storage.from(SUPABASE_BUCKET).upload(archivo, fileBuffer, { upsert: true });
      }
    }
  } catch (err) {
    console.error("⚠️ Error sincronizando sesión a Supabase:", err.message);
  }
}

// -------------------------------------------------------------------------
// 4. CONSULTA DE CARTERA EN NEON POSTGRESQL
// -------------------------------------------------------------------------
async function consultarCarteraPorTelefono(telefonoLimpio) {
  const digitos = telefonoLimpio.replace(/\D/g, "");
  console.log(`🔍 [BOT] Evaluando número: "${telefonoLimpio}" -> Dígitos: "${digitos}"`);

  if (!digitos || digitos.length < 7) return null;

  const ultimos8 = digitos.slice(-8);
  const ultimos7 = digitos.slice(-7);

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
      console.log(`✅ [BOT] Doctor encontrado: ${res.rows[0].doctor_nombre} | Saldo: ${res.rows[0].saldo_pendiente}`);
      return res.rows[0];
    }
    return null;
  } catch (err) {
    console.error("❌ [BOT] Error SQL en Neon:", err.message);
    return null;
  }
}

// -------------------------------------------------------------------------
// 5. INICIALIZACIÓN CONTROLADA DEL BOT
// -------------------------------------------------------------------------
let codigoYaSolicitado = false;

async function iniciarBot() {
  await descargarSesionSupabase();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: 60000
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await sincronizarArchivosASupabase();
  });

  const syncInterval = setInterval(async () => {
    if (sock.authState?.creds?.registered) {
      await sincronizarArchivosASupabase();
    }
  }, 30000);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Solo se solicita Pairing Code cuando el socket está listo y no está registrado
    if (qr && !sock.authState.creds.registered && PHONE_NUMBER && !codigoYaSolicitado) {
      codigoYaSolicitado = true;
      try {
        const cleanNumber = PHONE_NUMBER.replace(/\D/g, "");
        const code = await sock.requestPairingCode(cleanNumber);
        console.log("\n=======================================================");
        console.log(`📲 CÓDIGO DE VINCULACIÓN: ${code}`);
        console.log("=======================================================\n");
      } catch (err) {
        codigoYaSolicitado = false;
        console.error("Aviso solicitando código:", err.message);
      }
    }

    if (connection === "close") {
      clearInterval(syncInterval);
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ Conexión cerrada (status: ${statusCode}).`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log("🛑 Sesión cerrada o inválida (401). Limpiando credenciales locales...");
        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          fs.mkdirSync(SESSION_DIR, { recursive: true });
        } catch (_) {}
      } else {
        setTimeout(iniciarBot, 5000);
      }
    } else if (connection === "open") {
      console.log("\n🟢 Mobadent Bot Cloud CONECTADO y activo 24/7.\n");
      await sincronizarArchivosASupabase();
    }
  });

  // -----------------------------------------------------------------------
  // 6. GESTIÓN DE MENSAJES Y RECONOCIMIENTO INTELIGENTE DE INTENCIONES
  // -----------------------------------------------------------------------
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid || "";
      if (remoteJid.endsWith("@g.us")) continue; // Ignorar grupos

      // Limpieza y normalización del texto recibido
      const textoOriginal = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ""
      ).trim();

      if (!textoOriginal) continue;

      // Normalizar texto: a mayúsculas y sin acentos para comparaciones infalibles
      const textoNormalizado = textoOriginal
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

      // Extracción prioritaria del número real
      let telefonoReal = "";
      if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.includes("@s.whatsapp.net")) {
        telefonoReal = msg.key.remoteJidAlt.split("@")[0];
      } else if (msg.key.participantPn) {
        telefonoReal = msg.key.participantPn.split("@")[0];
      } else if (msg.key.senderPn) {
        telefonoReal = msg.key.senderPn.split("@")[0];
      } else if (remoteJid.endsWith("@s.whatsapp.net")) {
        telefonoReal = remoteJid.split("@")[0];
      }

      if ((!telefonoReal || telefonoReal.length > 15) && remoteJid.includes("@lid") && sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(remoteJid);
          if (pn) telefonoReal = pn.split("@")[0];
        } catch (_) {}
      }

      if (!telefonoReal) telefonoReal = remoteJid.split("@")[0];

      // =====================================================================
      // INTENCIONES MEDIANTE EXPRESIONES REGULARES
      // =====================================================================
      
      // 1. Intención de Saldo / Estado de Cartera / Cuánto debo
      const esConsultaSaldo = /^(1)$|SALDO|CUANTO (DEBO|LES DEBO|ES MI CUENTA|TENGO QUE PAGAR)|MI (DEUDA|SALDO|ESTADO DE CUENTA|CUENTA)|DEUDA|CARTERA|PENDIENTE DE PAGO|BALANCE/i.test(textoNormalizado);

      // 2. Intención de Banco / Cuentas Bancarias / Transferencia
      const esConsultaBanco = /^(2)$|BANCO|CUENTA(S)? (DEL BANCO|BANCARIA(S)?|PARA PAGAR|PARA TRANSFERIR)|DATOS (BANCARIOS|DE PAGO|DE TRANSFERENCIA|PARA DEPOSITAR)|PASENME (EL BANCO|LAS CUENTAS)|TRANSFERENCIA|DEPOSITO|DONDE (PAGO|TRANSFIERO|DEPOSITO)/i.test(textoNormalizado);

      // 3. Menú o Saludos
      const esConsultaMenu = /^(MENU|INICIO|OPCIONES|AYUDA|HOLA|BUENAS|BUENOS DIAS|BUENAS TARDES|BUENAS NOCHES)$/i.test(textoNormalizado);

      try {
        // --- CASO 1: CONSULTA DE SALDO ---
        if (esConsultaSaldo) {
          const cuenta = await consultarCarteraPorTelefono(telefonoReal);

          if (!cuenta) {
            await sock.sendMessage(remoteJid, {
              text: "Estimado/a Doctor/a:\n\nNo registramos una cuenta vinculada a este número de contacto en nuestro sistema de cartera.\n\nPor favor, envíenos su número de identificación fiscal (RUC/Cédula) o nombres completos para que el área de atención pueda verificar su registro formalmente."
            });
            continue;
          }

          const trato = cuenta.trato || "Dr./Dra.";
          const nombre = cuenta.doctor_nombre || "";
          const saldo = parseFloat(cuenta.saldo_pendiente || 0);

          if (saldo > 0) {
            await sock.sendMessage(remoteJid, {
              text: `Estimado/a ${trato} ${nombre}:\n\nLe informamos que su saldo pendiente actual es de *$${saldo.toFixed(2)}*.\n\nSi ya realizó su depósito o transferencia, por favor envíenos el comprobante bancario por este medio para registrar su conciliación contable. Puede escribir *BANCO* o *2* para obtener las cuentas oficiales.`
            });
          } else {
            await sock.sendMessage(remoteJid, {
              text: `Estimado/a ${trato} ${nombre}:\n\nNos complace informarle que su cuenta se encuentra actualmente *AL DÍA* (Saldo: $0.00).\n\nMuchas gracias por su puntualidad y confianza en Mobadent.`
            });
          }
        } 
        // --- CASO 2: DATOS BANCARIOS ---
        else if (esConsultaBanco) {
          await sock.sendMessage(remoteJid, {
            text: "🏦 *DATOS BANCARIOS OFICIALES - MOBADENT S.A.S.*\n\n" +
                  "• *Institución Financiera:* Banco Pichincha\n" +
                  "• *Tipo de Cuenta:* Corriente\n" +
                  "• *Número de Cuenta:* 2100XXXXXX\n" +
                  "• *Titular:* MOBADENT S.A.S.\n" +
                  "• *RUC:* 099XXXXXXXX001\n" +
                  "• *Correo de Facturación:* pagos@mobadent.ec\n\n" +
                  "📌 *Nota:* Una vez realizada la operación, envíenos la fotografía o archivo digital del comprobante por este medio para conciliar su abono contable."
          });
        } 
        // --- CASO 3: MENÚ PRINCIPAL ---
        else if (esConsultaMenu) {
          await sock.sendMessage(remoteJid, {
            text: "👋 *Atención al Cliente - Mobadent*\n\n" +
                  "Bienvenido al canal corporativo de consultas. Por favor, elija una opción escribiendo el número o la palabra deseada:\n\n" +
                  "👉 *1* o *SALDO*: Consulta de balance contable y estado de cartera.\n" +
                  "👉 *2* o *BANCO*: Información de cuentas bancarias oficiales para pagos.\n\n" +
                  "Escriba *MENU* en cualquier momento para volver a ver estas opciones."
          });
        }
      } catch (err) {
        console.error("Error procesando mensaje:", err.message);
      }
    }
  });
}

iniciarBot().catch(console.error);