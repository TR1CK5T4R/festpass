// BullMQ consumers (hold expiry, tickets, emails) are added from Day 13.
// Until then this timer only keeps the process alive so shutdown handling can be tested.
const keepAlive = setInterval(() => {}, 60_000);

console.log('worker started');

function shutdown(signal: NodeJS.Signals) {
  console.log(`worker received ${signal}, shutting down`);
  clearInterval(keepAlive);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
