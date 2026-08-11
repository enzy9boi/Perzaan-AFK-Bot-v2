const mineflayer = require('mineflayer')
const express = require('express')
const fs = require('fs')
const path = require('path')

let pathfinder = null

try {
    const { pathfinder: pf } = require('mineflayer-pathfinder')
    pathfinder = pf
} catch (err) {
    console.log('[WARN] mineflayer-pathfinder could not be loaded')
}

const setupLeaveRejoin = require('./leaveRejoin')

const SETTINGS_FILE = path.join(__dirname, 'settings.json')
const ACCOUNTS_FILE = path.join(__dirname, 'launcher_accounts.json')

const PORT = Number(process.env.PORT || 3000)

let settings = {}
let accounts = []
let bots = new Map()

let server = null

function loadJSON(file, fallback = {}) {
    try {
        if (!fs.existsSync(file)) {
            return fallback
        }

        const raw = fs.readFileSync(file, 'utf8').trim()

        if (!raw) {
            return fallback
        }

        return JSON.parse(raw)
    } catch (err) {
        console.log(`[CONFIG] Failed to read ${file}: ${err.message}`)
        return fallback
    }
}

function loadConfig() {
    settings = loadJSON(SETTINGS_FILE, {})
    const launcher = loadJSON(ACCOUNTS_FILE, { accounts: [] })

    /*
     * Supports several possible account formats so the bot
     * remains compatible with different versions of the repository.
     */

    if (Array.isArray(settings.accounts) && settings.accounts.length) {
        accounts = settings.accounts
    } else if (Array.isArray(launcher.accounts) && launcher.accounts.length) {
        accounts = launcher.accounts
    } else {
        accounts = []
    }
}

function getSetting(...keys) {
    for (const key of keys) {
        if (
            settings &&
            settings[key] !== undefined &&
            settings[key] !== null &&
            settings[key] !== ''
        ) {
            return settings[key]
        }
    }

    return undefined
}

function getServerHost() {
    return (
        process.env.MC_HOST ||
        process.env.SERVER_HOST ||
        getSetting(
            'host',
            'server',
            'serverHost',
            'serverIp',
            'ip',
            'address'
        ) ||
        'localhost'
    )
}

function getServerPort() {
    return Number(
        process.env.MC_PORT ||
        process.env.SERVER_PORT ||
        getSetting(
            'port',
            'serverPort',
            'server_port'
        ) ||
        25565
    )
}

function getVersion(account) {
    return (
        account.version ||
        getSetting('version', 'minecraftVersion', 'mcVersion') ||
        false
    )
}

function getAuthType(account) {
    return (
        account.auth ||
        account.authMode ||
        getSetting('auth', 'authMode') ||
        'offline'
    )
}

function getUsername(account, index) {
    return (
        account.username ||
        account.name ||
        account.email ||
        process.env.MC_USERNAME ||
        process.env.MINECRAFT_USERNAME ||
        getSetting('username', 'name') ||
        `AFKBot${index + 1}`
    )
}

function getPassword(account) {
    return (
        account.password ||
        process.env.MC_PASSWORD ||
        process.env.MINECRAFT_PASSWORD ||
        getSetting('password')
    )
}

function getHostAndPort() {
    return {
        host: getServerHost(),
        port: getServerPort()
    }
}

