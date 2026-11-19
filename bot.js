import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { GoogleGenAI } from '@google/genai';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import http from 'http';

// Where auth, contacts and state are saved. On a host, point DATA_DIR at a persistent disk/volume.
const DATA = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA, { recursive: true });

// ---------- CONFIG (set as environment variables) ----------
const OWNER = process.env.OWNER_NAME || 'Xavi';
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash'; // check current names
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'; // check current names
const VOICE = process.env.GEMINI_VOICE || 'Kore'; // try a few voices, pick the one you like
const RING_MS = 10_000; // let the call ring this long, then reject
const VOICE_DELAY_MS = 10_000; // wait this long after rejecting, then send the voice note
const ONLY_LISTED = process.env.ONLY_LISTED === 'true'; // true = ignore numbers not in contacts.json
// Your OTHER WhatsApp number(s) that can command the bot, digits only, comma separated: 254700000000,254711111111
const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
const ACCENT = process.env.VOICE_ACCENT || 'Kalenjin (Rift Valley, Kenya)';
// ElevenLabs is used when ELEVENLABS_API_KEY is set. If it fails (no credits, error), Gemini voice is the backup.
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || 'ld6juhMEAFeE1MBpEAhC';
const ELEVEN_SPEED = Number(process.env.ELEVENLABS_SPEED || 0.85); // 0.7 = slower, 1.0 = normal, 1.2 = faster
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2'; // check ElevenLabs docs for the newest model that supports Swahili

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 5 default first voice notes. Rotated so callers don't always get the same one.
// Override per number with "firstMessages" in contacts.json.
const DEFAULT_FIRST = [
  `Hey niaje! ${OWNER} hayuko kwa sasa, nitamwambia umepiga.`,
  `Heyy, ${OWNER} ameacha simu, hayuko. Niambie unataka nini nimfikishie.`,
  `Niaje, ${OWNER} yuko offline saa hii. Acha ujumbe hapa, atakujibu.`,
  `Hi hi, ${OWNER} hayuko poa. Nikusaidie na nini?`,
  `Sasa, ${OWNER} amepumzika saa hii. Unaweza niambia, nitamwambia asubuhi.`,
];

// Used when you set /online: you are around but can't talk right now
const DEFAULT_ONLINE = [
  `Hey! ${OWNER} yuko online lakini hawezi kuongea sasa hivi. Mtumie ujumbe, atakujibu hivi karibuni.`,
  `Niaje, ${OWNER} ameona umepiga, ako busy kidogo. Andika hapa, atakujibu.`,
  `Heyy, ${OWNER} yuko around lakini hawezi pick simu saa hii. Niambie unataka nini.`,
];

// ---------- helpers ----------
const loadContacts = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'contacts.json'), 'utf8'));
  } catch {
    return {};
  }
};
const numOf = (jid) => jid.split('@')[0].split(':')[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bot starts OFF until you send /on. State survives restarts.
let enabled = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')).enabled === true;
  } catch {
    return false;
  }
})();
let ownerStatus = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')).status === 'online' ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
})();
const saveState = () => fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ enabled, status: ownerStatus }));
const setEnabled = (v) => {
  enabled = v;
  saveState();
};
const setStatus = (v) => {
  ownerStatus = v === 'online' ? 'online' : 'offline';
  saveState();
};
const saveContacts = (c) => fs.writeFileSync(path.join(DATA, 'contacts.json'), JSON.stringify(c, null, 2));

const HELP = `Commands (send these to yourself in WhatsApp):
/on  or  /off
/online  or  /offline  (tell the bot if you are available)
/status
/list
/train 254712345678 notes about this person
/first 254712345678 a custom first voice note line
/clearfirst 254712345678
/mode 254712345678 voice|text|alternate`;

