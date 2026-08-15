const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Simple multipart/form-data parser for single PDF file upload
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return reject(new Error('Not multipart/form-data'));
    }
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('No boundary found'));
    const boundary = boundaryMatch[1];

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from('--' + boundary);

      // Find parts
      let start = 0;
      const parts = [];
      while (true) {
        const idx = buffer.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) {
          parts.push(buffer.slice(start, idx));
        }
        start = idx + boundaryBuf.length;
        // Skip \r\n after boundary
        if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
        // Check for closing --
        if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
      }

      // Parse first file part
      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        if (!headers.includes('filename=')) continue;

        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const filename = filenameMatch ? filenameMatch[1] : 'upload.pdf';
        // Body starts after \r\n\r\n and ends before trailing \r\n
        let body = part.slice(headerEnd + 4);
        if (body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
          body = body.slice(0, body.length - 2);
        }
        return resolve({ filename, data: body });
      }
      reject(new Error('No file found in upload'));
    });
    req.on('error', reject);
  });
}

app.use(express.json());

// Never cache HTML pages — always send fresh from server
app.use((req, res, next) => {
  const p = req.path;
  if (p === '/' || p === '/scan' || p.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Clean URL alias: /scan → /scan.html
app.get('/scan', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan.html'));
});

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ customers: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

app.get('/api/customers', (req, res) => {
  const state = loadState();
  const q = (req.query.q || '').toLowerCase();
  let customers = state.customers;
  if (q) {
    customers = customers.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.mobile || '').includes(q) ||
      (c.aadhaar || '').includes(q) ||
      (c.receiptNo || '').toLowerCase().includes(q)
    );
  }
  res.json(customers);
});

