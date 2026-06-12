const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
