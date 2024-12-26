const mysql = require('mysql2');

let pool;

function createPool() {
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 0, // No limit on the number of connections
        queueLimit: 0, // No limit on the queue size
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

    return pool.promise();
}

module.exports = createPool();
