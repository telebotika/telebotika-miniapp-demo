// scripts/seed.js — заполнение базовыми данными (услуги, график работы).
// Запускается ПОСЛЕ migrate.js на чистой БД. Идемпотентен благодаря ON CONFLICT DO NOTHING.
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log("Seeding initial data...");

  // === УСЛУГИ ДЕМО-САЛОНА ===
  // Меняются при клонировании под другого мастера (репетитор, юрист, тренер).
  const services = [
    { name: "Маникюр классический", description: null, price: 1500, duration_minutes: 60, sort_order: 1 },
    { name: "Покрытие гель-лак", description: null, price: 2500, duration_minutes: 90, sort_order: 2 },
    { name: "Дизайн ногтей", description: null, price: 500, duration_minutes: 30, sort_order: 3 },
  ];

  for (const svc of services) {
    // INSERT ... ON CONFLICT DO NOTHING: если услуга с таким именем уже есть, пропускаем вставку молча.
    // Для полной надёжности здесь стоило бы указать конкретный столбец конфликта (например, UNIQUE(name)),
    // но так как в схеме services нет уникального индекса по имени, используем простой подход:
    // сначала проверяем наличие, потом вставляем. Это медленнее, но безопаснее для демо.
    const exists = await pool.query(
      `SELECT 1 FROM services WHERE name = $1 LIMIT 1`,
      [svc.name]
    );

    if (exists.rows.length === 0) {
      await pool.query(
        `INSERT INTO services (name, description, price, duration_minutes, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [svc.name, svc.description, svc.price, svc.duration_minutes, svc.sort_order]
      );
      console.log(`Added service: ${svc.name}`);
    } else {
      console.log(`Service already exists: ${svc.name}`);
    }
  }

  // === ГРАФИК РАБОТЫ (ПН–ВС) ===
  // weekday: 0=воскресенье, 1=понедельник, ..., 6=суббота (стандарт JS Date.getDay()).
  // Рабочие дни: ПН–ПТ (1–5), выходные: СБ–ВС (6, 0).
  // Перерыв: 14:00–15:00 ежедневно в рабочие дни.
  const schedule = [
    // Воскресенье (выходной)
    { weekday: 0, start_time: "10:00", end_time: "20:00", break_start: null, break_end: null, is_working_day: false },
    // Понедельник – Пятница (рабочие дни)
    { weekday: 1, start_time: "10:00", end_time: "20:00", break_start: "14:00", break_end: "15:00", is_working_day: true },
    { weekday: 2, start_time: "10:00", end_time: "20:00", break_start: "14:00", break_end: "15:00", is_working_day: true },
    { weekday: 3, start_time: "10:00", end_time: "20:00", break_start: "14:00", break_end: "15:00", is_working_day: true },
    { weekday: 4, start_time: "10:00", end_time: "20:00", break_start: "14:00", break_end: "15:00", is_working_day: true },
    { weekday: 5, start_time: "10:00", end_time: "20:00", break_start: "14:00", break_end: "15:00", is_working_day: true },
    // Суббота (выходной)
    { weekday: 6, start_time: "10:00", end_time: "20:00", break_start: null, break_end: null, is_working_day: false },
  ];

  for (const day of schedule) {
    // Аналогично услугам: проверяем существование перед вставкой.
    const exists = await pool.query(
      `SELECT 1 FROM working_hours WHERE weekday = $1 LIMIT 1`,
      [day.weekday]
    );

    if (exists.rows.length === 0) {
      await pool.query(
        `INSERT INTO working_hours (weekday, start_time, end_time, break_start, break_end, is_working_day)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [day.weekday, day.start_time, day.end_time, day.break_start, day.break_end, day.is_working_day]
      );
      console.log(`Added schedule for weekday ${day.weekday}`);
    } else {
      console.log(`Schedule already exists for weekday ${day.weekday}`);
    }
  }

  console.log("Seed complete.");
}

main()
  .then(async () => { await pool.end(); })
  .catch(async (e) => { 
    console.error("Seed failed:", e.message); 
    await pool.end(); 
    process.exit(1); 
  });