app.get('/api/next-receipt-number', (req, res) => {
  const state = loadState();
  const year = new Date().getFullYear();
  const prefix = 'RL-' + year + '-';
  let maxNum = 0;
  state.customers.forEach(c => {
    if (c.receiptNo && c.receiptNo.startsWith(prefix)) {
      const num = parseInt(c.receiptNo.replace(prefix, ''), 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
  });
  const next = prefix + String(maxNum + 1).padStart(3, '0');
  res.json({ receiptNo: next });
});

app.get('/api/customers/:id', (req, res) => {
  const state = loadState();
  const c = state.customers.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.post('/api/customers', (req, res) => {
  const state = loadState();
  const customer = { id: Date.now().toString(), createdAt: new Date().toISOString(), ...req.body };
  state.customers.unshift(customer);
  saveState(state);
  res.json(customer);
});

app.put('/api/customers/:id', (req, res) => {
  const state = loadState();
  const idx = state.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  state.customers[idx] = { ...state.customers[idx], ...req.body };
  saveState(state);
  res.json(state.customers[idx]);
});

app.delete('/api/customers/:id', (req, res) => {
  const state = loadState();
  state.customers = state.customers.filter(c => c.id !== req.params.id);
  saveState(state);
  // Also delete any uploaded agreement PDF
  const pdfPath = path.join(UPLOADS_DIR, 'agreement-' + req.params.id + '.pdf');
  if (fs.existsSync(pdfPath)) {
    fs.unlinkSync(pdfPath);
  }
  // Also delete any uploaded receipt PDF
  const receiptPdfPath = path.join(UPLOADS_DIR, 'receipt-' + req.params.id + '.pdf');
  if (fs.existsSync(receiptPdfPath)) {
    fs.unlinkSync(receiptPdfPath);
  }
  res.json({ ok: true });
});

// Upload agreement PDF for a customer
app.post('/api/customers/:id/upload-agreement', async (req, res) => {
  try {
    const { filename, data } = await parseMultipart(req);
    if (!filename.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }
    if (data.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 10MB)' });
    }
    const state = loadState();
    const idx = state.customers.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Customer not found' });

    const savedFilename = 'agreement-' + req.params.id + '.pdf';
    fs.writeFileSync(path.join(UPLOADS_DIR, savedFilename), data);
    state.customers[idx].agreementPdf = savedFilename;
    saveState(state);
    res.json({ ok: true, filename: savedFilename });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Upload failed' });
  }
});

// Delete uploaded agreement PDF
app.delete('/api/customers/:id/agreement', (req, res) => {
  const state = loadState();
  const idx = state.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  const filename = state.customers[idx].agreementPdf;
  if (filename) {
    const pdfPath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
    delete state.customers[idx].agreementPdf;
    saveState(state);
  }
  res.json({ ok: true });
});

// Upload receipt PDF for a customer
app.post('/api/customers/:id/upload-receipt', async (req, res) => {
  try {
    const { filename, data } = await parseMultipart(req);
    if (!filename.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }
    if (data.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 10MB)' });
    }
    const state = loadState();
    const idx = state.customers.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Customer not found' });

    const savedFilename = 'receipt-' + req.params.id + '.pdf';
    fs.writeFileSync(path.join(UPLOADS_DIR, savedFilename), data);
    state.customers[idx].receiptPdf = savedFilename;
    saveState(state);
    res.json({ ok: true, filename: savedFilename });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Upload failed' });
  }
});

// Delete uploaded receipt PDF
app.delete('/api/customers/:id/receipt', (req, res) => {
  const state = loadState();
  const idx = state.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  const filename = state.customers[idx].receiptPdf;
  if (filename) {
    const pdfPath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
    delete state.customers[idx].receiptPdf;
    saveState(state);
  }
  res.json({ ok: true });
});


// ===== VIDEO VERIFICATION ROUTES =====
const VIDEO_DIR = path.join(__dirname, 'uploads', 'videos');
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

// Simple multipart parser for video/webm blobs (reuses same pattern as PDF upload)
function parseVideoMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return reject(new Error('Not multipart'));
    }
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('No boundary'));
    const boundary = boundaryMatch[1].trim();
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from('--' + boundary);
      let start = 0;
      const parts = [];
      while (true) {
        const idx = buf.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) parts.push(buf.slice(start, idx));
        start = idx + boundaryBuf.length;
        if (buf[start] === 0x0d && buf[start+1] === 0x0a) start += 2;
        if (buf[start] === 0x2d && buf[start+1] === 0x2d) break;
      }
      for (const part of parts) {
        const hEnd = part.indexOf('\r\n\r\n');
        if (hEnd === -1) continue;
        const headers = part.slice(0, hEnd).toString();
        if (!headers.includes('filename=') && !headers.includes('name="video"')) continue;
        let body = part.slice(hEnd + 4);
        if (body[body.length-2] === 0x0d && body[body.length-1] === 0x0a) body = body.slice(0, -2);
        const fnMatch = headers.match(/filename="([^"]+)"/);
        return resolve({ filename: fnMatch ? fnMatch[1] : 'video.webm', data: body });
      }
      reject(new Error('No video part found'));
    });
    req.on('error', reject);
  });
}

