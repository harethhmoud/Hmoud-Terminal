const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const { Snaptrade } = require("snaptrade-typescript-sdk");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const USER_DATA_FILE = path.join(__dirname, "user-data.json");

// ── SnapTrade client ────────────────────────────────────────────────────

let snaptrade = null;

function getClient() {
  if (!snaptrade) {
    const clientId = process.env.SNAPTRADE_CLIENT_ID;
    const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY;
    if (!clientId || !consumerKey) {
      return null;
    }
    snaptrade = new Snaptrade({ consumerKey, clientId });
  }
  return snaptrade;
}

// ── Persist user credentials locally ────────────────────────────────────

function loadUserData() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      return JSON.parse(fs.readFileSync(USER_DATA_FILE, "utf8"));
    }
  } catch (_) {}
  return null;
}

function saveUserData(data) {
  fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Routes ──────────────────────────────────────────────────────────────

// Check if SnapTrade is configured and user is registered
app.get("/api/status", async (_req, res) => {
  const client = getClient();
  if (!client) {
    return res.json({
      configured: false,
      registered: false,
      connected: false,
      message: "SnapTrade API keys not found. Add them to .env file.",
    });
  }

  const userData = loadUserData();
  if (!userData) {
    return res.json({ configured: true, registered: false, connected: false });
  }

  // Check if user has any connected accounts
  try {
    const accounts = (
      await client.accountInformation.listUserAccounts({
        userId: userData.userId,
        userSecret: userData.userSecret,
      })
    ).data;

    return res.json({
      configured: true,
      registered: true,
      connected: accounts.length > 0,
      accountCount: accounts.length,
    });
  } catch (err) {
    return res.json({
      configured: true,
      registered: true,
      connected: false,
      error: err.message,
    });
  }
});

// Register a new SnapTrade user
app.post("/api/register", async (_req, res) => {
  const client = getClient();
  if (!client) {
    return res.status(500).json({ error: "SnapTrade not configured" });
  }

  // If already registered, return existing data
  const existing = loadUserData();
  if (existing) {
    return res.json({ userId: existing.userId, alreadyRegistered: true });
  }

  try {
    const userId = "hmoud-terminal-" + Date.now();
    const response = await client.authentication.registerSnapTradeUser({
      userId,
    });
    const userSecret = response.data.userSecret;

    saveUserData({ userId, userSecret });
    res.json({ userId, registered: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get the connection portal URL (user opens this to link Wealthsimple)
app.get("/api/connect", async (_req, res) => {
  const client = getClient();
  const userData = loadUserData();

  if (!client || !userData) {
    return res.status(400).json({ error: "Not configured or registered" });
  }

  try {
    const response = await client.authentication.loginSnapTradeUser({
      userId: userData.userId,
      userSecret: userData.userSecret,
    });

    const data = response.data;
    if (!data.redirectURI) {
      return res.status(500).json({ error: "No redirect URI returned" });
    }

    res.json({ redirectURI: data.redirectURI });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all connected accounts
app.get("/api/accounts", async (_req, res) => {
  const client = getClient();
  const userData = loadUserData();

  if (!client || !userData) {
    return res.status(400).json({ error: "Not configured or registered" });
  }

  try {
    const accounts = (
      await client.accountInformation.listUserAccounts({
        userId: userData.userId,
        userSecret: userData.userSecret,
      })
    ).data;

    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all holdings across all accounts
app.get("/api/holdings", async (_req, res) => {
  const client = getClient();
  const userData = loadUserData();

  if (!client || !userData) {
    return res.status(400).json({ error: "Not configured or registered" });
  }

  try {
    const holdings = (
      await client.accountInformation.getAllUserHoldings({
        userId: userData.userId,
        userSecret: userData.userSecret,
      })
    ).data;

    res.json(holdings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get positions for a specific account
app.get("/api/positions/:accountId", async (req, res) => {
  const client = getClient();
  const userData = loadUserData();

  if (!client || !userData) {
    return res.status(400).json({ error: "Not configured or registered" });
  }

  try {
    const positions = (
      await client.accountInformation.getUserAccountPositions({
        userId: userData.userId,
        userSecret: userData.userSecret,
        accountId: req.params.accountId,
      })
    ).data;

    res.json(positions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get balances for a specific account
app.get("/api/balances/:accountId", async (req, res) => {
  const client = getClient();
  const userData = loadUserData();

  if (!client || !userData) {
    return res.status(400).json({ error: "Not configured or registered" });
  }

  try {
    const balances = (
      await client.accountInformation.getUserAccountBalance({
        userId: userData.userId,
        userSecret: userData.userSecret,
        accountId: req.params.accountId,
      })
    ).data;

    res.json(balances);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect: delete SnapTrade user and local data
app.post("/api/disconnect", async (_req, res) => {
  const client = getClient();
  const userData = loadUserData();

  if (!client || !userData) {
    return res.status(400).json({ error: "Not configured or registered" });
  }

  try {
    await client.authentication.deleteSnapTradeUser({
      userId: userData.userId,
    });
  } catch (_) {
    // If deletion fails on SnapTrade side, still clean up locally
  }

  try {
    fs.unlinkSync(USER_DATA_FILE);
  } catch (_) {}

  snaptrade = null;
  res.json({ disconnected: true });
});

// Get scraped news articles
const NEWS_FILE = path.join(__dirname, "scraped-news.json");

app.get("/api/news", (_req, res) => {
  try {
    if (fs.existsSync(NEWS_FILE)) {
      const data = JSON.parse(fs.readFileSync(NEWS_FILE, "utf8"));
      return res.json(data.articles || []);
    }
  } catch (_) {}
  res.json([]);
});

// Fallback: serve index.html
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Hmoud Terminal running at http://localhost:${PORT}`);
  const client = getClient();
  if (!client) {
    console.log(
      "Warning: SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY not set in .env"
    );
    console.log("The dashboard will run with sample data until configured.");
  }
});
