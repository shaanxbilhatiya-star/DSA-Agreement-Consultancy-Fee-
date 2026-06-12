const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');
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
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

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
