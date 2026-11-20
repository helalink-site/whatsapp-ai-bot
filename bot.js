import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { GoogleGenAI } from '@google/genai';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Kenyan numbers: 0712345678, 712345678, +254 712 345 678 all become 254712345678
function normNum(x) {
  const d = String(x || '').replace(/\D/g, '');
  if (d.startsWith('254') && d.length >= 12) return d;
  if (d.startsWith('0') && d.length === 10) return '254' + d.slice(1);
  if ((d.startsWith('7') || d.startsWith('1')) && d.length === 9) return '254' + d;
  return d;
}

// Where auth, contacts and state are saved. On a host, point DATA_DIR at a persistent disk/volume.
const DATA = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA, { recursive: true });

// ---------- CONFIG (set as environment variables) ----------
const OWNER = process.env.OWNER_NAME || 'Clinton'; // short name used in messages
const OWNER_FULL = process.env.OWNER_FULL_NAME || 'Clinton Oduor';
const BUSINESS = process.env.BUSINESS_NAME || 'Skyline Technologies';
const LANG = process.env.BOT_LANGUAGE || 'English'; // language of all bot replies and voice notes
// "My people": numbers the bot must never reply to or touch (family, friends, partner). Digits only, comma separated.
// People you add with /mine are also saved in contacts.json, but that file is lost on free hosting restarts, so keep the important ones here too.
const PERSONAL_ENV = (process.env.PERSONAL_NUMBERS || '').split(',').map(normNum).filter(Boolean);
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash'; // check current names
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'; // check current names
const VOICE = process.env.GEMINI_VOICE || 'Kore'; // try a few voices, pick the one you like
const RING_MS = 10_000; // let the call ring this long, then reject
const VOICE_DELAY_MS = 10_000; // wait this long after rejecting, then send the voice note
const ONLY_LISTED = process.env.ONLY_LISTED === 'true'; // true = ignore numbers not in contacts.json
// Your OTHER WhatsApp number(s) that can command the bot, digits only, comma separated: 254700000000,254711111111
const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || '').split(',').map(normNum).filter(Boolean);
const ACCENT = process.env.VOICE_ACCENT || 'Kalenjin (Rift Valley, Kenya)';
// ElevenLabs is used when ELEVENLABS_API_KEY is set. If it fails (no credits, error), Gemini voice is the backup.
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || 'ld6juhMEAFeE1MBpEAhC';
const ELEVEN_SPEED = Number(process.env.ELEVENLABS_SPEED || 0.85); // 0.7 = slower, 1.0 = normal, 1.2 = faster
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2'; // check ElevenLabs docs for the newest model that supports Swahili

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 5 default first voice notes. Rotated so callers don't always get the same one.
// Override per number with "firstMessages" in contacts.json.
const DEFAULT_FIRST = [
  `Sorry, ${BUSINESS} is unavailable right now. To get help, send the word .menu on WhatsApp and I will show you our services, projects and prices.`,
  `Hello, you have reached ${BUSINESS}. ${OWNER} is not available at the moment. Please send the word .menu on WhatsApp to see everything we offer.`,
  `Thank you for calling ${BUSINESS}. We are unable to take your call right now. Send .menu on WhatsApp to see our services, projects and prices.`,
  `Hi, this is ${BUSINESS}. We could not take your call. Send .menu on WhatsApp for our services, projects and prices, or tell me what you need.`,
  `Hello, ${BUSINESS} here. ${OWNER} is not available at the moment. Send .menu on WhatsApp and I will help you right away.`,
];