function createBot(account = {}, index = 0) {
    const botId = String(
        account.id ||
        account.username ||
        account.name ||
        `bot-${index + 1}`
    )

    if (bots.has(botId)) {
        const oldBot = bots.get(botId)

        try {
            oldBot.removeAllListeners()
            oldBot.quit()
        } catch (_) {}

        bots.delete(botId)
    }

    const { host, port } = getHostAndPort()

    const username = getUsername(account, index)
    const auth = getAuthType(account)

    const options = {
        host,
        port,
        username,
        auth,
        version: getVersion(account),

        // Helps prevent some unnecessary timeout problems
        connectTimeout: 30000,

        // Keep the connection alive
        checkTimeoutInterval: 60000
    }

    if (auth === 'microsoft') {
        options.username =
            account.email ||
            account.username ||
            process.env.MICROSOFT_EMAIL ||
            username

        console.log(
            `[${botId}] Microsoft authentication enabled`
        )
    }

    if (auth === 'offline' && getPassword(account)) {
        options.password = getPassword(account)
    }

    console.log('')
    console.log('======================================')
    console.log(`[${botId}] Starting Minecraft bot`)
    console.log(`[${botId}] Server: ${host}:${port}`)
    console.log(`[${botId}] Username: ${username}`)
    console.log(`[${botId}] Auth: ${auth}`)
    console.log('======================================')

    let bot

    try {
        bot = mineflayer.createBot(options)
    } catch (err) {
        console.log(`[${botId}] Failed to create bot:`, err.message)
        scheduleReconnect(account, index, botId)
        return null
    }

    bots.set(botId, bot)

    if (pathfinder) {
        bot.loadPlugin(pathfinder)
    }

    bot.once('login', () => {
        console.log(`[${botId}] Logged into Minecraft`)
    })

    bot.once('spawn', () => {
        console.log(`[${botId}] Spawned successfully`)

        /*
         * Small random movement to make the bot look less static.
         */
        startMovement(bot, botId)

        /*
         * Existing repository module handles:
         * - random jumping
         * - scheduled leave/rejoin
         */
        try {
            setupLeaveRejoin(bot, () => {
                createBot(account, index)
            })
        } catch (err) {
            console.log(
                `[${botId}] leaveRejoin error: ${err.message}`
            )
        }

        setupAutoAuth(bot, account, botId)
    })

    bot.on('chat', (username, message) => {
        console.log(`[CHAT] ${username}: ${message}`)
    })

    bot.on('messagestr', message => {
        console.log(`[${botId}] ${message}`)
    })

    bot.on('kicked', reason => {
        console.log(`[${botId}] Kicked: ${formatReason(reason)}`)
    })

    bot.on('error', err => {
        console.log(`[${botId}] Error: ${err.message}`)
    })

    bot.on('end', reason => {
        console.log(
            `[${botId}] Connection ended: ${reason || 'unknown reason'}`
        )

        stopMovement(bot)

        if (bots.get(botId) === bot) {
            bots.delete(botId)
        }

        scheduleReconnect(account, index, botId)
    })

    return bot
}

function formatReason(reason) {
    try {
        if (typeof reason === 'string') {
            return reason
        }

        return JSON.stringify(reason)
    } catch (_) {
        return String(reason)
    }
}

function setupAutoAuth(bot, account, botId) {
    const password =
        account.authPassword ||
        account.serverPassword ||
        account.registerPassword ||
        process.env.SERVER_PASSWORD ||
        getSetting(
            'serverPassword',
            'authPassword',
            'registerPassword'
        )

    if (!password) {
        return
    }

    let authenticated = false

    const commands = [
        `/login ${password}`,
        `/l ${password}`
    ]

    const authDelay = Number(
        getSetting('authDelay', 'loginDelay') || 2500
    )

    const tryAuth = () => {
        if (authenticated) return

        authenticated = true

        const command = commands[0]

        try {
            bot.chat(command)

            console.log(`[${botId}] Authentication command sent`)
        } catch (err) {
            console.log(
                `[${botId}] Authentication failed: ${err.message}`
            )
        }
    }

    bot.on('messagestr', message => {
        const text = String(message).toLowerCase()

        const needsAuth =
            text.includes('login') ||
            text.includes('log in') ||
            text.includes('register') ||
            text.includes('authenticate') ||
            text.includes('password')

        if (needsAuth) {
            setTimeout(tryAuth, authDelay)
        }
    })

    /*
     * Some servers don't send a clear authentication message.
     */
    setTimeout(() => {
        if (!authenticated) {
            tryAuth()
        }
    }, authDelay)
}

const movementTimers = new Map()

function startMovement(bot, botId) {
    stopMovement(bot)

    const state = {
        stopped: false,
        timer: null,
        releaseTimer: null
    }

    movementTimers.set(botId, state)

    function randomDelay(min, max) {
        return Math.floor(
            Math.random() * (max - min + 1)
        ) + min
    }

    function move() {
        if (
            state.stopped ||
            !bot ||
            !bot.entity
        ) {
            return
        }

        const actions = [
            'forward',
            'back',
            'left',
            'right'
        ]

        const action =
            actions[
                Math.floor(Math.random() * actions.length)
            ]

        const duration = randomDelay(700, 2200)

        try {
            bot.setControlState(action, true)

            state.releaseTimer = setTimeout(() => {
                try {
                    bot.setControlState(action, false)
                } catch (_) {}
            }, duration)
        } catch (_) {}

        state.timer = setTimeout(
            move,
            randomDelay(30000, 120000)
        )
    }

    state.timer = setTimeout(
        move,
        randomDelay(10000, 30000)
    )
}

