# Yuji Ide — Discord bot

Bot for the Ultimate Racing 2D 2 league community. Node.js + discord.js v14.

## Run

```
npm install
node index.js
```

Needs a `.env` (never committed):

| Variable | Used by |
|---|---|
| `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` | Bot login and slash command registration |
| `STEAM_REFRESH_TOKEN` | `/record` leaderboards (create with `node scripts/steamLogin.js`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | `/results upload` |

Server-specific settings (channels, roles, leagues) live in `config.json`.

## Layout

```
index.js            Starts the bot: loads commands, starts every service, routes buttons/menus
config.json         Channels, roles and per-feature settings
commands/           One file per slash command
services/
  core/             Shared: button/menu router, cleanup, bot presence, Supabase client
  reports/          Race reports and steward polls
  contracts/        Driver contracts
  starters/         Weekly starters board (/attend), race-day close times
  results/          /results listen (live lobby watcher) and /results upload (CSV -> Supabase)
  replay/           Race replay posted with the race CSV: recorder -> builder -> assets (Steam) -> render
                    (the page is assets/replay/template.html — edit it there; track/car cache in data/replay-cache)
  steam/            UR2D2 lobby list, Steam news + sales, leaderboards (/record), profiles
scripts/            One-off tools (steamLogin.js)
assets/fonts/       Fonts for the generated images
data/               Runtime state written by the bot (not in git)
```

## Where to change things

| I want to… | File |
|---|---|
| Add a slash command | new file in `commands/` (loaded automatically) |
| Add a button / select menu | `services/core/buttonHandler.js` |
| Change who can use a command | `config.json` |
| Lobby list message | `services/steam/lobbyService.js` |
| Steam news and sales | `services/steam/newsService.js` |
| Results upload preview / saving | `services/results/resultsUpload.js` |
| Starters board image | `services/starters/starterBoard.js` |

Prototypes (race replay, ideal racing line, packet analysis) are kept outside the repo, in `Documents/BotReports-Lab`.
