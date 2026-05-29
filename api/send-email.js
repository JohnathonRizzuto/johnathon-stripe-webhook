// send-email.js -- Gmail SMTP send endpoint.
//
// Plain .js (not .ts) to bypass Vercel's TypeScript bundler, which was
// failing to load the compiled .ts output. Same fix we used for /api/state.
//
// Required env vars: GMAIL_USER, GMAIL_APP_PASSWORD, SEND_EMAIL_KEY.
// See README "Email automation" for full details.

const nodemailer = require("nodemailer");

function isValidEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Send-Key");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204).end();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  // Shared-secret auth
  const sentKey = req.headers["x-send-key"];
  const expectedKey = process.env.SEND_EMAIL_KEY;
  if (!expectedKey) {
    console.error("SEND_EMAIL_KEY env var is not set");
    res.status(500).json({ ok: false, error: "Server misconfigured" });
    return;
  }
  if (sentKey !== expectedKey) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const body = req.body || {};
  if (!body.to || !isValidEmail(body.to)) {
    res.status(400).json({ ok: false, error: "Missing or invalid field: to" });
    return;
  }
  if (!body.subject || typeof body.subject !== "string") {
    res.status(400).json({ ok: false, error: "Missing field: subject" });
    return;
  }
  if (!body.body || typeof body.body !== "string") {
    res.status(400).json({ ok: false, error: "Missing field: body" });
    return;
  }

  const gmailUser = (process.env.GMAIL_USER || "").trim();
  // Strip ALL whitespace from the App Password -- Google displays it as
  // "abcd efgh ijkl mnop" for readability but the spaces aren't part of the
  // credential. nodemailer is rejected by Gmail SMTP if spaces remain.
  const gmailPass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!gmailUser || !gmailPass) {
    console.error("GMAIL_USER or GMAIL_APP_PASSWORD env var is not set");
    res.status(500).json({ ok: false, error: "Email service not configured" });
    return;
  }
  const credDiag = {
    userLen: gmailUser.length,
    passLen: gmailPass.length,
    userEndsWith: gmailUser.slice(-12),
  };
  console.error("Gmail creds loaded:", credDiag);

  const fromName = (body.fromName || "Johnathon Builds").replace(/[\r\n]/g, "");

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  try {
    const info = await transporter.sendMail({
      from: '"' + fromName + '" <' + gmailUser + ">",
      to: body.to,
      subject: body.subject,
      text: body.body,
    });
    console.log("Email sent:", {
      to: body.to,
      subject: body.subject,
      messageId: info.messageId,
    });
    res.status(200).json({ ok: true, messageId: info.messageId });
  } catch (err) {
    const msg = err && err.message ? err.message : "unknown";
    console.error("sendMail failed:", msg, "creds:", credDiag);
    const shortMsg = msg.length > 120 ? msg.slice(0, 120) + "..." : msg;
    res.status(500).json({
      ok: false,
      error:
        shortMsg +
        " [userLen=" +
        credDiag.userLen +
        ", passLen=" +
        credDiag.passLen +
        ", user=..." +
        credDiag.userEndsWith +
        "]",
    });
  }
};
