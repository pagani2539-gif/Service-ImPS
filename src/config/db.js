const mysql = require('mysql2');
const perfMonitor = require('../utils/perfMonitor');
const logger = require('../utils/logger');

let pool;

async function ensureConfigurationSchema(promisePool) {
    try {
        await promisePool.query("ALTER TABLE configuration ADD COLUMN retention_days INT DEFAULT 3");
        logger.info("[DB Schema] Checked/Added column retention_days to configuration");
    } catch (err) {
        if (err.errno !== 1060 && err.code !== 'ER_DUP_FIELDNAME') {
            logger.error("[DB Schema] Error checking retention_days:", err.message);
        }
    }

    try {
        await promisePool.query("ALTER TABLE configuration ADD COLUMN straddling_time_diff INT DEFAULT 3");
        logger.info("[DB Schema] Checked/Added column straddling_time_diff to configuration");
    } catch (err) {
        if (err.errno !== 1060 && err.code !== 'ER_DUP_FIELDNAME') {
            logger.error("[DB Schema] Error checking straddling_time_diff:", err.message);
        }
    }

    // Add new dynamic matching/metrics configuration columns
    const columns = [
        { name: "snap_match_db_poll_ms", definition: "INT DEFAULT 1000" },
        { name: "snap_match_max_wait_ms", definition: "INT DEFAULT 3000" },
        { name: "trigger_history_window_ms", definition: "INT DEFAULT 3000" },
        { name: "metrics_interval_ms", definition: "INT DEFAULT 300000" },
        { name: "metrics_format", definition: "VARCHAR(50) DEFAULT 'pretty'" },
        // เกณฑ์จับคู่รถคร่อมเลน — ปรับค่าได้หน้างานผ่าน DB (default = ค่าแนะนำ)
        { name: "straddling_axle_tol", definition: "INT DEFAULT 3" },
        { name: "straddling_speed_diff", definition: "INT DEFAULT 15" },
        { name: "straddling_wheelbase_diff", definition: "INT DEFAULT 30" },
        { name: "straddling_zero_kg", definition: "INT DEFAULT 100" },
        // โซนขอบถนน/เกาะกลางต่อเลน (JSON array) สำหรับ mirror รถไหลทาง — ว่าง = ปิดฟีเจอร์
        { name: "mirror_edge_zones", definition: "TEXT" }
    ];

    for (const col of columns) {
        try {
            await promisePool.query(`ALTER TABLE configuration ADD COLUMN ${col.name} ${col.definition}`);
            logger.info(`[DB Schema] Checked/Added column ${col.name} to configuration`);
        } catch (err) {
            if (err.errno !== 1060 && err.code !== 'ER_DUP_FIELDNAME') {
                logger.error(`[DB Schema] Error checking column ${col.name}: ${err.message}`);
            }
        }
    }
}

function createPool() {
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 50, // Safe default connection limit
        queueLimit: Number(process.env.DB_QUEUE_LIMIT) || 0, // 0 means unlimited queue size
    });

    pool.on('connection', (connection) => {
        logger.info('Database connection established');
    });

    // มี query ต้องรอคิว connection — ถ้าตัวเลขนี้ขึ้นบ่อยใน [Metrics] แปลว่า pool อิ่มตัว
    pool.on('enqueue', () => {
        perfMonitor.count('db_pool_enqueue');
    });

    pool.on('error', (err) => {
        // pool ของ mysql2 จัดการ connection หายรายตัวเอง (ทิ้งตัวที่เสีย + สร้างใหม่ตอน getConnection)
        // เดิม createPool() สร้าง pool ใหม่ใส่ตัวแปร local แต่ module.exports คืน promisePool "ตัวแรก" ไปแล้ว
        // → consumer ทุกตัวยังถือ pool เก่าที่ตาย (orphan) ; และ throw = uncaught → process crash
        // จึงแค่ log อย่างเดียว ไม่ recreate/ไม่ throw → pool เดิมฟื้นเองเมื่อ DB กลับมา
        logger.error('Database pool error:', err && err.code);
    });

    const promisePool = pool.promise();
    promisePool.dbInitializedPromise = ensureConfigurationSchema(promisePool).catch((err) => {
        logger.error("[DB Schema] Initialization failed:", err);
    });

    return promisePool;
}

module.exports = createPool();