async function ownerCommand(sock, jid, text) {
  const [cmd, arg1, ...rest] = text.trim().split(/\s+/);
  const say = (t) => sock.sendMessage(jid, { text: t });
  const contacts = loadContacts();
  const num = arg1?.replace(/\D/g, '');
  const arg = rest.join(' ');

  switch (cmd.toLowerCase()) {
    case '/on':
      setEnabled(true);
      return say('Bot is ON');
    case '/off':
      setEnabled(false);
      return say('Bot is OFF');
    case '/online':
      setStatus('online');
      return say('Status: you are ONLINE. Callers will be told you are around but busy.');
    case '/offline':
      setStatus('offline');
      return say('Status: you are OFFLINE. Callers will be told you are away.');
    case '/status':
      return say(`Bot is ${enabled ? 'ON' : 'OFF'}. You are ${ownerStatus}. ${Object.keys(contacts).length} numbers trained.`);
    case '/list':
      return say(
        Object.entries(contacts)
          .map(([n, c]) => `${n}: ${(c.notes || '').slice(0, 60)}`)
          .join('\n') || 'No numbers trained yet.'
      );
    case '/train':
      if (!num || !arg) return say('Use: /train 254712345678 notes about this person');
      contacts[num] = { ...contacts[num], notes: arg };
      saveContacts(contacts);
      return say(`Saved notes for ${num}`);
    case '/first':
      if (!num || !arg) return say('Use: /first 254712345678 your line here');
      contacts[num] = { ...contacts[num], firstMessages: [...(contacts[num]?.firstMessages || []), arg] };
      saveContacts(contacts);
      return say(`Added. ${num} now has ${contacts[num].firstMessages.length} custom first messages.`);
    case '/clearfirst':
      if (!num) return say('Use: /clearfirst 254712345678');
      if (contacts[num]) delete contacts[num].firstMessages;
      saveContacts(contacts);
      return say(`Cleared custom first messages for ${num}`);
    case '/mode':
      if (!num || !['voice', 'text', 'alternate'].includes(arg)) return say('Use: /mode 254712345678 voice|text|alternate');
      contacts[num] = { ...contacts[num], mode: arg };
      saveContacts(contacts);
      return say(`Mode for ${num} is now ${arg}`);
    default:
      return say(HELP);
  }
}

const lastFirst = new Map(); // number -> last variant index used
const replyCount = new Map(); // number -> replies sent (for voice/text alternating)
const history = new Map(); // number -> chat history for Gemini

function pickFirst(num, contact) {
  const pool = contact.firstMessages?.length ? contact.firstMessages : ownerStatus === 'online' ? DEFAULT_ONLINE : DEFAULT_FIRST;
  let i;
  do {
    i = Math.floor(Math.random() * pool.length);
  } while (pool.length > 1 && i === lastFirst.get(num));
  lastFirst.set(num, i);
  return pool[i];
}

// Gemini TTS returns raw 24kHz PCM; WhatsApp voice notes need ogg/opus (requires ffmpeg installed)
function pcmToOpus(pcm) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1',
    ]);
    const out = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.on('error', reject);
    ff.on('close', (c) => (c === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg exit ' + c))));
    ff.stdin.on('error', () => {});
    ff.stdin.end(pcm);
  });
}

function mp3ToOpus(mp3) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
    const out = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.on('error', reject);
    ff.on('close', (c) => (c === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg exit ' + c))));
    ff.stdin.on('error', () => {});
    ff.stdin.end(mp3);
  });
}

async function elevenVoice(text) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: ELEVEN_SPEED },
      }),
    }
  );
  if (!res.ok) throw new Error('ElevenLabs HTTP ' + res.status);
  return mp3ToOpus(Buffer.from(await res.arrayBuffer()));
}

// Tries ElevenLabs first, falls back to Gemini voice if it fails or the key is missing
async function textToVoice(text) {
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      return await elevenVoice(text);
    } catch (e) {
      console.error('ElevenLabs failed, using Gemini voice:', e.message);
    }
  }
  return geminiVoice(text);
}

async function geminiVoice(text) {
  const r = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ parts: [{ text: `Say this in a warm, casual, friendly young woman's voice with a ${ACCENT} accent: ${text}` }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  });
  const b64 = r.candidates[0].content.parts[0].inlineData.data;
  return pcmToOpus(Buffer.from(b64, 'base64'));
}

async function aiReply(num, contact, userText) {
  const h = history.get(num) ?? [];
  h.push({ role: 'user', parts: [{ text: userText }] });

  const system = `You are ${OWNER}'s AI assistant, replying on WhatsApp while ${OWNER} is away.
About this person (written by ${OWNER}): ${contact.notes || 'no notes, be polite and neutral'}.
${OWNER}'s current instructions for this person: ${(contact.instructions || []).map((i) => i.text).join(' | ') || 'none'}.
Rules:
- Short, casual, natural replies. Match their language (English, Swahili or Sheng).
- Read the person's mood (angry, sad, worried, excited) and answer in a fitting tone: calm and respectful if upset, warm if sad, light if happy.
- ${OWNER} is currently ${ownerStatus}. Say so honestly if it matters: if online, he is around but cannot talk now; if offline, he is away.
- You are an assistant, not ${OWNER}. If they sincerely ask whether you are a bot or a human, say you are ${OWNER}'s AI assistant.
- Never invent facts, plans or promises for ${OWNER}. If unsure, say you will pass the message on.
- Do not flirt, play a romantic partner, or try to manipulate anyone's feelings (no making people jealous).`;

  const r = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: h.slice(-20),
    config: { systemInstruction: system },
  });
  const text = r.text.trim();
  h.push({ role: 'model', parts: [{ text }] });
  history.set(num, h.slice(-20));
  return text;
}

