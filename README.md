# Skyline Technologies WhatsApp Business Bot (Baileys + Gemini + ElevenLabs)

Rejects calls after 10s, sends a voice note, then chats with AI. Controlled by you from your owner number.

## Run locally (test first)
1. Install Node 22+ and ffmpeg.
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

## Business mode
- `business.md` holds the services, prices and terms the bot answers from. Edit it and push to update.
- `docs/` holds the PDFs the bot attaches when a customer asks for the price list or services guide.
- The bot tells your owner number about new enquiries and calls.

## My people
Friends, family and your partner should not get business replies. From your owner number send:
`/mine 254712345678 Name`, `/unmine 254712345678` and `/people`, or say it in words
("Mercy 254712345678 is my girlfriend, don't reply to her"). The bot stays silent and leaves their calls alone.
Also put the important numbers in `PERSONAL_NUMBERS` so they survive restarts on free hosting.

## Menu, projects and orders
- Customers send `.menu`: Projects, Services, Prices (PDF), About us, Place an order, Talk to the owner. Menus are numbered text because WhatsApp blocks real buttons on normal numbers.
- Add projects from your owner number: send a picture with the caption `.project Name | description | https://link`.
  `.projects` lists them and `.delproject 2` removes one. Put permanent ones in `portfolio.md` too.
- Orders and new enquiries are sent to your owner number and to the bot number's "message yourself" chat.
- Calls: if you set `.offline` the bot hangs up and sends a voice note; if `.online` the phone keeps ringing and a note is sent only if the call goes unanswered.
- Greetings use Nairobi time and a waving hand, with the logo, for new or returning contacts.

## Back online
While you are `.offline` the bot remembers everyone who called or messaged. When you send `.online` it tells each of them (within 24 hours) that you are now available.