// Used when you set /online: you are around but can't talk right now
const DEFAULT_ONLINE = [
  `Hello, this is ${BUSINESS}. Sorry we missed your call. Send the word .menu on WhatsApp for our services, projects and prices, and ${OWNER} will reply soon.`,
  `Hi, thank you for calling ${BUSINESS}. We could not pick up just now. Send .menu on WhatsApp and we will get back to you shortly.`,
  `Hi, we could not pick up your call. Send .menu on WhatsApp and I will help you right away.`,
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
const loadBiz = () => {
  try {
    return fs.readFileSync(path.join(HERE, 'business.md'), 'utf8');
  } catch {
    return '';
  }
};
const isPersonal = (nums, contacts) => nums.some((n) => PERSONAL_ENV.includes(n) || contacts[n]?.personal === true);

async function notifyOwner(sock, text) {
  const targets = new Set(OWNER_NUMBERS.map((n) => `${n}@s.whatsapp.net`));
  if (sock.user?.id) targets.add(numOf(sock.user.id) + '@s.whatsapp.net'); // the bot's own number ("message yourself")
  for (const jid of targets) {
    try {
      await sock.sendMessage(jid, { text });
    } catch (e) {
      console.error('notify error:', e.message);
    }
  }
}
async function sendDoc(sock, jid, file) {
  try {
    await sock.sendMessage(jid, { document: fs.readFileSync(path.join(HERE, 'docs', file)), mimetype: 'application/pdf', fileName: file });
  } catch (e) {
    console.error('doc error:', e.message);
  }
}
const leadSeen = new Map(); // number -> last time the owner was notified

// ---------- projects (portfolio) fed by the owner ----------
const loadProjects = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'projects.json'), 'utf8'));
  } catch {
    return [];
  }
};
const saveProjects = (l) => fs.writeFileSync(path.join(DATA, 'projects.json'), JSON.stringify(l, null, 2));
const portfolioFile = () => {
  try {
    return fs.readFileSync(path.join(HERE, 'portfolio.md'), 'utf8');
  } catch {
    return '';
  }
};
const projectsText = () => {
  const t = loadProjects().map((p) => `- ${p.name}: ${p.description || ''} ${p.link || ''}`).join('\n') + '\n' + portfolioFile();
  return t.trim() || 'none added yet';
};

// ---------- menu, greeting, orders ----------
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '+254 743 810 633';
const BUSINESS_WA = process.env.BUSINESS_WHATSAPP_LINK || 'https://wa.me/254743810633';
const BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || 'skylinetechnologies254@gmail.com';
const FOOTER = `\n\n------------------\n📞 Call: ${BUSINESS_PHONE}\n💬 WhatsApp: ${BUSINESS_WA}\n✉️ Email: ${BUSINESS_EMAIL}`;
const LOGO = path.join(HERE, 'docs', 'logo.jpg');

const SERVICES = [
  { name: 'WhatsApp AI Bot', price: 'KES 15,000 - 40,000', time: '1 - 2 weeks', desc: 'AI replies to customers, call handling, voice notes' },
  { name: 'Business Website', price: 'KES 15,000 - 50,000', time: '1 - 3 weeks', desc: 'Up to 5 pages, mobile friendly, contact form' },
  { name: 'Online Shop', price: 'KES 50,000 - 150,000', time: '3 - 6 weeks', desc: 'Products, cart, M-Pesa payments, admin dashboard' },
  { name: 'POS System', price: 'KES 40,000 - 120,000', time: '3 - 6 weeks', desc: 'Sales, receipts, stock tracking, reports' },
  { name: 'M-Pesa (Daraja) Integration', price: 'KES 15,000 - 40,000', time: '1 - 2 weeks', desc: 'STK Push and automatic payment confirmation' },
  { name: 'Android App', price: 'KES 80,000 - 300,000', time: '6 - 12 weeks', desc: 'Designed and built mobile app' },
  { name: 'Custom Management System', price: 'KES 150,000 - 500,000+', time: '2 - 4+ months', desc: 'Hospital, school, inventory and other systems' },
  { name: 'Maintenance and Support', price: 'KES 3,000 - 15,000 per month', time: 'Monthly', desc: 'Updates, bug fixes, monitoring' },
];
const servicesText = () => SERVICES.map((x, i) => `${i + 1}. *${x.name}*\n   ${x.desc}\n   💰 ${x.price}  ⏱ ${x.time}`).join('\n\n');
const MENU = () =>
  `👋 *${BUSINESS}*\n_Innovate • Design • Develop_\n\nReply with a number:\n1️⃣ Projects\n2️⃣ Services\n3️⃣ Prices (PDF)\n4️⃣ About us\n5️⃣ Place an order\n6️⃣ Talk to ${OWNER}${FOOTER}`;

const menuState = new Map(); // number -> { step, service, at }
const lastGreeted = new Map(); // number -> time