// GET /api/video/:customerId/script — returns dynamic script with substituted fields
app.get('/api/video/:customerId/script', (req, res) => {
  const state = loadState();
  const c = state.customers.find(x => x.id === req.params.customerId);
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  // Format agreement date from customer date or today
  const agreeDate = c.date
    ? new Date(c.date).toLocaleDateString('hi-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : new Date().toLocaleDateString('hi-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const name = c.name || '___';
  const fee = c.successFee ? 'रु. ' + Number(c.successFee).toLocaleString('en-IN') : 'रु. ___';
  const chequeNo = c.chequeNo || '___';
  const bankBranch = c.chequeBankBranch || '___';

  const blocks = [
    {
      label: 'प्रारंभ (Opening)',
      type: 'opening',
      text: `आज दिनांक ${agreeDate}, हम ${name} जी की ऋण सुविधा परामर्श अनुबंध की वीडियो पुष्टि रिकॉर्ड कर रहे हैं।`
    },
    {
      label: 'Q1 — पहचान (Section 1)',
      text: 'अपना पूरा नाम और पिता/पति का नाम बताइए।'
    },
    {
      label: 'Q2 — स्वैच्छिक हस्ताक्षर (Section 16b)',
      text: 'क्या आपने यह अनुबंध बिना किसी दबाव या जोर-जबरदस्ती के, अपनी स्वतंत्र इच्छा से हस्ताक्षर किया है?'
    },
    {
      label: 'Q3 — शुल्क की समझ (Section 2, 16c)',
      text: `क्या आप समझते हैं कि Ruralift की परामर्श सेवा निःशुल्क है, और सफलता-आधारित शुल्क ${fee} केवल ऋण के सफल वितरण पर ही देय होगा?`
    },
    {
      label: 'Q4 — PDC की समझ (Section 3, 16e)',
      text: `क्या आपने स्वेच्छा से चेक नंबर ${chequeNo} (${bankBranch}) जारी किया है, और आप समझते हैं कि यह कब जमा किया जा सकता है — ऋण वितरण पर शुल्क के रूप में, या अनुबंध भंग होने पर क्षतिपूर्ति के रूप में?`
    },
    {
      label: 'Q5 — चेक बाउंस परिणाम (Section 3f, 16e)',
      text: 'क्या आप जानते हैं कि चेक अनादरण की स्थिति में आप धारा 138, परक्राम्य लिखत अधिनियम के अंतर्गत आपराधिक रूप से दायी होंगे?'
    },
    {
      label: 'Q6 — DSA/कमीशन खुलासा (Section 16j)',
      text: 'क्या आपको बताया गया है कि Ruralift का ऋण संस्थानों के साथ DSA संबंध हो सकता है और वह कमीशन भी प्राप्त कर सकता है — फिर भी आप यह अतिरिक्त परामर्श शुल्क देने पर सहमत हैं?'
    },
    {
      label: 'Q7 — ऋण की गारंटी नहीं (Section 16f, 16h)',
      text: 'क्या आप समझते हैं कि Ruralift ऋणदाता नहीं है और ऋण स्वीकृति की कोई गारंटी नहीं दी गई है?'
    },
    {
      label: 'Q8 — दस्तावेज़ों की सत्यता (Section 16g)',
      text: 'क्या आपके द्वारा दिए गए सभी दस्तावेज़ और जानकारी सत्य, सटीक और पूर्ण हैं?'
    },
    {
      label: 'Q9 — डेटा शेयरिंग सहमति (Section 16i)',
      text: 'क्या आप सहमत हैं कि आपकी जानकारी बैंकों/NBFCs के साथ साझा की जा सकती है?'
    },
    {
      label: 'समापन (Closing — ग्राहक बोलें)',
      type: 'closing',
      text: `मैं ${name} पुष्टि करता/करती हूँ कि मैंने यह अनुबंध पढ़कर, समझकर, स्वेच्छा से हस्ताक्षर किया है।`
    }
  ];

  res.json({ blocks });
});

// POST /api/video/:customerId/upload — accept webm blob, save to uploads/videos/
app.post('/api/video/:customerId/upload', async (req, res) => {
  const state = loadState();
  const c = state.customers.find(x => x.id === req.params.customerId);
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  try {
    const { data } = await parseVideoMultipart(req);
    if (data.length > 200 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 200MB)' });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `video-${req.params.customerId}-${timestamp}.webm`;
    fs.writeFileSync(path.join(VIDEO_DIR, filename), data);
    res.json({ ok: true, filename });
  } catch(e) {
    res.status(400).json({ error: e.message || 'Upload failed' });
  }
});

// GET /api/video/:customerId/list — list saved videos for a customer
app.get('/api/video/:customerId/list', (req, res) => {
  const prefix = 'video-' + req.params.customerId + '-';
  let files = [];
  if (fs.existsSync(VIDEO_DIR)) {
    files = fs.readdirSync(VIDEO_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.webm'))
      .sort()
      .reverse()
      .map(f => {
        const stat = fs.statSync(path.join(VIDEO_DIR, f));
        const mb = (stat.size / (1024*1024)).toFixed(1);
        // Parse date from filename: video-{id}-YYYY-MM-DDTHH-MM-SS.webm
        const datePart = f.replace(prefix, '').replace('.webm', '');
        const friendly = datePart.replace('T', ' ').replace(/-/g, (m, o) => o < 10 ? '-' : ':');
        return { filename: f, date: friendly, size: mb + ' MB' };
      });
  }
  res.json({ videos: files });
});

// GET /api/video/download/:filename — force-download video file
app.get('/api/video/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(VIDEO_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
});

// GET /api/video/file/:filename — stream video with range support
app.get('/api/video/file/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(VIDEO_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/webm',
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/webm',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});


// DELETE /api/video/:customerId/:filename — delete a saved video
app.delete('/api/video/:customerId/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const prefix = 'video-' + req.params.customerId + '-';
  if (!filename.startsWith(prefix) || !filename.endsWith('.webm')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(VIDEO_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Delete failed' });
  }
});

// ===== EMAIL CONFIG =====
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ===== GMAIL OAUTH2 =====
const { google } = require('googleapis');

function getRedirectUri() {
  // Railway sets RAILWAY_PUBLIC_DOMAIN automatically
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN + '/oauth2callback';
  }
  return 'http://localhost:' + PORT + '/oauth2callback';
}

function getOAuth2Client() {
  const cfg = loadConfig();
  const client = new google.auth.OAuth2(
    cfg.oauthClientId,
    cfg.oauthClientSecret,
    getRedirectUri()
  );
  if (cfg.oauthTokens) client.setCredentials(cfg.oauthTokens);
  // Auto-save refreshed tokens
  client.on('tokens', tokens => {
    const c = loadConfig();
    c.oauthTokens = { ...c.oauthTokens, ...tokens };
    saveConfig(c);
  });
  return client;
}

// GET /api/email-config — return current OAuth status
app.get('/api/email-config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    hasClientId:     !!cfg.oauthClientId,
    hasClientSecret: !!cfg.oauthClientSecret,
    isConnected:     !!(cfg.oauthTokens && cfg.oauthTokens.refresh_token),
    gmailUser:       cfg.gmailUser || ''
  });
});

