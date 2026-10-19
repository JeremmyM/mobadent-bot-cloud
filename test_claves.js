import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const DATABASE_URL = "postgresql://neondb_owner:npg_nqiwTbu9JW8c@ep-blue-dawn-b4muaxvp.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require";
const SUPABASE_URL = "https://gheplthcqqsjfcfruleb.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZXBsdGhjcXFzamZjZnJ1bGViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2OTg3NzAsImV4cCI6MjEwNjI3NDc3MH0.vF5BiMP6D6v09VaJj9AI674w8S2XKp1r6kR3N9XV9L4";
const BUCKET = "whatsapp-session";

console.log("=================================================");
console.log("?? INICIANDO AUDITORIA DE CREDENCIALES Y ACCESOS");
console.log("=================================================");

async function auditar() {
  // 1. SUPABASE
  console.log("\n--- 1. AUDITORIA DE SUPABASE STORAGE ---");
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  
  try {
    const { data: buckets, error: bErr } = await supabase.storage.listBuckets();
    if (bErr) throw bErr;
    console.log("? Conexion con Supabase: EXITOSA");
    console.log("?? Buckets encontrados:", buckets.map(b => b.name));

    const existeBucket = buckets.some(b => b.name === BUCKET);
    if (!existeBucket) {
      console.log(`?? ALERTA: El bucket "${BUCKET}" NO existe. Creandolo...`);
      const { error: cErr } = await supabase.storage.createBucket(BUCKET, { public: false });
      if (cErr) console.error("Error al crear bucket:", cErr.message);
      else console.log(`? Bucket "${BUCKET}" creado exitosamente.`);
    } else {
      console.log(`? Bucket "${BUCKET}" existe.`);
    }

    // Listar contenido actual
    const { data: files, error: fErr } = await supabase.storage.from(BUCKET).list("", { limit: 10 });
    if (fErr) throw fErr;
    console.log(`?? Archivos actuales en "${BUCKET}":`, files.length > 0 ? files.map(f => f.name) : "(Bucket vacio)");

    // Prueba de escritura
    const testBuffer = Buffer.from("ping keepalive mobadent");
    const { error: upErr } = await supabase.storage.from(BUCKET).upload("test_ping.txt", testBuffer, { upsert: true });
    if (upErr) throw upErr;
    console.log("? Permiso de subida (WRITE) en Supabase: CONFIRMADO");

  } catch (err) {
    console.error("? Fallo en Supabase:", err.message);
  }

  // 2. NEON POSTGRESQL
  console.log("\n--- 2. AUDITORIA DE NEON POSTGRESQL ---");
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    const res = await pool.query("SELECT id, doctor_nombre, telefono, saldo_pendiente FROM cuentas_doctores;");
    console.log("? Conexion con Neon: EXITOSA");
    console.log(`?? Total doctores registrados: ${res.rows.length}`);
    console.table(res.rows);

    // Consulta con Regex del bot
    const telPrueba = "79326149972";
    const resRegex = await pool.query(`
      SELECT doctor_nombre, trato, saldo_pendiente, telefono
      FROM cuentas_doctores
      WHERE 
        REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') LIKE $1
        OR REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') = $2
      LIMIT 1;
    `, ["%26149972", telPrueba]);

    if (resRegex.rows.length > 0) {
      console.log("? Consulta Regex de Cartera: EXITOSA (Emparejo al Dr./Dra.):", resRegex.rows[0].doctor_nombre);
    } else {
      console.log("? No hubo coincidencia en Neon con los digitos probados.");
    }

    await pool.end();
  } catch (err) {
    console.error("? Fallo en Neon:", err.message);
  }

  console.log("\n=================================================");
  console.log("?? AUDITORIA FINALIZADA");
  console.log("=================================================");
}

auditar();
