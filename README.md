# WhatsApp AI Bot (Baileys + Gemini + ElevenLabs)

Rejects calls after 10s, sends a voice note, then chats with AI. Controlled by you from your owner number.

## Run locally (test first)
1. Install Node 20+ and ffmpeg.
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in.
4. `npm run dev`
5. Link the number: look for `PAIRING CODE:` in the console. In WhatsApp on the bot number:
   Settings > Linked devices > Link a device > Link with phone number instead > enter the code.
6. From your owner number send `/on`, then call the bot number to test.

## Deploy
Use a host that runs a long-lived process AND keeps a persistent disk (Docker works).
- Set the same variables from `.env.example` in the host's settings (never in the repo).
- Mount a volume at `/data` (DATA_DIR) so the WhatsApp login survives restarts.
- Link the number once using the pairing code in the host's logs.

## Never commit
`.env`, `auth/`, `contacts.json`, `state.json` (they hold keys, the WhatsApp login and private notes).
