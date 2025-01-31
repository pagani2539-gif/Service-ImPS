const WebSocket = require('ws');

let ws;
const WS_URL = process.env.WS_SERVER_URL || 'ws://localhost:4000/vehicle/receive';

// Initialize WebSocket connection
function initializeWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log(`WebSocket connected to ${WS_URL}`);
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed. Reconnecting...',WS_URL);
    setTimeout(initializeWebSocket, 5000); // Retry connection after 5 seconds
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
}

// Send data to WebSocket server
function sendToWebSocket(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('WebSocket is not connected. Cannot send data.');
    return;
  }

  try {
    ws.send(JSON.stringify(data));
    console.log('Data sent to WebSocket:', data);
  } catch (error) {
    console.error('Error sending data to WebSocket:', error.message);
  }
}

// Initialize WebSocket connection on load
initializeWebSocket();

module.exports = {
  sendToWebSocket,
};