function timeGreeting() {
  const h = Number(new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', hour: 'numeric', hour12: false })) % 24;
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Hello';
}
const isGreetingOnly = (t) =>
  /^(hi+|hey+|hello+|hallo|habari|mambo|niaje|sasa|vipi|yo|salaam|karibu|good\s?(morning|afternoon|evening|day)|hi there)[\s!.?,]*$/i.test(t.trim());

// Welcome with a real-time greeting and a waving hand. Returns 'only' if the message was just a greeting.
async function maybeGreet(sock, jid, num, contact, body) {
  const last = lastGreeted.get(num) || contact.lastGreeted || 0;
  if (Date.now() - last < 8 * 3600 * 1000) return null;
  lastGreeted.set(num, Date.now());
  const contacts = loadContacts();
  contacts[num] = { ...contacts[num], lastGreeted: Date.now() };
  saveContacts(contacts);
  const caption = `👋 ${timeGreeting()}${contact.name ? ' ' + contact.name : ''}! Welcome to *${BUSINESS}*.\n\nI am ${OWNER}'s assistant. Send *.menu* to see our projects, services and prices, or just tell me what you need.`;
  try {
    if (fs.existsSync(LOGO)) await sock.sendMessage(jid, { image: fs.readFileSync(LOGO), caption });
    else await sock.sendMessage(jid, { text: caption });
  } catch (e) {
    console.error('greet error:', e.message);
  }
  return isGreetingOnly(body) ? 'only' : 'sent';
}

// People who called or messaged while you were offline
const loadWaiting = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'waiting.json'), 'utf8'));
  } catch {
    return {};
  }
};
const saveWaiting = (w) => fs.writeFileSync(path.join(DATA, 'waiting.json'), JSON.stringify(w));
function addWaiting(num) {
  const w = loadWaiting();
  w[num] = Date.now();
  saveWaiting(w);
}

// When you come back online, tell everyone who tried to reach you while you were offline. Returns how many were told.
async function announceBackOnline(sock) {
  const w = loadWaiting();
  const contacts = loadContacts();
  const fresh = Object.keys(w).filter((n) => Date.now() - w[n] < 24 * 3600 * 1000 && !isPersonal([n], contacts));
  let sent = 0;
  for (const n of fresh.slice(0, 40)) {
    const name = contacts[n]?.name ? ' ' + contacts[n].name : '';
    try {
      await sock.sendMessage(`${n}@s.whatsapp.net`, {
        text: `👋 ${timeGreeting()}${name}! Good news: ${OWNER} from *${BUSINESS}* is now available. You can call or message him now, or send *.menu* to see our services.${FOOTER}`,
      });
      sent++;
    } catch (e) {
      console.error('back-online error:', e.message);
    }
    await sleep(2500);
  }
  saveWaiting({});
  return sent;
}

async function sendProjects(sock, jid) {
  const list = loadProjects();
  if (!list.length) {
    await sock.sendMessage(jid, { text: `Our projects list is being updated. Ask ${OWNER} for examples of our work.${FOOTER}` });
    return;
  }
  await sock.sendMessage(jid, { text: `*Our projects* (${list.length})` });
  for (const p of list.slice(0, 10)) {
    const caption = `*${p.name}*\n${p.description || ''}${p.link ? `\n\n🔗 Open it here: ${p.link}` : ''}`;
    try {
      const file = p.image && path.join(DATA, 'projects', p.image);
      if (file && fs.existsSync(file)) await sock.sendMessage(jid, { image: fs.readFileSync(file), caption });
      else await sock.sendMessage(jid, { text: caption });
    } catch (e) {
      console.error('project send error:', e.message);
    }
    await sleep(800);
  }
  await sock.sendMessage(jid, { text: `Like what you see? Reply *5* to place an order, or *.menu* for the main menu.${FOOTER}` });
}

