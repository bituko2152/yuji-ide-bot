// One-time Steam login to give the bot read access to the game's leaderboards.
// Run it YOURSELF on your PC, from the project folder:  node scripts/steamLogin.js
// It asks for your username and password (typed here, never stored). Then
// approve the login in the Steam mobile app (tap Accept), or type a Steam
// Guard code if you prefer. Only a login token (STEAM_REFRESH_TOKEN) is
// written into .env, which is git-ignored. Copy that line into the bot's .env
// on Wispbyte.
//
// Uses steam-session directly: unlike steam-user's password login, it waits
// for the "Accept" in the mobile app instead of requiring a code.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = require('steam-session');

const ENV_FILE = path.join(__dirname, '../.env');

// One single readline for the whole run (re-creating it on Windows can
// leave stdin closed and make Node exit silently).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let hideInput = false;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = s => write(hideInput && !s.startsWith('\r') && !s.includes(':') ? '*' : s);

function ask(question, { hidden = false } = {}) {
    return new Promise(resolve => {
        hideInput = hidden;
        rl.question(question, answer => {
            hideInput = false;
            resolve(answer.trim());
        });
    });
}

function saveToken(token) {
    let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
    env = env.replace(/^STEAM_REFRESH_TOKEN=.*\r?\n?/m, '');
    if (env && !env.endsWith('\n')) env += '\n';
    fs.writeFileSync(ENV_FILE, `${env}STEAM_REFRESH_TOKEN=${token}\n`);
}

function finish(code) {
    rl.close();
    setTimeout(() => process.exit(code), 300);
}

(async () => {
    const accountName = await ask('Steam username: ');
    const password = await ask('Steam password (hidden): ', { hidden: true });

    // SteamClient platform: the token is the one steam-user (the bot) logs in with.
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    session.loginTimeout = 5 * 60 * 1000;

    session.on('authenticated', () => {
        saveToken(session.refreshToken);
        console.log('\n✅ Logged in. STEAM_REFRESH_TOKEN saved to .env (git-ignored).');
        console.log('   Copy that line to the bot\'s .env on Wispbyte. Never share it or commit it.');
        finish(0);
    });
    session.on('timeout', () => {
        console.error('\n❌ Timed out waiting for the approval. Run the script again.');
        finish(1);
    });
    session.on('error', err => {
        console.error('\n❌ Login failed:', err.message);
        finish(1);
    });

    console.log('🔐 Logging in...');
    let start;
    try {
        start = await session.startWithCredentials({ accountName, password });
    } catch (err) {
        console.error('\n❌ Login failed:', err.message);
        return finish(1);
    }
    if (!start.actionRequired) return; // no Steam Guard at all: 'authenticated' fires on its own

    const types = start.validActions.map(a => a.type);
    if (types.includes(EAuthSessionGuardType.DeviceConfirmation)) {
        console.log('📱 Open the Steam mobile app and tap Accept on the login request. Waiting...');
    }
    if (types.includes(EAuthSessionGuardType.EmailConfirmation)) {
        console.log('📧 Open the link in the email Steam sent you. Waiting...');
    }

    const needsCode = types.includes(EAuthSessionGuardType.DeviceCode) || types.includes(EAuthSessionGuardType.EmailCode);
    if (needsCode) {
        const code = await ask('(Optional) Steam Guard code — or just approve in the app and leave this alone: ');
        if (code) {
            await session.submitSteamGuardCode(code).catch(err => {
                console.error('❌ Code rejected:', err.message);
                finish(1);
            });
        }
    }
})();
