// scripts/migrate.js — создание таблиц и индексов схемы записи.
// Запускается ОДИН РАЗ при поднятии чистой БД (клонирование, перенос на хостинг).
// Идемпотентен: повторный запуск не падает и не создаёт дублей объектов.
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log("Migrating schema...");

  // Таблица пользователей (Telegram ID + имя клиента)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_user_id BIGINT UNIQUE NOT NULL,
      first_name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Таблица услуг (название, описание, цена, длительность)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // График работы салона (дни недели, часы открытия/закрытия, перерыв)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS working_hours (
      id SERIAL PRIMARY KEY,
      weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=вс, 1=пн, ..., 6=сб
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      break_start TIME,
      break_end TIME,
      is_working_day BOOLEAN DEFAULT TRUE,
      UNIQUE (weekday)
    );
  `);

  // Брони клиентов (услуга, время начала/конца, статус, комментарий)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      service_id INTEGER REFERENCES services(id) ON DELETE RESTRICT,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
      comment TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Журнал доставок напоминаний (тип 24h/2h, попытки, ошибки)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminder_log (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      reminder_type TEXT NOT NULL,            -- '24h' или '2h'
      status TEXT NOT NULL DEFAULT 'failed',  -- 'sent' | 'failed'
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // === ИНДЕКСЫ ЗАЩИТЫ ОТ ДУБЛЕЙ ===

  // Уникальный индекс активной брони на слот: два клиента не могут занять одно кресло одновременно.
  // WHERE ограничивает проверку только активными статусами (pending/confirmed), отменённые игнорируются.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_slot
    ON bookings (service_id, starts_at)
    WHERE status IN ('pending', 'confirmed');
  `);

  // Уникальный индекс пары (бронь, тип напоминания): одна бронь получает максимум одно напоминание каждого типа.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_reminder
    ON reminder_log (booking_id, reminder_type);
  `);
  // Платежи (Модуль 6, 17.10): журнал платежей, привязанный к броням.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
      status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','succeeded','failed')),
      provider_ref TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      succeeded_at TIMESTAMPTZ
    );
  `);
  // Эволюция схемы: новая колонка на СТАРОЙ таблице — идемпотентно через IF NOT EXISTS.
  await pool.query(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_paid BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log("Migration complete.");
}

main()
  .then(async () => { await pool.end(); })
  .catch(async (e) => { 
    console.error("Migration failed:", e.message); 
    await pool.end(); 
    process.exit(1); 
  });