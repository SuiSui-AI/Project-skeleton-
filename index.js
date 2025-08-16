import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

// ====== ENV ======
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // e.g. https://your-app.onrender.com/oauth2/callback
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LIVE_CHAT_ID = process.env.LIVE_CHAT_ID; // fill after /livechatid step
const BOT_NAME = process.env.BOT_NAME || "Sui Sui";
const TRIGGERS = (process.env.TRIGGERS || "!sui,!suisui,!hello sui sui")
  .split(",").map(s=>s.trim().toLowerCase());

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

let REFRESH_TOKEN = process.env.REFRESH_TOKEN || null;
let lastRespondedMessageId = null; // in-memory dedupe

function setRefreshToken(rt){
  REFRESH_TOKEN = rt;
  process.env.REFRESH_TOKEN = rt; // for current session
}

function authClient(){
  if(!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) throw new Error("Missing OAuth env: CLIENT_ID/CLIENT_SECRET/REDIRECT_URI");
  if(!REFRESH_TOKEN) throw new Error("Missing REFRESH_TOKEN. Open /auth, complete consent, then paste token in env.");
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return google.youtube({ version: "v3", auth: oauth2Client });
}

app.get("/", (_, res)=>res.send("Sui Sui bot server running. Use /auth, /oauth2/callback, /livechatid, /run"));

// 1) Start OAuth: open this URL in browser
app.get("/auth", (req, res)=>{
  const scopes = [
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/youtube.readonly",
  ];
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });
  res.redirect(url);
});

// 2) OAuth redirect target: exchange code -> tokens
app.get("/oauth2/callback", async (req, res)=>{
  try{
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    if(tokens.refresh_token){
      setRefreshToken(tokens.refresh_token);
    }
    const msg = `OK. REFRESH_TOKEN: ${tokens.refresh_token ? tokens.refresh_token : "<not returned>"}

Now add this as REFRESH_TOKEN env in Render and redeploy.`;
    res.type("text/plain").send(msg);
  }catch(err){
    res.status(500).send("OAuth error: "+err.message);
  }
});

// 3) Get liveChatId of active broadcast
app.get("/livechatid", async (req, res)=>{
  try{
    const yt = authClient();
    const r = await yt.liveBroadcasts.list({ part:["snippet"], broadcastStatus:"active", broadcastType:"all" });
    if(!r.data.items || !r.data.items.length) return res.status(404).send("No active live. Start an unlisted test stream and reload.");
    const id = r.data.items[0].snippet.liveChatId;
    res.type("text/plain").send(id);
  }catch(e){ res.status(500).send(e.message); }
});

async function openAiReply(contextMsgs, toUser, rawText){
  const system = `You are a short, friendly YouTube viewer named ${BOT_NAME}. Keep replies casual, 1-2 sentences, add a small follow-up question sometimes. Use light emojis.`;
  const messages = [{ role: "system", content: system }];
  contextMsgs.slice(-10).forEach(m=>messages.push({ role:"user", content: `${m.who}: ${m.text}` }));
  messages.push({ role:"user", content: `Reply to ${toUser}'s message: ${rawText}` });

  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${OPENAI_API_KEY}`},
    body: JSON.stringify({ model:"gpt-3.5-turbo", temperature:0.8, max_tokens:120, messages })
  });
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "").trim();
}

// 4) Run one polling cycle: read -> detect command -> reply
app.post("/run", async (req, res)=>{
  try{
    if(!LIVE_CHAT_ID) throw new Error("Set LIVE_CHAT_ID env (see /livechatid)");
    if(!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY env");

    const yt = authClient();

    const { data } = await yt.liveChatMessages.list({
      liveChatId: LIVE_CHAT_ID,
      part:["snippet","authorDetails"],
      maxResults:200,
    });
    const items = data.items || [];

    // latest command message
    let cmd = null; let idx = -1;
    for(let i=items.length-1;i>=0;i--){
      const t = (items[i].snippet.displayMessage||"").toLowerCase();
      if(TRIGGERS.some(tr=>t.includes(tr))){ cmd = items[i]; idx = i; break; }
    }
    if(!cmd) return res.json({status:"no-command"});
    if(lastRespondedMessageId === cmd.id) return res.json({status:"duplicate-skipped"});

    const context = [];
    for(let i=Math.max(0, idx-8); i<items.length; i++){
      const it = items[i];
      context.push({ who: it.authorDetails.displayName, text: it.snippet.displayMessage });
    }

    const reply = await openAiReply(context, cmd.authorDetails.displayName, cmd.snippet.displayMessage);
    if(!reply) return res.status(500).json({error:"openai-empty-reply"});

    await yt.liveChatMessages.insert({
      part:["snippet"],
      requestBody:{
        snippet:{
          liveChatId: LIVE_CHAT_ID,
          type:"textMessageEvent",
          textMessageDetails:{ messageText: reply }
        }
      }
    });

    lastRespondedMessageId = cmd.id;
    res.json({status:"posted", reply});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("Sui Sui server on :"+PORT));