// POST /api/email-config — save Client ID + Secret
app.post('/api/email-config', (req, res) => {
  const { oauthClientId, oauthClientSecret } = req.body;
  if (!oauthClientId || !oauthClientSecret) {
    return res.status(400).json({ error: 'Client ID and Client Secret required' });
  }
  const cfg = loadConfig();
  cfg.oauthClientId     = oauthClientId.trim();
  cfg.oauthClientSecret = oauthClientSecret.trim();
  delete cfg.oauthTokens; // reset tokens when credentials change
  saveConfig(cfg);
  res.json({ ok: true });
});

// GET /api/gmail-auth — generate OAuth2 consent URL and redirect
app.get('/api/gmail-auth', (req, res) => {
  const cfg = loadConfig();
  if (!cfg.oauthClientId || !cfg.oauthClientSecret) {
    return res.status(400).send('Client ID/Secret not set. Configure in Gmail Setup first.');
  }
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    // NOTE: gmail.send alone does NOT grant access to gmail.users.getProfile.
    // userinfo.email is added so we can read the connected account's email
    // address via the lightweight OAuth2 userinfo endpoint instead.
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  });
  res.redirect(url);
});

// GET /oauth2callback — handle OAuth2 redirect from Google
app.get('/oauth2callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(`<h2>❌ Authorization failed: ${error || 'no code'}</h2><a href="/">Back to CRM</a>`);
  }
  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user's email address via the OAuth2 userinfo endpoint.
    // (gmail.users.getProfile requires a broader Gmail scope than
    // gmail.send provides, which was causing "Insufficient Permission".)
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userinfo = await oauth2.userinfo.get();
    const email = userinfo.data.email;

    const cfg = loadConfig();
    cfg.oauthTokens = tokens;
    cfg.gmailUser = email;
    saveConfig(cfg);

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4;">
        <h2 style="color:#15803d">✅ Gmail Connected!</h2>
        <p style="font-size:18px">Emails will now send from <strong>${email}</strong></p>
        <p style="color:#666">You can close this tab and return to the CRM.</p>
        <script>setTimeout(()=>window.close(),3000)</script>
      </body></html>
    `);
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.send(`<h2>❌ Error: ${e.message}</h2><a href="/">Back to CRM</a>`);
  }
});

// POST /api/send-email — send via Gmail API with auto-attached files
app.post('/api/send-email', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.oauthTokens || !cfg.oauthTokens.refresh_token) {
    return res.status(400).json({ error: 'Gmail not connected. Click "Connect Gmail" in settings.' });
  }

  const { customerId, toEmail, subject, body } = req.body;
  if (!customerId || !toEmail) {
    return res.status(400).json({ error: 'Customer ID and recipient email required.' });
  }

  const state = loadState();
  const c = state.customers.find(x => x.id === customerId);
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  // Build nodemailer attachments
  const attachments = [];
  if (c.agreementPdf) {
    const p = path.join(UPLOADS_DIR, c.agreementPdf);
    if (fs.existsSync(p)) attachments.push({
      filename: `Signed_Agreement_${(c.name||'Customer').replace(/\s+/g,'_')}.pdf`,
      path: p, contentType: 'application/pdf'
    });
  }
  if (c.receiptPdf) {
    const p = path.join(UPLOADS_DIR, c.receiptPdf);
    if (fs.existsSync(p)) attachments.push({
      filename: `Consultancy_Receipt_${(c.name||'Customer').replace(/\s+/g,'_')}.pdf`,
      path: p, contentType: 'application/pdf'
    });
  }
  if (fs.existsSync(VIDEO_DIR)) {
    const prefix = 'video-' + customerId + '-';
    const videos = fs.readdirSync(VIDEO_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.webm'))
      .sort().reverse();
    if (videos.length > 0) attachments.push({
      filename: `VideoVerification_${(c.name||'Customer').replace(/\s+/g,'_')}.webm`,
      path: path.join(VIDEO_DIR, videos[0]), contentType: 'video/webm'
    });
  }

  // Check total attachment size — Gmail hard limit is 25MB
  const MAX_BYTES = 24 * 1024 * 1024; // 24MB to be safe
  let totalSize = 0;
  const sizeWarnings = [];
  const safeAttachments = attachments.filter(a => {
    try {
      const s = fs.statSync(a.path).size;
      totalSize += s;
      const mb = (s / (1024 * 1024)).toFixed(1);
      console.log(`  Attachment: ${a.filename} — ${mb} MB`);
      if (totalSize > MAX_BYTES) {
        sizeWarnings.push(`${a.filename} skipped (total would exceed 24 MB)`);
        totalSize -= s;
        return false;
      }
      return true;
    } catch { return false; }
  });
  if (sizeWarnings.length) console.warn('Size warnings:', sizeWarnings);

  try {
    const auth = getOAuth2Client();
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      socketTimeout: 30000,   // 30s — fail fast instead of hanging
      greetingTimeout: 15000,
      connectionTimeout: 15000,
      auth: {
        type: 'OAuth2',
        user: cfg.gmailUser,
        clientId: cfg.oauthClientId,
        clientSecret: cfg.oauthClientSecret,
        refreshToken: cfg.oauthTokens.refresh_token,
        accessToken: cfg.oauthTokens.access_token
      }
    });

    await transporter.sendMail({
      from: `"Ruralift" <${cfg.gmailUser}>`,
      to: toEmail,
      subject,
      text: body,
      attachments: safeAttachments
    });

    res.json({ ok: true, attached: safeAttachments.length, from: cfg.gmailUser, warnings: sizeWarnings });
  } catch (e) {
    const fullError = e.response?.body ? JSON.stringify(e.response.body) : (e.message || 'Unknown error');
    console.error('Email send error:', fullError, e.stack || '');
    res.status(500).json({ error: fullError, code: e.code || '', stack: e.stack || '' });
  }
});

// Listen on all interfaces so any device on the same LAN can connect
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n===========================================');
  console.log('  Ruralift CRM started');
  console.log('===========================================');
  console.log(`  Local:  http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`  LAN:    http://${addr.address}:${PORT}   <-- use this on other devices`);
      }
    }
  }
  console.log('===========================================\n');
});
