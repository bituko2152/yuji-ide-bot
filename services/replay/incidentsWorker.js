const { parentPort, workerData } = require('worker_threads');
const { parseReplay, detectIncidents } = require('./incidents');

// Takes seconds: on its own thread, so the bot (and a running mock lobby) doesn't stall.
const data = parseReplay(workerData);
if (!data?.cars) parentPort.postMessage({ error: '❌ That file has no replay data.' });
else if (data.session !== 'race') parentPort.postMessage({ error: '❌ This only works on race replays, not qualifying.' });
else parentPort.postMessage({ result: detectIncidents(data) });
