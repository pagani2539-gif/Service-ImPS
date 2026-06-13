const axios = require('axios');
const logger = require('../utils/logger');


async function getSingleDualTire(PICO_BASE, start_ms, end_ms, id) {
    try {
        logger.debug('getSingleDualTire');
        const response = await axios.get(`${PICO_BASE}/wheel-type`, {
            params: {
                chanel: 'A',
                start: start_ms,
                end: end_ms,
                id: id
            },
            timeout: 3000
        });

        return response.data; // return เฉพาะ data
    } catch (error) {
        // console.error("Error fetching wheel-type:", error.message);
        return []
    }
}

module.exports = { getSingleDualTire }
