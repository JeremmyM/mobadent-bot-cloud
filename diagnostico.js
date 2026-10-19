import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import path from "path";
import fs from "fs";

const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_BUCKET = "whatsapp-session";
const SESSION_DIR = path.resolve("./auth_session");

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function descargarSesion() {
  console.log("?? Verificando sesion en Supabase Storage...");
  try {
    const { data: files, error } = await supabase.storage.from(SUPABASE_BUCKET).list();
    if (error || !files || files.length === 0) {
      console.log("?? No hay archivos o ya existen localmente.");
      return;
    }
    console.log(`?? Descargando ${files.length} archivos de sesion...`);
    for (const f of files) {
      if (f.name === ".emptyFolderPlaceholder") continue;
      const localPath = path.join(SESSION_DIR, f.name);
      if (fs.existsSync(localPath)) continue; // Si ya existe no perder tiempo

      const { data } = await supabase.storage.from(SUPABASE_BUCKET).download(f.name);
      if (data) {
        fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
      }
    }
    console.log("? Sesion lista.");
  } catch (err) {
    console.log("?? Continuando con credenciales locales:", err.message);
  }
}

async function auditarNeon(numeroProbado) {
  console.log(`\n=================================================`);
  console.log(`?? AUDITANDO NEON PARA NUMERO: "${numeroProbado}"`);
  console.log(`=================================================`);
  
  const digitos = numeroProbado.replace(/\D/g, "");
  const ultimos8 = digitos.slice(-8);
  const ultimos7 = digitos.slice(-7);

  console.log(`• Digitos limpios: ${digitos} | Ultimos 8: ${ultimos8} | Ultimos 7: ${ultimos7}`);

  const query = `
    SELECT doctor_nombre, trato, saldo_pendiente, telefono
    FROM cuentas_doctores
    WHERE 
      REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') LIKE $1
      OR REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') LIKE $2
      OR REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') = $3
    ORDER BY id DESC LIMIT 1;
  `;
  try {
    const res = await pool.query(query, [`%${ultimos8}`, `%${ultimos7}`, digitos]);
    if (res.rows.length > 0) {
      console.log(`? ?ENCONTRADO EN BASE DE DATOS!:`, res.rows[0]);
    } else {
      console.log(`? NO ENCONTRADO EN NEON.`);
      const todos = await pool.query("SELECT id, doctor_nombre, telefono FROM cuentas_doctores LIMIT 5;");
      console.log("Registros actuales en la tabla:", todos.rows);
    }
  } catch (e) {
    console.error("Error SQL:", e.message);
  }
}

async function run() {
  await descargarSesion();
  const { state } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: (await import("pino")).default({ level: "silent" })
  });

  sock.ev.on("connection.update", (up) => {
    if (up.connection === "open") {
      console.log("\n?? BOT LISTO Y CONECTADO. Envia la palabra SALDO ahora...");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      
      console.log("\n?? === MENSAJE RECIBIDO ===");
      console.log("Remote JID:", msg.key.remoteJid);
      console.log("Remote JID Alt:", msg.key.remoteJidAlt);
      console.log("Participant PN:", msg.key.participantPn);

      let numeroFinal = (msg.key.remoteJidAlt || msg.key.participantPn || msg.key.remoteJid).split("@")[0];

      if (numeroFinal.length > 15 && sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(msg.key.remoteJid);
          if (pn) numeroFinal = pn.split("@")[0];
        } catch (_) {}
      }

      console.log(`?? Telefono resuelto: "${numeroFinal}"`);
      await auditarNeon(numeroFinal);
    }
  });
}

run().catch(console.error);