// Builds the first voice note after a rejected call.
// If you gave instructions for this number, Gemini turns them into a short spoken message.
// "once" instructions are used up after the next call; "always" ones are used on every call.
async function callScript(num, kind = 'rejected_by_bot') {
  const contacts = loadContacts();
  const contact = contacts[num] || {};
  const active = (contact.instructions || []).filter((i) => i.repeat === 'always' || !i.used);
  if (!active.length) return pickFirst(num, contact);

  const r = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: [{
      role: 'user',
      parts: [{ text: `Write a short WhatsApp voice note (max 2 spoken sentences, casual, mix of Swahili, Sheng and English as fits) from ${OWNER}'s AI assistant to someone who just called and was rejected.
About them: ${contact.notes || 'no notes'}
${OWNER}'s instructions for what to say: ${active.map((i) => i.text).join(' | ')}
Context: ${OWNER} is currently ${ownerStatus}. What happened to the call: ${kind.replace(/_/g, ' ')}. If ${OWNER} is online, say politely he is around but cannot talk and will reply by message; if offline, say he is away.
Do not claim to be human or ${OWNER}. Output only the words to be spoken.` }],
    }],
  });

  (contact.instructions || []).forEach((i) => { if (i.repeat === 'once') i.used = true; });
  contacts[num] = contact;
  saveContacts(contacts);
  return r.text.trim();
}

// Owner pastes a message someone sent him; bot reads the mood and drafts replies HE sends himself.
async function helpReply(message, about) {
  const r = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: [{
      role: 'user',
      parts: [{ text: `${OWNER} received this WhatsApp message${about ? ' from ' + about : ''}:
"${message}"

Give, briefly: 1) the mood you read in it (one line), 2) what they probably need, 3) three short reply options in ${OWNER}'s casual voice (English, Swahili or Sheng as fits): warm, calm and honest. ${OWNER} will pick one and send it himself.` }],
    }],
  });
  return r.text.trim();
}

// You (the owner) talk to the bot in normal language from your other number.
async function ownerAI(sock, jid, text) {
  const contacts = loadContacts();
  const roster = Object.entries(contacts).map(([n, c]) => `${n} = ${c.name || 'unnamed'}`).join('\n') || 'none yet';
  const key = 'owner:' + jid;
  const h = history.get(key) ?? [];
  h.push({ role: 'user', parts: [{ text }] });

  const system = `You turn the owner's WhatsApp messages into actions for his call-answering bot.
Known contacts (number = name):
${roster}

Reply ONLY with JSON: {"reply": string, "actions": []}
Action types:
{"type":"instruct","number":"digits","name":"optional","text":"what the bot should tell this person","repeat":"once"|"always"}
{"type":"train","number":"digits","name":"optional","notes":"how to treat or talk to this person"}
{"type":"clear_instructions","number":"digits"}
{"type":"on"} {"type":"off"} {"type":"list"}
{"type":"status","value":"online"|"offline"}  (the owner says whether he is available)
{"type":"help_reply","message":"the text the other person sent","about":"optional who sent it"}  (the owner pastes a message and asks how to reply)

Rules:
- Map names to numbers using the contacts list. Numbers are digits with country code, no plus.
- If the number is unknown or ambiguous, or the owner did not say whether to say it ONCE or EVERY TIME she calls, return no actions and ask one short question in "reply".
- "reply" is a short confirmation or question to the owner, in the language he used.
- Refuse (no actions, explain briefly in "reply") anything meant to deceive someone into harm or to manipulate their feelings, such as making someone jealous.`;

  const r = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: h.slice(-12),
    config: { systemInstruction: system, responseMimeType: 'application/json' },
  });

  let out;
  try {
    out = JSON.parse(r.text);
  } catch {
    return sock.sendMessage(jid, { text: 'I did not understand that, can you say it again?' });
  }
  h.push({ role: 'model', parts: [{ text: r.text }] });
  history.set(key, h.slice(-12));

  const c = loadContacts();
  let extra = '';
  for (const a of out.actions || []) {
    const n = a.number?.replace(/\D/g, '');
    if (a.type === 'on') setEnabled(true);
    else if (a.type === 'off') setEnabled(false);
    else if (a.type === 'status') setStatus(a.value);
    else if (a.type === 'help_reply' && a.message) extra += '\n\n' + (await helpReply(a.message, a.about));
    else if (a.type === 'list') {
      extra += '\n' + (Object.entries(c).map(([k, v]) => `${k} ${v.name || ''}: ${(v.notes || '').slice(0, 50)}`).join('\n') || 'No numbers yet.');
    } else if (n && a.type === 'instruct' && a.text) {
      c[n] = { ...c[n] };
      if (a.name && !c[n].name) c[n].name = a.name;
      c[n].instructions = [...(c[n].instructions || []), { text: a.text, repeat: a.repeat === 'always' ? 'always' : 'once', used: false }];
    } else if (n && a.type === 'train') {
      c[n] = { ...c[n], notes: a.notes };
      if (a.name) c[n].name = a.name;
    } else if (n && a.type === 'clear_instructions' && c[n]) {
      delete c[n].instructions;
    }
  }
  saveContacts(c);
  await sock.sendMessage(jid, { text: (out.reply || 'Done') + extra });
}

