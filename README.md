# Private Discord Music Bot

A beginner-friendly Discord music bot for one private server, built with `discord.js` and `DisTube`.

## What This Bot Can Do

- Join your voice channel automatically when you use `/play`
- Play from YouTube and SoundCloud links or search text
- Respect saved timestamps on direct YouTube links like `?t=1m30s` or `&start=90`, with an option to ignore them
- Accept Spotify **track** links and match them to a playable source
- Show one shared "now playing" message with buttons for pause/resume, skip, `-10s`, `+10s`, and stop
- Show a small Spotify-style album-art preview on the player card when artwork is available
- Show the current playback time update every few seconds on the player card to keep Discord updates lightweight
- Show who requested each queued song and who last queued or skipped something on the shared player
- Show a read-only `/history` list of songs that started playing in the last 30 days, including who queued them, which platform they came from, and when they were queued
- Open a shared queue manager from the player card with `Show Queue`, then move or remove upcoming songs
- Redisplay the shared player in a different text channel with `/player`
- Manage the queue with slash commands like `/queue`, `/shuffle`, `/remove`, and `/clear`

## Important Notes

- This bot is designed for **one private server** and runs on **your own Windows PC**.
- Queue data only lives in memory. Restarting the bot clears the queue.
- Playback history is saved in a local SQLite database and kept for 30 days, so `/history` survives normal bot restarts.
- Spotify support in this version is for **track links only**. Album, playlist, and artist links are intentionally blocked for now.
- The project uses `ffmpeg-static`, so it does not depend on a separate FFmpeg install to play audio.
- YouTube playback is handled through a bundled `yt-dlp` binary that is installed with `npm install`.

## 1. Install What You Need

Node.js is already installed on this machine during setup for this project. If you ever need to reinstall it, use the current Node LTS release from [nodejs.org](https://nodejs.org/en/download/).

## 2. Create Your Discord Bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a new application.
3. Open the **Bot** tab and create a bot user.
4. Copy the bot token. You will place it in `.env`.
5. Under **OAuth2 > URL Generator**:
   - Select the `bot` and `applications.commands` scopes.
   - Give the bot at least these permissions:
     - `View Channels`
     - `Send Messages`
     - `Use Slash Commands`
     - `Connect`
     - `Speak`
     - `Read Message History`
6. Open the generated URL in your browser and invite the bot to your private server.

## 3. Find Your IDs

- `CLIENT_ID`: from **General Information** in the Discord Developer Portal
- `DISCORD_TOKEN`: from the **Bot** tab
- `GUILD_ID`: your private Discord server ID

If you do not see server IDs in Discord, enable **Developer Mode** in Discord settings first.

## 4. Fill In Your `.env` File

1. Copy `.env.example` to a new file named `.env`.
2. Fill in the required values:

```env
DISCORD_TOKEN=your-discord-bot-token
CLIENT_ID=your-discord-application-client-id
GUILD_ID=your-private-server-id
```

Spotify credentials are optional, but they improve Spotify track-link support:

```env
SPOTIFY_CLIENT_ID=your-spotify-client-id
SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
SPOTIFY_TOP_TRACKS_COUNTRY=US
```

To create Spotify credentials:

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/).
2. Create an app.
3. Copy the client ID and client secret into `.env`.

## 5. Install Dependencies

From this project folder, run:

```powershell
& "$env:ProgramFiles\nodejs\npm.cmd" install
```

## 6. Register Slash Commands

Run:

```powershell
& "$env:ProgramFiles\nodejs\npm.cmd" run deploy-commands
```

This registers the slash commands for your one private server, so updates appear quickly.

## 7. Start The Bot

Run:

```powershell
& "$env:ProgramFiles\nodejs\npm.cmd" start
```

If everything is working, the terminal will print the bot account name after login.

## Slash Commands

- `/play query [use_link_timestamp]`
- `/player`
- `/queue`
- `/history`
- `/nowplaying`
- `/pause`
- `/resume`
- `/skip`
- `/stop`
- `/leave`
- `/seek time`
- `/shuffle`
- `/remove index`
- `/clear`

## How The Controls Work

- Slash commands and player buttons only work for users in the **same voice channel as the bot**
- `/player` moves the shared player message to the channel where you used the command
- `/queue` shows the current song and the next 10 songs only
- The shared player and queue views show who requested songs, plus the most recent queue or skip action
- The player card has a `Loop` button that cycles `Off -> 1 -> 2 -> 3 -> 4 -> 5 -> Off` for the current song only
- `/history` shows saved playback history from the last 30 days, newest first
- `Show Queue` replaces the player card with a queue manager for the next 5 upcoming songs on the current page
- The queue manager lets you select one upcoming song at a time, move it up, move it down, move it to the top, remove it, and go back to the player card
- `/clear` removes upcoming songs but keeps the current song playing
- `/stop` stops playback and clears the queue
- `/leave` disconnects the bot from voice

