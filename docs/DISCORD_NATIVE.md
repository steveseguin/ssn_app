# Native Discord sources

SSApp can capture and send Discord channel messages directly through a bot. Discord Desktop and Discord Web do not need to be open. The connection runs locally for as long as SSApp is running, including while SSApp is minimized to the system tray.

This setup is intended for servers where you can install a bot. If you cannot install one, choose **Discord > Use Discord Web capture** and provide the channel URL instead.

## What you need

- Permission to install a bot in the Discord server.
- A Discord application and bot token from the Discord Developer Portal.
- **Message Content Intent** enabled for the bot.

There is no Social Stream API key and no Cloudflare setup. The bot connects from SSApp directly to Discord.

The native connector is designed for a personal or small shared bot. Discord requires verification and privileged-intent approval as an app grows to 100 or more servers, and very large bots require Gateway sharding that this local connector does not provide.

## Create and connect the bot

1. In SSApp, open **Sources and Settings** and choose **Discord**.
2. Choose **Connect a Discord bot**.
3. Select **Open Developer Portal**.
4. In Discord, create a **New Application**, give it a name, and open its **Bot** page.
5. Create or reset the bot token and copy it. Treat this token like a password.
6. On the same Bot page, find **Privileged Gateway Intents** and turn on **Message Content Intent**. Save the change.
7. Return to SSApp, paste the token, and choose **Save and verify bot**.
8. Choose **Install bot in a server**. Select the server and approve the requested permissions.
9. Return to SSApp and choose **Refresh**. Select the server and channel, then choose **Add source**.
10. Activate the new source. Enable **Auto-activate on startup** if SSApp should reconnect it automatically.

SSApp's install link requests only these Discord permissions:

- View Channels
- Send Messages

It does not request Administrator. A server or channel override can still deny either permission. Channels the bot cannot view are not shown. Channels where it can read but not send are marked **capture only**.

## Bot token storage

SSApp encrypts bot tokens with Electron's `safeStorage`, backed by the operating system's credential protection. Tokens are stored separately from the source state. Saved sources contain only an opaque credential reference, never the bot token.

If secure credential storage is unavailable, SSApp refuses to save the token in plain text. Full-session backups may include the encrypted credential store; protect those backups as you would other signed-in application data.

To rotate a token, open the source's settings, choose **Manage bot or change channel**, paste the new token, and save it. Sources sharing that bot are disconnected and can be activated again after the replacement is verified. To revoke access completely, reset the token in Discord and use **Forget saved bot** in SSApp.

## Capture and sending behavior

- SSApp captures new messages in the selected guild text or announcement channel.
- Direct messages, threads, forum posts, message history, edits, and deletes are not included in the initial native connector.
- Messages authored by the connected bot are ignored to prevent relay loops.
- Messages from other bots and webhooks are ignored by default. Enable them in the source settings if needed.
- Replies sent through Social Stream use Discord's Create Message API.
- Outbound messages longer than Discord's 2,000-character limit are split safely.
- Outbound mentions are disabled, so bridged text cannot unexpectedly ping users, roles, or everyone.
- Discord rate limits are honored and outbound messages for each channel are kept in order.

The source keeps running when the main window is hidden or minimized to the tray. It stops when the source is stopped, its saved bot is forgotten, or SSApp fully exits.

## Troubleshooting

### The bot is valid, but no servers are listed

Use **Install bot in a server**, complete Discord's authorization screen, then choose **Refresh**. Confirm you selected a server where you have permission to install applications.

### A channel is missing

Check the bot's roles and the channel's permission overrides. The bot must have **View Channel**. Category and channel overrides can deny access even when its server role allows it.

### “Enable Message Content Intent” appears

Open the application's **Bot** page in the Discord Developer Portal, turn on **Message Content Intent**, save, then activate the source again.

### The token is rejected

Make sure you pasted the bot token, not the application ID, client secret, or public key. Reset the token in the Developer Portal if its value is unknown or may have been exposed.

### Messages arrive, but SSApp cannot send

The selected channel is probably capture-only. Grant the bot **Send Messages** in that channel, then refresh the setup screen. Announcement channels may also have server-specific restrictions.

### Discord Web is already configured

The Web source and native bot source can coexist, but capturing the same channel through both will create duplicate messages. Stop or remove the Web source after confirming the native source works.

## Deployment note

Native Discord support is local and bring-your-own-bot. It does not require a hosted Social Stream bot, OAuth callback Worker, Durable Object, queue, KV namespace, or other Cloudflare resource. A future shared hosted bot would be a separate service with different privacy, moderation, scaling, and Discord verification requirements.
