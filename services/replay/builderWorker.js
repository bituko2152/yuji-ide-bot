const { parentPort, workerData } = require('worker_threads');
const { buildReplayData } = require('./builder');

// Takes seconds of CPU on a long race: on its own thread, so the bot keeps
// answering (buttons, commands, a running mock lobby) meanwhile.
try {
    parentPort.postMessage({ data: buildReplayData(workerData.rec, { qualifying: workerData.qualifying }) });
} catch (err) {
    parentPort.postMessage({ error: err.message });
}
