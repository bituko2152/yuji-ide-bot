const pollStore = require('./pollStore');
const contractStore = require('./contractStore');

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // run once a day is plenty

/**
 * Deletes poll and contract records older than 15 days from disk.
 * The original Discord messages are left untouched — they just become
 * inert (buttons won't respond anymore), which is fine since by then
 * the report/contract is long resolved either way.
 */
function cleanupOldData() {
    const now = Date.now();

    const polls = pollStore.readAll();
    const stalePollIds = Object.entries(polls)
        .filter(([, p]) => p.createdAt && now - p.createdAt > FIFTEEN_DAYS_MS)
        .map(([id]) => id);
    if (stalePollIds.length) {
        pollStore.deletePolls(stalePollIds);
        console.log(`🧹 [Cleanup] Removed ${stalePollIds.length} poll(s) older than 15 days.`);
    }

    const contracts = contractStore.allContracts();
    const staleContractIds = Object.entries(contracts)
        .filter(([, c]) => c.createdAt && now - c.createdAt > FIFTEEN_DAYS_MS)
        .map(([id]) => id);
    if (staleContractIds.length) {
        contractStore.deleteContracts(staleContractIds);
        console.log(`🧹 [Cleanup] Removed ${staleContractIds.length} contract(s) older than 15 days.`);
    }
}

function startCleanupLoop() {
    // A cleanup problem must never take the whole bot down.
    const run = () => {
        try { cleanupOldData(); }
        catch (err) { console.error('❌ [Cleanup]', err.message); }
    };
    run();
    setInterval(run, CHECK_INTERVAL_MS);
}

module.exports = { startCleanupLoop };