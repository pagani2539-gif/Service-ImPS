const axios = require('axios');


async function getSingleDualTire(PICO_BASE, start_ms, end_ms, id) {
    try {
        console.log('getSingleDualTire')
        // แปลง string → number แล้วปรับช่วงเวลา
        const start = Number(start_ms) - 500;
        const end = Number(end_ms) + 500;
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
