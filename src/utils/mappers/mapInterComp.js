// Mapping logic for InterComp
function mapInterComp(rawData, station) {
    return {
      id: rawData.id,
      lane: "TH" + rawData.channel,
      stamp: new Date(rawData.timestamp),
      triggerType: rawData.TriggerType,
      eventId: rawData["event-id"],
      stationID: parseInt(station.stationID || 0),
      station: {
        stationName: station.stationName || "Unknown",
        stationID: parseInt(station.stationID || 0),
        stationIP: station.host || "0.0.0.0",
      },
    };
  }
  
  module.exports = mapInterComp;
  