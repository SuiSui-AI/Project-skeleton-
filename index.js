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

// Step 2: Callback
app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.send("❌ No code returned from Google.");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Save tokens in session
    req.session.tokens = tokens;

    res.send("✅ Login successful! Tokens saved in session.");
  } catch (err) {
    console.error("Error exchanging code for token:", err);
    res.send("❌ Error during authentication.");
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