// ---------- main ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA, 'auth'));
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'), // required for pairing-code linking
  });
  let pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);



  // Link by phone number (no QR): set PAIR_NUMBER=254743810633. The code is requested when
  // WhatsApp is ready. Use the NEWEST code in the logs, within about a minute, in
  // WhatsApp > Linked devices > Link a device > Link with phone number instead.
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && process.env.PAIR_NUMBER && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(process.env.PAIR_NUMBER.replace(/\D/g, ''));
        console.log('=== PAIRING CODE:', code, '===');
      } catch (e) {
        console.error('pairing error:', e.message);
      }
    } else if (qr && !process.env.PAIR_NUMBER) {
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('Connected');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) start();
      else console.log('Logged out. Delete the auth folder and scan again.');
    }
  });

  // Incoming call: ring 10s -> reject -> wait 10s -> voice note
  const handled = new Set();
  const callState = new Map(); // call id -> latest status (offer, accept, reject, timeout...)
  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      callState.set(call.id, call.status);
      if (!enabled || call.status !== 'offer' || handled.has(call.id)) continue;
      handled.add(call.id);

      const num = numOf(call.callerPn || call.from);
      console.log('CALL from', call.from, call.callerPn || '', 'enabled=' + enabled);
      const contacts = loadContacts();
      const contact = contacts[num] || {};
      if (ONLY_LISTED && !contacts[num]) continue;

      try {
        await sleep(RING_MS);
        const st = callState.get(call.id);
        console.log('CALL status after ring:', st);
        if (st === 'accept') continue; // you answered: do nothing
        let kind = 'rejected_by_bot';
        if (st === 'reject') kind = 'declined_by_owner'; // you declined it yourself
        else if (st === 'timeout' || st === 'terminate') kind = 'missed'; // rang out or caller hung up
        else await sock.rejectCall(call.id, call.from); // still ringing: the bot rejects it
        await sleep(VOICE_DELAY_MS);

        const text = await callScript(num, kind);
        await sock.sendPresenceUpdate('recording', call.from);
        const audio = await textToVoice(text);
        await sock.sendMessage(call.from, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });

        // remember what was said so the AI continues the conversation naturally
        const h = history.get(num) ?? [];
        h.push({ role: 'model', parts: [{ text }] });
        history.set(num, h);
      } catch (e) {
        console.error('call flow error:', e.message);
      }
    }
  });

  // Chat messages: AI replies, alternating voice note and text
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message) continue;
      const jid = m.key.remoteJid;
      const phoneJid = m.key.remoteJidAlt || jid; // real phone number when jid is a @lid
      console.log('MSG from', jid, m.key.remoteJidAlt || '', 'fromMe=' + m.key.fromMe);
      if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      const body = m.message.conversation || m.message.extendedTextMessage?.text;
      if (!body) continue;

      // Owner commands: only from your own "message yourself" chat
      const me = [sock.user?.id, sock.user?.lid].filter(Boolean).map(numOf);
      if (m.key.fromMe) {
        if (me.includes(numOf(jid)) && body.startsWith('/')) {
          await ownerCommand(sock, jid, body).catch((e) => console.error('command error:', e.message));
        }
        continue;
      }
      // Messages from your other number(s) are commands, and work even when the bot is OFF
      if ([numOf(phoneJid), numOf(jid)].some((n) => OWNER_NUMBERS.includes(n))) {
        const handler = body.startsWith('/') ? ownerCommand : ownerAI;
        await handler(sock, jid, body).catch((e) => console.error('owner error:', e.message));
        continue;
      }
      if (!enabled) continue;

      const num = numOf(phoneJid);
      const contacts = loadContacts();
      if (ONLY_LISTED && !contacts[num]) continue;
      const contact = contacts[num] || {};

      try {
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(1500 + Math.random() * 2500);
        const reply = await aiReply(num, contact, body);

        const n = replyCount.get(num) ?? 0;
        replyCount.set(num, n + 1);
        const useVoice = contact.mode === 'voice' || (contact.mode !== 'text' && n % 2 === 0);

        if (useVoice) {
          await sock.sendPresenceUpdate('recording', jid);
          const audio = await textToVoice(reply);
          await sock.sendMessage(jid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        } else {
          await sock.sendMessage(jid, { text: reply });
        }
      } catch (e) {
        console.error('reply error:', e.message);
      }
    }
  });
}

start();

if (process.env.PORT) {
  http.createServer((_, res) => res.end('ok')).listen(process.env.PORT);
}
