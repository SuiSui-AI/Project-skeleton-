import express from "express";
import session from "express-session";
import { google } from "googleapis";

const app = express();

// ---------- SESSION SETUP ----------
app.use(
  session({
    secret: "your-secret-key", // kuch bhi random
    resave: false,
    saveUninitialized: true,
  })
);

// ---------- GOOGLE OAUTH SETUP ----------
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,     // Render me env var set karo
  process.env.GOOGLE_CLIENT_SECRET, // Render me env var set karo
  process.env.REDIRECT_URI          // e.g. https://your-app.onrender.com/oauth2callback
);

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
];

// ---------- ROUTES ----------
app.get("/", (req, res) => {
  res.send(`<h2>✅ App Running!</h2>
    <a href="/auth/google">Login with Google</a>`);
});

// Step 1: Login start
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  res.redirect(url);
});

// Step 2: Callback after login
app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("❌ No code found");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Save to session
    req.session.tokens = tokens;

    res.send("🎉 Login successful! Tokens saved.");
  } catch (err) {
    console.error("OAuth Error:", err);
    res.send("❌ OAuth Failed");
  }
});

// Example: Check user channel
app.get("/channel", async (req, res) => {
  if (!req.session.tokens) return res.send("⚠️ Not logged in");

  oauth2Client.setCredentials(req.session.tokens);

  const youtube = google.youtube("v3");
  const response = await youtube.channels.list({
    auth: oauth2Client,
    part: "snippet,contentDetails,statistics",
    mine: true,
  });

  res.json(response.data);
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});});

app.listen(10000, () => console.log("Server running on 10000"));app.get("/auth", (req, res)=>{
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
    if(!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY env");

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

    const reply = await geminiAiReply(context, cmd.authorDetails.displayName, cmd.snippet.displayMessage);
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
