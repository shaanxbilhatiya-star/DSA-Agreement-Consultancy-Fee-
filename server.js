const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load state
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ customers: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// GET all customers
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

// GET single customer
app.get('/api/customers/:id', (req, res) => {
  const state = loadState();
  const c = state.customers.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

// POST new customer
app.post('/api/customers', (req, res) => {
  const state = loadState();
  const customer = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    ...req.body
  };
  state.customers.unshift(customer);
  saveState(state);
  res.json(customer);
});

// PUT update customer
app.put('/api/customers/:id', (req, res) => {
  const state = loadState();
  const idx = state.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  state.customers[idx] = { ...state.customers[idx], ...req.body };
  saveState(state);
  res.json(state.customers[idx]);
});

// DELETE customer
app.delete('/api/customers/:id', (req, res) => {
  const state = loadState();
  state.customers = state.customers.filter(c => c.id !== req.params.id);
  saveState(state);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Ruralift CRM running on http://localhost:${PORT}`));
