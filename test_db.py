import psycopg2

conn_str = "postgresql://neondb_owner:npg_nqiwTbu9JW8c@ep-blue-dawn-b4muaxvp.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require"

try:
    conn = psycopg2.connect(conn_str)
    cur = conn.cursor()

    print("--- 1. TODOS LOS REGISTROS EN CUENTAS_DOCTORES ---")
    cur.execute("SELECT id, doctor_nombre, telefono, saldo_pendiente FROM cuentas_doctores;")
    registros = cur.fetchall()
    for r in registros:
        print(f"ID: {r[0]} | Doctor: {r[1]} | Telefono original: {r[2]} | Saldo: {r[3]}")

    print("\n--- 2. PRUEBA DE COINCIDENCIA CON TU NUMERO (+79326149972) ---")
    # Prueba 1: Coincidencia por ultimos 8 digitos (26149972)
    cur.execute("SELECT id, doctor_nombre, telefono FROM cuentas_doctores WHERE REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') LIKE '%26149972';")
    res8 = cur.fetchall()
    print("Coincidencia con ultimos 8 digitos (26149972):", res8)

    # Prueba 2: Coincidencia por numero completo sin caracteres especiales
    cur.execute("SELECT id, doctor_nombre, telefono FROM cuentas_doctores WHERE REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') = '79326149972';")
    res_full = cur.fetchall()
    print("Coincidencia con numero completo (79326149972):", res_full)

    cur.close()
    conn.close()

except Exception as e:
    print("Error conectando a Neon:", e)