// Menu navigation by numbers. Returns true when the message was handled here.
async function handleMenu(sock, jid, num, contact, body) {
  const t = body.trim().toLowerCase();
  const say = (text) => sock.sendMessage(jid, { text });
  const orderList = () => say(`🛒 *Place an order*\n\nReply with the number of the service you want:\n\n${servicesText()}`);

  if (['.menu', '/menu', 'menu', '.help', '.start'].includes(t)) {
    lastGreeted.set(num, Date.now());
    menuState.set(num, { step: 'main', at: Date.now() });
    await say(MENU());
    return true;
  }
  if (t === '.order' || t === 'order') {
    menuState.set(num, { step: 'order_pick', at: Date.now() });
    await orderList();
    return true;
  }
  const st = menuState.get(num);
  if (!st || Date.now() - st.at > 30 * 60 * 1000) {
    menuState.delete(num);
    return false;
  }

  if (st.step === 'main' && /^[1-6]$/.test(t)) {
    menuState.set(num, { step: 'main', at: Date.now() });
    if (t === '1') await sendProjects(sock, jid);
    else if (t === '2') await say(`*Our services*\n\n${servicesText()}\n\nReply *5* to place an order, or *.menu* to go back.${FOOTER}`);
    else if (t === '3') {
      await say(`💰 *Prices*\nHere is our price list. These are starting estimates, and ${OWNER} sends an exact written quote.`);
      await sendDoc(sock, jid, 'Skyline-Technologies-Price-List.pdf');
      await say(`Reply *5* to place an order, or *.menu* to go back.${FOOTER}`);
    } else if (t === '4') {
      await say(`ℹ️ *About ${BUSINESS}*\nWe design, build and support software for small businesses, schools, clinics and individuals in Kenya. Founder: ${OWNER_FULL}.\n\nHere is our services guide:`);
      await sendDoc(sock, jid, 'Skyline-Technologies-Services-Guide.pdf');
      await say(`Reply *.menu* to go back.${FOOTER}`);
    } else if (t === '5') {
      menuState.set(num, { step: 'order_pick', at: Date.now() });
      await orderList();
    } else if (t === '6') {
      await say(`✅ I have told ${OWNER}. He will contact you soon. You can also reach him directly:${FOOTER}`);
      notifyOwner(sock, `📞 ${num}${contact.name ? ' (' + contact.name + ')' : ''} wants to talk to you (menu option 6).\nhttps://wa.me/${num}`);
    }
    return true;
  }
  if (st.step === 'order_pick') {
    const svc = SERVICES[Number(t) - 1];
    if (!svc) return false;
    menuState.set(num, { step: 'order_details', service: svc.name, at: Date.now() });
    await say(`Great choice: *${svc.name}* (${svc.price}).\n\nPlease send in one message: your name, what exactly you need, your budget and when you need it.`);
    return true;
  }
  if (st.step === 'order_details') {
    menuState.delete(num);
    await notifyOwner(sock, `🛒 NEW ORDER\nService: ${st.service}\nFrom: ${num}${contact.name ? ' (' + contact.name + ')' : ''}\nDetails: ${body}\n\nReply to them: https://wa.me/${num}`);
    await say(`✅ Order received! ${OWNER} has been notified and will contact you shortly to confirm the details and send a written quote.${FOOTER}`);
    return true;
  }
  return false;
}
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

// Voice library: { "soft": "ElevenLabsVoiceId", ... }. Each contact can use one by name.
const loadVoices = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'voices.json'), 'utf8'));
  } catch {
    return {};
  }
};
const saveVoices = (v) => fs.writeFileSync(path.join(DATA, 'voices.json'), JSON.stringify(v, null, 2));
function voiceFor(contact) {
  const v = contact?.voice;
  if (!v) return ELEVEN_VOICE;
  return loadVoices()[v] || (/^[A-Za-z0-9]{15,}$/.test(v) ? v : ELEVEN_VOICE);
}

const HELP = `Commands (from your owner number, start with . or /):
.on  .off  .status
.online  .offline  (are you available?)
.mine 0712345678 Name  (family/friends: you can paste many lines)
.unmine 0712345678  .people
.project Name | description | link  (attach a picture to show it in the menu)
.projects  .delproject 2
.train 0712345678 notes about this person
.first  .clearfirst  .mode  .voices  .addvoice  .voice`;