## Troubleshooting

### PowerShell says scripts are disabled

Use `npm.cmd` exactly as shown above instead of plain `npm`.

### The bot joins but does not play sound

- Make sure the bot has permission to **Connect** and **Speak**
- Make sure no one server-muted the bot
- Restart the bot after changing permissions

### Spotify links do not work

- Add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to `.env`
- Try a **track** link, not a playlist or album

### YouTube or SoundCloud suddenly stop working

Music-source sites change over time. If playback breaks later, update dependencies first:

```powershell
& "$env:ProgramFiles\nodejs\npm.cmd" install
```

That command also refreshes the bundled `yt-dlp` binary used for YouTube playback.

## Deploy To An Ubuntu VPS

This repo includes a GitHub Actions workflow that deploys the bot to `/opt/lizzo` on pushes to `main`. The deploy keeps secrets and playback history out of git, writes the production `.env` from GitHub Secrets, installs dependencies on the VPS, registers slash commands, and restarts `lizzo-bot.service`.

### One-Time VPS Setup

Install Node.js `>=24.14.1`, npm, rsync, and systemd support on the VPS. Then create the dedicated deploy/runtime user and app directory:

```bash
sudo useradd --system --create-home --shell /bin/bash --user-group lizzo
sudo mkdir -p /opt/lizzo
sudo chown -R lizzo:lizzo /opt/lizzo
```

Generate an SSH key for GitHub Actions, then add its public key to the VPS:

```bash
sudo install -d -m 700 -o lizzo -g lizzo /home/lizzo/.ssh
echo "PASTE_GITHUB_ACTIONS_PUBLIC_KEY_HERE" | sudo tee -a /home/lizzo/.ssh/authorized_keys
sudo chown lizzo:lizzo /home/lizzo/.ssh/authorized_keys
sudo chmod 600 /home/lizzo/.ssh/authorized_keys
```

From this project on your computer, copy the service file to the VPS:

```bash
scp -P 22 deploy/lizzo-bot.service your-admin-user@your-vps-host:/tmp/lizzo-bot.service
```

Then install it on the VPS:

```bash
sudo install -m 644 /tmp/lizzo-bot.service /etc/systemd/system/lizzo-bot.service
sudo systemctl daemon-reload
sudo systemctl enable lizzo-bot.service
```

Allow the `lizzo` user to restart and check only this service from GitHub Actions:

```bash
sudo visudo -f /etc/sudoers.d/lizzo-bot
```

Add this line:

```sudoers
lizzo ALL=(root) NOPASSWD: /usr/bin/systemctl restart lizzo-bot.service, /usr/bin/systemctl is-active --quiet lizzo-bot.service, /usr/bin/systemctl status lizzo-bot.service
```

### GitHub Secrets

Add these repository secrets before running the workflow:

- `VPS_HOST`: VPS hostname or IP address.
- `VPS_PORT`: SSH port, usually `22`.
- `VPS_USER`: `lizzo`.
- `VPS_SSH_KEY`: private SSH key for GitHub Actions.
- `VPS_KNOWN_HOSTS`: trusted known_hosts entry for the VPS.
- `PRODUCTION_ENV`: full production `.env` contents, including `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, and any optional Spotify or SoundCloud values.

You can create the known_hosts value from your computer with:

```bash
ssh-keyscan -p 22 your-vps-hostname-or-ip
```

### Deploy Flow

On every push to `main`, `.github/workflows/deploy.yml`:

- Runs `npm ci` and `npm run check` on GitHub.
- Rsyncs the repo to `/opt/lizzo/` with `--delete`.
- Excludes `.git/`, `node_modules/`, `.env`, `.env.*`, and `data/`.
- Writes `PRODUCTION_ENV` to `/opt/lizzo/.env` with mode `600`.
- Ensures `/opt/lizzo/data` exists so `play-history.sqlite` survives deploys.
- Runs `npm ci --omit=dev`, `npm run deploy-commands`, and restarts `lizzo-bot.service`.

Check the service after a deploy with:

```bash
sudo systemctl status lizzo-bot.service
sudo journalctl -u lizzo-bot.service -n 50 --no-pager
```
