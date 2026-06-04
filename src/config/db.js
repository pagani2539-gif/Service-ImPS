const mysql = require('mysql2');

let pool;

async function ensureConfigurationSchema(promisePool) {
    try {
        await promisePool.query("ALTER TABLE configuration ADD COLUMN retention_days INT DEFAULT 3");
        console.log("[DB Schema] Checked/Added column retention_days to configuration");
    } catch (err) {
        if (err.errno !== 1060 && err.code !== 'ER_DUP_FIELDNAME') {
            console.error("[DB Schema] Error checking retention_days:", err.message);
        }
    }

    try {
        await promisePool.query("ALTER TABLE configuration ADD COLUMN straddling_time_diff INT DEFAULT 3");
        console.log("[DB Schema] Checked/Added column straddling_time_diff to configuration");
    } catch (err) {
        if (err.errno !== 1060 && err.code !== 'ER_DUP_FIELDNAME') {
            console.error("[DB Schema] Error checking straddling_time_diff:", err.message);
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
        console.log('Database connection established');
    });

    pool.on('error', (err) => {
        console.error('Database error:', err.code);
        if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
            console.log('Attempting to reconnect to the database...');
            createPool(); // Recreate the pool
        } else {
            throw err;
        }
    });

    const promisePool = pool.promise();
    promisePool.dbInitializedPromise = ensureConfigurationSchema(promisePool).catch((err) => {
        console.error("[DB Schema] Initialization failed:", err);
    });

    return promisePool;
}

module.exports = createPool();