async function ownerCommand(sock, jid, text, m) {
  const [cmd, arg1, ...rest] = text.trim().split(/\s+/);
  const say = (t) => sock.sendMessage(jid, { text: t });
  const contacts = loadContacts();
  const num = arg1 ? normNum(arg1) : undefined;
  const afterCmd = text.trim().replace(/^\S+\s*/, '');
  const arg = rest.join(' ');

  switch (cmd.toLowerCase()) {
    case '/on': {
      setEnabled(true);
      const people = Object.entries(contacts).filter(([, c]) => c.personal).map(([n, c]) => `${c.name || ''} ${n}`.trim()).concat(PERSONAL_ENV.map((n) => n + ' (settings)'));
      return say(`Bot is ON. Everyone who is not on your people list is treated as a client.\nYour people (${people.length}):\n${people.join('\n') || 'none yet'}`);
    }
    case '/off':
      setEnabled(false);
      return say('Bot is OFF');
    case '/mine': {
      // accepts one number or a pasted list, one person per line or separated by commas
      const found = [];
      for (const seg of afterCmd.split(/[\n,;]+/)) {
        const mt = seg.match(/\+?\d[\d\s-]{7,}\d/);
        if (!mt) continue;
        const n = normNum(mt[0]);
        const name = seg.replace(mt[0], '').replace(/[:\-]+/g, ' ').trim();
        contacts[n] = { ...contacts[n], personal: true };
        if (name) contacts[n].name = name;
        found.push(`${name || 'no name'} ${n}`);
      }
      if (!found.length) return say('Use: .mine 0712345678 Name   (or paste a list, one person per line)');
      saveContacts(contacts);
      return say(`Saved ${found.length} of your people. The bot will not reply to them or touch their calls:\n${found.join('\n')}`);
    }
    case '/project': {
      const [pname, pdesc, plink] = afterCmd.split('|').map((x) => x.trim());
      if (!pname) return say('Use: .project Name | description | https://link   (attach a picture to the same message to show it in the menu)');
      const list = loadProjects();
      const id = Date.now().toString(36);
      let image;
      if (m?.message?.imageMessage) {
        try {
          const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          fs.mkdirSync(path.join(DATA, 'projects'), { recursive: true });
          image = `${id}.jpg`;
          fs.writeFileSync(path.join(DATA, 'projects', image), buf);
        } catch (e) {
          console.error('image error:', e.message);
        }
      }
      list.push({ id, name: pname, description: pdesc || '', link: plink || '', image });
      saveProjects(list);
      return say(`Project added (${list.length} in total) ${image ? 'with its picture' : 'without a picture'}.`);
    }
    case '/projects':
      return say(loadProjects().map((p, i) => `${i + 1}. ${p.name} ${p.link || ''}${p.image ? ' [pic]' : ''}`).join('\n') || 'No projects yet. Add one: .project Name | description | link (attach a picture)');
    case '/delproject': {
      const list = loadProjects();
      const i = Number(arg1) - 1;
      if (!list[i]) return say('Use: .delproject 2   (see the numbers with .projects)');
      const [gone] = list.splice(i, 1);
      saveProjects(list);
      return say(`Removed "${gone.name}".`);
    }
    case '/unmine': {
      if (!num) return say('Use: /unmine 254712345678');
      if (contacts[num]) delete contacts[num].personal;
      saveContacts(contacts);
      return say(`${num} is no longer in your people list.`);
    }
    case '/people': {
      const list = Object.entries(contacts).filter(([, c]) => c.personal).map(([n, c]) => `${n} ${c.name || ''}`.trim());
      return say((list.concat(PERSONAL_ENV.map((n) => n + ' (from settings)')).join('\n')) || 'No people saved yet.');
    }
    case '/voices':
      return say(Object.keys(loadVoices()).join(', ') || 'No saved voices yet. Add one: /addvoice soft VOICE_ID');
    case '/addvoice': {
      const id = rest[0];
      if (!arg1 || !id) return say('Use: /addvoice name VOICE_ID');
      const lib = loadVoices();
      lib[arg1.toLowerCase()] = id;
      saveVoices(lib);
      return say(`Saved voice "${arg1.toLowerCase()}".`);
    }
    case '/voice': {
      const v = arg.toLowerCase();
      if (!num || !v) return say('Use: /voice 254712345678 voicename (or default)');
      const lib = loadVoices();
      if (v !== 'default' && !lib[v]) return say(`Unknown voice. Saved voices: ${Object.keys(lib).join(', ') || 'none'}`);
      contacts[num] = { ...contacts[num] };
      if (v === 'default') delete contacts[num].voice;
      else contacts[num].voice = v;
      saveContacts(contacts);
      return say(`${num} will now get the "${v}" voice.`);
    }
    case '/online': {
      const was = ownerStatus;
      setStatus('online');
      const told = was === 'offline' ? await announceBackOnline(sock) : 0;
      return say(`Status: you are ONLINE. Calls will ring on your phone.${told ? ` I told ${told} people who tried to reach you that you are available.` : ''}`);
    }
    case '/offline':
      setStatus('offline');
      return say('Status: you are OFFLINE. The bot will decline calls and tell people you are away. When you send .online it will tell them you are back.');
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

async function elevenVoice(text, voiceId) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId || ELEVEN_VOICE}?output_format=mp3_44100_128`,
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
async function textToVoice(text, voiceId) {
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      return await elevenVoice(text, voiceId);
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

  const system = `You are the WhatsApp assistant for ${BUSINESS}, a software company run by ${OWNER_FULL}. You reply to customers and potential customers while ${OWNER} is away.
Business information (your only source for services, prices and terms):
${loadBiz()}

Projects we have done (share the link when it helps the customer):
${projectsText()}

About this person (written by ${OWNER}): ${contact.notes || 'no notes, treat as a new customer, be polite and professional'}.
${OWNER}'s current instructions for this person: ${(contact.instructions || []).map((i) => i.text).join(' | ') || 'none'}.
Rules:
- Short, friendly, professional replies. Always reply in ${LANG}, even if the customer writes in another language.
- You can tell customers to send *.menu* to see projects, services and prices and to place an order.
- It is ${timeGreeting()} in Nairobi. Use a greeting that fits the time of day, in warm, natural words.
- Prices are starting estimates. The final price comes in a written quote from ${OWNER}. Never promise a price, discount, deadline or ownership terms beyond what is written above.
- Help the customer: explain the services, and find out what they need (what to build, budget, timeline) and their name. Tell them ${OWNER} will follow up.
- If they ask for the price list or the services guide, add [SEND_PRICE_LIST] or [SEND_GUIDE] at the very end of your reply and the PDF will be attached.
- Read the person's mood (angry, sad, worried, excited) and answer in a fitting tone: calm and respectful if upset, warm if happy.
- ${OWNER} is currently ${ownerStatus}. Say so honestly if it matters: if online, he is around but cannot talk now; if offline, he is away.
- You are an assistant, not ${OWNER}. If they sincerely ask whether you are a bot or a human, say you are ${BUSINESS}'s AI assistant.
- Never invent facts. If unsure, say you will pass the message on to ${OWNER}. Do not share ${OWNER}'s personal details.
- Do not flirt, play a romantic partner, or try to manipulate anyone's feelings.`;

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
// Voice note after a call: fresh, time-aware wording from Gemini. Falls back to the fixed lines if it fails.
async function callScript(num, kind = 'rejected_by_bot') {
  const contact = loadContacts()[num] || {};
  const hasInstr = (contact.instructions || []).some((i) => i.repeat === 'always' || !i.used);
  if (!hasInstr && contact.firstMessages?.length) return pickFirst(num, contact); // your own custom lines for this number
  try {
    return await callScriptAI(num, kind);
  } catch (e) {
    console.error('script AI failed, using a fixed line:', e.message);
    return pickFirst(num, contact);
  }
}

async function callScriptAI(num, kind) {
  const contacts = loadContacts();
  const contact = contacts[num] || {};
  const active = (contact.instructions || []).filter((i) => i.repeat === 'always' || !i.used);

  const r = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: [{
      role: 'user',
      parts: [{ text: `Write a short WhatsApp voice note (max 2 spoken sentences, polite and natural, in ${LANG}) from the assistant of ${BUSINESS} (run by ${OWNER_FULL}) to someone who just called and was rejected. Be professional and welcoming. Always end by telling them to send the word .menu on WhatsApp to see our services, projects and prices.
About them: ${contact.notes || 'no notes'}
${OWNER}'s instructions for what to say: ${active.map((i) => i.text).join(' | ') || 'none: write a warm, general message'}
Start with a greeting that fits the time of day (it is ${timeGreeting()} in Nairobi) and vary the wording so it never sounds the same twice.
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
  const roster = Object.entries(contacts).map(([n, c]) => `${n} = ${c.name || 'unnamed'}${c.personal ? ' [personal: bot ignores]' : ''}`).join('\n') || 'none yet';
  const key = 'owner:' + jid;
  const h = history.get(key) ?? [];
  h.push({ role: 'user', parts: [{ text }] });

  const system = `You turn the owner's WhatsApp messages into actions for his call-answering bot.
Known contacts (number = name):
${roster}
Saved voices: ${Object.keys(loadVoices()).join(', ') || 'none'}

Reply ONLY with JSON: {"reply": string, "actions": []}
Action types:
{"type":"instruct","number":"digits","name":"optional","text":"what the bot should tell this person","repeat":"once"|"always"}
{"type":"train","number":"digits","name":"optional","notes":"how to treat or talk to this person"}
{"type":"clear_instructions","number":"digits"}
{"type":"mark_personal","number":"digits","name":"optional"}  (friends, family, partner: the bot never replies to them or handles their calls)
{"type":"unmark_personal","number":"digits"}
{"type":"add_project","name":"project name","description":"short description","link":"url"}  (a project for the portfolio; tell the owner to send a picture with the caption .project Name | description | link if he wants an image)
{"type":"set_voice","number":"digits","voice":"saved voice name or default"}
{"type":"add_voice","name":"short name","id":"ElevenLabs voice id the owner gave"}
{"type":"on"} {"type":"off"} {"type":"list"}
{"type":"status","value":"online"|"offline"}  (the owner says whether he is available)
{"type":"help_reply","message":"the text the other person sent","about":"optional who sent it"}  (the owner pastes a message and asks how to reply)

Rules:
- Map names to numbers using the contacts list. Numbers are digits with country code, no plus. Kenyan numbers starting with 0 (like 0712345678) become 254712345678.
- If the owner pastes a list of family or friends, return one mark_personal action for each person.
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
    const n = a.number ? normNum(a.number) : undefined;
    if (a.type === 'on') setEnabled(true);
    else if (a.type === 'off') setEnabled(false);
    else if (a.type === 'add_voice' && a.name && a.id) {
      const lib = loadVoices();
      lib[a.name.toLowerCase()] = a.id;
      saveVoices(lib);
    } else if (n && a.type === 'set_voice' && a.voice) {
      const lib = loadVoices();
      const v = a.voice.toLowerCase();
      c[n] = { ...c[n] };
      if (v === 'default') delete c[n].voice;
      else if (lib[v]) c[n].voice = v;
      else extra += `\nUnknown voice "${v}".`;
    } else if (a.type === 'add_project' && a.name) {
      const pl = loadProjects();
      pl.push({ id: Date.now().toString(36), name: a.name, description: a.description || '', link: a.link || '' });
      saveProjects(pl);
    } else if (n && a.type === 'mark_personal') {
      c[n] = { ...c[n], personal: true };
      if (a.name) c[n].name = a.name;
    } else if (n && a.type === 'unmark_personal' && c[n]) {
      delete c[n].personal;
    } else if (a.type === 'status') {
      const was = ownerStatus;
      setStatus(a.value);
      if (was === 'offline' && ownerStatus === 'online') extra += `\nI told ${await announceBackOnline(sock)} people that you are available.`;
    }
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
  const waitCallEnd = async (id, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const st = callState.get(id);
      if (['accept', 'reject', 'timeout', 'terminate'].includes(st)) return st;
      await sleep(1000);
    }
    return callState.get(id);
  };
  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      callState.set(call.id, call.status);
      if (!enabled || call.status !== 'offer' || handled.has(call.id)) continue;
      handled.add(call.id);

      const num = numOf(call.callerPn || call.from);
      console.log('CALL from', call.from, call.callerPn || '', 'enabled=' + enabled);
      const contacts = loadContacts();
      const contact = contacts[num] || {};
      if (isPersonal([num, numOf(call.from)], contacts)) continue; // my people: leave their calls alone
      if (ONLY_LISTED && !contacts[num]) continue;

      try {
        let kind;
        if (ownerStatus === 'online') {
          // you are online: the phone keeps ringing so you can pick up. A note is sent only if it ends unanswered.
          const st = await waitCallEnd(call.id, 45_000);
          console.log('CALL (online) ended:', st);
          if (st === 'accept') continue;
          kind = st === 'reject' ? 'declined_by_owner' : 'missed';
        } else {
          // you are offline: ring briefly, then the bot hangs up
          await sleep(RING_MS);
          const st = callState.get(call.id);
          console.log('CALL status after ring:', st);
          if (st === 'accept') continue; // you answered: do nothing
          kind = 'rejected_by_bot';
          if (st === 'reject') kind = 'declined_by_owner';
          else if (st === 'timeout' || st === 'terminate') kind = 'missed';
          else await sock.rejectCall(call.id, call.from);
        }
        if (ownerStatus === 'offline') addWaiting(num);
        await sleep(VOICE_DELAY_MS);

        notifyOwner(sock, `Call from ${num}${contact.name ? ' (' + contact.name + ')' : ''}: ${kind.replace(/_/g, ' ')}. The bot is sending a voice note.`);
        const text = await callScript(num, kind);
        await sock.sendPresenceUpdate('recording', call.from);
        const audio = await textToVoice(text, voiceFor(contact));
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

      const body = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption;
      if (!body) continue;

      // Owner commands: only from your own "message yourself" chat
      const me = [sock.user?.id, sock.user?.lid].filter(Boolean).map(numOf);
      if (m.key.fromMe) {
        if (me.includes(numOf(jid)) && /^[\/.][a-z]+(\s|$)/i.test(body)) {
          await ownerCommand(sock, jid, '/' + body.trim().slice(1), m).catch((e) => console.error('command error:', e.message));
        }
        continue;
      }
      // Messages from your other number(s) are commands, and work even when the bot is OFF
      if ([numOf(phoneJid), numOf(jid)].some((n) => OWNER_NUMBERS.includes(n))) {
        const isCmd = /^[\/.][a-z]+(\s|$)/i.test(body);
        const handler = isCmd ? ownerCommand : ownerAI;
        await handler(sock, jid, isCmd ? '/' + body.trim().slice(1) : body, m).catch((e) => console.error('owner error:', e.message));
        continue;
      }
      if (!enabled) continue;

      const num = numOf(phoneJid);
      const contacts = loadContacts();
      if (ONLY_LISTED && !contacts[num]) continue;
      const contact = contacts[num] || {};
      if (isPersonal([num, numOf(jid)], contacts)) continue; // my people: the bot stays silent

      if (ownerStatus === 'offline') addWaiting(num); // so they are told when you are back
      // menu by numbers, then a real-time greeting for new or returning contacts
      if (await handleMenu(sock, jid, num, contact, body).catch((e) => (console.error('menu error:', e.message), false))) continue;
      const greeted = await maybeGreet(sock, jid, num, contact, body);
      if (greeted === 'only') continue;

      try {
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(1500 + Math.random() * 2500);
        let reply = await aiReply(num, contact, body);
        const sendPrice = reply.includes('[SEND_PRICE_LIST]');
        const sendGuide = reply.includes('[SEND_GUIDE]');
        reply = reply.replace(/\[SEND_(PRICE_LIST|GUIDE)\]/g, '').trim();

        // tell the owner about new enquiries (at most once every 6 hours per number)
        if (Date.now() - (leadSeen.get(num) || 0) > 6 * 3600 * 1000) {
          leadSeen.set(num, Date.now());
          notifyOwner(sock, `New message from ${num}${contact.name ? ' (' + contact.name + ')' : ''}:\n"${body.slice(0, 300)}"`);
        }

        const n = replyCount.get(num) ?? 0;
        replyCount.set(num, n + 1);
        const useVoice = contact.mode === 'voice' || (contact.mode === 'alternate' && n % 2 === 0); // default: text

        if (useVoice) {
          await sock.sendPresenceUpdate('recording', jid);
          const audio = await textToVoice(reply, voiceFor(contact));
          await sock.sendMessage(jid, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        } else {
          await sock.sendMessage(jid, { text: reply });
        }
        if (sendPrice) await sendDoc(sock, jid, 'Skyline-Technologies-Price-List.pdf');
        if (sendGuide) await sendDoc(sock, jid, 'Skyline-Technologies-Services-Guide.pdf');
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