function stopMovement(bot) {
    if (!bot) return

    for (const state of movementTimers.values()) {
        state.stopped = true

        if (state.timer) {
            clearTimeout(state.timer)
        }

        if (state.releaseTimer) {
            clearTimeout(state.releaseTimer)
        }
    }

    try {
        bot.clearControlStates()
    } catch (_) {}
}

const reconnectTimers = new Map()

function scheduleReconnect(account, index, botId) {
    if (reconnectTimers.has(botId)) {
        return
    }

    const delay = Math.floor(
        Math.random() * 10000
    ) + 5000

    console.log(
        `[${botId}] Reconnecting in ${Math.round(
            delay / 1000
        )} seconds`
    )

    const timer = setTimeout(() => {
        reconnectTimers.delete(botId)

        try {
            createBot(account, index)
        } catch (err) {
            console.log(
                `[${botId}] Reconnect failed: ${err.message}`
            )

            scheduleReconnect(
                account,
                index,
                botId
            )
        }
    }, delay)

    reconnectTimers.set(botId, timer)
}

function startBots() {
    loadConfig()

    /*
     * If no accounts are configured, use environment/settings
     * and create one bot.
     */
    if (!accounts.length) {
        console.log(
            '[CONFIG] No accounts found — starting one default bot'
        )

        createBot({}, 0)
        return
    }

    console.log(
        `[CONFIG] Found ${accounts.length} account(s)`
    )

    accounts.forEach((account, index) => {
        const delay = index * 5000

        setTimeout(() => {
            createBot(account, index)
        }, delay)
    })
}

function startWebServer() {
    const app = express()

    app.get('/', (req, res) => {
        const activeBots = []

        for (const [id, bot] of bots.entries()) {
            activeBots.push({
                id,
                username: bot.username || 'unknown',
                health: bot.player ? 'online' : 'connecting',
                server: `${getServerHost()}:${getServerPort()}`
            })
        }

        res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Minecraft AFK Bot</title>
    <style>
        body {
            margin: 0;
            padding: 40px;
            background: #111;
            color: #eee;
            font-family: Arial, sans-serif;
        }

        .container {
            max-width: 800px;
            margin: auto;
        }

        .card {
            background: #1b1b1b;
            border: 1px solid #333;
            border-radius: 12px;
            padding: 20px;
            margin-top: 20px;
        }

        .online {
            color: #63e66d;
        }

        .connecting {
            color: #f0c674;
        }

        h1 {
            margin-bottom: 5px;
        }

        code {
            background: #222;
            padding: 3px 6px;
            border-radius: 5px;
        }
    </style>
</head>
<body>
<div class="container">
    <h1>Minecraft AFK Bot</h1>
    <p>
        Server:
        <code>${escapeHTML(
            getServerHost()
        )}:${getServerPort()}</code>
    </p>

    <div class="card">
        <h2>Bot Status</h2>

        ${
            activeBots.length
                ? activeBots.map(bot => `
                    <p>
                        <strong>${escapeHTML(bot.id)}</strong>
                        —
                        <span class="${bot.health}">
                            ${bot.health}
                        </span>
                    </p>
                `).join('')
                : '<p>No active bots</p>'
        }
    </div>
</div>
</body>
</html>
        `)
    })

    app.get('/status', (req, res) => {
        const result = []

        for (const [id, bot] of bots.entries()) {
            result.push({
                id,
                username: bot.username || null,
                online: !!bot.player,
                server: {
                    host: getServerHost(),
                    port: getServerPort()
                }
            })
        }

        res.json({
            status: 'ok',
            bots: result,
            uptime: process.uptime()
        })
    })

    app.get('/health', (req, res) => {
        res.status(200).send('OK')
    })

    server = app.listen(PORT, '0.0.0.0', () => {
        console.log(
            `[WEB] Status server running on port ${PORT}`
        )
    })
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

process.on('uncaughtException', err => {
    console.log('[PROCESS] Uncaught exception:', err)
})

process.on('unhandledRejection', err => {
    console.log('[PROCESS] Unhandled rejection:', err)
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function shutdown() {
    console.log('[PROCESS] Shutting down...')

    for (const [id, bot] of bots.entries()) {
        try {
            stopMovement(bot)
            bot.quit()
        } catch (_) {}

        bots.delete(id)
    }

    for (const timer of reconnectTimers.values()) {
        clearTimeout(timer)
    }

    reconnectTimers.clear()

    if (server) {
        server.close(() => {
            process.exit(0)
        })
    } else {
        process.exit(0)
    }
}

startWebServer()
startBots()
